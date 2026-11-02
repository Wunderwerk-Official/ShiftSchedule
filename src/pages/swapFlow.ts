import { SwapApiError, type AppState } from "../api/client";
import type {
  SwapApplyRequest,
  SwapApplyResponse,
  SwapCandidatesRequest,
  SwapCandidatesResponse,
} from "../lib/swaps/types";

// Client flow of the swap assistant (SPEC §5.7). The page injects its calendar
// operations, so the order of saving, sending and hydrating is testable here.

/** The screen could not be saved, so no search ran. */
export class SwapSaveBlockedError extends Error {}

/** A search's answer; `reloaded`: the calendar was reloaded from the server before the answer was searched. */
export type SwapSearchResult = { response: SwapCandidatesResponse; reloaded: boolean };

export type SwapSearchDeps = {
  /** Saves the screen when it has unsaved edits; sets the page's save error on failure. */
  sync: () => Promise<{ revision: string | null; gen: number }>;
  find: (request: SwapCandidatesRequest) => Promise<SwapCandidatesResponse>;
  /** Reloads the calendar unless the screen changed since `gen`; true when it reloaded. */
  reloadIfUnchanged: (gen: number) => Promise<boolean>;
};

/**
 * Search against the revision the screen shows. When another tab changed the
 * calendar meanwhile and this screen holds no newer edits, reload it and
 * search the reloaded calendar.
 */
export async function runSwapSearch(
  deps: SwapSearchDeps,
  request: SwapCandidatesRequest,
): Promise<SwapSearchResult> {
  let synced: { revision: string | null; gen: number };
  try {
    synced = await deps.sync();
  } catch (err) {
    throw new SwapSaveBlockedError(err instanceof Error ? err.message : "Changes could not be saved.");
  }
  try {
    return { response: await deps.find({ ...request, expectedRevision: synced.revision }), reloaded: false };
  } catch (err) {
    if (err instanceof SwapApiError && err.code === "state_changed" && (await deps.reloadIfUnchanged(synced.gen))) {
      return { response: await deps.find({ ...request, expectedRevision: null }), reloaded: true };
    }
    throw err;
  }
}

export type SwapFlowDeps = {
  /** Another calendar operation (apply, restore, solver) is running. */
  isBusy: () => boolean;
  /** Shows "Updating calendar…" and stops the autosave. */
  pause: () => void;
  resume: () => void;
  /** The screen holds edits the server has not saved yet. */
  hasUnsavedEdits: () => boolean;
  /** Lets queued saves land; rejects when one of them failed. */
  flushSaves: () => Promise<void>;
  /** The revision of the last save or load; null or undefined when unknown. */
  savedRevision: () => string | null | undefined;
  /** Saves the screen; the server then holds what the planner sees. */
  ensureSaved: () => Promise<AppState>;
  hydrate: (state: AppState) => void;
  reload: () => Promise<void>;
  apply: (request: SwapApplyRequest) => Promise<SwapApplyResponse>;
  undo: (swapId: string, expectedRevision: string) => Promise<SwapApplyResponse>;
};

const BUSY_MESSAGE = "The calendar is being updated. Try again in a moment.";
const UNDO_RELOADED_MESSAGE = "The calendar changed in another tab. It was reloaded; undo again from History.";
const UNDO_NOT_RELOADED_MESSAGE = "The calendar changed in another tab. Reload the page, then undo again from History.";

/**
 * The revision an apply or undo is checked against. Unsaved edits (or an
 * unknown revision) are saved first. A screen without them is not saved
 * again: the queued saves land and their revision is sent, so a calendar
 * that another tab saved meanwhile is refused with state_changed, which
 * reloads it, instead of failing a save whose way out reloads the page.
 */
async function syncedRevision(deps: SwapFlowDeps): Promise<string> {
  if (!deps.hasUnsavedEdits()) {
    await deps.flushSaves();
    const revision = deps.savedRevision();
    if (revision) return revision;
  }
  return (await deps.ensureSaved()).revision ?? "";
}

/**
 * Sends an apply or undo. A state_changed refusal reloads the calendar and is
 * rethrown with `detail.reloaded`, so its text can say whether the screen now
 * shows the saved calendar.
 */
async function runCalendarChange(
  deps: SwapFlowDeps,
  send: (expectedRevision: string) => Promise<SwapApplyResponse>,
): Promise<SwapApplyResponse> {
  if (deps.isBusy()) throw new Error(BUSY_MESSAGE);
  deps.pause();
  try {
    const result = await send(await syncedRevision(deps));
    deps.hydrate(result.state);
    return result;
  } catch (err) {
    if (err instanceof SwapApiError && err.code === "state_changed") {
      let reloaded = true;
      try {
        await deps.reload();
      } catch {
        // The refusal is what the planner needs to see; a failed reload keeps the screen.
        reloaded = false;
      }
      throw new SwapApiError(err.message, err.status, err.code, { ...err.detail, reloaded });
    }
    throw err;
  } finally {
    // The autosave effect runs once more after this: expected and harmless.
    deps.resume();
  }
}

/** Apply the swap against the revision the screen is saved as, then show the saved calendar. */
export function runSwapApply(deps: SwapFlowDeps, request: SwapApplyRequest): Promise<SwapApplyResponse> {
  return runCalendarChange(deps, (expectedRevision) => deps.apply({ ...request, expectedRevision }));
}

/** Like runSwapApply for an undo; after a conflict it asks to undo again from History. */
export async function runSwapUndo(deps: SwapFlowDeps, swapId: string): Promise<SwapApplyResponse> {
  try {
    return await runCalendarChange(deps, (expectedRevision) => deps.undo(swapId, expectedRevision));
  } catch (err) {
    if (err instanceof SwapApiError && err.code === "state_changed") {
      const message = err.detail.reloaded === true ? UNDO_RELOADED_MESSAGE : UNDO_NOT_RELOADED_MESSAGE;
      throw new SwapApiError(message, 409, "state_changed", err.detail);
    }
    throw err;
  }
}
