import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { RenderedAssignment } from "../../lib/schedule";
import type { ScheduleRow } from "../../lib/shiftRows";
import { STACKED_DIVIDER } from "./RowLabel";
import ScheduleGrid from "./ScheduleGrid";
import { buildLocationRowTints, buildPersonPillStyles } from "./teamColors";

const baseRow: ScheduleRow = {
  id: "slot-1",
  name: "MRI",
  kind: "class",
  dotColorClass: "bg-slate-200",
  sectionId: "class-1",
  sectionName: "MRI",
  slotLabel: "Shift 1",
  startTime: "08:00",
  endTime: "16:00",
  endDayOffset: 0,
};

const renderGrid = (extra: Partial<Parameters<typeof ScheduleGrid>[0]> = {}) => {
  const weekDays = [new Date(2026, 0, 5)];
  const dateISO = "2026-01-05";
  const assignments: RenderedAssignment[] = [
    {
      id: "assign-1",
      rowId: baseRow.id,
      dateISO,
      clinicianId: "clin-1",
    },
  ];
  const assignmentMap = new Map([[`${baseRow.id}__${dateISO}`, assignments]]);
  return render(
    <ScheduleGrid
      leftHeaderTitle="Week"
      weekDays={weekDays}
      rows={[baseRow]}
      assignmentMap={assignmentMap}
      getClinicianName={() => "Dr. Alice"}
      getIsQualified={() => true}
      getHasEligibleClasses={() => true}
      onCellClick={vi.fn()}
      onMoveWithinDay={vi.fn()}
      {...extra}
    />,
  );
};

const locatedRow: ScheduleRow = { ...baseRow, locationId: "loc-1", locationName: "Berlin", rowBandLabel: "MRI" };
const clinicians = [
  { id: "clin-0", name: "Bob Other", qualifiedClassIds: [], preferredClassIds: [], vacations: [] },
  { id: "clin-1", name: "Dr. Alice Smith", qualifiedClassIds: [], preferredClassIds: [], vacations: [] },
];

