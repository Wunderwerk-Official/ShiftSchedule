import { describe, expect, it } from "vitest";
import { insertVacationRange, shiftISODate, type VacationRange } from "./vacations";

const makeId = () => "vac-new";
const range = (id: string, startISO: string, endISO: string): VacationRange => ({
  id,
  startISO,
  endISO,
});

describe("shiftISODate", () => {
  it("shifts across month boundaries", () => {
    expect(shiftISODate("2026-07-31", 1)).toBe("2026-08-01");
    expect(shiftISODate("2026-08-01", -1)).toBe("2026-07-31");
  });

  it("shifts across year boundaries", () => {
    expect(shiftISODate("2026-12-31", 1)).toBe("2027-01-01");
    expect(shiftISODate("2027-01-01", -1)).toBe("2026-12-31");
  });
});

describe("insertVacationRange", () => {
  it("inserts into an empty list", () => {
    expect(insertVacationRange([], { startISO: "2026-07-06", endISO: "2026-07-10" }, makeId)).toEqual([
      range("vac-new", "2026-07-06", "2026-07-10"),
    ]);
  });

  it("returns the same reference when the range is fully covered", () => {
    const existing = [range("a", "2026-07-01", "2026-07-31")];
    const result = insertVacationRange(
      existing,
      { startISO: "2026-07-06", endISO: "2026-07-10" },
      makeId,
    );
    expect(result).toBe(existing);
  });

  it("merges an adjacent range (end + 1 day)", () => {
    const existing = [range("a", "2026-07-01", "2026-07-05")];
    const result = insertVacationRange(
      existing,
      { startISO: "2026-07-06", endISO: "2026-07-10" },
      makeId,
    );
    expect(result).toEqual([range("a", "2026-07-01", "2026-07-10")]);
  });

  it("merges an overlapping range", () => {
    const existing = [range("a", "2026-07-04", "2026-07-08")];
    const result = insertVacationRange(
      existing,
      { startISO: "2026-07-06", endISO: "2026-07-12" },
      makeId,
    );
    expect(result).toEqual([range("a", "2026-07-04", "2026-07-12")]);
  });

  it("bridges two existing ranges into one", () => {
    const existing = [range("a", "2026-07-01", "2026-07-03"), range("b", "2026-07-10", "2026-07-12")];
    const result = insertVacationRange(
      existing,
      { startISO: "2026-07-04", endISO: "2026-07-09" },
      makeId,
    );
    expect(result).toEqual([range("a", "2026-07-01", "2026-07-12")]);
  });

  it("keeps disjoint ranges separate and sorted", () => {
    const existing = [range("a", "2026-07-20", "2026-07-22")];
    const result = insertVacationRange(
      existing,
      { startISO: "2026-07-01", endISO: "2026-07-02" },
      makeId,
    );
    expect(result).toEqual([
      range("vac-new", "2026-07-01", "2026-07-02"),
      range("a", "2026-07-20", "2026-07-22"),
    ]);
  });

  it("merges across a year boundary", () => {
    const existing = [range("a", "2026-12-20", "2026-12-31")];
    const result = insertVacationRange(
      existing,
      { startISO: "2027-01-01", endISO: "2027-01-05" },
      makeId,
    );
    expect(result).toEqual([range("a", "2026-12-20", "2027-01-05")]);
  });
});
