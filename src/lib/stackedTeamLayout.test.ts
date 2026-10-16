import { describe, expect, it } from "vitest";
import { buildCalendarRows, type DayColumn } from "./calendarView";
import type { ScheduleRow } from "./shiftRows";
import { buildStackedColumns, buildStackedTeamLayout, buildTimeLanes } from "./stackedTeamLayout";

const slot = (id: string, overrides: Partial<ScheduleRow> = {}): ScheduleRow => ({
  id,
  name: "CT",
  kind: "class",
  dotColorClass: "bg-slate-200",
  sectionId: "sec-ct",
  sectionName: "CT",
  locationId: "loc-a",
  locationName: "Campus",
  rowBandId: "rb-ct",
  rowBandLabel: "CT",
  dayType: "mon",
  colBandOrder: 1,
  startTime: "07:00",
  endTime: "15:00",
  ...overrides,
});

const column = (
  dateISO: string,
  dayType: DayColumn["dayType"],
  colOrder: number,
  columnIndex: number,
): DayColumn => ({
  date: new Date(`${dateISO}T00:00:00`),
  dateISO,
  dayType,
  colOrder,
  isFirstInDay: colOrder === 1,
  dayIndex: 0,
  columnIndex,
  columnTimeLabel: "07:00 - 15:00",
  columnHasMixedTimes: false,
});

// Monday and Tuesday, two time columns each (early / late).
const columns: DayColumn[] = [
  column("2026-01-05", "mon", 1, 0),
  column("2026-01-05", "mon", 2, 1),
  column("2026-01-06", "tue", 1, 2),
  column("2026-01-06", "tue", 2, 3),
];

const ids = (lanes: ScheduleRow[][]) => lanes.map((lane) => lane.map((s) => s.id));

describe("buildTimeLanes", () => {
  it("opens the lanes on the day with the most columns, in column order", () => {
    const lanes = buildTimeLanes([
      slot("tue-late", { dayType: "tue", colBandOrder: 2, startTime: "14:00", endTime: "22:00" }),
      slot("mon-early"),
      slot("mon-late", { colBandOrder: 2, startTime: "14:00", endTime: "22:00" }),
      slot("mon-night", { colBandOrder: 3, startTime: "22:00", endTime: "07:00", endDayOffset: 1 }),
    ]);
    expect(ids(lanes)).toEqual([["mon-early"], ["mon-late", "tue-late"], ["mon-night"]]);
  });

  it("puts a weekend shift into the lane of the same time, whatever its column number", () => {
    // The weekend has two columns: its night shift is column 2, not 3.
    const lanes = buildTimeLanes([
      slot("mon-early"),
      slot("mon-late", { colBandOrder: 2, startTime: "14:00", endTime: "22:00" }),
      slot("mon-night", { colBandOrder: 3, startTime: "22:00", endTime: "07:00", endDayOffset: 1 }),
      slot("sat-day", { dayType: "sat", startTime: "08:00", endTime: "20:00" }),
      slot("sat-night", { dayType: "sat", colBandOrder: 2, startTime: "22:00", endTime: "07:00", endDayOffset: 1 }),
    ]);
    // The day shift has no lane of its time: it joins the nearest start (early).
    expect(ids(lanes)).toEqual([["mon-early", "sat-day"], ["mon-late"], ["mon-night", "sat-night"]]);
  });

  it("keeps a shorter shift in its lane by the nearest start", () => {
    const lanes = buildTimeLanes([
      slot("thu-early", { dayType: "thu" }),
      slot("thu-late", { dayType: "thu", colBandOrder: 2, startTime: "12:00", endTime: "20:30" }),
      slot("fri-early", { dayType: "fri" }),
      slot("fri-late", { dayType: "fri", colBandOrder: 2, startTime: "12:00", endTime: "19:00" }),
    ]);
    expect(ids(lanes)).toEqual([["thu-early", "fri-early"], ["thu-late", "fri-late"]]);
  });

  it("tells same-time columns apart by their section", () => {
    const senior = { sectionId: "sec-senior", sectionName: "Senior" };
    const lanes = buildTimeLanes([
      slot("mon-ct"),
      slot("mon-senior", { colBandOrder: 2, ...senior }),
      // Tuesday lists the senior column first.
      slot("tue-senior", { dayType: "tue", ...senior }),
      slot("tue-ct", { dayType: "tue", colBandOrder: 2 }),
    ]);
    expect(ids(lanes)).toEqual([["mon-ct", "tue-ct"], ["mon-senior", "tue-senior"]]);
  });

  it("measures the nearest start on the clock, across midnight", () => {
    const lanes = buildTimeLanes([
      slot("mon-late", { startTime: "14:00", endTime: "22:00" }),
      slot("mon-night", { colBandOrder: 2, startTime: "22:00", endTime: "06:00", endDayOffset: 1 }),
      slot("sat-night", { dayType: "sat", startTime: "00:00", endTime: "08:00" }),
    ]);
    expect(ids(lanes)).toEqual([["mon-late"], ["mon-night", "sat-night"]]);
  });

  it("gives two slots of one day their own lanes, also without valid times", () => {
    const lanes = buildTimeLanes([
      slot("a", { startTime: undefined }),
      slot("b", { startTime: undefined }),
      slot("c", { dayType: "tue", startTime: undefined }),
    ]);
    expect(ids(lanes)).toEqual([["a", "c"], ["b"]]);
  });
});

