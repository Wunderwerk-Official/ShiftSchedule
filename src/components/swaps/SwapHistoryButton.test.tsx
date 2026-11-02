import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import SwapHistoryButton from "./SwapHistoryButton";

describe("SwapHistoryButton", () => {
  it("waits, with the reason as its tooltip, until the calendar has loaded", () => {
    const onClick = vi.fn();
    const { rerender } = render(<SwapHistoryButton pressed={false} onClick={onClick} calendarLoading />);
    const button = screen.getByRole("button", { name: "Swap history" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "Swaps are available once the calendar has loaded.");
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();

    rerender(<SwapHistoryButton pressed={false} onClick={onClick} calendarLoading={false} />);
    expect(button).toBeEnabled();
    expect(button).toHaveAttribute("title", "Swap history");
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
