import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import PublishWeeksPopover from "./PublishWeeksPopover";

const setup = (publishedWeekStartISOs: string[] = []) => {
  const onSetWeekPublished = vi.fn();
  const onSetWeeksPublished = vi.fn();
  render(
    <PublishWeeksPopover
      monthStart={new Date(2026, 6, 1)} // July 2026: weeks of Jun 29 .. Jul 27
      publishedWeekStartISOs={publishedWeekStartISOs}
      onSetWeekPublished={onSetWeekPublished}
      onSetWeeksPublished={onSetWeeksPublished}
    />,
  );
  return { onSetWeekPublished, onSetWeeksPublished };
};

const JULY_WEEKS = [
  "2026-06-29",
  "2026-07-06",
  "2026-07-13",
  "2026-07-20",
  "2026-07-27",
];

describe("PublishWeeksPopover", () => {
  it("shows the published count on the trigger", () => {
    setup(["2026-07-06", "2026-07-13"]);
    expect(screen.getByText("2/5")).toBeTruthy();
  });

  it("lists every week of the month and toggles a single week", () => {
    const { onSetWeekPublished } = setup(["2026-07-06"]);
    fireEvent.click(screen.getByText("Publish"));
    const switches = screen.getAllByRole("switch");
    expect(switches).toHaveLength(5);
    // First listed week (Jun 29) is unpublished -> toggle publishes it.
    fireEvent.click(switches[0]);
    expect(onSetWeekPublished).toHaveBeenCalledWith("2026-06-29", true);
    // Second listed week (Jul 6) is published -> toggle unpublishes it.
    fireEvent.click(switches[1]);
    expect(onSetWeekPublished).toHaveBeenCalledWith("2026-07-06", false);
  });

  it("publishes and unpublishes all listed weeks via the quick actions", () => {
    const { onSetWeeksPublished } = setup();
    fireEvent.click(screen.getByText("Publish"));
    fireEvent.click(screen.getByText("All on"));
    expect(onSetWeeksPublished).toHaveBeenCalledWith(JULY_WEEKS, true);
    fireEvent.click(screen.getByText("All off"));
    expect(onSetWeeksPublished).toHaveBeenCalledWith(JULY_WEEKS, false);
  });

  it("closes on outside click", () => {
    setup();
    fireEvent.click(screen.getByText("Publish"));
    expect(screen.getByText("Published weeks")).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByText("Published weeks")).toBeNull();
  });
});
