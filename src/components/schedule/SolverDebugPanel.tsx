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

export default function SolverDebugPanel({ debugInfo }: SolverDebugPanelProps) {
  const { timing, solution_times, num_variables, num_days, num_slots, solver_status, cpu_workers_used, cpu_cores_available, sub_scores } = debugInfo;

  return (
    <div className="flex flex-col gap-4">
      {/* Summary stats. Agent runs don't report the CP-SAT-only numbers
          (variables, CPU workers) — render those rows only when present. */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        <div className="text-slate-500 dark:text-slate-400">Status</div>
        <div className="font-medium text-slate-700 dark:text-slate-200">{solver_status}</div>
        {num_variables !== undefined && (
          <>
            <div className="text-slate-500 dark:text-slate-400">Variables</div>
            <div className="font-medium text-slate-700 dark:text-slate-200">{num_variables.toLocaleString()}</div>
          </>
        )}
        <div className="text-slate-500 dark:text-slate-400">Days</div>
        <div className="font-medium text-slate-700 dark:text-slate-200">{num_days}</div>
        <div className="text-slate-500 dark:text-slate-400">Slots</div>
        <div className="font-medium text-slate-700 dark:text-slate-200">{num_slots}</div>
        <div className="text-slate-500 dark:text-slate-400">Solutions found</div>
        <div className="font-medium text-slate-700 dark:text-slate-200">{solution_times?.length ?? 0}</div>
        {cpu_workers_used !== undefined && cpu_cores_available !== undefined && (
          <>
            <div className="text-slate-500 dark:text-slate-400">CPU cores</div>
            <div className="font-medium text-slate-700 dark:text-slate-200">{cpu_workers_used} / {cpu_cores_available}</div>
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

      {/* Timing breakdown table. Agent runs report only the total — show a
          single line instead of the per-phase table. */}
      {!timing.checkpoints?.length ? (
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
          <div className="text-slate-500 dark:text-slate-400">Total runtime</div>
          <div className="font-medium text-slate-700 dark:text-slate-200">
            {formatMs(timing.total_ms)}
          </div>
        </div>
      ) : (
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
      )}
    </div>
  );
}
