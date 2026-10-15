import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ClinicianPickerPopover, { type ClinicianOption } from "./ClinicianPickerPopover";

const option = (id: string, name: string): ClinicianOption => ({
  id,
  name,
  isQualified: true,
  isOnVacation: false,
  isOnRestDay: false,
  hasTimeConflict: false,
  hasLocationConflict: false,
  alreadyAssigned: false,
});

const clinicians = [option("c1", "Anna Alpha"), option("c2", "Bert Beta")];
const anchorRect = { top: 100, bottom: 120, left: 100, right: 200, width: 100, height: 20 } as DOMRect;

const renderPicker = (onClose: () => void) => (
  <ClinicianPickerPopover
    open
    onClose={onClose}
    onSelect={vi.fn()}
    clinicians={clinicians}
    anchorRect={anchorRect}
    rowName="MRI"
    dateLabel="Mon 5 Oct"
  />
);

const flushTimers = () => act(() => new Promise((resolve) => setTimeout(resolve, 10)));

describe("ClinicianPickerPopover", () => {
  it("keeps focus where the user put it when the parent re-renders", async () => {
    const { rerender } = render(renderPicker(() => {}));
    await flushTimers();
    expect(screen.getByPlaceholderText("Search clinicians...")).toHaveFocus();

    const listButton = screen.getByText("Bert Beta").closest("button")!;
    listButton.focus();
    // Grids pass a fresh inline onClose on every render.
    rerender(renderPicker(() => {}));
    await flushTimers();
    expect(listButton).toHaveFocus();
  });

  it("calls the latest onClose on Escape and on outside clicks", async () => {
    const first = vi.fn();
    const latest = vi.fn();
    const { rerender } = render(renderPicker(first));
    rerender(renderPicker(latest));

    fireEvent.keyDown(window, { key: "Escape" });
    expect(latest).toHaveBeenCalledTimes(1);

    fireEvent.mouseDown(document.body);
    expect(latest).toHaveBeenCalledTimes(2);
    expect(first).not.toHaveBeenCalled();
  });
});
