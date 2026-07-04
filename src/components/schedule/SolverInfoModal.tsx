import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import type { SolverDebugInfo, SolverDebugSolutionTime, SolverSettings } from "../../api/client";
import { cx } from "../../lib/classNames";
import { AGENT_MODEL_OPTIONS, estimateAgentCostUSD, formatCostUSD } from "../../lib/llmPricing";
import { formatFeedDate } from "../../lib/agentActivity";
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

export type SolverHistoryEntry = {
  id: string;
  startISO: string;
  endISO: string;
  startedAt: number;
  endedAt: number;
  status: "success" | "aborted" | "error";
  notes: string[];
  debugInfo?: SolverDebugInfo;
  statsHistory?: StatsHistoryEntry[]; // Stats for each solution found
};

type SolverInfoModalProps = {
  isOpen: boolean;
  onClose: () => void;
  history: SolverHistoryEntry[];
  timeoutSeconds: number;
  onTimeoutChange: (seconds: number) => void;
  solverSettings?: SolverSettings;
  onSolverSettingsChange?: (settings: Partial<SolverSettings>) => void;
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

const formatDuration = (ms: number) => {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${minutes}m ${secs}s`;
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

function ChartIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 20 20"
      fill="currentColor"
      className={className}
    >
      <path d="M15.5 2A1.5 1.5 0 0014 3.5v13a1.5 1.5 0 001.5 1.5h1a1.5 1.5 0 001.5-1.5v-13A1.5 1.5 0 0016.5 2h-1zM9.5 6A1.5 1.5 0 008 7.5v9A1.5 1.5 0 009.5 18h1a1.5 1.5 0 001.5-1.5v-9A1.5 1.5 0 0010.5 6h-1zM3.5 10A1.5 1.5 0 002 11.5v5A1.5 1.5 0 003.5 18h1A1.5 1.5 0 006 16.5v-5A1.5 1.5 0 004.5 10h-1z" />
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

// Historical solution chart - similar to LiveSolutionChart but for completed runs
function HistoricalSolutionChart({
  solutionTimes,
  totalDurationMs,
}: {
  solutionTimes: SolverDebugSolutionTime[];
  totalDurationMs: number;
}) {
  if (solutionTimes.length === 0) return null;

  const chartWidth = 500;
  const chartHeight = 140;
  const padding = { top: 15, right: 15, bottom: 25, left: 55 };
  const innerWidth = chartWidth - padding.left - padding.right;
  const innerHeight = chartHeight - padding.top - padding.bottom;

  // Time range: 0 to total duration
  const maxTimeMs = totalDurationMs * 1.1;
  const maxTimeSec = maxTimeMs / 1000;

  // Get min/max objectives (min is best)
  const minObjective = Math.min(...solutionTimes.map((s) => s.objective));
  const maxObjective = Math.max(...solutionTimes.map((s) => s.objective));

  // Calculate distances from minimum (for log scale)
  const maxDistance = maxObjective - minObjective;
  const logMaxDistance = maxDistance > 0 ? Math.log10(maxDistance + 1) : 1;

  // Build path points with step function
  const points: { x: number; y: number }[] = [];
  for (let i = 0; i < solutionTimes.length; i++) {
    const s = solutionTimes[i];
    const distance = s.objective - minObjective;
    const logDistance = distance > 0 ? Math.log10(distance + 1) : 0;
    const normalized = 1 - logDistance / logMaxDistance;

    const x = padding.left + (s.time_ms / 1000 / maxTimeSec) * innerWidth;
    const y = padding.top + (1 - normalized) * innerHeight;

    points.push({ x, y });

    // Extend horizontally to next solution or to total duration
    const nextTime = i < solutionTimes.length - 1 ? solutionTimes[i + 1].time_ms : totalDurationMs;
    const nextX = padding.left + (nextTime / 1000 / maxTimeSec) * innerWidth;
    points.push({ x: nextX, y });
  }

  const linePath =
    points.length > 0
      ? `M ${points.map((p) => `${p.x},${p.y}`).join(" L ")}`
      : "";

  return (
    <div className="flex flex-col items-center gap-1">
      <svg width={chartWidth} height={chartHeight} className="overflow-visible">
        {/* Grid lines */}
        <line
          x1={padding.left}
          y1={chartHeight - padding.bottom}
          x2={chartWidth - padding.right}
          y2={chartHeight - padding.bottom}
          stroke="currentColor"
          strokeOpacity={0.2}
        />
        <line
          x1={padding.left}
          y1={padding.top}
          x2={padding.left}
          y2={chartHeight - padding.bottom}
          stroke="currentColor"
          strokeOpacity={0.2}
        />

        {/* Solution line */}
        {linePath && (
          <path d={linePath} fill="none" stroke="#6366f1" strokeWidth={2} />
        )}

        {/* Solution dots */}
        {points
          .filter((_, i) => i % 2 === 0)
          .map((p, i) => (
            <circle key={i} cx={p.x} cy={p.y} r={3} fill="#6366f1" />
          ))}

        {/* Y-axis label */}
        <text
          x={padding.left - 8}
          y={chartHeight / 2}
          textAnchor="middle"
          transform={`rotate(-90, ${padding.left - 8}, ${chartHeight / 2})`}
          className="fill-current text-[9px] opacity-50"
        >
          Score
        </text>

        {/* Y-axis values */}
        <text
          x={padding.left - 4}
          y={padding.top + 3}
          textAnchor="end"
          className="fill-current text-[9px] opacity-60"
        >
          {minObjective}
        </text>
        <text
          x={padding.left - 4}
          y={chartHeight - padding.bottom}
          textAnchor="end"
          className="fill-current text-[9px] opacity-60"
        >
          {maxObjective}
        </text>

        {/* X-axis label */}
        <text
          x={chartWidth / 2}
          y={chartHeight - 2}
          textAnchor="middle"
          className="fill-current text-[9px] opacity-50"
        >
          Time (s)
        </text>

        {/* Time markers */}
        <text
          x={padding.left}
          y={chartHeight - 8}
          textAnchor="start"
          className="fill-current text-[9px] opacity-40"
        >
          0
        </text>
        <text
          x={chartWidth - padding.right}
          y={chartHeight - 8}
          textAnchor="end"
          className="fill-current text-[9px] opacity-40"
        >
          {maxTimeSec.toFixed(1)}
        </text>
      </svg>
      <div className="flex items-center gap-2 text-[10px] text-slate-500 dark:text-slate-400">
        <span>Solutions: {solutionTimes.length}</span>
        <span>Best: {minObjective}</span>
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
  history,
  timeoutSeconds,
  onTimeoutChange,
  solverSettings,
  onSolverSettingsChange,
}: SolverInfoModalProps) {
  const [view, setView] = useState<View>("info");
  const [selectedEntry, setSelectedEntry] = useState<SolverHistoryEntry | null>(null);
  const [weightsExpanded, setWeightsExpanded] = useState(false);
  const [debugExpanded, setDebugExpanded] = useState(false);

  // Reset view to info when modal opens
  useEffect(() => {
    if (isOpen) {
      setView("info");
      setSelectedEntry(null);
      setDebugExpanded(false);
    }
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

  const handleViewDetail = (entry: SolverHistoryEntry) => {
    setSelectedEntry(entry);
    setView("detail");
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
                    Planning runs as an AI agent: a fast draft plan is built first, then
                    Claude reviews and improves it step by step — filling open slots,
                    balancing hours (preferring people behind on their yearly target),
                    and following the free-text instructions from Settings → Solver.
                    Names are anonymized before anything is sent to the AI, and the
                    hard rules above can never be broken.
                  </p>
                  <p className="text-xs text-slate-400 dark:text-slate-500">
                    Longer date ranges or more clinicians will require more time to solve.
                    You can abort at any time and keep the best solution found so far.
                  </p>
                </div>

                {/* Max Runtime setting */}
                <div className="flex flex-col gap-2">
                  <div className="text-xs font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500">
                    Max Runtime
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      value={timeoutSeconds}
                      onChange={(e) => {
                        // Allow any numeric input while typing
                        const raw = e.target.value.replace(/[^0-9]/g, "");
                        if (raw === "") return;
                        const val = parseInt(raw, 10);
                        if (!isNaN(val)) {
                          // Clamp to valid range
                          onTimeoutChange(Math.max(1, Math.min(3600, val)));
                        }
                      }}
                      onBlur={(e) => {
                        // Ensure valid value on blur
                        const val = parseInt(e.target.value, 10);
                        if (isNaN(val) || val < 1) {
                          onTimeoutChange(1);
                        } else if (val > 3600) {
                          onTimeoutChange(3600);
                        }
                      }}
                      className="w-20 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:focus:border-indigo-400 dark:focus:ring-indigo-400"
                    />
                    <span className="text-sm text-slate-500 dark:text-slate-400">seconds</span>
                  </div>
                </div>

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

                {/* Recent runs list */}
                {history.length > 0 && (
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center justify-between">
                      <div className="text-xs font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500">
                        Recent Runs
                      </div>
                      {history.some((entry) => entry.debugInfo?.agent) && (
                        <div className="text-xs text-slate-500 dark:text-slate-400">
                          AI cost (runs shown):{" "}
                          <span className="font-semibold text-violet-600 dark:text-violet-400">
                            {formatCostUSD(
                              history.reduce(
                                (sum, entry) =>
                                  sum +
                                  (estimateAgentCostUSD(
                                    entry.debugInfo?.agent?.model,
                                    entry.debugInfo?.agent,
                                  ) ?? 0),
                                0,
                              ),
                            )}
                          </span>
                        </div>
                      )}
                    </div>
                    {history.map((entry) => (
                      <button
                        key={entry.id}
                        type="button"
                        onClick={() => handleViewDetail(entry)}
                        className="flex items-center justify-between rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-left transition-colors hover:border-slate-300 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:hover:border-slate-600 dark:hover:bg-slate-700"
                      >
                        <div className="flex flex-col gap-0.5">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-slate-700 dark:text-slate-200">
                              {formatEuropeanDate(entry.startISO)} – {formatEuropeanDate(entry.endISO)}
                            </span>
                            <span
                              className={cx(
                                "rounded-full px-2 py-0.5 text-xs font-medium",
                                entry.status === "success" &&
                                  "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
                                entry.status === "aborted" &&
                                  "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
                                entry.status === "error" &&
                                  "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400"
                              )}
                            >
                              {entry.status === "success" && "Completed"}
                              {entry.status === "aborted" && "Aborted"}
                              {entry.status === "error" && "Error"}
                            </span>
                          </div>
                          <div className="flex items-center gap-3 text-xs text-slate-500 dark:text-slate-400">
                            <span>{formatDateTime(entry.startedAt)}</span>
                            <span>•</span>
                            <span>{formatDuration(entry.endedAt - entry.startedAt)}</span>
                            {entry.debugInfo?.agent && (
                              <>
                                <span>•</span>
                                <span className="font-medium text-violet-600 dark:text-violet-400">
                                  AI{" "}
                                  {formatCostUSD(
                                    estimateAgentCostUSD(
                                      entry.debugInfo.agent.model,
                                      entry.debugInfo.agent,
                                    ) ?? 0,
                                  )}
                                </span>
                              </>
                            )}
                          </div>
                        </div>
                        <ChartIcon className="h-4 w-4 text-slate-400 dark:text-slate-500" />
                      </button>
                    ))}
                  </div>
                )}
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
                      <span>{formatDuration(selectedEntry.endedAt - selectedEntry.startedAt)}</span>
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
                    {
                      label: "Estimated cost",
                      value: formatCostUSD(cost) ?? "n/a (unknown model pricing)",
                    },
                  ];
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
                        <div className="mt-3">
                          <div className="mb-1 text-xs font-medium text-slate-500 dark:text-slate-400">
                            Changes made by the agent ({agent.moves.length})
                          </div>
                          <div className="flex max-h-44 flex-col gap-1 overflow-y-auto pr-1">
                            {agent.moves.map((move, index) => (
                              <div
                                key={index}
                                className="text-xs text-slate-600 dark:text-slate-300"
                              >
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
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })()}

                {/* Optimization Score Chart - dashboard style */}
                {selectedEntry.debugInfo && selectedEntry.debugInfo.solution_times.length > 0 && (
                  <DashboardCard title="Optimization Score" accentColor="#6366f1">
                    <HistoricalSolutionChart
                      solutionTimes={selectedEntry.debugInfo.solution_times}
                      totalDurationMs={selectedEntry.debugInfo.timing.total_ms}
                    />
                  </DashboardCard>
                )}

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

                {/* Debug info - expandable */}
                {selectedEntry.debugInfo ? (
                  <div className="flex flex-col gap-2">
                    <button
                      type="button"
                      onClick={() => setDebugExpanded(!debugExpanded)}
                      className="flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-left transition-colors hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700"
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
                    {debugExpanded && (
                      <SolverDebugPanel debugInfo={selectedEntry.debugInfo} />
                    )}
                  </div>
                ) : (
                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-center text-sm text-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400">
                    Detailed timing data not available for this run.
                    <br />
                    <span className="text-xs">
                      Enable DEBUG_SOLVER=true on the backend for full details.
                    </span>
                  </div>
                )}
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
