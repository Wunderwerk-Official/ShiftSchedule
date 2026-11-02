import { describe, expect, it, vi } from "vitest";
import { SwapApiError, type AppState } from "../api/client";
import type {
  SwapApplyRequest,
  SwapApplyResponse,
  SwapCandidatesRequest,
  SwapCandidatesResponse,
} from "../lib/swaps/types";
import { SwapSaveBlockedError, runSwapApply, runSwapSearch, runSwapUndo, type SwapFlowDeps } from "./swapFlow";

const request: SwapCandidatesRequest = {
  mode: "swap",
  assignment: { assignmentId: "as-1", rowId: "night-thu", dateISO: "2026-11-19", clinicianId: "clin-anna" },
  slot: null,
  wholeDay: false,
  partnerId: null,
  range: "fourWeeks",
  dates: [],
  sameTypeOnly: false,
};
const candidates = { revision: "r1", targetFindings: [] } as unknown as SwapCandidatesResponse;
const stateChanged = () => new SwapApiError("Changed elsewhere.", 409, "state_changed", { revision: "r9" });

describe("runSwapSearch", () => {
  it("searches against the revision the sync reports", async () => {
    const find = vi.fn().mockResolvedValue(candidates);
    const deps = { sync: vi.fn().mockResolvedValue({ revision: "r1", gen: 3 }), find, reloadIfUnchanged: vi.fn() };
    await expect(runSwapSearch(deps, request)).resolves.toEqual({ response: candidates, reloaded: false });
    expect(find).toHaveBeenCalledWith({ ...request, expectedRevision: "r1" });
    expect(deps.reloadIfUnchanged).not.toHaveBeenCalled();
  });

  it("reports a failed save as SwapSaveBlockedError and does not search", async () => {
    const find = vi.fn();
    const deps = { sync: vi.fn().mockRejectedValue(new Error("Calendar changed in another tab.")), find, reloadIfUnchanged: vi.fn() };
    const error = await runSwapSearch(deps, request).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(SwapSaveBlockedError);
    expect((error as Error).message).toBe("Calendar changed in another tab.");
    expect(find).not.toHaveBeenCalled();
  });

  it("searches the reloaded calendar after a conflict when the screen was unchanged", async () => {
    const find = vi.fn().mockRejectedValueOnce(stateChanged()).mockResolvedValueOnce(candidates);
    const reloadIfUnchanged = vi.fn().mockResolvedValue(true);
    const deps = { sync: vi.fn().mockResolvedValue({ revision: "r1", gen: 7 }), find, reloadIfUnchanged };
    // Reported, so the drawer counts the reloaded plan as the one the list was made from.
    await expect(runSwapSearch(deps, request)).resolves.toEqual({ response: candidates, reloaded: true });
    expect(reloadIfUnchanged).toHaveBeenCalledWith(7);
    expect(find.mock.calls.map(([sent]) => sent.expectedRevision)).toEqual(["r1", null]);
  });

  it("rethrows the conflict when the screen changed meanwhile", async () => {
    const conflict = stateChanged();
    const find = vi.fn().mockRejectedValue(conflict);
    const deps = {
      sync: vi.fn().mockResolvedValue({ revision: "r1", gen: 7 }),
      find,
      reloadIfUnchanged: vi.fn().mockResolvedValue(false),
    };
    await expect(runSwapSearch(deps, request)).rejects.toBe(conflict);
    expect(find).toHaveBeenCalledTimes(1);
  });
});

const applyRequest = { mode: "handover", partnerId: "clin-ben", expectedRevision: "" } as SwapApplyRequest;
const savedState = { revision: "r5", rows: [], clinicians: [], assignments: [], minSlotsByRowId: {} } as AppState;
const applied = { swap: { id: "swp-1" }, state: { ...savedState, revision: "r6" } } as SwapApplyResponse;

/**
 * Flow dependencies that record the calendar steps in order. By default the
 * screen has unsaved edits; a clean screen's last saved revision is "r3"
 * until the queued saves land, then "r4".
 */
