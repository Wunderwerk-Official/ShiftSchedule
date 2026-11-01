import { describe, expect, it } from "vitest";
import type { Holiday } from "../api/client";
import {
  HOLIDAY_REGIONS,
  filterHolidaysByRegion,
  holidayRegionForCountry,
  mergeLoadedHolidays,
  normalizeHolidayRegion,
  type NagerPublicHoliday,
} from "./holidays";

const nationwide = (date: string, localName: string): NagerPublicHoliday => ({
  date,
  localName,
  global: true,
  counties: null,
});
const regional = (date: string, localName: string, counties: string[]): NagerPublicHoliday => ({
  date,
  localName,
  global: false,
  counties,
});

// date.nager.at's answer for Germany 2026 (the start state of new accounts).
const germany2026: NagerPublicHoliday[] = [
  nationwide("2026-01-01", "Neujahr"),
  regional("2026-01-06", "Heilige Drei Könige", ["DE-BW", "DE-BY", "DE-ST"]),
  regional("2026-03-08", "Internationaler Frauentag", ["DE-BE", "DE-MV"]),
  nationwide("2026-04-03", "Karfreitag"),
  regional("2026-04-05", "Ostersonntag", ["DE-BB"]),
  nationwide("2026-04-06", "Ostermontag"),
  nationwide("2026-05-01", "Tag der Arbeit"),
  nationwide("2026-05-14", "Christi Himmelfahrt"),
  regional("2026-05-24", "Pfingstsonntag", ["DE-BB"]),
  nationwide("2026-05-25", "Pfingstmontag"),
  regional("2026-06-04", "Fronleichnam", ["DE-BW", "DE-BY", "DE-HE", "DE-NW", "DE-RP", "DE-SL"]),
  regional("2026-08-15", "Mariä Himmelfahrt", ["DE-SL"]),
  regional("2026-09-20", "Weltkindertag", ["DE-TH"]),
  nationwide("2026-10-03", "Tag der Deutschen Einheit"),
  regional("2026-10-31", "Reformationstag", [
    "DE-BB", "DE-MV", "DE-SN", "DE-ST", "DE-TH", "DE-HB", "DE-HH", "DE-NI", "DE-SH",
  ]),
  regional("2026-11-01", "Allerheiligen", ["DE-BW", "DE-BY", "DE-NW", "DE-RP", "DE-SL"]),
  regional("2026-11-18", "Buß- und Bettag", ["DE-SN"]),
  nationwide("2026-12-25", "Erster Weihnachtstag"),
  nationwide("2026-12-26", "Zweiter Weihnachtstag"),
];
const names = (holidays: NagerPublicHoliday[]) => holidays.map((holiday) => holiday.localName);

describe("filterHolidaysByRegion", () => {
  it("keeps every entry without a region, regional holidays of all regions included", () => {
    expect(filterHolidaysByRegion(germany2026)).toEqual(germany2026);
    expect(filterHolidaysByRegion(germany2026, undefined)).toHaveLength(19);
    expect(filterHolidaysByRegion(germany2026, "")).toHaveLength(19);
  });

  it("keeps the nationwide holidays and the region's own ones", () => {
    const nrw = filterHolidaysByRegion(germany2026, "DE-NW");
    expect(names(nrw)).toEqual([
      "Neujahr",
      "Karfreitag",
      "Ostermontag",
      "Tag der Arbeit",
      "Christi Himmelfahrt",
      "Pfingstmontag",
      "Fronleichnam",
      "Tag der Deutschen Einheit",
      "Allerheiligen",
      "Erster Weihnachtstag",
      "Zweiter Weihnachtstag",
    ]);
    // The holidays an NRW team got wrongly before (holiday staffing on a workday).
    expect(names(nrw)).not.toContain("Heilige Drei Könige");
    expect(names(nrw)).not.toContain("Buß- und Bettag");
    expect(names(filterHolidaysByRegion(germany2026, "DE-SN"))).toContain("Buß- und Bettag");
  });

  it("keeps nationwide entries whatever their counties say", () => {
    const entry = { global: true, counties: ["DE-BY"] };
    expect(filterHolidaysByRegion([entry], "DE-NW")).toEqual([entry]);
  });

  it("drops regional entries of other regions and entries without counties", () => {
    const entries = [
      { global: false, counties: ["DE-BY", "DE-BW"] },
      { global: false, counties: null },
      { global: false },
      { counties: [] },
    ];
    expect(filterHolidaysByRegion(entries, "DE-NW")).toEqual([]);
    expect(filterHolidaysByRegion(entries, "DE-BY")).toEqual([entries[0]]);
  });

  it("matches region codes exactly", () => {
    expect(filterHolidaysByRegion([{ global: false, counties: ["DE-NW"] }], "de-nw")).toEqual([]);
    expect(filterHolidaysByRegion([{ global: false, counties: ["IT-32"] }], "IT-3")).toEqual([]);
  });
});

describe("normalizeHolidayRegion", () => {
  it.each([
    ["DE-NW", "DE-NW"],
    ["de-nw", "DE-NW"],
    ["IT-32", "IT-32"],
    ["AT-9", "AT-9"],
    ["GB-ENG", "GB-ENG"],
  ])("keeps %s as %s", (raw, expected) => {
    expect(normalizeHolidayRegion(raw)).toBe(expected);
  });

  it.each(["", "DE", "DE-", "DE-NRWX", "DENW", "D-NW", "DE_NW", " DE-NW", "Nordrhein-Westfalen"])(
    "drops %j (same rule as the backend, no trimming)",
    (raw) => {
      expect(normalizeHolidayRegion(raw)).toBeUndefined();
    },
  );

  it.each([undefined, null, 12, true, ["DE-NW"], { code: "DE-NW" }])("drops non-strings (%j)", (raw) => {
    expect(normalizeHolidayRegion(raw)).toBeUndefined();
  });
});

