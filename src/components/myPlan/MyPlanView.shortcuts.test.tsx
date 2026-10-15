import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { freezeClock, renderPlan } from "./testHarness";

// Keyboard shortcuts (SPEC R16), per-device orientations (A3.5), saved views
// that open at a relative start (R17) and the browser title of another
// person's plan (R18). "Now" = Wed 14 Oct 2026, 14:32.

freezeClock();

const LENA = { clinicianId: "lh" };
const savedView = (startAt: string) => ({
  id: "v1",
  name: "Saved",
  scope: "me",
  range: "week",
  orientation: "top",
  colorBy: "section",
  startAt,
});

describe("MyPlanView shortcuts and views", () => {
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
    fireEvent.click(screen.getByRole("button", { name: "Views" }));
    fireEvent.click(screen.getByRole("button", { name: "Save current view…" }));
    fireEvent.keyDown(screen.getByLabelText("Name"), { key: "w" });
    expect(view.prefs().myPlanRange).toBe("month");
    fireEvent.keyDown(document.body, { key: "p" });
    expect(view.onScopeChange).toHaveBeenCalledWith("team");
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

  it("opens a saved view at its relative start (week start, next shift)", () => {
    const weekStart = renderPlan({ prefs: { ...LENA, myPlanRange: "day", savedViews: [savedView("weekStart")] } });
    fireEvent.click(screen.getByRole("button", { name: "Views" }));
    expect(screen.getByText(/opens at week start/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Saved/ }));
    expect(weekStart.prefs().myPlanRange).toBe("week");
    expect(weekStart.anchor().toDateString()).toBe(new Date(2026, 9, 12).toDateString());
    weekStart.unmount();

    vi.setSystemTime(new Date(2026, 9, 15, 9, 0));
    const next = renderPlan({ prefs: { ...LENA, savedViews: [savedView("nextShift")] } });
    fireEvent.click(screen.getByRole("button", { name: "Views" }));
    fireEvent.click(screen.getByRole("button", { name: /^Saved/ }));
    expect(next.anchor().toDateString()).toBe(new Date(2026, 9, 16).toDateString());
  });

  it("stores the 'Open at' choice with a new view", () => {
    const view = renderPlan({ prefs: LENA });
    fireEvent.click(screen.getByRole("button", { name: "Views" }));
    fireEvent.click(screen.getByRole("button", { name: "Save current view…" }));
    const openAt = screen.getByRole("group", { name: "Open at" });
    expect(within(openAt).getByRole("radio", { name: "Today" })).toBeChecked();
    fireEvent.click(within(openAt).getByRole("radio", { name: "Next shift" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(view.prefs().savedViews[0]).toMatchObject({ name: "My week", startAt: "nextShift" });
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