function flowDeps(overrides: Partial<SwapFlowDeps> = {}) {
  const calls: string[] = [];
  const track = <T,>(name: string, result: () => T) => vi.fn(() => {
    calls.push(name);
    return result();
  });
  let revision: string | null = "r3";
  const deps: SwapFlowDeps = {
    isBusy: vi.fn(() => false),
    pause: track("pause", () => undefined),
    resume: track("resume", () => undefined),
    hasUnsavedEdits: vi.fn(() => true),
    flushSaves: track("flushSaves", () => {
      revision = "r4";
      return Promise.resolve();
    }),
    savedRevision: vi.fn(() => revision),
    ensureSaved: track("ensureSaved", () => Promise.resolve(savedState)),
    hydrate: track("hydrate", () => undefined),
    reload: track("reload", () => Promise.resolve()),
    apply: track("apply", () => Promise.resolve(applied)),
    undo: track("undo", () => Promise.resolve(applied)),
    ...overrides,
  };
  return { deps, calls };
}

describe("runSwapApply", () => {
  it("with unsaved edits: pauses, saves, applies against the saved revision, hydrates and resumes", async () => {
    const { deps, calls } = flowDeps();
    await expect(runSwapApply(deps, applyRequest)).resolves.toBe(applied);
    expect(calls).toEqual(["pause", "ensureSaved", "apply", "hydrate", "resume"]);
    expect(deps.apply).toHaveBeenCalledWith({ ...applyRequest, expectedRevision: "r5" });
    expect(deps.hydrate).toHaveBeenCalledWith(applied.state);
  });

  it("on a clean screen: no save, the queued saves land and the apply carries their revision", async () => {
    const { deps, calls } = flowDeps({ hasUnsavedEdits: () => false });
    await expect(runSwapApply(deps, applyRequest)).resolves.toBe(applied);
    expect(calls).toEqual(["pause", "flushSaves", "apply", "hydrate", "resume"]);
    expect(deps.ensureSaved).not.toHaveBeenCalled();
    expect(deps.apply).toHaveBeenCalledWith({ ...applyRequest, expectedRevision: "r4" });
  });

  it.each([null, undefined])("on a clean screen with no known revision (%s): saves first", async (unknown) => {
    const { deps, calls } = flowDeps({ hasUnsavedEdits: () => false, savedRevision: () => unknown });
    await expect(runSwapApply(deps, applyRequest)).resolves.toBe(applied);
    expect(calls).toEqual(["pause", "flushSaves", "ensureSaved", "apply", "hydrate", "resume"]);
    expect(deps.apply).toHaveBeenCalledWith({ ...applyRequest, expectedRevision: "r5" });
  });

  it("refuses while another calendar operation runs, without pausing", async () => {
    const { deps, calls } = flowDeps({ isBusy: () => true });
    await expect(runSwapApply(deps, applyRequest)).rejects.toThrow("The calendar is being updated. Try again in a moment.");
    expect(calls).toEqual([]);
  });

  it("reloads after a conflict, rethrows it marked as reloaded and resumes", async () => {
    const { deps, calls } = flowDeps({ apply: vi.fn().mockRejectedValue(stateChanged()) });
    const error = await runSwapApply(deps, applyRequest).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(SwapApiError);
    expect(error).toMatchObject({
      status: 409,
      code: "state_changed",
      message: "Changed elsewhere.",
      detail: { revision: "r9", reloaded: true },
    });
    expect(calls).toEqual(["pause", "ensureSaved", "reload", "resume"]);
  });

  it("on a clean screen, another tab's save is refused by the apply itself: reload, rethrow, resume", async () => {
    const { deps, calls } = flowDeps({ hasUnsavedEdits: () => false, apply: vi.fn().mockRejectedValue(stateChanged()) });
    await expect(runSwapApply(deps, applyRequest)).rejects.toMatchObject({
      code: "state_changed",
      detail: { revision: "r9", reloaded: true },
    });
    expect(deps.apply).toHaveBeenCalledWith({ ...applyRequest, expectedRevision: "r4" });
    expect(deps.ensureSaved).not.toHaveBeenCalled();
    expect(calls).toEqual(["pause", "flushSaves", "reload", "resume"]);
  });

  it("keeps the refusal when the reload fails, marked as not reloaded", async () => {
    const { deps } = flowDeps({
      apply: vi.fn().mockRejectedValue(stateChanged()),
      reload: vi.fn().mockRejectedValue(new Error("offline")),
    });
    await expect(runSwapApply(deps, applyRequest)).rejects.toMatchObject({
      code: "state_changed",
      message: "Changed elsewhere.",
      detail: { revision: "r9", reloaded: false },
    });
    expect(deps.resume).toHaveBeenCalledOnce();
  });

  it("resumes after any other refusal without reloading", async () => {
    const invalid = new SwapApiError("Breaks a rule.", 409, "swap_invalid", { reasons: ["x"] });
    const { deps, calls } = flowDeps({ apply: vi.fn().mockRejectedValue(invalid) });
    await expect(runSwapApply(deps, applyRequest)).rejects.toBe(invalid);
    expect(calls).toEqual(["pause", "ensureSaved", "resume"]);
  });

  it("does not apply when the screen cannot be saved, and does not reload", async () => {
    const saveError = new Error("The calendar changed in another tab.");
    const { deps, calls } = flowDeps({ ensureSaved: vi.fn().mockRejectedValue(saveError) });
    await expect(runSwapApply(deps, applyRequest)).rejects.toBe(saveError);
    expect(deps.apply).not.toHaveBeenCalled();
    expect(deps.reload).not.toHaveBeenCalled();
    expect(calls).toEqual(["pause", "resume"]);
  });

  it("does not apply when a queued save failed, and neither saves again nor reloads", async () => {
    const saveError = new Error("The calendar changed in another tab.");
    const { deps, calls } = flowDeps({ hasUnsavedEdits: () => false, flushSaves: vi.fn().mockRejectedValue(saveError) });
    await expect(runSwapApply(deps, applyRequest)).rejects.toBe(saveError);
    expect(deps.apply).not.toHaveBeenCalled();
    expect(deps.ensureSaved).not.toHaveBeenCalled();
    expect(deps.reload).not.toHaveBeenCalled();
    expect(calls).toEqual(["pause", "resume"]);
  });
});

