import { useState, useMemo, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { Assignment, Clinician, SolverSettings } from "../../api/client";
import type { ScheduleRow } from "../../lib/shiftRows";
import { calculateSolverLiveStats } from "../../lib/solverStats";
import type { SolverSettingsForStats } from "../../lib/solverStats";

export type LiveSolution = {
  solution_num: number;
  time_ms: number;
  objective: number;
  assignments?: Assignment[];
};

type SolverOverlayProps = {
  isVisible: boolean;
  progress: { current: number; total: number } | null;
  elapsedMs: number;
  totalAllowedMs: number; // Total time allowed for solving
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
          className="fill-current text-[11px] opacity-60"
        >
          Score
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
      <div className="flex items-center gap-2 text-[11px] text-slate-500 dark:text-slate-400">
        <span>Solutions: {solutions.length}</span>
        <span>Improved: {bestImprovementPct.toFixed(1)}%</span>
      </div>
    </div>
  );
}


// Type for stats history entry - exported for use in history
export type StatsHistoryEntry = {
  time_ms: number;
  filledSlots: number;
  openSlots: number;
  nonConsecutiveShifts: number;
  peopleWeeksWithinHours: number;
  totalPeopleWeeksWithTarget: number;
  totalRequiredSlots: number;
  locationChanges: number;
  totalAssignments: number;
  sectionPreferenceMatches: number;
  totalClassAssignments: number;
  timeWindowFits: number;
  totalAssignmentsWithTimeWindows: number;
  onCallRestViolations: number;
  workingHoursDeviationMinutes: number;
  preferenceRankScore: number;
  maxPreferenceRankScore: number;
};

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
  totalAllowedMs,
  onClose,
}: {
  liveSolutions: LiveSolution[];
  statsHistory: StatsHistoryEntry[];
  liveStats: {
    filledSlots: number;
    totalRequiredSlots: number;
    openSlots: number;
    nonConsecutiveShifts: number;
    peopleWeeksWithinHours: number;
    totalPeopleWeeksWithTarget: number;
    locationChanges: number;
    totalAssignments: number;
    sectionPreferenceMatches: number;
    totalClassAssignments: number;
    timeWindowFits: number;
    totalAssignmentsWithTimeWindows: number;
    onCallRestViolations: number;
    workingHoursDeviationMinutes: number;
    preferenceRankScore: number;
    maxPreferenceRankScore: number;
  } | null;
  elapsedMs: number;
  totalAllowedMs: number;
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
            Solver Details
          </h2>
          <div className="flex items-center gap-2 rounded-full bg-slate-100 px-3 py-1 dark:bg-slate-700">
            <div className="h-2 w-2 animate-pulse rounded-full bg-indigo-500" />
            <span className="text-xs font-medium tabular-nums text-slate-600 dark:text-slate-300">
              {formatDuration(elapsedMs)} / {formatDuration(totalAllowedMs)}
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
          {/* Top row: Score (full width) */}
          <DashboardCard title="Optimization Score" accentColor="#6366f1" className="mb-6">
            <LiveSolutionChart solutions={liveSolutions} elapsedMs={elapsedMs} />
          </DashboardCard>

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
  progress,
  elapsedMs,
  totalAllowedMs,
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
}: SolverOverlayProps) {
  const [dashboardOpen, setDashboardOpen] = useState(false);
  const [calendarContainer, setCalendarContainer] = useState<HTMLElement | null>(null);

  // Find the calendar container when visible or on mount
  useEffect(() => {
    if (!isVisible) return;
    // Find the parent of .calendar-scroll which has position:relative
    const scrollEl = document.querySelector('.calendar-scroll');
    const container = scrollEl?.parentElement;
    if (container instanceof HTMLElement) {
      setCalendarContainer(container);
    }
  }, [isVisible]);

  // Cache for incremental stats computation
  // Key: solution_num, Value: computed stats entry
  const statsCache = useRef<Map<number, StatsHistoryEntry>>(new Map());
  const lastSolveRangeKey = useRef<string | null>(null);

  // Build stats history incrementally - only compute stats for new solutions
  const statsHistory = useMemo(() => {
    if (!solveRange) return [];

    // If solve range changed, clear cache
    const solveRangeKey = `${solveRange.startISO}-${solveRange.endISO}`;
    if (lastSolveRangeKey.current !== solveRangeKey) {
      statsCache.current.clear();
      lastSolveRangeKey.current = solveRangeKey;
    }

    const history: StatsHistoryEntry[] = [];
    for (const solution of liveSolutions) {
      // Check if we already computed stats for this solution
      const cached = statsCache.current.get(solution.solution_num);
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
        statsCache.current.set(solution.solution_num, entry);
        history.push(entry);
      }
    }
    return history;
  }, [solveRange, liveSolutions, scheduleRows, clinicians, holidays, existingAssignments, solverSettings]);

  // Calculate live stats for the current best solution (last entry in history)
  const liveStats = useMemo(() => {
    if (statsHistory.length === 0) return null;
    const last = statsHistory[statsHistory.length - 1];
    return {
      filledSlots: last.filledSlots,
      totalRequiredSlots: last.totalRequiredSlots,
      openSlots: last.openSlots,
      nonConsecutiveShifts: last.nonConsecutiveShifts,
      peopleWeeksWithinHours: last.peopleWeeksWithinHours,
      totalPeopleWeeksWithTarget: last.totalPeopleWeeksWithTarget,
      locationChanges: last.locationChanges,
      totalAssignments: last.totalAssignments,
      sectionPreferenceMatches: last.sectionPreferenceMatches,
      totalClassAssignments: last.totalClassAssignments,
      timeWindowFits: last.timeWindowFits,
      totalAssignmentsWithTimeWindows: last.totalAssignmentsWithTimeWindows,
      onCallRestViolations: last.onCallRestViolations,
      workingHoursDeviationMinutes: last.workingHoursDeviationMinutes,
      preferenceRankScore: last.preferenceRankScore,
      maxPreferenceRankScore: last.maxPreferenceRankScore,
    };
  }, [statsHistory]);

  // Check if the displayed week overlaps with the solve range
  const hasOverlap =
    isVisible && solveRange && rangesOverlap(solveRange, displayedRange);

  // Don't render if not visible or no overlap
  if (!hasOverlap) return null;

  const dateRangeLabel = solveRange
    ? `${formatEuropeanDate(solveRange.startISO)} – ${formatEuropeanDate(solveRange.endISO)}`
    : null;

  // If no calendar container found (e.g., settings view is open), render as fixed overlay
  const portalTarget = calendarContainer ?? document.body;
  const isFixedOverlay = !calendarContainer;

  return createPortal(
    <div className={isFixedOverlay ? "fixed inset-0 z-30 flex items-center justify-center" : "absolute inset-0 z-30 flex items-center justify-center"}>
      {/* Semi-transparent overlay */}
      <div className="absolute inset-0 bg-white/80 dark:bg-slate-900/80" />

      {/* Content panel - compact width that fits content */}
      <div className="relative z-10 flex max-h-[90%] w-auto max-w-lg flex-col items-center gap-4 overflow-y-auto rounded-2xl border border-slate-200 bg-white px-8 py-6 shadow-2xl dark:border-slate-700 dark:bg-slate-900">
        {/* Circular progress indicator */}
        {(() => {
          const progress = Math.min(1, elapsedMs / totalAllowedMs);
          const radius = 28;
          const circumference = 2 * Math.PI * radius;
          const strokeDashoffset = circumference * (1 - progress);
          return (
            <div className="relative h-16 w-16" role="progressbar" aria-valuenow={Math.round(progress * 100)} aria-label="Solver progress">
              <svg
                className="-rotate-90"
                viewBox="0 0 64 64"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
                {/* Background circle */}
                <circle
                  cx="32"
                  cy="32"
                  r={radius}
                  stroke="currentColor"
                  strokeWidth="4"
                  className="text-slate-200 dark:text-slate-700"
                />
                {/* Progress arc */}
                <circle
                  cx="32"
                  cy="32"
                  r={radius}
                  stroke="currentColor"
                  strokeWidth="4"
                  strokeLinecap="round"
                  className="text-indigo-500 transition-all duration-300"
                  style={{
                    strokeDasharray: circumference,
                    strokeDashoffset: strokeDashoffset,
                  }}
                />
              </svg>
            </div>
          );
        })()}

        {/* Elapsed / Total time - directly under the progress ring */}
        <div className="-mt-2 text-sm font-medium tabular-nums text-slate-600 dark:text-slate-300">
          {formatDuration(elapsedMs)} / {formatDuration(totalAllowedMs)}
        </div>

        {/* Title and date range */}
        <div className="flex flex-col items-center gap-1">
          <h3 className="text-base font-semibold text-slate-800 dark:text-slate-100">
            Optimizing Schedule
          </h3>
          {dateRangeLabel && (
            <p className="text-sm font-medium text-indigo-600 dark:text-indigo-400">
              {dateRangeLabel}
            </p>
          )}
          <p className="mt-1 text-center text-xs text-slate-500 dark:text-slate-400">
            Schedule is locked during optimization
          </p>
        </div>

        {/* Preparation phase indicator - shown before solutions arrive */}
        {currentPhase && liveSolutions.length === 0 && (
          <div className="flex items-center gap-3 rounded-lg bg-slate-50 px-4 py-3 dark:bg-slate-800">
            <div className="h-2 w-2 animate-pulse rounded-full bg-indigo-500" />
            <span className="text-sm text-slate-600 dark:text-slate-300">
              {currentPhase}
            </span>
          </div>
        )}

        {/* Live solutions chart */}
        {liveSolutions.length > 0 && (
          <LiveSolutionChart solutions={liveSolutions} elapsedMs={elapsedMs} />
        )}

        {/* Action buttons */}
        <div className="flex items-center gap-3">
          {/* Details button - only shown when solutions exist */}
          {liveSolutions.length > 0 && (
            <button
              type="button"
              onClick={() => setDashboardOpen(true)}
              className="rounded-lg border border-slate-200 bg-white px-4 py-1.5 text-sm font-medium text-slate-600 transition-colors hover:border-slate-300 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-slate-500 focus:ring-offset-2 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:border-slate-600 dark:hover:bg-slate-700"
            >
              Details
            </button>
          )}

          {/* Abort button - always shown */}
          <button
            type="button"
            onClick={onAbort}
            className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-1.5 text-sm font-medium text-rose-600 transition-colors hover:border-rose-300 hover:bg-rose-100 focus:outline-none focus:ring-2 focus:ring-rose-500 focus:ring-offset-2 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-300 dark:hover:border-rose-700 dark:hover:bg-rose-900"
          >
            Abort
          </button>

          {/* Apply Solution button - only shown when solutions exist */}
          {liveSolutions.length > 0 && (
            <button
              type="button"
              onClick={onApplySolution}
              className="rounded-lg border border-indigo-200 bg-indigo-50 px-4 py-1.5 text-sm font-medium text-indigo-600 transition-colors hover:border-indigo-300 hover:bg-indigo-100 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 dark:border-indigo-800 dark:bg-indigo-950 dark:text-indigo-300 dark:hover:border-indigo-700 dark:hover:bg-indigo-900"
            >
              Apply Solution
            </button>
          )}
        </div>

        {/* Full-screen dashboard */}
        {dashboardOpen && (
          <SolverDashboard
            liveSolutions={liveSolutions}
            statsHistory={statsHistory}
            liveStats={liveStats}
            elapsedMs={elapsedMs}
            totalAllowedMs={totalAllowedMs}
            onClose={() => setDashboardOpen(false)}
          />
        )}
      </div>
    </div>,
    portalTarget,
  );
}
