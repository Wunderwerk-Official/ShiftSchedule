import type { SolverDebugInfo, SolverRunSummary, SolverUnsolvedOpenSlot } from "../api/client";

// Same wording and tie-break order as the backend's closing report
// (RULE_LABELS in backend/agent/open_reasons.py), plus the two outcomes that
// are not a rule: no qualified person left, someone could still be added.
const RULE_LABELS: Record<string, string> = {
  WEEKLY_HOURS: "weekly-hours limit",
  VACATION: "vacation",
  REST_DAY: "rest day",
  OVERLAP: "overlapping shift",
  SAME_LOCATION_PER_DAY: "other location that day",
  SPLIT_SHIFT: "split shift",
  ON_CALL_REST: "on-call rest",
  MANDATORY_WINDOW: "mandatory working time",
  SOLVER_RULE: "shift rule",
  CAPACITY_EXCEEDED: "slot full",
  QUALIFICATION: "not qualified",
  NO_QUALIFIED: "no qualified person left",
  ADDABLE: "a qualified person is still free",
};
const RULE_ORDER = Object.keys(RULE_LABELS);

export function ruleLabel(code: string): string {
  return RULE_LABELS[code] ?? code.toLowerCase().replace(/_/g, " ");
}

function ruleRank(code: string): number {
  const index = RULE_ORDER.indexOf(code);
  return index < 0 ? RULE_ORDER.length : index;
}

export type OpenSlotReasonSummary = {
  /** "weekly-hours limit (7), vacation (2)" */
  text: string;
  /** Open slots the closing check reached (it is bounded by count and time). */
  checked: number;
  total: number;
};

/** Each checked open slot's main blocking rule, most frequent first (ties in
 *  the backend's rule order); a slot where someone could still be added
 *  counts as "a qualified person is still free". Null when no slot carries
 *  reasons (older server, stopped run, closing check out of time). */
export function openSlotReasonSummary(slots: SolverUnsolvedOpenSlot[]): OpenSlotReasonSummary | null {
  const tally = new Map<string, number>();
  let checked = 0;
  for (const slot of slots) {
    const blockers = slot.blockers;
    if (!blockers) continue;
    checked += 1;
    const code = blockers.main ?? (blockers.addable > 0 ? "ADDABLE" : null);
    if (code) tally.set(code, (tally.get(code) ?? 0) + 1);
  }
  if (!tally.size) return null;
  const text = [...tally.entries()]
    .sort((a, b) => b[1] - a[1] || ruleRank(a[0]) - ruleRank(b[0]) || a[0].localeCompare(b[0]))
    .map(([code, count]) => `${ruleLabel(code)} (${count})`)
    .join(", ");
  return { text, checked, total: slots.length };
}

/** The run ended before it finished: stopped, out of budget, a provider
 *  failure, or days it skipped or left incomplete. */
export function runEndedEarly(status: string, debug?: SolverDebugInfo): boolean {
  const agent = debug?.agent;
  return status === "aborted"
    || (agent?.stopReason != null && agent.stopReason !== "completed")
    || !!agent?.daysSkipped?.length
    || !!agent?.daysIncomplete?.length;
}

/** The coverage banner's explanation after a run left required positions
 *  open: the reasons where the run checked them, never a guess where it did
 *  not (a stopped run did not plan those slots). */
export function coverageExplanation(slots: SolverUnsolvedOpenSlot[], endedEarly: boolean): string {
  const summary = openSlotReasonSummary(slots);
  if (summary) {
    const scope = summary.checked === summary.total ? "per slot" : `for ${summary.checked} of ${summary.total} slots`;
    return `${endedEarly ? "The run ended early. " : ""}Main reason ${scope}: ${summary.text}. The run log names the blocking rules.`;
  }
  return endedEarly
    ? "The run ended before it checked these positions - the run log lists every open slot."
    : "The run log lists every open slot.";
}

const STOP_REASON_LABELS: Record<string, string> = {
  aborted: "stopped",
  budget_exhausted: "stopped early: planning budget used up",
  provider_error: "stopped early: the model request failed",
  partial: "ended with days not finished",
  error: "stopped early: the model call failed",
  refusal: "stopped early: the model refused",
};

/** The run-details "Run:" line. The harness reports workflow_finished on
 *  every exit, so the stop reason decides whether it really finished. */
export function runStateLabel(stopReason: string | undefined | null, workflowFinished: boolean): string {
  if (stopReason && stopReason !== "completed") return STOP_REASON_LABELS[stopReason] ?? `stopped early (${stopReason})`;
  return workflowFinished ? "finished" : "in progress";
}

/** Run-card line for a draft that needs a look before applying (applied or
 *  discarded runs need none). A run that finished every check but left
 *  positions open was not cut short. Older servers send no
 *  unfinished_dates: keep the cautious wording there. */
export function runReviewLine(run: Pick<SolverRunSummary, "status" | "incomplete_dates" | "unfinished_dates">): string | null {
  if (run.status !== "finished" && run.status !== "aborted") return null;
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
  return `Basic plan (without AI): the returned draft was made without the AI. ${explanation} Review it in the run inbox.`;
}

export function agentReviewNotice(debug?: SolverDebugInfo): string | null {
  const agent = debug?.agent;
  const dates = [...new Set([...(agent?.daysSkipped ?? []), ...(agent?.daysIncomplete ?? [])])].sort();
  if (!dates.length) return null;
  return `${dates.length} day(s) need review (${dates.join(", ")}). The model skipped days or required checks remain open. Review coverage separately in the run inbox.`;
}
