import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import CalendarTransitionOverlay from "./CalendarTransitionOverlay";

describe("CalendarTransitionOverlay (re-QA)", () => {
  it("is a modal: the page behind is inert, focus is on Cancel, Escape cancels", () => {
    const onCancel = vi.fn();
    const { unmount } = render(
      <div>
        <button type="button">Settings</button>
      </div>,
    );
    const page = screen.getByRole("button", { name: "Settings" });
    page.focus();
    const overlay = render(<CalendarTransitionOverlay message="Creating PDF for 2 weeks…" onCancel={onCancel} />);
    const dialog = screen.getByRole("dialog", { name: "Creating PDF for 2 weeks…" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(page.closest("[inert]")).not.toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    overlay.unmount();
    // The page is usable again and gets its focus back.
    expect(page.closest("[inert]")).toBeNull();
    expect(document.activeElement).toBe(page);
    unmount();
  });

  it("offers no Cancel while the calendar is only being updated", () => {
    render(<CalendarTransitionOverlay message="Updating calendar…" />);
    expect(screen.getByRole("status")).toHaveTextContent("Updating calendar…");
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("dialog"));
  });
});
