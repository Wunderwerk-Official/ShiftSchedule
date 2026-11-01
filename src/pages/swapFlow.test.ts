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
const candidates = { revision: "r1" } as SwapCandidatesResponse;
const stateChanged = () => new SwapApiError("Changed elsewhere.", 409, "state_changed", { revision: "r9" });

describe("runSwapSearch", () => {
  it("searches against the revision the sync reports", async () => {
    const find = vi.fn().mockResolvedValue(candidates);
    const deps = { sync: vi.fn().mockResolvedValue({ revision: "r1", gen: 3 }), find, reloadIfUnchanged: vi.fn() };
    await expect(runSwapSearch(deps, request)).resolves.toBe(candidates);
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
    await expect(runSwapSearch(deps, request)).resolves.toBe(candidates);
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

function flowDeps(overrides: Partial<SwapFlowDeps> = {}) {
  const calls: string[] = [];
  const track = <T,>(name: string, result: () => T) => vi.fn(() => {
    calls.push(name);
    return result();
  });
  const deps: SwapFlowDeps = {
    isBusy: vi.fn(() => false),
    pause: track("pause", () => undefined),
    resume: track("resume", () => undefined),
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
  it("pauses, saves, applies against the saved revision, hydrates and resumes", async () => {
    const { deps, calls } = flowDeps();
    await expect(runSwapApply(deps, applyRequest)).resolves.toBe(applied);
    expect(calls).toEqual(["pause", "ensureSaved", "apply", "hydrate", "resume"]);
    expect(deps.apply).toHaveBeenCalledWith({ ...applyRequest, expectedRevision: "r5" });
    expect(deps.hydrate).toHaveBeenCalledWith(applied.state);
  });

  it("refuses while another calendar operation runs, without pausing", async () => {
    const { deps, calls } = flowDeps({ isBusy: () => true });
    await expect(runSwapApply(deps, applyRequest)).rejects.toThrow("The calendar is being updated. Try again in a moment.");
    expect(calls).toEqual([]);
  });

  it("reloads after a conflict, rethrows it and resumes", async () => {
    const conflict = stateChanged();
    const { deps, calls } = flowDeps({ apply: vi.fn().mockRejectedValue(conflict) });
    await expect(runSwapApply(deps, applyRequest)).rejects.toBe(conflict);
    expect(calls).toEqual(["pause", "ensureSaved", "reload", "resume"]);
  });

  it("keeps the refusal when the reload fails", async () => {
    const conflict = stateChanged();
    const { deps } = flowDeps({ apply: vi.fn().mockRejectedValue(conflict), reload: vi.fn().mockRejectedValue(new Error("offline")) });
    await expect(runSwapApply(deps, applyRequest)).rejects.toBe(conflict);
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
});

describe("runSwapUndo", () => {
  it("undoes against the saved revision and hydrates", async () => {
    const { deps, calls } = flowDeps();
    await expect(runSwapUndo(deps, "swp-1")).resolves.toBe(applied);
    expect(deps.undo).toHaveBeenCalledWith("swp-1", "r5");
    expect(calls).toEqual(["pause", "ensureSaved", "undo", "hydrate", "resume"]);
  });

  it("after a conflict reloads and asks to undo again from History", async () => {
    const { deps, calls } = flowDeps({ undo: vi.fn().mockRejectedValue(stateChanged()) });
    const error = await runSwapUndo(deps, "swp-1").catch((err: unknown) => err);
    expect(error).toBeInstanceOf(SwapApiError);
    expect(error).toMatchObject({
      status: 409,
      code: "state_changed",
      message: "The calendar changed in another tab. It was reloaded; undo again from History.",
      detail: { revision: "r9" },
    });
    expect(calls).toEqual(["pause", "ensureSaved", "reload", "resume"]);
  });

  it("passes other refusals through unchanged", async () => {
    const conflict = new SwapApiError("The shifts changed after the swap.", 409, "undo_conflict");
    const { deps } = flowDeps({ undo: vi.fn().mockRejectedValue(conflict) });
    await expect(runSwapUndo(deps, "swp-1")).rejects.toBe(conflict);
  });
});
