import { describe, expect, it } from "vitest";
import type { Holiday } from "../api/client";
import { holidayRegionOptions, mergeLoadedHolidays, type PublicHolidayApiEntry } from "./holidays";

const api: PublicHolidayApiEntry[] = [
  { date: "2026-01-01", localName: "Neujahr", global: true, counties: null },
  { date: "2026-06-04", localName: "Fronleichnam", global: false, counties: ["DE-BW", "DE-BY", "DE-NW"] },
  { date: "2026-10-31", localName: "Reformationstag", global: false, counties: ["DE-BB", "DE-SN"] },
  { date: "2026-11-01", localName: "Allerheiligen", global: false, counties: ["DE-NW", "DE-BY"] },
];

describe("mergeLoadedHolidays", () => {
  it("adds the nationwide holidays plus those of the chosen region", () => {
    const { holidays, added } = mergeLoadedHolidays([], api, 2026, "DE-NW");
    expect(holidays.map((h) => h.name)).toEqual(["Neujahr", "Fronleichnam", "Allerheiligen"]);
    expect(holidays.every((h) => h.source === "public")).toBe(true);
    expect(added).toBe(3);
    expect(mergeLoadedHolidays([], api, 2026, "").holidays.map((h) => h.name)).toEqual(["Neujahr"]);
  });

  it("keeps holidays added by hand and other years, and replaces earlier loaded ones", () => {
    const previous: Holiday[] = [
      { dateISO: "2026-03-02", name: "Betriebsausflug", source: "manual" },
      { dateISO: "2026-10-31", name: "Reformationstag", source: "public" },
      { dateISO: "2025-12-25", name: "Weihnachten", source: "public" },
    ];
    const { holidays } = mergeLoadedHolidays(previous, api, 2026, "DE-NW");
    expect(holidays.map((h) => h.name)).toEqual([
      "Betriebsausflug", "Weihnachten", "Neujahr", "Fronleichnam", "Allerheiligen",
    ]);
  });

  it("treats older untagged entries the service lists as loaded and keeps the rest", () => {
    const previous: Holiday[] = [
      { dateISO: "2026-10-31", name: "Reformationstag" }, // loaded before v1.71 (all states)
      { dateISO: "2026-12-24", name: "Heiligabend (Klinik)" }, // added by hand before v1.71
    ];
    const { holidays } = mergeLoadedHolidays(previous, api, 2026, "DE-NW");
    expect(holidays.map((h) => h.name)).toEqual(["Heiligabend (Klinik)", "Neujahr", "Fronleichnam", "Allerheiligen"]);
  });

  it("does not add a loaded holiday twice when the same one was added by hand", () => {
    const previous: Holiday[] = [{ dateISO: "2026-01-01", name: "Neujahr", source: "manual" }];
    const { holidays, added } = mergeLoadedHolidays(previous, api, 2026, "");
    expect(holidays).toEqual(previous);
    expect(added).toBe(0);
  });

  it("reports the regions the service listed", () => {
    expect(mergeLoadedHolidays([], api, 2026, "").regions).toEqual(["DE-BB", "DE-BW", "DE-BY", "DE-NW", "DE-SN"]);
  });
});

describe("holidayRegionOptions", () => {
  it("offers the German states for DE and seen regions for other countries", () => {
    const de = holidayRegionOptions("de");
    expect(de[0]).toEqual({ value: "", label: "Nationwide only" });
    expect(de).toContainEqual({ value: "DE-NW", label: "Nordrhein-Westfalen" });
    expect(de).toHaveLength(17);
    expect(holidayRegionOptions("AT", ["AT-9", "DE-NW"]).map((o) => o.value)).toEqual(["", "AT-9"]);
  });
});
