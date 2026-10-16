import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { RenderedAssignment } from "../../lib/schedule";
import type { ScheduleRow } from "../../lib/shiftRows";
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

  it("renders pills and row labels without inline colors by default", () => {
    const { container } = renderGrid({
      rows: [locatedRow],
      locationSeparatorRowIds: [locatedRow.id],
      locationRowTints: buildLocationRowTints([{ id: "loc-1", name: "Berlin" }], false),
    });
    const pill = screen.getByText("Dr. Alice").closest("[data-assignment-pill=\"true\"]");
    expect(pill?.getAttribute("style")).toBeNull();
    expect(pill?.className).not.toContain("outline");
    expect(container.querySelector('[style*="background-color"]')).toBeNull();
  });

  it("colors pills by person (initials, palette colors, outline for me)", () => {
    renderGrid({ personPillStyles: buildPersonPillStyles(clinicians), myClinicianId: "clin-1" });
    const pill = screen.getByText("Dr. Alice").closest("[data-assignment-pill=\"true\"]") as HTMLElement;
    // Second clinician → palette p02.
    expect(pill.style.backgroundColor).toBe("rgb(254, 243, 199)");
    expect(pill.style.borderColor).toBe("rgb(180, 83, 9)");
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
    expect(pill.style.backgroundColor).toBe("rgb(70, 36, 16)"); // p02 dark fill #462410
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

  it("keeps the default pill look: 2 px border, inner hairline, centered name, no initials", () => {
    const { container } = renderGrid({
      rows: [{ ...baseRow, blockColor: "#FF99CC" }],
      onToggleAssignmentLock: vi.fn(),
    });
    const pill = screen.getByText("Dr. Alice").closest('[data-assignment-pill="true"]') as HTMLElement;
    expect(pill.getAttribute("style")).toBeNull();
    // pr-4: room for the manual lock badge, so long names abbreviate instead of running under it.
    for (const token of ["border-2", "pl-1.5", "pr-4", "py-0.5", "shadow-[inset_0_0_0_1px_rgba(255,255,255,0.7)]", "bg-sky-50", "border-sky-200"]) {
      expect(pill.classList).toContain(token);
    }
    expect(pill.classList).not.toContain("border");
    expect(pill.classList).not.toContain("pr-5");
    const name = screen.getByText("Dr. Alice");
    expect(name.className).toBe("whitespace-nowrap text-center");
    expect(name.parentElement?.className).toContain("justify-center");
    expect(name.parentElement?.getAttribute("title")).toBeNull();
    expect(pill.getAttribute("title")).toBeNull();
    // Manual pill: lock badge, no initials circle (no inline-styled spans at all).
    expect(pill.querySelector("svg")).not.toBeNull();
    expect(pill.querySelector("[style]")).toBeNull();
    // The section block keeps its fill and its title.
    const fills = container.querySelectorAll('[style*="rgb(255, 153, 204)"]');
    expect(fills).toHaveLength(1);
    expect(fills[0].textContent).toContain("MRI");
  });

  it("tints the label cells and the separator of a colored location", () => {
    const { container } = renderGrid({
      rows: [locatedRow],
      locationSeparatorRowIds: [locatedRow.id],
      locationRowTints: buildLocationRowTints([{ id: "loc-1", name: "Berlin", color: "#EEDFC4" }], false),
    });
    const tinted = container.querySelectorAll<HTMLElement>('[style*="background-color"]');
    expect(tinted.length).toBeGreaterThanOrEqual(2);
    const chip = screen.getAllByTitle("Berlin").find((element) => element.style.backgroundColor);
    expect(chip?.style.backgroundColor).toBe("rgb(226, 201, 158)");
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

  it("draws a hairline between the lanes of a row, a full line after its last lane", () => {
    renderStacked();
    expect(cell("ct-mon-early", MON).className).toContain("border-b-slate-100");
    expect(cell("ct-mon-late", MON).className).not.toContain("border-b-slate-100");
    expect(cell("ct-mon-late", MON).className).toContain("border-slate-200");
  });

  it("shows a cell's own time only where it differs from its row", () => {
    renderStacked();
    expect(within(cell("ct-tue-late", TUE)).getByText("14:00–20:00")).toBeTruthy();
    expect(within(cell("ct-mon-late", MON)).queryByText("14:00–22:00")).toBeNull();
  });

  it("names no section in a cell: the label shows +N, the cell keeps it in its tooltip", () => {
    const mixed: ScheduleRow = {
      ...groupRow,
      slotRows: groupRow.slotRows!.map((slot) =>
        slot.id === "ct-tue-early"
          ? { ...slot, sectionId: "sec-mr", sectionName: "MR", name: "MR", blockColor: "#BBF7D0" }
          : { ...slot, blockColor: "#BFDBFE" },
      ),
    };
    renderStacked({ rows: [mixed] });
    const tue = cell("ct-tue-early", TUE);
    expect(within(tue).queryByText("MR")).toBeNull();
    expect(tue.getAttribute("title")).toBe("MR · 07:00 - 15:00");
    const badge = screen.getByText("+1");
    expect(badge.getAttribute("title")).toBe("Other days: Tue: MR");
    // Section look: each cell is tinted with its own section's color.
    expect(tue.className).toContain("stacked-section-cell");
    expect(tue.style.getPropertyValue("--section-color")).toBe("#BBF7D0");
    expect(cell("ct-mon-early", MON).style.getPropertyValue("--section-color")).toBe("#BFDBFE");
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

  it("marks a day of another section without naming it, and hatches days without a slot", () => {
    const mixed: ScheduleRow = {
      ...groupRow,
      // Tuesday has no late slot; its early slot belongs to another section.
      slotRows: groupRow.slotRows!
        .filter((slot) => slot.id !== "ct-tue-late")
        .map((slot) => (slot.id === "ct-tue-early" ? { ...slot, sectionId: "sec-mr", sectionName: "MR", name: "MR" } : slot)),
    };
    renderStacked({ rows: [mixed] });
    expect(cell("ct-tue-early", TUE).querySelector('[data-other-section="true"]')).not.toBeNull();
    expect(cell("ct-mon-early", MON).querySelector('[data-other-section="true"]')).toBeNull();
    const lateTuesday = document.querySelector(
      `[data-schedule-cell="true"][data-date-iso="${TUE}"][data-row-id="group-loc-1__rb-ct__t2"]`,
    ) as HTMLElement;
    expect(lateTuesday.className).toContain("stacked-off-cell");
  });

  it("writes short open slots in the compact grid", () => {
    renderStacked({ minSlotsByRowId: { "ct-tue-early": { weekday: 1, weekend: 0 } } });
    expect(within(cell("ct-tue-early", TUE)).getByText("Open")).toBeTruthy();
    expect(screen.queryByText("Open Slot")).toBeNull();
  });

  it("keeps the fix button and its room on a fixed pill", () => {
    renderStacked({
      onToggleAssignmentLock: vi.fn(),
      assignmentMap: new Map([
        [`ct-mon-early__${MON}`, [{ id: "a1", rowId: "ct-mon-early", dateISO: MON, clinicianId: "x", source: "solver" as const, locked: true }]],
      ]),
    });
    const pill = document.querySelector(
      `[data-schedule-grid="true"] [data-assignment-key="ct-mon-early__${MON}__x"]`,
    ) as HTMLElement;
    expect(pill.classList).toContain("pr-6");
    const button = screen.getByRole("button", { name: /Unfix assignment/ });
    expect(button.parentElement?.className).not.toContain("opacity-0");
  });

  it("keeps no room for the fix button of an unfixed pill (shown on hover)", () => {
    renderStacked({
      onToggleAssignmentLock: vi.fn(),
      assignmentMap: new Map([
        [`ct-mon-early__${MON}`, [{ id: "a1", rowId: "ct-mon-early", dateISO: MON, clinicianId: "x", source: "solver" as const }]],
      ]),
    });
    const pill = document.querySelector(
      `[data-schedule-grid="true"] [data-assignment-key="ct-mon-early__${MON}__x"]`,
    ) as HTMLElement;
    expect(pill.classList).not.toContain("pr-6");
    expect(pill.classList).toContain("[@media(hover:none)]:pr-6");
    expect(screen.getByRole("button", { name: /Fix assignment/ })).toBeTruthy();
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
