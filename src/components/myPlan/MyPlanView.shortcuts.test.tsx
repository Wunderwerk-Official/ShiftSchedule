import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { freezeClock, renderPlan } from "./testHarness";

// Keyboard shortcuts (SPEC R16), per-device orientations (A3.5) and the
// browser title of another person's plan (R18). "Now" = Wed 14 Oct 2026, 14:32.

freezeClock();

const LENA = { clinicianId: "lh" };

describe("MyPlanView shortcuts", () => {
  it("switches range, orientation and scope with single keys, not while typing", () => {
    const view = renderPlan({ prefs: LENA });
    fireEvent.keyDown(document.body, { key: "m" });
    expect(view.prefs().myPlanRange).toBe("month");
    fireEvent.keyDown(document.body, { key: "o" });
    expect(view.prefs().orientationByRange.month).toBe("left");
    // Desktop keys never touch the phone record.
    expect(view.prefs().orientationByRangeMobile.month).toBe("top");
    fireEvent.keyDown(document.body, { key: "w", ctrlKey: true });
    expect(view.prefs().myPlanRange).toBe("month");
    fireEvent.click(screen.getByRole("button", { name: "Open the plan of another person" }));
    fireEvent.keyDown(screen.getByPlaceholderText("Search person"), { key: "w" });
    expect(view.prefs().myPlanRange).toBe("month");
    fireEvent.keyDown(document.body, { key: "p" });
    expect(view.onScopeChange).toHaveBeenCalledWith("team");
  });

  it("ignores single keys while focus is in the person picker or another popover", () => {
    const view = renderPlan({ prefs: LENA });
    fireEvent.click(screen.getByRole("button", { name: "Open the plan of another person" }));
    const picker = screen.getByRole("dialog", { name: "Choose person" });
    // Tabbed from the search field onto a name: the letter belongs to the list.
    const name = within(picker).getByRole("button", { name: /Jonas Weber/ });
    name.focus();
    fireEvent.keyDown(name, { key: "m" });
    expect(view.prefs().myPlanRange).toBe("week");
    // Any listbox or menu, with or without aria-modal, keeps its keys too.
    for (const role of ["listbox", "menu"]) {
      const owner = document.createElement("div");
      owner.setAttribute("role", role);
      const item = document.createElement("button");
      owner.append(item);
      document.body.append(owner);
      fireEvent.keyDown(item, { key: "m" });
      owner.remove();
    }
    const editable = document.createElement("div");
    editable.setAttribute("role", "textbox");
    document.body.append(editable);
    fireEvent.keyDown(editable, { key: "m" });
    editable.remove();
    expect(view.prefs().myPlanRange).toBe("week");
  });

  it("ignores single keys while focus is in the date picker", () => {
    const view = renderPlan({ prefs: LENA });
    fireEvent.click(screen.getByRole("button", { name: /^Pick a week/ }));
    const picker = screen.getByRole("dialog", { name: "Select a week" });
    // Browsing to another month puts focus on the picker's chevron.
    const next = within(picker).getByRole("button", { name: "Next month" });
    next.focus();
    fireEvent.click(next);
    fireEvent.keyDown(next, { key: "m" });
    fireEvent.keyDown(next, { key: "t" });
    expect(view.prefs().myPlanRange).toBe("week");
    expect(screen.getByRole("dialog", { name: "Select a week" })).toHaveTextContent("November 2026");
  });

  it("ignores single keys in the open shift detail, but N / Shift+N step on from there", () => {
    const view = renderPlan({ prefs: LENA });
    fireEvent.keyDown(document.body, { key: "n" });
    const detail = screen.getByRole("dialog", { name: "Nachtdienst" });
    const inside = within(detail).getAllByRole("button")[0];
    inside.focus();
    fireEvent.keyDown(inside, { key: "t" });
    expect(view.prefs().myPlanRange).toBe("week");
    expect(screen.getByRole("dialog", { name: "Nachtdienst" })).toBeInTheDocument();
    fireEvent.keyDown(inside, { key: "n" });
    expect(screen.getByRole("dialog", { name: "Angiographie" })).toBeInTheDocument();
  });

  it("phones remember their own orientation", () => {
    const view = renderPlan({ prefs: LENA, isMobile: true });
    // Week opens as the agenda on phones.
    expect(screen.getByRole("button", { name: /Mon 12 Oct – Tue 13 Oct/ })).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: "o" });
    expect(view.prefs().orientationByRangeMobile.week).toBe("top");
    expect(view.prefs().orientationByRange.week).toBe("top");
    expect(screen.getByRole("group", { name: "Week, days side by side" })).toBeInTheDocument();
  });

  it("N / Shift+N select the next and previous shift from now", () => {
    renderPlan({ prefs: LENA });
    fireEvent.keyDown(document.body, { key: "n" });
    expect(screen.getByRole("dialog", { name: "Nachtdienst" })).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: "n" });
    expect(screen.getByRole("dialog", { name: "Angiographie" })).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: "N", shiftKey: true });
    expect(screen.getByRole("dialog", { name: "Nachtdienst" })).toBeInTheDocument();
  });

  it("N in a day view starts from the shift preselected in the card", () => {
    const view = renderPlan({ prefs: { ...LENA, myPlanRange: "day" } });
    expect(screen.getByRole("region", { name: "Nachtdienst" })).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: "n" });
    expect(view.anchor().toDateString()).toBe(new Date(2026, 9, 16).toDateString());
    expect(screen.getByRole("region", { name: "Angiographie" })).toBeInTheDocument();
  });

  it("names the viewed person in the browser title and restores it", () => {
    document.title = "Weekly Schedule";
    const view = renderPlan({ prefs: LENA });
    fireEvent.click(screen.getByRole("button", { name: "Open the plan of another person" }));
    const picker = screen.getByRole("dialog", { name: "Choose person" });
    fireEvent.change(within(picker).getByPlaceholderText("Search person"), { target: { value: "jonas" } });
    fireEvent.click(within(picker).getByRole("button", { name: /Jonas Weber/ }));
    expect(document.title).toBe("Plan of Jonas Weber · Week 42");
    view.unmount();
    expect(document.title).toBe("Weekly Schedule");
  });
});
