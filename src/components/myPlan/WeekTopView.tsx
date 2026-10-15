import { useState } from "react";
import { cx } from "../../lib/classNames";
import {
  MINUTES_PER_DAY,
  absenceRuns,
  formatDayLabel,
  minutesToPx,
  segmentBox,
  type PlanDay,
} from "../../lib/myPlan";
import AbsenceBand from "./AbsenceBand";
import NowLine from "./NowLine";
import ShiftBlock from "./ShiftBlock";
import TimeAxis, { HourLines } from "./TimeAxis";
import { DayHeaderTop, DayTotal } from "./dayCells";
import { handleBlockArrowKeys } from "./gridKeys";
import type { PlanViewProps } from "./types";
import {
  WithAvatars,
  blockColorsOf,
  dayGroundClass,
  dayTintStyle,
  restAfterCaption,
  tintOfLocation,
} from "./viewParts";
import { HOURS_RULE_HINT, TEXT_3 } from "./planChrome";

// Week · date on top (SPEC E1 / mobile E11): days are columns, time runs down
// 00–24 at 24 px/h (mobile 22 px/h). Rows: day headers, an all-day row (only
// when a vacation is visible), the time grid, day totals.

const ROW_BORDER = "border-slate-300 dark:border-slate-600";
const COL_DIVIDE = "divide-x divide-slate-200 dark:divide-slate-700";

export default function WeekTopView(props: PlanViewProps) {
  const { days, isMobile } = props;
  // Shared hover: both halves of a split night light up together.
  const [hovered, setHovered] = useState<string | null>(null);
  const axisWidth = isMobile ? 30 : 56;
  const columns = { gridTemplateColumns: `${axisWidth}px repeat(${days.length}, minmax(0, 1fr))` };
  const vacationRuns = absenceRuns(days, "vacation");

  return (
    <div
      role="group"
      aria-label="Week, days side by side"
      className="w-full text-slate-900 dark:text-slate-100"
      onKeyDown={(event) => handleBlockArrowKeys(event, "top")}
    >
      <div className={cx("grid border-b", ROW_BORDER, COL_DIVIDE)} style={columns}>
        <div className="bg-slate-50 dark:bg-[#131C2E]" />
        {days.map((day) => (
          <DayHeaderTop
            key={day.dateISO}
            day={day}
            locationsById={props.locationsById}
            isMobile={isMobile}
          />
        ))}
      </div>

      {vacationRuns.length > 0 ? (
        <div className="grid border-b border-slate-200 dark:border-slate-700" style={columns}>
          <div className="h-8 bg-slate-50 dark:bg-[#131C2E]" />
          {vacationRuns.map((run) => {
            const startIndex = days.findIndex((day) => day.dateISO === run.startISO);
            const absence = days[startIndex].absences.find((item) => item.kind === "vacation");
            if (!absence) return null;
            const detail =
              run.days > 1
                ? `${formatDayLabel(run.startISO)} – ${formatDayLabel(run.endISO)} (${run.days} days)`
                : undefined;
            return (
              <div
                key={run.startISO}
                className="relative h-8"
                style={{ gridColumn: `${startIndex + 2} / span ${run.days}`, gridRow: 1 }}
              >
                <AbsenceBand
                  absence={absence}
                  layout="row"
                  isDark={props.isDark}
                  compact={isMobile}
                  detail={isMobile ? undefined : detail}
                  style={{ left: 3, right: 3, top: 3, bottom: 3 }}
                />
              </div>
            );
          })}
        </div>
      ) : null}

      <div className={cx("grid", COL_DIVIDE)} style={columns}>
        <TimeAxis
          axis="vertical"
          windowStartMin={0}
          windowEndMin={MINUTES_PER_DAY}
          pxPerHour={isMobile ? 22 : 24}
          labelEveryHours={isMobile ? 3 : 2}
          nowMin={days.some((day) => day.isToday) ? props.nowMin : null}
          compact={isMobile}
        />
        {days.map((day, index) => (
          <DayColumn
            key={day.dateISO}
            {...props}
            day={day}
            index={index}
            hovered={hovered}
            onHoverChange={setHovered}
          />
        ))}
      </div>

      <div className={cx("grid border-t", ROW_BORDER, COL_DIVIDE)} style={columns}>
        <div
          className={cx("grid place-items-center text-xs font-semibold", isMobile ? "h-7" : "h-9", TEXT_3)}
          title={`Hours per day. ${HOURS_RULE_HINT}`}
        >
          {isMobile ? "h" : "Σ"}
        </div>
        {days.map((day) => (
          <div key={day.dateISO} className={cx("grid place-items-center", isMobile ? "h-7" : "h-9")}>
            <DayTotal day={day} plan={props.plan} isMobile={isMobile} />
          </div>
        ))}
      </div>
    </div>
  );
}

