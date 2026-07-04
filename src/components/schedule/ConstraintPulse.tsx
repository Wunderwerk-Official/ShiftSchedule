import { useAnimatedNumber } from "../../lib/useAnimatedNumber";

// Compact live view of constraint fulfilment during a solve, shown in the
// main SolverOverlay for every solver mode. The same numbers previously only
// existed behind the "Details" dashboard; here they update in place with
// gentle motion as new solutions stream in.

export type ConstraintPulseStats = {
  filledSlots: number;
  totalRequiredSlots: number;
  nonConsecutiveShifts: number;
  locationChanges: number;
  onCallRestViolations: number;
  peopleWeeksWithinHours: number;
  totalPeopleWeeksWithTarget: number;
  sectionPreferenceMatches: number;
  totalClassAssignments: number;
  timeWindowFits: number;
  totalAssignmentsWithTimeWindows: number;
};

function CheckIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} className={className} aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
    </svg>
  );
}

/** A constraint chip: green check when clean, count when violated. Hard
 * constraints show rose, soft targets (tone="warn") amber — being under
 * contract hours is a balancing goal, not a rule break. Re-keyed on state
 * flips so the pop animation replays exactly then. */
function ConstraintChip({ ok, okLabel, badLabel, value, tone = "hard" }: {
  ok: boolean;
  okLabel: string;
  badLabel: string;
  value: number;
  tone?: "hard" | "warn";
}) {
  const badClasses =
    tone === "warn"
      ? "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-300"
      : "border-rose-200 bg-rose-50 text-rose-600 dark:border-rose-900 dark:bg-rose-950/60 dark:text-rose-300";
  return (
    <span
      key={ok ? "ok" : `bad-${value}`}
      className={`solver-pop inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium ${
        ok
          ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-300"
          : badClasses
      }`}
    >
      {ok ? (
        <CheckIcon className="h-2.5 w-2.5" />
      ) : (
        <span className="tabular-nums font-semibold">{value}</span>
      )}
      {ok ? okLabel : badLabel}
    </span>
  );
}

/** Soft-criterion chip (informational, never "red"). */
function SoftChip({ label, value, max }: { label: string; value: number; max: number }) {
  const display = useAnimatedNumber(value);
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-violet-200 bg-violet-50 px-2.5 py-1 text-[11px] font-medium text-violet-600 dark:border-violet-900 dark:bg-violet-950/60 dark:text-violet-300">
      <span className="tabular-nums font-semibold">
        {display}/{max}
      </span>
      {label}
    </span>
  );
}

export default function ConstraintPulse({
  stats,
  onCallRestEnabled,
}: {
  stats: ConstraintPulseStats;
  onCallRestEnabled: boolean;
}) {
  const filled = useAnimatedNumber(stats.filledSlots);
  const coveragePct =
    stats.totalRequiredSlots > 0
      ? Math.min(1, stats.filledSlots / stats.totalRequiredSlots)
      : 1;
  const fullyCovered = stats.totalRequiredSlots > 0 && stats.filledSlots >= stats.totalRequiredSlots;

  return (
    <div className="flex w-full max-w-xl flex-col gap-2">
      {stats.totalRequiredSlots > 0 && (
        <div className="flex items-center gap-3">
          <span className="shrink-0 text-[11px] font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500">
            Coverage
          </span>
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
            <div
              className={`solver-bar-fill h-full rounded-full ${
                fullyCovered
                  ? "bg-gradient-to-r from-emerald-400 to-teal-400"
                  : "bg-gradient-to-r from-sky-400 to-indigo-400"
              }`}
              style={{ width: `${Math.round(coveragePct * 100)}%` }}
            />
          </div>
          <span className="shrink-0 text-xs font-semibold tabular-nums text-slate-600 dark:text-slate-300">
            {filled}/{stats.totalRequiredSlots}
            {fullyCovered && (
              <span key="covered" className="solver-pop ml-1 inline-block text-emerald-500">
                ✓
              </span>
            )}
          </span>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-center gap-1.5">
        <ConstraintChip
          ok={stats.nonConsecutiveShifts === 0}
          okLabel="Continuous shifts"
          badLabel={`split shift${stats.nonConsecutiveShifts === 1 ? "" : "s"}`}
          value={stats.nonConsecutiveShifts}
        />
        <ConstraintChip
          ok={stats.locationChanges === 0}
          okLabel="One location/day"
          badLabel={`location switch${stats.locationChanges === 1 ? "" : "es"}`}
          value={stats.locationChanges}
        />
        {onCallRestEnabled && (
          <ConstraintChip
            ok={stats.onCallRestViolations === 0}
            okLabel="On-call rest kept"
            badLabel={`rest violation${stats.onCallRestViolations === 1 ? "" : "s"}`}
            value={stats.onCallRestViolations}
          />
        )}
        {stats.totalPeopleWeeksWithTarget > 0 && (
          <ConstraintChip
            ok={stats.peopleWeeksWithinHours >= stats.totalPeopleWeeksWithTarget}
            okLabel="Hours in range"
            badLabel={`of ${stats.totalPeopleWeeksWithTarget} weeks off target hours`}
            value={stats.totalPeopleWeeksWithTarget - stats.peopleWeeksWithinHours}
            tone="warn"
          />
        )}
        {stats.totalClassAssignments > 0 && stats.sectionPreferenceMatches > 0 && (
          <SoftChip
            label="preferred sections"
            value={stats.sectionPreferenceMatches}
            max={stats.totalClassAssignments}
          />
        )}
        {stats.totalAssignmentsWithTimeWindows > 0 && (
          <SoftChip
            label="time windows"
            value={stats.timeWindowFits}
            max={stats.totalAssignmentsWithTimeWindows}
          />
        )}
      </div>
    </div>
  );
}
