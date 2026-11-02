import { formatDayLabel, formatHours, formatWeekday, parseISODate } from "../myPlan";
import type {
  SwapApplyRequest,
  SwapItemRef,
  SwapMode,
  SwapOpenTarget,
  SwapOption,
  SwapRecord,
  SwapRecordItem,
  SwapRestDayMove,
  SwapTargetInfo,
  SwapUnit,
  SwapWeekHours,
} from "./types";

// Pure text and request helpers of the swap assistant (SPEC §5.9). Times
// arrive as calendar wall-clock strings "YYYY-MM-DDTHH:MM" and are shown as
// they are: no time-zone conversion happens in the browser.

const TITLES = new Set(["dr", "dr.", "prof", "prof.", "pd", "med", "med."]);
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The team grid's pill key (`data-assignment-key`). */
export function assignmentKey(rowId: string, dateISO: string, clinicianId: string): string {
  return `${rowId}__${dateISO}__${clinicianId}`;
}

/** "Thu 19 Nov". */
export const dayLabel = formatDayLabel;

/** "Thu 19 / Sat 21 Nov", "Mon 30 Nov / Tue 1 Dec", or "Thu 19 Nov" for one day. */
export function dayMonthPair(firstISO: string, secondISO: string): string {
  if (firstISO === secondISO) return dayLabel(firstISO);
  if (firstISO.slice(0, 7) !== secondISO.slice(0, 7)) return `${dayLabel(firstISO)} / ${dayLabel(secondISO)}`;
  return `${formatWeekday(firstISO)} ${parseISODate(firstISO).getDate()} / ${dayLabel(secondISO)}`;
}

/** "08:00–16:00" on one day, "20:00 → 08:00" across midnight. */
export function timeRange(start: string, end: string): string {
  const from = start.slice(11, 16);
  const to = end.slice(11, 16);
  return start.slice(0, 10) === end.slice(0, 10) ? `${from}–${to}` : `${from} → ${to}`;
}

/** 720 → "12.0 h". */
export function hoursLabel(minutes: number): string {
  return formatHours(minutes / 60);
}

