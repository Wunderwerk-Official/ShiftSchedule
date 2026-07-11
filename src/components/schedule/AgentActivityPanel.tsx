import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
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

// Long model output stays readable: short texts render inline; anything
// longer shows a preview plus a button that opens the COMPLETE text in a
// dedicated dialog (reasoning chains of large models are pages long — an
// inline toggle inside the small scroll area could never show them whole).
const THOUGHT_PREVIEW_CHARS = 220;

export type ThoughtDetails = { text: string; reasoning: boolean };

function ThoughtRow({
  text,
  reasoning,
  onShowFull,
}: {
  text: string;
  reasoning: boolean;
  onShowFull: (details: ThoughtDetails) => void;
}) {
  const long = text.length > THOUGHT_PREVIEW_CHARS;
  return (
    <div className="solver-feed-enter flex items-start gap-2 px-2.5 py-1">
      <SparkleIcon
        className={`mt-0.5 h-3 w-3 shrink-0 ${
          reasoning
            ? "text-violet-300 dark:text-violet-500"
            : "text-indigo-300 dark:text-indigo-500"
        }`}
      />
      <div className="min-w-0 flex-1">
        {reasoning && (
          <span className="mr-1.5 rounded bg-violet-100 px-1 py-px text-[10px] font-medium uppercase tracking-wide text-violet-500 dark:bg-violet-900/50 dark:text-violet-300">
            reasoning
          </span>
        )}
        <span className="whitespace-pre-wrap text-xs italic leading-snug text-slate-500 dark:text-slate-400">
          {long ? `${text.slice(0, THOUGHT_PREVIEW_CHARS)}…` : text}
        </span>
        {long && (
          <button
            type="button"
            onClick={() => onShowFull({ text, reasoning })}
            className="mt-0.5 block text-[11px] font-medium text-indigo-500 hover:text-indigo-600 dark:text-indigo-400 dark:hover:text-indigo-300"
          >
            Show full text
          </button>
        )}
      </div>
    </div>
  );
}

function ThoughtDialog({
  details,
  onClose,
}: {
  details: ThoughtDetails;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(details.text);
      setCopied(true);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = details.text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
      setCopied(true);
    }
    window.setTimeout(() => setCopied(false), 1500);
  };
  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4 sm:p-8">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-slate-900/50 backdrop-blur-[1px]"
      />
      <div className="relative flex max-h-full w-full max-w-3xl flex-col rounded-2xl border border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900">
        <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-2.5 dark:border-slate-800">
          <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">
            {details.reasoning ? "Model reasoning (full text)" : "Model output (full text)"}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void copy()}
              className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              {copied ? "Copied ✓" : "Copy"}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              Close
            </button>
          </div>
        </div>
        <div className="overflow-y-auto px-4 py-3">
          <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-slate-700 dark:text-slate-200">
            {details.text}
          </pre>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function FeedRow({
  entry,
  onShowFullThought,
}: {
  entry: AgentFeedEntry;
  onShowFullThought: (details: ThoughtDetails) => void;
}) {
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
      <ThoughtRow
        text={entry.text}
        reasoning={entry.reasoning}
        onShowFull={onShowFullThought}
      />
    );
  }
  if (entry.type === "tools") {
    return (
      <div className="solver-feed-enter flex items-center gap-2 px-2.5 py-1">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-sky-400" />
        <span className="min-w-0 truncate text-xs text-slate-400 dark:text-slate-500">
          {entry.label}
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
  const [fullThought, setFullThought] = useState<ThoughtDetails | null>(null);
  // The feed is chronological (newest at the BOTTOM) and only follows new
  // rows when the reader is already at the bottom — someone scrolled up to
  // read an earlier thought must never be yanked away from it.
  const feedRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);
  const onFeedScroll = () => {
    const el = feedRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };
  useEffect(() => {
    const el = feedRef.current;
    if (el && atBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [status.feed.length, status.thinking]);
  // Seconds since the last live event: with adaptive thinking a single model
  // step can take minutes on large plans, which used to look like a hang.
  const lastEventAtRef = useRef(Date.now());
  const [waitSeconds, setWaitSeconds] = useState(0);
  useEffect(() => {
    lastEventAtRef.current = Date.now();
    setWaitSeconds(0);
  }, [events.length]);
  useEffect(() => {
    const id = window.setInterval(() => {
      setWaitSeconds(Math.floor((Date.now() - lastEventAtRef.current) / 1000));
    }, 1000);
    return () => window.clearInterval(id);
  }, []);
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

      <div
        ref={feedRef}
        onScroll={onFeedScroll}
        className="mt-3 flex max-h-40 flex-col gap-1 overflow-y-auto pr-1"
      >
        {status.feed.map((entry) => (
          <FeedRow key={entry.key} entry={entry} onShowFullThought={setFullThought} />
        ))}
        {status.thinking && (
          <div className="flex items-center gap-2 px-2.5 py-1">
            <SparkleIcon className="solver-float h-3.5 w-3.5 text-violet-400" />
            <span className="solver-shimmer-text text-xs font-medium">
              {waitSeconds > 90
                ? `Still working — large plans can take a few minutes per step… (${waitSeconds}s)`
                : `Agent is thinking…${waitSeconds >= 10 ? ` (${waitSeconds}s)` : ""}`}
            </span>
          </div>
        )}
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
      {fullThought && (
        <ThoughtDialog details={fullThought} onClose={() => setFullThought(null)} />
      )}
    </div>
  );
}
