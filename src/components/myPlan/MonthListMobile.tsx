import type { CSSProperties, ReactNode } from "react";
import { cx } from "../../lib/classNames";
import {
  MINUTES_PER_DAY,
  formatHours,
  formatWeekday,
  type PersonPlan,
  type PlanDay,
} from "../../lib/myPlan";
import { vacationBandStyle, vacationColors } from "./absenceStyles";
import {
  dayAriaSummary,
  dayEntries,
  entryRadiusClass,
  entryStyle,
  monthWeekGroups,
  weekTotalText,
  type DayEntry,
} from "./monthParts";
import { dayPct, draftBadgeClass, formatLongDate } from "./planChrome";
import type { MonthViewProps } from "./types";
import { LocationChips, dayHeadTone, showsFree, tintStyle } from "./viewParts";

// Month · date on left on phones (SPEC E13 "Liste"): week headers with
// totals, one row per day with a mini timeline and a text line; consecutive
// free days and vacation days are merged into one row. Every row opens the
// day view (a merged row opens its first day).

type Item =
  | { kind: "day"; day: PlanDay }
  | { kind: "free" | "vacation"; days: PlanDay[] };

const isVacation = (day: PlanDay) => day.absences.some((absence) => absence.kind === "vacation");
const isPlainFree = (day: PlanDay) => showsFree(day) && !day.isToday && !day.holidayName;
const daysText = (count: number) => `${count} ${count === 1 ? "day" : "days"}`;

function groupItems(days: PlanDay[]): Item[] {
  const items: Item[] = [];
  for (const day of days) {
    const last = items[items.length - 1];
    const kind = isVacation(day) ? "vacation" : isPlainFree(day) ? "free" : null;
    if (kind && last && last.kind === kind) last.days.push(day);
    else if (kind) items.push({ kind, days: [day] });
    else items.push({ kind: "day", day });
  }
  // A single free day stays a normal row ("free").
  return items.map((item) => (item.kind === "free" && item.days.length === 1 ? { kind: "day", day: item.days[0] } : item));
}

function dayShort(day: PlanDay): string {
  return `${formatWeekday(day.dateISO)} ${String(day.date.getDate()).padStart(2, "0")}`;
}

export default function MonthListMobile(props: MonthViewProps) {
  const { plan, days, monthAnchor, weekHours, isDark, locationsById, nowMin, onOpenDay } = props;
  return (
    <div className="pb-2">
      {monthWeekGroups(days, monthAnchor).map((group) => {
        const total = weekTotalText(weekHours.get(group.mondayISO) ?? 0, group.vacationDays);
        return (
          <section key={group.mondayISO} aria-label={group.label}>
            <div className="flex h-9 items-center justify-between gap-2 border-t border-slate-200 bg-slate-50 px-4 text-xs font-semibold tabular-nums text-slate-700 dark:border-slate-700 dark:bg-slate-800/50 dark:text-slate-300">
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate">{group.label}</span>
                {group.draft ? <span className={draftBadgeClass}>Draft</span> : null}
              </span>
              <span
                className="shrink-0 text-slate-900 dark:text-slate-100"
                style={total.vacation ? { color: vacationColors(isDark).text } : undefined}
              >
                {total.vacation ? `Vacation · ${daysText(group.vacationDays)}` : total.text}
              </span>
            </div>
            {groupItems(group.days).map((item) => {
              if (item.kind === "day") {
                return (
                  <MobileDayRow
                    key={item.day.dateISO}
                    day={item.day}
                    plan={plan}
                    isDark={isDark}
                    nowMin={nowMin}
                    locationsById={locationsById}
                    onOpenDay={onOpenDay}
                  />
                );
              }
              return <MergedRow key={item.days[0].dateISO} item={item} isDark={isDark} onOpenDay={onOpenDay} />;
            })}
          </section>
        );
      })}
    </div>
  );
}

function MergedRow({
  item,
  isDark,
  onOpenDay,
}: {
  item: { kind: "free" | "vacation"; days: PlanDay[] };
  isDark: boolean;
  onOpenDay: (dateISO: string) => void;
}) {
  const first = item.days[0];
  const last = item.days[item.days.length - 1];
  const span = item.days.length > 1 ? `${dayShort(first)} – ${dayShort(last)}` : dayShort(first);
  const label =
    item.kind === "vacation"
      ? `${first.absences.find((absence) => absence.kind === "vacation")?.label ?? "Vacation"} (${daysText(item.days.length)})`
      : "free";
  const range =
    item.days.length > 1 ? `${formatLongDate(first.dateISO)} to ${formatLongDate(last.dateISO)}` : formatLongDate(first.dateISO);
  return (
    <button
      type="button"
      onClick={() => onOpenDay(first.dateISO)}
      aria-label={`${range}: ${label}. Open ${formatLongDate(first.dateISO)}`}
      className={cx(
        "flex w-full items-center gap-2 border-t border-slate-100 px-4 text-left text-[13px] dark:border-slate-800",
        item.kind === "vacation" ? "h-[52px] font-semibold" : "h-11 text-slate-600 dark:text-slate-400",
      )}
      style={item.kind === "vacation" ? vacationBandStyle(isDark) : undefined}
    >
      <span className="tabular-nums">{span}</span>
      <span aria-hidden="true">·</span>
      <span className="truncate">{label}</span>
    </button>
  );
}