/** Hours as a count in running text: 10 → "10", 82.46 → "82.5". */
export function hoursText(hours: number): string {
  const rounded = Math.round(hours * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/** "Week 47: 40.0 → 36.0 h". */
export function weekChange(week: SwapWeekHours): string {
  const hours = (minutes: number) => (minutes / 60).toFixed(1);
  return `Week ${week.isoWeek}: ${hours(week.beforeMinutes)} → ${hours(week.afterMinutes)} h`;
}

/** "Week 47: 40.0 → 36.0 h (limit 45.0 h)" or "… (no contract hours)". */
export function weekHoursLine(week: SwapWeekHours): string {
  const limit = week.limitMinutes === null ? "no contract hours" : `limit ${hoursLabel(week.limitMinutes)}`;
  return `${weekChange(week)} (${limit})`;
}

/** "Night duty 20:00 → 08:00 + Demo 07:15–07:45". */
export function unitSummary(unit: SwapUnit): string {
  return unit.items.map((item) => `${item.sectionName} ${timeRange(item.start, item.end)}`).join(" + ");
}

/** "Sat 21 Nov · CT · 08:00–16:00 · Mitte". */
export function unitLine(unit: SwapUnit): string {
  const locations = [...new Set(unit.items.map((item) => item.locationName).filter(Boolean))];
  const parts = [dayLabel(unit.startDateISO), unit.primarySectionName, timeRange(unit.start, unit.end)];
  if (locations.length > 0) parts.push(locations.join(" + "));
  return parts.join(" · ");
}

/** "Dr. Lena Hoffmann" → "Lena". */
export function firstName(name: string): string {
  const words = name.split(/\s+/).filter(Boolean);
  return words.find((word) => !TITLES.has(word.toLowerCase())) ?? words[0] ?? name;
}

/** The section of a target: the selected shift's or the open slot's. */
function targetSection(target: SwapTargetInfo): string {
  return target.sectionName ?? target.unit?.primarySectionName ?? "";
}

/** The days of the moved shifts: "Thu 19 / Sat 21 Nov" for a swap, else "Thu 19 Nov". */
function swapDays(swap: SwapRecord): string {
  const given = swap.give[0].dateISO;
  return swap.kind === "swap" ? dayMonthPair(given, swap.take[0].dateISO) : dayLabel(given);
}

/** "Swapped: Anna Weber ⇄ Ben Ott (Thu 19 / Sat 21 Nov)"; full names, as first names repeat in a team. */
export function swapToastMessage(swap: SwapRecord): string {
  const giver = swap.requesterName ?? "";
  const days = swapDays(swap);
  if (swap.kind === "swap") return `Swapped: ${giver} ⇄ ${swap.partnerName} (${days})`;
  if (swap.kind === "handover") return `Handed over: ${giver} → ${swap.partnerName} (${days})`;
  return `Assigned: ${swap.partnerName} covers ${swap.give[0].sectionName} (${days})`;
}

/** "Swap undone: Anna Weber ⇄ Ben Ott (Thu 19 / Sat 21 Nov)", as the toast of the apply. */
export function undoToastMessage(swap: SwapRecord): string {
  const giver = swap.requesterName ?? "";
  const days = swapDays(swap);
  if (swap.kind === "swap") return `Swap undone: ${giver} ⇄ ${swap.partnerName} (${days})`;
  if (swap.kind === "handover") return `Hand-over undone: ${giver} → ${swap.partnerName} (${days})`;
  return `Cover undone: ${swap.partnerName} no longer covers ${swap.give[0].sectionName} (${days})`;
}

/**
 * Name of History's Undo button: "Undo swap of Anna Weber and Ben Ott (Thu 19 /
 * Sat 21 Nov)", "Undoing …" while it runs. It starts with the visible text.
 */
export function undoButtonLabel(swap: SwapRecord, running: boolean): string {
  const verb = running ? "Undoing" : "Undo";
  const giver = swap.requesterName ?? "";
  const datable = swap.give.length > 0 && (swap.kind !== "swap" || swap.take.length > 0);
  const days = datable ? ` (${swapDays(swap)})` : "";
  if (swap.kind === "swap") return `${verb} swap of ${giver} and ${swap.partnerName}${days}`;
  if (swap.kind === "handover") return `${verb} hand-over from ${giver} to ${swap.partnerName}${days}`;
  return `${verb} ${swap.partnerName} covering ${swap.give[0]?.sectionName ?? "the slot"}${days}`;
}

export function consentLabel(mode: SwapMode, partnerName: string): string {
  return mode === "swap" ? `${partnerName} agreed to this swap` : `${partnerName} agreed to take this shift`;
}

export function primaryLabel(mode: SwapMode): string {
  if (mode === "swap") return "Swap shifts";
  return mode === "handover" ? "Hand over" : "Assign";
}

export function previewTitle(mode: SwapMode, target: SwapTargetInfo, option: SwapOption): string {
  if (mode === "swap") return `Swap ${target.holderName ?? ""} ⇄ ${option.partnerName}`;
  if (mode === "handover") return `Hand over to ${option.partnerName}`;
  return `${option.partnerName} covers ${targetSection(target)}`;
}

/** Pill keys of the selected unit X (its holder's pills). */
export function targetHighlightKeys(target: SwapTargetInfo): string[] {
  const { unit, holderId } = target;
  if (!unit || !holderId) return [];
  return unit.items.map((item) => assignmentKey(item.rowId, item.dateISO, holderId));
}

/**
 * What the page reveals once the drawer has opened: the target's first pill,
 * or for cover the open slot's cell, as a key without a person (the page
 * falls back to the cell of a key whose pill it does not find).
 */
export function targetRevealKey(target: SwapTargetInfo): string | null {
  const [pill] = targetHighlightKeys(target);
  if (pill) return pill;
  const item = target.mode === "cover" ? target.unit?.items[0] : undefined;
  return item ? assignmentKey(item.rowId, item.dateISO, "") : null;
}

/** Pill keys of an option's unit Y (the partner's pills); none for hand-over and cover. */
export function optionHighlightKeys(option: SwapOption): string[] {
  if (!option.take) return [];
  return option.take.items.map((item) => assignmentKey(item.rowId, item.dateISO, option.partnerId));
}

/**
 * The preview outline (SPEC §5.5): teal-600 pills (teal-300 in dark mode) and
 * clinic sheet names. `!important` wins over the "me" outline of a pill; the
 * drag image clone keeps its own look.
 */
export function highlightCss(keys: string[]): string {
  if (keys.length === 0) return "";
  const escaped = keys.map((key) => CSS.escape(key));
  const pills = `:is(${escaped.map((key) => `[data-assignment-key="${key}"]`).join(", ")}):not([data-pill-drag-preview])`;
  const names = `:is(${escaped.map((key) => `[data-sheet-assignment-key="${key}"]`).join(", ")})`;
  return [
    `${pills} { outline: 2px solid #0d9488 !important; outline-offset: 1px !important; }`,
    `.dark ${pills} { outline-color: #5eead4 !important; }`,
    `${names} { outline: 2px solid #0d9488 !important; outline-offset: -1px !important; }`,
  ].join("\n");
}

/** Hours until the earlier of X and Y starts; null when neither is known. */
export function noticeHoursLeft(target: SwapTargetInfo, option: SwapOption): number | null {
  const hours = [target.hoursUntilStart, option.takeHoursUntilStart].filter((value): value is number => value !== null);
  return hours.length > 0 ? Math.min(...hours) : null;
}

/** The Find tab summary of the target (SPEC §5.5), also for a blocked target without a unit. */
export function targetSummary(target: SwapTargetInfo): string {
  const { unit } = target;
  if (!unit) {
    const head = target.mode === "cover" ? "Open slot" : target.holderName;
    return [head, dayLabel(target.dateISO), target.sectionName].filter(Boolean).join(" · ");
  }
  if (target.mode === "cover") {
    return ["Open slot", targetSection(target), dayLabel(unit.startDateISO), timeRange(unit.start, unit.end)].join(" · ");
  }
  return [target.holderName, dayLabel(unit.startDateISO), unitSummary(unit), hoursLabel(unit.minutes)]
    .filter(Boolean)
    .join(" · ");
}

/** "12 Nov, 10:42" in the browser's time zone (history timestamps are UTC). */
export function stampLabel(iso: string): string {
  const date = new Date(iso);
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  return `${date.getDate()} ${MONTHS_SHORT[date.getMonth()]}, ${time}`;
}

/** History line of one moved shift: "Thu 19 Nov · Night duty 20:00 → 08:00". */
export function recordItemLine(item: SwapRecordItem): string {
  return `${dayLabel(item.dateISO)} · ${item.sectionName} ${timeRange(item.start, item.end)}`;
}

export function restDayMoveKey(move: SwapRestDayMove): string {
  return `${move.fromClinicianId}>${move.toClinicianId}@${move.dateISO}`;
}

/** The preview's form; buildApplyRequest turns it into the apply request. */
export type SwapApplyForm = {
  consent: boolean;
  acknowledgedWarnings: string[];
  overrideNotice: boolean;
  /** The ticked rest-day moves (every detected move starts ticked). */
  restDayMoves: SwapRestDayMove[];
  /** The optional hidden removal is ticked; a required one is always sent. */
  removeHidden: boolean;
  note: string;
  approverName: string;
};

function itemRefs(unit: SwapUnit | null, clinicianId: string | null): SwapItemRef[] {
  if (!unit || !clinicianId) return [];
  return unit.items.map(({ rowId, dateISO, fp }) => ({ rowId, dateISO, clinicianId, fp }));
}

/** The apply request of a previewed option; the page fills in expectedRevision. */
export function buildApplyRequest(
  mode: SwapMode,
  target: SwapTargetInfo,
  option: SwapOption,
  form: SwapApplyForm,
): SwapApplyRequest {
  const instance = target.unit?.items[0];
  const ticked = new Set(form.restDayMoves.map(restDayMoveKey));
  const hidden = option.hiddenRemoval;
  return {
    mode,
    give: mode === "cover" ? [] : itemRefs(target.unit, target.holderId),
    wholeDay: target.wholeDay,
    slot: mode === "cover" && instance ? { rowId: instance.rowId, dateISO: instance.dateISO, fp: instance.fp } : null,
    partnerId: option.partnerId,
    take: option.take ? itemRefs(option.take, option.partnerId) : null,
    restDayMoves: option.restDayMoves.filter((move) => ticked.has(restDayMoveKey(move))),
    removeHidden: hidden && (hidden.required || form.removeHidden) ? { clinicianId: hidden.clinicianId } : null,
    expectedRevision: "",
    consent: form.consent,
    note: form.note.trim() || null,
    approverName: form.approverName.trim() || null,
    overrideNotice: form.overrideNotice,
    acknowledgedWarnings: form.acknowledgedWarnings,
  };
}

/** Drawer identity on the page: a new target remounts the drawer. */
export function swapTargetKey(target: SwapOpenTarget): string {
  if (target.kind === "history") return "h";
  if (target.kind === "slot") return `s:${target.slot.rowId}__${target.slot.dateISO}`;
  const { rowId, dateISO, clinicianId } = target.assignment;
  return `a:${assignmentKey(rowId, dateISO, clinicianId)}`;
}
