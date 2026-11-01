import { describe, expect, it } from "vitest";
import type { SolverUnsolvedOpenSlot } from "../api/client";
import { openSlotReasonSummary, ruleLabel, runReviewLine } from "./solverOutcome";

const slot = (main: string | null, blockedBy: Record<string, number> = {}): SolverUnsolvedOpenSlot => ({
  dateISO: "2026-11-06", section: "IRM seno", time: "07:30-11:30", missing: 1,
  blockers: { qualified: 4, addable: main ? 0 : 1, blocked_by: blockedBy, main },
});

describe("openSlotReasonSummary", () => {
  it("tallies each open slot's main blocking rule, most frequent first", () => {
    const slots = [
      slot("WEEKLY_HOURS", { WEEKLY_HOURS: 4 }),
      slot("VACATION", { VACATION: 2 }),
      slot("WEEKLY_HOURS", { WEEKLY_HOURS: 3, VACATION: 1 }),
      slot(null),
    ];
    expect(openSlotReasonSummary(slots)).toBe("weekly-hours limit (2), vacation (1)");
  });

  it("returns null when the run reported no reasons", () => {
    expect(openSlotReasonSummary([{ dateISO: "2026-11-06", section: "S", time: "08:00-16:00", missing: 1 }])).toBeNull();
    expect(openSlotReasonSummary([])).toBeNull();
  });

  it("labels unknown codes readably and names slots nobody is qualified for", () => {
    expect(ruleLabel("NO_QUALIFIED")).toBe("nobody qualified");
    expect(ruleLabel("SOME_NEW_RULE")).toBe("some new rule");
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
});