describe("ScheduleGrid", () => {
  it("hides assignment time labels (time labels are always hidden)", () => {
    renderGrid();
    const pill = screen.getByText("Dr. Alice").closest("[data-assignment-pill=\"true\"]");
    expect(pill).not.toBeNull();
    expect(within(pill as HTMLElement).queryByText("08:00 - 16:00")).toBeNull();
  });

  it("renders pills and row labels without inline colors without location colors (print, public)", () => {
    const { container } = renderGrid({
      rows: [locatedRow],
      locationSeparatorRowIds: [locatedRow.id],
    });
    const pill = screen.getByText("Dr. Alice").closest("[data-assignment-pill=\"true\"]");
    expect(pill?.getAttribute("style")).toBeNull();
    expect(pill?.className).not.toContain("outline");
    expect(container.querySelector('[style*="background-color"]')).toBeNull();
  });

  it("gives an uncolored location its automatic color: band, label shade and ink", () => {
    renderGrid({
      rows: [locatedRow],
      locationSeparatorRowIds: [locatedRow.id],
      locationRowTints: buildLocationRowTints([{ id: "loc-1", name: "Berlin" }], false),
    });
    // First location → blue: label ground #DBEAFE with ink #172554, band #1D4ED8.
    const label = document.querySelector<HTMLElement>("[data-label-shade]")!;
    expect(label.style.backgroundColor).toBe("rgb(219, 234, 254)");
    expect(screen.getByTitle("MRI").style.color).toBe("rgb(23, 37, 84)");
    const band = document.querySelector<HTMLElement>('[data-location-band="true"]')!;
    expect(band.textContent).toBe("Berlin");
    expect(band.style.color).toBe("rgb(255, 255, 255)");
    expect(band.parentElement?.style.backgroundColor).toBe("rgb(29, 78, 216)");
  });

  it("colors pills by person (initials, palette colors, outline for me)", () => {
    renderGrid({ personPillStyles: buildPersonPillStyles(clinicians), myClinicianId: "clin-1" });
    const pill = screen.getByText("Dr. Alice").closest("[data-assignment-pill=\"true\"]") as HTMLElement;
    // Second clinician → palette p02 (rust, dark tone: white text).
    expect(pill.style.backgroundColor).toBe("rgb(194, 65, 12)");
    expect(pill.style.borderColor).toBe("rgb(124, 45, 18)");
    expect(pill.style.color).toBe("rgb(255, 255, 255)");
    expect(within(pill).getByText("AS")).toBeTruthy();
    expect(pill.className).toContain("outline-2");
    // Left-aligned row (a centered one clips the initials), ellipsis on the name.
    const name = screen.getByText("Dr. Alice");
    expect(name.className).toContain("truncate");
    expect(name.parentElement?.className).toContain("justify-start");
    expect(within(pill).getByText("AS").className).toContain("h-5");
  });

  it("uses the dark person tokens and neutral section blocks in person mode", () => {
    const { container } = renderGrid({
      rows: [{ ...baseRow, blockColor: "#FF99CC" }],
      personPillStyles: buildPersonPillStyles(clinicians, true),
    });
    const pill = screen.getByText("Dr. Alice").closest('[data-assignment-pill="true"]') as HTMLElement;
    expect(pill.style.backgroundColor).toBe("rgb(253, 186, 116)"); // p02 dark fill #FDBA74 (tones swap)
    expect(within(pill).getByText("AS").style.color).toBe("rgb(15, 23, 42)");
    // SPEC E7: the section fill gives way to the person colors.
    expect(container.querySelector('[style*="rgb(255, 153, 204)"]')).toBeNull();
  });

  it("outlines only the given person's pills, without inline colors", () => {
    renderGrid({ myClinicianId: "clin-1" });
    const pill = screen.getByText("Dr. Alice").closest('[data-assignment-pill="true"]') as HTMLElement;
    expect(pill.className).toContain("outline-2");
    expect(pill.getAttribute("style")).toBeNull();
    cleanup();
    renderGrid({ myClinicianId: "clin-0" });
    const other = screen.getByText("Dr. Alice").closest('[data-assignment-pill="true"]') as HTMLElement;
    expect(other.className).not.toContain("outline");
  });

  it("keeps the section fill of the blocks by default", () => {
    const { container } = renderGrid({ rows: [{ ...baseRow, blockColor: "#FF99CC" }] });
    expect(container.querySelector('[style*="rgb(255, 153, 204)"]')).not.toBeNull();
  });

  it("keeps the section pill look: 2 px border, inner hairline, centered name, no initials", () => {
    const { container } = renderGrid({
      rows: [{ ...baseRow, blockColor: "#FF99CC" }],
      onToggleAssignmentLock: vi.fn(),
    });
    const pill = screen.getByText("Dr. Alice").closest('[data-assignment-pill="true"]') as HTMLElement;
    expect(pill.getAttribute("style")).toBeNull();
    // A legacy entry is locked: its lock sits in the row and brings its own
    // spacing, so the pill keeps a small right padding (pr-px).
    for (const token of ["border-2", "pl-1.5", "pr-px", "py-0.5", "shadow-[inset_0_0_0_1px_rgba(255,255,255,0.7)]", "bg-sky-50", "border-sky-200"]) {
      expect(pill.classList).toContain(token);
    }
    expect(pill.classList).not.toContain("border");
    expect(pill.classList).not.toContain("min-h-7");
    const name = screen.getByText("Dr. Alice");
    expect(name.className).toBe("whitespace-nowrap text-center");
    expect(name.parentElement?.className).toContain("justify-center");
    expect(name.parentElement?.getAttribute("title")).toBeNull();
    expect(pill.getAttribute("title")).toBeNull();
    // The lock glyph, no initials circle (no inline-styled spans at all).
    expect(within(pill).getByRole("button", { name: "Lock assignment for Dr. Alice" })).toHaveAttribute("aria-pressed", "true");
    expect(pill.querySelector("svg")).not.toBeNull();
    expect(pill.querySelector("[style]")).toBeNull();
    // The section block keeps its fill and its title.
    const fills = container.querySelectorAll('[style*="rgb(255, 153, 204)"]');
    expect(fills).toHaveLength(1);
    expect(fills[0].textContent).toContain("MRI");
  });

  it("uses a location's own color for its label cells and its band", () => {
    renderGrid({
      rows: [locatedRow],
      locationSeparatorRowIds: [locatedRow.id],
      locationRowTints: buildLocationRowTints([{ id: "loc-1", name: "Berlin", color: "#EEDFC4" }], false),
    });
    // Sand: ground #EEDFC4 on the first row band, band #7A5E2E, ink #5A3E0E.
    const label = document.querySelector<HTMLElement>("[data-label-shade]")!;
    expect(label.style.backgroundColor).toBe("rgb(238, 223, 196)");
    const band = document.querySelector<HTMLElement>('[data-location-band="true"]')!;
    expect(band.parentElement?.style.backgroundColor).toBe("rgb(122, 94, 46)");
    const locationLine = screen.getAllByTitle("Berlin").find((element) => element !== band);
    expect(locationLine?.style.color).toBe("rgb(90, 62, 14)");
  });

  it("keeps the plain separator without a location name (locations off), still shading the labels", () => {
    const unnamed = (id: string, band: string): ScheduleRow => ({ ...baseRow, id, locationId: "loc-default", rowBandLabel: band });
    const { container } = renderGrid({
      rows: [unnamed("r-mri", "MRI"), unnamed("r-ct", "CT")],
      locationSeparatorRowIds: ["r-mri"],
      locationRowTints: buildLocationRowTints([{ id: "loc-default", name: "Berlin" }], false),
    });
    expect(document.querySelector('[data-location-band="true"]')).toBeNull();
    expect(container.querySelector('[style*="rgb(29, 78, 216)"]')).toBeNull();
    const shades = Array.from(document.querySelectorAll<HTMLElement>("[data-label-shade]")).map(
      (element) => element.dataset.labelShade,
    );
    expect(shades).toEqual(["#DBEAFE", "#93C5FD"]);
  });

  it("alternates the label shades per row band, restarting at each location", () => {
    const row = (id: string, locationId: string, band: string): ScheduleRow => ({
      ...baseRow,
      id,
      locationId,
      locationName: locationId === "loc-1" ? "Berlin" : "Potsdam",
      rowBandLabel: band,
    });
    const rows = [
      row("b-mri", "loc-1", "MRI"),
      row("b-ct", "loc-1", "CT"),
      row("b-us", "loc-1", "US"),
      row("p-ct", "loc-2", "CT"),
    ];
    renderGrid({
      rows,
      locationSeparatorRowIds: ["b-mri", "p-ct"],
      locationRowTints: buildLocationRowTints(
        [
          { id: "loc-1", name: "Berlin" },
          { id: "loc-2", name: "Potsdam" },
        ],
        false,
      ),
    });
    const shades = Array.from(document.querySelectorAll<HTMLElement>("[data-label-shade]")).map(
      (element) => element.dataset.labelShade,
    );
    // Berlin blue: light, strong, light; Potsdam green starts light again.
    expect(shades).toEqual(["#DBEAFE", "#93C5FD", "#DBEAFE", "#DCFCE7"]);
  });
});

