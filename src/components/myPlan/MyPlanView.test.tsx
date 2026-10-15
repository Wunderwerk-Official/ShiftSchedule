import { act, fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { freezeClock, renderPlan } from "./testHarness";

freezeClock();

describe("MyPlanView", () => {
  it("shows the week with header, next up and the hours footer", () => {
    const view = renderPlan({ prefs: { clinicianId: "lh" } });
    expect(screen.getByRole("button", { name: /Pick a week \(Week 42, 12–18 Oct 2026\)/ })).toBeInTheDocument();
    const nextUp = screen.getByRole("button", { name: /^Next up: Nachtdienst · today 17:00 – Thu 08:00 · Klinikum Mitte, in 2 h 28 min/ });
    expect(nextUp).toBeInTheDocument();
    const footer = screen.getByText(/planned · target 40 h/);
    expect(footer.textContent).toBe("Week 42: 53.0 h planned · target 40 h");
    // The hours rule differs from the Working hours overview; the tooltip says how.
    expect(footer).toHaveAttribute("title", expect.stringContaining("overlapping own shifts count once"));
    expect(screen.getByRole("list", { name: "Legend" })).toHaveTextContent("Nachtdienst");
    expect(screen.getByRole("button", { name: "Team" })).toHaveAttribute("aria-pressed", "false");

    nextUp.focus();
    fireEvent.click(nextUp);
    expect(view.prefs().myPlanRange).toBe("day");
    expect(view.anchor().toDateString()).toBe(new Date(2026, 9, 14).toDateString());
    expect(screen.getByRole("group", { name: "Day, time runs down" })).toBeInTheDocument();
    // The chip stays mounted, so it keeps focus.
    expect(document.activeElement).toBe(nextUp);
  });

  it("switches range and remembers the orientation per range", () => {
    const view = renderPlan({ prefs: { clinicianId: "lh" } });
    fireEvent.click(screen.getByRole("button", { name: /Date on left/ }));
    expect(view.prefs().orientationByRange).toEqual({ day: "top", week: "left", month: "top" });
    fireEvent.click(screen.getByRole("button", { name: "Month" }));
    expect(view.prefs().myPlanRange).toBe("month");
    expect(screen.getByRole("button", { name: /Calendar/ })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Next month" }));
    expect(screen.getByText("November 2026")).toBeInTheDocument();
  });

  it("opens a month day popover and jumps to the day view", () => {
    const view = renderPlan({ prefs: { clinicianId: "lh", myPlanRange: "month" } });
    const cell = screen.getByRole("button", { name: /^Wednesday, 14 Oct 2026:/ });
    expect(cell).toHaveAttribute("aria-current", "date");
    fireEvent.click(cell);
    const dialog = screen.getByRole("dialog", { name: "Day detail Wednesday, 14 Oct 2026" });
    expect(within(dialog).getByText("Nachtdienst")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Monday, 19 Oct 2026/ }));
    expect(screen.getByRole("dialog", { name: /Monday, 19 Oct 2026/ })).toHaveTextContent("(5 days)");
    fireEvent.click(within(screen.getByRole("dialog", { name: /Monday, 19 Oct/ })).getByRole("button", { name: /Open day/ }));
    expect(view.prefs().myPlanRange).toBe("day");
    expect(view.anchor().toDateString()).toBe(new Date(2026, 9, 19).toDateString());
  });

  it("renders the month list and the day view with colleague lanes", () => {
    const list = renderPlan({ prefs: { clinicianId: "lh", myPlanRange: "month", orientationByRange: { month: "left" } } });
    expect(screen.getByText(/Week 43 · 19–25 Oct/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open Thursday, 15 Oct 2026" }));
    expect(list.prefs().myPlanRange).toBe("day");
    list.unmount();
    renderPlan({ prefs: { clinicianId: "lh", myPlanRange: "day" } });
    expect(screen.getAllByText("Jonas Weber").length).toBeGreaterThan(0);
    expect(screen.getByText(/Wed 14 Oct:/)).toBeInTheDocument();
  });

  it("toggles the start page with a toast that can undo", () => {
    const view = renderPlan({ prefs: { clinicianId: "lh" } });
    // Constant name; the state is aria-pressed.
    const star = screen.getByRole("button", { name: "Start page on computers" });
    expect(star).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(star);
    expect(view.prefs().startViewDesktop).toMatchObject({ scope: "me", range: "week", orientation: "top" });
    expect(screen.getByRole("button", { name: "Start page on computers" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Start page on computers: My plan · Week · Date on top");
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    });
    expect(view.prefs().startViewDesktop).toBeNull();
  });

  it("saves (without a date), applies and deletes a named view, keeping focus in the menu", () => {
    const view = renderPlan({ prefs: { clinicianId: "lh" } });
    fireEvent.click(screen.getByRole("button", { name: "Views" }));
    // Opening moves focus into the panel (no views yet: the save action).
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Save current view…" }));
    fireEvent.click(screen.getByRole("button", { name: "Save current view…" }));
    const name = screen.getByLabelText("Name");
    expect(document.activeElement).toBe(name);
    fireEvent.click(screen.getByRole("button", { name: "Back to views" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Save current view…" }));

    fireEvent.click(screen.getByRole("button", { name: "Save current view…" }));
    expect(screen.getByLabelText("Name")).toHaveValue("My week");
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Week grid" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /On computers/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const [saved] = view.prefs().savedViews;
    expect(saved).toMatchObject({ name: "Week grid", scope: "me", range: "week", orientation: "top" });
    expect(Object.keys(saved).sort()).toEqual(["colorBy", "id", "name", "orientation", "range", "scope", "startAt"]);
    expect(saved.startAt).toBe("today");
    expect(view.prefs().startViewDesktop).toMatchObject({ range: "week" });
    expect(screen.getByRole("status")).toHaveTextContent('View "Week grid" saved · start page on computers');

    fireEvent.click(screen.getByRole("button", { name: "Month" }));
    fireEvent.click(screen.getByRole("button", { name: "Views" }));
    expect(screen.getByText("Computer: Week grid")).toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /^Week grid/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Week grid/ }));
    expect(view.prefs().myPlanRange).toBe("week");

    fireEvent.click(screen.getByRole("button", { name: "Views" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete view Week grid" }));
    expect(view.prefs().savedViews).toHaveLength(0);
    // The deleted row's button is gone: focus moves to the save action.
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Save current view…" }));
  });

  it("shows another person's plan with a banner and returns to mine", () => {
    renderPlan({ prefs: { clinicianId: "lh" } });
    fireEvent.click(screen.getByRole("button", { name: "Open the plan of another person" }));
    fireEvent.change(screen.getByPlaceholderText("Search person"), { target: { value: "jonas" } });
    fireEvent.click(screen.getByRole("button", { name: /Jonas Weber/ }));
    expect(screen.getByText(/You are viewing the plan of/)).toHaveTextContent("Jonas Weber");
    expect(screen.getByRole("button", { name: "Jonas Weber" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Back to my plan" }));
    expect(screen.queryByText(/You are viewing the plan of/)).not.toBeInTheDocument();
  });

  it("renders the phone month calendar with the selected day below", () => {
    renderPlan({ prefs: { clinicianId: "lh", myPlanRangeMobile: "month" }, isMobile: true });
    expect(screen.getByRole("heading", { name: "Wednesday, 14 Oct 2026" })).toBeInTheDocument();
    expect(screen.getByText("Week 42 · 53.0 h planned")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Friday, 16 Oct 2026/ }));
    expect(screen.getByRole("heading", { name: "Friday, 16 Oct 2026" })).toBeInTheDocument();
  });

  it("phone month list: a day with several entries names every one briefly", () => {
    renderPlan({
      prefs: { clinicianId: "lh", myPlanRangeMobile: "month", orientationByRangeMobile: { month: "left" } },
      isMobile: true,
    });
    const monday = screen.getByRole("button", { name: /^Monday, 12 Oct 2026:/ });
    expect(monday).toHaveTextContent("Früh · MRT");
    expect(screen.getByRole("button", { name: /^Friday, 16 Oct 2026:/ })).toHaveTextContent("Angiographie 08:00–16:30");
  });
});
