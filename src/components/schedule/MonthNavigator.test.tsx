import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import MonthNavigator from "./MonthNavigator";
import WeekNavigator from "./WeekNavigator";

// October 2026 starts on a Thursday, so the first picker row's Monday is
// 28 Sep 2026.
const clickRowWithFirstOfMonth = () => {
  const row = screen.getByText("1").closest("button");
  expect(row).not.toBeNull();
  fireEvent.click(row!);
};

describe("MonthNavigator picker", () => {
  it("navigates to the displayed month, not the previous month's Monday", () => {
    const onGoToDate = vi.fn();
    render(
      <MonthNavigator
        month={new Date(2026, 9, 1)}
        onPrevMonth={vi.fn()}
        onNextMonth={vi.fn()}
        onToday={vi.fn()}
        onGoToDate={onGoToDate}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Pick a month" }));
    clickRowWithFirstOfMonth();

    expect(onGoToDate).toHaveBeenCalledTimes(1);
    const date: Date = onGoToDate.mock.calls[0][0];
    expect(date.getFullYear()).toBe(2026);
    expect(date.getMonth()).toBe(9);
  });
});

describe("WeekNavigator picker", () => {
  it("still navigates to the Monday of the clicked week", () => {
    const onGoToDate = vi.fn();
    render(
      <WeekNavigator
        rangeStart={new Date(2026, 9, 5)}
        rangeEndInclusive={new Date(2026, 9, 11)}
        onPrevWeek={vi.fn()}
        onNextWeek={vi.fn()}
        onToday={vi.fn()}
        onGoToDate={onGoToDate}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Pick a week" }));
    clickRowWithFirstOfMonth();

    const date: Date = onGoToDate.mock.calls[0][0];
    expect([date.getFullYear(), date.getMonth(), date.getDate()]).toEqual([2026, 8, 28]);
  });
});
