import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { normalizePreferences } from "../../lib/userPreferences";
import { applyPrefsUpdate, freezeClock, renderPlan } from "./testHarness";

// End-to-end flows of the integrated My-plan container on the demo data
// (Dr. Lena Hoffmann, week 42 of 2026; "now" = Wed 14 Oct 2026, 14:32).

freezeClock();

const LENA = { clinicianId: "lh" };
const NIGHT_ID = "lh:nacht:2026-10-14";
const blocksOf = (container: HTMLElement, shiftId: string) =>
  Array.from(container.querySelectorAll<HTMLElement>(`[data-shift-id="${shiftId}"]`));

describe("MyPlanView flows", () => {
  it("links the account, then shows Lena's week with titles and times", () => {
    const view = renderPlan();
    expect(screen.getByRole("heading", { name: "Who are you in the plan?" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Week, days side by side" })).not.toBeInTheDocument();
    const confirm = screen.getByRole("button", { name: "That's me" });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText("I am"), { target: { value: "lh" } });
    fireEvent.click(confirm);
    expect(view.onUpdatePrefs).toHaveBeenCalledWith({ clinicianId: "lh" });
    expect(view.prefs().clinicianId).toBe("lh");
    expect(screen.queryByText("Who are you in the plan?")).not.toBeInTheDocument();

    const week = screen.getByRole("group", { name: "Week, days side by side" });
    const mrt = within(week).getByRole("button", { name: /^MRT, Monday 12 October, 08:00 to 16:30, Klinikum Mitte/ });
    expect(mrt).toHaveTextContent("MRT");
    expect(mrt).toHaveTextContent("08:00–16:30");
    const sono = within(week).getByRole("button", { name: /^Sonographie, Tuesday 13 October, 12:00 to 16:30, MVZ Nord/ });
    expect(sono).toHaveTextContent("12:00–16:30");
    expect(within(week).getByRole("button", { name: /^Angiographie, Friday 16 October/ })).toBeInTheDocument();
    expect(within(week).getByRole("button", { name: /^LKE\/DL, Sunday 18 October, 08:00 to 20:00/ })).toBeInTheDocument();
  });

  it("draws the overnight duty as two segments that select together", () => {
    const { container } = renderPlan({ prefs: LENA });
    const halves = blocksOf(container, NIGHT_ID);
    expect(halves).toHaveLength(2);
    expect(halves[0]).toHaveTextContent("17:00 → Thu 08:00");
    expect(halves[1]).toHaveTextContent("until 08:00");
    halves.forEach((half) => expect(half).toHaveAttribute("aria-expanded", "false"));

    fireEvent.click(halves[1]);
    blocksOf(container, NIGHT_ID).forEach((half) => expect(half).toHaveAttribute("aria-expanded", "true"));
    expect(screen.getByRole("dialog", { name: "Nachtdienst" })).toBeInTheDocument();
  });

  it("switches range and orientation, rendering the matching view and saving the preference", () => {
    const view = renderPlan({ prefs: LENA });
    expect(screen.getByRole("group", { name: "Week, days side by side" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Date on left/ }));
    const orientationUpdate = view.onUpdatePrefs.mock.lastCall![0];
    expect(typeof orientationUpdate).toBe("function");
    expect(applyPrefsUpdate(normalizePreferences({}), orientationUpdate).orientationByRange).toEqual({
      day: "top",
      week: "left",
      month: "top",
    });
    expect(screen.getByRole("group", { name: "Week, days stacked" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Day" }));
    expect(view.onUpdatePrefs).toHaveBeenLastCalledWith({ myPlanRange: "day" });
    expect(screen.getByRole("group", { name: "Day, time runs down" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Time runs down/ })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: /Time runs right/ }));
    expect(screen.getByRole("group", { name: "Day, time runs right" })).toBeInTheDocument();
    expect(view.prefs().orientationByRange).toEqual({ day: "left", week: "left", month: "top" });

    fireEvent.click(screen.getByRole("button", { name: "Month" }));
    expect(view.onUpdatePrefs).toHaveBeenLastCalledWith({ myPlanRange: "month" });
    expect(screen.getByRole("button", { name: /^Wednesday, 14 Oct 2026:/ })).toHaveAttribute("aria-current", "date");
    fireEvent.click(screen.getByRole("button", { name: /List/ }));
    expect(screen.getByRole("button", { name: "Open Wednesday, 14 Oct 2026, Klinikum Mitte" })).toBeInTheDocument();

    // Back to the week: its remembered orientation (date on left) comes back.
    fireEvent.click(screen.getByRole("button", { name: "Week" }));
    expect(screen.getByRole("group", { name: "Week, days stacked" })).toBeInTheDocument();
    expect(view.prefs()).toMatchObject({ myPlanRange: "week", orientationByRange: { day: "left", week: "left", month: "left" } });
  });

  it("opens the detail with 'Working with you' and closes it on Escape", () => {
    const { container } = renderPlan({ prefs: LENA });
    const block = blocksOf(container, NIGHT_ID)[0];
    block.focus();
    fireEvent.click(block);
    const dialog = screen.getByRole("dialog", { name: "Nachtdienst" });
    expect(dialog).toHaveTextContent("Wed 14 Oct, 17:00 → Thu 15 Oct, 08:00 · 15.0 h");
    const team = within(dialog).getByRole("region", { name: "Working with you" });
    expect(team).toHaveTextContent("Same duty (1)");
    expect(within(team).getByText("Jonas Weber")).toBeInTheDocument();
    expect(team).toHaveTextContent("Same time at location");
    expect(team).toHaveTextContent("Sophie Klein");
    expect(dialog).toHaveTextContent("Rest before: 24.5 h");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Nachtdienst" })).not.toBeInTheDocument();
    blocksOf(container, NIGHT_ID).forEach((half) => expect(half).toHaveAttribute("aria-expanded", "false"));
    expect(document.activeElement).toBe(block);
  });

  it("'Show in team plan' hands the shift's row, date and person to the page and closes the detail", () => {
    const view = renderPlan({ prefs: LENA });
    fireEvent.click(screen.getByRole("button", { name: /^Sonographie, Tuesday 13 October/ }));
    fireEvent.click(screen.getByRole("button", { name: "Show in team plan" }));
    expect(view.onShowInTeam).toHaveBeenCalledWith({ rowId: "sonopm-tue", dateISO: "2026-10-13", clinicianId: "lh" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("reports scope changes from the Team | My plan switch", () => {
    const view = renderPlan({ prefs: LENA });
    const group = screen.getByRole("group", { name: "Choose plan" });
    expect(within(group).getByRole("button", { name: /My plan/ })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(within(group).getByRole("button", { name: "Team" }));
    expect(view.onScopeChange).toHaveBeenCalledWith("team");
    expect(within(group).getByRole("button", { name: "Team" })).toHaveAttribute("aria-pressed", "true");
  });

  it("stores the start view for the device class it was set on", () => {
    const phone = renderPlan({ prefs: { ...LENA, myPlanRangeMobile: "month" }, isMobile: true });
    fireEvent.click(screen.getByRole("button", { name: "Start page on phones" }));
    expect(phone.prefs().startViewMobile).toEqual({ scope: "me", range: "month", orientation: "top", colorBy: "section" });
    expect(phone.prefs().startViewDesktop).toBeNull();
    expect(screen.getByRole("button", { name: "Start page on phones" })).toHaveAttribute("aria-pressed", "true");
    phone.unmount();

    const desktop = renderPlan({ prefs: { ...LENA, orientationByRange: { week: "left" } } });
    fireEvent.click(screen.getByRole("button", { name: "Start page on computers" }));
    expect(desktop.prefs().startViewDesktop).toEqual({ scope: "me", range: "week", orientation: "left", colorBy: "section" });
    expect(desktop.prefs().startViewMobile).toBeNull();
  });

  it("shows the running shift as 'Now' once it started", () => {
    vi.setSystemTime(new Date(2026, 9, 14, 20, 0));
    renderPlan({ prefs: LENA });
    const chip = screen.getByRole("button", { name: /^Now:/ });
    expect(chip).toHaveTextContent("Nachtdienst · until 08:00 · Klinikum Mitte");
    expect(chip).toHaveTextContent("12 h left");
  });

  it("month calendar: week sums, the vacation bar and the draft week", () => {
    renderPlan({ prefs: { ...LENA, myPlanRange: "month" } });
    expect(screen.getByText("October 2026")).toBeInTheDocument();
    expect(screen.getByText("53.0 h")).toBeInTheDocument(); // week 42
    expect(screen.getByText("Vacation")).toBeInTheDocument(); // week 43 has no hours
    expect(screen.getByText("5 days")).toBeInTheDocument();
    expect(screen.getByText("Urlaub/FzA · 19–23 Oct (5 days)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Monday, 19 Oct 2026: Vacation/ })).toBeInTheDocument();
    expect(screen.getAllByText("Draft").length).toBeGreaterThan(0); // week 44 is unpublished
  });

  it("phones remember their own range: switching on the phone leaves the desktop range alone", () => {
    const phone = renderPlan({ prefs: { ...LENA, myPlanRange: "day" }, isMobile: true });
    // The desktop range (day) does not decide what the phone opens: its own (week).
    expect(screen.getByRole("button", { name: "Week" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Month" }));
    expect(phone.onUpdatePrefs).toHaveBeenLastCalledWith({ myPlanRangeMobile: "month" });
    expect(phone.prefs()).toMatchObject({ myPlanRangeMobile: "month", myPlanRange: "day" });
  });

  it("phone day · date on left: the detail is a card below the lanes (no sheet)", () => {
    renderPlan({ prefs: { ...LENA, myPlanRangeMobile: "day", orientationByRangeMobile: { day: "left" } }, isMobile: true });
    // Default: the day's current/next own shift, with full-width actions.
    const card = screen.getByRole("region", { name: "Nachtdienst" });
    expect(card.querySelector("[data-layout]")).toHaveAttribute("data-layout", "stack");
    expect(within(card).getByRole("button", { name: "Show in team plan" })).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: /^Nachtdienst, Wednesday 14 October/ })[0]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Nachtdienst" })).toBeInTheDocument();
  });

  it("phone week opens as the agenda list (phones remember their own orientations)", () => {
    // The desktop record says "top"; phones read orientationByRangeMobile (week: left by default).
    const view = renderPlan({ prefs: { ...LENA, orientationByRange: { week: "top" } }, isMobile: true });
    expect(screen.queryByRole("group", { name: "Week, days stacked" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Mon 12 Oct – Tue 13 Oct/ })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText(/Now 14:32 · free until 17:00/)).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: /^Nachtdienst, Wednesday 14 October/ })[0]);
    // Mobile: the detail is a modal bottom sheet.
    expect(screen.getByRole("dialog", { name: "Nachtdienst" })).toHaveAttribute("aria-modal", "true");
    expect(view.onUpdatePrefs).not.toHaveBeenCalled();
  });

  it("day view of another person (phone): their lane is drawn, the linked person is a colleague", () => {
    renderPlan({ prefs: { ...LENA, myPlanRangeMobile: "day" }, isMobile: true });
    fireEvent.click(screen.getByRole("button", { name: "Open the plan of another person" }));
    const picker = screen.getByRole("dialog", { name: "Choose person" });
    fireEvent.change(within(picker).getByPlaceholderText("Search person"), { target: { value: "jonas" } });
    fireEvent.click(within(picker).getByRole("button", { name: /Jonas Weber/ }));
    const track = screen.getByRole("group", { name: "Day, time runs down" });
    // Only the viewed person's lane is drawn on phones: Jonas' background duty, not Lena's night.
    expect(within(track).getByRole("button", { name: /^Hintergrund OA, Wednesday 14 October/ })).toBeInTheDocument();
    expect(within(track).queryByRole("button", { name: /^Nachtdienst/ })).not.toBeInTheDocument();
    const colleagues = screen.getByRole("region", { name: "Working with you" });
    expect(within(colleagues).getByRole("button", { name: /Lena Hoffmann/ })).toBeInTheDocument();
  });

  it("day views preselect the shift shown in the card, in both orientations; clicking it keeps it", () => {
    const { container } = renderPlan({ prefs: { ...LENA, myPlanRange: "day" } });
    const block = (shiftId: string) =>
      container.querySelector<HTMLElement>(`[data-plan-block][data-shift-id="${shiftId}"]`)!;
    // Date on top: the card shows the night and the night is the selected block.
    expect(screen.getByRole("region", { name: "Nachtdienst" })).toBeInTheDocument();
    expect(block(NIGHT_ID)).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(block(NIGHT_ID));
    expect(block(NIGHT_ID)).toHaveAttribute("aria-pressed", "true");

    // Date on left: the same rule.
    fireEvent.click(screen.getByRole("button", { name: /Time runs right/ }));
    expect(block(NIGHT_ID)).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(block(NIGHT_ID));
    expect(block(NIGHT_ID)).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("region", { name: "Nachtdienst" })).toBeInTheDocument();

    // Another shift takes over the selection and the card; clicking it again keeps it.
    const jonasDuty = "jw:ruf:2026-10-14";
    fireEvent.click(block(jonasDuty));
    expect(block(jonasDuty)).toHaveAttribute("aria-pressed", "true");
    expect(block(NIGHT_ID)).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(block(jonasDuty));
    expect(block(jonasDuty)).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("region", { name: "Hintergrund OA" })).toBeInTheDocument();
  });

  it("day view of another person (desktop): the Me badge marks the linked person's lane only", () => {
    renderPlan({ prefs: { ...LENA, myPlanRange: "day" } });
    fireEvent.click(screen.getByRole("button", { name: "Open the plan of another person" }));
    const picker = screen.getByRole("dialog", { name: "Choose person" });
    fireEvent.change(within(picker).getByPlaceholderText("Search person"), { target: { value: "jonas" } });
    fireEvent.click(within(picker).getByRole("button", { name: /Jonas Weber/ }));
    // The only "Me" badge sits in Lena's (colleague) lane header, not in Jonas' main lane.
    expect(within(screen.getByTitle("Dr. Lena Hoffmann")).getByText("Me")).toBeInTheDocument();
    expect(screen.getAllByText("Me")).toHaveLength(1);
    expect(screen.getByRole("button", { name: /^Next up · Jonas:/ })).toBeInTheDocument();
    // Main-lane extras (location tag) go to Jonas' block, not to Lena's colleague lane.
    expect(screen.getByRole("button", { name: /^Hintergrund OA, Wednesday 14 October/ })).toHaveTextContent("Klinikum Mitte");
    expect(screen.getByRole("button", { name: /^Nachtdienst, Wednesday 14 October/ })).not.toHaveTextContent("Klinikum Mitte");
  });

  it("month day popover: focus moves in once it is positioned; 'Open day' hands focus to the day", () => {
    const visibilityAtFocus: string[] = [];
    const original = HTMLElement.prototype.focus;
    const spy = vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (this: HTMLElement, options) {
      if (this.getAttribute("role") === "dialog") visibilityAtFocus.push(this.style.visibility);
      original.call(this, options);
    });
    const view = renderPlan({ prefs: { ...LENA, myPlanRange: "month" } });
    const cell = screen.getByRole("button", { name: /^Monday, 19 Oct 2026/ });
    cell.focus();
    fireEvent.click(cell);
    const dialog = screen.getByRole("dialog", { name: /Monday, 19 Oct 2026/ });
    expect(document.activeElement).toBe(dialog);
    expect(visibilityAtFocus.length).toBeGreaterThan(0);
    expect(visibilityAtFocus).not.toContain("hidden");
    spy.mockRestore();

    const open = within(dialog).getByRole("button", { name: /Open day/ });
    open.focus();
    fireEvent.click(open);
    expect(view.prefs().myPlanRange).toBe("day");
    // The popover and its cell are gone: focus lands on the plan body, now the day.
    expect(document.activeElement).toBe(screen.getByRole("region", { name: "Mon, 19 Oct 2026" }));
  });

  it("month day popover: Escape and tabbing out close it and return focus to the cell", () => {
    renderPlan({ prefs: { ...LENA, myPlanRange: "month" } });
    const cell = screen.getByRole("button", { name: /^Wednesday, 14 Oct 2026/ });
    fireEvent.click(cell);
    const open = within(screen.getByRole("dialog", { name: /Wednesday, 14 Oct 2026/ })).getByRole("button", { name: /Open day/ });
    open.focus();
    fireEvent.keyDown(open, { key: "Tab" });
    expect(screen.queryByRole("dialog", { name: /Wednesday, 14 Oct 2026/ })).not.toBeInTheDocument();
    expect(document.activeElement).toBe(cell);
    fireEvent.click(cell);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: /Wednesday, 14 Oct 2026/ })).not.toBeInTheDocument();
    expect(document.activeElement).toBe(cell);
  });

  it("keeps the open detail on its block across an orientation switch", () => {
    const { container } = renderPlan({ prefs: LENA });
    const block = blocksOf(container, NIGHT_ID)[0];
    block.focus();
    fireEvent.click(block);
    expect(screen.getByRole("dialog", { name: "Nachtdienst" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Date on left/ }));
    expect(screen.getByRole("group", { name: "Week, days stacked" })).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Nachtdienst" })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    // Focus returns to the night's block in the new view (the old element is gone).
    const [first] = blocksOf(container, NIGHT_ID);
    expect(block.isConnected).toBe(false);
    expect(document.activeElement).toBe(first);
  });

  it.each([
    ["week · date on left", { ...LENA, orientationByRange: { week: "left" } }],
    ["month · list", { ...LENA, myPlanRange: "month", orientationByRange: { month: "left" } }],
  ])("%s: the detail popover is stacked (three columns only in the inline day card)", (_label, prefs) => {
    const { container } = renderPlan({ prefs });
    fireEvent.click(blocksOf(container, NIGHT_ID)[0]);
    const dialog = screen.getByRole("dialog", { name: "Nachtdienst" });
    expect(dialog.querySelector("[data-layout]")).toHaveAttribute("data-layout", "stack");
    expect(within(dialog).getByRole("heading", { name: "Nachtdienst" })).toBeInTheDocument();
  });

  it("day · date on left: the inline detail card uses three columns", () => {
    renderPlan({ prefs: { ...LENA, myPlanRange: "day", orientationByRange: { day: "left" } } });
    const card = screen.getByRole("region", { name: "Nachtdienst" });
    expect(card.querySelector("[data-layout]")).toHaveAttribute("data-layout", "columns");
  });

  it("shows 'free' only in published weeks", () => {
    renderPlan({ prefs: LENA });
    expect(screen.getByText("free")).toBeInTheDocument(); // Sat 17 Oct
    fireEvent.click(screen.getByRole("button", { name: "Next week" }));
    fireEvent.click(screen.getByRole("button", { name: "Next week" }));
    // Week 44 is not published: its empty days are not "free" (yet).
    expect(screen.getByRole("button", { name: /Pick a week \(Week 44/ })).toBeInTheDocument();
    expect(screen.queryByText("free")).not.toBeInTheDocument();
  });

  it("phone month list: merged free days open their first day, vacation weeks count days", () => {
    const view = renderPlan({
      prefs: { ...LENA, myPlanRangeMobile: "month", orientationByRangeMobile: { month: "left" } },
      isMobile: true,
    });
    expect(screen.getByText("Vacation · 5 days")).toBeInTheDocument();
    const weekend = screen.getByRole("button", { name: /^Saturday, 24 Oct 2026 to Sunday, 25 Oct 2026: free/ });
    fireEvent.click(weekend);
    expect(view.prefs().myPlanRangeMobile).toBe("day");
    expect(view.prefs().myPlanRange).toBe("week");
    expect(view.anchor().toDateString()).toBe(new Date(2026, 9, 24).toDateString());
  });
});
