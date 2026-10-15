import type { CSSProperties } from "react";
import type { Location } from "../../api/client";
import { cx } from "../../lib/classNames";
import {
  formatTime,
  minutesToPx,
  segmentBox,
  type PersonPlan,
  type PlanDay,
} from "../../lib/myPlan";
import AbsenceBand from "./AbsenceBand";
import NowLine from "./NowLine";
import ShiftBlock from "./ShiftBlock";
import { HourLines } from "./TimeAxis";
import {
  OUTSIDE_LABEL_MIN_FREE_PX,
  daySegments,
  freeBefore,
  freeUntil,
  laneDay,
  type DayWindow,
} from "./dayLanes";
import type { SelectShift } from "./types";
import { dayGroundClass, restAfterCaption, tintOfLocation, tintStyle } from "./viewParts";
import { TEXT_3 } from "./planChrome";

// One lane (person) of a day view on a time axis: ground tint, hour lines
// with the dashed midnight, absence bands, unsplit shift blocks, now-line
// and the "free until 17:00" hint. Used by DayTopView (vertical) and
// DayLeftView (horizontal).

export type DayLaneTrackProps = {
  plan: PersonPlan;
  /** The visible day (of the main plan); the lane's own day is looked up by date. */
  day: PlanDay;
  timeWindow: DayWindow;
  axis: "vertical" | "horizontal";
  pxPerHour: number;
  crossInsetPx: number;
  variant?: "regular" | "compact";
  /** Lane of the viewed person (see isOwnerLane): "free" hints and location tags. */
  isOwner: boolean;
  isDark: boolean;
  /** "Now" in the window's frame (nowInDayFrame); null = not inside this day's window. */
  nowFrameMin: number | null;
  /** The detail renders inline (desktop day views): blocks are toggles, not dialog openers. */
  inlineDetail?: boolean;
  selectedShiftId: string | null;
  onSelectShift: SelectShift;
  hovered: string | null;
  onHoverChange: (shiftId: string | null) => void;
  locationsById: Map<string, Location>;
  navCol: number;
  showNowDot?: boolean;
  className?: string;
  style?: CSSProperties;
};

const hintClass = cx("pointer-events-none absolute left-3 z-[1] text-xs tabular-nums", TEXT_3);

export default function DayLaneTrack(props: DayLaneTrackProps) {
  const { plan, day, timeWindow, axis, pxPerHour, isDark, isOwner, variant = "regular" } = props;
  const vertical = axis === "vertical";
  const lanePlanDay = laneDay(plan, day.dateISO);
  const ownDay = lanePlanDay ?? day;
  // The lane's own tint only: a colleague whose day is a continuation or free stays neutral.
  const tint = lanePlanDay ? lanePlanDay.tint : day.tint;
  const segments = daySegments(plan, day.dateISO, timeWindow);
  const toPx = (min: number) => minutesToPx(min, timeWindow.startMin, pxPerHour);
  const freeMin = isOwner ? freeUntil(segments, timeWindow) : null;
  // Room for "free until 17:00" before the first block (wider when time runs right).
  const free =
    freeMin !== null && toPx(freeMin) >= (vertical ? 24 : 112) ? freeMin : null;
  const along = (from: number, to?: number): CSSProperties => {
    const start = toPx(Math.max(from, timeWindow.startMin)) + 1;
    const cross = vertical
      ? { left: props.crossInsetPx, right: props.crossInsetPx }
      : { top: props.crossInsetPx, bottom: props.crossInsetPx };
    if (to === undefined) return vertical ? { ...cross, top: start, bottom: 0 } : { ...cross, left: start, right: 0 };
    const size = Math.max(0, toPx(to) - start - 1);
    return vertical ? { ...cross, top: start, height: size } : { ...cross, left: start, width: size };
  };
  const now = props.nowFrameMin;
  const restCaption = variant !== "compact" ? restAfterCaption(plan, ownDay) : undefined;

  return (
    <div
      className={cx("relative min-w-0", dayGroundClass(day), props.className)}
      style={{ ...tintStyle(tint, isDark), ...props.style }}
    >
      <HourLines
        axis={axis}
        windowStartMin={timeWindow.startMin}
        windowEndMin={timeWindow.endMin}
        pxPerHour={pxPerHour}
      />
      {ownDay.absences.map((absence, index) => (
        <AbsenceBand
          key={`${absence.kind}-${index}`}
          absence={absence}
          layout={vertical ? "column" : "row"}
          isDark={isDark}
          compact={variant === "compact"}
          detail={absence.kind === "rest" ? restCaption : undefined}
          flatEnd
          style={along(absence.kind === "vacation" ? timeWindow.startMin : absence.startMin, Math.min(timeWindow.endMin, 24 * 60))}
        />
      ))}
      {free !== null ? (
        <span className={cx(hintClass, vertical ? "top-2" : "top-1/2 -translate-y-1/2")}>
          free until {formatTime(free)}
        </span>
      ) : null}
      {isOwner && segments.length === 0 && ownDay.absences.length === 0 && ownDay.published ? (
        <span className={cx(hintClass, vertical ? "top-2" : "top-1/2 -translate-y-1/2")}>free</span>
      ) : null}
      {segments.map((segment) => {
        const shift = plan.shifts.get(segment.shiftId);
        if (!shift) return null;
        const box = segmentBox(segment, segments, {
          windowStartMin: timeWindow.startMin,
          windowEndMin: timeWindow.endMin,
          pxPerHour,
          minPx: vertical ? 18 : 1,
        });
        return (
          <ShiftBlock
            key={segment.key}
            shift={shift}
            segment={segment}
            axis={axis}
            offsetPx={box.offsetPx}
            sizePx={box.sizePx}
            crossInsetPx={props.crossInsetPx}
            variant={variant}
            selected={props.selectedShiftId === shift.id}
            isDark={isDark}
            opensDialog={!props.inlineDetail}
            hovered={props.hovered === shift.id}
            onHoverChange={props.onHoverChange}
            onSelect={props.onSelectShift}
            edgeCaptions={false}
            // The own lane is wide (≥ 200 px): even half of it fits a title.
            narrow={segment.lanes === 2 && !isOwner}
            showLocation={isOwner}
            locationTint={tintOfLocation(props.locationsById, shift.locationId)}
            outsideLabel={
              !vertical &&
              freeBefore(segment, segments, toPx, timeWindow.startMin) >= OUTSIDE_LABEL_MIN_FREE_PX
            }
            navCol={props.navCol}
          />
        );
      })}
      {now !== null && now >= timeWindow.startMin && now <= timeWindow.endMin ? (
        <NowLine axis={axis} offsetPx={toPx(now)} showDot={props.showNowDot ?? false} />
      ) : null}
    </div>
  );
}
