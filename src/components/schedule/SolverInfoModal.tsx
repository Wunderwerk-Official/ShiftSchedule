import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { SolverRunDetail, SolverRunSummary, SolverSettings } from "../../api/client";
import { cx } from "../../lib/classNames";
import { AGENT_MODEL_OPTIONS, estimateAgentCostUSD, formatCostUSD } from "../../lib/llmPricing";
import { formatFeedDate } from "../../lib/agentActivity";
import {
  buildRunLog,
  downloadTextFile,
  formatRunDuration,
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

const copyTextToClipboard = async (text: string): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API needs a secure context; fall back to the classic
    // hidden-textarea trick so copying also works over plain http.
    try {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(textarea);
      return ok;
    } catch {
      return false;
    }
  }
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

// Card wrapper for dashboard panels
function DashboardCard({
  title,
  children,
  className = "",
  accentColor,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
  accentColor?: string;
}) {
  return (
    <div
      className={`flex flex-col rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-800 ${className}`}
    >
      <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-3 dark:border-slate-700">
        {accentColor && (
          <div
            className="h-2 w-2 rounded-full"
            style={{ backgroundColor: accentColor }}
          />
        )}
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
          {title}
        </h3>
      </div>
      <div className="flex flex-1 items-center justify-center p-4">
        {children}
      </div>
    </div>
  );
}

