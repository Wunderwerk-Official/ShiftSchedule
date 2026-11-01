import type { AppState } from "../../api/client";

// Shared contract of the swap assistant (SPEC §3 / §8.2): the JSON shapes of
// /v1/swaps/*. The backend's pydantic models and serializers mirror these.

export type SwapMode = "swap" | "handover" | "cover";
export type SwapRange = "sameWeek" | "fourWeeks" | "dates";
export type SwapAssignmentRef = { assignmentId: string; rowId: string; dateISO: string; clinicianId: string };
export type SwapSlotRef = { rowId: string; dateISO: string };
export type SwapOpenTarget =
  | { kind: "assignment"; assignment: SwapAssignmentRef }
  | { kind: "slot"; slot: SwapSlotRef }
  | { kind: "history" }; // FE-only: opens the drawer on History
export type SwapItemRef = { rowId: string; dateISO: string; clinicianId: string; fp: string };
export type SwapApplySlotRef = { rowId: string; dateISO: string; fp: string };

export type SwapItem = {
  assignmentId: string | null; rowId: string; dateISO: string; clinicianId: string | null;
  sectionId: string; sectionName: string; slotLabel: string | null; locationId: string; locationName: string | null;
  start: string; end: string; minutes: number; fp: string;
};
export type SwapUnit = {
  clinicianId: string | null; startDateISO: string; start: string; end: string; minutes: number;
  kind: "duty" | "shift"; overnight: boolean; blockCount: number; primarySectionName: string; items: SwapItem[];
};
export type SwapBlockedCode = "started" | "pool_row" | "vacation_hidden" | "no_times" | "not_open" | "inactive_slot";
export type SwapTargetInfo = {
  mode: SwapMode; holderId: string | null; holderName: string | null;
  dateISO: string; sectionName: string | null;
  unit: SwapUnit | null; // null iff blocked.code is pool_row | vacation_hidden | no_times | inactive_slot
  blocksOnDate: number; wholeDay: boolean;
  startsAt: string | null; hoursUntilStart: number | null; insideNotice: boolean; noticeHours: number;
  timeZone: string; blocked: { code: SwapBlockedCode; message: string } | null; openCount: number | null;
  hiddenHolder: { clinicianId: string; name: string; assignmentId: string } | null;
  excludedPartnerIds: string[];
};
export type SwapWarningCode = "rest_short" | "night_no_free_day" | "block_too_long";
export type SwapCheckCode = "qualification" | "vacation" | "overlap" | "same_location" | "on_call_rest" |
  "mandatory_window" | "weekly_hours" | "split_shift" | "capacity" | "rest" | "night_free_day" | "block_length";
export type SwapWarning = { id: string; code: SwapWarningCode; check: "rest" | "night_free_day" | "block_length";
  clinicianId: string; message: string; short: string };
export type SwapFindingCode = "solver_rule" | "preference_window" | "preferred_day_off" | "section_preference" |
  "hours_above_contract" | "giver_below_contract" | "partner_notice";
export type SwapFinding = { code: SwapFindingCode; clinicianId: string | null; message: string; short: string };
export type SwapChip = { code: "same_section" | "same_type" | "same_week" | "hours_even" | "no_contract" | "prefers" |
  "behind_on_hours"; label: string; tone: "positive" | "neutral" };
export type SwapWeekHours = { isoYear: number; isoWeek: number; weekStartISO: string; beforeMinutes: number;
  afterMinutes: number; contractMinutes: number | null; limitMinutes: number | null };
export type SwapPersonHours = { clinicianId: string; name: string; weeks: SwapWeekHours[] };
export type SwapRestDayMove = { fromClinicianId: string; toClinicianId: string; dateISO: string };
export type SwapRestDayRemoval = { clinicianId: string; name: string; dateISO: string };
export type SwapHiddenRemoval = { clinicianId: string; name: string; assignmentId: string; required: boolean };
export type SwapOption = {
  key: string; partnerId: string; partnerName: string; take: SwapUnit | null; group: "best" | "possible" | "blocked";
  chips: SwapChip[]; reason: { code: string; message: string } | null; blockerCount: number;
  warnings: SwapWarning[]; findings: SwapFinding[]; hours: SwapPersonHours[];
  restDayMoves: SwapRestDayMove[]; restDayRemovals: SwapRestDayRemoval[];
  hiddenRemoval: SwapHiddenRemoval | null; insideNotice: boolean;
  takeHoursUntilStart: number | null; preexisting: SwapCheckCode[];
};
export type SwapCheck = { code: SwapCheckCode; label: string };
export type SwapCandidatesRequest = {
  mode: SwapMode; assignment: SwapAssignmentRef | null; slot: SwapSlotRef | null; wholeDay: boolean;
  partnerId: string | null; range: SwapRange; dates: string[]; sameTypeOnly: boolean; expectedRevision?: string | null;
};
export type SwapCandidatesResponse = {
  revision: string; target: SwapTargetInfo; checks: SwapCheck[];
  best: SwapOption[]; possible: SwapOption[]; blocked: SwapOption[]; closest: SwapOption[];
  totals: { best: number; possible: number; blocked: number }; checked: number; truncated: boolean;
};
export type SwapApplyRequest = {
  mode: SwapMode; give: SwapItemRef[]; wholeDay: boolean; slot: SwapApplySlotRef | null; partnerId: string;
  take: SwapItemRef[] | null; restDayMoves: SwapRestDayMove[]; removeHidden: { clinicianId: string } | null;
  expectedRevision: string; consent: boolean; note: string | null; approverName: string | null;
  overrideNotice: boolean; acknowledgedWarnings: string[];
};
export type SwapRecordItem = { rowId: string; dateISO: string; sectionName: string; start: string; end: string };
export type SwapRecord = {
  id: string; kind: SwapMode; status: "applied" | "reverted";
  requesterId: string | null; requesterName: string | null; partnerId: string; partnerName: string;
  give: SwapRecordItem[]; take: SwapRecordItem[]; restDayMoves: SwapRestDayMove[];
  restDaysRemoved: SwapRestDayRemoval[]; hiddenRemoved: { clinicianId: string; name: string } | null; note: string | null; approverName: string | null;
  consent: "confirmed_by_planner"; noticeOverride: boolean;
  acknowledgedWarnings: { id: string; code: string; message: string }[];
  createdAt: string; appliedAt: string; revertedAt: string | null; canUndo: boolean; undoBlockedReason: string | null;
};
export type SwapApplyResponse = { swap: SwapRecord; state: AppState };
export type SwapHistoryResponse = { swaps: SwapRecord[] };
export type SwapErrorCode = "state_changed" | "swap_stale" | "swap_started" | "notice_override_required" |
  "plan_invalid" | "swap_invalid" | "warnings_unacknowledged" | "consent_required" | "invalid_request" |
  "undo_conflict" | "already_reverted" | "swap_not_found";
