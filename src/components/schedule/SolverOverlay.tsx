import { useState, useMemo, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type {
  AgentActivityData,
  Assignment,
  Clinician,
  SolverMode,
  SolverSettings,
} from "../../api/client";
import type { ScheduleRow } from "../../lib/shiftRows";
import { calculateSolverLiveStats } from "../../lib/solverStats";
import type { SolverLiveStats, SolverSettingsForStats } from "../../lib/solverStats";
import { cx } from "../../lib/classNames";
import AgentActivityPanel from "./AgentActivityPanel";
import ConstraintPulse from "./ConstraintPulse";

export type LiveSolution = {
  solution_num: number;
  time_ms: number;
  objective: number;
  assignments?: Assignment[];
};

type SolverOverlayProps = {
  isVisible: boolean;
  elapsedMs: number;
  onMinimize?: () => void; // Send the run to the background (calendar stays usable)
  solveRange: { startISO: string; endISO: string } | null;
  displayedRange: { startISO: string; endISO: string };
  onAbort: () => void;
  onApplySolution: () => void; // Separate handler for applying solution
  liveSolutions?: LiveSolution[];
  scheduleRows?: ScheduleRow[];
  clinicians?: Clinician[];
  holidays?: Set<string>;
  currentPhase?: string | null;
  existingAssignments?: Assignment[]; // Existing (manual) assignments in the solve range
  solverSettings?: SolverSettings; // Solver settings for on-call rest tracking
  solverMode?: SolverMode; // Which solver runs (drives the agent activity panel)
  agentEvents?: AgentActivityData[]; // Live agent activity (solver_mode "agent")
  liveConnected?: boolean;
  error?: string | null;
};

const formatDuration = (valueMs: number) => {
  const totalSeconds = Math.max(0, Math.floor(valueMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
};

const formatEuropeanDate = (dateISO: string) => {
  const [year, month, day] = dateISO.split("-");
  if (!year || !month || !day) return dateISO;
  return `${day}.${month}.${year}`;
};

// Check if two date ranges overlap
const rangesOverlap = (
  range1: { startISO: string; endISO: string },
  range2: { startISO: string; endISO: string },
): boolean => {
  return range1.startISO <= range2.endISO && range1.endISO >= range2.startISO;
};

// Minimal live chart for solutions - log scale so both large and small improvements are visible
function LiveSolutionChart({ solutions, elapsedMs }: { solutions: LiveSolution[]; elapsedMs: number }) {
  if (solutions.length === 0) return null;

  const chartWidth = 500;
  const chartHeight = 140;
  const padding = { top: 15, right: 15, bottom: 25, left: 55 };
  const innerWidth = chartWidth - padding.left - padding.right;
  const innerHeight = chartHeight - padding.top - padding.bottom;

  // Time range: 0 to max(elapsedMs, last solution time) + some padding
  const maxTimeMs = Math.max(elapsedMs, ...solutions.map((s) => s.time_ms)) * 1.1;
  const maxTimeSec = maxTimeMs / 1000;

  // Y-axis: log-scaled distance from best objective
  // This compresses large early jumps and amplifies small late improvements
  const minObjective = Math.min(...solutions.map((s) => s.objective));
  const maxObjective = Math.max(...solutions.map((s) => s.objective));
  const maxDistance = maxObjective - minObjective;
  const logMaxDistance = maxDistance > 0 ? Math.log10(maxDistance + 1) : 1;

  const points: { x: number; y: number }[] = [];
  for (let i = 0; i < solutions.length; i++) {
    const s = solutions[i];
    // Distance from best (0 for best solution, larger for worse)
    const distance = s.objective - minObjective;
    const logDistance = distance > 0 ? Math.log10(distance + 1) : 0;
    // Invert: best (logDistance=0) at top, worst at bottom
    const normalized = 1 - logDistance / logMaxDistance;

    const x = padding.left + (s.time_ms / 1000 / maxTimeSec) * innerWidth;
    const y = padding.top + (1 - normalized) * innerHeight;
    points.push({ x, y });

    // Extend horizontally to next solution or to current time
    const nextTime = i < solutions.length - 1 ? solutions[i + 1].time_ms : elapsedMs;
    const nextX = padding.left + (nextTime / 1000 / maxTimeSec) * innerWidth;
    points.push({ x: nextX, y });
  }

  const linePath =
    points.length > 0
      ? `M ${points.map((p) => `${p.x},${p.y}`).join(" L ")}`
      : "";

  // Format large numbers compactly
  const formatObj = (v: number) => {
    const abs = Math.abs(v);
    if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
    if (abs >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
    return v.toFixed(0);
  };

  // Calculate improvement stats for summary
  const firstObjective = solutions[0].objective;
  const denom = Math.max(1, Math.abs(firstObjective));
  const bestImprovementPct = ((firstObjective - minObjective) / denom) * 100;

  return (
    <div className="flex w-full flex-col items-center gap-1">
      {/* Responsive SVG: viewBox-based sizing lets the chart shrink to the
          modal's inner width on narrow viewports (avoids the left-hand Y-axis
          label getting clipped) and lets it grow up to ~700px on wide ones so
          the score progression is actually readable. */}
      <svg
        viewBox={`0 0 ${chartWidth} ${chartHeight}`}
        preserveAspectRatio="xMidYMid meet"
        className="block h-auto w-full max-w-[700px]"
      >
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
          <path
            d={linePath}
            fill="none"
            strokeWidth={2}
            className="stroke-indigo-500 dark:stroke-indigo-400"
          />
        )}

        {/* Solution dots */}
        {points
          .filter((_, i) => i % 2 === 0)
          .map((p, i) => (
            <circle
              key={i}
              cx={p.x}
              cy={p.y}
              r={3}
              className="fill-indigo-500 dark:fill-indigo-400"
            />
          ))}

        {/* Y-axis label */}
        <text
          x={padding.left - 8}
          y={chartHeight / 2}
          textAnchor="middle"
          transform={`rotate(-90, ${padding.left - 8}, ${chartHeight / 2})`}
          className="fill-current text-[11px] opacity-60"
        >
          Score ↑ better
        </text>

        {/* Y-axis values: top = best (min objective), bottom = worst (max objective) */}
        <text
          x={padding.left - 4}
          y={padding.top + 4}
          textAnchor="end"
          className="fill-current text-[11px] opacity-60"
        >
          {formatObj(minObjective)}
        </text>
        <text
          x={padding.left - 4}
          y={chartHeight - padding.bottom}
          textAnchor="end"
          className="fill-current text-[11px] opacity-60"
        >
          {formatObj(maxObjective)}
        </text>

        {/* X-axis label */}
        <text
          x={chartWidth / 2}
          y={chartHeight - 2}
          textAnchor="middle"
          className="fill-current text-[11px] opacity-60"
        >
          Time (s)
        </text>

        {/* Time markers */}
        <text
          x={padding.left}
          y={chartHeight - 8}
          textAnchor="start"
          className="fill-current text-[11px] opacity-60"
        >
          0
        </text>
        <text
          x={chartWidth - padding.right}
          y={chartHeight - 8}
          textAnchor="end"
          className="fill-current text-[11px] opacity-60"
        >
          {maxTimeSec.toFixed(1)}
        </text>
      </svg>
      <div
        className="flex items-center gap-2 text-[11px] text-slate-500 dark:text-slate-400"
        title="Every dot is a better plan than the one before. The line climbing means the plan is improving."
      >
        <span>
          {solutions.length} plan{solutions.length === 1 ? "" : "s"} found
        </span>
        <span>·</span>
        <span>{bestImprovementPct.toFixed(1)}% better than the first draft</span>
      </div>
    </div>
  );
}


// Type for stats history entry - exported for use in history
export type StatsHistoryEntry = { time_ms: number } & SolverLiveStats;

// Stats chart for a single metric - same size as main solution chart
// Supports fixed Y-axis range via fixedMin/fixedMax to avoid misleading auto-scaling
function MiniStatsChart({
  data,
  dataKey,
  elapsedMs,
  color,
  labelSuffix,
  fixedMin,
  fixedMax,
}: {
  data: StatsHistoryEntry[];
  dataKey: keyof StatsHistoryEntry;
  elapsedMs: number;
  color: string;
  labelSuffix?: string; // e.g., "/42" for "x/y" format
  fixedMin?: number; // Fixed Y-axis minimum (e.g., 0)
  fixedMax?: number; // Fixed Y-axis maximum (e.g., totalRequiredSlots)
}) {
  if (data.length === 0) return null;

  const width = 500;
  const height = 140;
  const padding = { top: 15, right: 45, bottom: 25, left: 55 }; // Extra right padding for label
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;

  const values = data.map((d) => d[dataKey] as number);
  const dataMin = Math.min(...values);
  const dataMax = Math.max(...values);

  // Use fixed range if provided, otherwise fall back to data range
  let minVal = fixedMin ?? dataMin;
  let maxVal = fixedMax ?? dataMax;

  // When min equals max, add padding so the line appears in the middle
  if (minVal === maxVal) {
    const padding_amount = Math.max(1, Math.abs(minVal * 0.1)); // 10% or at least 1
    minVal = Math.floor(minVal - padding_amount);
    maxVal = Math.ceil(maxVal + padding_amount);
  }

  const range = maxVal - minVal;

  const maxTimeMs = Math.max(elapsedMs, ...data.map((d) => d.time_ms)) * 1.05;

  // Build step path - higher values at top
  const points: { x: number; y: number; value: number }[] = [];
  for (let i = 0; i < data.length; i++) {
    const d = data[i];
    const val = d[dataKey] as number;
    const normalized = (val - minVal) / range;
    const y = padding.top + (1 - normalized) * innerHeight;
    const x = padding.left + (d.time_ms / maxTimeMs) * innerWidth;
    points.push({ x, y, value: val });

    // Extend to next point or current time
    const nextTime = i < data.length - 1 ? data[i + 1].time_ms : elapsedMs;
    const nextX = padding.left + (nextTime / maxTimeMs) * innerWidth;
    points.push({ x: nextX, y, value: val });
  }

  const linePath = points.length > 0
    ? `M ${points.map((p) => `${p.x},${p.y}`).join(" L ")}`
    : "";

  // Get the current (last) value for the label
  const currentValue = points.length > 0 ? points[points.length - 1].value : 0;
  const lastPoint = points.length > 0 ? points[points.length - 1] : null;
  const labelText = labelSuffix ? `${currentValue}${labelSuffix}` : `${currentValue}`;

  return (
    <svg width={width} height={height} className="overflow-visible">
      {/* Background grid line */}
      <line
        x1={padding.left}
        y1={height - padding.bottom}
        x2={width - padding.right}
        y2={height - padding.bottom}
        stroke="currentColor"
        strokeOpacity={0.1}
      />
      {/* Line path */}
      {linePath && (
        <path d={linePath} fill="none" stroke={color} strokeWidth={1.5} />
      )}
      {/* Current value dot and label at leading edge */}
      {lastPoint && (
        <>
          <circle
            cx={lastPoint.x}
            cy={lastPoint.y}
            r={4}
            fill={color}
          />
          <text
            x={lastPoint.x + 8}
            y={lastPoint.y + 4}
            className="text-[11px] font-semibold"
            fill={color}
          >
            {labelText}
          </text>
        </>
      )}
      {/* Y-axis labels - higher values at top */}
      <text
        x={padding.left - 4}
        y={padding.top + 4}
        textAnchor="end"
        className="fill-current text-[11px] opacity-60"
      >
        {maxVal}
      </text>
      <text
        x={padding.left - 4}
        y={height - padding.bottom}
        textAnchor="end"
        className="fill-current text-[11px] opacity-60"
      >
        {minVal}
      </text>
      {/* X-axis labels */}
      <text
        x={padding.left}
        y={height - 5}
        className="fill-current text-[11px] opacity-60"
      >
        0
      </text>
      <text
        x={width - padding.right}
        y={height - 5}
        textAnchor="end"
        className="fill-current text-[11px] opacity-60"
      >
        {(Math.max(elapsedMs, ...data.map((d) => d.time_ms)) / 1000).toFixed(1)}
      </text>
      {/* Axis lines */}
      <line
        x1={padding.left}
        y1={height - padding.bottom}
        x2={width - padding.right}
        y2={height - padding.bottom}
        stroke="currentColor"
        strokeOpacity={0.2}
      />
      <line
        x1={padding.left}
        y1={padding.top}
        x2={padding.left}
        y2={height - padding.bottom}
        stroke="currentColor"
        strokeOpacity={0.2}
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

// Section header for dashboard groups
function DashboardSectionHeader({ title }: { title: string }) {
  return (
    <div className="col-span-full mt-2 mb-1">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
        {title}
      </h3>
    </div>
  );
}

// Constraint status badge - replaces charts for hard constraints that are always 0
function ConstraintStatusBadge({
  items,
}: {
  items: { label: string; value: number; color: string }[];
}) {
  const allSatisfied = items.every((item) => item.value === 0);
  return (
    <div className="col-span-full">
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white px-5 py-3 shadow-sm dark:border-slate-700 dark:bg-slate-800">
        {allSatisfied ? (
          <div className="flex items-center gap-2">
            <div className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-900">
              <svg className="h-3 w-3 text-emerald-600 dark:text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <span className="text-sm font-medium text-emerald-700 dark:text-emerald-300">
              All constraints satisfied
            </span>
          </div>
        ) : (
          items.map((item) => (
            <div key={item.label} className="flex items-center gap-1.5">
              <div
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: item.value === 0 ? "#10b981" : item.color }}
              />
              <span className={`text-xs font-medium ${item.value === 0 ? "text-slate-500 dark:text-slate-400" : "text-slate-700 dark:text-slate-200"}`}>
                {item.label}: {item.value === 0 ? "OK" : item.value}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// Full-screen dashboard with all graphs
function SolverDashboard({
  liveSolutions,
  statsHistory,
  liveStats,
  elapsedMs,
  solverMode,
  onClose,
}: {
  liveSolutions: LiveSolution[];
  statsHistory: StatsHistoryEntry[];
  liveStats: SolverLiveStats | null;
  elapsedMs: number;
  solverMode?: SolverMode;
  onClose: () => void;
}) {
  const hasStats = liveStats && statsHistory.length > 1;
  const hasWorkingHoursTarget = liveStats && liveStats.totalPeopleWeeksWithTarget > 0;
  const hasTimeWindows = liveStats && liveStats.totalAssignmentsWithTimeWindows > 0;
  const hasPreferenceRank = liveStats && liveStats.maxPreferenceRankScore > 0;

  return createPortal(
    <div className="fixed inset-0 z-[1100] flex flex-col bg-slate-50 dark:bg-slate-900">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-4 dark:border-slate-700 dark:bg-slate-800">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold text-slate-800 dark:text-slate-100">
            Run charts
          </h2>
          <div className="flex items-center gap-2 rounded-full bg-slate-100 px-3 py-1 dark:bg-slate-700">
            <div className="h-2 w-2 animate-pulse rounded-full bg-indigo-500" />
            <span className="text-xs font-medium tabular-nums text-slate-600 dark:text-slate-300">
              {formatDuration(elapsedMs)}
            </span>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg border border-slate-200 bg-white px-4 py-1.5 text-sm font-medium text-slate-600 transition-colors hover:border-slate-300 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-slate-500 focus:ring-offset-2 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:border-slate-600 dark:hover:bg-slate-700"
        >
          ← Back
        </button>
      </div>

      {/* Dashboard content */}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-6xl">
          {/* Top row: Score (full width). Hidden for agent runs — the agent
              optimizes a priority ladder, the encoded scalar means nothing. */}
          {solverMode !== "agent" && (
            <DashboardCard title="Optimization Score" accentColor="#6366f1" className="mb-6">
              <LiveSolutionChart solutions={liveSolutions} elapsedMs={elapsedMs} />
            </DashboardCard>
          )}

          {/* Stats grid: 2 columns on larger screens */}
          {hasStats && (
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              {/* === Coverage === */}
              <DashboardSectionHeader title="Coverage" />

              {/* Filled Slots - fixed Y-axis 0..totalRequired */}
              <DashboardCard title="Filled Slots" accentColor="#6366f1">
                <MiniStatsChart
                  data={statsHistory}
                  dataKey="filledSlots"
                  elapsedMs={elapsedMs}
                  color="#6366f1"
                  labelSuffix={`/${liveStats.totalRequiredSlots}`}
                  fixedMin={0}
                  fixedMax={liveStats.totalRequiredSlots}
                />
              </DashboardCard>

              {/* Total Assignments - fixed Y-axis starting at 0 */}
              <DashboardCard title="Total Assignments" accentColor="#818cf8">
                <MiniStatsChart
                  data={statsHistory}
                  dataKey="totalAssignments"
                  elapsedMs={elapsedMs}
                  color="#818cf8"
                  fixedMin={0}
                />
              </DashboardCard>

              {/* === Constraints — compact status badge === */}
              <DashboardSectionHeader title="Constraints" />
              <ConstraintStatusBadge
                items={[
                  { label: "Non-consecutive shifts", value: liveStats.nonConsecutiveShifts, color: "#ef4444" },
                  { label: "Location changes", value: liveStats.locationChanges, color: "#f59e0b" },
                  { label: "On-call rest violations", value: liveStats.onCallRestViolations, color: "#dc2626" },
                ]}
              />

              {/* === Quality === */}
              {(hasWorkingHoursTarget || hasPreferenceRank || hasTimeWindows) && (
                <DashboardSectionHeader title="Quality" />
              )}

              {/* Working Hours Deviation - continuous, lower is better, fixed at 0 min */}
              {hasWorkingHoursTarget && (
                <DashboardCard title="Working Hours Deviation" accentColor="#10b981">
                  <MiniStatsChart
                    data={statsHistory}
                    dataKey="workingHoursDeviationMinutes"
                    elapsedMs={elapsedMs}
                    color="#10b981"
                    labelSuffix=" min"
                    fixedMin={0}
                  />
                </DashboardCard>
              )}

              {/* Section Preference Rank Score - weighted, higher is better */}
              {hasPreferenceRank && (
                <DashboardCard title="Preference Rank Score" accentColor="#8b5cf6">
                  <MiniStatsChart
                    data={statsHistory}
                    dataKey="preferenceRankScore"
                    elapsedMs={elapsedMs}
                    color="#8b5cf6"
                    labelSuffix={`/${liveStats.maxPreferenceRankScore}`}
                    fixedMin={0}
                    fixedMax={liveStats.maxPreferenceRankScore}
                  />
                </DashboardCard>
              )}

              {/* Time Window Compliance - fixed Y-axis 0..total */}
              {hasTimeWindows && (
                <DashboardCard title="Time Window Compliance" accentColor="#06b6d4">
                  <MiniStatsChart
                    data={statsHistory}
                    dataKey="timeWindowFits"
                    elapsedMs={elapsedMs}
                    color="#06b6d4"
                    labelSuffix={`/${liveStats.totalAssignmentsWithTimeWindows}`}
                    fixedMin={0}
                    fixedMax={liveStats.totalAssignmentsWithTimeWindows}
                  />
                </DashboardCard>
              )}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

export default function SolverOverlay({
  isVisible,
  elapsedMs,
  onMinimize,
  solveRange,
  displayedRange,
  onAbort,
  onApplySolution,
  liveSolutions = [],
  scheduleRows = [],
  clinicians = [],
  holidays = new Set(),
  currentPhase = null,
  existingAssignments = [],
  solverSettings,
  solverMode,
  agentEvents = [],
  liveConnected = true,
  error,
}: SolverOverlayProps) {
  const [dashboardOpen, setDashboardOpen] = useState(false);
  // Held here, not in the panel: this component stays mounted while the run
  // is in the background, so an opened log is still open when it comes back.
  const [activityLogOpen, setActivityLogOpen] = useState(false);
  const [calendarContainer, setCalendarContainer] = useState<HTMLElement | null>(null);

  // Reset dashboard view when a new solve starts
  useEffect(() => {
    if (isVisible) {
      setDashboardOpen(false);
    }
  }, [isVisible]);

  // Find the calendar container while visible. No dependency array on
  // purpose: the calendar grid is remounted on settings / layout / plan-scope
  // switches, and a stale container is detached and invisible. Re-resolve
  // whenever the .calendar-scroll element changes (the overlay re-renders
  // every 100 ms via elapsedMs anyway).
  const scrollElRef = useRef<Element | null>(null);
  useEffect(() => {
    if (!isVisible) {
      scrollElRef.current = null;
      return;
    }
    // Find the parent of .calendar-scroll which has position:relative
    const scrollEl = document.querySelector('.calendar-scroll');
    if (scrollEl === scrollElRef.current) return;
    scrollElRef.current = scrollEl;
    const container = scrollEl?.parentElement;
    // Small calendars (few template rows) clip the modal: the overlay is
    // bounded by the container, so panels and chart end up behind a scrollbar
    // in a ~300px window. Fall back to the viewport-centered overlay then.
    if (container instanceof HTMLElement && container.clientHeight >= 600) {
      setCalendarContainer(container);
    } else {
      setCalendarContainer(null);
    }
  });

  // Cache for incremental stats computation
  // Key: solution object (one per SSE event), Value: computed stats entry.
  // solution_num restarts at 1 for every run, so it is not a safe key.
  const statsCache = useRef(new WeakMap<LiveSolution, StatsHistoryEntry>());

  // Build stats history incrementally - only compute stats for new solutions
  const statsHistory = useMemo(() => {
    if (!solveRange) return [];

    const history: StatsHistoryEntry[] = [];
    for (const solution of liveSolutions) {
      // Check if we already computed stats for this solution
      const cached = statsCache.current.get(solution);
      if (cached) {
        history.push(cached);
      } else {
        // Compute stats only for new solutions
        const solverAssignments = solution.assignments ?? [];
        const statsSettings: SolverSettingsForStats | undefined = solverSettings
          ? {
              onCallRestEnabled: solverSettings.onCallRestEnabled,
              onCallRestClassId: solverSettings.onCallRestClassId,
              onCallRestDaysBefore: solverSettings.onCallRestDaysBefore,
              onCallRestDaysAfter: solverSettings.onCallRestDaysAfter,
            }
          : undefined;
        const stats = calculateSolverLiveStats(
          solverAssignments,
          scheduleRows,
          clinicians,
          solveRange,
          holidays,
          existingAssignments,
          statsSettings,
        );
        const entry: StatsHistoryEntry = {
          time_ms: solution.time_ms,
          ...stats,
        };
        // Cache it for future renders
        statsCache.current.set(solution, entry);
        history.push(entry);
      }
    }
    return history;
  }, [solveRange, liveSolutions, scheduleRows, clinicians, holidays, existingAssignments, solverSettings]);

  // Calculate live stats for the current best solution (last entry in history)
  const liveStats = statsHistory.length > 0 ? statsHistory[statsHistory.length - 1] : null;

  // Check if the displayed week overlaps with the solve range
  const hasOverlap =
    isVisible && solveRange && rangesOverlap(solveRange, displayedRange);

  // Don't render if not visible or no overlap
  if (!hasOverlap) return null;

  const dateRangeLabel = solveRange
    ? `${formatEuropeanDate(solveRange.startISO)} – ${formatEuropeanDate(solveRange.endISO)}`
    : null;

  // If no calendar container found (e.g., settings view is open), render as fixed overlay
  const portalTarget = calendarContainer?.isConnected ? calendarContainer : document.body;
  const isFixedOverlay = portalTarget === document.body;
  const isAgent = solverMode === "agent";
  const hasDraftAssignments = liveSolutions.some((solution) => (solution.assignments?.length ?? 0) > 0);

  // Layout (top to bottom): what runs and for how long · where it stands
  // (agent: day track and current step; optimizer: phase) · the best plan so
  // far (coverage, rules, goals; the score chart for the optimizer) · the
  // agent's activity log, collapsed · the actions in a footer that never
  // scrolls away. Primary action: apply the best plan; "Stop run" is quiet.
  const bestPlan = liveStats ? (
    <section
      aria-label="Best plan so far"
      className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm sm:p-4 dark:border-slate-700 dark:bg-slate-900"
    >
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <h4 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          Best plan so far
        </h4>
        {hasDraftAssignments ? (
          <button
            type="button"
            onClick={() => setDashboardOpen(true)}
            title="Show live charts and statistics for this run. Planning continues in the background."
            className="rounded-md px-1.5 py-0.5 text-xs font-medium text-indigo-600 hover:bg-indigo-50 dark:text-indigo-300 dark:hover:bg-indigo-950"
          >
            Charts
          </button>
        ) : null}
      </div>
      <ConstraintPulse stats={liveStats} onCallRestEnabled={solverSettings?.onCallRestEnabled ?? false} />
      {/* Agent runs work on a strict priority ladder, not a scalar score: the
          encoded objective means nothing to users there, so the score chart
          only shows for the classic optimizer. */}
      {liveSolutions.length > 0 && !isAgent ? (
        <div className="mt-4 border-t border-slate-100 pt-3 text-slate-600 dark:border-slate-800 dark:text-slate-300">
          <LiveSolutionChart solutions={liveSolutions} elapsedMs={elapsedMs} />
        </div>
      ) : null}
    </section>
  ) : isAgent ? (
    <section
      aria-label="Best plan so far"
      className="rounded-xl border border-dashed border-slate-200 px-3 py-3 text-xs text-slate-500 sm:px-4 dark:border-slate-700 dark:text-slate-400"
    >
      <span className="font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Best plan so far</span>
      <span className="mt-1 block">Appears here as soon as the first draft is saved.</span>
    </section>
  ) : null;

  return createPortal(
    <div
      className={cx(
        isFixedOverlay ? "fixed" : "absolute",
        "inset-0 z-30 flex items-center justify-center p-3 sm:p-6",
      )}
    >
      {/* Calm backdrop: the calendar stays recognizable behind the panel. */}
      <div className="absolute inset-0 bg-white/80 backdrop-blur-[2px] dark:bg-slate-950/80" />

      <section
        aria-label={isAgent ? "AI planning run" : "Optimizer run"}
        className="relative z-10 flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900"
      >
        {/* Header: what runs, over which days, for how long. */}
        <header className="flex items-center gap-3 border-b border-slate-100 px-4 py-3 sm:px-5 dark:border-slate-800">
          <span
            aria-hidden="true"
            className="solver-breathe grid h-9 w-9 shrink-0 place-items-center rounded-full bg-gradient-to-br from-indigo-500 to-violet-500 text-white"
          >
            <svg viewBox="0 0 24 24" fill="currentColor" className="h-[18px] w-[18px]">
              <path d="M12 2c.4 3.9 3 6.9 7 7.5v1c-4 .6-6.6 3.6-7 7.5h-1c-.4-3.9-3-6.9-7-7.5v-1c4-.6 6.6-3.6 7-7.5h1z" />
            </svg>
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-[15px] font-semibold text-slate-900 dark:text-slate-50">
              {isAgent ? "AI planning" : "Optimizing schedule"}
            </h3>
            {dateRangeLabel ? (
              <p className="truncate text-xs tabular-nums text-slate-500 dark:text-slate-400">{dateRangeLabel}</p>
            ) : null}
          </div>
          <div
            role="progressbar"
            aria-label="Solver progress"
            aria-valuetext={`Running for ${formatDuration(elapsedMs)}`}
            className="shrink-0 text-right"
          >
            <div className="text-lg font-semibold leading-6 tabular-nums text-slate-800 dark:text-slate-100">
              {formatDuration(elapsedMs)}
            </div>
            <div className="text-[10px] uppercase tracking-wide text-slate-400 dark:text-slate-500">running</div>
          </div>
        </header>

        {/* Body: scrolls on its own, header and actions stay in place. */}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5">
          <div className="flex flex-col gap-4">
            {error ? (
              <div role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-950 dark:text-rose-200">
                {error}
              </div>
            ) : null}
            {isAgent ? (
              <AgentActivityPanel
                events={agentEvents}
                elapsedMs={elapsedMs}
                currentPhase={currentPhase}
                liveConnected={liveConnected}
                range={solveRange}
                logOpen={activityLogOpen}
                onLogOpenChange={setActivityLogOpen}
              >
                {bestPlan}
              </AgentActivityPanel>
            ) : (
              <>
                {/* Preparation phase, shown before the first solution arrives. */}
                {currentPhase && liveSolutions.length === 0 ? (
                  <div className="flex items-center gap-3 rounded-xl bg-slate-50 px-4 py-3 dark:bg-slate-800/60">
                    <div className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-indigo-500" />
                    <span className="text-sm text-slate-600 dark:text-slate-300">{currentPhase}</span>
                  </div>
                ) : null}
                {bestPlan}
              </>
            )}
          </div>
        </div>

        {/* Actions: always visible. On phones the primary action comes first. */}
        <footer className="border-t border-slate-100 bg-slate-50/80 px-4 py-3 sm:px-5 dark:border-slate-800 dark:bg-slate-950/40">
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center">
            <button
              type="button"
              onClick={onAbort}
              title="Stop the run — the calendar stays untouched; any partial result lands in the run inbox."
              className="rounded-lg px-3 py-2 text-sm font-medium text-rose-600 transition-colors hover:bg-rose-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-500 sm:mr-auto sm:py-1.5 dark:text-rose-300 dark:hover:bg-rose-950/60"
            >
              Stop run
            </button>
            {onMinimize ? (
              <button
                type="button"
                onClick={onMinimize}
                title="Hide this panel - the run keeps working on the server and a badge stays in the corner."
                className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm transition-colors hover:border-slate-300 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:py-1.5 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
              >
                Run in background
              </button>
            ) : null}
            {liveSolutions.length > 0 ? (
              <button
                type="button"
                onClick={onApplySolution}
                title="Stop the run now and apply the best plan found so far to the calendar."
                className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-indigo-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 sm:py-1.5 dark:bg-indigo-500 dark:hover:bg-indigo-400 dark:focus-visible:ring-offset-slate-900"
              >
                Apply best plan
              </button>
            ) : null}
          </div>
          <p className="mt-2 text-[11px] leading-snug text-slate-500 dark:text-slate-400">
            The run continues on the server. Your calendar changes only when you apply a plan; the
            best plan is also kept in the run inbox for review.
          </p>
        </footer>

        {/* Full-screen dashboard */}
        {dashboardOpen && (
          <SolverDashboard
            liveSolutions={liveSolutions}
            statsHistory={statsHistory}
            liveStats={liveStats}
            elapsedMs={elapsedMs}
            solverMode={solverMode}
            onClose={() => setDashboardOpen(false)}
          />
        )}
      </section>
    </div>,
    portalTarget,
  );
}
