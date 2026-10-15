import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { WeeklyCalendarTemplate } from "../../api/client";
import { DAY_TYPES } from "../../lib/dayTypes";
import { ConfirmDialogProvider } from "../ui/ConfirmDialog";
import WeeklyTemplateBuilder from "./WeeklyTemplateBuilder";

// One location and row; every day type has one column, Monday two. The slot
// sits in Monday's first column, Monday's second column is empty.
const template: WeeklyCalendarTemplate = {
  version: 4,
  blocks: [{ id: "block-1", sectionId: "sec-1", requiredSlots: 0 }],
  locations: [
    {
      locationId: "loc-1",
      rowBands: [{ id: "row-1", order: 1, label: "" }],
      colBands: [
        ...DAY_TYPES.map((dayType) => ({ id: `col-${dayType}-1`, label: "", order: 1, dayType })),
        { id: "col-mon-2", label: "", order: 2, dayType: "mon" as const },
      ],
      slots: [
        {
          id: "slot-1",
          locationId: "loc-1",
          rowBandId: "row-1",
          colBandId: "col-mon-1",
          blockId: "block-1",
          requiredSlots: 1,
          startTime: "08:00",
          endTime: "16:00",
          endDayOffset: 0,
        },
      ],
    },
  ],
};

function setup() {
  const onChange = vi.fn();
  render(
    <ConfirmDialogProvider>
      <WeeklyTemplateBuilder
        template={template}
        locations={[{ id: "loc-1", name: "Main" }]}
        rows={[{ id: "sec-1", name: "CT", kind: "class", dotColorClass: "" }]}
        onChange={onChange}
        onCreateSection={vi.fn().mockReturnValue("sec-2")}
        onUpdateSectionColor={vi.fn()}
        onAddLocation={vi.fn()}
        onRenameLocation={vi.fn()}
        onRemoveLocation={vi.fn()}
        onReorderLocations={vi.fn()}
      />
    </ConfirmDialogProvider>,
  );
  return onChange;
}

const nextLocation = (onChange: ReturnType<typeof vi.fn>) =>
  (onChange.mock.calls[0][0] as WeeklyCalendarTemplate).locations[0];

it("removes a placed slot only after confirming", async () => {
  const onChange = setup();
  fireEvent.click(screen.getByRole("button", { name: "Remove slot" }));
  const dialog = await screen.findByRole("dialog");
  expect(dialog).toHaveTextContent("including past weeks, are deleted");
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(onChange).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "Remove slot" }));
  fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Remove" }));
  await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
  expect(nextLocation(onChange).slots).toEqual([]);
});

it("asks before deleting a column with slots and deletes an empty column at once", async () => {
  const onChange = setup();
  fireEvent.click(screen.getByTestId("delete-column-mon-1"));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(nextLocation(onChange).colBands.map((band) => band.id)).not.toContain("col-mon-2");
  expect(nextLocation(onChange).slots).toHaveLength(1);

  onChange.mockClear();
  fireEvent.click(screen.getByTestId("delete-column-mon-0"));
  const dialog = await screen.findByRole("dialog");
  expect(dialog).toHaveTextContent("Delete this column?");
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
  const location = nextLocation(onChange);
  expect(location.colBands.filter((band) => band.dayType === "mon").map((band) => band.id)).toEqual([
    "col-mon-2",
  ]);
  expect(location.slots).toEqual([]);
});

it("warns that Copy Day deletes the shifts planned in the target day", () => {
  const onChange = setup();
  fireEvent.click(screen.getByRole("button", { name: "Copy Day" }));
  const modal = screen.getByRole("heading", { name: "Copy Day" }).parentElement!;
  // Copy Tuesday (empty) onto Monday, which holds the slot.
  const source = within(modal).getByRole("button", { name: "Mon" });
  fireEvent.click(source);
  fireEvent.click(within(source.parentElement!).getByRole("button", { name: "Tue" }));
  expect(within(modal).getByText("Mon (target)")).toBeVisible();
  expect(modal).toHaveTextContent(
    "All shifts planned in the target day's slots, including past weeks, are deleted.",
  );
  const copy = within(modal).getByRole("button", { name: "Copy" });
  expect(copy).toBeDisabled();
  fireEvent.click(within(modal).getByRole("checkbox"));
  fireEvent.click(copy);
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(nextLocation(onChange).slots).toEqual([]);
});