describe("runSwapUndo", () => {
  it("undoes against the saved revision and hydrates", async () => {
    const { deps, calls } = flowDeps();
    await expect(runSwapUndo(deps, "swp-1")).resolves.toBe(applied);
    expect(deps.undo).toHaveBeenCalledWith("swp-1", "r5");
    expect(calls).toEqual(["pause", "ensureSaved", "undo", "hydrate", "resume"]);
  });

  it("on a clean screen undoes against the revision of the queued saves, without saving", async () => {
    const { deps, calls } = flowDeps({ hasUnsavedEdits: () => false });
    await expect(runSwapUndo(deps, "swp-1")).resolves.toBe(applied);
    expect(deps.undo).toHaveBeenCalledWith("swp-1", "r4");
    expect(calls).toEqual(["pause", "flushSaves", "undo", "hydrate", "resume"]);
  });

  it("after a conflict reloads and asks to undo again from History", async () => {
    const { deps, calls } = flowDeps({ hasUnsavedEdits: () => false, undo: vi.fn().mockRejectedValue(stateChanged()) });
    const error = await runSwapUndo(deps, "swp-1").catch((err: unknown) => err);
    expect(error).toBeInstanceOf(SwapApiError);
    expect(error).toMatchObject({
      status: 409,
      code: "state_changed",
      message: "The calendar changed in another tab. It was reloaded; undo again from History.",
      detail: { revision: "r9", reloaded: true },
    });
    expect(calls).toEqual(["pause", "flushSaves", "reload", "resume"]);
  });

  it("after a conflict whose reload fails asks to reload the page first", async () => {
    const { deps } = flowDeps({
      undo: vi.fn().mockRejectedValue(stateChanged()),
      reload: vi.fn().mockRejectedValue(new Error("offline")),
    });
    await expect(runSwapUndo(deps, "swp-1")).rejects.toMatchObject({
      code: "state_changed",
      message: "The calendar changed in another tab. Reload the page, then undo again from History.",
      detail: { revision: "r9", reloaded: false },
    });
  });

  it("passes other refusals through unchanged", async () => {
    const conflict = new SwapApiError("The shifts changed after the swap.", 409, "undo_conflict");
    const { deps } = flowDeps({ undo: vi.fn().mockRejectedValue(conflict) });
    await expect(runSwapUndo(deps, "swp-1")).rejects.toBe(conflict);
  });
});
