import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import LocationColorPicker from "./LocationColorPicker";

describe("LocationColorPicker", () => {
  it("names the presets in one row, marks the current one and picks another", () => {
    const onChange = vi.fn();
    render(<LocationColorPicker value="#E9EEF5" onChange={onChange} label="Location color for Berlin" />);
    const trigger = screen.getByRole("button", { name: "Location color for Berlin: Slate" });
    fireEvent.click(trigger);
    const panel = screen.getByRole("dialog", { name: "Location color for Berlin" });
    const options = within(panel).getAllByRole("button");
    expect(options.map((option) => option.textContent)).toEqual(["None", "Slate", "Sand", "Sage", "Lilac"]);
    expect(within(panel).getByRole("button", { name: "Slate" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(within(panel).getByRole("button", { name: "Sand" }));
    expect(onChange).toHaveBeenCalledWith("#EEDFC4");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(trigger);
  });

  it("clears the color and closes on Escape", () => {
    const onChange = vi.fn();
    render(<LocationColorPicker value={null} onChange={onChange} label="Location color" />);
    fireEvent.click(screen.getByRole("button", { name: "Location color: None" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Location color: None" }));
    fireEvent.click(screen.getByRole("button", { name: "None" }));
    expect(onChange).toHaveBeenCalledWith(null);
  });
});
