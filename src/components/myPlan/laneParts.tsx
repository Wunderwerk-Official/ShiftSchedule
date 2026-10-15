import type { Location } from "../../api/client";
import { cx } from "../../lib/classNames";
import { formatHours, formatShiftTimeRange, personTone, type PlanShift } from "../../lib/myPlan";
import { isOwnerLane, laneDay, laneHours } from "./dayLanes";
import type { DayLane, SelectShift } from "./types";
import { Avatar, showsFree } from "./viewParts";
import { displayName, MICRO_LABEL, TEXT_1, TEXT_2, TEXT_3 } from "./planChrome";

// Lane headers, group labels and the mobile colleague list of the day views.

export const GROUP_LABELS: Record<DayLane["group"], string> = {
  me: "Me",
  sameDuty: "Same duty",
  sameTimeAtLocation: "Same time at location",
};

/** Location names of the shifts the lane starts that day, e.g. "Klinikum Mitte". */
export function laneLocationText(lane: DayLane, dateISO: string, locationsById: Map<string, Location>) {
  const day = laneDay(lane.plan, dateISO);
  return (day?.startLocationIds ?? [])
    .map((id) => locationsById.get(id)?.name ?? id)
    .join(" · ");
}

/** Parts of the second header line: ["15.0 h", "Klinikum Mitte"] / ["free"] / []; withHours=false drops the hours. */
function laneSubline(
  lane: DayLane,
  dateISO: string,
  locationsById: Map<string, Location>,
  withHours = true,
): string[] {
  const hours = laneHours(lane.plan, dateISO);
  const location = laneLocationText(lane, dateISO, locationsById);
  if (hours !== null || location) {
    return [withHours && hours !== null ? formatHours(hours) : "", location].filter(Boolean);
  }
  const day = laneDay(lane.plan, dateISO);
  return day && showsFree(day) ? ["free"] : [];
}

export function MeBadge() {
  return (
    <span className="inline-flex h-[18px] shrink-0 items-center rounded-full bg-slate-100 px-1.5 text-[11px] font-semibold text-slate-700 dark:bg-slate-800 dark:text-slate-200">
      Me
    </span>
  );
}

/**
 * Lane header (SPEC E4): avatar, name (truncated) + "Me" on line 1, "15.0 h ·
 * Klinikum Mitte" (truncated) on line 2. `dense` (colleague rows of day ·
 * left): small avatar, "Me" moves to line 2. `narrowCell` (the 136 px label
 * cell of day · left): the name may wrap onto two lines (ellipsis on the
 * second), "Me" moves to line 2, the hours are left to the Hours column and
 * the tooltip names everything.
 */
export function LaneHeader({
  lane,
  dateISO,
  locationsById,
  isDark,
  dense = false,
  narrowCell = false,
}: {
  lane: DayLane;
  dateISO: string;
  locationsById: Map<string, Location>;
  isDark: boolean;
  dense?: boolean;
  narrowCell?: boolean;
}) {
  const parts = laneSubline(lane, dateISO, locationsById, !narrowCell);
  const owner = isOwnerLane(lane);
  const badgeBelow = dense || narrowCell;
  const title = narrowCell ? [lane.name, ...laneSubline(lane, dateISO, locationsById)].join(" · ") : lane.name;
  return (
    <div className="flex min-w-0 items-center gap-2" title={title}>
      <Avatar name={lane.name} size={owner && !dense ? "m" : "s"} tone={personTone(lane.colorIndex, isDark)} />
      <span className="flex min-w-0 flex-col">
        <span className="flex min-w-0 items-center gap-1.5">
          <span
            className={cx(
              narrowCell ? "line-clamp-2 break-words" : "truncate",
              "font-semibold",
              // Colleague rows are 48 px: two 14 px name lines + the 18 px "Me" line fit.
              owner ? "text-[13px] leading-4" : narrowCell ? "text-xs leading-[14px]" : "text-xs",
              TEXT_1,
            )}
          >
            {displayName(lane.name)}
          </span>
          {lane.isMe && !badgeBelow ? <MeBadge /> : null}
        </span>
        <span className="flex min-w-0 items-center gap-1">
          {lane.isMe && badgeBelow ? <MeBadge /> : null}
          {parts.length > 0 ? (
            <span className={cx("truncate text-[11px] leading-[14px] tabular-nums", TEXT_3)}>{parts.join(" · ")}</span>
          ) : null}
        </span>
      </span>
    </div>
  );
}

/** Uppercase group label ("SAME DUTY"). */
export function GroupLabel({ children, className }: { children: string; className?: string }) {
  return <span className={cx(MICRO_LABEL, TEXT_3, "truncate", className)}>{children}</span>;
}

/** "+N more at location": a count only (no affordance); the team plan lists everyone. */
export function HiddenColleagues({ count, className }: { count: number; className?: string }) {
  if (count <= 0) return null;
  return <div className={cx("flex items-center text-[13px]", TEXT_2, className)}>+{count} more at location</div>;
}

export type LaneShiftEntry = { lane: DayLane; shift: PlanShift };

/** Mobile day · top: colleagues as a list below my lane (SPEC E12 "Working with you"). */
export function ColleagueList({
  entries,
  hiddenCount,
  selectedShiftId,
  onSelectShift,
  isDark,
}: {
  entries: LaneShiftEntry[];
  hiddenCount: number;
  selectedShiftId: string | null;
  onSelectShift: SelectShift;
  isDark: boolean;
}) {
  if (entries.length === 0 && hiddenCount <= 0) return null;
  const groups: Array<DayLane["group"]> = ["sameDuty", "sameTimeAtLocation"];
  return (
    <section
      aria-label="Working with you"
      className="overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900"
    >
      {groups.map((group) => {
        const items = entries.filter((entry) => entry.lane.group === group);
        if (items.length === 0) return null;
        return (
          <div key={group}>
            <div className="flex h-8 items-center px-4">
              <GroupLabel>{`${GROUP_LABELS[group]} (${items.length})`}</GroupLabel>
            </div>
            {items.map(({ lane, shift }) => {
              const selected = selectedShiftId === shift.id;
              return (
                <button
                  key={`${lane.clinicianId}-${shift.id}`}
                  type="button"
                  data-shift-id={shift.id}
                  aria-haspopup="dialog"
                  aria-expanded={selected}
                  onClick={(event) => onSelectShift(selected ? null : shift.id, selected ? null : event.currentTarget)}
                  className={cx(
                    "flex h-14 w-full items-center gap-3 border-t border-slate-100 px-4 text-left hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800",
                    selected && "bg-slate-50 dark:bg-slate-800",
                  )}
                >
                  <Avatar name={lane.name} size="l" tone={personTone(lane.colorIndex, isDark)} />
                  <span className="flex min-w-0 flex-col">
                    <span className={cx("truncate text-[15px] font-medium leading-5", TEXT_1)}>{displayName(lane.name)}</span>
                    <span className={cx("truncate text-[13px] leading-[18px]", TEXT_3)}>{shift.title}</span>
                  </span>
                  <span className={cx("ml-auto shrink-0 text-[13px] tabular-nums", TEXT_2)}>
                    {formatShiftTimeRange(shift)}
                  </span>
                </button>
              );
            })}
          </div>
        );
      })}
      <HiddenColleagues count={hiddenCount} className="h-12 border-t border-slate-100 px-4 dark:border-slate-800" />
    </section>
  );
}
