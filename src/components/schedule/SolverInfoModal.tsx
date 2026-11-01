import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { SolverRunDetail, SolverRunSummary, SolverSettings } from "../../api/client";
import { cx } from "../../lib/classNames";
import { copyTextToClipboard } from "../../lib/clipboard";
import { AGENT_MODEL_OPTIONS, estimateAgentCostUSD, formatCostUSD } from "../../lib/llmPricing";
import { formatFeedDate } from "../../lib/agentActivity";
import { heuristicFallbackNotice } from "../../lib/solverOutcome";
import {
  buildRunLog,
  downloadTextFile,
  formatRunDuration,
  modelSelectionNotice,
  serverRunToHistoryEntry,
  type SolverHistoryEntry,
} from "../../lib/runLog";
import SolverDebugPanel from "./SolverDebugPanel";
import type { StatsHistoryEntry } from "./SolverOverlay";

// Default weights for the solver optimization
const DEFAULT_WEIGHTS = {
  weightCoverage: 1000,
  weightSlack: 1000,
  weightTotalAssignments: 100,
  weightSlotPriority: 10,
  weightTimeWindow: 20,
  weightSectionPreference: 10,
  weightWorkingHours: 3,
  weightMinimumDailyHours: 5,
  weightYtdBalance: 5,
};

type WeightKey = keyof typeof DEFAULT_WEIGHTS;

const WEIGHT_LABELS: Record<
  WeightKey,
  { label: string; description: string; tooltip: string; distributeOnly?: boolean }
> = {
  weightCoverage: {
    label: "Coverage",
    description: "Fill required slots",
    tooltip: "Ensures every shift that needs someone gets at least one person assigned. Higher values make filling empty shifts the top priority.",
  },
  weightSlack: {
    label: "Slack",
    description: "Minimize unfilled slots",
    tooltip: "When a shift needs multiple people (e.g., 3 required), this pushes to fill all positions, not just the first one.",
  },
  weightTotalAssignments: {
    label: "Total Assignments",
    description: "Distribute All only",
    tooltip: "Tries to give everyone work. Only active when using 'Distribute All' mode - ignored when filling required slots only.",
    distributeOnly: true,
  },
  weightSlotPriority: {
    label: "Slot Priority",
    description: "Distribute All only",
    tooltip: "Fills shifts in the order they appear in your template. Only active when using 'Distribute All' mode.",
    distributeOnly: true,
  },
  weightTimeWindow: {
    label: "Time Window",
    description: "Respect preferred times",
    tooltip: "Considers each person's preferred working hours. Higher values mean the planner tries harder to match people with their preferred time slots.",
  },
  weightSectionPreference: {
    label: "Section Preference",
    description: "Prefer assigned sections",
    tooltip: "Assigns people to sections they've marked as preferred. Higher values mean preferences are respected more strongly.",
  },
  weightWorkingHours: {
    label: "Working Hours",
    description: "Balance weekly hours",
    tooltip: "Tries to match each person's target weekly hours. Prevents overworking or underworking relative to their contract.",
  },
  weightMinimumDailyHours: {
    label: "Minimum Daily Hours",
    description: "Avoid short daily assignments",
    tooltip: "Penalizes assigning someone to just a short slot (e.g. 1 hour) with nothing else that day. Minimum is derived from preferred working times or weekly hours.",
  },
  weightYtdBalance: {
    label: "YTD Balance",
    description: "Fair year-to-date distribution",
    tooltip: "Gives priority to clinicians who are behind on their year-to-date hours target. Helps balance workload across the year.",
  },
};

type SolverInfoModalProps = {
  isOpen: boolean;
  onClose: () => void;
  serverRuns: SolverRunSummary[];
  onApplyRun: (runId: string) => Promise<void>;
  onDiscardRun: (runId: string) => Promise<void>;
  onRefreshRuns: () => Promise<void>;
  onFetchRunDetail: (runId: string) => Promise<SolverRunDetail>;
  onSendFeedback: (runId: string, comment: string) => Promise<void>;
  /** Stats collected while THIS tab watched the run live (per-solution
   * progression is never stored server-side) - merged into the detail
   * view when available. */
  getLocalRunStats?: (runId: string) => StatsHistoryEntry[] | undefined;
  solverSettings?: SolverSettings;
  onSolverSettingsChange?: (settings: Partial<SolverSettings>) => void;
};

const RUN_STATUS_LABEL: Record<string, string> = {
  running: "Running",
  finished: "Ready to apply",
  aborted: "Aborted",
  failed: "Failed",
  crashed: "Interrupted",
  applied: "Applied",
  discarded: "Discarded",
};


const formatEuropeanDate = (dateISO: string) => {
  const [year, month, day] = dateISO.split("-");
  if (!year || !month || !day) return dateISO;
  return `${day}.${month}.${year}`;
};

