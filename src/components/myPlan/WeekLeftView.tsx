import { useRef, useState } from "react";
import { cx } from "../../lib/classNames";
import {
  MINUTES_PER_DAY,
  isoWeekNumber,
  minutesToPx,
  segmentBox,
  type PlanDay,
} from "../../lib/myPlan";
import AbsenceBand from "./AbsenceBand";
import AgendaList from "./AgendaList";
import NowLine from "./NowLine";
import ShiftBlock from "./ShiftBlock";
import TimeAxis, { HourLines } from "./TimeAxis";
import { DateCellLeft, DayTotal } from "./dayCells";
import { OUTSIDE_LABEL_MIN_FREE_PX, freeBefore } from "./dayLanes";
import { handleBlockArrowKeys } from "./gridKeys";
import type { PlanViewProps } from "./types";
import { useElementWidth } from "./useElementWidth";
import {
  WithAvatars,
  blockColorsOf,
  dayGroundClass,
  dayTintStyle,
  restAfterCaption,
  tintOfLocation,
} from "./viewParts";
import { HOURS_RULE_HINT, TEXT_3 } from "./planChrome";

// Week · date on left (SPEC E2): days are 72 px rows, time runs right over
// 0–24 h on the available width; columns 136 px date | track | 80 px total.
// On mobile the week renders as the agenda list instead (SPEC E10).

const COLUMNS = { gridTemplateColumns: "136px minmax(0, 1fr) 80px" };

export default function WeekLeftView(props: PlanViewProps) {
  if (props.isMobile) return <AgendaList {...props} />;
  return <WeekLeftGrid {...props} />;
}

function WeekLeftGrid(props: PlanViewProps) {
  const { days } = props;
  const axisRef = useRef<HTMLDivElement>(null);
  const trackWidth = useElementWidth(axisRef, 1008);
  const pxPerHour = trackWidth / 24;
  const [hovered, setHovered] = useState<string | null>(null);
  const week = days.length > 0 ? isoWeekNumber(days[0].date) : null;

  return (
    <div
      role="group"
      aria-label="Week, days stacked"
      className="w-full text-slate-900 dark:text-slate-100"
      onKeyDown={(event) => handleBlockArrowKeys(event, "left")}
    >
      <div
        className="grid h-8 border-b border-slate-300 bg-slate-50 dark:border-slate-600 dark:bg-[#131C2E]"
        style={COLUMNS}
      >
        <div className={cx("flex items-center pl-4 text-[11px] font-semibold", TEXT_3)}>
          {week !== null ? `Week ${week}` : null}
        </div>
        <div ref={axisRef} className="relative min-w-0 border-l border-slate-200 dark:border-slate-700">
          <TimeAxis
            axis="horizontal"
            windowStartMin={0}
            windowEndMin={MINUTES_PER_DAY}
            pxPerHour={pxPerHour}
            nowMin={days.some((day) => day.isToday) ? props.nowMin : null}
          />
        </div>
        <div
          className={cx("flex items-center justify-end border-l border-slate-200 pr-4 text-[11px] font-semibold dark:border-slate-700", TEXT_3)}
          title={`Hours per day. ${HOURS_RULE_HINT}`}
        >
          Hours
        </div>
      </div>
      {days.map((day, index) => (
        <div
          key={day.dateISO}
          className="grid h-[72px] border-b border-slate-200 dark:border-slate-700"
          style={COLUMNS}
        >
          <DateCellLeft day={day} locationsById={props.locationsById} />
          <DayTrack
            {...props}
            day={day}
            index={index}
            pxPerHour={pxPerHour}
            hovered={hovered}
            onHoverChange={setHovered}
          />
          <div className="flex items-center justify-end border-l border-slate-200 pr-4 dark:border-slate-700">
            <DayTotal day={day} plan={props.plan} isMobile={false} emphasis />
          </div>
        </div>
      ))}
    </div>
  );
}

type DayTrackProps = PlanViewProps & {
  day: PlanDay;
  index: number;
  pxPerHour: number;
  hovered: string | null;
  onHoverChange: (shiftId: string | null) => void;
};

function DayTrack(props: DayTrackProps) {
  const { day, index, plan, pxPerHour, isDark, days, selectedShiftId, onSelectShift } = props;
  const toPx = (min: number) => minutesToPx(min, 0, pxPerHour);
  const visible = new Set(days.map((item) => item.dateISO));
  const twoLocations = day.startLocationIds.length > 1;

  return (
    <div
      className={cx("relative min-w-0 border-l border-slate-200 dark:border-slate-700", dayGroundClass(day))}
      style={dayTintStyle(day, isDark, "horizontal")}
    >
      <HourLines axis="horizontal" windowStartMin={0} windowEndMin={MINUTES_PER_DAY} pxPerHour={pxPerHour} />
      {day.absences.map((absence) =>
        absence.kind === "vacation" ? (
          <AbsenceBand
            key={`vacation-${absence.dateISO}`}
            absence={absence}
            layout="row"
            isDark={isDark}
            style={{ left: 1, right: 1, top: 10, bottom: 10, paddingLeft: Math.max(3, toPx(8 * 60)) }}
          />
        ) : (
          <AbsenceBand
            key={`rest-${absence.dateISO}`}
            absence={absence}
            layout="row"
            isDark={isDark}
            flatEnd
            detail={restAfterCaption(plan, day)}
            style={{ left: toPx(absence.startMin) + 1, right: 0, top: 10, bottom: 10 }}
          />
        ),
      )}
      {day.segments.map((segment) => {
        const shift = plan.shifts.get(segment.shiftId);
        if (!shift) return null;
        const box = segmentBox(segment, day.segments, {
          windowStartMin: 0,
          windowEndMin: MINUTES_PER_DAY,
          pxPerHour,
          minPx: 1,
        });
        // SPEC C5.6: ≥ 300 px wide blocks show the same-duty avatars on the right.
        const people = props.sameDutyByShift?.get(shift.id);
        const colors = blockColorsOf(shift, isDark);
        const withFooter =
          people && box.sizePx >= 300 && segment.lanes === 1 && !segment.cutStart ? (
            <WithAvatars people={people} ring={colors.fill} color={colors.secondaryText} isDark={isDark} />
          ) : undefined;
        return (
          <ShiftBlock
            key={segment.key}
            shift={shift}
            segment={segment}
            axis="horizontal"
            offsetPx={box.offsetPx}
            sizePx={box.sizePx}
            footer={withFooter}
            crossInsetPx={10}
            selected={selectedShiftId === shift.id}
            isDark={isDark}
            hovered={props.hovered === shift.id}
            onHoverChange={props.onHoverChange}
            onSelect={onSelectShift}
            focusable={!segment.cutStart || !visible.has(shift.dateISO)}
            showLocation={twoLocations}
            locationTint={tintOfLocation(props.locationsById, shift.locationId)}
            outsideLabel={freeBefore(segment, day.segments, toPx) >= OUTSIDE_LABEL_MIN_FREE_PX}
            navCol={index}
          />
        );
      })}
      {day.isToday ? <NowLine axis="horizontal" offsetPx={toPx(props.nowMin)} /> : null}
    </div>
  );
}
