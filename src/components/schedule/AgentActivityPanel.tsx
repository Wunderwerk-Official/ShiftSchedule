import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import type { AgentActivityData } from "../../api/client";
import {
  deriveAgentStatus,
  formatActivityTime,
  formatFeedDate,
  type AgentFeedEntry,
  type AgentStatus,
} from "../../lib/agentActivity";
import { buttonSmall } from "../../lib/buttonStyles";
import { cx } from "../../lib/classNames";
import { copyTextToClipboard } from "../../lib/clipboard";

// Live view of the agent solver inside SolverOverlay (solver_mode "agent"):
// a day track over the planning range with the agent's current step, then
// (slot) the best plan so far, then the activity log — collapsed to its
// latest entry, so the overlay stays readable while the agent works.

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** The ISO dates of a planning range (at most 62, oldest first). */
export function rangeDays(range?: { startISO: string; endISO: string } | null): string[] {
  if (!range) return [];
  const parse = (iso: string) => {
    const [year, month, day] = iso.split("-").map(Number);
    return year && month && day ? Date.UTC(year, month - 1, day) : NaN;
  };
  const start = parse(range.startISO);
  const end = parse(range.endISO);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
  const days: string[] = [];
  for (let t = start; t <= end && days.length < 62; t += 86_400_000) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  return days;
}

function SparkleIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M12 2c.4 3.9 3 6.9 7 7.5v1c-4 .6-6.6 3.6-7 7.5h-1c-.4-3.9-3-6.9-7-7.5v-1c4-.6 6.6-3.6 7-7.5h1z" />
      <path d="M19 14c.2 1.8 1.4 3.2 3 3.5v.6c-1.6.3-2.8 1.7-3 3.5h-.6c-.2-1.8-1.4-3.2-3-3.5v-.6c1.6-.3 2.8-1.7 3-3.5h.6z" opacity={0.6} />
    </svg>
  );
}

type DayState = "done" | "current" | "skipped" | "open";

/**
 * One segment per day of the range: planned, in progress (pulsing), skipped
 * (amber) or still open. Short ranges name their days below the segments.
 */
