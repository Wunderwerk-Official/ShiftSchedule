import { describe, expect, it } from "vitest";
import type { SolverUnsolvedOpenSlot } from "../api/client";
import {
  coverageExplanation, heuristicFallbackNotice, openPositionsUnproven, openSlotReasonSummary, ruleLabel, runEndedEarly,
  runFinishedNotice, runReviewLine, runStateLabel, runStoppedEarly,
} from "./solverOutcome";

const slot = (main: string | null, addable = 0): SolverUnsolvedOpenSlot => ({
  dateISO: "2026-11-06", section: "IRM seno", time: "07:30-11:30", missing: 1,
  blockers: { qualified: 4, addable, blocked_by: main ? { [main]: 4 - addable } : {}, main },
});
const unchecked: SolverUnsolvedOpenSlot = { dateISO: "2026-11-06", section: "S", time: "08:00-16:00", missing: 1 };

describe("openSlotReasonSummary", () => {
  it("counts each slot's main rule, most frequent first, whatever the input order", () => {
    const slots = [slot("VACATION"), slot("WEEKLY_HOURS"), slot("WEEKLY_HOURS"), slot("OVERLAP"), slot("WEEKLY_HOURS")];
    expect(openSlotReasonSummary(slots)?.text).toBe("weekly-hours limit (3), vacation (1), overlapping shift (1)");
  });

  it("breaks ties in the backend's rule order, not alphabetically", () => {
    expect(openSlotReasonSummary([slot("VACATION"), slot("WEEKLY_HOURS")])?.text)
      .toBe("weekly-hours limit (1), vacation (1)");
    expect(openSlotReasonSummary([slot("NO_QUALIFIED"), slot("SPLIT_SHIFT")])?.text)
      .toBe("split shift (1), no qualified person left (1)");
    // A hand-placed rest day (REST_DAY, v1.75) ranks with vacation, before overlaps.
    expect(openSlotReasonSummary([slot("OVERLAP"), slot("REST_DAY")])?.text)
      .toBe("rest day (1), overlapping shift (1)");
  });

  it("names every reason: no top-N cut", () => {
    const codes = ["ON_CALL_REST", "OVERLAP", "VACATION", "WEEKLY_HOURS", "SPLIT_SHIFT"];
    const text = openSlotReasonSummary(codes.map((code) => slot(code)))?.text ?? "";
    for (const code of codes) expect(text).toContain(ruleLabel(code));
  });

  it("keeps slots where someone could still be added and counts unchecked slots", () => {
    const summary = openSlotReasonSummary([slot("WEEKLY_HOURS"), slot(null, 2), unchecked]);
    expect(summary).toEqual({ text: "weekly-hours limit (1), a qualified person is still free (1)", checked: 2, total: 3 });
  });

  it("returns null when no slot carries reasons", () => {
    expect(openSlotReasonSummary([unchecked])).toBeNull();
    expect(openSlotReasonSummary([])).toBeNull();
  });

  it("labels unknown codes readably", () => {
    expect(ruleLabel("NO_QUALIFIED")).toBe("no qualified person left");
    expect(ruleLabel("SOME_NEW_RULE")).toBe("some new rule");
  });
});

describe("coverageExplanation", () => {
  it("names the reasons and how many slots they cover", () => {
    expect(coverageExplanation([slot("WEEKLY_HOURS"), slot("WEEKLY_HOURS")], false))
      .toBe("Main reason per slot: weekly-hours limit (2). The run log names the blocking rules.");
    expect(coverageExplanation([slot("VACATION"), unchecked], false))
      .toBe("Main reason for 1 of 2 slots: vacation (1). The run log names the blocking rules.");
  });

  it("never blames the rules for a run that ended before checking", () => {
    expect(coverageExplanation([unchecked], true))
      .toBe("The run ended before it checked these positions - the run log lists every open slot.");
    expect(coverageExplanation([unchecked], false)).toBe("The run log lists every open slot.");
    expect(coverageExplanation([slot("VACATION")], true)).toMatch(/^The run ended early\. Main reason per slot/);
  });
});

const debug = (agent: object) => ({ timing: { total_ms: 1 }, num_days: 1, num_slots: 1, solver_status: "AGENT_COMPLETE", agent });
const complete = { plan_revision: 3, workflow_finished: true, required_checks_complete: true, coverage_complete: true,
  soft_wishes_fulfilled: true, free_text_wishes_verified: true };
// test_agent_retry's run: Tuesday's model call failed, the repair and the
// final checks completed the day (stopReason "partial", nothing left open).
const repairedSkip = { stopReason: "partial", iterations: 4, daysSkipped: [], daysIncomplete: [],
  modelDaysSkipped: ["2026-01-06"], completion: complete };

describe("runEndedEarly", () => {
  it("is true for stopped, budget-limited and partial runs", () => {
    expect(runEndedEarly("aborted")).toBe(true);
    expect(runEndedEarly("finished", debug({ stopReason: "budget_exhausted" }))).toBe(true);
    expect(runEndedEarly("finished", debug({ stopReason: "completed", daysSkipped: ["2026-11-06"] }))).toBe(true);
    expect(runEndedEarly("finished", debug({ stopReason: "partial", daysIncomplete: ["2026-11-06"] }))).toBe(true);
    expect(runEndedEarly("finished", debug({ stopReason: "completed", daysSkipped: [], daysIncomplete: [] }))).toBe(false);
    expect(runEndedEarly("finished")).toBe(false);
  });

  it("does not count a day the repair completed for the model as an early end", () => {
    expect(runStoppedEarly("finished", debug(repairedSkip))).toBe(false);
    expect(runEndedEarly("finished", debug(repairedSkip))).toBe(false);
  });
});

