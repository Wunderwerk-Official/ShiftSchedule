import { describe, expect, it } from "vitest";
import type { SolverUnsolvedOpenSlot } from "../api/client";
import {
  coverageExplanation, openSlotReasonSummary, ruleLabel, runEndedEarly, runReviewLine,
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

describe("runEndedEarly", () => {
  it("is true for stopped, budget-limited and partial runs", () => {
    const debug = (agent: object) => ({ timing: { total_ms: 1 }, num_days: 1, num_slots: 1, solver_status: "AGENT_COMPLETE", agent });
    expect(runEndedEarly("aborted")).toBe(true);
    expect(runEndedEarly("finished", debug({ stopReason: "budget_exhausted" }))).toBe(true);
    expect(runEndedEarly("finished", debug({ stopReason: "completed", daysSkipped: ["2026-11-06"] }))).toBe(true);
    expect(runEndedEarly("finished", debug({ stopReason: "completed", daysSkipped: [], daysIncomplete: [] }))).toBe(false);
    expect(runEndedEarly("finished")).toBe(false);
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
