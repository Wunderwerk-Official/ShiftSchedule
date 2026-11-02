import { describe, expect, it } from "vitest";
import { buildCalendarRows, type DayColumn } from "./calendarView";
import type { ScheduleRow } from "./shiftRows";
import {
  buildSectionLanes,
  buildStackedColumns,
  buildStackedTeamLayout,
  buildTimeLanes,
} from "./stackedTeamLayout";

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

  it("opens a lane of its own for a slot that overlaps no free lane, however near its start", () => {
    const lanes = buildTimeLanes([
      slot("wed-pm", { dayType: "wed", startTime: "13:00", endTime: "16:00" }),
      slot("wed-eve", { dayType: "wed", colBandOrder: 2, startTime: "16:00", endTime: "19:00" }),
      // Touches the 13:00 lane only: a lane of its own.
      slot("mon-am", { startTime: "07:30", endTime: "13:00" }),
      // Overlaps the 13:00 lane: joins it (its cell shows its own time).
      slot("fri-pm", { dayType: "fri", startTime: "12:00", endTime: "15:00" }),
    ]);
    expect(ids(lanes)).toEqual([["wed-pm", "fri-pm"], ["wed-eve"], ["mon-am"]]);
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

describe("buildSectionLanes", () => {
  const sec = (name: string) => ({ sectionId: `sec-${name}`, sectionName: name, name });
  const lanes = (slots: ScheduleRow[]) =>
    buildSectionLanes(slots).map((lane) => `${lane.sectionName}: ${lane.slots.map((s) => s.id).join(" ")}`);
  // The user's "IRM HK" row: sections rotate per weekday over the same three
  // time columns (07:30 / 13:00 / 16:00).
  const rotating = [
    slot("mon-1", { ...sec("Cardio"), startTime: "07:30", endTime: "13:00" }),
    slot("mon-2", { ...sec("Neuro"), colBandOrder: 2, startTime: "13:00", endTime: "16:00" }),
    slot("mon-3", { ...sec("Neuro"), colBandOrder: 3, startTime: "16:00", endTime: "19:00" }),
    slot("tue-1", { ...sec("Prostate"), dayType: "tue", startTime: "07:30", endTime: "13:00" }),
    slot("tue-2", { ...sec("Neuro"), dayType: "tue", colBandOrder: 2, startTime: "13:00", endTime: "16:00" }),
    slot("wed-1", { ...sec("Cardio"), dayType: "wed", startTime: "07:30", endTime: "13:00" }),
    slot("wed-2", { ...sec("Prostate"), dayType: "wed", colBandOrder: 2, startTime: "13:00", endTime: "16:00" }),
  ];

  it("never puts two sections into one lane", () => {
    const result = buildSectionLanes(rotating);
    for (const lane of result) {
      expect(new Set(lane.slots.map((s) => s.sectionId))).toEqual(new Set([`sec-${lane.sectionName}`]));
    }
    // Before v1.76 Monday's Neuro and Tuesday's Prostate shared the 13:00
    // lane. Prostate's morning (Tue) and afternoon (Wed) do not overlap: a
    // lane each, hatched on the other day.
    expect(lanes(rotating)).toEqual([
      "Cardio: mon-1 wed-1",
      "Prostate: tue-1",
      "Prostate: wed-2",
      "Neuro: mon-2 tue-2",
      "Neuro: mon-3",
    ]);
  });

  it("gives a section's separate time blocks on different days a lane each, so no cell differs from its lane's time", () => {
    // The user's IRM cardio HK: Monday and Thursday mornings, Wednesday
    // afternoon and evening. Wednesday opens the lanes; Monday's 07:30 must
    // not join the 13:00 lane by the nearest start (they only touch).
    const cardio = [
      slot("mon-1", { ...sec("Cardio"), startTime: "07:30", endTime: "13:00" }),
      slot("wed-2", { ...sec("Cardio"), dayType: "wed", colBandOrder: 2, startTime: "13:00", endTime: "16:00" }),
      slot("wed-3", { ...sec("Cardio"), dayType: "wed", colBandOrder: 3, startTime: "16:00", endTime: "19:00" }),
      slot("thu-1", { ...sec("Cardio"), dayType: "thu", startTime: "07:30", endTime: "13:00" }),
    ];
    const result = buildSectionLanes(cardio);
    expect(lanes(cardio)).toEqual(["Cardio: mon-1 thu-1", "Cardio: wed-2", "Cardio: wed-3"]);
    for (const lane of result) {
      expect(new Set(lane.slots.map((s) => `${s.startTime}-${s.endTime}`)).size).toBe(1);
    }
  });

  it("orders sections by earliest start, then first slot in column order, then name", () => {
    expect(
      lanes([
        // Mon column 2 comes before Tue column 1 in template column order.
        slot("tue-b", { ...sec("Beta"), dayType: "tue", startTime: "08:00", endTime: "12:00" }),
        slot("mon-late", { ...sec("Late"), startTime: "06:00", endTime: "07:00" }),
        slot("mon-a", { ...sec("Alpha"), colBandOrder: 2, startTime: "08:00", endTime: "12:00" }),
        slot("mon-z", { ...sec("Zulu"), colBandOrder: 3, startTime: "06:00", endTime: "07:00" }),
      ]),
    ).toEqual(["Late: mon-late", "Zulu: mon-z", "Alpha: mon-a", "Beta: tue-b"]);
    // Same start and same first column (a slot collision): by name.
    expect(
      lanes([
        slot("b", { ...sec("Bravo"), startTime: "08:00", endTime: "12:00" }),
        slot("a", { ...sec("Alpha"), startTime: "08:00", endTime: "12:00" }),
      ]).map((lane) => lane.split(":")[0]),
    ).toEqual(["Alpha", "Bravo"]);
  });

  it("orders a section's lanes by start, also when a later day opened them", () => {
    expect(
      lanes([
        // Saturday has the most slots and lists its evening shift first.
        slot("sat-eve", { dayType: "sat", startTime: "16:00", endTime: "19:00" }),
        slot("sat-am", { dayType: "sat", colBandOrder: 2, startTime: "07:00", endTime: "13:00" }),
        slot("mon-am", { startTime: "07:00", endTime: "13:00" }),
      ]),
    ).toEqual(["CT: mon-am sat-am", "CT: sat-eve"]);
  });

  it("keeps a variant of the same section with another time in its lane", () => {
    expect(
      lanes([
        slot("fri-am", { startTime: "07:30", endTime: "13:00" }),
        slot("fri-pm", { colBandOrder: 2, dayType: "fri", startTime: "13:00", endTime: "16:00" }),
        slot("mon-am", { startTime: "07:30", endTime: "13:00" }),
        slot("sat-am", { dayType: "sat", startTime: "08:00", endTime: "13:00" }),
      ].map((s) => (s.id === "fri-am" ? { ...s, dayType: "fri" as const } : s))),
    ).toEqual(["CT: mon-am fri-am sat-am", "CT: fri-pm"]);
  });

  it("gives two slots of one section on the same day their own lanes", () => {
    expect(lanes([slot("a"), slot("b", { colBandOrder: 2 })])).toEqual(["CT: a", "CT: b"]);
  });

  it("tells sections apart by id, by name without one", () => {
    expect(
      lanes([
        slot("a", { sectionId: undefined, sectionName: "One", name: "One" }),
        slot("b", { dayType: "tue", sectionId: undefined, sectionName: "Two", name: "Two" }),
        slot("c", { dayType: "wed", sectionId: undefined, sectionName: "One", name: "One" }),
      ]),
    ).toEqual(["One: a c", "Two: b"]);
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
    // Saturday has the most slots and opens the lanes; the weekdays join the
    // Saturday shifts their own overlap.
    slot("ct-sat-a", { dayType: "sat", startTime: "06:00", endTime: "12:00" }),
    slot("ct-sat-b", { dayType: "sat", colBandOrder: 2, startTime: "13:00", endTime: "21:00" }),
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
      groupSpan: 2,
      title: undefined,
      sectionName: "CT",
      sectionColor: undefined,
      sectionSpan: 2,
      timeLabel: "07:00 - 15:00",
      isFirstInGroup: true,
      isLastInGroup: false,
      isFirstInSection: true,
      isLastInSection: false,
    });
    expect(layout.metaByRowId.get(`${ctGroup}__t2`)).toMatchObject({
      groupLabel: undefined,
      groupSpan: undefined,
      sectionSpan: undefined,
      // A tie (one Monday, one Tuesday time) goes to the first day.
      timeLabel: "14:00 - 22:00",
      isFirstInGroup: false,
      isLastInGroup: true,
      isFirstInSection: false,
      isLastInSection: true,
    });
  });

  it("titles a lane whose section is not the row's own name", () => {
    expect(layout.metaByRowId.get(`${mrGroup}__t1`)?.title).toBeUndefined();
    expect(layout.metaByRowId.get(`${mrGroup}__t2`)).toMatchObject({
      title: "Senior",
      sectionSpan: 1,
      isFirstInSection: true,
      isLastInSection: true,
    });
  });

  it("gives a day of another section a lane of its own, colored by that section", () => {
    const split = buildStackedTeamLayout(
      buildCalendarRows([
        slot("mon", { blockColor: "#BFDBFE" }),
        slot("tue", { dayType: "tue", sectionId: "sec-pro", sectionName: "Prostate", blockColor: "#FBCFE8" }),
      ]),
      [...columns, column("2026-01-07", "wed", 1, 4)],
    );
    expect(split.rows.map((row) => row.slotRows?.map((s) => s.id))).toEqual([["mon"], ["tue"]]);
    expect(split.metaByRowId.get(`${ctGroup}__t1`)).toMatchObject({
      title: undefined,
      sectionName: "CT",
      sectionColor: "#BFDBFE",
    });
    expect(split.metaByRowId.get(`${ctGroup}__t2`)).toMatchObject({
      title: "Prostate",
      sectionName: "Prostate",
      sectionColor: "#FBCFE8",
      timeLabel: "07:00 - 15:00",
    });
    expect(split.metaByRowId.get(`${ctGroup}__t1`)).not.toHaveProperty("otherSections");
  });

  it("names a section called like its row when another section comes first", () => {
    const result = buildStackedTeamLayout(
      buildCalendarRows([
        slot("ct", { colBandOrder: 2 }),
        slot("early", { sectionId: "sec-early", sectionName: "Early", startTime: "06:00", endTime: "07:00" }),
      ]),
      columns,
    );
    // Under "Early" an untitled lane would read as Early's second time.
    expect(result.rows.map((row) => result.metaByRowId.get(row.id)?.title)).toEqual(["Early", "CT"]);
  });

  it("keeps lane ids and order the same whatever days are on screen", () => {
    const slots = [
      slot("mon-ct"),
      slot("mon-ct-late", { colBandOrder: 2, startTime: "14:00", endTime: "22:00" }),
      slot("tue-pro", { dayType: "tue", sectionId: "sec-pro", sectionName: "Prostate" }),
    ];
    const lanesOn = (cols: DayColumn[]) =>
      buildStackedTeamLayout(buildCalendarRows(slots), cols).rows.map((row) => [
        row.id,
        row.slotRows?.map((s) => s.id),
      ]);
    expect(lanesOn(columns)).toEqual([
      [`${ctGroup}__t1`, ["mon-ct"]],
      [`${ctGroup}__t2`, ["mon-ct-late"]],
      [`${ctGroup}__t3`, ["tue-pro"]],
    ]);
    expect(lanesOn([column("2026-01-05", "mon", 1, 0), column("2026-01-05", "mon", 2, 1)])).toEqual([
      [`${ctGroup}__t1`, ["mon-ct"]],
      [`${ctGroup}__t2`, ["mon-ct-late"]],
    ]);
    // One lane on screen: the row keeps its own id.
    expect(lanesOn([column("2026-01-06", "tue", 1, 0)])).toEqual([[ctGroup, ["tue-pro"]]]);
  });

  it("orders lanes by all of a row's slots, so a hidden day keeps the order and ids of the visible lanes", () => {
    const a = { sectionId: "sec-a", sectionName: "A", name: "A" };
    const slots = [
      slot("mon-a", { ...a, startTime: "09:00", endTime: "12:00" }),
      // Saturday gives A the earliest start (06:00): A stays above B in a
      // week without Saturday too, although B starts first on Monday.
      slot("sat-a", { ...a, dayType: "sat", startTime: "06:00", endTime: "10:00" }),
      slot("mon-b", { colBandOrder: 2, sectionId: "sec-b", sectionName: "B", name: "B", startTime: "08:00", endTime: "12:00" }),
    ];
    const lanesOn = (cols: DayColumn[]) =>
      buildStackedTeamLayout(buildCalendarRows(slots), cols).rows.map((row) => [
        row.id,
        row.slotRows?.map((s) => s.id),
      ]);
    const expected = [
      [`${ctGroup}__t1`, ["mon-a", "sat-a"]],
      [`${ctGroup}__t2`, ["mon-b"]],
    ];
    expect(lanesOn([...columns, column("2026-01-10", "sat", 1, 4)])).toEqual(expected);
    expect(lanesOn(columns)).toEqual(expected);
    // A holiday week: Saturday's date is a holiday (day type "holiday").
    expect(lanesOn([...columns, column("2026-01-10", "holiday", 1, 4)])).toEqual(expected);
  });

  it("counts the visible lanes of a row and of each section for the spanning label cells", () => {
    const result = buildStackedTeamLayout(
      buildCalendarRows([
        slot("ct-early"),
        slot("ct-late", { colBandOrder: 2, startTime: "14:00", endTime: "22:00" }),
        slot("senior", { colBandOrder: 3, sectionId: "sec-senior", sectionName: "Senior", startTime: "09:00", endTime: "17:00" }),
        // Hidden in a Monday–Tuesday view: not counted.
        slot("ct-sat", { dayType: "sat", colBandOrder: 3, startTime: "22:00", endTime: "07:00", endDayOffset: 1 }),
      ]),
      columns,
    );
    expect(
      result.rows.map((row) => {
        const meta = result.metaByRowId.get(row.id)!;
        return [meta.groupSpan, meta.sectionSpan, meta.isFirstInSection, meta.isLastInSection];
      }),
    ).toEqual([
      [3, 2, true, false],
      [undefined, undefined, false, true],
      [undefined, 1, true, true],
    ]);
  });

  it("passes pool rows through without meta", () => {
    expect(layout.rows.at(-1)).toBe(pool);
    expect(layout.metaByRowId.has("pool-rest-day")).toBe(false);
  });

  it("keeps a row with one lane under its own id", () => {
    const single = buildStackedTeamLayout(buildCalendarRows([slot("only")]), columns);
    expect(single.rows.map((row) => row.id)).toEqual([ctGroup]);
    expect(single.metaByRowId.get(ctGroup)).toMatchObject({
      isFirstInGroup: true,
      isLastInGroup: true,
      isFirstInSection: true,
      isLastInSection: true,
      groupSpan: 1,
      sectionSpan: 1,
    });
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
