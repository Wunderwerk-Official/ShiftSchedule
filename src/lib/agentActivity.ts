import type { AgentActivityData, AgentMoveItem } from "../api/client";

// Derived, render-ready view of the agent solver's live activity stream.
// Kept as pure functions (no React) so the reduction is unit-testable.

export type AgentStage = "seed" | "improve" | "finalize";

export type AgentFeedEntry =
  | { type: "move"; key: string; timeMs: number; move: AgentMoveItem; improved: boolean; retainedBest?: boolean }
  | { type: "thought"; key: string; timeMs: number; text: string; reasoning: boolean; outputTruncated?: boolean }
  | { type: "rejected"; key: string; timeMs: number; count: number; reason: string }
  | { type: "tools"; key: string; timeMs: number; label: string; summary?: string; outcome?: string; durationMs?: number }
  | { type: "notice"; key: string; timeMs: number; label: string; warning?: boolean };

const ACTIVE_TOOL_LABELS: Record<string, string> = {
  get_plan_tasks: "Checking remaining planning tasks",
  get_plan_overview: "Reviewing coverage and plan quality",
  get_violations: "Checking scheduling rules",
  list_open_slots: "Finding open positions",
  list_candidates_for_slot: "Comparing eligible clinicians",
  get_clinician_summary: "Reviewing a clinician's week",
  get_ytd_progress: "Checking fairness across the year",
  list_short_days: "Finding short workdays",
  get_hours_overview: "Comparing weekly working hours",
  get_day_schedule: "Reading the day's schedule",
  get_day_priorities: "Ranking the day's staffing needs",
  suggest_day_blocks: "Comparing contiguous work blocks",
  suggest_rescue_moves: "Searching for swaps to fill gaps",
  suggest_balance_moves: "Looking for a better workload balance",
  repair_neighborhood: "Testing changes across nearby days",
  analyze_bottlenecks: "Investigating staffing bottlenecks",
  explain_unfilled: "Checking why positions remain open",
  get_search_history: "Reviewing earlier checks",
  apply_moves: "Checking and applying draft changes",
  apply_proposal: "Applying a checked proposal and finding the next options",
};

export function describeActiveTool(tool?: string): string {
  return ACTIVE_TOOL_LABELS[tool ?? ""] ?? "Checking a planning option";
}

/** Preserve context and row identities when older events leave the buffer.
 * Older servers only send stage once; new servers repeat context on each event. */
export function appendAgentEvent(events: AgentActivityData[], event: AgentActivityData): AgentActivityData[] {
  const previous = events[events.length - 1];
  return [...events.slice(-239), {
    ...event,
    sequence: event.sequence ?? (previous?.sequence ?? 0) + 1,
    stage: event.stage ?? (event.iteration > 0 && previous?.stage !== "finalize" ? "improve" : previous?.stage ?? "seed"),
  }];
}

