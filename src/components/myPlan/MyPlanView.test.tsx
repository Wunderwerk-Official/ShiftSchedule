import { fireEvent, screen, within } from "@testing-library/react";
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

  it("has no start-page star and no Views menu in the header", () => {
    renderPlan({ prefs: { clinicianId: "lh" } });
    expect(screen.queryByRole("button", { name: /Start page/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Views" })).not.toBeInTheDocument();
  });

  it("names the linked person behind the initials on My plan", () => {
    renderPlan({ prefs: { clinicianId: "lh" } });
    const myPlan = screen.getByRole("button", { name: "My plan (Dr. Lena Hoffmann)" });
    expect(myPlan).toHaveAttribute("title", "My plan · Dr. Lena Hoffmann");
    expect(myPlan).toHaveTextContent("LH");
    expect(myPlan).toHaveAttribute("aria-pressed", "true");
  });

  it("offers 'Not <name>? Change who you are' only while the account is linked", () => {
    const unlinked = renderPlan();
    fireEvent.click(screen.getByRole("button", { name: "Open the plan of another person" }));
    const picker = screen.getByRole("dialog", { name: "Choose person" });
    expect(within(picker).queryByRole("button", { name: /Change who you are/ })).not.toBeInTheDocument();
    unlinked.unmount();

    // Phones have no hover: the visible label itself names the linked person.
    renderPlan({ prefs: { clinicianId: "lh" } });
    fireEvent.click(screen.getByRole("button", { name: "Open the plan of another person" }));
    const footer = within(screen.getByRole("dialog", { name: "Choose person" })).getByRole("button", {
      name: /Change who you are/,
    });
    expect(footer).toHaveTextContent(/^Not Lena Hoffmann\? Change who you are$/);
  });

  it("names the linked person in the footer even while another person's plan is shown", () => {
    renderPlan({ prefs: { clinicianId: "lh" } });
    const chevron = screen.getByRole("button", { name: "Open the plan of another person" });
    fireEvent.click(chevron);
    fireEvent.click(screen.getByRole("button", { name: /Jonas Weber/ }));
    fireEvent.click(chevron);
    expect(screen.getByRole("button", { name: "Not Lena Hoffmann? Change who you are" })).toBeInTheDocument();
  });

  it("'Not <name>? Change who you are' clears the link, so the person can choose again", () => {
    const view = renderPlan({ prefs: { clinicianId: "lh" } });
    // Viewing someone else first: the change goes back to the own (now unlinked) plan.
    const chevron = screen.getByRole("button", { name: "Open the plan of another person" });
    fireEvent.click(chevron);
    fireEvent.click(screen.getByRole("button", { name: /Jonas Weber/ }));
    expect(screen.getByText(/You are viewing the plan of/)).toBeInTheDocument();

    fireEvent.click(chevron);
    fireEvent.click(screen.getByRole("button", { name: "Not Lena Hoffmann? Change who you are" }));
    expect(view.onUpdatePrefs).toHaveBeenLastCalledWith({ clinicianId: null });
    expect(view.prefs().clinicianId).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Choose person" })).not.toBeInTheDocument();
    expect(document.activeElement).toBe(chevron);
    expect(screen.queryByText(/You are viewing the plan of/)).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Who are you in the plan?" })).toBeInTheDocument();
    // A fresh choice, not the "no longer in the plan" message.
    expect(screen.getByText(/You can change this later/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "My plan" })).not.toHaveAttribute("aria-label");

    fireEvent.change(screen.getByLabelText("I am"), { target: { value: "jw" } });
    fireEvent.click(screen.getByRole("button", { name: "That's me" }));
    expect(view.prefs().clinicianId).toBe("jw");
    expect(screen.getByRole("button", { name: "My plan (Jonas Weber)" })).toHaveTextContent("JW");
    expect(screen.queryByText(/You are viewing the plan of/)).not.toBeInTheDocument();
  });

  it("shows another person's plan with a banner and returns to mine", () => {
    renderPlan({ prefs: { clinicianId: "lh" } });
    fireEvent.click(screen.getByRole("button", { name: "Open the plan of another person" }));
    fireEvent.change(screen.getByPlaceholderText("Search person"), { target: { value: "jonas" } });
    fireEvent.click(screen.getByRole("button", { name: /Jonas Weber/ }));
    expect(screen.getByText(/You are viewing the plan of/)).toHaveTextContent("Jonas Weber");
    expect(screen.getByRole("button", { name: "Jonas Weber" })).toHaveAttribute("aria-pressed", "true");
    // Another person's plan keeps its own label; the tooltip names whose plan it is.
    expect(screen.getByRole("button", { name: "Jonas Weber" })).toHaveAttribute("title", "Plan of Jonas Weber");
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
