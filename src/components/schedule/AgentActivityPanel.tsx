import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AgentActivityData } from "../../api/client";
import {
  deriveAgentStatus,
  formatActivityTime,
  formatFeedDate,
  type AgentFeedEntry,
  type AgentStage,
} from "../../lib/agentActivity";
import { buttonSmall } from "../../lib/buttonStyles";
import { copyTextToClipboard } from "../../lib/clipboard";

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

export type ThoughtDetails = { text: string; reasoning: boolean; outputTruncated?: boolean };

const RESPONSE_LIMIT_NOTICE = "The model reached its response limit. All received text is shown, but the response may end mid-sentence.";

function ThoughtRow({
  text,
  reasoning,
  outputTruncated,
  onShowFull,
}: {
  text: string;
  reasoning: boolean;
  outputTruncated?: boolean;
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
            onClick={() => onShowFull({ text, reasoning, outputTruncated })}
            className={`${buttonSmall.base} mt-1 block`}
          >
            Show full text
          </button>
        )}
        {long && <p className="mt-1 text-[10px] text-slate-500 dark:text-slate-400">Preview · {text.length.toLocaleString()} characters received</p>}
        {outputTruncated && <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">Model response limit reached.</p>}
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
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.stopPropagation(); onClose(); }
      if (event.key === "Tab") {
        const buttons = dialogRef.current?.querySelectorAll<HTMLButtonElement>("button");
        const first = buttons?.[0];
        const last = buttons?.[buttons.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
          event.preventDefault(); last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault(); first?.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); previousFocus?.focus(); };
  }, [onClose]);
  const copy = async () => {
    // Only confirm when the copy actually worked.
    const ok = await copyTextToClipboard(details.text);
    setCopied(ok);
    if (ok) window.setTimeout(() => setCopied(false), 1500);
  };
  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4 sm:p-8">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-slate-900/50 backdrop-blur-[1px]"
      />
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={details.reasoning ? "Model reasoning (full text)" : "Model output (full text)"} tabIndex={-1} className="relative flex max-h-full w-full max-w-3xl flex-col rounded-2xl border border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900">
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-4 py-2.5 dark:border-slate-800">
          <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">
            {details.reasoning ? "Model reasoning (full text)" : "Model output (full text)"}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void copy()}
              className={buttonSmall.base}
            >
              {copied ? "Copied ✓" : "Copy"}
            </button>
            <button
              type="button"
              onClick={onClose}
              className={buttonSmall.base}
            >
              Close
            </button>
          </div>
        </div>
        {details.outputTruncated && <p className="shrink-0 border-b border-amber-100 bg-amber-50 px-4 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">{RESPONSE_LIMIT_NOTICE}</p>}
        <div className="min-h-0 overflow-y-auto px-4 py-3">
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
        <span className="min-w-0 text-xs text-slate-600 dark:text-slate-300">
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
          {entry.retainedBest === false && <span className="ml-1 text-amber-700 dark:text-amber-300">· Working draft only; earlier best kept</span>}
          {entry.improved && <span className="ml-1 text-emerald-700 dark:text-emerald-300">· Better plan saved</span>}
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
        outputTruncated={entry.outputTruncated}
        onShowFull={onShowFullThought}
      />
    );
  }
  if (entry.type === "tools") {
    return (
      <div className="solver-feed-enter flex items-start gap-2 px-2.5 py-1.5">
        <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${entry.outcome === "error" || entry.outcome === "warning" ? "bg-amber-500" : "bg-sky-500"}`} />
        <div className="min-w-0 text-xs text-slate-700 dark:text-slate-200">
          <span className="font-medium">{entry.label}</span>
          {typeof entry.durationMs === "number" && <span className="ml-2 whitespace-nowrap tabular-nums text-slate-400">{(entry.durationMs / 1000).toFixed(1)}s</span>}
          {entry.summary && <p className={`mt-0.5 leading-relaxed ${entry.outcome === "warning" || entry.outcome === "error" ? "text-amber-700 dark:text-amber-300" : "text-slate-500 dark:text-slate-400"}`}>{entry.summary}</p>}
        </div>
      </div>
    );
  }
  if (entry.type === "notice") {
    return <p className={`px-2.5 py-1.5 text-xs font-medium ${entry.warning ? "text-amber-700 dark:text-amber-300" : "text-indigo-700 dark:text-indigo-300"}`}>{entry.label}</p>;
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

export default function AgentActivityPanel({ events, elapsedMs = 0, currentPhase, liveConnected = true }: {
  events: AgentActivityData[];
  elapsedMs?: number;
  currentPhase?: string | null;
  liveConnected?: boolean;
}) {
  const status = useMemo(() => deriveAgentStatus(events), [events]);
  const [fullThought, setFullThought] = useState<ThoughtDetails | null>(null);
  const closeThought = useCallback(() => setFullThought(null), []);
  const [includeModelText, setIncludeModelText] = useState(false);
  const feedRef = useRef<HTMLDivElement>(null);
  const waitSeconds = Math.max(0, Math.floor((elapsedMs - status.actionStartedMs) / 1000));
  const visibleFeed = status.feed.filter((entry) => includeModelText || entry.type !== "thought");
  const phase = status.stage === "finalize" ? "Finalize the best draft"
    : status.phaseLabel ?? currentPhase ?? "Prepare the planning run";
  return (
    <div className="w-full rounded-xl border border-indigo-100 bg-gradient-to-b from-indigo-50/60 to-white p-3 sm:p-4 dark:border-indigo-900/50 dark:from-indigo-950/40 dark:to-slate-900">
      <StageStepper stage={status.stage} />
      <div className="mt-4 rounded-lg border border-indigo-100 bg-white/80 p-3 dark:border-indigo-900 dark:bg-slate-900/70">
        <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-medium text-slate-500 dark:text-slate-400">
          <span>{status.planningDate && status.dayIndex ? `Day ${status.dayIndex} of ${status.totalDays} · ${formatFeedDate(status.planningDate)}` : phase}</span>
          <span className="tabular-nums">Step {status.iteration} · {status.movesAccepted} draft changes</span>
        </div>
        <div role="status" className="mt-2 flex items-start gap-2 text-sm font-semibold text-slate-800 dark:text-slate-100">
          <SparkleIcon className={`mt-0.5 h-4 w-4 shrink-0 text-indigo-500 ${liveConnected ? "solver-float" : ""}`} />
          <span>{liveConnected ? status.currentAction : "Live updates interrupted"}</span>
        </div>
        {!liveConnected ? (
          <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">The connection is being restored. The run continues on the server; this view may be out of date. If updates do not resume, reload the page.</p>
        ) : (
          <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            <span className="tabular-nums">{formatActivityTime(waitSeconds * 1000)} in this step</span>
            {status.thinking && waitSeconds >= 30 && <span> · Waiting for the model response; complex steps can take a few minutes.</span>}
          </div>
        )}
        {status.checksProgress && <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
          Current plan: {status.checksProgress.complete}/{status.checksProgress.total} day checks complete.
          Checks restart when assignments change.
        </p>}
        {status.lastResult && <p className="mt-2 border-t border-slate-100 pt-2 text-xs leading-relaxed text-slate-600 dark:border-slate-800 dark:text-slate-300"><span className="font-medium">Last result: </span>{status.lastResult}</p>}
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
          <input type="checkbox" checked={includeModelText} onChange={(e) => setIncludeModelText(e.target.checked)} className="accent-indigo-600" />
          Include model text
        </label>
        <button type="button" className={buttonSmall.base} disabled={visibleFeed.length === 0} onClick={() => {
          if (feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight;
        }}>Jump to latest ↓</button>
      </div>
      {/* Only an explicit click scrolls: readers keep their place as results arrive. */}
      <div ref={feedRef} role="region" aria-label="Planning activity" tabIndex={0} className="mt-2 flex max-h-64 flex-col gap-1 overflow-y-auto overscroll-contain pr-1 [overflow-anchor:none]">
        {visibleFeed.map((entry) => (
          <div key={entry.key} className="flex items-start gap-1 border-b border-slate-100 py-1 last:border-0 dark:border-slate-800">
            <span className="w-9 shrink-0 pt-1.5 text-right text-[10px] tabular-nums text-slate-400">{formatActivityTime(entry.timeMs)}</span>
            <div className="min-w-0 flex-1"><FeedRow entry={entry} onShowFullThought={setFullThought} /></div>
          </div>
        ))}
        {visibleFeed.length === 0 && <p className="px-2 py-3 text-xs text-slate-500">Checks and draft changes will appear here as they happen.</p>}
      </div>
      <p className="mt-2 text-[10px] leading-relaxed text-slate-400">Recent activity · Changes below belong to the working draft. The best saved plan is shown in the coverage figures.</p>
      {fullThought && (
        <ThoughtDialog details={fullThought} onClose={closeThought} />
      )}
    </div>
  );
}
