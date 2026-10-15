import { Fragment, useRef, useState, type ReactNode } from "react";
import { cx } from "../../lib/classNames";
import { formatHours, personTone } from "../../lib/myPlan";
import DayLaneTrack from "./DayLaneTrack";
import { resolveLanes } from "./DayTopView";
import TimeAxis from "./TimeAxis";
import { dayViewWindow, isOwnerLane, laneHours, nowInDayFrame } from "./dayLanes";
import { handleBlockArrowKeys } from "./gridKeys";
import { GROUP_LABELS, GroupLabel, HiddenColleagues, LaneHeader, laneLocationText } from "./laneParts";
import type { DayLane, DayViewProps } from "./types";
import { useElementWidth } from "./useElementWidth";
import { Avatar } from "./viewParts";
import { displayName, TEXT_1, TEXT_3 } from "./planChrome";

// Day · date on left (SPEC E4 / mobile E12 "left"): lanes are rows — me
// (80 px), then group rows and colleague rows (48 px) — and time runs right
// over the day window on the available width. Columns 136 px | track | 80 px
// total (mobile 88 px | track). `detailSlot` renders below the lanes (desktop
// and phone: the selected or the day's current own shift).

export type DayLeftViewProps = DayViewProps & {
  /** Rendered below the lanes: the container's <ShiftDetail variant="inline" …/>. */
  detailSlot?: ReactNode;
};

export default function DayLeftView(props: DayLeftViewProps) {
  const day = props.days[0];
  const axisRef = useRef<HTMLDivElement>(null);
  const trackWidth = useElementWidth(axisRef, props.isMobile ? 270 : 1008);
  const [hovered, setHovered] = useState<string | null>(null);
  if (!day) return null;
  const { isMobile } = props;
  const lanes = resolveLanes(props);
  const timeWindow = dayViewWindow(day, lanes, props.plan);
  const nowFrameMin = nowInDayFrame(day, props.nowMin);
  const pxPerHour = trackWidth / ((timeWindow.endMin - timeWindow.startMin) / 60);
  const columns = { gridTemplateColumns: isMobile ? "88px minmax(0, 1fr)" : "136px minmax(0, 1fr) 80px" };
  const myLocation = lanes[0] ? laneLocationText(lanes[0], day.dateISO, props.locationsById) : "";

  const row = (lane: DayLane, index: number) => {
    const hours = laneHours(lane.plan, day.dateISO);
    const owner = isOwnerLane(lane);
    const rowHeight = owner ? (isMobile ? 64 : 80) : isMobile ? 52 : 48;
    return (
      <div
        key={lane.clinicianId}
        className="grid border-b border-slate-200 dark:border-slate-700"
        style={{ ...columns, height: rowHeight }}
      >
        <div className={cx("flex min-w-0 items-center", isMobile ? "px-2" : "px-3")}>
          {isMobile ? (
            <span className="flex min-w-0 items-center gap-1.5" title={lane.name}>
              <Avatar name={lane.name} size={owner ? "m" : "s"} tone={personTone(lane.colorIndex, props.isDark)} />
              <span className={cx("truncate text-[13px] font-semibold", TEXT_1)}>
                {lane.isMe ? "Me" : displayName(lane.name).split(" ")[0]}
              </span>
            </span>
          ) : (
            <LaneHeader
              lane={lane}
              dateISO={day.dateISO}
              locationsById={props.locationsById}
              isDark={props.isDark}
              dense={!owner}
              narrowCell
            />
          )}
        </div>
        <DayLaneTrack
          plan={lane.plan}
          day={day}
          timeWindow={timeWindow}
          axis="horizontal"
          pxPerHour={pxPerHour}
          crossInsetPx={owner ? (isMobile ? 18 : 12) : isMobile ? 16 : 8}
          variant={owner && !isMobile ? "regular" : "compact"}
          isOwner={owner}
          isDark={props.isDark}
          nowFrameMin={nowFrameMin}
          inlineDetail={props.detailSlot !== undefined}
          selectedShiftId={props.selectedShiftId}
          onSelectShift={props.onSelectShift}
          hovered={hovered}
          onHoverChange={setHovered}
          locationsById={props.locationsById}
          navCol={index}
          showNowDot={index === 0}
          className="border-l border-slate-200 dark:border-slate-700"
        />
        {!isMobile ? (
          <div
            className={cx(
              "flex items-center justify-end border-l border-slate-200 pr-4 text-[13px] font-semibold tabular-nums dark:border-slate-700",
              TEXT_1,
            )}
          >
            {hours !== null ? formatHours(hours) : "–"}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <div className="flex w-full flex-col gap-4 text-slate-900 dark:text-slate-100">
      <div
        role="group"
        aria-label="Day, time runs right"
        className={cx(isMobile && "overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900")}
        onKeyDown={(event) => handleBlockArrowKeys(event, "left")}
      >
        <div
          className={cx(
            "grid border-b border-slate-300 bg-slate-50 dark:border-slate-600 dark:bg-[#131C2E]",
            isMobile ? "h-7" : "h-8",
          )}
          style={columns}
        >
          <div />
          <div ref={axisRef} className="relative min-w-0 border-l border-slate-200 dark:border-slate-700">
            <TimeAxis
              axis="horizontal"
              windowStartMin={timeWindow.startMin}
              windowEndMin={timeWindow.endMin}
              pxPerHour={pxPerHour}
              labelEveryHours={isMobile ? 6 : 2}
              nowMin={nowFrameMin}
              dateISO={day.dateISO}
              compact={isMobile}
            />
          </div>
          {!isMobile ? (
            <div
              className={cx("flex items-center justify-end border-l border-slate-200 pr-4 text-[11px] font-semibold dark:border-slate-700", TEXT_3)}
            >
              Hours
            </div>
          ) : null}
        </div>
        {lanes.map((lane, index) => {
          const previous = lanes[index - 1];
          const groupStarts = index > 0 && (!previous || previous.group !== lane.group);
          return (
            <Fragment key={lane.clinicianId}>
              {groupStarts ? (
                <div className="flex h-7 items-center border-b border-slate-200 bg-slate-50 px-4 dark:border-slate-700 dark:bg-[#131C2E]">
                  <GroupLabel>
                    {lane.group === "sameTimeAtLocation" && myLocation && !isMobile
                      ? `${GROUP_LABELS[lane.group]} · ${myLocation}`
                      : GROUP_LABELS[lane.group]}
                  </GroupLabel>
                </div>
              ) : null}
              {row(lane, index)}
            </Fragment>
          );
        })}
        <HiddenColleagues count={props.hiddenColleagueCount} className="h-10 px-4" />
      </div>
      {props.detailSlot ? <div className={isMobile ? "pb-3" : "px-4 pb-4"}>{props.detailSlot}</div> : null}
    </div>
  );
}
