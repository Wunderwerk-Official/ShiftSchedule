import type { SolverDebugInfo } from "../api/client";

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
