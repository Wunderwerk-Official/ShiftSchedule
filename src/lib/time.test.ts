import { describe, expect, it } from "vitest";
import { parseTimeToMinutes } from "./time";

describe("parseTimeToMinutes", () => {
  it("parses HH:MM and H:MM", () => {
    expect(parseTimeToMinutes("08:00")).toBe(480);
    expect(parseTimeToMinutes("23:59")).toBe(23 * 60 + 59);
    expect(parseTimeToMinutes(" 8:05 ")).toBe(485);
  });

  it("rejects out-of-range, malformed and empty values", () => {
    for (const value of ["24:00", "12:60", "08:00:00", "8", "ab:cd", "", undefined]) {
      expect(parseTimeToMinutes(value)).toBeNull();
    }
  });
});
