import type { AgentActivityData, AgentMoveItem } from "../api/client";

// Derived, render-ready view of the agent solver's live activity stream.
// Kept as pure functions (no React) so the reduction is unit-testable.

export type AgentStage = "seed" | "improve" | "finalize";

export type AgentFeedEntry =
  | { type: "move"; key: string; timeMs: number; move: AgentMoveItem; improved: boolean }
  | { type: "thought"; key: string; timeMs: number; text: string; reasoning: boolean }
  | { type: "rejected"; key: string; timeMs: number; count: number; reason: string }
  | { type: "tools"; key: string; timeMs: number; label: string };

/** Human wording for inspection tool calls shown in the live feed. */
const TOOL_LABELS: Record<string, string> = {
  get_plan_overview: "reviewed the plan status",
  get_violations: "checked rule violations",
  list_open_slots: "scanned for open slots",
  list_candidates_for_slot: "compared candidates for a slot",
  get_clinician_summary: "reviewed someone's week",
  get_ytd_progress: "checked year-to-date fairness",
  list_short_days: "looked for too-short work days",
  get_hours_overview: "compared everyone's weekly hours",
  get_day_schedule: "reviewed a full day's schedule",
  get_day_priorities: "ranked the day's open slots",
  suggest_day_blocks: "compared work blocks for the next slot",
  suggest_rescue_moves: "searched for rescue swaps",
  suggest_balance_moves: "reviewed the day's balance",
};

/** "checked rule violations · compared candidates for a slot" — apply_moves is
 * omitted (its outcome already shows as move/rejected rows). */
export function describeToolUse(tools: string[] | undefined): string {
  const labels = Array.from(
    new Set(
      (tools ?? [])
        .filter((name) => name !== "apply_moves")
        .map((name) => TOOL_LABELS[name] ?? name.replaceAll("_", " ")),
    ),
  );
  return labels.join(" · ");
}

export type AgentStatus = {
  stage: AgentStage;
  iteration: number;
  maxIterations: number | null;
  movesAccepted: number;
  /** True while the LLM is working on its next step (last signal was an
   * iteration tick with nothing after it yet). Drives the thinking shimmer. */
  thinking: boolean;
  /** Chronological (newest LAST), capped to the most recent entries — new
   * rows append at the bottom so a reader's scroll position never jumps. */
  feed: AgentFeedEntry[];
};

const FEED_CAP = 30;

export function deriveAgentStatus(events: AgentActivityData[]): AgentStatus {
  let stage: AgentStage = "seed";
  let iteration = 0;
  let maxIterations: number | null = null;
  let movesAccepted = 0;
  const feed: AgentFeedEntry[] = [];

  for (const [index, event] of events.entries()) {
    if (event.kind === "stage" && event.stage) {
      stage = event.stage;
    }
    iteration = Math.max(iteration, event.iteration ?? 0);
    if (typeof event.max_iterations === "number") {
      maxIterations = event.max_iterations;
    }
    movesAccepted = Math.max(movesAccepted, event.moves_accepted ?? 0);

    if (event.kind === "moves_applied" && event.moves) {
      for (const [moveIndex, move] of event.moves.entries()) {
        feed.push({
          type: "move",
          key: `${index}-${moveIndex}`,
          timeMs: event.time_ms,
          move,
          improved: event.improved ?? false,
        });
      }
    } else if (event.kind === "thought" && event.text) {
      feed.push({
        type: "thought",
        key: `${index}`,
        timeMs: event.time_ms,
        text: event.text,
        reasoning: event.reasoning === true,
      });
    } else if (event.kind === "moves_rejected") {
      feed.push({
        type: "rejected",
        key: `${index}`,
        timeMs: event.time_ms,
        count: event.count ?? 0,
        reason: event.reason ?? "constraint conflict",
      });
    } else if (event.kind === "tool_use") {
      const label = describeToolUse(event.tools);
      if (label) {
        feed.push({ type: "tools", key: `${index}`, timeMs: event.time_ms, label });
      }
    }
  }

  const last = events[events.length - 1];
  const thinking = stage === "improve" && last?.kind === "iteration";

  return {
    stage,
    iteration,
    maxIterations,
    movesAccepted,
    thinking,
    feed: feed.slice(-FEED_CAP),
  };
}

const WEEKDAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "2026-01-05" -> "Mon 05.01." (matches the app's DD.MM. date style). */
export function formatFeedDate(dateISO: string): string {
  const [year, month, day] = dateISO.split("-").map(Number);
  if (!year || !month || !day) return dateISO;
  const weekday = WEEKDAYS_SHORT[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  return `${weekday} ${String(day).padStart(2, "0")}.${String(month).padStart(2, "0")}.`;
}
