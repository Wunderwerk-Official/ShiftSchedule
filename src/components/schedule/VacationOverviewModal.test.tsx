import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import VacationOverviewModal from "./VacationOverviewModal";

// jsdom implements neither element scrolling nor pointer capture.
beforeEach(() => {
  Element.prototype.scrollTo = vi.fn();
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

// jsdom (v25) has no PointerEvent; without it fireEvent.pointerDown falls
// back to a plain Event where button/clientX are undefined.
if (typeof window.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    pointerId: number;
    pointerType: string;
    constructor(type: string, params: PointerEventInit = {}) {
      super(type, params);
      this.pointerId = params.pointerId ?? 0;
      this.pointerType = params.pointerType ?? "";
    }
  }
  (window as unknown as { PointerEvent: typeof MouseEvent }).PointerEvent =
    PointerEventPolyfill as unknown as typeof MouseEvent;
}

// The timeline starts one year before the current one (YEAR_RANGE = 3,
// centered on today), so day index 0 maps to Jan 1 of last year.
const rangeStartYear = new Date().getFullYear() - 1;

// jsdom rects are all zeros, so clientX maps straight onto the timeline:
// the name column occupies [0, 100) (MIN_LEFT_COLUMN_WIDTH) and each day
// is 20px wide, i.e. clientX 110 = day 0, 130 = day 1, ...
const clientXForDay = (dayIndex: number) => 100 + dayIndex * 20 + 10;

const clinicians = [
  { id: "clin-1", name: "Dr. Smith", vacations: [] },
  { id: "clin-2", name: "Dr. Jones", vacations: [] },
];

const renderModal = (overrides: {
  onSelectClinician?: (clinicianId: string) => void;
  onCreateVacationRange?: (clinicianId: string, startISO: string, endISO: string) => void;
  onClose?: () => void;
}) =>
  render(
    <VacationOverviewModal
      open={true}
      onClose={overrides.onClose ?? (() => {})}
      clinicians={clinicians}
      sections={[]}
      assignments={[]}
      onSelectClinician={overrides.onSelectClinician ?? (() => {})}
      onCreateVacationRange={overrides.onCreateVacationRange}
    />,
  );

const getRow = (name: string) =>
  screen.getByRole("button", { name: `${name} vacation timeline` });

describe("VacationOverviewModal drag-to-create", () => {
  it("opens the clinician editor on a plain click", () => {
    const onSelectClinician = vi.fn();
    renderModal({ onSelectClinician, onCreateVacationRange: vi.fn() });
    const row = getRow("Dr. Smith");
    fireEvent.pointerDown(row, { pointerId: 1, button: 0, clientX: clientXForDay(0) });
    fireEvent.pointerUp(row, { pointerId: 1, clientX: clientXForDay(0) });
    fireEvent.click(row);
    expect(onSelectClinician).toHaveBeenCalledWith("clin-1");
  });

  it("creates a vacation range on drag and suppresses the trailing click", () => {
    const onSelectClinician = vi.fn();
    const onCreateVacationRange = vi.fn();
    renderModal({ onSelectClinician, onCreateVacationRange });
    const row = getRow("Dr. Smith");
    fireEvent.pointerDown(row, { pointerId: 1, button: 0, clientX: clientXForDay(0) });
    fireEvent.pointerMove(row, { pointerId: 1, clientX: clientXForDay(3) });
    fireEvent.pointerUp(row, { pointerId: 1, clientX: clientXForDay(3) });
    fireEvent.click(row);
    expect(onCreateVacationRange).toHaveBeenCalledWith(
      "clin-1",
      `${rangeStartYear}-01-01`,
      `${rangeStartYear}-01-04`,
    );
    expect(onSelectClinician).not.toHaveBeenCalled();
  });

  it("normalizes a right-to-left drag to start <= end", () => {
    const onCreateVacationRange = vi.fn();
    renderModal({ onCreateVacationRange });
    const row = getRow("Dr. Jones");
    fireEvent.pointerDown(row, { pointerId: 1, button: 0, clientX: clientXForDay(5) });
    fireEvent.pointerMove(row, { pointerId: 1, clientX: clientXForDay(2) });
    fireEvent.pointerUp(row, { pointerId: 1, clientX: clientXForDay(2) });
    expect(onCreateVacationRange).toHaveBeenCalledWith(
      "clin-2",
      `${rangeStartYear}-01-03`,
      `${rangeStartYear}-01-06`,
    );
  });

  it("does not start a drag below the movement threshold", () => {
    const onCreateVacationRange = vi.fn();
    renderModal({ onCreateVacationRange });
    const row = getRow("Dr. Smith");
    const startX = clientXForDay(0);
    fireEvent.pointerDown(row, { pointerId: 1, button: 0, clientX: startX });
    fireEvent.pointerMove(row, { pointerId: 1, clientX: startX + 3 });
    fireEvent.pointerUp(row, { pointerId: 1, clientX: startX + 3 });
    expect(onCreateVacationRange).not.toHaveBeenCalled();
  });

  it("ignores touch pointers", () => {
    const onCreateVacationRange = vi.fn();
    renderModal({ onCreateVacationRange });
    const row = getRow("Dr. Smith");
    fireEvent.pointerDown(row, {
      pointerId: 1,
      button: 0,
      pointerType: "touch",
      clientX: clientXForDay(0),
    });
    fireEvent.pointerMove(row, { pointerId: 1, clientX: clientXForDay(4) });
    fireEvent.pointerUp(row, { pointerId: 1, clientX: clientXForDay(4) });
    expect(onCreateVacationRange).not.toHaveBeenCalled();
  });

  it("cancels an active drag with Escape without closing the modal", () => {
    const onClose = vi.fn();
    const onSelectClinician = vi.fn();
    const onCreateVacationRange = vi.fn();
    renderModal({ onClose, onSelectClinician, onCreateVacationRange });
    const row = getRow("Dr. Smith");
    fireEvent.pointerDown(row, { pointerId: 1, button: 0, clientX: clientXForDay(0) });
    fireEvent.pointerMove(row, { pointerId: 1, clientX: clientXForDay(4) });
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.pointerUp(row, { pointerId: 1, clientX: clientXForDay(4) });
    fireEvent.click(row);
    expect(onCreateVacationRange).not.toHaveBeenCalled();
    expect(onSelectClinician).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText("Vacation Overview")).toBeInTheDocument();
    // A second Escape (no drag active) closes the modal.
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("clamps a drag that leaves the timeline to the last day", () => {
    const onCreateVacationRange = vi.fn();
    renderModal({ onCreateVacationRange });
    const row = getRow("Dr. Smith");
    fireEvent.pointerDown(row, { pointerId: 1, button: 0, clientX: clientXForDay(2) });
    fireEvent.pointerMove(row, { pointerId: 1, clientX: 0 });
    fireEvent.pointerUp(row, { pointerId: 1, clientX: 0 });
    expect(onCreateVacationRange).toHaveBeenCalledWith(
      "clin-1",
      `${rangeStartYear}-01-01`,
      `${rangeStartYear}-01-03`,
    );
  });
});
