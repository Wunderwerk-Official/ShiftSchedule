import { act, render, screen, fireEvent, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import AgentActivityPanel from "./AgentActivityPanel";
import { appendAgentEvent } from "../../lib/agentActivity";
import type { AgentActivityData } from "../../api/client";

// Distinct start/end markers so we can prove the WHOLE text is shown, not a
// clamped preview. Also exceed the former 24,000-character server limit.
const LONG =
  "START-MARKER " + "reasoning detail ".repeat(3000) + "END-MARKER";

/** The log starts collapsed (latest entry only); most tests open it first. */
const openLog = () => fireEvent.click(screen.getByRole("button", { name: /Activity log/ }));

function ev(data: Partial<AgentActivityData>): AgentActivityData {
  return {
    kind: "thought",
    iteration: 1,
    max_iterations: 20,
    moves_accepted: 0,
    time_ms: 0,
    ...data,
  } as AgentActivityData;
}

describe("AgentActivityPanel full-text dialog", () => {
  it("opens the complete reasoning in a dialog, not just a clamped preview", () => {
    render(
      <AgentActivityPanel
        events={[
          ev({ kind: "stage", stage: "improve" }),
          ev({ kind: "thought", text: LONG, reasoning: true }),
        ]}
      />,
    );
    // The feed preview shows the start but is clamped before the end marker.
    openLog();
    fireEvent.click(screen.getByRole("checkbox", { name: "Include model text" }));
    expect(screen.queryByText(/END-MARKER/)).toBeNull();
    const opener = screen.getByRole("button", { name: /show full text/i });
    fireEvent.click(opener);
    // The dialog now shows the COMPLETE text — both markers are present.
    const dialogBody = screen.getByText(
      (_content, node) =>
        node?.tagName === "PRE" &&
        (node.textContent ?? "").includes("START-MARKER") &&
        (node.textContent ?? "").includes("END-MARKER"),
    );
    expect(dialogBody).toBeTruthy();
    expect(screen.getByText(/reasoning \(full text\)/i)).toBeTruthy();
    // Escape closes it.
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByText(/END-MARKER/)).toBeNull();
  });

  it("does not claim 'Copied' when copying the full text fails", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockRejectedValue(new Error("insecure context")) },
      configurable: true,
    });
    Object.defineProperty(document, "execCommand", { value: vi.fn(() => false), configurable: true });
    try {
      render(
        <AgentActivityPanel
          events={[
            ev({ kind: "stage", stage: "improve" }),
            ev({ kind: "thought", text: LONG, reasoning: true }),
          ]}
        />,
      );
      openLog();
      fireEvent.click(screen.getByRole("checkbox", { name: "Include model text" }));
      fireEvent.click(screen.getByRole("button", { name: /show full text/i }));
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Copy" }));
      });
      expect(screen.queryByText("Copied ✓")).toBeNull();
      expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
    } finally {
      Reflect.deleteProperty(navigator, "clipboard");
      Reflect.deleteProperty(document, "execCommand");
    }
  });

  it("keeps short thoughts inline without an opener", () => {
    render(
      <AgentActivityPanel
        events={[
          ev({ kind: "stage", stage: "improve" }),
          ev({ kind: "thought", text: "Filling Monday gaps." }),
        ]}
      />,
    );
    openLog();
    expect(screen.queryByText("Filling Monday gaps.")).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "Include model text" }));
    expect(screen.getByText("Filling Monday gaps.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /show full text/i })).toBeNull();
  });

  it("distinguishes a provider limit from the preview and retains an open response as activity advances", () => {
    const events = [ev({ text: LONG, output_truncated: true })];
    const { rerender } = render(<AgentActivityPanel events={events} />);
    openLog();
    fireEvent.click(screen.getByRole("checkbox", { name: "Include model text" }));
    expect(screen.getByText(/characters received/)).toBeVisible();
    expect(screen.getByText("Model response limit reached.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Show full text" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/response may end mid-sentence/)).toBeVisible();
    rerender(<AgentActivityPanel events={[ev({ kind: "iteration", iteration: 200 })]} />);
    expect(dialog.querySelector("pre")?.textContent).toBe(LONG);
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

it("keeps the current day and operation visible with an honest waiting duration", () => {
  const events = [ev({ kind: "tool_start", stage: "improve", tool: "suggest_rescue_moves", activity_id: 7,
    phase_label: "Build the daily plan", planning_date: "2026-01-06", day_index: 2, total_days: 5, time_ms: 60000 })];
  const { rerender } = render(<AgentActivityPanel events={events} elapsedMs={75000} />);
  expect(screen.getByText(/Day 2 of 5 · Tue 06.01./)).toBeTruthy();
  expect(screen.getByRole("status").textContent).toContain("Searching for swaps");
  expect(screen.getByText("0:15 in this step")).toBeTruthy();
  rerender(<AgentActivityPanel events={events} elapsedMs={75000} liveConnected={false} />);
  expect(screen.getByRole("status").textContent).toBe("Live updates interrupted");
  expect(screen.getByText(/this view may be out of date/)).toBeTruthy();
});

it("distinguishes temporary working changes from a better saved plan", () => {
  render(<AgentActivityPanel events={[ev({ kind: "moves_applied", retained_best: false, improved: false,
    moves: [{ action: "assign", clinician: "Dr. Schmit", section: "MRI", dateISO: "2026-01-06", start: "08:00", end: "16:00" }] })]} />);
  openLog();
  const feed = screen.getByRole("region", { name: "Planning activity" });
  expect(within(feed).getByText(/earlier best kept/)).toBeTruthy();
  expect(within(feed).queryByText(/Better plan saved/)).toBeNull();
});

it('shows only checks for the current plan after a revision invalidates previous reviews', () => {
  const { rerender } = render(<AgentActivityPanel events={[ev({
    kind: 'phase', checks_progress: { revision: 4, total: 7, complete: 3 },
  })]} />);
  expect(screen.getByText(/Current plan: 3\/7 days checked/)).toBeVisible();
  rerender(<AgentActivityPanel events={[ev({
    kind: 'moves_applied', checks_progress: { revision: 5, total: 7, complete: 0 },
  })]} />);
  expect(screen.getByText(/Current plan: 0\/7 days checked/)).toBeVisible();
  expect(screen.queryByText(/Current plan: 3\/7/)).toBeNull();
});

it("keeps the log collapsed to its latest entry until it is opened", () => {
  render(<AgentActivityPanel events={[
    ev({ kind: "tool_result", tool: "get_day_priorities", activity_id: 1, summary: "Open positions on this day: 4.", time_ms: 30000 }),
    ev({ kind: "moves_applied", improved: true, time_ms: 61000,
      moves: [{ action: "assign", clinician: "Dr. Schmit", section: "MRI", dateISO: "2026-01-06", start: "08:00", end: "16:00" }] }),
    ev({ kind: "thought", text: "Model text is not a teaser.", time_ms: 62000 }),
  ]} />);
  const toggle = screen.getByRole("button", { name: /Activity log/ });
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByRole("region", { name: "Planning activity" })).toBeNull();
  // The latest activity (not model text) stays readable while collapsed.
  expect(within(toggle).getByText("Dr. Schmit → MRI · Tue 06.01. · Better plan saved")).toBeTruthy();
  expect(within(toggle).getByText("2 recent")).toBeTruthy();
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  expect(within(screen.getByRole("region", { name: "Planning activity" })).getByText(/Open positions on this day/)).toBeTruthy();
});

it("lets the caller hold the log state, so it survives a remount", () => {
  const onLogOpenChange = vi.fn();
  render(<AgentActivityPanel events={[]} logOpen onLogOpenChange={onLogOpenChange} />);
  expect(screen.getByRole("region", { name: "Planning activity" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /Activity log/ }));
  expect(onLogOpenChange).toHaveBeenCalledWith(false);
});

describe("day track", () => {
  const RANGE = { startISO: "2026-01-05", endISO: "2026-01-09" };
  const day = (index: number, iso: string) => ev({ kind: "tool_start", stage: "improve", tool: "suggest_day_blocks",
    phase_label: "Build the daily plan", day_index: index, total_days: 5, planning_date: iso });

  it("shows planned, current and open days of the range", () => {
    render(<AgentActivityPanel events={[day(1, "2026-01-05"), day(3, "2026-01-07")]} range={RANGE} />);
    const track = screen.getByRole("progressbar", { name: "Days planned" });
    expect(track).toHaveAttribute("aria-valuenow", "2");
    expect(track).toHaveAttribute("aria-valuetext", "2 of 5 days planned");
    expect(track.children).toHaveLength(5);
    expect(track.children[2].className).toContain("animate-pulse");
    expect(screen.getByText("Day 3 of 5 · Wed 07.01.")).toBeTruthy();
    expect(screen.getByText("Wed 07").className).toContain("font-semibold");
  });

  it("counts every day as planned once the agent reviews the whole range (servers without day lists)", () => {
    render(<AgentActivityPanel range={RANGE} events={[
      day(5, "2026-01-09"),
      ev({ kind: "phase", phase_label: "Review the whole planning range", day_index: null, planning_date: null, total_days: 5 }),
    ]} />);
    expect(screen.getByRole("progressbar", { name: "Days planned" })).toHaveAttribute("aria-valuenow", "5");
    const progress = screen.getByRole("region", { name: "Planning progress" });
    expect(within(progress).getByText("Review the whole planning range")).toBeTruthy();
  });

  it("starts empty while the first draft is made", () => {
    render(<AgentActivityPanel range={RANGE} events={[ev({ kind: "stage", stage: "seed", iteration: 0, days_finished: [], days_skipped: [] })]} />);
    expect(screen.getByRole("progressbar", { name: "Days planned" })).toHaveAttribute("aria-valuenow", "0");
    expect(screen.getByText("Drafting a first plan")).toBeTruthy();
  });

  it("reads finished and skipped days from the server, also with no history (reload)", () => {
    // A reload during the review: no day event in the buffer any more, but
    // every event carries the day lists (v1.69).
    render(<AgentActivityPanel range={RANGE} events={[
      ev({ kind: "phase", stage: "improve", phase_label: "Review the whole planning range", day_index: null,
        planning_date: null, total_days: 5,
        days_finished: ["2026-01-05", "2026-01-06", "2026-01-08", "2026-01-09"], days_skipped: ["2026-01-07"] }),
    ]} />);
    const track = screen.getByRole("progressbar", { name: "Days planned" });
    expect(track).toHaveAttribute("aria-valuenow", "4");
    expect(track).toHaveAttribute("aria-valuetext", "4 of 5 days planned, 1 skipped");
    expect([...track.children].map((segment) => segment.getAttribute("data-day-state"))).toEqual([
      "done", "done", "skipped", "done", "done",
    ]);
    expect(screen.getByText("Wed 07").className).toContain("text-amber-700");
  });

  it("keeps the track full through a long review that pushed every day event out of the buffer", () => {
    const all = ["2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08", "2026-01-09"];
    let events: AgentActivityData[] = [day(5, "2026-01-09")];
    for (let i = 0; i < 300; i += 1) {
      events = appendAgentEvent(events, ev({ kind: "tool_result", stage: "improve", phase_label: "Review the whole planning range",
        day_index: null, planning_date: null, total_days: 5, days_finished: all, days_skipped: [], activity_id: i, summary: `check ${i}` }));
    }
    expect(events.some((event) => typeof event.day_index === "number")).toBe(false);
    render(<AgentActivityPanel range={RANGE} events={events} />);
    expect(screen.getByRole("progressbar", { name: "Days planned" })).toHaveAttribute("aria-valuenow", "5");
  });

  it("keeps the current day and the days not reached yet apart", () => {
    render(<AgentActivityPanel range={RANGE} events={[
      day(2, "2026-01-06"),
      ev({ kind: "iteration", stage: "improve", phase_label: "Build the daily plan", day_index: 2, total_days: 5,
        planning_date: "2026-01-06", days_finished: ["2026-01-05"], days_skipped: [] }),
    ]} />);
    const states = [...screen.getByRole("progressbar", { name: "Days planned" }).children]
      .map((segment) => segment.getAttribute("data-day-state"));
    expect(states).toEqual(["done", "current", "open", "open", "open"]);
  });

  it("shows no day track for runs without a day loop (repair strategy)", () => {
    render(<AgentActivityPanel range={RANGE} events={[ev({ kind: "iteration", stage: "improve", iteration: 3 })]} />);
    expect(screen.queryByRole("progressbar", { name: "Days planned" })).toBeNull();
  });
});