const formatDateTime = (timestamp: number) => {
  const date = new Date(timestamp);
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${day}.${month}. ${hours}:${minutes}`;
};

function GearIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M12 15a3 3 0 100-6 3 3 0 000 6z" />
      <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z" />
    </svg>
  );
}

function CloseIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 20 20"
      fill="currentColor"
      className={className}
    >
      <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
    </svg>
  );
}

function BackIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 20 20"
      fill="currentColor"
      className={className}
    >
      <path
        fillRule="evenodd"
        d="M17 10a.75.75 0 01-.75.75H5.612l4.158 3.96a.75.75 0 11-1.04 1.08l-5.5-5.25a.75.75 0 010-1.08l5.5-5.25a.75.75 0 111.04 1.08L5.612 9.25H16.25A.75.75 0 0117 10z"
        clipRule="evenodd"
      />
    </svg>
  );
}

// Compact stats chart - for displaying completed run stats in a smaller form
const iconProps = {
  fill: "none",
  viewBox: "0 0 24 24",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

function SparkIcon({ className }: { className?: string }) {
  return (
    <svg className={className} {...iconProps}>
      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z" />
      <path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15z" />
    </svg>
  );
}

function ClockIcon({ className }: { className?: string }) {
  return (
    <svg className={className} {...iconProps}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

function ChevronRightIcon({ className }: { className?: string }) {
  return (
    <svg className={className} {...iconProps}>
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

function DownloadIcon({ className }: { className?: string }) {
  return (
    <svg className={className} {...iconProps}>
      <path d="M12 4v11m0 0l-4-4m4 4l4-4M5 20h14" />
    </svg>
  );
}

function ChatIcon({ className }: { className?: string }) {
  return (
    <svg className={className} {...iconProps}>
      <path d="M21 12a8 8 0 01-11.6 7.1L4 20l1.1-4.6A8 8 0 1121 12z" />
    </svg>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg className={className} {...iconProps}>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

function AlertIcon({ className }: { className?: string }) {
  return (
    <svg className={className} {...iconProps}>
      <path d="M12 9v4m0 4h.01M10.3 3.9L2.4 17.5A2 2 0 004.1 20.5h15.8a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z" />
    </svg>
  );
}

export type RunIssue = { count: number; label: string; severe: boolean };

// "Unresolved after this run: 11 open slot(s), 3 short day(s), 7 over-long
// day(s), 4 placement(s) outside preferred working times." → chips. Returns
// null when the note has another shape (the card then shows it as text).
const ISSUE_LABELS: Array<{ pattern: RegExp; one: string; many: string; severe: boolean }> = [
  { pattern: /^open slot\(s\)$/, one: "open slot", many: "open slots", severe: true },
  { pattern: /^short day\(s\)$/, one: "short day", many: "short days", severe: false },
  { pattern: /^over-long day\(s\)$/, one: "over-long day", many: "over-long days", severe: false },
  {
    pattern: /^placement\(s\) outside preferred working times$/,
    one: "outside preferred times",
    many: "outside preferred times",
    severe: false,
  },
];

export function parseUnresolvedNote(note: string): RunIssue[] | null {
  const prefix = "Unresolved after this run:";
  if (!note.startsWith(prefix)) return null;
  const parts = note.slice(prefix.length).trim().replace(/\.$/, "").split(/,\s*/);
  const issues: RunIssue[] = [];
  for (const part of parts) {
    const match = /^(\d+)\s+(.+)$/.exec(part.trim());
    if (!match) return null;
    const count = Number(match[1]);
    const known = ISSUE_LABELS.find((item) => item.pattern.test(match[2]));
    if (!known) return null;
    if (count > 0) issues.push({ count, label: count === 1 ? known.one : known.many, severe: known.severe });
  }
  return issues;
}

/** "2026-11-01T16:56:12" → "01.11.2026, 16:56" (the stored time, unchanged). */
const formatRunStarted = (createdAt: string) => {
  const [datePart, timePart = ""] = createdAt.split("T");
  const date = /^\d{4}-\d{2}-\d{2}$/.test(datePart) ? formatEuropeanDate(datePart) : datePart;
  return timePart ? `${date}, ${timePart.slice(0, 5)}` : date;
};

const RUN_STATUS_STYLE: Record<string, { pill: string; dot: string }> = {
  finished: {
    pill: "bg-indigo-50 text-indigo-700 ring-indigo-200 dark:bg-indigo-900/30 dark:text-indigo-300 dark:ring-indigo-800",
    dot: "bg-indigo-500",
  },
  applied: {
    pill: "bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300 dark:ring-emerald-800",
    dot: "bg-emerald-500",
  },
  running: {
    pill: "bg-sky-50 text-sky-700 ring-sky-200 dark:bg-sky-900/30 dark:text-sky-300 dark:ring-sky-800",
    dot: "bg-sky-500 animate-pulse",
  },
  aborted: {
    pill: "bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:ring-amber-800",
    dot: "bg-amber-500",
  },
  crashed: {
    pill: "bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:ring-amber-800",
    dot: "bg-amber-500",
  },
  failed: {
    pill: "bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-900/30 dark:text-rose-300 dark:ring-rose-800",
    dot: "bg-rose-500",
  },
  discarded: {
    pill: "bg-slate-100 text-slate-600 ring-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700",
    dot: "bg-slate-400",
  },
};

const PLANNER_CONSIDERS = [
  "Qualifications and working hours",
  "Vacations and rest days",
  "Minimum staffing of every slot",
  "Preferred times and continuous shifts",
  "Fair workload across the team",
  "Your free-text instructions",
];

const ghostButtonClass =
  "inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-800 disabled:opacity-50 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-slate-100";
const secondaryButtonClass =
  "rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 shadow-sm transition-colors hover:border-slate-300 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700";
const primaryButtonClass =
  "rounded-lg bg-indigo-600 px-3.5 py-1.5 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-indigo-500 dark:hover:bg-indigo-400";

function CompactStatsChart({
  data,
  dataKey,
  totalDurationMs,
  color,
  labelSuffix,
}: {
  data: StatsHistoryEntry[];
  dataKey: keyof StatsHistoryEntry;
  totalDurationMs: number;
  color: string;
  labelSuffix?: string;
}) {
  if (data.length === 0) return null;

  const width = 200;
  const height = 60;
  const padding = { top: 8, right: 8, bottom: 8, left: 8 };
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;

  const values = data.map((d) => d[dataKey] as number);
  const dataMin = Math.min(...values);
  const dataMax = Math.max(...values);

  let minVal = dataMin;
  let maxVal = dataMax;

  if (minVal === maxVal) {
    const padding_amount = Math.max(1, Math.abs(minVal * 0.1));
    minVal = minVal - padding_amount;
    maxVal = maxVal + padding_amount;
  }

  const range = maxVal - minVal;
  const maxTimeMs = totalDurationMs * 1.1;

  // Build step path
  const points: { x: number; y: number; value: number }[] = [];
  for (let i = 0; i < data.length; i++) {
    const d = data[i];
    const val = d[dataKey] as number;
    const normalized = (val - minVal) / range;
    const y = padding.top + (1 - normalized) * innerHeight;
    const x = padding.left + (d.time_ms / maxTimeMs) * innerWidth;
    points.push({ x, y, value: val });

    // Extend to next point or total duration
    const nextTime = i < data.length - 1 ? data[i + 1].time_ms : totalDurationMs;
    const nextX = padding.left + (nextTime / maxTimeMs) * innerWidth;
    points.push({ x: nextX, y, value: val });
  }

  const linePath = points.length > 0
    ? `M ${points.map((p) => `${p.x},${p.y}`).join(" L ")}`
    : "";

  const currentValue = points.length > 0 ? points[points.length - 1].value : 0;
  const labelText = labelSuffix ? `${currentValue}${labelSuffix}` : `${currentValue}`;

  return (
    <div className="flex items-center gap-3">
      <svg viewBox={`0 0 ${width} ${height}`} className="h-12 w-full max-w-[120px] overflow-visible">
        {/* Line path */}
        {linePath && (
          <path d={linePath} fill="none" stroke={color} strokeWidth={1.5} />
        )}
        {/* Axis line */}
        <line
          x1={padding.left}
          y1={height - padding.bottom}
          x2={width - padding.right}
          y2={height - padding.bottom}
          stroke="currentColor"
          strokeOpacity={0.1}
        />
      </svg>
      <div className="text-lg font-semibold" style={{ color }}>
        {labelText}
      </div>
    </div>
  );
}

type View = "info" | "detail";

export default function SolverInfoModal({
  isOpen,
  onClose,
  serverRuns,
  onApplyRun,
  onDiscardRun,
  onRefreshRuns,
  onFetchRunDetail,
  onSendFeedback,
  getLocalRunStats,
  solverSettings,
  onSolverSettingsChange,
}: SolverInfoModalProps) {
  const [busyRunId, setBusyRunId] = useState<string | null>(null);
  const [view, setView] = useState<View>("info");
  const [selectedEntry, setSelectedEntry] = useState<SolverHistoryEntry | null>(null);
  const [weightsExpanded, setWeightsExpanded] = useState(false);
  // "How the agent plans": collapsed while there are runs to look at.
  const [explainOpen, setExplainOpen] = useState(serverRuns.length === 0);
  const [debugExpanded, setDebugExpanded] = useState(false);
  const [logCopied, setLogCopied] = useState(false);
  const [feedbackFor, setFeedbackFor] = useState<string | null>(null);
  const [feedbackText, setFeedbackText] = useState("");
  const [feedbackBusy, setFeedbackBusy] = useState(false);
  const [feedbackSentFor, setFeedbackSentFor] = useState<string | null>(null);
  // Failure of a run action (feedback, detail, log), shown in that run's card.
  const [actionError, setActionError] = useState<{ runId: string; message: string } | null>(
    null,
  );
  const logCopiedTimerRef = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (logCopiedTimerRef.current !== null) {
        window.clearTimeout(logCopiedTimerRef.current);
      }
    };
  }, []);
  const handleCopyRunLog = async (entry: SolverHistoryEntry) => {
    const ok = await copyTextToClipboard(buildRunLog(entry));
    setLogCopied(ok);
    if (logCopiedTimerRef.current !== null) {
      window.clearTimeout(logCopiedTimerRef.current);
    }
    logCopiedTimerRef.current = window.setTimeout(() => setLogCopied(false), 2000);
  };
  const handleDownloadServerRunLog = async (runId: string) => {
    setActionError(null);
    try {
      const detail = await onFetchRunDetail(runId);
      handleDownloadRunLog(serverRunToHistoryEntry(detail));
    } catch {
      setActionError({ runId, message: "Downloading the log failed - please try again." });
    }
  };

  const handleDownloadRunLog = (entry: SolverHistoryEntry) => {
    downloadTextFile(
      `shiftschedule-run-${entry.startISO}_${entry.endISO}.txt`,
      buildRunLog(entry),
    );
  };

  // Open a run's detail view from its server record; per-solution stats
  // exist only when this tab watched the run live.
  const handleOpenRunDetail = async (runId: string) => {
    setActionError(null);
    setBusyRunId(runId);
    try {
      const detail = await onFetchRunDetail(runId);
      const entry = serverRunToHistoryEntry(detail);
      entry.statsHistory = getLocalRunStats?.(runId);
      setSelectedEntry(entry);
      setView("detail");
    } catch {
      setActionError({ runId, message: "Loading the run failed - please try again." });
    } finally {
      setBusyRunId(null);
    }
  };

  const handleSendFeedback = async (runId: string) => {
    const comment = feedbackText.trim();
    if (!comment) return;
    setActionError(null);
    setFeedbackBusy(true);
    try {
      await onSendFeedback(runId, comment);
      setFeedbackFor(null);
      setFeedbackText("");
      setFeedbackSentFor(runId);
      window.setTimeout(() => {
        setFeedbackSentFor((current) => (current === runId ? null : current));
      }, 3000);
    } catch {
      // Keep the text so the user can retry.
      setActionError({ runId, message: "Sending the comment failed - please try again." });
    } finally {
      setFeedbackBusy(false);
    }
  };

  // Reset view to info when modal opens; refresh the server run inbox
  useEffect(() => {
    if (isOpen) {
      setView("info");
      setSelectedEntry(null);
      setDebugExpanded(false);
      setActionError(null);
      void onRefreshRuns();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  if (!isOpen) return null;

  // Get current weight value with fallback to default
  const getWeight = (key: WeightKey): number => {
    const value = solverSettings?.[key];
    return typeof value === "number" ? value : DEFAULT_WEIGHTS[key];
  };

  // Handle weight change
  const handleWeightChange = (key: WeightKey, value: number) => {
    if (onSolverSettingsChange) {
      onSolverSettingsChange({ [key]: value });
    }
  };

  const handleClose = () => {
    setView("info");
    setSelectedEntry(null);
    onClose();
  };

  const handleBack = () => {
    if (view === "detail") {
      setSelectedEntry(null);
      setView("info");
    }
  };

  return createPortal(
    // z-[1200] sits above the live SolverOverlay dashboard (z-[1100] in SolverOverlay.tsx)
    // so this modal remains visible when opened while a solve run is in progress.
    <div className="fixed inset-0 z-[1200]">
      {/* Backdrop */}
      <button
        className="absolute inset-0 cursor-default bg-slate-900/30 backdrop-blur-[1px]"
        onClick={handleClose}
      />

      {/* Modal */}
      <div className="relative mx-auto mt-16 w-full max-w-2xl px-4">
        <div
          role="dialog"
          aria-modal="true"
          className="relative overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-900"
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-700">
            <div className="flex items-center gap-2">
              {view !== "info" && (
                <button
                  type="button"
                  onClick={handleBack}
                  className="rounded-lg p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
                >
                  <BackIcon className="h-5 w-5" />
                </button>
              )}
              {view === "info" && (
                <span className="grid h-7 w-7 place-items-center rounded-lg bg-indigo-50 text-indigo-600 dark:bg-indigo-900/40 dark:text-indigo-300">
                  <SparkIcon className="h-4 w-4" />
                </span>
              )}
              <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">
                {view === "info" && "About Automated Planning"}
                {view === "detail" && "Run Details"}
              </h2>
            </div>
            <button
              type="button"
              aria-label="Close"
              onClick={handleClose}
              className="rounded-lg p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
            >
              <CloseIcon className="h-5 w-5" />
            </button>
          </div>

          {/* Content */}
          <div className="max-h-[70vh] overflow-auto p-4">
            {view === "info" && (
              <div className="flex flex-col gap-5">
                {/* Runs: the server-side inbox is the single run list.
                    Results wait here until applied; clicking a run opens
                    its detail view (stats, cost, changes, log). */}
                {serverRuns.length > 0 && (
                  <section aria-label="Runs" className="flex flex-col gap-3">
                    <div className="flex items-end justify-between gap-3">
                      <div>
                        <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                          Runs
                          <span className="ml-1.5 rounded-full bg-slate-100 px-1.5 py-0.5 text-[11px] font-semibold text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                            {serverRuns.length}
                          </span>
                        </h3>
                        <p className="text-xs text-slate-500 dark:text-slate-400">
                          Results wait here until you apply or discard them.
                        </p>
                      </div>
                      {(() => {
                        // Cost is estimated from token counts and known API
                        // prices; runs on the self-hosted model have no
                        // price and are excluded (nothing shown if all runs
                        // are local).
                        const costs = serverRuns
                          .map((r) => estimateAgentCostUSD(r.agent_usage?.model, r.agent_usage))
                          .filter((c): c is number => c !== null);
                        if (costs.length === 0) return null;
                        return (
                          <div className="shrink-0 rounded-xl bg-violet-50 px-3 py-1.5 text-right ring-1 ring-inset ring-violet-100 dark:bg-violet-900/20 dark:ring-violet-900/50">
                            <div className="text-[10px] font-medium uppercase tracking-wide text-violet-500 dark:text-violet-300">
                              AI cost (runs shown)
                            </div>
                            <div className="text-sm font-semibold tabular-nums text-violet-700 dark:text-violet-200">
                              {formatCostUSD(costs.reduce((sum, c) => sum + c, 0))}
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                    {serverRuns.map((run) => {
                      const runCost = estimateAgentCostUSD(run.agent_usage?.model, run.agent_usage);
                      const durationMs =
                        run.finished_at && Date.parse(run.finished_at) && Date.parse(run.created_at)
                          ? Date.parse(run.finished_at) - Date.parse(run.created_at)
                          : null;
                      const noteLines = run.notes?.split("\n") ?? [];
                      const unresolvedNote = noteLines.find((n) => n.startsWith("Unresolved after this run:"));
                      const issues = unresolvedNote ? parseUnresolvedNote(unresolvedNote) : null;
                      const allClear = noteLines.some((n) => n.startsWith("No unresolved issues"));
                      const canDecide = (run.status === "finished" || run.status === "aborted") && run.has_result;
                      const statusStyle = RUN_STATUS_STYLE[run.status] ?? RUN_STATUS_STYLE.discarded;
                      return (
                      <div
                        key={run.id}
                        data-testid={`run-card-${run.id}`}
                        className={cx(
                          "flex flex-col overflow-hidden rounded-2xl border bg-white shadow-sm dark:bg-slate-800/60",
                          run.status === "finished"
                            ? "border-indigo-200 dark:border-indigo-900/70"
                            : "border-slate-200 dark:border-slate-700",
                        )}
                      >
                        <button
                          type="button"
                          disabled={!run.has_result}
                          onClick={() => void handleOpenRunDetail(run.id)}
                          title={run.has_result ? "Show run details (stats, changes, log)." : undefined}
                          className={cx(
                            "group flex w-full items-start gap-3 px-4 pb-3 pt-3.5 text-left",
                            run.has_result && "cursor-pointer hover:bg-slate-50/80 dark:hover:bg-slate-800",
                          )}
                        >
                          <div className="flex min-w-0 flex-1 flex-col gap-2">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-[15px] font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                                {formatEuropeanDate(run.start_iso)} – {formatEuropeanDate(run.end_iso)}
                              </span>
                              <span
                                className={cx(
                                  "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset",
                                  statusStyle.pill,
                                )}
                              >
                                <span aria-hidden="true" className={cx("h-1.5 w-1.5 rounded-full", statusStyle.dot)} />
                                {RUN_STATUS_LABEL[run.status] ?? run.status}
                              </span>
                            </div>
                            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
                              <span>{formatRunStarted(run.created_at)}</span>
                              {durationMs !== null && durationMs > 0 && (
                                <span className="inline-flex items-center gap-1">
                                  <ClockIcon className="h-3.5 w-3.5" />
                                  {formatRunDuration(durationMs)}
                                </span>
                              )}
                              {runCost !== null && (
                                <span className="inline-flex items-center gap-1 font-medium text-violet-600 dark:text-violet-300">
                                  <SparkIcon className="h-3.5 w-3.5" />
                                  AI {formatCostUSD(runCost)}
                                </span>
                              )}
                              {run.attempt > 1 && <span>restarted after interruption</span>}
                              {run.error && (
                                <span className="text-rose-600 dark:text-rose-300">{run.error.slice(0, 80)}</span>
                              )}
                            </div>
                            {issues && issues.length > 0 && (
                              <ul aria-label="Unresolved after this run" className="flex flex-wrap gap-1.5">
                                {issues.map((issue) => (
                                  <li
                                    key={issue.label}
                                    className={cx(
                                      "rounded-lg px-2 py-1 text-xs ring-1 ring-inset",
                                      issue.severe
                                        ? "bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-900/20 dark:text-rose-300 dark:ring-rose-900/60"
                                        : "bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-900/20 dark:text-amber-300 dark:ring-amber-900/60",
                                    )}
                                  >
                                    <span className="font-semibold tabular-nums">{issue.count}</span> {issue.label}
                                  </li>
                                ))}
                              </ul>
                            )}
                            {unresolvedNote && !issues && (
                              <div className="text-xs font-medium text-amber-700 dark:text-amber-400">{unresolvedNote}</div>
                            )}
                            {(allClear || (issues && issues.length === 0)) && (
                              <div className="inline-flex w-fit items-center gap-1.5 rounded-lg bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700 ring-1 ring-inset ring-emerald-200 dark:bg-emerald-900/20 dark:text-emerald-300 dark:ring-emerald-900/60">
                                <CheckIcon className="h-3.5 w-3.5" />
                                No unresolved issues
                              </div>
                            )}
                            {(run.apply_blocked_reason || !!run.incomplete_dates?.length) && (
                              <div className="flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-900/20 dark:text-amber-300">
                                <AlertIcon className="mt-px h-4 w-4 shrink-0" />
                                <div className="flex flex-col gap-0.5">
                                  {run.apply_blocked_reason && <span>{run.apply_blocked_reason}</span>}
                                  {!!run.incomplete_dates?.length && (
                                    <span>
                                      Incomplete draft: {run.incomplete_dates.length} day(s) need review before applying.
                                    </span>
                                  )}
                                </div>
                              </div>
                            )}
                          </div>
                          {run.has_result && (
                            <ChevronRightIcon className="mt-1 h-4 w-4 shrink-0 text-slate-300 transition-transform group-hover:translate-x-0.5 group-hover:text-slate-500 dark:text-slate-600" />
                          )}
                        </button>
                        {(run.has_result || run.status !== "running") && (
                          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 bg-slate-50/70 px-3 py-2 dark:border-slate-700/70 dark:bg-slate-900/40">
                            <div className="flex items-center gap-1">
                              {run.has_result && (
                                <button
                                  type="button"
                                  onClick={() => void handleDownloadServerRunLog(run.id)}
                                  title="Download the full run log (notes, unresolved issues, every change, the agent's thoughts)."
                                  className={ghostButtonClass}
                                >
                                  <DownloadIcon className="h-3.5 w-3.5" />
                                  Log
                                </button>
                              )}
                              {run.status !== "running" && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setFeedbackFor(feedbackFor === run.id ? null : run.id);
                                    setFeedbackText("");
                                    setActionError(null);
                                  }}
                                  title="Write a comment about this run - it is sent to the admin together with a reference to the run's log."
                                  className={cx(
                                    ghostButtonClass,
                                    feedbackSentFor === run.id &&
                                      "text-emerald-700 hover:text-emerald-800 dark:text-emerald-300",
                                  )}
                                >
                                  {feedbackSentFor === run.id ? (
                                    <CheckIcon className="h-3.5 w-3.5" />
                                  ) : (
                                    <ChatIcon className="h-3.5 w-3.5" />
                                  )}
                                  {feedbackSentFor === run.id ? "Sent ✓" : "Comment"}
                                </button>
                              )}
                            </div>
                            {canDecide && (
                              <div className="ml-auto flex items-center gap-2">
                                <button
                                  type="button"
                                  disabled={busyRunId === run.id}
                                  onClick={async () => {
                                    setBusyRunId(run.id);
                                    try {
                                      await onDiscardRun(run.id);
                                    } finally {
                                      setBusyRunId(null);
                                    }
                                  }}
                                  title="Reject this result - the calendar stays as it is."
                                  className={secondaryButtonClass}
                                >
                                  Discard
                                </button>
                                <button
                                  type="button"
                                  disabled={busyRunId === run.id || !!run.apply_blocked_reason}
                                  onClick={async () => {
                                    setBusyRunId(run.id);
                                    try {
                                      await onApplyRun(run.id);
                                    } finally {
                                      setBusyRunId(null);
                                    }
                                  }}
                                  title={run.apply_blocked_reason ?? "Write this plan into the calendar (manual entries always stay)."}
                                  className={primaryButtonClass}
                                >
                                  {busyRunId === run.id ? "Applying..." : "Apply"}
                                </button>
                              </div>
                            )}
                          </div>
                        )}
                        {feedbackFor === run.id && (
                          <div className="flex flex-col gap-2 border-t border-slate-200 px-3 py-2.5 dark:border-slate-700">
                            <textarea
                              value={feedbackText}
                              onChange={(e) => setFeedbackText(e.target.value)}
                              rows={3}
                              maxLength={4000}
                              placeholder="What should the admin know about this run? Your comment is stored next to the run so the admin can read it together with the run's log."
                              className="w-full resize-y rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-xs text-slate-700 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-200"
                            />
                            <div className="flex items-center justify-end gap-2">
                              <button
                                type="button"
                                onClick={() => {
                                  setFeedbackFor(null);
                                  setFeedbackText("");
                                  setActionError(null);
                                }}
                                className={secondaryButtonClass}
                              >
                                Cancel
                              </button>
                              <button
                                type="button"
                                disabled={feedbackBusy || !feedbackText.trim()}
                                onClick={() => void handleSendFeedback(run.id)}
                                className={primaryButtonClass}
                              >
                                {feedbackBusy ? "Sending..." : "Send to admin"}
                              </button>
                            </div>
                          </div>
                        )}
                        {actionError?.runId === run.id && (
                          <p
                            role="alert"
                            className="border-t border-slate-200 px-3 py-2 text-xs text-rose-600 dark:border-slate-700 dark:text-rose-300"
                          >
                            {actionError.message}
                          </p>
                        )}
                      </div>
                      );
                    })}
                  </section>
                )}

                {/* How it works: a compact overview; the details fold away
                    while there are runs to look at. */}
                <section
                  aria-label="How automated planning works"
                  className="rounded-2xl border border-slate-200 bg-gradient-to-br from-slate-50 to-white p-4 dark:border-slate-700 dark:from-slate-800/60 dark:to-slate-900"
                >
                  <div className="flex items-start gap-3">
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-indigo-100 text-indigo-600 dark:bg-indigo-900/40 dark:text-indigo-300">
                      <SparkIcon className="h-5 w-5" />
                    </span>
                    <div className="min-w-0">
                      <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">How it works</h3>
                      <p className="mt-0.5 text-sm text-slate-600 dark:text-slate-300">
                        An AI agent searches for the best possible shift assignments for your team. It considers:
                      </p>
                    </div>
                  </div>
                  <ul className="mt-3 grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-2">
                    {PLANNER_CONSIDERS.map((item) => (
                      <li key={item} className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
                        <CheckIcon className="h-4 w-4 shrink-0 text-emerald-500" />
                        {item}
                      </li>
                    ))}
                  </ul>
                  <button
                    type="button"
                    aria-expanded={explainOpen}
                    onClick={() => setExplainOpen((value) => !value)}
                    className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-indigo-600 hover:text-indigo-500 dark:text-indigo-300 dark:hover:text-indigo-200"
                  >
                    <ChevronRightIcon className={cx("h-3.5 w-3.5 transition-transform", explainOpen && "rotate-90")} />
                    How the agent plans
                  </button>
                  {explainOpen && (
                    <div className="mt-2 flex flex-col gap-2 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
                      <p>
                        The agent builds each day the way an experienced human planner does: on-call duties
                        and scarce slots are staffed first, every clinician is placed with a contiguous block
                        of work (no short stints, no 24-hour double duties), hours are balanced towards people
                        behind on their yearly target, and the free-text instructions from Settings → Planning rules &amp; AI
                        are followed. The AI works with the plan data including names, and the hard rules
                        can never be broken.
                      </p>
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        Longer date ranges or more clinicians take more time. You can abort at any time and
                        keep the best solution found so far.
                      </p>
                    </div>
                  )}
                </section>

                {/* Optimization Weights */}
                <div className="flex flex-col gap-2">
                  <button
                    type="button"
                    onClick={() => setWeightsExpanded(!weightsExpanded)}
                    className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-slate-400 hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300"
                  >
                    <svg
                      className={cx(
                        "h-3 w-3 transition-transform",
                        weightsExpanded && "rotate-90"
                      )}
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                    </svg>
                    Optimization Weights
                  </button>
                  {weightsExpanded && (
                    <div className="mt-1 rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-800">
                      <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
                        Only used by the classic CP-SAT optimizer (API/benchmarks). AI planning ranks plans by a fixed priority ladder and ignores these weights.
                      </p>
                      <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                        {(Object.keys(WEIGHT_LABELS) as WeightKey[]).map((key) => {
                          const isDistributeOnly = WEIGHT_LABELS[key].distributeOnly;
                          return (
                            <div
                              key={key}
                              className={cx(
                                "flex items-center justify-between gap-2",
                                isDistributeOnly && "opacity-60"
                              )}
                            >
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-1">
                                  <span className="truncate text-xs font-medium text-slate-700 dark:text-slate-200">
                                    {WEIGHT_LABELS[key].label}
                                  </span>
                                  <div className="group relative">
                                    <button
                                      type="button"
                                      className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-slate-200 text-[9px] font-bold text-slate-500 hover:bg-slate-300 dark:bg-slate-600 dark:text-slate-400 dark:hover:bg-slate-500"
                                      tabIndex={-1}
                                    >
                                      ?
                                    </button>
                                    <div className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-1.5 w-48 -translate-x-1/2 rounded-lg bg-slate-800 px-2.5 py-2 text-[11px] leading-relaxed text-white opacity-0 shadow-lg transition-opacity group-hover:opacity-100 dark:bg-slate-700">
                                      {WEIGHT_LABELS[key].tooltip}
                                      <div className="absolute left-1/2 top-full -translate-x-1/2 border-4 border-transparent border-t-slate-800 dark:border-t-slate-700" />
                                    </div>
                                  </div>
                                </div>
                                <div className={cx(
                                  "truncate text-[10px]",
                                  isDistributeOnly
                                    ? "italic text-amber-500 dark:text-amber-400"
                                    : "text-slate-400 dark:text-slate-500"
                                )}>
                                  {WEIGHT_LABELS[key].description}
                                </div>
                              </div>
                              <input
                                type="text"
                                inputMode="numeric"
                                pattern="[0-9]*"
                                value={getWeight(key)}
                                onChange={(e) => {
                                  const raw = e.target.value.replace(/[^0-9]/g, "");
                                  if (raw === "") return;
                                  const val = parseInt(raw, 10);
                                  if (!isNaN(val) && val >= 0) {
                                    handleWeightChange(key, Math.min(9999, val));
                                  }
                                }}
                                className="w-16 rounded border border-slate-200 bg-white px-2 py-1 text-right text-xs tabular-nums text-slate-700 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-200"
                              />
                            </div>
                          );
                        })}
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          if (onSolverSettingsChange) {
                            onSolverSettingsChange(DEFAULT_WEIGHTS);
                          }
                        }}
                        className="mt-3 text-xs text-indigo-600 hover:text-indigo-700 dark:text-indigo-400 dark:hover:text-indigo-300"
                      >
                        Reset to defaults
                      </button>
                    </div>
                  )}
                </div>

              </div>
            )}

            {view === "detail" && selectedEntry && (
              <div className="flex flex-col gap-4">
                {/* Dashboard header with summary info */}
                <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 dark:border-slate-700 dark:bg-slate-800">
                  <div className="flex flex-col gap-1">
                    <div className="text-sm font-medium text-indigo-600 dark:text-indigo-400">
                      {formatEuropeanDate(selectedEntry.startISO)} – {formatEuropeanDate(selectedEntry.endISO)}
                    </div>
                    <div className="flex items-center gap-3 text-xs text-slate-500 dark:text-slate-400">
                      <span>{formatDateTime(selectedEntry.startedAt)}</span>
                      <span>•</span>
                      <span>{formatRunDuration(selectedEntry.endedAt - selectedEntry.startedAt)}</span>
                    </div>
                  </div>
                  <span
                    className={cx(
                      "rounded-full px-3 py-1 text-xs font-medium",
                      selectedEntry.status === "success" &&
                        "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
                      selectedEntry.status === "aborted" &&
                        "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
                      selectedEntry.status === "error" &&
                        "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400"
                    )}
                  >
                    {selectedEntry.status === "success" && "Completed"}
                    {selectedEntry.status === "aborted" && "Aborted"}
                    {selectedEntry.status === "error" && "Error"}
                  </span>
                </div>

                {!selectedEntry.debugInfo?.agent && heuristicFallbackNotice(selectedEntry.debugInfo) && (
                  <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs dark:border-amber-900 dark:bg-amber-950/20">
                    <div className="mb-2 font-medium">Heuristic fallback</div>
                    {heuristicFallbackNotice(selectedEntry.debugInfo)}
                  </div>
                )}
                {/* AI agent run: model, tokens, and estimated cost */}
                {selectedEntry.debugInfo?.agent && (() => {
                  const agent = selectedEntry.debugInfo.agent;
                  const fallbackNotice = heuristicFallbackNotice(selectedEntry.debugInfo);
                  const selectionNotice = modelSelectionNotice(agent.model_selection);
                  const modelLabel =
                    AGENT_MODEL_OPTIONS.find((o) => o.id === agent.model)?.label ??
                    agent.model ??
                    (agent.model_selection?.selected_model === null ? "No model answered" : "server default");
                  const cost = estimateAgentCostUSD(agent.model, agent);
                  const fmtTokens = (n?: number) =>
                    (n ?? 0) >= 1000 ? `${((n ?? 0) / 1000).toFixed(1)}k` : `${n ?? 0}`;
                  const tiles: Array<{ label: string; value: string }> = [
                    { label: "Model", value: modelLabel },
                    {
                      label: "Iterations",
                      value: `${agent.iterations ?? 0} · ${agent.moves_accepted ?? 0} changes`,
                    },
                    {
                      label: "Model tokens",
                      value: `${fmtTokens(
                        (agent.input_tokens ?? 0) +
                          (agent.cache_read_input_tokens ?? 0) +
                          (agent.cache_creation_input_tokens ?? 0),
                      )} in · ${fmtTokens(agent.output_tokens)} out`,
                    },
                  ];
                  // Endpoint generation speed — handy for self-hosted models
                  // where the admin is tuning throughput. Null on older runs
                  // or when a run produced no output before erroring.
                  if (
                    agent.output_tokens_per_second !== null &&
                    agent.output_tokens_per_second !== undefined
                  ) {
                    tiles.push({
                      label: "Speed",
                      value: `${agent.output_tokens_per_second} tok/s`,
                    });
                  }
                  // Only API models have a known price; self-hosted models
                  // cost nothing per run, so no cost tile at all.
                  if (cost !== null) {
                    tiles.push({
                      label: "Estimated model cost",
                      value: formatCostUSD(cost) ?? "",
                    });
                  }
                  // Older stored runs predate the outcome fields.
                  if (agent.daysSkipped !== undefined) {
                    tiles.push({
                      label: "Days",
                      value: `${agent.daysPlanned ?? 0} checks complete · ${
                        agent.daysSkipped.length
                      } skipped · ${agent.daysIncomplete?.length ?? 0} checks open${
                        agent.daysUnverified?.length ? ` · ${agent.daysUnverified.length} not finished in time` : ""
                      }`,
                    });
                  }
                  return (
                    <div className="rounded-xl border border-violet-200 bg-violet-50/50 p-3 dark:border-violet-900/50 dark:bg-violet-950/20">
                      <div className="mb-2 text-xs font-medium uppercase tracking-wide text-violet-500 dark:text-violet-400">
                        {fallbackNotice ? "Heuristic fallback" : "AI Agent"}
                      </div>
                      {fallbackNotice && <p className="mb-3 text-xs text-slate-600 dark:text-slate-300">{fallbackNotice} Tokens and costs below belong to the model attempts.</p>}
                      {selectionNotice && <p className="mb-3 text-xs text-slate-600 dark:text-slate-300">{selectionNotice}</p>}
                      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                        {tiles.map((tile) => (
                          <div key={tile.label}>
                            <div className="text-xs text-slate-500 dark:text-slate-400">
                              {tile.label}
                            </div>
                            <div className="text-sm font-semibold text-slate-700 dark:text-slate-200">
                              {tile.value}
                            </div>
                          </div>
                        ))}
                      </div>
                      {agent.completion && (
                        <div className="mt-3 rounded-lg bg-white/70 p-3 text-xs dark:bg-slate-900/50">
                          <div className="font-medium">Result checks · plan {agent.completion.plan_revision}</div>
                          <ul className="mt-2 space-y-1">
                            <li>Run: {agent.completion.workflow_finished ? "finished" : "in progress"}</li>
                            <li>Required checks: {agent.completion.required_checks_complete
                              ? "complete"
                              : agent.completion.required_checks_unverified && agent.completion.required_checks_unverified === (agent.tasks?.tasks.filter(task => task.kind === "required_check" && task.status !== "complete").length ?? -1)
                                ? `not finished in time for ${agent.completion.required_checks_unverified} day(s)`
                                : "still open"}</li>
                            <li>Required positions: {agent.completion.coverage_complete ? "all filled" : "gaps remain"}</li>
                            <li>Work preferences: {agent.completion.soft_wishes_fulfilled === true ? "measured wishes met" : agent.completion.soft_wishes_fulfilled === false ? "deviations remain" : "not fully assessable"}</li>
                          </ul>
                          {!!agent.modelDaysSkipped?.length && <p className="mt-2">The model skipped {agent.modelDaysSkipped.length} day(s); the final checks above describe the returned plan after bounded repair.</p>}
                          {!agent.completion.free_text_wishes_verified && <p className="mt-2">Free-text wishes need human review.</p>}
                          <p className="mt-2 text-slate-500">Checks use a bounded search; they do not prove that the plan is optimal.</p>
                          {agent.tasks?.tasks.some(task => task.kind === "required_check" && task.status !== "complete") && (
                            <details className="mt-2"><summary className="cursor-pointer">Open checks</summary>
                              <ul className="mt-1 space-y-1">{agent.tasks.tasks.filter(task => task.kind === "required_check" && task.status !== "complete").map(task => (
                                <li key={task.id}>{task.dateISO}: {task.reason}</li>
                              ))}</ul>
                            </details>
                          )}
                        </div>
                      )}
                      {agent.summary && (
                        <div className="mt-3 rounded-lg bg-white/70 px-3 py-2 text-xs italic leading-relaxed text-slate-600 dark:bg-slate-900/50 dark:text-slate-300">
                          &ldquo;{agent.summary}&rdquo;
                        </div>
                      )}
                      {agent.moves && agent.moves.length > 0 && (
                        <details className="mt-3">
                          <summary className="cursor-pointer text-xs font-medium text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200">
                            Change history ({agent.moves.length} changes
                            {agent.moves.some((m) => typeof m.iteration === "number")
                              ? ", grouped by iteration"
                              : ""}
                            )
                          </summary>
                          <div className="mt-1 flex max-h-64 flex-col gap-1 overflow-y-auto pr-1">
                            {agent.moves.map((move, index) => {
                              const prev = index > 0 ? agent.moves?.[index - 1] : undefined;
                              const newIteration =
                                typeof move.iteration === "number" &&
                                move.iteration !== prev?.iteration;
                              return (
                                <div key={index}>
                                  {newIteration && (
                                    <div className="mt-1 text-[11px] font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500">
                                      Iteration {move.iteration}
                                    </div>
                                  )}
                                  <div className="text-xs text-slate-600 dark:text-slate-300">
                                    <span
                                      className={
                                        move.action === "assign"
                                          ? "font-bold text-emerald-600 dark:text-emerald-400"
                                          : "font-bold text-rose-500 dark:text-rose-300"
                                      }
                                    >
                                      {move.action === "assign" ? "+" : "–"}
                                    </span>{" "}
                                    <span className="font-medium">{move.clinician}</span>
                                    {move.action === "assign" ? " → " : " ← "}
                                    {move.section || "shift"}
                                    <span className="text-slate-400 dark:text-slate-500">
                                      {" · "}
                                      {formatFeedDate(move.dateISO)}
                                      {move.start && ` · ${move.start}–${move.end}`}
                                    </span>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                          <div className="mt-1 text-[11px] text-slate-400 dark:text-slate-500">
                            The copyable log additionally contains the full plan before and
                            after these changes, so every intermediate state can be
                            reconstructed.
                          </div>
                        </details>
                      )}
                    </div>
                  );
                })()}

                {/* Stats Summary - shown if statsHistory is available */}
                {selectedEntry.statsHistory && selectedEntry.statsHistory.length > 0 && (() => {
                  const statsHistory = selectedEntry.statsHistory;
                  const totalDurationMs = selectedEntry.debugInfo?.timing.total_ms ?? (selectedEntry.endedAt - selectedEntry.startedAt);
                  const lastStats = statsHistory[statsHistory.length - 1];
                  const hasWorkingHoursTarget = lastStats.totalPeopleWeeksWithTarget > 0;

                  return (
                    <div className="grid grid-cols-2 gap-3">
                      {/* Row 1: Working Hours Compliance & Non-consecutive shifts */}
                      {hasWorkingHoursTarget && (
                        <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-800">
                          <div className="mb-1 text-xs font-medium text-slate-500 dark:text-slate-400">
                            Hours Compliance
                          </div>
                          <CompactStatsChart
                            data={statsHistory}
                            dataKey="peopleWeeksWithinHours"
                            totalDurationMs={totalDurationMs}
                            color="#10b981"
                            labelSuffix={`/${lastStats.totalPeopleWeeksWithTarget}`}
                          />
                        </div>
                      )}

                      <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-800">
                        <div className="mb-1 text-xs font-medium text-slate-500 dark:text-slate-400">
                          Non-consecutive
                        </div>
                        <CompactStatsChart
                          data={statsHistory}
                          dataKey="nonConsecutiveShifts"
                          totalDurationMs={totalDurationMs}
                          color="#ef4444"
                        />
                      </div>

                      {/* Row 2: Filled Slots & Location Changes */}
                      <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-800">
                        <div className="mb-1 text-xs font-medium text-slate-500 dark:text-slate-400">
                          Filled Slots
                        </div>
                        <CompactStatsChart
                          data={statsHistory}
                          dataKey="filledSlots"
                          totalDurationMs={totalDurationMs}
                          color="#6366f1"
                          labelSuffix={`/${lastStats.totalRequiredSlots}`}
                        />
                      </div>

                      <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-800">
                        <div className="mb-1 text-xs font-medium text-slate-500 dark:text-slate-400">
                          Location Changes
                        </div>
                        <CompactStatsChart
                          data={statsHistory}
                          dataKey="locationChanges"
                          totalDurationMs={totalDurationMs}
                          color="#f59e0b"
                        />
                      </div>
                    </div>
                  );
                })()}

                {/* Notes */}
                {selectedEntry.notes.length > 0 && (
                  <div className="rounded-xl border border-slate-200 bg-amber-50 p-3 dark:border-slate-700 dark:bg-amber-900/20">
                    <div className="text-xs font-medium text-amber-700 dark:text-amber-400">
                      Notes
                    </div>
                    <ul className="mt-1 space-y-0.5 text-xs text-amber-600 dark:text-amber-300">
                      {selectedEntry.notes.map((note, i) => (
                        <li key={i}>{note}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Debug info - expandable, plus a copyable run log for bug
                    reports (works for every run, with or without debugInfo) */}
                <div className="flex flex-col gap-2">
                  <div className="flex items-stretch gap-2">
                {selectedEntry.debugInfo ? (
                    <button
                      type="button"
                      onClick={() => setDebugExpanded(!debugExpanded)}
                      className="flex flex-1 items-center justify-between rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-left transition-colors hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700"
                    >
                      <div className="flex items-center gap-2">
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          viewBox="0 0 20 20"
                          fill="currentColor"
                          className="h-4 w-4 text-slate-500 dark:text-slate-400"
                        >
                          <path fillRule="evenodd" d="M2 4.25A2.25 2.25 0 014.25 2h11.5A2.25 2.25 0 0118 4.25v8.5A2.25 2.25 0 0115.75 15h-3.105a3.501 3.501 0 001.1 1.677A.75.75 0 0113.26 18H6.74a.75.75 0 01-.484-1.323A3.501 3.501 0 007.355 15H4.25A2.25 2.25 0 012 12.75v-8.5zm1.5 0a.75.75 0 01.75-.75h11.5a.75.75 0 01.75.75v7.5a.75.75 0 01-.75.75H4.25a.75.75 0 01-.75-.75v-7.5z" clipRule="evenodd" />
                        </svg>
                        <span className="text-sm font-medium text-slate-700 dark:text-slate-200">
                          Technical Details
                        </span>
                      </div>
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        viewBox="0 0 20 20"
                        fill="currentColor"
                        className={cx(
                          "h-4 w-4 text-slate-400 transition-transform dark:text-slate-500",
                          debugExpanded && "rotate-180"
                        )}
                      >
                        <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" />
                      </svg>
                    </button>
                ) : (
                  <div className="flex-1 rounded-xl border border-slate-200 bg-slate-50 p-4 text-center text-sm text-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400">
                    Detailed timing data not available for this run.
                  </div>
                )}
                    <button
                      type="button"
                      onClick={() => void handleCopyRunLog(selectedEntry)}
                      title="Copy a technical log of this run (settings, notes, agent summary, moves, tokens) — paste it into a bug report or an AI chat."
                      className={cx(
                        "flex items-center gap-1.5 rounded-xl border px-4 py-3 text-sm font-medium transition-colors",
                        logCopied
                          ? "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300"
                          : "border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700",
                      )}
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
                        <path d="M7 3.5A1.5 1.5 0 018.5 2h3.879a1.5 1.5 0 011.06.44l3.122 3.12A1.5 1.5 0 0117 6.622V12.5a1.5 1.5 0 01-1.5 1.5h-1v-3.379a3 3 0 00-.879-2.121L10.5 5.379A3 3 0 008.379 4.5H7v-1z" />
                        <path d="M4.5 6A1.5 1.5 0 003 7.5v9A1.5 1.5 0 004.5 18h7a1.5 1.5 0 001.5-1.5v-5.879a1.5 1.5 0 00-.44-1.06L9.44 6.439A1.5 1.5 0 008.378 6H4.5z" />
                      </svg>
                      {logCopied ? "Copied!" : "Copy log"}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDownloadRunLog(selectedEntry)}
                      title="Download the same technical run log as a text file."
                      className="flex items-center gap-1.5 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
                        <path d="M10.75 2.75a.75.75 0 00-1.5 0v8.614L6.295 8.235a.75.75 0 10-1.09 1.03l4.25 4.5a.75.75 0 001.09 0l4.25-4.5a.75.75 0 00-1.09-1.03l-2.955 3.129V2.75z" />
                        <path d="M3.5 12.75a.75.75 0 00-1.5 0v2.5A2.75 2.75 0 004.75 18h10.5A2.75 2.75 0 0018 15.25v-2.5a.75.75 0 00-1.5 0v2.5c0 .69-.56 1.25-1.25 1.25H4.75c-.69 0-1.25-.56-1.25-1.25v-2.5z" />
                      </svg>
                      Download
                    </button>
                  </div>
                  {debugExpanded && selectedEntry.debugInfo && (
                    <SolverDebugPanel debugInfo={selectedEntry.debugInfo} />
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

// Info button component to trigger the modal
export function SolverInfoButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded p-0.5 text-slate-400 transition-colors hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300"
      title="Run inbox, weights & timeout"
    >
      <GearIcon className="h-4 w-4" />
    </button>
  );
}
