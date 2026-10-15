import { cx } from "../../lib/classNames";
import {
  MINUTES_PER_DAY,
  formatTime,
  formatWeekdayTime,
  parseISODate,
  tintTone,
  type LocationTint,
  type PlanShift,
} from "../../lib/myPlan";

// Shared chrome of every "My plan" component: text tokens, control classes,
// and the small name/date text helpers. Colors follow the app: slate
// neutrals, sky for the active segment (same tokens as getPillToggleClasses).

/** SPEC B1 text tokens (slate-500 is too weak on tinted grounds). */
export const TEXT_1 = "text-slate-900 dark:text-slate-100";
export const TEXT_2 = "text-slate-700 dark:text-slate-300";
export const TEXT_3 = "text-slate-600 dark:text-slate-400";
/** Tooltip of the hours sums (footer, day totals): how My plan counts hours (lib/myPlan/hours.ts). */
export const HOURS_RULE_HINT =
  "Gross shift time, counted on the start day; overlapping own shifts count once";
/** Uppercase micro label shape ("MON", "SAME DUTY"); add a text token for the color. */
export const MICRO_LABEL = "text-[11px] font-semibold uppercase leading-[14px] tracking-wide";

/** Segmented-control container (Team | My plan, Day | Week | Month, …). */
export const segmentGroupClass = cx(
  "inline-flex items-center rounded-full border border-slate-200 bg-slate-50 p-0.5",
  "dark:border-slate-700 dark:bg-slate-800/60",
);

/** One segment; active = sky like getPillToggleClasses, inactive = muted slate. */
export function segmentClass(active: boolean): string {
  return cx(
    // focus-visible:rounded-full: the global focus ring rounds to 0.5rem otherwise.
    "inline-flex items-center rounded-full transition-colors focus-visible:rounded-full",
    active
      ? "bg-sky-50 font-semibold text-sky-900 ring-1 ring-inset ring-sky-300 dark:bg-sky-900/30 dark:text-sky-100 dark:ring-sky-400/60"
      : "font-medium text-slate-600 hover:bg-white hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-slate-100",
  );
}

/** Round 32 px icon button (navigator arrows, person chevron). */
export const roundIconButtonClass = cx(
  "grid h-8 w-8 shrink-0 place-items-center rounded-full border border-slate-200 bg-white text-slate-600 focus-visible:rounded-full",
  "hover:bg-slate-50 active:bg-slate-100",
  "dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-300 dark:hover:bg-slate-800",
);

/** 36 px tool button (star, "Views"). */
export const toolButtonClass = cx(
  "inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-xl border border-slate-300 bg-white text-sm text-slate-800 shadow-sm",
  "hover:bg-slate-50 active:bg-slate-100",
  "dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800",
);

/** Floating panel (popovers, menus). */
export const popoverPanelClass = cx(
  "rounded-2xl border border-slate-200 bg-white p-4 text-slate-900 shadow-lg",
  "dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100",
);

/** Filled primary button without size (sky-700: white text ≥ 4.5:1); add height, padding, text size. */
export const solidButtonBaseClass = cx(
  "inline-flex items-center justify-center rounded-xl bg-sky-700 font-semibold text-white shadow-sm",
  "hover:bg-sky-800 disabled:cursor-not-allowed disabled:opacity-60",
);

/** Filled primary button, regular size. */
export const solidButtonClass = cx(solidButtonBaseClass, "h-9 px-4 text-sm");

/** Outline secondary button. */
export const outlineButtonClass = cx(
  "inline-flex h-9 items-center justify-center rounded-xl border border-slate-200 px-4 text-sm text-slate-700",
  "hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800",
);

/** Micro label in the muted color ("SAVED VIEWS", "WEEK"). */
export const microLabelClass = cx(MICRO_LABEL, TEXT_3);

/** Amber "Draft" badge. */
export const draftBadgeClass = cx(
  "inline-flex h-[18px] items-center rounded-full border border-amber-200 bg-amber-50 px-2 text-[11px] font-semibold text-amber-800",
  "dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-200",
);

const WEEKDAYS_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "Wednesday, 14 Oct 2026" (headings, day popover). */
export function formatLongDate(dateISO: string): string {
  const date = parseISODate(dateISO);
  return `${WEEKDAYS_LONG[date.getDay()]}, ${date.getDate()} ${MONTHS_SHORT[date.getMonth()]} ${date.getFullYear()}`;
}

/** "Wednesday 14 October" (screen-reader labels and tooltips of the body views). */
export function formatLongDay(date: Date): string {
  return `${WEEKDAYS_LONG[date.getDay()]} ${date.getDate()} ${MONTHS_LONG[date.getMonth()]}`;
}

/** "14 Oct" (day + short month). */
export function formatDayMonth(dateISO: string): string {
  const date = parseISODate(dateISO);
  return `${date.getDate()} ${MONTHS_SHORT[date.getMonth()]}`;
}

const TITLES = new Set(["dr", "dr.", "prof", "prof.", "pd", "med", "med."]);

function nameWords(name: string): string[] {
  const words = name.split(/\s+/).filter(Boolean);
  const plain = words.filter((word) => !TITLES.has(word.toLowerCase()) && !word.endsWith("."));
  return plain.length > 0 ? plain : words;
}

/** "Dr. Lena Hoffmann" → "Lena Hoffmann" (titles dropped for tight labels). */
export function displayName(name: string): string {
  const words = name.split(/\s+/).filter((word) => word && !TITLES.has(word.toLowerCase()));
  return words.length > 0 ? words.join(" ") : name;
}

/** "Dr. Lena Hoffmann" → "LH" (titles such as "Dr." / "Prof" are skipped). */
export function initialsOf(name: string): string {
  const words = nameWords(name);
  const first = words[0]?.[0] ?? "";
  const last = words.length > 1 ? words[words.length - 1][0] : "";
  return `${first}${last}`.toUpperCase() || "?";
}

/** Minutes of a day (clamped to 0–24 h) → CSS percentage of a 0–24 h track. */
export function dayPct(min: number): string {
  return `${(Math.max(0, Math.min(MINUTES_PER_DAY, min)) / MINUTES_PER_DAY) * 100}%`;
}

/** Continuation of a night on the next day: "until 08:00 · since Wed 17:00". */
export function continuationTimeText(shift: PlanShift): string {
  return `until ${formatTime(shift.endMin)} · since ${formatWeekdayTime(shift.dateISO, shift.startMin)}`;
}

/** Ground color of a location tint for the current theme (dark: the B7 dark ground). */
export function tintGround(tint: LocationTint, isDark: boolean): string {
  return tintTone(tint, isDark).ground;
}