// Compact stats chart - for displaying completed run stats in a smaller form
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
  const [debugExpanded, setDebugExpanded] = useState(false);
  const [logCopied, setLogCopied] = useState(false);
  const [feedbackFor, setFeedbackFor] = useState<string | null>(null);
  const [feedbackText, setFeedbackText] = useState("");
  const [feedbackBusy, setFeedbackBusy] = useState(false);
  const [feedbackSentFor, setFeedbackSentFor] = useState<string | null>(null);
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
    try {
      const detail = await onFetchRunDetail(runId);
      handleDownloadRunLog(serverRunToHistoryEntry(detail));
    } catch {
      // Best-effort: the next click retries.
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
    setBusyRunId(runId);
    try {
      const detail = await onFetchRunDetail(runId);
      const entry = serverRunToHistoryEntry(detail);
      entry.statsHistory = getLocalRunStats?.(runId);
      setSelectedEntry(entry);
      setView("detail");
    } catch {
      // Best-effort: the next click retries.
    } finally {
      setBusyRunId(null);
    }
  };

  const handleSendFeedback = async (runId: string) => {
    const comment = feedbackText.trim();
    if (!comment) return;
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
              <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">
                {view === "info" && "About Automated Planning"}
                {view === "detail" && "Run Details"}
              </h2>
            </div>
            <button
              type="button"
              onClick={handleClose}
              className="rounded-lg p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
            >
              <CloseIcon className="h-5 w-5" />
            </button>
          </div>

          {/* Content */}
          <div className="max-h-[70vh] overflow-auto p-4">
            {view === "info" && (
              <div className="flex flex-col gap-4">
                {/* Layman description */}
                <div className="flex flex-col gap-3 text-sm text-slate-600 dark:text-slate-300">
                  <p>
                    The automated planner uses an optimization algorithm to find the best
                    possible shift assignments for your team. It considers:
                  </p>
                  <ul className="ml-4 list-disc space-y-1.5 text-slate-500 dark:text-slate-400">
                    <li>Each clinician's qualifications and working hours</li>
                    <li>Vacation days and rest day requirements</li>
                    <li>Slot coverage requirements (minimum staffing)</li>
                    <li>Preferred time windows and continuous shift preferences</li>
                    <li>Fair distribution of workload across the team</li>
                  </ul>
                  <p>
                    Planning runs as an AI agent that builds each day the way an
                    experienced human planner does: on-call duties and scarce slots
                    are staffed first, every clinician is placed with a contiguous
                    block of work (no short stints, no 24-hour double duties), hours
                    are balanced towards people behind on their yearly target, and
                    the free-text instructions from Settings → Solver are followed.
                    The AI works with the plan data including names, and the
                    hard rules above can never be broken.
                  </p>
                  <p className="text-xs text-slate-400 dark:text-slate-500">
                    Longer date ranges or more clinicians will require more time to solve.
                    You can abort at any time and keep the best solution found so far.
                  </p>
                </div>

                {/* Runs: the server-side inbox is the single run list.
                    Results wait here until applied; clicking a run opens
                    its detail view (stats, cost, changes, log). */}
                {serverRuns.length > 0 && (
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center justify-between">
                      <div className="text-xs font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500">
                        Runs
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
                          <div className="text-xs text-slate-500 dark:text-slate-400">
                            AI cost (runs shown):{" "}
                            <span className="font-semibold text-violet-600 dark:text-violet-400">
                              {formatCostUSD(costs.reduce((sum, c) => sum + c, 0))}
                            </span>
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
                      return (
                      <div
                        key={run.id}
                        className="flex flex-col rounded-xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-800"
                      >
                        <div className="flex items-center justify-between gap-3 px-3 py-2.5">
                        <button
                          type="button"
                          disabled={!run.has_result}
                          onClick={() => void handleOpenRunDetail(run.id)}
                          title={run.has_result ? "Show run details (stats, changes, log)." : undefined}
                          className={cx(
                            "flex min-w-0 flex-1 flex-col gap-0.5 text-left",
                            run.has_result && "cursor-pointer",
                          )}
                        >
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-slate-700 dark:text-slate-200">
                              {formatEuropeanDate(run.start_iso)} – {formatEuropeanDate(run.end_iso)}
                            </span>
                            <span
                              className={cx(
                                "rounded-full px-2 py-0.5 text-xs font-medium",
                                run.status === "finished" &&
                                  "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300",
                                run.status === "applied" &&
                                  "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
                                run.status === "running" &&
                                  "bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300",
                                (run.status === "aborted" || run.status === "crashed") &&
                                  "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
                                (run.status === "failed" || run.status === "discarded") &&
                                  "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400",
                              )}
                            >
                              {RUN_STATUS_LABEL[run.status] ?? run.status}
                            </span>
                          </div>
                          <div className="text-xs text-slate-500 dark:text-slate-400">
                            {run.created_at.replace("T", " ").slice(0, 16)}
                            {durationMs !== null && durationMs > 0
                              ? ` · ${formatRunDuration(durationMs)}`
                              : ""}
                            {run.attempt > 1 ? " · restarted after interruption" : ""}
                            {run.error ? ` · ${run.error.slice(0, 80)}` : ""}
                            {runCost !== null && (
                              <span className="font-medium text-violet-600 dark:text-violet-400">
                                {" "}· AI {formatCostUSD(runCost)}
                              </span>
                            )}
                          </div>
                          {run.notes?.split("\n").find((n) => n.startsWith("Unresolved after this run:")) && (
                            <div className="text-xs font-medium text-amber-600 dark:text-amber-400">
                              {run.notes.split("\n").find((n) => n.startsWith("Unresolved after this run:"))}
                            </div>
                          )}
                          {run.notes?.split("\n").find((n) => n.startsWith("No unresolved issues")) && (
                            <div className="text-xs text-emerald-600 dark:text-emerald-400">
                              No unresolved issues
                            </div>
                          )}
                        </button>
                        <div className="flex shrink-0 items-center gap-2">
                          {run.has_result && (
                            <button
                              type="button"
                              onClick={() => void handleDownloadServerRunLog(run.id)}
                              title="Download the full run log (notes, unresolved issues, every change, the agent's thoughts)."
                              className="rounded-lg border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-500 transition-colors hover:border-slate-300 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
                            >
                              Log
                            </button>
                          )}
                          {run.status !== "running" && (
                            <button
                              type="button"
                              onClick={() => {
                                setFeedbackFor(feedbackFor === run.id ? null : run.id);
                                setFeedbackText("");
                              }}
                              title="Write a comment about this run - it is sent to the admin together with a reference to the run's log."
                              className={cx(
                                "rounded-lg border px-3 py-1 text-xs font-medium transition-colors",
                                feedbackSentFor === run.id
                                  ? "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300"
                                  : "border-slate-200 bg-white text-slate-500 hover:border-slate-300 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300",
                              )}
                            >
                              {feedbackSentFor === run.id ? "Sent ✓" : "Comment"}
                            </button>
                          )}
                        {(run.status === "finished" || run.status === "aborted") &&
                          run.has_result && (
                            <div className="flex shrink-0 items-center gap-2">
                              <button
                                type="button"
                                disabled={busyRunId === run.id}
                                onClick={async () => {
                                  setBusyRunId(run.id);
                                  try {
                                    await onApplyRun(run.id);
                                  } finally {
                                    setBusyRunId(null);
                                  }
                                }}
                                title="Write this plan into the calendar (manual entries always stay)."
                                className="rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-1 text-xs font-medium text-indigo-600 transition-colors hover:border-indigo-300 hover:bg-indigo-100 disabled:opacity-50 dark:border-indigo-800 dark:bg-indigo-950 dark:text-indigo-300"
                              >
                                {busyRunId === run.id ? "Applying..." : "Apply"}
                              </button>
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
                                className="rounded-lg border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-500 transition-colors hover:border-slate-300 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
                              >
                                Discard
                              </button>
                            </div>
                          )}
                        </div>
                        </div>
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
                                }}
                                className="rounded-lg border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-500 transition-colors hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
                              >
                                Cancel
                              </button>
                              <button
                                type="button"
                                disabled={feedbackBusy || !feedbackText.trim()}
                                onClick={() => void handleSendFeedback(run.id)}
                                className="rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-1 text-xs font-medium text-indigo-600 transition-colors hover:border-indigo-300 hover:bg-indigo-100 disabled:opacity-50 dark:border-indigo-800 dark:bg-indigo-950 dark:text-indigo-300"
                              >
                                {feedbackBusy ? "Sending..." : "Send to admin"}
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                      );
                    })}
                  </div>
                )}

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
                        Higher weights give more priority to that objective. Default values work well for most cases.
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

                {/* AI agent run: model, tokens, and estimated cost */}
                {selectedEntry.debugInfo?.agent && (() => {
                  const agent = selectedEntry.debugInfo.agent;
                  const modelLabel =
                    AGENT_MODEL_OPTIONS.find((o) => o.id === agent.model)?.label ??
                    agent.model ??
                    "server default";
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
                      label: "Tokens",
                      value: `${fmtTokens(
                        (agent.input_tokens ?? 0) +
                          (agent.cache_read_input_tokens ?? 0) +
                          (agent.cache_creation_input_tokens ?? 0),
                      )} in · ${fmtTokens(agent.output_tokens)} out`,
                    },
                  ];
                  // Only API models have a known price; self-hosted models
                  // cost nothing per run, so no cost tile at all.
                  if (cost !== null) {
                    tiles.push({
                      label: "Estimated cost",
                      value: formatCostUSD(cost) ?? "",
                    });
                  }
                  // Older stored runs predate the outcome fields.
                  if (agent.daysSkipped !== undefined) {
                    tiles.push({
                      label: "Days",
                      value: `${agent.daysPlanned ?? 0} planned · ${
                        agent.daysSkipped.length
                      } skipped`,
                    });
                  }
                  return (
                    <div className="rounded-xl border border-violet-200 bg-violet-50/50 p-3 dark:border-violet-900/50 dark:bg-violet-950/20">
                      <div className="mb-2 text-xs font-medium uppercase tracking-wide text-violet-500 dark:text-violet-400">
                        AI Agent
                      </div>
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
      title="Solver history, weights & timeout"
    >
      <GearIcon className="h-4 w-4" />
    </button>
  );
}
