import { useState, type ReactNode } from "react";
import { cx } from "../../lib/classNames";
import TimeAxis from "./TimeAxis";
import WeekStrip from "./WeekStrip";
import DayLaneTrack from "./DayLaneTrack";
import { dayViewWindow, daySegments, isOwnerLane, nowInDayFrame, type DayWindow } from "./dayLanes";
import { handleBlockArrowKeys } from "./gridKeys";
import {
  ColleagueList,
  GROUP_LABELS,
  GroupLabel,
  HiddenColleagues,
  LaneHeader,
  type LaneShiftEntry,
} from "./laneParts";
import type { DayLane, DayViewProps } from "./types";

// Day · date on top (SPEC E3 / mobile E12 "top"): lanes are columns — me
// first, then colleagues ("Same duty", "Same time at location") — and time
// runs down at 24 px/h (mobile 20 px/h) over the day window (06–22 extended,
// a night runs unsplit past midnight). Desktop shows `detailSlot` in a right
// column; on mobile only my lane is drawn and colleagues are listed below.

export type DayTopViewProps = DayViewProps & {
  /** Desktop right column: the container renders <ShiftDetail variant="inline" …/> here. */
  detailSlot?: ReactNode;
  /** Desktop: the 7-day strip above the detail jumps to another day of the week. */
  onPickDay?: (dateISO: string) => void;
};

/** Lanes to draw: the container's lanes, or just me (from `plan`) when none are passed. */
export function resolveLanes(props: DayViewProps): DayLane[] {
  if (props.lanes.length > 0) return props.lanes;
  return [{ clinicianId: props.plan.clinicianId, name: "Me", colorIndex: 0, isMe: true, group: "me", plan: props.plan }];
}

export default function DayTopView(props: DayTopViewProps) {
  const day = props.days[0];
  const [hovered, setHovered] = useState<string | null>(null);
  if (!day) return null;
  const lanes = resolveLanes(props);
  const timeWindow = dayViewWindow(day, lanes, props.plan);
  const nowFrameMin = nowInDayFrame(day, props.nowMin);
  const shared = { ...props, day, timeWindow, nowFrameMin, hovered, onHoverChange: setHovered };
  if (props.isMobile) return <MobileDayTop {...shared} lanes={lanes} />;
  return <DesktopDayTop {...shared} lanes={lanes} />;
}

type InnerProps = DayTopViewProps & {
  day: DayViewProps["days"][number];
  timeWindow: DayWindow;
  nowFrameMin: number | null;
  hovered: string | null;
  onHoverChange: (shiftId: string | null) => void;
};

function laneTrackProps(props: InnerProps, lane: DayLane, index: number) {
  return {
    plan: lane.plan,
    day: props.day,
    timeWindow: props.timeWindow,
    isOwner: isOwnerLane(lane),
    isDark: props.isDark,
    nowFrameMin: props.nowFrameMin,
    // Desktop: the detail is the inline column, so blocks toggle instead of opening a dialog.
    inlineDetail: !props.isMobile,
    selectedShiftId: props.selectedShiftId,
    onSelectShift: props.onSelectShift,
    hovered: props.hovered,
    onHoverChange: props.onHoverChange,
    locationsById: props.locationsById,
    navCol: index,
  };
}

