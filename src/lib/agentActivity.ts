import type { AgentActivityData, AgentMoveItem } from "../api/client";

// Derived, render-ready view of the agent solver's live activity stream.
// Kept as pure functions (no React) so the reduction is unit-testable.

export type AgentStage = "seed" | "improve" | "finalize";

export type AgentFeedEntry =
  | { type: "move"; key: string; timeMs: number; move: AgentMoveItem; improved: boolean }
  | { type: "thought"; key: string; timeMs: number; text: string }
  | { type: "rejected"; key: string; timeMs: number; count: number; reason: string };

export type AgentStatus = {
  stage: AgentStage;
  iteration: number;
  maxIterations: number | null;
  movesAccepted: number;
  /** True while the LLM is working on its next step (last signal was an
   * iteration tick with nothing after it yet). Drives the thinking shimmer. */
  thinking: boolean;
  /** Newest first, capped. */
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
      feed.push({ type: "thought", key: `${index}`, timeMs: event.time_ms, text: event.text });
    } else if (event.kind === "moves_rejected") {
      feed.push({
        type: "rejected",
        key: `${index}`,
        timeMs: event.time_ms,
        count: event.count ?? 0,
        reason: event.reason ?? "constraint conflict",
      });
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
    feed: feed.reverse().slice(0, FEED_CAP),
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