describe("ScheduleGrid print pages", () => {
  const week = Array.from({ length: 7 }, (_, i) => new Date(2026, 0, 5 + i));
  const gridColumns = () =>
    (document.querySelector('[data-schedule-grid="true"]') as HTMLElement).style.gridTemplateColumns;
  const firstCell = () =>
    document.querySelector('[data-schedule-cell="true"][data-row-kind="class"]') as HTMLElement;

  it("gives the side-by-side week narrower columns and tighter paddings in print", () => {
    renderGrid({ weekDays: week, print: true });
    expect(gridColumns()).toContain("minmax(84px, 1fr)");
    expect(firstCell().className).not.toContain("sm:p-1");
    expect(firstCell().querySelector(".rounded-lg.border-2")?.className).toContain("px-1");
    cleanup();
    renderGrid({ weekDays: week });
    expect(gridColumns()).toContain("minmax(120px, 1fr)");
    expect(firstCell().className).toContain("sm:p-1");
  });

  it("keeps the compact week's columns in print", () => {
    renderGrid({ weekDays: week, print: true, timeLayout: "stacked" });
    expect(gridColumns()).toContain("minmax(64px, 1fr)");
  });

  it("lets labels wrap in print instead of cutting them off", () => {
    renderGrid({
      weekDays: week,
      print: true,
      rows: [{ ...locatedRow, sectionName: "Interventionelle Radiologie Kardio" }],
      holidayNameByDate: { "2026-01-06": "Heilige Drei Könige" },
    });
    for (const text of ["Interventionelle Radiologie Kardio", "Heilige Drei Könige", "MRI", "Berlin"]) {
      expect(screen.getAllByText(text)[0].className).toContain("print-wrap");
    }
  });

  it("does not mark today in print", () => {
    renderGrid({ weekDays: [new Date()] });
    const today = document.querySelector(".rounded-full.border-slate-900") as HTMLElement;
    expect(today.className).toContain("print:border-transparent");
  });
});

