import type { CSSProperties } from "react";
import type { Location } from "../../api/client";
import { cx } from "../../lib/classNames";
import {
  MINUTES_PER_DAY,
  deriveDarkBlockColors,
  deriveLocationShortName,
  locationTint,
  personTone,
  type BlockColors,
  type LocationTint,
  type PersonPlan,
  type PersonTone,
  type PlanDay,
  type PlanShift,
} from "../../lib/myPlan";
import { TEXT_1, TEXT_2, initialsOf, tintGround } from "./planChrome";
import type { BlockCoworker } from "./types";

// Small building blocks shared by all views (week/day/month × top/left):
// day header tones and grounds, location tint, location chips, avatars,
// the day number with the today ring.

/** Holiday / weekend tone of a day header or date cell; undefined on workdays. */
export function dayHeadTone(day: PlanDay): string | undefined {
  if (day.holidayName) return "bg-purple-100 dark:bg-[#2E1F47]";
  if (day.isWeekend) return "bg-slate-100 dark:bg-slate-800";
  return undefined;
}

/** Header / date-cell background by day type (holiday › weekend › workday). */
export function dayHeadClass(day: PlanDay): string {
  return dayHeadTone(day) ?? "bg-slate-50 dark:bg-[#131C2E]";
}

/** Neutral ground of a day's time area (weekend slightly grey). */
export function dayGroundClass(day: PlanDay): string {
  return day.isWeekend ? "bg-slate-50 dark:bg-[#131C2E]" : "bg-white dark:bg-slate-900";
}

/** Location tint of the day's time area: the light or the dark (SPEC B7) ground. */
export function tintStyle(tint: LocationTint | null | undefined, isDark: boolean): CSSProperties {
  if (!tint) return {};
  return { backgroundColor: tintGround(tint, isDark) };
}

/**
 * Two locations on one day (SPEC R9): the 0–24 h ground as hard-stop
 * gradient bands along the time axis, split by a 1 px line; null otherwise.
 */
export function tintBandsImage(day: PlanDay, isDark: boolean, axis: "vertical" | "horizontal"): string | null {
  if (day.tintBands.length < 2) return null;
  const line = isDark ? "#475569" : "#CBD5E1";
  const pct = (min: number) => `${(min / MINUTES_PER_DAY) * 100}%`;
  const stops: string[] = [];
  day.tintBands.forEach((band, index) => {
    const color = band.tint ? tintGround(band.tint, isDark) : "transparent";
    const from = pct(band.startMin);
    if (index > 0) stops.push(`${line} ${from}`, `${line} calc(${from} + 1px)`, `${color} calc(${from} + 1px)`);
    else stops.push(`${color} ${from}`);
    stops.push(`${color} ${pct(band.endMin)}`);
  });
  return `linear-gradient(${axis === "vertical" ? "to bottom" : "to right"}, ${stops.join(", ")})`;
}

/** Ground of a day's 0–24 h time area: the split bands of two locations, else the day tint. */
export function dayTintStyle(day: PlanDay, isDark: boolean, axis: "vertical" | "horizontal"): CSSProperties {
  const bands = tintBandsImage(day, isDark, axis);
  return bands ? { backgroundImage: bands } : tintStyle(day.tint, isDark);
}

/** Duty palette for dark mode (SPEC B5/B10): light indigo instead of the near-black light-mode fill. */
export const DUTY_COLORS_DARK: BlockColors = {
  fill: "#A5B4FC",
  border: "#C7D2FE",
  text: "#1E1B4B",
  secondaryText: "#312E81",
};

/** Inline block colors for the theme (dark mode: the light duty palette, toned-down sections). */
export function blockColorsOf(shift: Pick<PlanShift, "kind" | "colors">, isDark: boolean): BlockColors {
  if (!isDark) return shift.colors;
  return shift.kind === "duty" ? DUTY_COLORS_DARK : deriveDarkBlockColors(shift.colors.fill);
}

/** "free" only in published weeks (SPEC R10): an unpublished empty day is not free yet. */
export function showsFree(day: PlanDay): boolean {
  return day.isFree && day.published;
}

/** Caption of a rest band that starts after a continuation: "after Nachtdienst". */
export function restAfterCaption(plan: PersonPlan, day: PlanDay): string | undefined {
  const rest = day.absences.find((absence) => absence.kind === "rest");
  if (!rest || rest.startMin <= 0) return undefined;
  const continuation = day.segments.find((segment) => segment.cutStart);
  const shift = continuation ? plan.shifts.get(continuation.shiftId) : undefined;
  return shift ? `after ${shift.title}` : "after the shift";
}

