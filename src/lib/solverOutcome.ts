import type { SolverAgentDebug, SolverDebugInfo, SolverRunSummary, SolverUnsolvedOpenSlot } from "../api/client";

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

/** The run itself stopped before its end: stopped by hand, or the agent
 *  ended on a budget, a provider failure, an error or a refusal. "partial"
 *  is no stop: the model skipped or left days, and daysSkipped,
 *  daysIncomplete and the final checks say which are still unfinished
 *  (the same rule as backend/run_apply.cut_short). */
export function runStoppedEarly(status: string | undefined, debug?: SolverDebugInfo): boolean {
  const reason = debug?.agent?.stopReason;
  return status === "aborted" || (reason != null && reason !== "completed" && reason !== "partial");
}

/** The run ended before it finished: stopped early, or days it skipped or
 *  left incomplete. */
export function runEndedEarly(status: string, debug?: SolverDebugInfo): boolean {
  const agent = debug?.agent;
  return runStoppedEarly(status, debug)
    || !!agent?.daysSkipped?.length
    || !!agent?.daysIncomplete?.length;
}

/** The coverage banner leads with "are still open" instead of "could not
 *  be staffed" when nothing proves the positions unstaffable: the run ended
 *  early, a slot's day is one the run did not finish (the server's
 *  unfinished_dates, e.g. its final check ran out of time), or someone
 *  could still take the slot. */
export function openPositionsUnproven(
  status: string,
  debug: SolverDebugInfo | undefined,
  slots: SolverUnsolvedOpenSlot[],
  unfinishedDates?: string[],
): boolean {
  const unfinished = new Set(unfinishedDates ?? []);
  return runEndedEarly(status, debug)
    || slots.some((slot) => unfinished.has(slot.dateISO) || (slot.blockers?.addable ?? 0) > 0);
}

/** The toast after a run: only a run that really finished is offered for
 *  applying as it is. */
export function runFinishedNotice(status: string, debug?: SolverDebugInfo): string {
  if (status === "aborted") return "Run stopped - review the best plan so far in the run inbox.";
  if (runStoppedEarly(status, debug)) return "Run stopped early - review the best plan so far in the run inbox.";
  return "Run finished - review the result in the run inbox and apply it.";
}

/** The model never ran: this account's AI budget was used up before the
 *  first call (the harness then returns the basic plan with
 *  stopReason "budget_exhausted" and no iterations). */
function aiBudgetUsedUp(agent?: Pick<SolverAgentDebug, "stopReason" | "iterations">): boolean {
  return agent?.stopReason === "budget_exhausted" && (agent.iterations ?? 0) === 0;
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
 *  every exit, so the run status and the stop reason decide whether it
 *  really finished. A "partial" run whose skipped day the repair and the
 *  final checks completed did finish. */
export function runStateLabel(
  agent: Pick<SolverAgentDebug, "stopReason" | "iterations" | "daysSkipped" | "daysIncomplete" | "completion">,
  runStatus?: string,
): string {
  if (runStatus === "aborted") return STOP_REASON_LABELS.aborted;
  const reason = agent.stopReason;
  if (aiBudgetUsedUp(agent)) return "not started: this account's AI budget is used up";
  if (reason === "partial") {
    const unfinished = !!agent.daysSkipped?.length || !!agent.daysIncomplete?.length
      || agent.completion?.required_checks_complete === false;
    return unfinished ? STOP_REASON_LABELS.partial : "finished";
  }
  if (reason && reason !== "completed") return STOP_REASON_LABELS[reason] ?? `stopped early (${reason})`;
  return agent.completion?.workflow_finished ? "finished" : "in progress";
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
    : aiBudgetUsedUp(agent)
      ? "This account's AI budget is used up."
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