type MobileDayRowProps = {
  day: PlanDay;
  plan: PersonPlan;
  isDark: boolean;
  nowMin: number;
  locationsById: MonthViewProps["locationsById"];
  onOpenDay: (dateISO: string) => void;
};

/** Mini-timeline mark of an entry: overlapping segments take half the height each. */
function markStyle(entry: DayEntry, isDark: boolean): CSSProperties {
  const start = entry.kind === "shift" ? entry.segment.startMin : entry.absence.startMin;
  const end = entry.kind === "shift" ? entry.segment.endMin : MINUTES_PER_DAY;
  const half = entry.kind === "shift" && entry.segment.lanes === 2;
  return {
    ...entryStyle(entry, isDark),
    left: dayPct(start),
    width: dayPct(Math.max(end - start, 15)),
    top: half && entry.segment.lane === 1 ? "50%" : 0,
    height: half ? "50%" : "100%",
  };
}

function MobileDayRow({ day, plan, isDark, nowMin, locationsById, onOpenDay }: MobileDayRowProps) {
  const entries = dayEntries(plan, day);
  let text: ReactNode = day.published ? "free" : "not published";
  if (entries.length === 1) {
    const [only] = entries;
    // The location only when it adds something ("MRT" at the "MRT" location: once).
    const location = only.kind === "shift" && only.shift.locationName !== only.shift.title ? only.shift.locationName : "";
    const where = location ? ` · ${location}` : "";
    text = `${only.title} ${only.time}${where}`;
  } else if (entries.length > 1) {
    // Several entries: every one by its short name ("↳ Nacht · Demos · ND-Frei").
    text = dayEntries(plan, day, "chip")
      .map((entry) => entry.title)
      .join(" · ");
  } else if (day.holidayName) {
    text = <span className="text-purple-800 dark:text-purple-200">{day.holidayName}</span>;
  }
  const tint = tintStyle(day.tint, isDark);
  return (
    <button
      type="button"
      onClick={() => onOpenDay(day.dateISO)}
      aria-label={`${formatLongDate(day.dateISO)}: ${dayAriaSummary(plan, day, locationsById)}. Open day`}
      aria-current={day.isToday ? "date" : undefined}
      className="flex h-[52px] w-full items-stretch border-t border-slate-100 text-left dark:border-slate-800"
    >
      <span
        className={cx(
          "flex w-[76px] shrink-0 flex-col justify-center gap-0.5 whitespace-nowrap pl-3",
          dayHeadTone(day),
        )}
      >
        <span
          className={cx(
            "self-start whitespace-nowrap text-[13px] font-semibold tabular-nums",
            day.isToday
              ? "rounded-full bg-slate-900 px-1 text-white dark:bg-white dark:text-slate-900"
              : "text-slate-900 dark:text-slate-100",
          )}
        >
          {dayShort(day)}
        </span>
        <LocationChips ids={day.startLocationIds} locationsById={locationsById} size="mini" className="pr-1" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col justify-center gap-1 px-3" style={tint}>
        <span
          aria-hidden="true"
          className="relative h-2.5 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800"
        >
          {entries.map((entry) => (
            <span
              key={entry.key}
              className={cx("absolute", entryRadiusClass(entry, "rounded-sm"))}
              style={markStyle(entry, isDark)}
            />
          ))}
          {day.isToday ? (
            <span className="absolute inset-y-0 w-0.5 bg-slate-900 dark:bg-white" style={{ left: dayPct(nowMin) }} />
          ) : null}
        </span>
        <span className="truncate text-[13px] tabular-nums text-slate-700 dark:text-slate-300">{text}</span>
      </span>
      <span
        className="flex w-14 shrink-0 items-center justify-end pr-3 text-xs tabular-nums text-slate-600 dark:text-slate-400"
        style={tint}
      >
        {day.hours != null ? formatHours(day.hours) : "–"}
      </span>
    </button>
  );
}
