import { useState, type CSSProperties } from "react";
import { cx } from "../../lib/classNames";
import {
  countedHours,
  formatDayLabel,
  formatHours,
  formatShiftTimeRange,
  formatTime,
  formatWeekday,
  type PersonPlan,
  type PlanDay,
  type PlanSegment,
  type PlanShift,
} from "../../lib/myPlan";
import { restBandStyle, vacationBandStyle } from "./absenceStyles";
import { shiftAriaLabel } from "./ShiftBlock";
import type { PlanViewProps } from "./types";
import PlanIcon from "./PlanIcons";
import {
  blockColorsOf,
  dayGroundClass,
  dayHeadClass,
  DayNumber,
  tintOfLocation,
  tintStyle,
  LocationChips,
  LocationTag,
  shortLocationName,
  showsFree,
} from "./viewParts";
import {
  continuationTimeText,
  dayPct as pct,
  formatLongDay,
  MICRO_LABEL,
  TEXT_1,
  TEXT_2,
  TEXT_3,
} from "./planChrome";

// Mobile week · date on left (SPEC E10): one row per day with a 0–24 h
// mini timeline and the day's entries. Days before today collapse into one
// row ("Mon 12 – Tue 13 · 17.5 h") that expands on tap.

export default function AgendaList(props: PlanViewProps) {
  const { days, plan } = props;
  const todayIndex = days.findIndex((day) => day.isToday);
  const [showPast, setShowPast] = useState(false);
  const past = todayIndex > 0 ? days.slice(0, todayIndex) : [];
  const shown = showPast || past.length === 0 ? days : days.slice(todayIndex);
  const pastHours = past.reduce((sum, day) => sum + (day.hours ?? 0), 0);

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
      <div aria-hidden="true" className="grid h-6 border-b border-slate-200 dark:border-slate-700" style={{ gridTemplateColumns: "52px minmax(0, 1fr)" }}>
        <span />
        <span className="relative mx-3">
          {[0, 6, 12, 18, 24].map((hour) => (
            <span
              key={hour}
              className={cx("absolute top-1/2 -translate-y-1/2 text-[11px] tabular-nums", TEXT_3)}
              style={{
                left: `${(hour / 24) * 100}%`,
                transform: `translate(${hour === 0 ? "0" : hour === 24 ? "-100%" : "-50%"}, -50%)`,
              }}
            >
              {hour}
            </span>
          ))}
        </span>
      </div>
      {past.length > 0 ? (
        <button
          type="button"
          aria-expanded={showPast}
          onClick={() => setShowPast((value) => !value)}
          className="flex h-12 w-full items-center gap-1 px-3 text-left text-[13px] hover:bg-slate-50 dark:hover:bg-slate-800"
        >
          <span className={cx("font-semibold", TEXT_1)}>
            {past.length === 1
              ? formatDayLabel(past[0].dateISO)
              : `${formatDayLabel(past[0].dateISO)} – ${formatDayLabel(past[past.length - 1].dateISO)}`}
          </span>
          <span className={cx("tabular-nums", TEXT_2)}>· {formatHours(pastHours)}</span>
          <PlanIcon name="chevronDown" size={16} className={cx("ml-auto transition-transform", TEXT_3, showPast && "rotate-180")} />
        </button>
      ) : null}
      {shown.map((day) => (
        <AgendaDay key={day.dateISO} {...props} day={day} plan={plan} />
      ))}
    </div>
  );
}

