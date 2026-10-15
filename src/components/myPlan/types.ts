import type { Location } from "../../api/client";
import type { PersonPlan, PlanDay, PlanShift, PlanSource } from "../../lib/myPlan";

// Shared prop contracts of the "My plan" views. MyPlanView (the container)
// builds the plans and owns selection; the views only render.

/** Select a shift (or clear with null); the anchor positions the detail popover. */
export type SelectShift = (shiftId: string | null, anchor?: HTMLElement | null) => void;

/** "Show in team plan": the assignment the team grid jumps to (and pulses). */
export type TeamPlanTarget = { rowId: string; dateISO: string; clinicianId: string };

/** A colleague on the same duty, for the "with" avatars of week blocks. */
export type BlockCoworker = {
  clinicianId: string;
  name: string;
  /** Clinician list index → person color (personTone). */
  colorIndex: number;
};

/** Props every body view receives (week/day/month × date on top/left). */
export type PlanViewProps = {
  plan: PersonPlan;
  /** Visible days in order: week 7, day 1, month the whole sheet. */
  days: PlanDay[];
  selectedShiftId: string | null;
  onSelectShift: SelectShift;
  /** Minutes since local midnight; the now-line is drawn on today's day only. */
  nowMin: number;
  isMobile: boolean;
  isDark: boolean;
  locationsById: Map<string, Location>;
  /** Week views: same-duty colleagues per own shift id ("with" + avatars on large blocks). */
  sameDutyByShift?: Map<string, BlockCoworker[]>;
};

/** One lane of the day view: me first, then colleagues working with me. */
export type DayLane = {
  clinicianId: string;
  name: string;
  /** Clinician list index → person color of the avatar (personTone). */
  colorIndex: number;
  /** The linked "I am" person ("Me" badge). Not the same as the first lane. */
  isMe: boolean;
  /** "me" = the person whose plan is shown (first lane, see isOwnerLane). */
  group: "me" | "sameDuty" | "sameTimeAtLocation";
  /** That person's plan covering the visible day. */
  plan: PersonPlan;
};

export type DayViewProps = PlanViewProps & {
  lanes: DayLane[];
  /** Colleagues at the location not shown as lanes ("+N more at location"). */
  hiddenColleagueCount: number;
};

export type MonthViewProps = PlanViewProps & {
  monthAnchor: Date;
  /** Hours per ISO week, keyed by the week's Monday (YYYY-MM-DD). */
  weekHours: Map<string, number>;
  onOpenDay: (dateISO: string) => void;
};

export type ShiftDetailProps = {
  shift: PlanShift;
  /** Plan of the person the shift belongs to. */
  plan: PersonPlan;
  source: PlanSource;
  /** The shift belongs to the person whose plan is shown (adds rest before / next). */
  isMe: boolean;
  anchorEl: HTMLElement | null;
  isMobile: boolean;
  isDark: boolean;
  locationsById: Map<string, Location>;
  onClose: () => void;
  /** "Show in team plan" of this shift (row, date and person). */
  onShowInTeam: (shift: PlanShift) => void;
};
