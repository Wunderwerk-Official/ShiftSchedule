import type { SolverDebugInfo, SolverRunSummary, SolverUnsolvedOpenSlot } from "../api/client";

// Same wording as the backend's closing report (backend/agent/open_reasons.py).
const RULE_LABELS: Record<string, string> = {
  WEEKLY_HOURS: "weekly-hours limit",
  VACATION: "vacation",
  OVERLAP: "overlapping shift",
  SAME_LOCATION_PER_DAY: "other site that day",
  SPLIT_SHIFT: "split shift",
  ON_CALL_REST: "on-call rest",
  MANDATORY_WINDOW: "mandatory working time",
  SOLVER_RULE: "shift rule",
  CAPACITY_EXCEEDED: "slot full",
  QUALIFICATION: "not qualified",
  NO_QUALIFIED: "nobody qualified",
};

export function ruleLabel(code: string): string {
  return RULE_LABELS[code] ?? code.toLowerCase().replace(/_/g, " ");
}

/** "weekly-hours limit (7), vacation (2)": each open slot's main blocking
 *  rule, most frequent first. Null when the run reported no reasons. */
export function openSlotReasonSummary(slots: SolverUnsolvedOpenSlot[], limit = 3): string | null {
  const tally = new Map<string, number>();
  for (const slot of slots) {
    const main = slot.blockers?.main;
    if (main) tally.set(main, (tally.get(main) ?? 0) + 1);
  }
  if (!tally.size) return null;
  return [...tally.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([code, count]) => `${ruleLabel(code)} (${count})`)
    .join(", ");
}

/** Run-card line for a draft that needs a look before applying. A run that
 *  finished every check but left positions open was not cut short. Older
 *  servers send no unfinished_dates: keep the cautious wording there. */
export function runReviewLine(run: Pick<SolverRunSummary, "status" | "incomplete_dates" | "unfinished_dates">): string | null {
  const days = run.incomplete_dates?.length ?? 0;
  if (!days) return null;
  const unfinished = run.status === "aborted" || run.unfinished_dates === undefined || run.unfinished_dates.length > 0;
  return unfinished
    ? `Incomplete draft: ${days} day(s) need review before applying.`
    : `Finished with open positions on ${days} day(s): check them before applying.`;
}

export function heuristicFallbackNotice(debug?: SolverDebugInfo): string | null {
  const agent = debug?.agent;
  if (agent?.result_producer !== "heuristic_v2" && !agent?.fallback && debug?.solver_status !== "AGENT_FALLBACK_SEED") return null;
  const reason = agent?.fallback?.model_stop_reason ?? agent?.stopReason;
  const explanation = reason === "provider_error"
    ? "The model request failed."
    : reason === "budget_exhausted"
      ? "The model's planning budget was exhausted."
      : reason === "aborted"
        ? "The model run was stopped."
        : "The model did not produce the returned draft.";
  return `Heuristic fallback: the returned draft was produced by heuristic v2. ${explanation} Review it in the run inbox.`;
}

export function agentReviewNotice(debug?: SolverDebugInfo): string | null {
  const agent = debug?.agent;
  const dates = [...new Set([...(agent?.daysSkipped ?? []), ...(agent?.daysIncomplete ?? [])])].sort();
  if (!dates.length) return null;
  return `${dates.length} day(s) need review (${dates.join(", ")}). The model skipped days or required checks remain open. Review coverage separately in the run inbox.`;
}