type DayColumnProps = PlanViewProps & {
  day: PlanDay;
  index: number;
  hovered: string | null;
  onHoverChange: (shiftId: string | null) => void;
};

function DayColumn(props: DayColumnProps) {
  const { day, index, plan, isMobile, isDark, selectedShiftId, onSelectShift, days, hovered } = props;
  const pxPerHour = isMobile ? 22 : 24;
  const height = 24 * pxPerHour;
  const visible = new Set(days.map((item) => item.dateISO));
  const twoLocations = day.startLocationIds.length > 1;
  const rest = day.absences.find((absence) => absence.kind === "rest");

  return (
    <div
      className={cx("relative min-w-0", dayGroundClass(day))}
      style={{ height, ...dayTintStyle(day, isDark, "vertical") }}
    >
      <HourLines axis="vertical" windowStartMin={0} windowEndMin={MINUTES_PER_DAY} pxPerHour={pxPerHour} />
      {rest ? (
        <AbsenceBand
          absence={rest}
          layout="column"
          isDark={isDark}
          compact={isMobile}
          flatEnd
          detail={isMobile ? undefined : restAfterCaption(plan, day)}
          style={{
            top: minutesToPx(rest.startMin, 0, pxPerHour) + 1,
            bottom: 0,
            left: isMobile ? 2 : 6,
            right: isMobile ? 2 : 6,
          }}
        />
      ) : null}
      {day.segments.map((segment) => {
        const shift = plan.shifts.get(segment.shiftId);
        if (!shift) return null;
        const box = segmentBox(segment, day.segments, {
          windowStartMin: 0,
          windowEndMin: MINUTES_PER_DAY,
          pxPerHour,
          minPx: isMobile ? 16 : 18,
        });
        // SPEC C5.5: ≥ 140 px tall blocks name who is on the same duty.
        const people = props.sameDutyByShift?.get(shift.id);
        const colors = blockColorsOf(shift, isDark);
        const withFooter =
          !isMobile && people && box.sizePx >= 140 && segment.lanes === 1 && !segment.cutStart ? (
            <WithAvatars
              people={people}
              ring={colors.fill}
              color={colors.secondaryText}
              isDark={isDark}
            />
          ) : undefined;
        return (
          <ShiftBlock
            key={segment.key}
            shift={shift}
            segment={segment}
            axis="vertical"
            offsetPx={box.offsetPx}
            sizePx={box.sizePx}
            footer={withFooter}
            crossInsetPx={isMobile ? 2 : 6}
            variant={isMobile ? "compact" : "regular"}
            selected={selectedShiftId === shift.id}
            isDark={isDark}
            hovered={hovered === shift.id}
            onHoverChange={props.onHoverChange}
            onSelect={onSelectShift}
            focusable={!segment.cutStart || !visible.has(shift.dateISO)}
            showLocation={twoLocations}
            locationTint={tintOfLocation(props.locationsById, shift.locationId)}
            navCol={index}
          />
        );
      })}
      {day.isToday ? (
        <NowLine axis="vertical" offsetPx={minutesToPx(props.nowMin, 0, pxPerHour)} showDot={!isMobile} />
      ) : null}
    </div>
  );
}