function DayTrack({ days, states }: { days: string[]; states: DayState[] }) {
  const total = states.length;
  const done = states.filter((state) => state === "done").length;
  const skipped = states.filter((state) => state === "skipped").length;
  const labelled = days.length === total && total <= 10;
  return (
    <div>
      <div
        role="progressbar"
        aria-label="Days planned"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
        aria-valuetext={`${done} of ${total} days planned${skipped ? `, ${skipped} skipped` : ""}`}
        className={cx("flex", total > 14 ? "gap-px" : "gap-1")}
      >
        {states.map((state, index) => (
          <span
            key={index}
            data-day-state={state}
            title={state === "skipped" ? "Skipped: this day was not planned" : undefined}
            className={cx(
              "h-1.5 flex-1 rounded-full transition-colors duration-700",
              state === "done"
                ? "bg-indigo-500 dark:bg-indigo-400"
                : state === "current"
                  ? "bg-indigo-300 motion-safe:animate-pulse dark:bg-indigo-400/45"
                  : state === "skipped"
                    ? "bg-amber-400 dark:bg-amber-500/70"
                    : "bg-slate-200 dark:bg-slate-700",
            )}
          />
        ))}
      </div>
      {labelled ? (
        <div className={cx("mt-1 flex", total > 14 ? "gap-px" : "gap-1")} aria-hidden="true">
          {days.map((dateISO, index) => {
            const [year, month, day] = dateISO.split("-").map(Number);
            const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
            const state = states[index];
            return (
              <span
                key={dateISO}
                className={cx(
                  "flex-1 truncate text-center text-[10px] tabular-nums",
                  state === "current"
                    ? "font-semibold text-indigo-600 dark:text-indigo-300"
                    : state === "skipped"
                      ? "text-amber-700 dark:text-amber-300"
                      : state === "done"
                        ? "text-slate-500 dark:text-slate-400"
                        : "text-slate-400 dark:text-slate-500",
                )}
              >
                {weekday} {String(day).padStart(2, "0")}
              </span>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Day states for the track, or null when the run has no day loop (repair
 * strategy). New servers send the finished and skipped days with every
 * event; for older ones the context is read: days before the current one
 * are done, and once the context drops the day again (whole-range review,
 * finalize) every day counts as done.
 */
function dayStates(status: AgentStatus, days: string[]): DayState[] | null {
  const total = status.totalDays ?? days.length;
  if (total <= 0) return null;
  const current = status.stage !== "finalize" && status.dayIndex ? status.dayIndex - 1 : null;
  if (status.daysFinished) {
    const finished = new Set(status.daysFinished);
    const skipped = new Set(status.daysSkipped ?? []);
    const byDate = days.length === total;
    return Array.from({ length: total }, (_, index): DayState => {
      if (index === current) return "current";
      if (byDate) {
        if (finished.has(days[index])) return "done";
        if (skipped.has(days[index])) return "skipped";
        return "open";
      }
      return index < finished.size ? "done" : "open";
    });
  }
  if (status.totalDays === null) return null;
  const reviewing = status.stage === "finalize" || (status.dayIndex === null && status.maxDayIndex !== null);
  const done = reviewing ? total : current !== null ? Math.min(total, current) : 0;
  return Array.from({ length: total }, (_, index): DayState =>
    index === current ? "current" : index < done ? "done" : "open",
  );
}

/**
 * Where the run stands: phase or day, the day track, and the agent's current
 * step with its duration. The step sits in role="status" so screen readers
 * hear it change.
 */
export function AgentRunProgress({ status, range, elapsedMs = 0, currentPhase, liveConnected = true }: {
  status: AgentStatus;
  range?: { startISO: string; endISO: string } | null;
  elapsedMs?: number;
  currentPhase?: string | null;
  liveConnected?: boolean;
}) {
  const days = rangeDays(range);
  const states = dayStates(status, days);
  const total = states?.length ?? 0;
  const waitSeconds = Math.max(0, Math.floor((elapsedMs - status.actionStartedMs) / 1000));
  const phase = status.stage === "finalize"
    ? "Finishing: the best plan is prepared for review"
    : status.planningDate && status.dayIndex
      ? `Day ${status.dayIndex} of ${status.totalDays ?? total} · ${formatFeedDate(status.planningDate)}`
      : status.stage === "seed" && !status.phaseLabel
        ? "Drafting a first plan"
        : status.phaseLabel ?? currentPhase ?? "Preparing the planning run";
  const checks = status.checksProgress;
  return (
    <section aria-label="Planning progress" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{phase}</p>
        <p className="text-[11px] tabular-nums text-slate-400 dark:text-slate-500">
          Step {status.iteration} · {status.movesAccepted} draft change{status.movesAccepted === 1 ? "" : "s"}
          {checks ? (
            <span title="Final day checks of the current plan. They start over when assignments change.">
              {" "}· Current plan: {checks.complete}/{checks.total} days checked
            </span>
          ) : null}
        </p>
      </div>
      {states ? <DayTrack days={days} states={states} /> : null}
      <div className="flex items-start gap-2.5 rounded-xl bg-slate-50 px-3 py-2.5 dark:bg-slate-800/60">
        <SparkleIcon
          className={cx("mt-0.5 h-4 w-4 shrink-0", liveConnected ? "solver-float text-indigo-500" : "text-amber-500")}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3">
            <p role="status" className="min-w-0 text-sm font-medium text-slate-800 dark:text-slate-100">
              {liveConnected ? status.currentAction : "Live updates interrupted"}
            </p>
            {liveConnected ? (
              <span className="shrink-0 text-[11px] tabular-nums text-slate-400 dark:text-slate-500">
                {formatActivityTime(waitSeconds * 1000)} in this step
              </span>
            ) : null}
          </div>
          {!liveConnected ? (
            <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
              The connection is being restored. The run continues on the server; this view may be
              out of date. If updates do not resume, reload the page.
            </p>
          ) : status.thinking && waitSeconds >= 30 ? (
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              Waiting for the model response; complex steps can take a few minutes.
            </p>
          ) : null}
          {status.lastResult ? (
            <p className="mt-1 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
              <span className="font-medium text-slate-600 dark:text-slate-300">Last result: </span>
              {status.lastResult}
            </p>
          ) : null}
        </div>
      </div>
    </section>
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

/** One line for the collapsed log: what happened last (model text excluded). */
function entrySummary(entry: AgentFeedEntry): string {
  switch (entry.type) {
    case "move": {
      const { move } = entry;
      const arrow = move.action === "assign" ? "→" : "←";
      const note = entry.improved ? " · Better plan saved" : "";
      return `${move.clinician} ${arrow} ${move.section || "shift"} · ${formatFeedDate(move.dateISO)}${note}`;
    }
    case "tools":
      return entry.summary ? `${entry.label}: ${entry.summary}` : entry.label;
    case "notice":
      return entry.label;
    case "rejected":
      return `${entry.count} change${entry.count === 1 ? "" : "s"} rolled back — ${entry.reason}`;
    default:
      return entry.text;
  }
}

/**
 * The agent's activity log. Collapsed it shows only the latest entry; opened
 * it lists the recent activity (model text on request). Only an explicit
 * click scrolls: readers keep their place as results arrive.
 */
export function AgentActivityLog({ status, open, onOpenChange }: {
  status: AgentStatus;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [fullThought, setFullThought] = useState<ThoughtDetails | null>(null);
  const closeThought = useCallback(() => setFullThought(null), []);
  const [includeModelText, setIncludeModelText] = useState(false);
  const feedRef = useRef<HTMLDivElement>(null);
  const bodyId = useId();
  const visibleFeed = status.feed.filter((entry) => includeModelText || entry.type !== "thought");
  const activity = status.feed.filter((entry) => entry.type !== "thought");
  const latest = activity[activity.length - 1];
  return (
    <section className="rounded-xl border border-slate-200 dark:border-slate-700">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => onOpenChange(!open)}
        className="flex w-full items-start gap-2 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/60"
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
          className={cx("mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform", open && "rotate-90")}>
          <path d="M6 3.5 10.5 8 6 12.5" />
        </svg>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-2">
            <span className="text-xs font-semibold text-slate-700 dark:text-slate-200">Activity log</span>
            <span className="text-[11px] tabular-nums text-slate-400 dark:text-slate-500">
              {activity.length === 0 ? "nothing yet" : `${activity.length} recent`}
            </span>
          </span>
          {!open && latest ? (
            <span className="mt-0.5 flex gap-2 text-xs text-slate-500 dark:text-slate-400">
              <span className="shrink-0 tabular-nums text-slate-400 dark:text-slate-500">{formatActivityTime(latest.timeMs)}</span>
              <span className="min-w-0 truncate">{entrySummary(latest)}</span>
            </span>
          ) : null}
        </span>
      </button>
      {open ? (
        <div id={bodyId} className="border-t border-slate-100 px-3 pb-3 dark:border-slate-800">
          <div className="flex flex-wrap items-center justify-between gap-2 py-2">
            <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
              <input type="checkbox" checked={includeModelText} onChange={(e) => setIncludeModelText(e.target.checked)} className="accent-indigo-600" />
              Include model text
            </label>
            <button type="button" className={buttonSmall.base} disabled={visibleFeed.length === 0} onClick={() => {
              if (feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight;
            }}>Jump to latest ↓</button>
          </div>
          <div ref={feedRef} role="region" aria-label="Planning activity" tabIndex={0} className="flex max-h-60 flex-col gap-1 overflow-y-auto overscroll-contain pr-1 [overflow-anchor:none]">
            {visibleFeed.map((entry) => (
              <div key={entry.key} className="flex items-start gap-1 border-b border-slate-100 py-1 last:border-0 dark:border-slate-800">
                <span className="w-9 shrink-0 pt-1.5 text-right text-[10px] tabular-nums text-slate-400">{formatActivityTime(entry.timeMs)}</span>
                <div className="min-w-0 flex-1"><FeedRow entry={entry} onShowFullThought={setFullThought} /></div>
              </div>
            ))}
            {visibleFeed.length === 0 && <p className="px-2 py-3 text-xs text-slate-500">Checks and draft changes will appear here as they happen.</p>}
          </div>
          <p className="mt-2 text-[10px] leading-relaxed text-slate-400">
            Changes in the log belong to the working draft. &ldquo;Best plan so far&rdquo; above shows the plan that would be applied.
          </p>
        </div>
      ) : null}
      {fullThought && (
        <ThoughtDialog details={fullThought} onClose={closeThought} />
      )}
    </section>
  );
}

/**
 * Progress, then `children` (the overlay puts the best plan so far there),
 * then the log. The log's open state can be held by the caller, so it
 * survives hiding the overlay ("Run in background") and opening it again.
 */
export default function AgentActivityPanel({
  events,
  elapsedMs = 0,
  currentPhase,
  liveConnected = true,
  range,
  logOpen,
  onLogOpenChange,
  children,
}: {
  events: AgentActivityData[];
  elapsedMs?: number;
  currentPhase?: string | null;
  liveConnected?: boolean;
  range?: { startISO: string; endISO: string } | null;
  logOpen?: boolean;
  onLogOpenChange?: (open: boolean) => void;
  children?: ReactNode;
}) {
  const status = useMemo(() => deriveAgentStatus(events), [events]);
  const [ownLogOpen, setOwnLogOpen] = useState(false);
  return (
    <div className="flex w-full flex-col gap-4">
      <AgentRunProgress
        status={status}
        range={range}
        elapsedMs={elapsedMs}
        currentPhase={currentPhase}
        liveConnected={liveConnected}
      />
      {children}
      <AgentActivityLog
        status={status}
        open={logOpen ?? ownLogOpen}
        onOpenChange={onLogOpenChange ?? setOwnLogOpen}
      />
    </div>
  );
}
