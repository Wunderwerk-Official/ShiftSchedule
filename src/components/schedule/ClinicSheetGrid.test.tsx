import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { RenderedAssignment } from "../../lib/schedule";
import type { ScheduleRow } from "../../lib/shiftRows";
import { EXCEL_CYAN, buildClinicSheetModel, buildMonthDays } from "../../lib/clinicSheet";
import { buildNameLabels } from "../../lib/personName";
import ClinicSheetGrid from "./ClinicSheetGrid";

const makeSlotRow = (overrides: Partial<ScheduleRow> = {}): ScheduleRow => ({
  id: "slot-mri__mon",
  kind: "class",
  name: "MRI",
  dotColorClass: "bg-slate-400",
  sectionId: "section-mri",
  sectionName: "MRI",
  locationId: "loc-default",
  locationName: "Default",
  blockColor: "#FDE2E4",
  rowBandId: "band-1",
  rowBandLabel: "MRT 08:00–17:00",
  rowBandOrder: 1,
  colBandOrder: 1,
  dayType: "mon",
  startTime: "08:00",
  endTime: "17:00",
  requiredSlots: 2,
  ...overrides,
});

const poolRow: ScheduleRow = {
  id: "pool-vacation",
  kind: "pool",
  name: "Urlaub",
  dotColorClass: "bg-emerald-500",
};

const setup = (
  options: {
    readOnly?: boolean;
    source?: RenderedAssignment["source"];
    onToggleAssignmentLock?: (assignment: { id: string; rowId: string; dateISO: string }) => void;
  } = {},
) => {
  const slotRow = makeSlotRow();
  const groupedRow: ScheduleRow = {
    ...slotRow,
    id: "group-loc-default__band-1",
    slotRows: [slotRow],
  };
  const days = buildMonthDays(new Date(2026, 6, 1), new Set());
  const model = buildClinicSheetModel({
    calendarRows: [groupedRow, poolRow],
    days,
  });
  // 2026-07-06 is a Monday.
  const assignments: RenderedAssignment[] = [
    { id: "assign-1", rowId: slotRow.id, dateISO: "2026-07-06", clinicianId: "clin-1", source: options.source },
  ];
  const assignmentMap = new Map([[`${slotRow.id}__2026-07-06`, assignments]]);
  const onAddAssignment = vi.fn();
  const onRemoveAssignment = vi.fn();
  const onMoveWithinDay = vi.fn();
  render(
    <ClinicSheetGrid
      model={model}
      assignmentMap={assignmentMap}
      rows={[groupedRow, poolRow]}
      readOnly={options.readOnly}
      getClinicianName={(id) => (id === "clin-1" ? "Anna Bergmann" : "Unbekannt")}
      getIsQualified={() => true}
      clinicians={[
        {
          id: "clin-1",
          name: "Anna Bergmann",
          qualifiedClassIds: ["section-mri"],
          vacations: [],
        },
        {
          id: "clin-2",
          name: "Jonas Keller",
          qualifiedClassIds: ["section-mri"],
          vacations: [],
        },
      ]}
      onAddAssignment={onAddAssignment}
      onRemoveAssignment={onRemoveAssignment}
      onMoveWithinDay={onMoveWithinDay}
      onToggleAssignmentLock={options.onToggleAssignmentLock}
    />,
  );
  return { onAddAssignment, onRemoveAssignment, onMoveWithinDay, slotRow };
};

const sheetCell = (rowId: string, dateISO: string) =>
  document.querySelector(
    `[data-schedule-cell="true"][data-row-id="${rowId}"][data-date-iso="${dateISO}"]`,
  ) as HTMLElement;

const makeDataTransfer = () => {
  const data: Record<string, string> = {};
  return {
    setData: (type: string, value: string) => {
      data[type] = value;
    },
    getData: (type: string) => data[type] ?? "",
    effectAllowed: "all",
    dropEffect: "none",
  };
};

