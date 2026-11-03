// Time zone of a plan, derived from its holiday country. Mirrors
// backend/plan_timezone.py; backend/tests/test_plan_timezone.py checks that
// both maps stay identical. Shift times in the template are local wall clock
// times in this zone; durations and calendar exports use real elapsed time.

export const DEFAULT_PLAN_TIME_ZONE = "Europe/Berlin";

export const PLAN_TIME_ZONES: Record<string, string> = {
  CH: "Europe/Zurich",
  DE: "Europe/Berlin",
  ES: "Europe/Madrid",
  FR: "Europe/Paris",
  GB: "Europe/London",
  IT: "Europe/Rome",
  LU: "Europe/Luxembourg",
  NL: "Europe/Amsterdam",
  PL: "Europe/Warsaw",
  RO: "Europe/Bucharest",
  RU: "Europe/Moscow",
  UA: "Europe/Kyiv",
};

// Older zone databases only know the former name.
export const ZONE_FALLBACKS: Record<string, string> = { "Europe/Kyiv": "Europe/Kiev" };

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(zone);
  if (!formatter) {
    // Throws a RangeError for a zone the browser does not know.
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(zone, formatter);
  }
  return formatter;
}

function isKnownZone(zone: string): boolean {
  try {
    formatterFor(zone);
    return true;
  } catch {
    return false;
  }
}

/** IANA zone of the plan: the holiday country's zone, else Europe/Berlin. */
export function planTimeZone(holidayCountry?: string | null): string {
  const zone = PLAN_TIME_ZONES[(holidayCountry ?? "").trim().toUpperCase()] ?? DEFAULT_PLAN_TIME_ZONE;
  const fallback = ZONE_FALLBACKS[zone];
  return fallback && !isKnownZone(zone) ? fallback : zone;
}

/** UTC offset of `zone` at the instant (ms), from the zone's wall clock fields. */
function offsetAt(instant: number, zone: string): number {
  const fields: Record<string, number> = {};
  for (const part of formatterFor(zone).formatToParts(new Date(instant))) {
    if (part.type !== "literal") fields[part.type] = Number(part.value);
  }
  const wall = Date.UTC(
    fields.year,
    fields.month - 1,
    fields.day,
    fields.hour % 24,
    fields.minute,
    fields.second,
  );
  return wall - Math.floor(instant / 1000) * 1000;
}

// Shift times repeat (a few slot times on each day), so conversions are kept.
const MAX_CACHED = 20_000;
const utcCache = new Map<string, number>();

/**
 * UTC instant (ms) of the wall clock time `minutes` after midnight of
 * `dateISO` in `zone` (may roll into later days). Like Python's zoneinfo with
 * fold=0: a time that does not exist (spring gap) or exists twice (autumn) is
 * read with the offset in force before the change.
 */
export function wallClockToUtc(dateISO: string, minutes: number, zone: string): number {
  const key = `${zone}|${dateISO}|${minutes}`;
  const cached = utcCache.get(key);
  if (cached !== undefined) return cached;
  const [year, month, day] = dateISO.split("-").map(Number);
  const wall = Date.UTC(year, (month ?? 1) - 1, day ?? 1) + minutes * MINUTE_MS;
  // Offsets a day before and after; they differ when a change lies in between.
  const before = offsetAt(wall - DAY_MS, zone);
  const after = offsetAt(wall + DAY_MS, zone);
  const early = wall - before;
  const late = wall - after;
  const result =
    before === after || offsetAt(early, zone) === before || offsetAt(late, zone) !== after ? early : late;
  if (utcCache.size >= MAX_CACHED) utcCache.clear();
  utcCache.set(key, result);
  return result;
}

/**
 * Real minutes from `startMin` to `endMin` (wall clock minutes after midnight
 * of the start day, end may lie on a later day) in `zone`: a 20:00–08:00
 * night lasts 13 h when the clocks go back and 11 h when they go forward.
 */
export function elapsedMinutes(dateISO: string, startMin: number, endMin: number, zone: string): number {
  return Math.round(
    (wallClockToUtc(dateISO, endMin, zone) - wallClockToUtc(dateISO, startMin, zone)) / MINUTE_MS,
  );
}