describe("ScheduleGrid drag and drop", () => {
  const MON = "2026-01-05";
  const TUE = "2026-01-06";
  const slot = (id: string, startTime: string, endTime: string, extra: Partial<ScheduleRow> = {}): ScheduleRow => ({
    ...baseRow,
    id,
    name: id,
    sectionId: `section-${id}`,
    sectionName: id,
    startTime,
    endTime,
    ...extra,
  });
  const dndRows: ScheduleRow[] = [
    slot("early", "08:00", "12:00"),
    slot("late", "12:00", "16:00"),
    slot("mid", "10:00", "14:00"),
    // 20:00-08:00 without "+1 day": no valid interval.
    slot("broken", "20:00", "08:00"),
    // Only active on Tuesdays: the Monday cell is inactive.
    slot("tue-only", "08:00", "09:00", { dayType: "tue", colBandOrder: 1 }),
    { id: "pool-rest-day", name: "Rest Day", kind: "pool", dotColorClass: "bg-slate-200" },
  ];
  const entry = (rowId: string, dateISO: string, clinicianId: string): [string, RenderedAssignment[]] => [
    `${rowId}__${dateISO}`,
    [{ id: `${rowId}-${dateISO}-${clinicianId}`, rowId, dateISO, clinicianId }],
  ];
  const dndMap = new Map<string, RenderedAssignment[]>([
    entry("early", MON, "x"),
    [`late__${MON}`, [{ id: `late-${MON}-y`, rowId: "late", dateISO: MON, clinicianId: "y" }]],
    entry("broken", MON, "z"),
  ]);
  dndMap.get(`early__${MON}`)!.push({ id: `early-${MON}-y`, rowId: "early", dateISO: MON, clinicianId: "y" });

  const renderDnd = () => {
    const onMoveWithinDay = vi.fn();
    const onRemoveAssignment = vi.fn();
    render(
      <ScheduleGrid
        leftHeaderTitle="Week"
        weekDays={[new Date(2026, 0, 5), new Date(2026, 0, 6)]}
        rows={dndRows}
        assignmentMap={dndMap}
        getClinicianName={(id) => `Person ${id.toUpperCase()}`}
        getIsQualified={() => true}
        getHasEligibleClasses={() => true}
        onCellClick={vi.fn()}
        onMoveWithinDay={onMoveWithinDay}
        onRemoveAssignment={onRemoveAssignment}
        onAddAssignment={vi.fn()}
      />,
    );
    return { onMoveWithinDay, onRemoveAssignment };
  };
  // Scoped to the grid: the drag image clone of an earlier drag (removed on a
  // timer) carries the same data attributes.
  const pill = (rowId: string, dateISO: string, clinicianId: string) =>
    document.querySelector(
      `[data-schedule-grid="true"] [data-assignment-key="${rowId}__${dateISO}__${clinicianId}"]`,
    ) as HTMLElement;
  const cell = (rowId: string, dateISO: string) =>
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
      setDragImage: () => {},
      effectAllowed: "all",
      dropEffect: "none",
    };
  };
  const dragTo = (from: HTMLElement, to: Element) => {
    const dataTransfer = makeDataTransfer();
    fireEvent.dragStart(from, { dataTransfer });
    fireEvent.dragOver(to, { dataTransfer });
    fireEvent.drop(to, { dataTransfer });
    fireEvent.dragEnd(from, { dataTransfer });
  };

  it("moves a pill to a free slot of the same day", () => {
    const { onMoveWithinDay, onRemoveAssignment } = renderDnd();
    dragTo(pill("early", MON, "x"), cell("late", MON));
    expect(onMoveWithinDay).toHaveBeenCalledWith({
      dateISO: MON,
      fromRowId: "early",
      toRowId: "late",
      assignmentId: `early-${MON}-x`,
      clinicianId: "x",
    });
    expect(onRemoveAssignment).not.toHaveBeenCalled();
  });

  it("moves a pill into a pool row of the same day", () => {
    const { onMoveWithinDay } = renderDnd();
    dragTo(pill("early", MON, "x"), cell("pool-rest-day", MON));
    expect(onMoveWithinDay).toHaveBeenCalledWith(
      expect.objectContaining({ fromRowId: "early", toRowId: "pool-rest-day", clinicianId: "x" }),
    );
  });

  it("treats a drop on the source cell as a no-op", () => {
    const { onMoveWithinDay, onRemoveAssignment } = renderDnd();
    dragTo(pill("early", MON, "x"), cell("early", MON));
    expect(onMoveWithinDay).not.toHaveBeenCalled();
    expect(onRemoveAssignment).not.toHaveBeenCalled();
  });

  // Current semantics (review finding grid-2 not applied): an invalid drop
  // inside the grid removes the assignment.
  it("removes the assignment when dropped on another day", () => {
    const { onMoveWithinDay, onRemoveAssignment } = renderDnd();
    dragTo(pill("early", MON, "x"), cell("late", TUE));
    expect(onRemoveAssignment).toHaveBeenCalledWith({
      rowId: "early",
      dateISO: MON,
      assignmentId: `early-${MON}-x`,
      clinicianId: "x",
    });
    expect(onMoveWithinDay).not.toHaveBeenCalled();
  });

  it("removes the assignment when the target overlaps another shift of that person", () => {
    const { onMoveWithinDay, onRemoveAssignment } = renderDnd();
    dragTo(pill("late", MON, "y"), cell("mid", MON));
    expect(onRemoveAssignment).toHaveBeenCalledWith(expect.objectContaining({ rowId: "late", clinicianId: "y" }));
    expect(onMoveWithinDay).not.toHaveBeenCalled();
  });

  it("removes the assignment when dropped on an inactive cell", () => {
    const { onMoveWithinDay, onRemoveAssignment } = renderDnd();
    dragTo(pill("early", MON, "x"), cell("tue-only", MON));
    expect(onRemoveAssignment).toHaveBeenCalledWith(expect.objectContaining({ rowId: "early", clinicianId: "x" }));
    expect(onMoveWithinDay).not.toHaveBeenCalled();
  });

  it("removes the assignment when dropped outside the grid", () => {
    const { onRemoveAssignment } = renderDnd();
    const dataTransfer = makeDataTransfer();
    fireEvent.dragStart(pill("early", MON, "x"), { dataTransfer });
    fireEvent.drop(document.body, { dataTransfer });
    expect(onRemoveAssignment).toHaveBeenCalledWith(expect.objectContaining({ rowId: "early", clinicianId: "x" }));
  });

  // The grid's own drop handler: inside the grid but on no cell (here the
  // top-left header). The window handler leaves such drops to the grid.
  const gridBackground = () => {
    const header = screen.getByText("Week");
    expect(header.closest('[data-schedule-grid="true"]')).not.toBeNull();
    expect(header.closest('[data-schedule-cell="true"]')).toBeNull();
    return header;
  };

  it("removes the assignment when dropped on the grid outside any cell", () => {
    const { onMoveWithinDay, onRemoveAssignment } = renderDnd();
    dragTo(pill("early", MON, "x"), gridBackground());
    expect(onRemoveAssignment).toHaveBeenCalledTimes(1);
    expect(onRemoveAssignment).toHaveBeenCalledWith({
      rowId: "early",
      dateISO: MON,
      assignmentId: `early-${MON}-x`,
      clinicianId: "x",
    });
    expect(onMoveWithinDay).not.toHaveBeenCalled();
  });

  it("ignores a malformed payload dropped on the grid outside any cell and ends the drag", () => {
    const { onMoveWithinDay, onRemoveAssignment } = renderDnd();
    fireEvent.dragStart(pill("early", MON, "x"), { dataTransfer: makeDataTransfer() });
    const broken = { ...makeDataTransfer(), getData: () => "{not json" };
    const background = gridBackground();
    fireEvent.dragOver(background, { dataTransfer: broken });
    fireEvent.drop(background, { dataTransfer: broken });
    expect(onRemoveAssignment).not.toHaveBeenCalled();
    // The drag is over: a later drop outside the grid removes nothing.
    fireEvent.drop(document.body, { dataTransfer: makeDataTransfer() });
    expect(onRemoveAssignment).not.toHaveBeenCalled();
    expect(onMoveWithinDay).not.toHaveBeenCalled();
  });

  it("moves a pill out of a slot without a valid time (its own unknown interval does not block)", () => {
    const { onMoveWithinDay, onRemoveAssignment } = renderDnd();
    dragTo(pill("broken", MON, "z"), cell("late", MON));
    expect(onMoveWithinDay).toHaveBeenCalledWith(
      expect.objectContaining({ fromRowId: "broken", toRowId: "late", clinicianId: "z" }),
    );
    expect(onRemoveAssignment).not.toHaveBeenCalled();
  });

  it("ignores a malformed drag payload without throwing", () => {
    const { onMoveWithinDay, onRemoveAssignment } = renderDnd();
    const errors: unknown[] = [];
    const onError = (event: ErrorEvent) => {
      errors.push(event.error);
      event.preventDefault();
    };
    window.addEventListener("error", onError);
    try {
      fireEvent.dragStart(pill("early", MON, "x"), { dataTransfer: makeDataTransfer() });
      const broken = { ...makeDataTransfer(), getData: () => "{not json" };
      for (const target of [cell("late", MON), cell("pool-rest-day", MON)]) {
        fireEvent.dragOver(target, { dataTransfer: broken });
        fireEvent.drop(target, { dataTransfer: broken });
      }
    } finally {
      window.removeEventListener("error", onError);
    }
    expect(errors).toEqual([]);
    expect(onMoveWithinDay).not.toHaveBeenCalled();
    expect(onRemoveAssignment).not.toHaveBeenCalled();
  });

  it("opens the clinician picker on a click into an active slot", () => {
    renderDnd();
    fireEvent.click(cell("mid", MON));
    expect(screen.getByPlaceholderText("Search clinicians...")).toBeTruthy();
  });
});