/** Passepartout around blocks (SPEC R6): 2 px of the card surface. */
export const PASSEPARTOUT = "shadow-[0_0_0_2px_#FFFFFF] dark:shadow-[0_0_0_2px_#0F172A]";

export function tintOfLocation(
  locationsById: Map<string, Location>,
  locationId?: string,
): LocationTint | null {
  if (!locationId) return null;
  return locationTint(locationsById.get(locationId)?.color);
}

/**
 * "Klinikum Mitte" → "Mitte", "Konferenzen" → "Konf." for narrow cells (≤ 8
 * characters, mini chips ≤ 5); the full name stays in the title.
 */
export function shortLocationName(name: string, max = 8): string {
  return deriveLocationShortName(name, max);
}

type LocationChipProps = {
  location?: Location;
  /** Fallback name when the location is not in the map. */
  name?: string;
  size?: "md" | "sm" | "mini";
  /** Short name ("Mitte") at any size; "mini" is always short. */
  short?: boolean;
  className?: string;
};

// Chip + ink of a location tint for both themes: CSS variables read by
// light / dark: classes, so chips need no isDark prop.
const TINT_CHIP_CLASS =
  "bg-[var(--tint-chip)] text-[var(--tint-ink)] dark:bg-[var(--tint-chip-dark)] dark:text-[var(--tint-ink-dark)]";

function tintChipVars(tint: LocationTint): CSSProperties {
  return {
    "--tint-chip": tint.chip,
    "--tint-ink": tint.ink,
    "--tint-chip-dark": tint.dark.chip,
    "--tint-ink-dark": tint.dark.ink,
  } as CSSProperties;
}

/** Location chip (SPEC C5.2): chip/ink of the location color (B7 dark set in dark mode), neutral without one. */
export function LocationChip({ location, name, size = "md", short = false, className }: LocationChipProps) {
  const label = location?.name ?? name;
  if (!label) return null;
  const tint = locationTint(location?.color);
  const abbreviated = size === "mini" || short;
  const text = abbreviated ? shortLocationName(label, size === "mini" ? 5 : 8) : label;
  return (
    <span
      title={label}
      className={cx(
        "inline-flex items-center whitespace-nowrap text-[11px] font-semibold",
        // A short name never shrinks below its text; full names truncate.
        abbreviated ? "shrink-0" : "max-w-full truncate",
        size === "mini" ? "h-4 rounded px-1" : "rounded-full",
        size === "md" && "h-5 px-2",
        size === "sm" && "h-[18px] px-1.5",
        tint ? TINT_CHIP_CLASS : "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200",
        className,
      )}
      style={tint ? tintChipVars(tint) : undefined}
    >
      <span className="truncate">{text}</span>
    </span>
  );
}

type LocationChipsProps = {
  ids: string[];
  locationsById: Map<string, Location>;
  size?: LocationChipProps["size"];
  short?: boolean;
  /** Chips shown before "+N" (the full list is in the "+N" tooltip). */
  max?: number;
  /**
   * With max > 1: further chips only while their (short) names together stay
   * within this many characters — two chips where they fit (SPEC R9).
   */
  maxChars?: number;
  /** Narrow columns: centered, "+N" wraps to the next line when it does not fit. */
  wrap?: boolean;
  className?: string;
};

/**
 * Every start location of a day: up to `max` chips, then "+N" with all names
 * in the title. When some are hidden, colored locations come first — the one
 * that tints the day is not the one behind "+N".
 */
export function LocationChips({
  ids,
  locationsById,
  size = "md",
  short = false,
  max = 1,
  maxChars,
  wrap = false,
  className,
}: LocationChipsProps) {
  if (ids.length === 0) return null;
  const chipText = (id: string) => {
    const name = locationsById.get(id)?.name ?? id;
    return size === "mini" || short ? shortLocationName(name, size === "mini" ? 5 : 8) : name;
  };
  const colored = (id: string) => !!locationTint(locationsById.get(id)?.color);
  const coloredFirst = [...ids.filter(colored), ...ids.filter((id) => !colored(id))];
  let count = 1;
  let chars = chipText(coloredFirst[0]).length;
  while (count < Math.min(max, ids.length)) {
    chars += chipText(coloredFirst[count]).length;
    if (maxChars !== undefined && chars > maxChars) break;
    count += 1;
  }
  // All fit: start order. Some hidden: the colored ones stay visible.
  const shown = count === ids.length ? ids : coloredFirst.slice(0, count);
  const hidden = ids.length - shown.length;
  const names = ids.map((id) => locationsById.get(id)?.name ?? id).join(", ");
  return (
    <span
      className={cx(
        "flex min-w-0 max-w-full items-center",
        wrap ? "flex-wrap justify-center gap-x-0.5" : "gap-1",
        className,
      )}
    >
      {shown.map((id) => (
        <LocationChip key={id} location={locationsById.get(id)} name={id} size={size} short={short} />
      ))}
      {hidden > 0 ? (
        <span
          title={names}
          aria-label={`${hidden} more: ${names}`}
          className={cx("shrink-0 text-[11px] font-semibold leading-4 tabular-nums", TEXT_2)}
        >
          +{hidden}
        </span>
      ) : null}
    </span>
  );
}

