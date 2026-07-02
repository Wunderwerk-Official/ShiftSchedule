import { useMemo } from "react";
import type { SolverDebugInfo } from "../../api/client";
import { cx } from "../../lib/classNames";

type SolverDebugPanelProps = {
  debugInfo: SolverDebugInfo;
};

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatPercentage(part: number, total: number): string {
  if (total === 0) return "0%";
  return `${((part / total) * 100).toFixed(1)}%`;
}

function formatSmallPercentage(value: number): string {
  // Use dynamic precision based on the magnitude
  const absVal = Math.abs(value);
  if (absVal === 0) return "0%";
  if (absVal >= 1) return `${value.toFixed(2)}%`;
  if (absVal >= 0.01) return `${value.toFixed(3)}%`;
  if (absVal >= 0.0001) return `${value.toFixed(5)}%`;
  return `${value.toExponential(2)}%`;
}

function formatObjective(value: number): string {
  const absVal = Math.abs(value);
  if (absVal >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (absVal >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (absVal >= 1e3) return `${(value / 1e3).toFixed(2)}K`;
  return value.toFixed(0);
}

export default function SolverDebugPanel({ debugInfo }: SolverDebugPanelProps) {
  const { timing, solution_times, num_variables, num_days, num_slots, solver_status, cpu_workers_used, cpu_cores_available, sub_scores } = debugInfo;

  // Calculate chart dimensions
  const chartWidth = 550;
  const chartHeight = 200;
  const padding = { top: 20, right: 20, bottom: 40, left: 70 };
  const innerWidth = chartWidth - padding.left - padding.right;
  const innerHeight = chartHeight - padding.top - padding.bottom;

  // Process solution times for the chart - logarithmic scale of (objective - minObj)
  const chartData = useMemo(() => {
    if (!solution_times || solution_times.length === 0) return null;

    const times = solution_times.map((s) => s.time_ms / 1000); // Convert to seconds
    const objectives = solution_times.map((s) => s.objective);

    // Use total runtime for X-axis max, not just the time of the last solution
    // This shows the full solve duration including time spent proving optimality
    const totalRuntimeSeconds = timing.total_ms / 1000;
    const lastSolutionTime = Math.max(...times);
    // Use whichever is larger, with 5% padding
    const maxTime = Math.max(totalRuntimeSeconds, lastSolutionTime) * 1.05;

    // Get min/max objective values (objectives are negative, more negative = better)
    const minObj = Math.min(...objectives); // Best (most negative)
    const maxObj = Math.max(...objectives); // Worst (least negative)

    // Transform to "distance from best": value = objective - minObj
    // This makes the best solution = 0 and worse solutions > 0
    // Then we use log scale for these transformed values
    const transformedValues = objectives.map((obj) => obj - minObj);
    const maxTransformed = Math.max(...transformedValues);

    // For log scale, we need to handle 0 (the best solution)
    // Add a small offset (1) to avoid log(0)
    const logMaxData = Math.log10(maxTransformed + 1);
    // Add 10% padding above the max for visual breathing room
    const logMax = logMaxData * 1.1;

    // Scale functions
    const xScale = (t: number) => (t / maxTime) * innerWidth;
    const yScale = (obj: number) => {
      // Transform: distance from best
      const transformed = obj - minObj;
      // Log scale with offset to handle 0
      const logValue = Math.log10(transformed + 1);
      // Map to chart: 0 (best) at bottom, max at top
      return ((logMax - logValue) / logMax) * innerHeight;
    };

    // Build smooth path with step-like appearance (solutions improve in steps)
    const points = times.map((t, i) => ({ x: xScale(t), y: yScale(objectives[i]), obj: objectives[i] }));

    // Add a final point at the end of the total runtime to show the line extending
    const endX = xScale(totalRuntimeSeconds);
    const lastY = points.length > 0 ? points[points.length - 1].y : innerHeight;

    // Create step path (horizontal then vertical)
    let pathD = "";
    if (points.length > 0) {
      pathD = `M ${points[0].x} ${points[0].y}`;
      for (let i = 1; i < points.length; i++) {
        // Horizontal line to new x, then vertical to new y
        pathD += ` L ${points[i].x} ${points[i - 1].y} L ${points[i].x} ${points[i].y}`;
      }
      // Extend line horizontally to the end of the runtime
      pathD += ` L ${endX} ${lastY}`;
    }

    // Create area path for fill under the line
    let areaD = "";
    if (points.length > 0) {
      areaD = `M ${points[0].x} ${innerHeight}`;
      areaD += ` L ${points[0].x} ${points[0].y}`;
      for (let i = 1; i < points.length; i++) {
        areaD += ` L ${points[i].x} ${points[i - 1].y} L ${points[i].x} ${points[i].y}`;
      }
      // Extend to end of runtime, then down to baseline
      areaD += ` L ${endX} ${lastY} L ${endX} ${innerHeight} Z`;
    }

    // Y-axis ticks - logarithmic spacing for "distance from optimal"
    const yTicks: { value: number; y: number; label: string }[] = [];
    // Generate log-spaced ticks
    const tickValues: number[] = [0]; // Always include 0 (optimal)
    if (maxTransformed > 0) {
      // Add log-spaced values
      const logStep = logMax / 4;
      for (let i = 1; i <= 4; i++) {
        const logVal = i * logStep;
        const transformed = Math.pow(10, logVal) - 1;
        if (transformed <= maxTransformed) {
          tickValues.push(transformed);
        }
      }
      // Ensure we have the max
      if (tickValues[tickValues.length - 1] < maxTransformed * 0.9) {
        tickValues.push(maxTransformed);
      }
    }
    // Convert to actual objective values and create ticks
    for (const transformed of tickValues) {
      const objValue = transformed + minObj;
      const logValue = Math.log10(transformed + 1);
      const y = ((logMax - logValue) / logMax) * innerHeight;
      yTicks.push({
        value: objValue,
        y,
        label: formatObjective(transformed), // Show distance from optimal
      });
    }

    // X-axis ticks
    const xTickCount = 4;
    const xTicks: { value: number; x: number }[] = [];
    for (let i = 0; i <= xTickCount; i++) {
      const value = (i / xTickCount) * maxTime;
      xTicks.push({ value, x: xScale(value) });
    }

    return {
      pathD,
      areaD,
      points,
      xTicks,
      yTicks,
      minObj,
      maxObj,
      maxTime,
    };
  }, [solution_times, timing.total_ms, innerWidth, innerHeight]);

  // Calculate improvement percentage
  const improvement = useMemo(() => {
    if (!solution_times || solution_times.length < 2) return null;
    const first = solution_times[0].objective;
    const last = solution_times[solution_times.length - 1].objective;
    // The objective is minimized (more negative = better), so improvement is
    // how far the objective dropped relative to the first solution — same
    // formula as SolverOverlay.
    const diff = first - last;
    const pct = (diff / Math.abs(first)) * 100;
    return pct.toFixed(4);
  }, [solution_times]);

  return (
    <div className="flex flex-col gap-4">
      {/* Summary stats */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        <div className="text-slate-500 dark:text-slate-400">Status</div>
        <div className="font-medium text-slate-700 dark:text-slate-200">{solver_status}</div>
        <div className="text-slate-500 dark:text-slate-400">Variables</div>
        <div className="font-medium text-slate-700 dark:text-slate-200">{num_variables.toLocaleString()}</div>
        <div className="text-slate-500 dark:text-slate-400">Days</div>
        <div className="font-medium text-slate-700 dark:text-slate-200">{num_days}</div>
        <div className="text-slate-500 dark:text-slate-400">Slots</div>
        <div className="font-medium text-slate-700 dark:text-slate-200">{num_slots}</div>
        <div className="text-slate-500 dark:text-slate-400">Solutions found</div>
        <div className="font-medium text-slate-700 dark:text-slate-200">{solution_times?.length ?? 0}</div>
        <div className="text-slate-500 dark:text-slate-400">CPU cores</div>
        <div className="font-medium text-slate-700 dark:text-slate-200">{cpu_workers_used} / {cpu_cores_available}</div>
        {improvement && (
          <>
            <div className="text-slate-500 dark:text-slate-400">Improvement</div>
            <div className="font-medium text-slate-700 dark:text-slate-200">{improvement}%</div>
          </>
        )}
      </div>

      {/* Sub-scores breakdown */}
      {sub_scores && (
        <div className="flex flex-col gap-1">
          <div className="text-xs font-medium text-slate-600 dark:text-slate-300">
            Objective Breakdown
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
            <div className="text-slate-500 dark:text-slate-400">Slots filled</div>
            <div className="font-medium text-green-600 dark:text-green-400">
              +{sub_scores.slots_filled.toLocaleString()}
            </div>
            <div className="text-slate-500 dark:text-slate-400">Slots unfilled (penalty)</div>
            <div className="font-medium text-red-600 dark:text-red-400">
              −{sub_scores.slots_unfilled.toLocaleString()}
            </div>
            <div className="text-slate-500 dark:text-slate-400">Total assignments</div>
            <div className="font-medium text-slate-700 dark:text-slate-200">
              {sub_scores.total_assignments.toLocaleString()}
            </div>
            <div className="text-slate-500 dark:text-slate-400">Preference score</div>
            <div className="font-medium text-green-600 dark:text-green-400">
              +{sub_scores.preference_score.toLocaleString()}
            </div>
            <div className="text-slate-500 dark:text-slate-400">Time window score</div>
            <div className="font-medium text-green-600 dark:text-green-400">
              +{sub_scores.time_window_score.toLocaleString()}
            </div>
            <div className="text-slate-500 dark:text-slate-400">Working hours penalty</div>
            <div className="font-medium text-red-600 dark:text-red-400">
              −{sub_scores.hours_penalty.toLocaleString()}
            </div>
          </div>
        </div>
      )}

      {/* Objective Value Over Time chart - seaborn-inspired style */}
      {chartData && solution_times.length > 1 && (
        <div className="flex flex-col gap-2">
          <div className="text-xs font-medium text-slate-600 dark:text-slate-300">
            Objective Value Over Time
          </div>
          <svg
            width={chartWidth}
            height={chartHeight}
            className="rounded-xl bg-slate-50 dark:bg-slate-800/50"
          >
            {/* Gradient definition for area fill */}
            <defs>
              <linearGradient id="areaGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#0ea5e9" stopOpacity="0.3" />
                <stop offset="100%" stopColor="#0ea5e9" stopOpacity="0.05" />
              </linearGradient>
              <linearGradient id="areaGradientDark" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#38bdf8" stopOpacity="0.25" />
                <stop offset="100%" stopColor="#38bdf8" stopOpacity="0.02" />
              </linearGradient>
            </defs>

            <g transform={`translate(${padding.left}, ${padding.top})`}>
              {/* Horizontal grid lines */}
              {chartData.yTicks.map((tick, i) => (
                <line
                  key={`grid-${i}`}
                  x1={0}
                  y1={tick.y}
                  x2={innerWidth}
                  y2={tick.y}
                  stroke="currentColor"
                  strokeDasharray={i === 0 || i === chartData.yTicks.length - 1 ? "0" : "3,3"}
                  className="text-slate-200 dark:text-slate-700"
                />
              ))}

              {/* Area fill under the line */}
              <path
                d={chartData.areaD}
                className="fill-[url(#areaGradient)] dark:fill-[url(#areaGradientDark)]"
              />

              {/* Main line */}
              {/* Using className-based stroke so the dark: variant actually wins —
                  a hardcoded stroke="…" attribute used to override the dark class. */}
              <path
                d={chartData.pathD}
                fill="none"
                strokeWidth={2.5}
                strokeLinecap="round"
                strokeLinejoin="round"
                className="stroke-sky-500 dark:stroke-sky-400"
              />

              {/* Data points with hover effect */}
              {chartData.points.map((point, i) => (
                <g key={i}>
                  {/* Outer glow */}
                  <circle
                    cx={point.x}
                    cy={point.y}
                    r={6}
                    className="fill-sky-500/20 dark:fill-sky-400/20"
                  />
                  {/* Inner point */}
                  <circle
                    cx={point.x}
                    cy={point.y}
                    r={4}
                    strokeWidth={2}
                    className="fill-white stroke-sky-500 dark:fill-slate-800 dark:stroke-sky-400"
                  />
                </g>
              ))}

              {/* Y-axis labels */}
              {chartData.yTicks.map((tick, i) => (
                <text
                  key={`y-${i}`}
                  x={-10}
                  y={tick.y}
                  textAnchor="end"
                  alignmentBaseline="middle"
                  className="fill-slate-500 text-[10px] font-medium dark:fill-slate-400"
                >
                  {tick.label}
                </text>
              ))}

              {/* X-axis labels */}
              {chartData.xTicks.map((tick, i) => (
                <text
                  key={`x-${i}`}
                  x={tick.x}
                  y={innerHeight + 20}
                  textAnchor="middle"
                  className="fill-slate-500 text-[10px] font-medium dark:fill-slate-400"
                >
                  {tick.value.toFixed(0)}s
                </text>
              ))}

              {/* Axis labels */}
              <text
                x={innerWidth / 2}
                y={innerHeight + 35}
                textAnchor="middle"
                className="fill-slate-400 text-[9px] dark:fill-slate-500"
              >
                Time (seconds)
              </text>
              <text
                x={-innerHeight / 2}
                y={-55}
                textAnchor="middle"
                transform="rotate(-90)"
                className="fill-slate-400 text-[9px] dark:fill-slate-500"
              >
                Distance from Minimum (log)
              </text>
            </g>
          </svg>
        </div>
      )}

      {/* Solution progress table */}
      {solution_times && solution_times.length > 0 && (
        <div className="flex flex-col gap-1">
          <div className="text-xs font-medium text-slate-600 dark:text-slate-300">
            Solution Progress
          </div>
          <div className="max-h-40 overflow-auto rounded-lg border border-slate-200 dark:border-slate-700">
            <table className="w-full text-xs">
              <thead className="sticky top-0">
                <tr className="bg-slate-50 dark:bg-slate-800">
                  <th className="px-2 py-1.5 text-left font-medium text-slate-600 dark:text-slate-300">
                    #
                  </th>
                  <th className="px-2 py-1.5 text-right font-medium text-slate-600 dark:text-slate-300">
                    Time
                  </th>
                  <th className="px-2 py-1.5 text-right font-medium text-slate-600 dark:text-slate-300">
                    Objective
                  </th>
                  <th className="px-2 py-1.5 text-right font-medium text-slate-600 dark:text-slate-300">
                    Δ from prev
                  </th>
                  <th className="px-2 py-1.5 text-right font-medium text-slate-600 dark:text-slate-300">
                    Δ from first
                  </th>
                </tr>
              </thead>
              <tbody>
                {solution_times.map((sol, i) => {
                  const firstObj = solution_times[0].objective;
                  const prevObj = i > 0 ? solution_times[i - 1].objective : sol.objective;
                  const deltaFromFirst = sol.objective - firstObj;
                  const deltaFromPrev = sol.objective - prevObj;
                  const deltaFromFirstPct = (deltaFromFirst / Math.abs(firstObj)) * 100;
                  return (
                    <tr
                      key={sol.solution}
                      className={cx(
                        i % 2 === 0 ? "bg-white dark:bg-slate-900" : "bg-slate-50/50 dark:bg-slate-800/50"
                      )}
                    >
                      <td className="px-2 py-1 text-slate-700 dark:text-slate-200">
                        {sol.solution}
                      </td>
                      <td className="px-2 py-1 text-right tabular-nums text-slate-600 dark:text-slate-300">
                        {formatMs(sol.time_ms)}
                      </td>
                      <td className="px-2 py-1 text-right tabular-nums text-slate-600 dark:text-slate-300">
                        {formatObjective(sol.objective)}
                      </td>
                      <td className="px-2 py-1 text-right tabular-nums text-slate-500 dark:text-slate-400">
                        {i === 0 ? "—" : formatObjective(deltaFromPrev)}
                      </td>
                      <td className="px-2 py-1 text-right tabular-nums text-slate-500 dark:text-slate-400">
                        {i === 0 ? "—" : formatSmallPercentage(deltaFromFirstPct)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Timing breakdown table */}
      <div className="flex flex-col gap-1">
        <div className="text-xs font-medium text-slate-600 dark:text-slate-300">
          Timing Breakdown
        </div>
        <div className="overflow-hidden rounded-lg border border-slate-200 dark:border-slate-700">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-slate-50 dark:bg-slate-800">
                <th className="px-2 py-1.5 text-left font-medium text-slate-600 dark:text-slate-300">
                  Phase
                </th>
                <th className="px-2 py-1.5 text-right font-medium text-slate-600 dark:text-slate-300">
                  Time
                </th>
                <th className="px-2 py-1.5 text-right font-medium text-slate-600 dark:text-slate-300">
                  %
                </th>
                <th className="w-24 px-2 py-1.5">
                  <span className="sr-only">Bar</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {timing.checkpoints.map((cp, i) => {
                const pct = (cp.duration_ms / timing.total_ms) * 100;
                return (
                  <tr
                    key={cp.name}
                    className={cx(
                      i % 2 === 0 ? "bg-white dark:bg-slate-900" : "bg-slate-50/50 dark:bg-slate-800/50"
                    )}
                  >
                    <td className="px-2 py-1 text-slate-700 dark:text-slate-200">
                      {cp.name.replace(/_/g, " ")}
                    </td>
                    <td className="px-2 py-1 text-right tabular-nums text-slate-600 dark:text-slate-300">
                      {formatMs(cp.duration_ms)}
                    </td>
                    <td className="px-2 py-1 text-right tabular-nums text-slate-500 dark:text-slate-400">
                      {formatPercentage(cp.duration_ms, timing.total_ms)}
                    </td>
                    <td className="px-2 py-1">
                      <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-700">
                        <div
                          className="h-full rounded-full bg-sky-500 dark:bg-sky-400"
                          style={{ width: `${Math.min(pct, 100)}%` }}
                        />
                      </div>
                    </td>
                  </tr>
                );
              })}
              {/* Total row */}
              <tr className="border-t border-slate-200 bg-slate-100 font-medium dark:border-slate-700 dark:bg-slate-800">
                <td className="px-2 py-1.5 text-slate-700 dark:text-slate-200">Total</td>
                <td className="px-2 py-1.5 text-right tabular-nums text-slate-700 dark:text-slate-200">
                  {formatMs(timing.total_ms)}
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums text-slate-600 dark:text-slate-300">
                  100%
                </td>
                <td />
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
