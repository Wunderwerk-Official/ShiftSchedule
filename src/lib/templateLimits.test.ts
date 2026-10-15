import { describe, expect, it } from "vitest";
import type { WeeklyCalendarTemplate } from "../api/client";
import { countTemplateColBands, MAX_TOTAL_COLBANDS } from "./templateLimits";

const location = (locationId: string, colBands: number) =>
  ({
    locationId,
    rowBands: [],
    slots: [],
    colBands: Array.from({ length: colBands }, (_, index) => ({
      id: `${locationId}-col-${index}`,
      dayType: "mon",
      order: index + 1,
    })),
  }) as unknown as WeeklyCalendarTemplate["locations"][number];

describe("countTemplateColBands", () => {
  it("sums the column bands of every location", () => {
    const template = {
      version: 4,
      blocks: [],
      locations: [location("a", 150), location("b", 151)],
    } as unknown as WeeklyCalendarTemplate;
    expect(countTemplateColBands(template)).toBe(301);
    expect(countTemplateColBands(template) > MAX_TOTAL_COLBANDS).toBe(true);
  });

  it("is 0 without a template or locations", () => {
    expect(countTemplateColBands(undefined)).toBe(0);
    expect(countTemplateColBands({} as WeeklyCalendarTemplate)).toBe(0);
  });

  it("keeps the save limit at 300", () => {
    expect(MAX_TOTAL_COLBANDS).toBe(300);
  });
});
