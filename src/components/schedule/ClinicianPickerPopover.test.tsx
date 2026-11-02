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

const renderPicker = (onClose: () => void, options: ClinicianOption[] = clinicians, onFindCover?: () => void) => (
  <ClinicianPickerPopover
    open
    onClose={onClose}
    onSelect={vi.fn()}
    clinicians={options}
    anchorRect={anchorRect}
    rowName="MRI"
    dateLabel="Mon 5 Oct"
    onFindCover={onFindCover}
  />
);

const flushTimers = () => act(() => new Promise((resolve) => setTimeout(resolve, 10)));

describe("ClinicianPickerPopover", () => {
  it("names the weekly limit and lists such people after the free ones", async () => {
    render(
      <ClinicianPickerPopover
        open
        onClose={vi.fn()}
        onSelect={vi.fn()}
        clinicians={[
          { ...option("c1", "Anna Alpha"), isOverWeeklyHours: true, weeklyHoursLabel: "41.5/40 h in 2026-W45" },
          option("c2", "Bert Beta"),
        ]}
        anchorRect={anchorRect}
        rowName="IRM seno ZK"
        dateLabel="Fri 6 Nov"
      />,
    );
    await flushTimers();
    expect(screen.getByText("Over weekly limit (41.5/40 h in 2026-W45)")).toBeInTheDocument();
    const names = screen.getAllByRole("button").map((button) => button.textContent ?? "");
    expect(names.findIndex((text) => text.includes("Bert Beta"))).toBeLessThan(
      names.findIndex((text) => text.includes("Anna Alpha")),
    );
  });

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

  it("finds names without typing their accents", () => {
    const roster = [
      option("c1", "Müller, Jörg; Dr."),
      option("c2", "Zoë O'Brien-Łukasiewicz"),
      option("c3", "Ünal Çelik"),
      option("c4", "Björn Ødegård"),
      option("c5", "Anaïs Lefèvre"),
      option("c6", "Bert Beta"),
    ];
    render(renderPicker(() => {}, roster));
    const search = screen.getByPlaceholderText("Search clinicians...");
    const found = (query: string) => {
      fireEvent.change(search, { target: { value: query } });
      return screen.queryAllByRole("button").map((button) => button.textContent ?? "");
    };
    for (const query of ["Jorg", "joerg", "muller", "mueller"]) {
      expect(found(query).some((text) => text.includes("Müller, Jörg; Dr."))).toBe(true);
    }
    expect(found("zoe").some((text) => text.includes("Zoë"))).toBe(true);
    expect(found("lukasiewicz").some((text) => text.includes("Łukasiewicz"))).toBe(true);
    expect(found("celik").some((text) => text.includes("Çelik"))).toBe(true);
    expect(found("odegard").some((text) => text.includes("Ødegård"))).toBe(true);
    expect(found("Lefevre").some((text) => text.includes("Lefèvre"))).toBe(true);
    expect(found("muller").some((text) => text.includes("Bert Beta"))).toBe(false);
  });

  it("offers \"Find cover…\" below the list only with onFindCover", () => {
    const { rerender } = render(renderPicker(() => {}));
    expect(screen.queryByRole("button", { name: "Find cover for this slot" })).toBeNull();
    const onFindCover = vi.fn();
    rerender(renderPicker(() => {}, clinicians, onFindCover));
    const button = screen.getByRole("button", { name: "Find cover for this slot" });
    expect(button).toHaveTextContent("Find cover…");
    fireEvent.click(button);
    expect(onFindCover).toHaveBeenCalledOnce();
  });
});
