import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { RenderedAssignment } from "../../lib/schedule";
import type { ScheduleRow } from "../../lib/shiftRows";
import { EXCEL_CYAN, buildClinicSheetModel, buildMonthDays } from "../../lib/clinicSheet";
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

const setup = (options: { readOnly?: boolean } = {}) => {
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
    { id: "assign-1", rowId: slotRow.id, dateISO: "2026-07-06", clinicianId: "clin-1" },
  ];
  const assignmentMap = new Map([[`${slotRow.id}__2026-07-06`, assignments]]);
  const onAddAssignment = vi.fn();
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
      onRemoveAssignment={vi.fn()}
      onMoveWithinDay={vi.fn()}
    />,
  );
  return { onAddAssignment, slotRow };
};

describe("ClinicSheetGrid", () => {
  it("renders assignments as plain surname text, not pills", () => {
    setup();
    const name = screen.getAllByText("Bergmann")[0];
    expect(name.getAttribute("data-sheet-name")).toBe("true");
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

  it("uses the sheet cyan constant for weekend blocks", () => {
    expect(EXCEL_CYAN).toBe("#00CCFF");
  });
});