describe("ScheduleGrid stacked times", () => {
  const MON = "2026-01-05";
  const TUE = "2026-01-06";
  const band = (id: string, dayType: "mon" | "tue", colBandOrder: number, startTime: string, endTime: string): ScheduleRow => ({
    ...baseRow,
    id,
    name: "CT",
    sectionId: "sec-ct",
    sectionName: "CT",
    locationId: "loc-1",
    locationName: "Campus",
    rowBandId: "rb-ct",
    rowBandLabel: "CT",
    dayType,
    colBandOrder,
    startTime,
    endTime,
  });
  const groupRow: ScheduleRow = {
    ...band("ct-mon-early", "mon", 1, "07:00", "15:00"),
    id: "group-loc-1__rb-ct",
    slotRows: [
      band("ct-mon-early", "mon", 1, "07:00", "15:00"),
      band("ct-mon-late", "mon", 2, "14:00", "22:00"),
      band("ct-tue-early", "tue", 1, "07:00", "15:00"),
      // Tuesday's late shift ends earlier than the band's usual time.
      band("ct-tue-late", "tue", 2, "14:00", "20:00"),
    ],
  };
  const column = (dateISO: string, dayType: "mon" | "tue", colOrder: number, columnIndex: number) => ({
    date: new Date(`${dateISO}T00:00:00`),
    dateISO,
    dayType,
    colOrder,
    isFirstInDay: colOrder === 1,
    dayIndex: dateISO === MON ? 0 : 1,
    columnIndex,
  });
  const dayColumns = [column(MON, "mon", 1, 0), column(MON, "mon", 2, 1), column(TUE, "tue", 1, 2), column(TUE, "tue", 2, 3)];
  const assignmentMap = new Map<string, RenderedAssignment[]>([
    [`ct-mon-early__${MON}`, [{ id: "a1", rowId: "ct-mon-early", dateISO: MON, clinicianId: "x" }]],
  ]);
  const renderStacked = (extra: Partial<Parameters<typeof ScheduleGrid>[0]> = {}) => {
    const onMoveWithinDay = vi.fn();
    render(
      <ScheduleGrid
        leftHeaderTitle=""
        weekDays={[new Date(2026, 0, 5), new Date(2026, 0, 6)]}
        dayColumns={dayColumns}
        rows={[groupRow]}
        assignmentMap={assignmentMap}
        locationSeparatorRowIds={[groupRow.id]}
        getClinicianName={(id) => `Person ${id.toUpperCase()}`}
        getIsQualified={() => true}
        getHasEligibleClasses={() => true}
        onCellClick={vi.fn()}
        onMoveWithinDay={onMoveWithinDay}
        timeLayout="stacked"
        {...extra}
      />,
    );
    return { onMoveWithinDay };
  };
  const cells = () => Array.from(document.querySelectorAll<HTMLElement>('[data-schedule-cell="true"]'));
  const cell = (rowId: string, dateISO: string) =>
    document.querySelector(
      `[data-schedule-cell="true"][data-row-id="${rowId}"][data-date-iso="${dateISO}"]`,
    ) as HTMLElement;

  it("renders one column per day and a day's times as rows", () => {
    renderStacked();
    const grid = document.querySelector('[data-schedule-grid="true"]') as HTMLElement;
    expect(grid.style.gridTemplateColumns).toContain("repeat(2,");
    // Two bands × two days, each cell addressed by its slot id.
    expect(cells().map((c) => `${c.dataset.rowId}@${c.dataset.dateIso}`)).toEqual([
      `ct-mon-early@${MON}`,
      `ct-tue-early@${TUE}`,
      `ct-mon-late@${MON}`,
      `ct-tue-late@${TUE}`,
    ]);
  });

  it("puts the row name and each band's time into the label column", () => {
    renderStacked();
    expect(screen.getAllByText("CT", { selector: "span" })).toHaveLength(1);
    expect(screen.getByText("07:00–15:00")).toBeTruthy();
    expect(screen.getByText("14:00–22:00")).toBeTruthy();
    // The location is named by the band above its rows.
    expect(screen.getByText("Campus")).toBeTruthy();
  });

  const labelCells = (kind: "band" | "section" | "time") =>
    Array.from(document.querySelectorAll<HTMLElement>(`[data-stacked-label="${kind}"]`));
  // The user's case: Monday's late slot is "MR neuro", Tuesday's "MR prostate".
  const rotating: ScheduleRow = {
    ...groupRow,
    slotRows: groupRow.slotRows!.map((slot) =>
      slot.id === "ct-mon-late"
        ? { ...slot, sectionId: "sec-neuro", sectionName: "MR neuro", name: "MR neuro", blockColor: "#DDD6FE" }
        : slot.id === "ct-tue-late"
          ? { ...slot, sectionId: "sec-pro", sectionName: "MR prostate", name: "MR prostate", blockColor: "#BFDBFE" }
          : { ...slot, blockColor: "#BBF7D0" },
    ),
  };

  const restDay: ScheduleRow = { id: "pool-rest-day", name: "Rest Day", kind: "pool", dotColorClass: "bg-slate-200" };

  it("splits the label into row band, section and time columns; band and section cells span their lanes", () => {
    renderStacked({ rows: [rotating, restDay] });
    const grid = document.querySelector('[data-schedule-grid="true"]') as HTMLElement;
    expect(grid.style.gridTemplateColumns.startsWith("repeat(3, auto) repeat(2,")).toBe(true);
    // One row band cell over the row's three lanes, one section cell per section.
    expect(labelCells("band").map((c) => [c.textContent, c.style.gridRow])).toEqual([["CT", "span 3"]]);
    expect(labelCells("section").map((c) => [c.textContent, c.style.gridRow])).toEqual([
      ["", "span 1"],
      ["MR neuro", "span 1"],
      ["MR prostate", "span 1"],
    ]);
    expect(labelCells("time").map((c) => c.textContent)).toEqual([
      "07:00–15:00",
      "14:00–22:00",
      "14:00–20:00",
    ]);
    // The empty top-left header and the pool rows span all three.
    expect((grid.firstElementChild as HTMLElement).style.gridColumn).toBe("span 3");
    // The pool row's label is one cell over the three label columns and its
    // first day cell follows it directly (no shift under section or time).
    const restMonday = cell("pool-rest-day", MON);
    const restLabel = restMonday.previousElementSibling as HTMLElement;
    expect(restLabel.textContent).toBe("Rest Day");
    expect(restLabel.style.gridColumn).toBe("span 3");
    expect(restMonday.nextElementSibling).toBe(cell("pool-rest-day", TUE));
  });

  it("draws a hairline between the lanes of a section, a line between sections, a stronger one between rows", () => {
    renderStacked({ rows: [rotating, { ...groupRow, id: "group-loc-1__rb-mr", rowBandId: "rb-mr" }] });
    const classes = (rowId: string, dateISO: string) => cell(rowId, dateISO).className;
    // Rotating row: CT lane, then MR neuro, then MR prostate — sections differ.
    expect(classes("ct-mon-early", MON)).toContain(STACKED_DIVIDER.section);
    expect(classes("ct-mon-late", MON)).toContain(STACKED_DIVIDER.section);
    // The last lane closes the row.
    expect(classes("ct-tue-late", TUE)).toContain(STACKED_DIVIDER.row);
    // Second row: one section in two lanes, a hairline between them.
    const second = Array.from(
      document.querySelectorAll<HTMLElement>('[data-schedule-cell="true"][data-row-id="ct-mon-early"]'),
    ).at(-1)!;
    expect(second.className).toContain(STACKED_DIVIDER.lane);
    // The row band cell ends with the row's line, the section cells with theirs.
    const [firstBand] = labelCells("band");
    expect(firstBand.className).toContain(STACKED_DIVIDER.row);
    expect(labelCells("section")[1].className).toContain(STACKED_DIVIDER.section);
  });

  it("keeps one label cell per lane in a single-day view", () => {
    renderStacked({
      rows: [rotating],
      weekDays: [new Date(2026, 0, 5)],
      dayColumns: dayColumns.slice(0, 2),
    });
    const grid = document.querySelector('[data-schedule-grid="true"]') as HTMLElement;
    expect(grid.style.gridTemplateColumns.startsWith("minmax(112px, 168px)")).toBe(true);
    expect(labelCells("band")).toHaveLength(0);
    // Monday: the CT lane and the MR neuro lane; Tuesday's prostate lane is hidden.
    expect(screen.getByText("MR neuro")).toBeTruthy();
    expect(screen.queryByText("MR prostate")).toBeNull();
  });

  it("names the section on every lane in a single-day view, also on a later lane of one section", () => {
    renderStacked({
      rows: [{ ...groupRow, rowBandLabel: "Imaging" }],
      weekDays: [new Date(2026, 0, 5)],
      dayColumns: dayColumns.slice(0, 2),
    });
    // Both CT lanes (07:00 and 14:00) name CT; the later one a little quieter.
    const names = screen.getAllByText("CT", { selector: "span" });
    expect(names).toHaveLength(2);
    expect(names[0].className).not.toContain("opacity-75");
    expect(names[1].className).toContain("opacity-75");
    expect(document.querySelector(".sr-only")).toBeNull();
  });

  it("shows a cell's own time only where it differs from its row, as a quiet note under the people", () => {
    renderStacked({
      assignmentMap: new Map([
        ...assignmentMap,
        [`ct-tue-late__${TUE}`, [{ id: "a2", rowId: "ct-tue-late", dateISO: TUE, clinicianId: "y" }]],
      ]),
    });
    const tue = cell("ct-tue-late", TUE);
    expect(within(tue).getByText("14:00–20:00")).toBeTruthy();
    expect(within(cell("ct-mon-late", MON)).queryByText("14:00–22:00")).toBeNull();
    // Not a chip above the pills (it was taken for a row label): plain text
    // with a clock, after the person.
    const note = tue.querySelector<HTMLElement>("[data-own-time]")!;
    expect(note.className).not.toMatch(/rounded|ring|bg-/);
    expect(note.querySelector("svg")).not.toBeNull();
    const pill = tue.querySelector('[data-assignment-pill="true"]')!;
    expect(pill.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("never mixes sections in a lane: no section tag in a cell, the label names it", () => {
    renderStacked({ rows: [rotating], minSlotsByRowId: { "ct-tue-late": { weekday: 1, weekend: 0 } } });
    // Monday's neuro and Tuesday's prostate slot each have a lane of their
    // own, so Tuesday in the neuro lane is hatched, not an open "MR neuro" slot.
    const tuesdayNeuro = document.querySelector(
      `[data-schedule-cell="true"][data-date-iso="${TUE}"][data-row-id="group-loc-1__rb-ct__t2"]`,
    ) as HTMLElement;
    expect(tuesdayNeuro.className).toContain("stacked-off-cell");
    // The open prostate slot names neither section nor time: its lane's
    // label says both.
    const tue = cell("ct-tue-late", TUE);
    expect(within(tue).queryByText("MR prostate")).toBeNull();
    expect(tue.querySelector("[data-own-time]")).toBeNull();
    expect(within(tue).getByText("Open")).toBeTruthy();
    expect(labelCells("section").at(-1)?.textContent).toBe("MR prostate");
    expect(labelCells("time").at(-1)?.textContent).toBe("14:00–20:00");
    // The tooltip keeps section and time; the label has no "+N".
    expect(tue.getAttribute("title")).toBe("MR prostate · 14:00 - 20:00");
    expect(screen.queryByText(/^\+\d+$/)).toBeNull();
    expect(document.querySelector("[data-other-section]")).toBeNull();
  });

  it("tints each lane label and cell with its own section's color in the section look", () => {
    renderStacked({ rows: [rotating] });
    const sectionColors = labelCells("section").map((c) => c.style.getPropertyValue("--section-color"));
    expect(sectionColors).toEqual(["#BBF7D0", "#DDD6FE", "#BFDBFE"]);
    expect(labelCells("time").every((c) => c.className.includes("stacked-label-tint"))).toBe(true);
    const tue = cell("ct-tue-late", TUE);
    expect(tue.className).toContain("stacked-section-cell");
    expect(tue.style.getPropertyValue("--section-color")).toBe("#BFDBFE");
    expect(cell("ct-mon-early", MON).style.getPropertyValue("--section-color")).toBe("#BBF7D0");
  });

  it("names the section of a later lane for screen readers and in its tooltip", () => {
    renderStacked({ rows: [{ ...groupRow, rowBandLabel: "Imaging" }] });
    const [, late] = labelCells("time");
    expect(late.getAttribute("title")).toBe("CT · 14:00–22:00");
    expect(late.querySelector(".sr-only")?.textContent?.trim()).toBe("CT");
    // The section cell spans both lanes and names CT once.
    expect(labelCells("section").map((c) => [c.textContent, c.style.gridRow])).toEqual([["CT", "span 2"]]);
  });

  it("colors every lane label of a row band with its location's shade instead of the section color", () => {
    renderStacked({
      rows: [{ ...groupRow, slotRows: groupRow.slotRows!.map((slot) => ({ ...slot, blockColor: "#BFDBFE" })) }],
      locationRowTints: buildLocationRowTints([{ id: "loc-1", name: "Campus", color: "#DCFCE7" }], false),
    });
    const labels = Array.from(document.querySelectorAll<HTMLElement>("[data-label-shade]"));
    // Row band, section and both time cells of the CT row band: the green
    // location's first shade.
    expect(labels.map((label) => label.dataset.labelShade)).toEqual(["#DCFCE7", "#DCFCE7", "#DCFCE7", "#DCFCE7"]);
    expect(labels[0].style.backgroundColor).toBe("rgb(220, 252, 231)");
    expect(document.querySelector(".stacked-label-tint")).toBeNull();
    expect(screen.getByText("07:00–15:00").style.color).toBe("rgb(5, 46, 22)");
    // The band above names the location in white on its strong green.
    const band = document.querySelector<HTMLElement>('[data-location-band="true"]')!;
    expect(band.textContent).toBe("Campus");
    expect(band.parentElement?.style.backgroundColor).toBe("rgb(21, 128, 61)");
  });

  it("draws no section block and keeps person-colored cells untinted", () => {
    renderStacked({
      rows: [{ ...groupRow, slotRows: groupRow.slotRows!.map((slot) => ({ ...slot, blockColor: "#BFDBFE" })) }],
      personPillStyles: buildPersonPillStyles([{ id: "x", name: "Xena Young", qualifiedClassIds: [], preferredClassIds: [], vacations: [] }]),
    });
    const mon = cell("ct-mon-early", MON);
    expect(mon.querySelector(".rounded-lg.border-2")).toBeNull();
    expect(mon.className).not.toContain("stacked-section-cell");
    // The lane label still carries the section color.
    expect(document.querySelector(".stacked-label-tint")).not.toBeNull();
  });

  it("hatches days without a slot in the lane", () => {
    renderStacked({ rows: [{ ...groupRow, slotRows: groupRow.slotRows!.filter((slot) => slot.id !== "ct-tue-late") }] });
    const lateTuesday = document.querySelector(
      `[data-schedule-cell="true"][data-date-iso="${TUE}"][data-row-id="group-loc-1__rb-ct__t2"]`,
    ) as HTMLElement;
    expect(lateTuesday.className).toContain("stacked-off-cell");
    expect(cell("ct-tue-early", TUE).className).not.toContain("stacked-off-cell");
  });

  it("writes short open slots in the compact grid", () => {
    renderStacked({ minSlotsByRowId: { "ct-tue-early": { weekday: 1, weekend: 0 } } });
    expect(within(cell("ct-tue-early", TUE)).getByText("Open")).toBeTruthy();
    expect(screen.queryByText("Open Slot")).toBeNull();
  });

  const lockedPill = (assignment: Partial<RenderedAssignment>) => {
    const onToggleAssignmentLock = vi.fn();
    renderStacked({
      onToggleAssignmentLock,
      assignmentMap: new Map([
        [`ct-mon-early__${MON}`, [{ id: "a1", rowId: "ct-mon-early", dateISO: MON, clinicianId: "x", ...assignment }]],
      ]),
    });
    const pill = document.querySelector(
      `[data-schedule-grid="true"] [data-assignment-key="ct-mon-early__${MON}__x"]`,
    ) as HTMLElement;
    const button = within(pill).getByRole("button", { name: "Lock assignment for Person X" });
    return { pill, button, onToggleAssignmentLock };
  };

  it("shows a locked planner pill's closed lock in the row, at the same height", () => {
    const { pill, button } = lockedPill({ source: "solver", locked: true });
    expect(button).toHaveAttribute("aria-pressed", "true");
    expect(pill.dataset.locked).toBe("true");
    // In the row (relative), not laid over the name; the pill keeps its height.
    expect(button.className).toContain("relative");
    expect(button.className).not.toContain("pill-lock-reveal");
    expect(pill.classList).not.toContain("min-h-7");
    expect(pill.className).not.toContain("[@media(hover:none)]:pr-[22px]");
  });

  it("shows an unlocked planner pill's open lock only on hover, over the faded name", () => {
    const { pill, button } = lockedPill({ source: "solver" });
    expect(button).toHaveAttribute("aria-pressed", "false");
    expect(pill.dataset.locked).toBe("false");
    expect(button.className).toContain("pill-lock-reveal");
    expect(button.className).toContain("absolute");
    expect(pill.querySelector(".pill-lock-fade")).not.toBeNull();
    expect(pill.classList).toContain("pr-1.5");
    // Touch screens always show the lock: its room is kept there.
    expect(pill.classList).toContain("[@media(hover:none)]:pr-[22px]");
  });

  it("starts a hand-placed pill locked and toggles it with the same button", () => {
    const { button, onToggleAssignmentLock } = lockedPill({ source: "manual" });
    expect(button).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(button);
    expect(onToggleAssignmentLock).toHaveBeenCalledWith(expect.objectContaining({ id: "a1", source: "manual" }));
  });

  it("shows no lock on read-only grids (print, public week)", () => {
    renderStacked({
      readOnly: true,
      onToggleAssignmentLock: vi.fn(),
      assignmentMap: new Map([
        [`ct-mon-early__${MON}`, [{ id: "a1", rowId: "ct-mon-early", dateISO: MON, clinicianId: "x", source: "manual" as const }]],
      ]),
    });
    const pill = document.querySelector(
      `[data-schedule-grid="true"] [data-assignment-key="ct-mon-early__${MON}__x"]`,
    ) as HTMLElement;
    expect(pill.querySelector("button")).toBeNull();
    expect(pill.querySelector("svg")).toBeNull();
  });

  it("moves a pill between the time bands of a day", () => {
    const { onMoveWithinDay } = renderStacked();
    const pill = document.querySelector(
      `[data-schedule-grid="true"] [data-assignment-key="ct-mon-early__${MON}__x"]`,
    ) as HTMLElement;
    const data: Record<string, string> = {};
    const dataTransfer = {
      setData: (type: string, value: string) => {
        data[type] = value;
      },
      getData: (type: string) => data[type] ?? "",
      setDragImage: () => {},
      effectAllowed: "all",
      dropEffect: "none",
    };
    const target = cell("ct-mon-late", MON);
    fireEvent.dragStart(pill, { dataTransfer });
    fireEvent.dragOver(target, { dataTransfer });
    fireEvent.drop(target, { dataTransfer });
    expect(onMoveWithinDay).toHaveBeenCalledWith({
      dateISO: MON,
      fromRowId: "ct-mon-early",
      toRowId: "ct-mon-late",
      assignmentId: "a1",
      clinicianId: "x",
    });
  });

  it("keeps the side-by-side columns by default", () => {
    renderStacked({ timeLayout: undefined });
    const grid = document.querySelector('[data-schedule-grid="true"]') as HTMLElement;
    expect(grid.style.gridTemplateColumns).toContain("repeat(4,");
    expect(cells()).toHaveLength(4);
    expect(screen.queryByText("Campus", { selector: "span.rounded-full" })).toBeNull();
  });
});