/** Location tag inside a block (continuations, days with two locations, day view). */
export function LocationTag({ name, tint }: { name: string; tint: LocationTint | null }) {
  return (
    <span
      title={name}
      className={cx(
        "inline-flex h-[18px] max-w-full shrink-0 items-center truncate rounded-md border border-slate-300 px-1.5 text-[11px] font-semibold dark:border-slate-600",
        tint ? TINT_CHIP_CLASS : "bg-white text-slate-700 dark:bg-slate-900 dark:text-slate-200",
      )}
      style={tint ? tintChipVars(tint) : undefined}
    >
      <span className="truncate">{name}</span>
    </span>
  );
}

/**
 * Initials circle (SPEC C5.1). `tone` = the person's color (personTone of the
 * clinician list index, as in the team plan); neutral slate without one.
 * `ring` draws a 2 px ring in that color (avatars overlapping on a block).
 */
export function Avatar({
  name,
  size = "s",
  tone,
  ring,
  className,
}: {
  name: string;
  size?: "s" | "m" | "l";
  tone?: PersonTone;
  ring?: string;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        "inline-grid shrink-0 place-items-center rounded-full font-semibold leading-none",
        !tone && "bg-slate-700 text-white dark:bg-slate-200 dark:text-slate-900",
        size === "s" && "h-5 w-5 text-[11px]",
        size === "m" && "h-6 w-6 text-[11px]",
        size === "l" && "h-8 w-8 text-xs",
        className,
      )}
      style={{
        ...(tone ? { backgroundColor: tone.strong, color: tone.onStrong } : null),
        ...(ring ? { boxShadow: `0 0 0 2px ${ring}` } : null),
      }}
    >
      {initialsOf(name)}
    </span>
  );
}

/**
 * "with" + avatars of the same duty on a large block (SPEC C5.5 / C5.6): at
 * most 3 in person colors, then "+N". They sit edge to edge; the 2 px ring in
 * the block fill cuts only 2 px into the previous circle, so two-letter
 * initials ("JM") stay readable.
 */
export function WithAvatars({
  people,
  ring,
  isDark,
  color,
}: {
  people: BlockCoworker[];
  /** Block fill: the 2 px ring that separates overlapping avatars. */
  ring: string;
  isDark: boolean;
  /** Secondary text color of the block. */
  color?: string;
}) {
  const shown = people.slice(0, 3);
  const more = people.length - shown.length;
  return (
    <span
      className="flex items-center gap-1.5 text-[11px] leading-[14px]"
      style={color ? { color } : undefined}
      title={`With ${people.map((person) => person.name).join(", ")}`}
    >
      with
      <span className="inline-flex">
        {shown.map((person) => (
          <Avatar
            key={person.clinicianId}
            name={person.name}
            tone={personTone(person.colorIndex, isDark)}
            ring={ring}
          />
        ))}
      </span>
      {more > 0 ? <span className="tabular-nums">+{more}</span> : null}
    </span>
  );
}

/** Today marker around the day number (SPEC C5.3): 1.5 px ring in the "now" color. */
export function DayNumber({
  day,
  size = "md",
}: {
  day: PlanDay;
  size?: "md" | "lg" | "sm";
}) {
  const number = day.date.getDate();
  if (!day.isToday) {
    return (
      <span
        className={cx(
          "font-semibold tabular-nums",
          TEXT_1,
          size === "lg" ? "text-xl leading-[26px]" : "text-[15px] leading-5",
        )}
      >
        {number}
      </span>
    );
  }
  return (
    <span
      className={cx(
        "inline-grid place-items-center rounded-full font-semibold tabular-nums",
        TEXT_1,
        size === "lg" ? "h-8 w-8 text-[15px]" : size === "sm" ? "h-6 w-6 text-[13px]" : "h-[26px] w-[26px] text-[13px]",
      )}
      style={{ boxShadow: "inset 0 0 0 1.5px currentColor" }}
    >
      {number}
    </span>
  );
}