describe("ClinicSheetGrid", () => {
  it("shows the same lock as the weekly grid: hand-placed names locked, planner names on hover", () => {
    const onToggleAssignmentLock = vi.fn();
    setup({ source: "manual", onToggleAssignmentLock });
    const locked = screen.getAllByRole("button", { name: "Lock assignment for Anna Bergmann" })[0];
    expect(locked).toHaveAttribute("aria-pressed", "true");
    expect(locked.className).not.toContain("pill-lock-reveal");
    fireEvent.click(locked);
    expect(onToggleAssignmentLock).toHaveBeenCalledWith(expect.objectContaining({ id: "assign-1" }));
  });

  it("fades an unlocked name only under its lock and keeps the lock's room on touch screens", () => {
    setup({ source: "solver", onToggleAssignmentLock: vi.fn() });
    const button = screen.getAllByRole("button", { name: "Lock assignment for Anna Bergmann" })[0];
    expect(button).toHaveAttribute("aria-pressed", "false");
    expect(button.className).toContain("pill-lock-reveal");
    const cell = button.closest("[data-sheet-name]") as HTMLElement;
    // The faded box spans the cell up to the lock, so a short name never fades.
    const name = cell.querySelector(".pill-lock-fade") as HTMLElement;
    expect(name.className).toContain("flex-1");
    expect(cell.className).toContain("[@media(hover:none)]:pr-5");
  });

  it("never lets a long name widen the day columns: it is cut, the full name in the title", () => {
    setup();
    const name = screen.getAllByText("Bergmann")[0].closest("[data-sheet-name]") as HTMLElement;
    // Inline-size containment: the name adds no width to the max-content
    // sized sheet grid, so every column keeps its width (screen and PDF).
    expect(name.className).toContain("[contain:inline-size]");
    expect(name.querySelector(".truncate")).not.toBeNull();
    expect(name.getAttribute("title")).toBe("Anna Bergmann");
    // A name of several words wraps (screen and PDF), so "Andreas Schulz" and
    // "Andrea Schulz" are never both cut to "Andrea…" (re-QA).
    expect(name.className).toContain("[&>span]:whitespace-normal");
    expect(name.className).not.toContain("print:[&>span]:whitespace-normal");
  });

  it("keeps day columns at a fixed width an ordinary surname fits", () => {
    setup();
    const grid = document.querySelector('[data-schedule-grid="true"]') as HTMLElement;
    // 6 name columns of 52px; never minmax(0, …) or max-content.
    expect(grid.style.gridTemplateColumns).toContain("minmax(312px, 1fr)");
  });

  it("gives names the free columns of their area instead of one column each", () => {
    const { slotRow } = setup({ readOnly: true });
    // One area spans all 6 columns of the day; its one name takes them all.
    const names = sheetCell(slotRow.id, "2026-07-06").firstElementChild as HTMLElement;
    expect(names.style.gridTemplateColumns).toBe("repeat(1, minmax(0, 1fr))");
  });

  it("keeps a track for each open-slot mark while the sheet is editable", () => {
    const { slotRow } = setup();
    // 2 required: the name and one "+" share the area.
    const names = sheetCell(slotRow.id, "2026-07-06").firstElementChild as HTMLElement;
    expect(names.style.gridTemplateColumns).toBe("repeat(2, minmax(0, 1fr))");
  });

  it("puts one name per column in a full area and wraps the rest", () => {
    const slotRow = makeSlotRow({ requiredSlots: 1 });
    const groupedRow: ScheduleRow = { ...slotRow, id: "group-loc-default__band-1", slotRows: [slotRow] };
    const days = buildMonthDays(new Date(2026, 6, 1), new Set());
    const model = buildClinicSheetModel({ calendarRows: [groupedRow, poolRow], days });
    const people = Array.from({ length: 8 }, (_, idx) => `clin-${idx}`);
    const assignmentMap = new Map<string, RenderedAssignment[]>([
      [
        `${slotRow.id}__2026-07-06`,
        people.map((id) => ({ id: `a-${id}`, rowId: slotRow.id, dateISO: "2026-07-06", clinicianId: id })),
      ],
      [
        "pool-vacation__2026-07-06",
        people.slice(0, 2).map((id) => ({ id: `v-${id}`, rowId: "pool-vacation", dateISO: "2026-07-06", clinicianId: id })),
      ],
    ]);
    render(
      <ClinicSheetGrid
        model={model}
        assignmentMap={assignmentMap}
        rows={[groupedRow, poolRow]}
        readOnly
        getClinicianName={(id) => `Person ${id}`}
        getIsQualified={() => true}
      />,
    );
    const area = sheetCell(slotRow.id, "2026-07-06").firstElementChild as HTMLElement;
    expect(area.style.gridTemplateColumns).toBe("repeat(6, minmax(0, 1fr))");
    const pool = sheetCell("pool-vacation", "2026-07-06").firstElementChild as HTMLElement;
    expect(pool.style.gridTemplateColumns).toBe("repeat(2, minmax(0, 1fr))");
  });

  it("renders assignments as plain surname text, not pills", () => {
    setup();
    const name = screen.getAllByText("Bergmann")[0];
    expect(name.closest("[data-sheet-name]")?.getAttribute("data-sheet-name")).toBe("true");
    expect(name.closest('[data-assignment-pill="true"]')).toBeNull();
  });

  it("renders the row label from the row band", () => {
    setup();
    expect(screen.getAllByText("MRT 08:00–17:00").length).toBeGreaterThan(0);
  });

  it("tints weekend day headers cyan and weekdays gray", () => {
    setup();
    // 2026-07-04 is a Saturday, 2026-07-01 a Wednesday.
    const saturday = screen.getByText("04.07.2026").closest("div[style]");
    const wednesday = screen.getByText("01.07.2026").closest("div[style]");
    expect(saturday?.getAttribute("style")).toContain("0, 204, 255");
    expect(wednesday?.getAttribute("style")).toContain("192, 192, 192");
  });

  it("opens the clinician picker on empty-area click and assigns", () => {
    const { onAddAssignment, slotRow } = setup();
    const cell = document.querySelector(
      `[data-schedule-cell="true"][data-row-id="${slotRow.id}"][data-date-iso="2026-07-06"]`,
    ) as HTMLElement;
    expect(cell).not.toBeNull();
    fireEvent.click(cell);
    const option = screen.getByText("Jonas Keller");
    fireEvent.click(option);
    expect(onAddAssignment).toHaveBeenCalledWith({
      rowId: slotRow.id,
      dateISO: "2026-07-06",
      clinicianId: "clin-2",
    });
  });

  it("does not open the picker when readOnly", () => {
    const { onAddAssignment, slotRow } = setup({ readOnly: true });
    const cell = document.querySelector(
      `[data-schedule-cell="true"][data-row-id="${slotRow.id}"][data-date-iso="2026-07-06"]`,
    ) as HTMLElement;
    fireEvent.click(cell);
    expect(screen.queryByText("Jonas Keller")).toBeNull();
    expect(onAddAssignment).not.toHaveBeenCalled();
  });

  it("renders pool assignments in the pool row", () => {
    const slotRow = makeSlotRow();
    const groupedRow: ScheduleRow = {
      ...slotRow,
      id: "group-loc-default__band-1",
      slotRows: [slotRow],
    };
    const days = buildMonthDays(new Date(2026, 6, 1), new Set());
    const model = buildClinicSheetModel({ calendarRows: [groupedRow, poolRow], days });
    const assignmentMap = new Map([
      [
        "pool-vacation__2026-07-06",
        [
          {
            id: "vac-1",
            rowId: "pool-vacation",
            dateISO: "2026-07-06",
            clinicianId: "clin-1",
          },
        ] as RenderedAssignment[],
      ],
    ]);
    render(
      <ClinicSheetGrid
        model={model}
        assignmentMap={assignmentMap}
        rows={[groupedRow, poolRow]}
        getClinicianName={() => "Anna Bergmann"}
        getIsQualified={() => true}
        onMoveWithinDay={vi.fn()}
      />,
    );
    expect(screen.getByText("Urlaub")).not.toBeNull();
    const poolCell = document.querySelector(
      '[data-schedule-cell="true"][data-row-id="pool-vacation"][data-date-iso="2026-07-06"]',
    ) as HTMLElement;
    expect(poolCell.textContent).toContain("Bergmann");
  });

  it("moves a name into a pool row of the same day", () => {
    const { onMoveWithinDay, onRemoveAssignment, slotRow } = setup();
    const name = screen.getByText("Bergmann").closest('[data-sheet-name="true"]') as HTMLElement;
    const dataTransfer = makeDataTransfer();
    fireEvent.dragStart(name, { dataTransfer });
    fireEvent.dragOver(sheetCell("pool-vacation", "2026-07-06"), { dataTransfer });
    fireEvent.drop(sheetCell("pool-vacation", "2026-07-06"), { dataTransfer });
    expect(onMoveWithinDay).toHaveBeenCalledWith({
      dateISO: "2026-07-06",
      fromRowId: slotRow.id,
      toRowId: "pool-vacation",
      assignmentId: "assign-1",
      clinicianId: "clin-1",
    });
    expect(onRemoveAssignment).not.toHaveBeenCalled();
  });

  it("removes the assignment when dropped on another day (current semantics)", () => {
    const { onMoveWithinDay, onRemoveAssignment, slotRow } = setup();
    const name = screen.getByText("Bergmann").closest('[data-sheet-name="true"]') as HTMLElement;
    const dataTransfer = makeDataTransfer();
    fireEvent.dragStart(name, { dataTransfer });
    fireEvent.drop(sheetCell("pool-vacation", "2026-07-07"), { dataTransfer });
    expect(onRemoveAssignment).toHaveBeenCalledWith({
      rowId: slotRow.id,
      dateISO: "2026-07-06",
      assignmentId: "assign-1",
      clinicianId: "clin-1",
    });
    expect(onMoveWithinDay).not.toHaveBeenCalled();
  });

  it("moves a Rest Day name to the Rest Day row of another day, like the weekly grid", () => {
    const slotRow = makeSlotRow();
    const groupedRow: ScheduleRow = { ...slotRow, id: "group-loc-default__band-1", slotRows: [slotRow] };
    const restRow: ScheduleRow = { id: "pool-rest-day", kind: "pool", name: "Ruhetag", dotColorClass: "" };
    const days = buildMonthDays(new Date(2026, 6, 1), new Set());
    const model = buildClinicSheetModel({ calendarRows: [groupedRow, restRow], days });
    const rest: RenderedAssignment = {
      id: "rest-1",
      rowId: "pool-rest-day",
      dateISO: "2026-07-06",
      clinicianId: "clin-1",
    };
    const onMoveRestDay = vi.fn();
    const onRemoveAssignment = vi.fn();
    render(
      <ClinicSheetGrid
        model={model}
        assignmentMap={new Map([["pool-rest-day__2026-07-06", [rest]]])}
        rows={[groupedRow, restRow]}
        getClinicianName={() => "Anna Bergmann"}
        getIsQualified={() => true}
        onMoveWithinDay={vi.fn()}
        onRemoveAssignment={onRemoveAssignment}
        onMoveRestDay={onMoveRestDay}
      />,
    );
    const name = screen.getByText("Bergmann").closest('[data-sheet-name="true"]') as HTMLElement;
    const dataTransfer = makeDataTransfer();
    fireEvent.dragStart(name, { dataTransfer });
    fireEvent.drop(sheetCell("pool-rest-day", "2026-07-08"), { dataTransfer });
    expect(onMoveRestDay).toHaveBeenCalledWith({
      fromDateISO: "2026-07-06",
      toDateISO: "2026-07-08",
      assignmentId: "rest-1",
      clinicianId: "clin-1",
    });
    expect(onRemoveAssignment).not.toHaveBeenCalled();
  });

  it("marks a name scheduled on the person's rest day (the sheet lists no rule violations)", () => {
    const slotRow = makeSlotRow();
    const groupedRow: ScheduleRow = { ...slotRow, id: "group-loc-default__band-1", slotRows: [slotRow] };
    const days = buildMonthDays(new Date(2026, 6, 1), new Set());
    const model = buildClinicSheetModel({ calendarRows: [groupedRow], days });
    const shift = (id: string, dateISO: string): RenderedAssignment => ({
      id,
      rowId: slotRow.id,
      dateISO,
      clinicianId: "clin-1",
    });
    render(
      <ClinicSheetGrid
        model={model}
        assignmentMap={
          new Map([
            [`${slotRow.id}__2026-07-06`, [shift("a", "2026-07-06")]],
            [`${slotRow.id}__2026-07-13`, [shift("b", "2026-07-13")]],
          ])
        }
        rows={[groupedRow]}
        getClinicianName={() => "Anna Bergmann"}
        getIsQualified={() => true}
        getIsOnRestDay={(clinicianId, dateISO) => clinicianId === "clin-1" && dateISO === "2026-07-13"}
      />,
    );
    const [free, resting] = screen
      .getAllByText("Bergmann")
      .map((element) => element.closest('[data-sheet-name="true"]') as HTMLElement);
    expect(resting.title).toBe("Anna Bergmann — scheduled on a rest day");
    expect(resting.className).toContain("decoration-red-600");
    expect(free.title).toBe("Anna Bergmann");
    expect(free.className).not.toContain("decoration-wavy");
  });

  it("keeps a Vacation name dropped on another day; out of the sheet it leaves", () => {
    const slotRow = makeSlotRow();
    const groupedRow: ScheduleRow = { ...slotRow, id: "group-loc-default__band-1", slotRows: [slotRow] };
    const vacationRow: ScheduleRow = { id: "pool-vacation", kind: "pool", name: "Urlaub", dotColorClass: "" };
    const days = buildMonthDays(new Date(2026, 6, 1), new Set());
    const model = buildClinicSheetModel({ calendarRows: [groupedRow, vacationRow], days });
    const vacation: RenderedAssignment = {
      id: "pool-pool-vacation-clin-1-2026-07-06",
      rowId: "pool-vacation",
      dateISO: "2026-07-06",
      clinicianId: "clin-1",
    };
    const onRemoveAssignment = vi.fn();
    render(
      <ClinicSheetGrid
        model={model}
        assignmentMap={new Map([["pool-vacation__2026-07-06", [vacation]]])}
        rows={[groupedRow, vacationRow]}
        getClinicianName={() => "Anna Bergmann"}
        getIsQualified={() => true}
        onMoveWithinDay={vi.fn()}
        onRemoveAssignment={onRemoveAssignment}
        onMoveRestDay={vi.fn()}
      />,
    );
    const name = () => screen.getByText("Bergmann").closest('[data-sheet-name="true"]') as HTMLElement;
    // Another day's Vacation cell, a slot on another (Monday) day.
    for (const target of [sheetCell("pool-vacation", "2026-07-08"), sheetCell(slotRow.id, "2026-07-13")]) {
      expect(target).not.toBeNull();
      const dataTransfer = makeDataTransfer();
      fireEvent.dragStart(name(), { dataTransfer });
      fireEvent.drop(target, { dataTransfer });
    }
    expect(onRemoveAssignment).not.toHaveBeenCalled();
    const dataTransfer = makeDataTransfer();
    fireEvent.dragStart(name(), { dataTransfer });
    fireEvent.drop(document.body, { dataTransfer });
    expect(onRemoveAssignment).toHaveBeenCalledWith(
      expect.objectContaining({ rowId: "pool-vacation", dateISO: "2026-07-06", clinicianId: "clin-1" }),
    );
  });

  it("ignores a malformed drag payload", () => {
    const { onMoveWithinDay, onRemoveAssignment } = setup();
    const name = screen.getByText("Bergmann").closest('[data-sheet-name="true"]') as HTMLElement;
    fireEvent.dragStart(name, { dataTransfer: makeDataTransfer() });
    const broken = { ...makeDataTransfer(), getData: () => "{not json" };
    fireEvent.drop(sheetCell("pool-vacation", "2026-07-06"), { dataTransfer: broken });
    expect(onMoveWithinDay).not.toHaveBeenCalled();
    expect(onRemoveAssignment).not.toHaveBeenCalled();
  });

  it("lists 'Last, First' and titled names by their surname, unique in the team", () => {
    const slotRow = makeSlotRow({ requiredSlots: 4 });
    const groupedRow: ScheduleRow = { ...slotRow, id: "group-loc-default__band-1", slotRows: [slotRow] };
    const model = buildClinicSheetModel({
      calendarRows: [groupedRow, poolRow],
      days: buildMonthDays(new Date(2026, 6, 1), new Set()),
    });
    const team = [
      { id: "jm", name: "Müller, Jörg; Dr." },
      { id: "as", name: "Dr. med. Anna Schmidt" },
      { id: "mp", name: "Marion P." },
      { id: "tm", name: "Thomas Müller" },
    ];
    const assignments: RenderedAssignment[] = ["jm", "as", "mp"].map((clinicianId) => ({
      id: `a-${clinicianId}`,
      rowId: slotRow.id,
      dateISO: "2026-07-06",
      clinicianId,
    }));
    // Thomas Müller works the next Monday: his surname still counts.
    assignments.push({ id: "a-tm", rowId: slotRow.id, dateISO: "2026-07-13", clinicianId: "tm" });
    const assignmentMap = new Map<string, RenderedAssignment[]>([
      [`${slotRow.id}__2026-07-06`, assignments.slice(0, 3)],
      [`${slotRow.id}__2026-07-13`, assignments.slice(3)],
    ]);
    render(
      <ClinicSheetGrid
        model={model}
        assignmentMap={assignmentMap}
        rows={[groupedRow, poolRow]}
        readOnly
        getClinicianName={(id) => team.find((person) => person.id === id)?.name ?? "Unknown"}
        nameLabels={buildNameLabels(team)}
        getIsQualified={() => true}
      />,
    );
    const names = Array.from(document.querySelectorAll('[data-sheet-name="true"]')).map(
      (element) => element.textContent,
    );
    // Once "Dr.", "P." and "Müller" for both Müllers.
    expect(names).toEqual(["J. Müller", "Marion P.", "Schmidt", "T. Müller"]);
  });

  it("uses the sheet cyan constant for weekend blocks", () => {
    expect(EXCEL_CYAN).toBe("#00CCFF");
  });
});