function DesktopDayTop(props: InnerProps) {
  const { lanes, day, timeWindow } = props;
  const pxPerHour = 24;
  const height = ((timeWindow.endMin - timeWindow.startMin) / 60) * pxPerHour;
  const columns = {
    gridTemplateColumns: `56px minmax(200px, 2.4fr) ${lanes
      .slice(1)
      .map(() => "minmax(92px, 1fr)")
      .join(" ")}`,
  };
  // Group label spans over consecutive colleague lanes of the same group.
  const spans: Array<{ group: DayLane["group"]; start: number; count: number }> = [];
  lanes.forEach((lane, index) => {
    if (index === 0) return;
    const last = spans[spans.length - 1];
    if (last && last.group === lane.group) last.count += 1;
    else spans.push({ group: lane.group, start: index, count: 1 });
  });

  return (
    <div className="flex w-full min-w-0 text-slate-900 dark:text-slate-100">
      <div
        role="group"
        aria-label="Day, time runs down"
        className="min-w-0 flex-1 overflow-x-auto"
        onKeyDown={(event) => handleBlockArrowKeys(event, "top")}
      >
        <div style={{ minWidth: 56 + 200 + (lanes.length - 1) * 92 }}>
          {spans.length > 0 ? (
            <div className="grid h-6 border-b border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-[#131C2E]" style={columns}>
              {spans.map((span) => (
                <div
                  key={span.start}
                  className="flex min-w-0 items-center border-l border-slate-200 px-2 dark:border-slate-700"
                  style={{ gridColumn: `${span.start + 2} / span ${span.count}`, gridRow: 1 }}
                >
                  <GroupLabel>{GROUP_LABELS[span.group]}</GroupLabel>
                </div>
              ))}
            </div>
          ) : null}
          <div
            className="grid h-14 divide-x divide-slate-200 border-b border-slate-300 bg-slate-50 dark:divide-slate-700 dark:border-slate-600 dark:bg-[#131C2E]"
            style={columns}
          >
            <div />
            {lanes.map((lane) => (
              <div key={lane.clinicianId} className="flex min-w-0 items-center px-2">
                <LaneHeader lane={lane} dateISO={day.dateISO} locationsById={props.locationsById} isDark={props.isDark} />
              </div>
            ))}
          </div>
          <div className="grid divide-x divide-slate-200 dark:divide-slate-700" style={columns}>
            <TimeAxis
              axis="vertical"
              windowStartMin={timeWindow.startMin}
              windowEndMin={timeWindow.endMin}
              pxPerHour={pxPerHour}
              nowMin={props.nowFrameMin}
              dateISO={day.dateISO}
            />
            {lanes.map((lane, index) => (
              <DayLaneTrack
                key={lane.clinicianId}
                {...laneTrackProps(props, lane, index)}
                axis="vertical"
                pxPerHour={pxPerHour}
                crossInsetPx={isOwnerLane(lane) ? 8 : 4}
                showNowDot={index === 0}
                style={{ height }}
              />
            ))}
          </div>
          <HiddenColleagues
            count={props.hiddenColleagueCount}
            className="h-10 border-t border-slate-200 px-4 dark:border-slate-700"
          />
        </div>
      </div>
      {props.detailSlot || props.onPickDay ? (
        <aside
          aria-label="Selected shift"
          className="flex w-[392px] shrink-0 flex-col gap-4 overflow-y-auto border-l border-slate-200 px-4 py-4 dark:border-slate-700"
        >
          {props.onPickDay ? (
            <WeekStrip plan={props.plan} dateISO={day.dateISO} isDark={props.isDark} onPickDay={props.onPickDay} />
          ) : null}
          {props.detailSlot}
        </aside>
      ) : null}
    </div>
  );
}

function MobileDayTop(props: InnerProps) {
  const { lanes, day, timeWindow } = props;
  const pxPerHour = 20;
  const height = ((timeWindow.endMin - timeWindow.startMin) / 60) * pxPerHour;
  const me = lanes.find(isOwnerLane) ?? lanes[0];
  const colleagues: LaneShiftEntry[] = [];
  for (const lane of lanes) {
    if (lane === me) continue;
    const segment = daySegments(lane.plan, day.dateISO, timeWindow)[0];
    const shift = segment ? lane.plan.shifts.get(segment.shiftId) : undefined;
    if (shift) colleagues.push({ lane, shift });
  }
  return (
    <div className="flex w-full flex-col gap-4 text-slate-900 dark:text-slate-100">
      <div
        role="group"
        aria-label="Day, time runs down"
        className={cx(
          "grid overflow-hidden rounded-xl border border-slate-200 dark:border-slate-700",
          "divide-x divide-slate-200 dark:divide-slate-700",
        )}
        style={{ gridTemplateColumns: "40px minmax(0, 1fr)" }}
        onKeyDown={(event) => handleBlockArrowKeys(event, "top")}
      >
        <TimeAxis
          axis="vertical"
          windowStartMin={timeWindow.startMin}
          windowEndMin={timeWindow.endMin}
          pxPerHour={pxPerHour}
          nowMin={props.nowFrameMin}
          dateISO={day.dateISO}
          compact
        />
        <DayLaneTrack
          {...laneTrackProps(props, me, 0)}
          axis="vertical"
          pxPerHour={pxPerHour}
          crossInsetPx={8}
          showNowDot
          style={{ height }}
        />
      </div>
      <ColleagueList
        entries={colleagues}
        hiddenCount={props.hiddenColleagueCount}
        selectedShiftId={props.selectedShiftId}
        onSelectShift={props.onSelectShift}
        isDark={props.isDark}
      />
      {props.detailSlot}
    </div>
  );
}