function AgendaDay(props: PlanViewProps & { day: PlanDay; plan: PersonPlan }) {
  const { day, plan, isDark, selectedShiftId, onSelectShift, nowMin } = props;
  const shifts = day.segments
    .map((segment) => ({ segment, shift: plan.shifts.get(segment.shiftId) }))
    .filter((item): item is { segment: PlanSegment; shift: PlanShift } => !!item.shift);
  const running = day.isToday && day.segments.some((s) => s.startMin <= nowMin && nowMin < s.endMin);
  const nextStart = day.isToday
    ? day.segments.filter((s) => s.startMin > nowMin).map((s) => s.startMin).sort((a, b) => a - b)[0]
    : undefined;

  return (
    <div
      className="grid border-t border-slate-200 dark:border-slate-700"
      style={{ gridTemplateColumns: "52px minmax(0, 1fr)" }}
      aria-current={day.isToday ? "date" : undefined}
    >
      <div
        className={cx("flex flex-col items-center gap-0.5 py-2.5", dayHeadClass(day))}
        title={day.holidayName ? `${formatLongDay(day.date)} · ${day.holidayName}` : formatLongDay(day.date)}
      >
        <span className={cx(MICRO_LABEL, TEXT_3)}>{formatWeekday(day.dateISO)}</span>
        <DayNumber day={day} size="lg" />
        <LocationChips ids={day.startLocationIds} locationsById={props.locationsById} size="mini" wrap />
        {day.holidayName ? <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-purple-800 dark:bg-purple-200" /> : null}
      </div>
      <div
        className={cx("flex min-w-0 flex-col gap-2 px-3 py-2.5", dayGroundClass(day))}
        style={tintStyle(day.tint, isDark)}
      >
        <MiniTimeline day={day} shifts={shifts} isDark={isDark} nowMin={nowMin} />
        {day.holidayName ? (
          <span className="text-[13px] text-purple-800 dark:text-purple-200">{day.holidayName}</span>
        ) : null}
        {day.isToday && !running ? (
          <span className={cx("flex items-center gap-1.5 text-[13px] tabular-nums", TEXT_3)}>
            <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-slate-900 dark:bg-slate-50" />
            Now {formatTime(nowMin)}
            {nextStart !== undefined ? ` · free until ${formatTime(nextStart)}` : ""}
          </span>
        ) : null}
        {shifts.map(({ segment, shift }) => (
          <AgendaEntry
            key={segment.key}
            segment={segment}
            shift={shift}
            selected={selectedShiftId === shift.id}
            onSelect={onSelectShift}
            isDark={isDark}
            locationTint={tintOfLocation(props.locationsById, shift.locationId)}
          />
        ))}
        {day.absences.map((absence) => (
          <span key={absence.kind} className={cx("flex min-h-[22px] items-center gap-2 text-[15px] leading-5", TEXT_1)}>
            {absence.kind === "rest" ? <PlanIcon name="rest" size={14} className={TEXT_3} /> : <PlanIcon name="suitcase" size={14} className="text-green-700 dark:text-green-400" />}
            <span className="truncate font-semibold">{absence.label}</span>
            {absence.startMin > 0 ? (
              <span className={cx("text-[13px] tabular-nums", TEXT_2)}>from {formatTime(absence.startMin)}</span>
            ) : null}
          </span>
        ))}
        {showsFree(day) ? <span className={cx("text-[15px] leading-5", TEXT_3)}>free</span> : null}
      </div>
    </div>
  );
}

function AgendaEntry({
  segment,
  shift,
  selected,
  onSelect,
  isDark,
  locationTint,
}: {
  segment: PlanSegment;
  shift: PlanShift;
  selected: boolean;
  onSelect: PlanViewProps["onSelectShift"];
  isDark: boolean;
  locationTint: ReturnType<typeof tintOfLocation>;
}) {
  const continuation = segment.cutStart && segment.dateISO !== shift.dateISO;
  const time = continuation ? continuationTimeText(shift) : formatShiftTimeRange(shift);
  const colors = blockColorsOf(shift, isDark);
  return (
    <button
      type="button"
      data-shift-id={shift.id}
      aria-label={shiftAriaLabel(shift)}
      aria-haspopup="dialog"
      aria-expanded={selected}
      onClick={(event) => onSelect(selected ? null : shift.id, selected ? null : event.currentTarget)}
      className={cx(
        "-mx-1.5 flex min-h-[36px] min-w-0 items-center gap-2 rounded-lg px-1.5 py-1 text-left",
        "hover:bg-slate-900/5 dark:hover:bg-white/10",
        // focus-visible:* keeps the selection outline while focused (the global focus style drops outlines).
        selected &&
          "outline outline-2 outline-offset-0 outline-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-slate-900 dark:outline-white dark:focus-visible:outline-white",
      )}
    >
      {continuation ? (
        <PlanIcon name="continue" size={12} className={TEXT_2} />
      ) : shift.kind === "duty" ? (
        <PlanIcon name="moon" size={12} className={TEXT_2} />
      ) : (
        <span
          aria-hidden="true"
          className="h-2.5 w-2.5 shrink-0 rounded-[3px]"
          style={{
            backgroundColor: colors.fill,
            border: `1px ${shift.published ? "solid" : "dashed"} ${colors.border}`,
          }}
        />
      )}
      <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
        <span className={cx("min-w-0 max-w-full truncate text-[15px] font-semibold leading-5", TEXT_1)}>{shift.title}</span>
        <span className={cx("min-w-0 max-w-full truncate text-[13px] leading-[18px] tabular-nums", TEXT_2)}>{time}</span>
      </span>
      <span className="shrink-0">
        {continuation && shift.locationName ? (
          <LocationTag name={shortLocationName(shift.locationName)} tint={locationTint} />
        ) : !continuation ? (
          <CountedHours shift={shift} />
        ) : null}
      </span>
    </button>
  );
}

/**
 * Hours the entry adds to the day and week totals (SPEC R4): time inside a
 * longer own shift counts there, so a meeting during a night shows "–".
 */
function CountedHours({ shift }: { shift: PlanShift }) {
  const counted = countedHours(shift);
  const partial = counted < shift.hours;
  return (
    <span
      className={cx("text-[13px] tabular-nums", TEXT_3)}
      title={partial ? `${formatHours(shift.hours)} long; the overlap with a longer shift counts there` : undefined}
    >
      {counted > 0 ? formatHours(counted) : "–"}
    </span>
  );
}

function MiniTimeline({
  day,
  shifts,
  isDark,
  nowMin,
}: {
  day: PlanDay;
  shifts: Array<{ segment: PlanSegment; shift: PlanShift }>;
  isDark: boolean;
  nowMin: number;
}) {
  return (
    <div aria-hidden="true" className="relative h-3">
      {[6, 12, 18].map((hour) => (
        <span key={hour} className="absolute top-0 h-3 w-px bg-slate-300 dark:bg-slate-600" style={{ left: pct(hour * 60) }} />
      ))}
      {day.absences.map((absence) => {
        const style: CSSProperties =
          absence.kind === "vacation" ? vacationBandStyle(isDark) : restBandStyle(isDark, 1);
        return (
          <span
            key={absence.kind}
            className="absolute top-0 h-3 rounded-[3px]"
            style={{ ...style, left: pct(absence.startMin), right: 0 }}
          />
        );
      })}
      {shifts.map(({ segment, shift }) => {
        const colors = blockColorsOf(shift, isDark);
        // Overlapping segments (two lanes) take half the height each.
        const half = segment.lanes === 2;
        return (
          <span
            key={segment.key}
            className="absolute"
            style={{
              top: half && segment.lane === 1 ? 6 : 0,
              height: half ? 6 : 12,
              left: pct(segment.startMin),
              width: `max(3px, calc(${pct(segment.endMin)} - ${pct(segment.startMin)}))`,
              backgroundColor: colors.fill,
              border: `1px ${shift.published ? "solid" : "dashed"} ${colors.border}`,
              borderRadius: `${segment.cutStart ? 0 : 3}px ${segment.cutEnd ? 0 : 3}px ${segment.cutEnd ? 0 : 3}px ${segment.cutStart ? 0 : 3}px`,
            }}
          />
        );
      })}
      {day.isToday ? (
        <span className="absolute -top-0.5 h-4 w-0.5 bg-slate-900 dark:bg-slate-50" style={{ left: `calc(${pct(nowMin)} - 1px)` }} />
      ) : null}
    </div>
  );
}