describe("openPositionsUnproven", () => {
  const done = debug({ stopReason: "completed", daysSkipped: [], daysIncomplete: [] });
  it("calls positions unstaffable only after a finished check found nobody", () => {
    expect(openPositionsUnproven("finished", done, [slot("WEEKLY_HOURS")], [])).toBe(false);
    // Its day's final check ran out of time: the server lists it as unfinished.
    expect(openPositionsUnproven("finished", done, [slot("WEEKLY_HOURS")], ["2026-11-06"])).toBe(true);
    // Someone could still take it.
    expect(openPositionsUnproven("finished", done, [slot(null, 1)], [])).toBe(true);
    expect(openPositionsUnproven("aborted", done, [slot("WEEKLY_HOURS")], [])).toBe(true);
  });
});

describe("runFinishedNotice", () => {
  it("offers only a run that really finished for applying", () => {
    expect(runFinishedNotice("finished", debug({ stopReason: "completed" })))
      .toBe("Run finished - review the result in the run inbox and apply it.");
    expect(runFinishedNotice("finished", debug(repairedSkip)))
      .toBe("Run finished - review the result in the run inbox and apply it.");
    expect(runFinishedNotice("aborted", debug({ stopReason: "completed" })))
      .toBe("Run stopped - review the best plan so far in the run inbox.");
    for (const stopReason of ["budget_exhausted", "provider_error", "error", "refusal"]) {
      expect(runFinishedNotice("finished", debug({ stopReason })))
        .toBe("Run stopped early - review the best plan so far in the run inbox.");
    }
  });
});

describe("runReviewLine", () => {
  const base = { status: "finished", incomplete_dates: ["2026-11-05", "2026-11-06"] };

  it("does not call a finished run with open positions incomplete", () => {
    expect(runReviewLine({ ...base, unfinished_dates: [] }))
      .toBe("Finished with open positions on 2 day(s): check them before applying.");
  });

  it("keeps the incomplete wording for unfinished, stopped or older runs", () => {
    const incomplete = "Incomplete draft: 2 day(s) need review before applying.";
    expect(runReviewLine({ ...base, unfinished_dates: ["2026-11-06"] })).toBe(incomplete);
    expect(runReviewLine({ ...base, status: "aborted", unfinished_dates: [] })).toBe(incomplete);
    expect(runReviewLine(base)).toBe(incomplete);
    expect(runReviewLine({ status: "finished", incomplete_dates: [], unfinished_dates: [] })).toBeNull();
  });

  it("says nothing about applying once a run is applied or discarded", () => {
    expect(runReviewLine({ ...base, status: "applied", unfinished_dates: [] })).toBeNull();
    expect(runReviewLine({ ...base, status: "discarded", unfinished_dates: ["2026-11-06"] })).toBeNull();
  });
});

describe("runStateLabel", () => {
  const finished = { completion: complete, iterations: 4 };
  it("says a stopped run stopped, although the harness reports workflow_finished on every exit", () => {
    expect(runStateLabel({ ...finished, stopReason: "aborted" })).toBe("stopped");
    expect(runStateLabel({ ...finished, stopReason: "budget_exhausted" })).toBe("stopped early: planning budget used up");
    expect(runStateLabel({ ...finished, stopReason: "something_new" })).toBe("stopped early (something_new)");
    expect(runStateLabel({ ...finished, stopReason: "completed" })).toBe("finished");
    expect(runStateLabel({})).toBe("in progress");
  });

  it("follows the run's status: a Stop during the closing report keeps stopReason completed", () => {
    expect(runStateLabel({ ...finished, stopReason: "completed" }, "aborted")).toBe("stopped");
  });

  it("calls a partial run finished only when no day is left", () => {
    expect(runStateLabel(repairedSkip)).toBe("finished");
    expect(runStateLabel({ ...repairedSkip, daysSkipped: ["2026-01-06"] })).toBe("ended with days not finished");
    expect(runStateLabel({ ...repairedSkip, daysIncomplete: ["2026-01-06"] })).toBe("ended with days not finished");
    expect(runStateLabel({ ...repairedSkip, completion: { ...complete, required_checks_complete: false } }))
      .toBe("ended with days not finished");
  });

  it("tells an account whose AI budget is used up that the model never started", () => {
    const unstarted = { stopReason: "budget_exhausted", iterations: 0, completion: complete,
      result_producer: "heuristic_v2", fallback: { producer: "heuristic_v2", model_stop_reason: "budget_exhausted" } };
    expect(runStateLabel(unstarted)).toBe("not started: this account's AI budget is used up");
    expect(heuristicFallbackNotice(debug(unstarted))).toContain("This account's AI budget is used up.");
    expect(heuristicFallbackNotice(debug({ ...unstarted, iterations: 3 }))).toContain("planning budget was exhausted");
  });
});
