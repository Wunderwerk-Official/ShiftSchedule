import { useMemo } from "react";
import type { AgentActivityData } from "../../api/client";
import {
  deriveAgentStatus,
  formatFeedDate,
  type AgentFeedEntry,
  type AgentStage,
} from "../../lib/agentActivity";

// Live view of the agent solver: stage stepper, iteration progress, and a
// feed of the concrete changes the agent makes. Rendered inside SolverOverlay
// for solver_mode === "agent" only.

const STAGES: { id: AgentStage; label: string }[] = [
  { id: "seed", label: "Draft plan" },
  { id: "improve", label: "AI improving" },
  { id: "finalize", label: "Finalize" },
];

function SparkleIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M12 2c.4 3.9 3 6.9 7 7.5v1c-4 .6-6.6 3.6-7 7.5h-1c-.4-3.9-3-6.9-7-7.5v-1c4-.6 6.6-3.6 7-7.5h1z" />
      <path d="M19 14c.2 1.8 1.4 3.2 3 3.5v.6c-1.6.3-2.8 1.7-3 3.5h-.6c-.2-1.8-1.4-3.2-3-3.5v-.6c1.6-.3 2.8-1.7 3-3.5h.6z" opacity={0.6} />
    </svg>
  );
}

function CheckIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} className={className} aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
    </svg>
  );
}

function StageStepper({ stage }: { stage: AgentStage }) {
  const activeIndex = STAGES.findIndex((s) => s.id === stage);
  return (
    <div className="flex w-full items-center" aria-label={`Agent stage: ${STAGES[activeIndex]?.label}`}>
      {STAGES.map((step, index) => {
        const done = index < activeIndex;
        const active = index === activeIndex;
        return (
          <div key={step.id} className={`flex items-center ${index > 0 ? "flex-1" : ""}`}>
            {index > 0 && (
              <div
                className={`mx-2 h-px flex-1 rounded transition-colors duration-700 ${
                  index <= activeIndex
                    ? "bg-gradient-to-r from-indigo-400 to-violet-400"
                    : "bg-slate-200 dark:bg-slate-700"
                }`}
              />
            )}
            <div className="flex items-center gap-1.5">
              {done ? (
                <span className="solver-pop flex h-4 w-4 items-center justify-center rounded-full bg-indigo-500 text-white">
                  <CheckIcon className="h-2.5 w-2.5" />
                </span>
              ) : active ? (
                <span className="solver-breathe flex h-4 w-4 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-violet-500">
                  <span className="h-1.5 w-1.5 rounded-full bg-white/90" />
                </span>
              ) : (
                <span className="h-4 w-4 rounded-full border-2 border-slate-200 dark:border-slate-600" />
              )}
              <span
                className={`text-xs font-medium ${
                  active
                    ? "text-indigo-600 dark:text-indigo-300"
                    : done
                      ? "text-slate-600 dark:text-slate-300"
                      : "text-slate-400 dark:text-slate-500"
                }`}
              >
                {step.label}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function FeedRow({ entry }: { entry: AgentFeedEntry }) {
  if (entry.type === "move") {
    const assign = entry.move.action === "assign";
    return (
      <div className="solver-feed-enter flex items-center gap-2 rounded-lg bg-white/70 px-2.5 py-1.5 dark:bg-slate-800/70">
        <span
          className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[11px] font-bold leading-none ${
            assign
              ? "bg-emerald-100 text-emerald-600 dark:bg-emerald-900/60 dark:text-emerald-300"
              : "bg-rose-100 text-rose-500 dark:bg-rose-900/60 dark:text-rose-300"
          }`}
        >
          {assign ? "+" : "–"}
        </span>
        <span className="min-w-0 truncate text-xs text-slate-600 dark:text-slate-300">
          <span className="font-semibold text-slate-700 dark:text-slate-100">
            {entry.move.clinician}
          </span>
          {assign ? " → " : " ← "}
          {entry.move.section || "shift"}
          <span className="text-slate-400 dark:text-slate-500">
            {" · "}
            {formatFeedDate(entry.move.dateISO)}
            {entry.move.start && ` · ${entry.move.start}–${entry.move.end}`}
          </span>
        </span>
        {entry.improved && (
          <SparkleIcon className="ml-auto h-3 w-3 shrink-0 text-violet-400" />
        )}
      </div>
    );
  }
  if (entry.type === "thought") {
    return (
      <div className="solver-feed-enter flex items-start gap-2 px-2.5 py-1">
        <SparkleIcon className="mt-0.5 h-3 w-3 shrink-0 text-indigo-300 dark:text-indigo-500" />
        <span className="text-xs italic leading-snug text-slate-500 dark:text-slate-400">
          {entry.text}
        </span>
      </div>
    );
  }
  return (
    <div className="solver-feed-enter flex items-center gap-2 px-2.5 py-1">
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />
      <span className="text-xs text-slate-500 dark:text-slate-400">
        {entry.count} change{entry.count === 1 ? "" : "s"} rolled back — {entry.reason}
      </span>
    </div>
  );
}

export default function AgentActivityPanel({ events }: { events: AgentActivityData[] }) {
  const status = useMemo(() => deriveAgentStatus(events), [events]);
  const iterationProgress =
    status.maxIterations && status.maxIterations > 0
      ? Math.min(1, status.iteration / status.maxIterations)
      : 0;

  return (
    <div className="w-full max-w-xl rounded-xl border border-indigo-100 bg-gradient-to-b from-indigo-50/60 to-white p-3 dark:border-indigo-900/50 dark:from-indigo-950/40 dark:to-slate-900">
      <StageStepper stage={status.stage} />

      {status.stage !== "seed" && status.maxIterations !== null && (
        <div className="mt-3 flex items-center gap-3">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
            <div
              className="solver-bar-fill h-full rounded-full bg-gradient-to-r from-indigo-400 via-violet-400 to-fuchsia-400"
              style={{ width: `${Math.round(iterationProgress * 100)}%` }}
            />
          </div>
          <span className="shrink-0 text-[11px] font-medium tabular-nums text-slate-500 dark:text-slate-400">
            Iteration {status.iteration}/{status.maxIterations} · {status.movesAccepted}{" "}
            change{status.movesAccepted === 1 ? "" : "s"}
          </span>
        </div>
      )}

      <div className="mt-3 flex max-h-40 flex-col gap-1 overflow-y-auto pr-1">
        {status.thinking && (
          <div className="flex items-center gap-2 px-2.5 py-1">
            <SparkleIcon className="solver-float h-3.5 w-3.5 text-violet-400" />
            <span className="solver-shimmer-text text-xs font-medium">
              Agent is thinking…
            </span>
          </div>
        )}
        {status.feed.map((entry) => (
          <FeedRow key={entry.key} entry={entry} />
        ))}
        {status.feed.length === 0 && !status.thinking && (
          <div className="flex items-center gap-2 px-2.5 py-1">
            <SparkleIcon className="solver-float h-3.5 w-3.5 text-indigo-300 dark:text-indigo-500" />
            <span className="solver-shimmer-text text-xs font-medium">
              {status.stage === "seed"
                ? "Drafting the initial plan…"
                : "Reviewing the schedule…"}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
