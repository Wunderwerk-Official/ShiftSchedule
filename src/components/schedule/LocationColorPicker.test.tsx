import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import LocationColorPicker from "./LocationColorPicker";

describe("LocationColorPicker", () => {
  it("names Auto and the presets, marks the current one and picks another", () => {
    const onChange = vi.fn();
    render(<LocationColorPicker value="#E9EEF5" onChange={onChange} label="Location color for Berlin" autoColor="#DBEAFE" />);
    const trigger = screen.getByRole("button", { name: "Location color for Berlin: Slate" });
    fireEvent.click(trigger);
    const panel = screen.getByRole("dialog", { name: "Location color for Berlin" });
    const options = within(panel).getAllByRole("button");
    expect(options.map((option) => option.textContent)).toEqual([
      "Auto", "Blue", "Green", "Amber", "Violet", "Rose", "Teal", "Orange", "Slate", "Sand", "Sage", "Lilac",
    ]);
    expect(within(panel).getByRole("button", { name: "Slate" })).toHaveAttribute("aria-pressed", "true");
    expect(within(panel).getByRole("button", { name: "Auto" })).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(within(panel).getByRole("button", { name: "Sand" }));
    expect(onChange).toHaveBeenCalledWith("#EEDFC4");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(trigger);
  });

  it("shows the automatic color while none is chosen, clears a choice and closes on Escape", () => {
    const onChange = vi.fn();
    render(<LocationColorPicker value={null} onChange={onChange} label="Location color" autoColor="#DCFCE7" />);
    const trigger = screen.getByRole("button", { name: "Location color: Auto (Green)" });
    expect(trigger).toHaveAttribute("title", "Location color: Auto (Green)");
    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(trigger);
    const auto = screen.getByRole("button", { name: "Auto" });
    expect(auto).toHaveAttribute("aria-pressed", "true");
    expect(auto).toHaveAttribute("title", "Automatic color by location order (now Green)");
    fireEvent.click(auto);
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("names a custom stored color by its value", () => {
    render(<LocationColorPicker value="#123456" onChange={vi.fn()} label="Location color" />);
    expect(screen.getByRole("button", { name: "Location color: #123456" })).toBeInTheDocument();
  });
});
