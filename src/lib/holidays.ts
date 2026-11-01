import type { Holiday } from "../api/client";

// Loading public holidays (date.nager.at) for a country, year and optional
// region. Reloading replaces only previously loaded holidays of that year;
// holidays added by hand stay. Regional holidays are included only for the
// chosen region (ISO 3166-2 code such as "DE-NW").

/** One entry of https://date.nager.at/api/v3/PublicHolidays/{year}/{country}. */
export type PublicHolidayApiEntry = {
  date: string;
  localName?: string;
  name?: string;
  /** true = nationwide; false = only in `counties`. */
  global?: boolean;
  counties?: string[] | null;
};

export type HolidayRegionOption = { value: string; label: string };

const GERMAN_STATES: Array<[string, string]> = [
  ["DE-BW", "Baden-Württemberg"],
  ["DE-BY", "Bayern"],
  ["DE-BE", "Berlin"],
  ["DE-BB", "Brandenburg"],
  ["DE-HB", "Bremen"],
  ["DE-HH", "Hamburg"],
  ["DE-HE", "Hessen"],
  ["DE-MV", "Mecklenburg-Vorpommern"],
  ["DE-NI", "Niedersachsen"],
  ["DE-NW", "Nordrhein-Westfalen"],
  ["DE-RP", "Rheinland-Pfalz"],
  ["DE-SL", "Saarland"],
  ["DE-SN", "Sachsen"],
  ["DE-ST", "Sachsen-Anhalt"],
  ["DE-SH", "Schleswig-Holstein"],
  ["DE-TH", "Thüringen"],
];

export const NATIONWIDE_ONLY = "";

/**
 * Region choices for a country: "Nationwide only", the German states for
 * DE, and for other countries the regions seen in the last loaded list.
 */
export function holidayRegionOptions(country: string, seenRegions: string[] = []): HolidayRegionOption[] {
  const code = country.trim().toUpperCase();
  const options: HolidayRegionOption[] = [{ value: NATIONWIDE_ONLY, label: "Nationwide only" }];
  const known = code === "DE" ? GERMAN_STATES : [];
  for (const [value, label] of known) options.push({ value, label });
  const listed = new Set(options.map((option) => option.value));
  for (const region of [...seenRegions].sort()) {
    if (region.startsWith(`${code}-`) && !listed.has(region)) {
      options.push({ value: region, label: region });
      listed.add(region);
    }
  }
  return options;
}

const holidayKey = (holiday: { dateISO: string; name: string }) => `${holiday.dateISO}__${holiday.name}`;

const toHoliday = (entry: PublicHolidayApiEntry): Holiday => ({
  dateISO: entry.date,
  name: entry.localName ?? entry.name ?? "Holiday",
  source: "public",
});

/**
 * The holiday list after loading `entries` for `year`:
 * - keeps every holiday of other years and every holiday added by hand;
 * - drops this year's previously loaded holidays (source "public", and
 *   older untagged entries that the service lists for any region);
 * - adds the nationwide holidays plus those of `region` (deduplicated).
 * Also returns the regions the service listed (for the region choice).
 */
export function mergeLoadedHolidays(
  previous: Holiday[],
  entries: PublicHolidayApiEntry[],
  year: number,
  region: string,
): { holidays: Holiday[]; added: number; regions: string[] } {
  const yearPrefix = `${year}-`;
  const listedKeys = new Set(entries.map((entry) => holidayKey(toHoliday(entry))));
  const kept = previous.filter((holiday) => {
    if (!holiday.dateISO.startsWith(yearPrefix)) return true;
    if (holiday.source === "manual") return true;
    if (holiday.source === "public") return false;
    // Older entries have no source: those the service lists were loaded.
    return !listedKeys.has(holidayKey(holiday));
  });
  const keptKeys = new Set(kept.map(holidayKey));
  const selected: Holiday[] = [];
  for (const entry of entries) {
    const applies = entry.global !== false || (!!region && (entry.counties ?? []).includes(region));
    if (!applies) continue;
    const holiday = toHoliday(entry);
    const key = holidayKey(holiday);
    if (keptKeys.has(key)) continue;
    keptKeys.add(key);
    selected.push(holiday);
  }
  const regions = Array.from(new Set(entries.flatMap((entry) => entry.counties ?? []))).sort();
  return { holidays: [...kept, ...selected], added: selected.length, regions };
}