describe("buildStackedColumns", () => {
  it("keeps one column per day, renumbered and without column times", () => {
    const result = buildStackedColumns(columns);
    expect(result.map((c) => [c.dateISO, c.colOrder, c.isFirstInDay, c.columnIndex])).toEqual([
      ["2026-01-05", 1, true, 0],
      ["2026-01-06", 1, true, 1],
    ]);
    expect(result.every((c) => c.columnTimeLabel === undefined && !c.columnHasMixedTimes)).toBe(true);
  });
});

describe("buildStackedTeamLayout", () => {
  const pool: ScheduleRow = { id: "pool-rest-day", name: "Rest Day", kind: "pool", dotColorClass: "bg-slate-200" };
  const scheduleRows: ScheduleRow[] = [
    slot("ct-mon-early"),
    slot("ct-tue-early", { dayType: "tue" }),
    slot("ct-mon-late", { colBandOrder: 2, startTime: "14:00", endTime: "22:00" }),
    // Tuesday's late shift ends earlier: the cell shows its own time.
    slot("ct-tue-late", { dayType: "tue", colBandOrder: 2, startTime: "14:00", endTime: "20:00" }),
    // A Saturday-only night band: hidden in a Monday–Tuesday view.
    slot("ct-sat-night", { dayType: "sat", colBandOrder: 3, startTime: "22:00", endTime: "07:00", endDayOffset: 1 }),
    slot("ct-sat-a", { dayType: "sat", startTime: "06:00", endTime: "07:00" }),
    slot("ct-sat-b", { dayType: "sat", colBandOrder: 2, startTime: "13:00", endTime: "14:00" }),
    // Another row band whose second column holds another section.
    slot("mr-mon", { rowBandId: "rb-mr", rowBandLabel: "MR", sectionId: "sec-mr", sectionName: "MR", name: "MR" }),
    slot("mr-mon-senior", {
      rowBandId: "rb-mr",
      rowBandLabel: "MR",
      sectionId: "sec-senior",
      sectionName: "Senior",
      name: "Senior",
      colBandOrder: 2,
    }),
    pool,
  ];
  const layout = buildStackedTeamLayout(buildCalendarRows(scheduleRows), columns);
  const ctGroup = "group-loc-a__rb-ct";
  const mrGroup = "group-loc-a__rb-mr";

  it("splits each row into its time lanes with slots on the visible days", () => {
    expect(layout.rows.map((row) => row.id)).toEqual([
      `${ctGroup}__t1`,
      `${ctGroup}__t2`,
      `${mrGroup}__t1`,
      `${mrGroup}__t2`,
      "pool-rest-day",
    ]);
    expect(layout.columns).toHaveLength(2);
  });

  it("moves a lane's slots to column 1 and keeps their ids", () => {
    const late = layout.rows[1];
    expect(late.slotRows?.map((s) => [s.id, s.dayType, s.colBandOrder])).toEqual([
      ["ct-mon-late", "mon", 1],
      ["ct-tue-late", "tue", 1],
      ["ct-sat-b", "sat", 1],
    ]);
    // The source rows stay untouched.
    expect(scheduleRows[2].colBandOrder).toBe(2);
  });

  it("names the row on its first lane and puts each lane's time in the label", () => {
    expect(layout.metaByRowId.get(`${ctGroup}__t1`)).toEqual({
      sourceRowId: ctGroup,
      groupLabel: "CT",
      title: undefined,
      sectionName: "CT",
      timeLabel: "07:00 - 15:00",
      isFirstInGroup: true,
      isLastInGroup: false,
    });
    expect(layout.metaByRowId.get(`${ctGroup}__t2`)).toMatchObject({
      groupLabel: undefined,
      // A tie (one Monday, one Tuesday time) goes to the first day.
      timeLabel: "14:00 - 22:00",
      isFirstInGroup: false,
      isLastInGroup: true,
    });
  });

  it("titles a lane whose section is not the row's own name", () => {
    expect(layout.metaByRowId.get(`${mrGroup}__t1`)?.title).toBeUndefined();
    expect(layout.metaByRowId.get(`${mrGroup}__t2`)).toMatchObject({
      title: "Senior",
      sectionName: "Senior",
    });
  });

  it("passes pool rows through without meta", () => {
    expect(layout.rows.at(-1)).toBe(pool);
    expect(layout.metaByRowId.has("pool-rest-day")).toBe(false);
  });

  it("keeps a row with one lane under its own id", () => {
    const single = buildStackedTeamLayout(buildCalendarRows([slot("only")]), columns);
    expect(single.rows.map((row) => row.id)).toEqual([ctGroup]);
    expect(single.metaByRowId.get(ctGroup)).toMatchObject({ isFirstInGroup: true, isLastInGroup: true });
  });

  it("keeps one inactive row for a row without any slot on the visible days", () => {
    const weekendOnly = buildStackedTeamLayout(
      buildCalendarRows([slot("sat-a", { dayType: "sat" }), slot("sat-b", { dayType: "sat", colBandOrder: 2 })]),
      columns,
    );
    expect(weekendOnly.rows.map((row) => row.id)).toEqual([ctGroup]);
    expect(weekendOnly.rows[0].slotRows?.map((s) => s.id)).toEqual(["sat-a"]);
    expect(weekendOnly.metaByRowId.get(ctGroup)).toMatchObject({ groupLabel: "CT", timeLabel: undefined });
  });

  it("names a later lane without its own time by its section", () => {
    const result = buildStackedTeamLayout(
      buildCalendarRows([slot("a"), slot("b", { colBandOrder: 2, startTime: undefined })]),
      columns,
    );
    expect(result.metaByRowId.get(`${ctGroup}__t2`)).toMatchObject({ title: "CT", timeLabel: undefined });
  });

  it("moves an ungrouped class row to column 1", () => {
    const plain = slot("plain", { rowBandLabel: undefined, colBandOrder: 2 });
    const result = buildStackedTeamLayout([plain], columns);
    expect(result.rows).toEqual([{ ...plain, colBandOrder: 1 }]);
    expect(result.metaByRowId.get("plain")).toMatchObject({ groupLabel: "CT", timeLabel: "07:00 - 15:00" });
  });
});
