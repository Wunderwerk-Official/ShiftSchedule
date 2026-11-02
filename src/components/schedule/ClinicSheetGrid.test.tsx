import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { RenderedAssignment } from "../../lib/schedule";
import type { ScheduleRow } from "../../lib/shiftRows";
import { EXCEL_CYAN, buildClinicSheetModel, buildMonthDays } from "../../lib/clinicSheet";
import type { ComponentProps } from "react";
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
    onFindSwap?: ComponentProps<typeof ClinicSheetGrid>["onFindSwap"];
    onFindCover?: ComponentProps<typeof ClinicSheetGrid>["onFindCover"];
    requiredSlots?: number;
    /** Jonas Keller on vacation the same day (a pool name). */
    withVacation?: boolean;
  } = {},
) => {
  const slotRow = makeSlotRow(options.requiredSlots === undefined ? {} : { requiredSlots: options.requiredSlots });
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
  if (options.withVacation) {
    assignmentMap.set("pool-vacation__2026-07-06", [
      { id: "vac-2", rowId: "pool-vacation", dateISO: "2026-07-06", clinicianId: "clin-2" },
    ]);
  }
  const onAddAssignment = vi.fn();
  const onRemoveAssignment = vi.fn();
  const onMoveWithinDay = vi.fn();
  render(
    <ClinicSheetGrid
      model={model}
      assignmentMap={assignmentMap}
      rows={[groupedRow, poolRow]}
      readOnly={options.readOnly}
      getClinicianName={(id) => ({ "clin-1": "Anna Bergmann", "clin-2": "Jonas Keller" })[id] ?? "Unbekannt"}
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
      onFindSwap={options.onFindSwap}
      onFindCover={options.onFindCover}
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

  it("ignores a malformed drag payload", () => {
    const { onMoveWithinDay, onRemoveAssignment } = setup();
    const name = screen.getByText("Bergmann").closest('[data-sheet-name="true"]') as HTMLElement;
    fireEvent.dragStart(name, { dataTransfer: makeDataTransfer() });
    const broken = { ...makeDataTransfer(), getData: () => "{not json" };
    fireEvent.drop(sheetCell("pool-vacation", "2026-07-06"), { dataTransfer: broken });
    expect(onMoveWithinDay).not.toHaveBeenCalled();
    expect(onRemoveAssignment).not.toHaveBeenCalled();
  });

  it("uses the sheet cyan constant for weekend blocks", () => {
    expect(EXCEL_CYAN).toBe("#00CCFF");
  });
});

describe("ClinicSheetGrid find swap and cover", () => {
  const findSwapButton = () => screen.getByRole("button", { name: "Find swap for Anna Bergmann" });
  const nameOf = (element: HTMLElement) => element.closest("[data-sheet-name]") as HTMLElement;

  it("puts the swap button on slot names only and keys them for the preview outline", () => {
    const onFindSwap = vi.fn();
    setup({ source: "manual", onToggleAssignmentLock: vi.fn(), onFindSwap, withVacation: true });
    const name = nameOf(findSwapButton());
    expect(name.getAttribute("data-sheet-assignment-key")).toBe("slot-mri__mon__2026-07-06__clin-1");
    expect(name.hasAttribute("data-assignment-key")).toBe(false);
    const vacation = nameOf(screen.getByText("Keller"));
    expect(vacation.hasAttribute("data-sheet-assignment-key")).toBe(false);
    expect(within(vacation).queryByRole("button", { name: /Find swap/ })).toBeNull();
    fireEvent.click(findSwapButton());
    expect(onFindSwap).toHaveBeenCalledWith({
      assignmentId: "assign-1",
      rowId: "slot-mri__mon",
      dateISO: "2026-07-06",
      clinicianId: "clin-1",
    });
  });

  it("locked name: the button sits left of the in-row lock, touch room is a margin of the name", () => {
    const onFindSwap = vi.fn();
    setup({ source: "manual", onToggleAssignmentLock: vi.fn(), onFindSwap });
    expect(findSwapButton().className).toContain("right-[21px]");
    const name = nameOf(findSwapButton());
    const text = name.querySelector(".pill-swap-fade-inrow") as HTMLElement;
    expect(text.className).toContain("[@media(hover:none)]:mr-5");
    expect(name.className).not.toContain("[@media(hover:none)]:pr-");
    const lock = within(name).getByRole("button", { name: "Lock assignment for Anna Bergmann" });
    fireEvent.keyDown(lock, { key: "s" });
    expect(onFindSwap).toHaveBeenCalledOnce();
  });

  it("unlocked name: the button sits left of the hover lock, with touch room for both", () => {
    setup({ source: "solver", onToggleAssignmentLock: vi.fn(), onFindSwap: vi.fn() });
    expect(findSwapButton().className).toContain("right-[19px]");
    const name = nameOf(findSwapButton());
    expect(name.className).toContain("[@media(hover:none)]:pr-10");
    expect(name.className).not.toContain("[@media(hover:none)]:pr-5");
    expect(name.querySelector(".pill-swap-fade")).not.toBeNull();
    expect(name.querySelector(".pill-lock-fade")).toBeNull();
  });

  it("offers \"Find cover…\" in the picker of an area with an open position only", () => {
    const onFindCover = vi.fn();
    const { slotRow } = setup({ onFindCover });
    fireEvent.click(sheetCell(slotRow.id, "2026-07-06"));
    fireEvent.click(screen.getByRole("button", { name: "Find cover for this slot" }));
    expect(onFindCover).toHaveBeenCalledWith({ rowId: slotRow.id, dateISO: "2026-07-06" });
    expect(screen.queryByPlaceholderText("Search clinicians...")).toBeNull();
  });

  it("shows no \"Find cover…\" for a full area", () => {
    const { slotRow } = setup({ onFindCover: vi.fn(), requiredSlots: 1 });
    fireEvent.click(sheetCell(slotRow.id, "2026-07-06"));
    expect(screen.getByPlaceholderText("Search clinicians...")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Find cover for this slot" })).toBeNull();
  });
});