describe("holidayRegionForCountry", () => {
  it("keeps a region of the country and drops one of another country", () => {
    expect(holidayRegionForCountry("DE", "DE-NW")).toBe("DE-NW");
    expect(holidayRegionForCountry(" de ", "DE-NW")).toBe("DE-NW");
    expect(holidayRegionForCountry("CH", "DE-NW")).toBeUndefined();
    expect(holidayRegionForCountry("D", "DE-NW")).toBeUndefined();
    expect(holidayRegionForCountry("DE", undefined)).toBeUndefined();
  });
});

describe("HOLIDAY_REGIONS", () => {
  it("lists the 16 German states", () => {
    expect(HOLIDAY_REGIONS.DE.regions.map((region) => region.code).sort()).toEqual([
      "DE-BB", "DE-BE", "DE-BW", "DE-BY", "DE-HB", "DE-HE", "DE-HH", "DE-MV",
      "DE-NI", "DE-NW", "DE-RP", "DE-SH", "DE-SL", "DE-SN", "DE-ST", "DE-TH",
    ]);
  });

  it("only holds stored-form codes of their own country, each once", () => {
    for (const [country, { regions }] of Object.entries(HOLIDAY_REGIONS)) {
      const codes = regions.map((region) => region.code);
      expect(new Set(codes).size).toBe(codes.length);
      for (const code of codes) {
        expect(normalizeHolidayRegion(code)).toBe(code);
        expect(holidayRegionForCountry(country, code)).toBe(code);
      }
    }
  });
});

describe("mergeLoadedHolidays", () => {
  const loadedNames = (holidays: Holiday[]) => holidays.map((holiday) => holiday.name);

  it("adds the nationwide holidays plus the region's own ones, tagged as loaded", () => {
    const { holidays, added } = mergeLoadedHolidays([], germany2026, 2026, "DE-NW");
    expect(loadedNames(holidays)).toEqual(names(filterHolidaysByRegion(germany2026, "DE-NW")));
    expect(holidays).toHaveLength(11);
    expect(holidays.every((holiday) => holiday.source === "public")).toBe(true);
    expect(holidays[0]).toEqual({ dateISO: "2026-01-01", name: "Neujahr", source: "public" });
    expect(added).toBe(11);
  });

  it("adds the regional holidays of all regions without a region, like filterHolidaysByRegion", () => {
    expect(mergeLoadedHolidays([], germany2026, 2026).holidays).toHaveLength(19);
    expect(mergeLoadedHolidays([], germany2026, 2026, "").holidays).toHaveLength(19);
  });

  it("keeps holidays added by hand and other years, and replaces this year's loaded ones", () => {
    const previous: Holiday[] = [
      { dateISO: "2026-03-02", name: "Betriebsausflug", source: "manual" },
      { dateISO: "2026-11-18", name: "Buß- und Bettag", source: "public" },
      { dateISO: "2025-12-25", name: "Erster Weihnachtstag", source: "public" },
    ];
    const { holidays, added } = mergeLoadedHolidays(previous, germany2026, 2026, "DE-NW");
    expect(loadedNames(holidays).slice(0, 2)).toEqual(["Betriebsausflug", "Erster Weihnachtstag"]);
    expect(holidays[1].dateISO).toBe("2025-12-25");
    expect(loadedNames(holidays)).not.toContain("Buß- und Bettag");
    expect(holidays).toHaveLength(2 + 11);
    expect(added).toBe(11);
  });

  it("treats older untagged entries the service lists (for any region) as loaded and keeps the rest", () => {
    const previous: Holiday[] = [
      { dateISO: "2026-11-18", name: "Buß- und Bettag" }, // loaded for all states before v1.74
      { dateISO: "2026-12-24", name: "Heiligabend (Klinik)" }, // added by hand before v1.74
    ];
    const { holidays } = mergeLoadedHolidays(previous, germany2026, 2026, "DE-NW");
    expect(loadedNames(holidays)).not.toContain("Buß- und Bettag");
    expect(holidays[0]).toEqual({ dateISO: "2026-12-24", name: "Heiligabend (Klinik)" });
    expect(holidays).toHaveLength(1 + 11);
  });

  it("does not add a loaded holiday twice when the same one was added by hand", () => {
    const previous: Holiday[] = [{ dateISO: "2026-01-01", name: "Neujahr", source: "manual" }];
    const { holidays, added } = mergeLoadedHolidays(previous, [nationwide("2026-01-01", "Neujahr")], 2026);
    expect(holidays).toEqual(previous);
    expect(added).toBe(0);
  });

  it("adds an entry the service lists twice only once", () => {
    const twice = [nationwide("2026-05-01", "Tag der Arbeit"), nationwide("2026-05-01", "Tag der Arbeit")];
    expect(mergeLoadedHolidays([], twice, 2026)).toEqual({
      holidays: [{ dateISO: "2026-05-01", name: "Tag der Arbeit", source: "public" }],
      added: 1,
    });
  });

  it("names an entry by localName, then name", () => {
    const { holidays } = mergeLoadedHolidays([], [{ date: "2026-07-14", name: "Bastille Day", global: true }], 2026);
    expect(holidays).toEqual([{ dateISO: "2026-07-14", name: "Bastille Day", source: "public" }]);
    expect(mergeLoadedHolidays([], [{ date: "2026-07-14", global: true }], 2026).holidays[0].name).toBe("Holiday");
  });
});