export function formatActivityTime(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Human wording for inspection tool calls shown in the live feed. */
const TOOL_LABELS: Record<string, string> = {
  get_plan_tasks: "reviewed remaining planning tasks",
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
        .filter((name) => name !== "apply_moves" && name !== "apply_proposal")
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
  phaseLabel: string | null;
  dayIndex: number | null;
  totalDays: number | null;
  /**
   * Highest day of the range the agent has worked on (1-based), or null.
   * Once the context drops the day again (whole-range review), the days are
   * done: the progress track shows them all as planned.
   */
  maxDayIndex: number | null;
  planningDate: string | null;
  checksProgress?: AgentActivityData["checks_progress"];
  currentAction: string;
  actionStartedMs: number;
  lastResult: string | null;
  retrying: boolean;
  /** Chronological (newest LAST), capped to the most recent entries — new
   * rows append at the bottom so a reader's scroll position never jumps. */
  feed: AgentFeedEntry[];
};

const FEED_CAP = 100;

export function deriveAgentStatus(events: AgentActivityData[]): AgentStatus {
  let stage: AgentStage = "seed";
  let iteration = 0;
  let maxIterations: number | null = null;
  let movesAccepted = 0;
  let context: AgentActivityData | undefined;
  let maxDayIndex: number | null = null;
  let lastResult: string | null = null;
  const activeTools = new Map<number, AgentActivityData>();
  const detailedIterations = new Set(events.filter((e) => e.kind === "tool_start" || e.kind === "tool_result").map((e) => e.iteration));
  const feed: AgentFeedEntry[] = [];

  for (const [index, event] of events.entries()) {
    if (event.kind === "iteration" || event.kind === "phase" || event.kind === "stage") activeTools.clear();
    const key = String(event.sequence ?? `${event.time_ms}-${index}`);
    if (event.stage) {
      stage = event.stage;
    } else if (event.iteration > 0 && stage === "seed") {
      stage = "improve";
    }
    if (event.phase_label) context = event;
    if (typeof event.day_index === "number") maxDayIndex = Math.max(maxDayIndex ?? 0, event.day_index);
    iteration = Math.max(iteration, event.iteration ?? 0);
    if (typeof event.max_iterations === "number") {
      maxIterations = event.max_iterations;
    }
    movesAccepted = Math.max(movesAccepted, event.moves_accepted ?? 0);

    if (event.kind === "moves_applied" && event.moves) {
      for (const [moveIndex, move] of event.moves.entries()) {
        feed.push({
          type: "move",
          key: `${key}-${moveIndex}`,
          timeMs: event.time_ms,
          move,
          improved: event.improved ?? false,
          retainedBest: event.retained_best,
        });
      }
    } else if (event.kind === "thought" && event.text) {
      feed.push({
        type: "thought",
        key,
        timeMs: event.time_ms,
        text: event.text,
        reasoning: event.reasoning === true,
        outputTruncated: event.output_truncated === true,
      });
    } else if (event.kind === "moves_rejected") {
      feed.push({
        type: "rejected",
        key,
        timeMs: event.time_ms,
        count: event.count ?? 0,
        reason: event.reason ?? "constraint conflict",
      });
    } else if (event.kind === "tool_start") {
      activeTools.set(event.activity_id ?? index, event);
    } else if (event.kind === "tool_result") {
      activeTools.delete(event.activity_id ?? index);
      const label = describeActiveTool(event.tool) + (event.dateISO ? ` · ${formatFeedDate(event.dateISO)}` : "");
      lastResult = event.summary ?? "Check completed.";
      feed.push({ type: "tools", key, timeMs: event.time_ms, label,
        summary: event.summary, outcome: event.outcome, durationMs: event.duration_ms });
    } else if (event.kind === "phase" && event.phase_label) {
      feed.push({ type: "notice", key, timeMs: event.time_ms,
        label: event.planning_date ? `Day ${event.day_index} of ${event.total_days} · ${formatFeedDate(event.planning_date)}` : event.phase_label });
    } else if (event.kind === "retry") {
      feed.push({ type: "notice", key, timeMs: event.time_ms, warning: true,
        label: `Model request interrupted. Retrying${event.attempt ? ` (attempt ${event.attempt})` : ""}; the best draft is kept.` });
    } else if (event.kind === "tool_use" && !detailedIterations.has(event.iteration)) {
      const label = describeToolUse(event.tools);
      if (label) {
        feed.push({ type: "tools", key, timeMs: event.time_ms, label });
      }
    }
  }

  const last = events[events.length - 1];
  const thinking = stage === "improve" && last?.kind === "iteration";
  const activeTool = [...activeTools.values()].pop();
  const retrying = last?.kind === "retry";
  const currentAction = stage === "finalize" ? "Preparing the best plan for review"
    : activeTool ? describeActiveTool(activeTool.tool) + (activeTool.dateISO ? ` · ${formatFeedDate(activeTool.dateISO)}` : "")
    : retrying ? "Retrying the model request"
    : thinking ? "Waiting for the model's next step"
    : stage === "seed" ? "Preparing the initial draft"
    : "Checking the next planning step";

  return {
    stage,
    iteration,
    maxIterations,
    movesAccepted,
    thinking,
    phaseLabel: context?.phase_label ?? null,
    dayIndex: context?.day_index ?? null,
    totalDays: context?.total_days ?? null,
    maxDayIndex,
    planningDate: context?.planning_date ?? null,
    checksProgress: last?.checks_progress,
    currentAction,
    actionStartedMs: activeTool?.time_ms ?? last?.time_ms ?? 0,
    lastResult,
    retrying,
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
