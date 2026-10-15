import type { CSSProperties } from "react";
import type { Location } from "../../api/client";
import { cx } from "../../lib/classNames";
import {
  absenceRuns,
  dayDiff,
  deriveAbsenceShortLabel,
  formatHours,
  formatTime,
  formatWeekdayTime,
  isSameMonth,
  isoWeekNumber,
  type PersonPlan,
  type PlanAbsence,
  type PlanDay,
  type PlanSegment,
  type PlanShift,
} from "../../lib/myPlan";
import { restBandStyle } from "./absenceStyles";
import { formatDayMonth } from "./planChrome";
import { blockColorsOf, tintStyle } from "./viewParts";

// Building blocks shared by the month calendar, the month list and the day
// popover: per-day entries (shift segments + rest band), entry chips and
// vacation runs split per week.

export type DayEntry =
  | { kind: "shift"; key: string; shift: PlanShift; segment: PlanSegment; title: string; time: string }
  | { kind: "rest"; key: string; absence: PlanAbsence; title: string; time: string };

/**
 * Name shown for a segment: "full" = title, "short" = compactLabel (≤ 5,
 * phone chips), "chip" = title when it fits a month cell next to the
 * time(s), else shortLabel (continuations always short: "↳ Nacht until 08:00").
 */
export type EntryLabelMode = "full" | "chip" | "short";

function entryName(shift: PlanShift, segment: PlanSegment, mode: EntryLabelMode): string {
  if (mode === "full") return shift.title;
  if (mode === "short") return shift.compactLabel;
  if (segment.cutStart) return shift.shortLabel;
  return shift.title.length <= (segment.cutEnd ? 12 : 8) ? shift.title : shift.shortLabel;
}

/** Shift segments (split nights: "↳ Title" / "17:00 →") and the rest band of a day. */
export function dayEntries(plan: PersonPlan, day: PlanDay, mode: EntryLabelMode = "full"): DayEntry[] {
  const entries: DayEntry[] = [];
  for (const segment of day.segments) {
    const shift = plan.shifts.get(segment.shiftId);
    if (!shift) continue;
    const name = entryName(shift, segment, mode);
    let title = name;
    let time = `${formatTime(shift.startMin)}–${formatTime(shift.endMin)}`;
    if (segment.cutStart) {
      // Phone chips (≈ 40 px of text) keep "↳Nacht" whole without the space.
      title = mode === "short" ? `↳${name}` : `↳ ${name}`;
      time = segment.cutEnd
        ? `until ${formatWeekdayTime(shift.dateISO, shift.endMin)}`
        : `until ${formatTime(shift.endMin)}`;
    } else if (segment.cutEnd) {
      time = `${formatTime(shift.startMin)} →`;
    }
    entries.push({ kind: "shift", key: segment.key, shift, segment, title, time });
  }
  for (const absence of day.absences) {
    if (absence.kind !== "rest") continue;
    entries.push({
      kind: "rest",
      key: `rest@${absence.dateISO}`,
      absence,
      title: mode === "short" ? deriveAbsenceShortLabel(absence.label) : absence.label,
      time: absence.startMin > 0 ? `from ${formatTime(absence.startMin)}` : "all day",
    });
  }
  return entries;
}

/** Inline style of an entry chip/bar (section/duty colors for the theme; rest = dashed band). */
export function entryStyle(entry: DayEntry, isDark: boolean): CSSProperties {
  if (entry.kind === "rest") return restBandStyle(isDark);
  const { published } = entry.shift;
  const colors = blockColorsOf(entry.shift, isDark);
  return {
    backgroundColor: colors.fill,
    border: `1px ${published ? "solid" : "dashed"} ${colors.border}`,
    color: colors.text,
  };
}

/** Rounded corners except at a midnight cut (split night = flat edge). */
export function entryRadiusClass(entry: DayEntry, radius = "rounded-md"): string {
  if (entry.kind !== "shift") return radius;
  return cx(
    radius,
    entry.segment.cutStart && "rounded-l-none",
    entry.segment.cutEnd && "rounded-r-none",
  );
}

type EntryChipProps = { entry: DayEntry; isDark: boolean; compact?: boolean };

/** Month chip "MRT 08:00–16:30" (compact: short label only). */
export function EntryChip({ entry, isDark, compact = false }: EntryChipProps) {
  return (
    <span
      className={cx(
        "flex min-w-0 items-center gap-1 overflow-hidden whitespace-nowrap tabular-nums",
        // Phone cells are ≈ 53 px: 10 px tight text keeps "Mamma" / "↳Nacht" whole.
        compact ? "h-4 px-px text-[10px] font-semibold tracking-tight" : "h-[22px] px-1.5 text-[11px]",
        entryRadiusClass(entry, compact ? "rounded" : "rounded-md"),
      )}
      style={entryStyle(entry, isDark)}
    >
      <span className={cx("truncate", !compact && "font-semibold")}>{entry.title}</span>
      {compact ? null : <span className="truncate">{entry.time}</span>}
    </span>
  );
}

/** Body ground of a day: the location tint where a shift starts; undefined = neutral. */
export function dayGroundStyle(day: PlanDay, isDark: boolean): CSSProperties | undefined {
  return day.tint ? tintStyle(day.tint, isDark) : undefined;
}

export type VacationSegment = {
  key: string;
  /** Column index 0..6 within the week. */
  startIndex: number;
  endIndex: number;
  label: string;
};

/** "19–23 Oct" / "28 Sep – 2 Oct". */
export function formatDateSpan(startISO: string, endISO: string): string {
  if (startISO === endISO) return formatDayMonth(startISO);
  const [start, end] = [formatDayMonth(startISO), formatDayMonth(endISO)];
  const [startDay, startMonth] = start.split(" ");
  const endMonth = end.split(" ")[1];
  return startMonth === endMonth ? `${startDay}–${end}` : `${start} – ${end}`;
}

/** Vacation runs over all sheet days, cut into per-week bars that keep the full-run label. */
export function vacationSegments(allDays: PlanDay[], weekDays: PlanDay[]): VacationSegment[] {
  if (weekDays.length === 0) return [];
  const weekStart = weekDays[0].dateISO;
  const weekEnd = weekDays[weekDays.length - 1].dateISO;
  return absenceRuns(allDays, "vacation")
    .filter((run) => run.endISO >= weekStart && run.startISO <= weekEnd)
    .map((run) => {
      const label =
        allDays.find((day) => day.dateISO === run.startISO)?.absences.find((a) => a.kind === "vacation")
          ?.label ?? "Vacation";
      return {
        key: `${run.startISO}:${weekStart}`,
        startIndex: Math.max(0, dayDiff(weekStart, run.startISO)),
        endIndex: Math.min(weekDays.length - 1, dayDiff(weekStart, run.endISO)),
        label: `${label} · ${formatDateSpan(run.startISO, run.endISO)} (${run.days} ${run.days === 1 ? "day" : "days"})`,
      };
    });
}

/** Accessible summary of a day ("Night duty 17:00 →; Rest day from 08:00; Klinikum Mitte"). */
export function dayAriaSummary(plan: PersonPlan, day: PlanDay, locationsById?: Map<string, Location>): string {
  const parts = dayEntries(plan, day).map((entry) => `${entry.title.replace(/^↳\s?/, "")} ${entry.time}`);
  if (day.absences.some((absence) => absence.kind === "vacation")) parts.unshift("Vacation");
  if (day.holidayName) parts.unshift(day.holidayName);
  if (locationsById && day.startLocationIds.length > 0) {
    parts.push(day.startLocationIds.map((id) => locationsById.get(id)?.name ?? id).join(", "));
  }
  if (parts.length > 0) return parts.join("; ");
  return day.published ? "free" : "not published";
}

export type MonthWeekGroup = {
  mondayISO: string;
  weekNumber: number;
  /** All 7 days of the ISO week (sums and vacation count use the whole week). */
  week: PlanDay[];
  /** Days of the week inside the month (the rows of the list). */
  days: PlanDay[];
  /** Unpublished week with shifts (planners see the "Draft" badge). */
  draft: boolean;
  /** "Week 40 · 28 Sep – 4 Oct". */
  label: string;
  vacationDays: number;
};

/** Sheet days grouped per ISO week, keeping only the month's days as rows. */
export function monthWeekGroups(sheetDays: PlanDay[], monthAnchor: Date): MonthWeekGroup[] {
  const groups: MonthWeekGroup[] = [];
  for (let i = 0; i < sheetDays.length; i += 7) {
    const week = sheetDays.slice(i, i + 7);
    const days = week.filter((day) => isSameMonth(day.date, monthAnchor));
    if (days.length === 0) continue;
    groups.push({
      mondayISO: week[0].dateISO,
      weekNumber: isoWeekNumber(week[0].date),
      week,
      days,
      draft: isDraftWeek(week),
      label: `Week ${isoWeekNumber(week[0].date)} · ${formatDateSpan(week[0].dateISO, week[week.length - 1].dateISO)}`,
      vacationDays: week.filter((day) => day.absences.some((absence) => absence.kind === "vacation")).length,
    });
  }
  return groups;
}

/** "Vacation" when a week has no hours but vacation days, else "53.0 h". */
export function weekTotalText(hours: number, vacationDays: number): { text: string; vacation: boolean } {
  if (hours === 0 && vacationDays > 0) return { text: "Vacation", vacation: true };
  return { text: formatHours(hours), vacation: false };
}

/** A week that is not published and has shifts to show ("Draft" badge). */
export function isDraftWeek(week: PlanDay[]): boolean {
  return week.some((day) => !day.published) && week.some((day) => day.segments.length > 0);
}
