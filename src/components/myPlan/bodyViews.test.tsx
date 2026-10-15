import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Assignment, Location } from "../../api/client";
import { buildPersonPlan, type PersonPlan } from "../../lib/myPlan";
import { ASSIGNMENTS, LOCATIONS, assign, makeSource } from "../../lib/myPlan/testFixtures";
import AgendaList from "./AgendaList";
import DayLeftView from "./DayLeftView";
import DayTopView from "./DayTopView";
import MonthListView from "./MonthListView";
import ShiftBlock from "./ShiftBlock";
import WeekLeftView from "./WeekLeftView";
import WeekTopView from "./WeekTopView";
import { assignOverlapLanes, daySegments } from "./dayLanes";
import { nightZones } from "./TimeAxis";
import type { DayLane, PlanViewProps } from "./types";

const source = makeSource();
const locationsById = new Map<string, Location>(LOCATIONS.map((location) => [location.id, location]));

function planFor(clinicianId: string, fromISO: string, toISO: string): PersonPlan {
  return buildPersonPlan({ ...source, clinicianId, fromISO, toISO, todayISO: "2026-10-14" });
}

function viewProps(plan: PersonPlan, overrides: Partial<PlanViewProps> = {}): PlanViewProps {
  return {
    plan,
    days: plan.days,
    selectedShiftId: null,
    onSelectShift: vi.fn(),
    nowMin: 14 * 60 + 32,
    isMobile: false,
    isDark: false,
    locationsById,
    ...overrides,
  };
}

const week42 = planFor("lh", "2026-10-12", "2026-10-18");
const nightId = week42.days[2].segments[0].shiftId;

describe("WeekTopView", () => {
  it("draws both halves of the night as one shift; only the first half is a tab stop", () => {
    const { container } = render(<WeekTopView {...viewProps(week42)} />);
    const halves = container.querySelectorAll<HTMLElement>(`[data-shift-id="${nightId}"]`);
    expect(halves).toHaveLength(2);
    expect(halves[0].tabIndex).toBe(0);
    expect(halves[1].tabIndex).toBe(-1);
    expect(halves[0]).toHaveAccessibleName(
      "Nachtdienst, Wednesday 14 October, 17:00 to Thu 08:00, Klinikum Mitte, 15.0 hours, duty",
    );
    expect(halves[0]).toHaveTextContent("↓ Thu until 08:00");
    expect(halves[1]).toHaveTextContent("until 08:00 · since Wed 17:00");
  });

  it("shows headers, day totals, the rest band and the now-line on today only", () => {
    const { container } = render(<WeekTopView {...viewProps(week42)} />);
    expect(screen.getAllByText("Klinikum Mitte").length).toBeGreaterThan(0);
    expect(screen.getByText("MVZ Nord")).toBeInTheDocument();
    expect(screen.getByText("free")).toBeInTheDocument();
    expect(screen.getAllByText("15.0 h")).toHaveLength(2); // block + day total
    expect(screen.getByTitle("Nachtdienst counts to its start day (Wed)")).toHaveTextContent("–");
    expect(screen.getByText("ND-Frei")).toBeInTheDocument();
    // The rest band names the shift it follows.
    expect(screen.getByText("from 08:00 · after Nachtdienst")).toBeInTheDocument();
    expect(container.querySelectorAll("[data-now-line]")).toHaveLength(1);
    expect(container.querySelector("[data-now-pill]")).toHaveTextContent("14:32");
    expect(container.querySelector('[aria-current="date"]')).toHaveTextContent("14");
  });

  it("toggles selection and outlines both halves of the selected night", () => {
    const onSelectShift = vi.fn();
    const { container, rerender } = render(<WeekTopView {...viewProps(week42, { onSelectShift })} />);
    const first = container.querySelector<HTMLElement>(`[data-shift-id="${nightId}"]`)!;
    fireEvent.click(first);
    expect(onSelectShift).toHaveBeenCalledWith(nightId, first);
    rerender(<WeekTopView {...viewProps(week42, { onSelectShift, selectedShiftId: nightId })} />);
    const halves = container.querySelectorAll<HTMLElement>(`[data-shift-id="${nightId}"]`);
    halves.forEach((half) => expect(half).toHaveAttribute("aria-expanded", "true"));
    fireEvent.click(halves[1]);
    expect(onSelectShift).toHaveBeenLastCalledWith(null, null);
  });

  it("moves focus with arrow keys: ↓ next block in the day, → neighbour day", () => {
    const { container } = render(<WeekTopView {...viewProps(week42)} />);
    const [fb, mrt] = week42.days[0].segments.map((segment) =>
      container.querySelector<HTMLElement>(`[data-shift-id="${segment.shiftId}"]`)!,
    );
    fb.focus();
    fireEvent.keyDown(fb, { key: "ArrowDown" });
    expect(document.activeElement).toBe(mrt);
    fireEvent.keyDown(mrt, { key: "ArrowRight" });
    expect((document.activeElement as HTMLElement).dataset.col).toBe("1");
  });

  it("marks blocks of unpublished weeks as drafts (dashed border)", () => {
    const week44 = planFor("lh", "2026-10-26", "2026-11-01");
    const { container } = render(<WeekTopView {...viewProps(week44)} />);
    const block = container.querySelector<HTMLElement>("[data-plan-block]")!;
    expect(block.style.borderStyle).toBe("dashed");
    expect(block.getAttribute("aria-label")).toContain("draft, not published");
  });

  it("shows a vacation week as one striped all-day bar", () => {
    const week43 = planFor("lh", "2026-10-19", "2026-10-25");
    render(<WeekTopView {...viewProps(week43)} />);
    expect(screen.getAllByText(/Urlaub\/FzA/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Mon 19 Oct – Fri 23 Oct \(5 days\)/).length).toBeGreaterThan(0);
  });

  it("uses compact labels on mobile", () => {
    const { container } = render(<WeekTopView {...viewProps(week42, { isMobile: true })} />);
    const mrt = container.querySelector<HTMLElement>(`[data-shift-id="${week42.days[0].segments[1].shiftId}"]`)!;
    // Short label and start time only (no range, no hours).
    expect(within(mrt).getByText("MRT")).toBeInTheDocument();
    expect(within(mrt).getByText("08:00")).toBeInTheDocument();
    expect(mrt).not.toHaveTextContent("16:30");
  });

  it("phone half lane: a tall night continuation still names itself (vertical label)", () => {
    const night = week42.shifts.get(nightId)!;
    const continuation = { ...week42.days[3].segments[0], lane: 0 as const, lanes: 2 as const };
    const block = (sizePx: number) => (
      <ShiftBlock
        shift={night}
        segment={continuation}
        axis="vertical"
        offsetPx={0}
        sizePx={sizePx}
        variant="compact"
        selected={false}
        onSelect={vi.fn()}
      />
    );
    const { rerender } = render(block(176));
    const button = screen.getByRole("button", { name: /^Nachtdienst/ });
    expect(button).toHaveTextContent("Nacht");
    expect(button).toHaveTextContent("–08:00");
    rerender(block(40));
    expect(screen.getByRole("button", { name: /^Nachtdienst/ }).textContent).toBe("");
  });

  it("desktop half lane: a night continuation reads '–08:00' on one line (no word-by-word wrap)", () => {
    const night = week42.shifts.get(nightId)!;
    const continuation = { ...week42.days[3].segments[0], lane: 0 as const, lanes: 2 as const };
    render(
      <ShiftBlock
        shift={night}
        segment={continuation}
        axis="vertical"
        offsetPx={0}
        sizePx={192}
        selected={false}
        onSelect={vi.fn()}
      />,
    );
    const button = screen.getByRole("button", { name: /^Nachtdienst/ });
    expect(button).toHaveTextContent("Nacht");
    expect(within(button).getByText("–08:00")).toHaveClass("truncate");
    expect(button).not.toHaveTextContent("since");
    // The start stays in the tooltip.
    expect(button).toHaveAttribute("title", "Nachtdienst · 17:00 → Thu 08:00");
  });
});

describe("MonthListView (desktop list)", () => {
  const monthPlan = (extra: Assignment[]) =>
    buildPersonPlan({
      ...makeSource({ assignments: [...ASSIGNMENTS, ...extra] }),
      clinicianId: "lh",
      fromISO: "2026-09-28",
      toISO: "2026-11-01",
      todayISO: "2026-10-14",
    });
  const renderList = (plan: PersonPlan, overrides: Partial<PlanViewProps> = {}) =>
    render(
      <MonthListView
        {...viewProps(plan, overrides)}
        monthAnchor={new Date(2026, 9, 1)}
        weekHours={new Map()}
        onOpenDay={vi.fn()}
      />,
    );
  const bars = (container: HTMLElement, shiftId: string) =>
    Array.from(container.querySelectorAll<HTMLElement>(`[data-shift-id="${shiftId}"]`));

  it("splits overlapping shifts into two lanes of a taller row, so none hides another (R4)", () => {
    // Fri 30: MRT at the same time as Konventionell. Thu 15: Demos 07:15 inside the night's end.
    const plan = monthPlan([assign("lh", "mrt", "2026-10-30"), assign("lh", "demo", "2026-10-15")]);
    const { container } = renderList(plan);
    const [konv] = bars(container, "lh:konv:2026-10-30");
    const [mrt] = bars(container, "lh:mrt:2026-10-30");
    expect([konv.style.top, mrt.style.top].sort()).toEqual(["23px", "4px"]);
    expect([konv.style.height, mrt.style.height]).toEqual(["17px", "17px"]);
    expect(konv.parentElement?.parentElement).toHaveClass("h-11");
    // The evening Zusatzdienst overlaps nothing: a full 20 px bar, centred in the taller row.
    const [zus] = bars(container, "lh:zus:2026-10-30");
    expect([zus.style.top, zus.style.height]).toEqual(["12px", "20px"]);
    // Thu 15: the continuation keeps the top lane, Demos takes the bottom one.
    const continuation = bars(container, "lh:nacht:2026-10-14")[1];
    const [demos] = bars(container, "lh:demo:2026-10-15");
    expect([continuation.style.top, demos.style.top]).toEqual(["4px", "23px"]);
    expect(continuation).toHaveTextContent("↳ Nachtdienst");
    // Days without overlaps keep their 28 px rows.
    const [ct] = bars(container, "lh:ctam:2026-10-13");
    expect(ct.parentElement?.parentElement).toHaveClass("h-7");
    expect([ct.style.top, ct.style.height]).toEqual(["4px", "20px"]);
  });

  it("labels blocks too short for text outside, left of the block (R7)", () => {
    const { container } = renderList(monthPlan([assign("lh", "demo", "2026-10-15")]));
    const [meeting] = bars(container, "lh:kon:2026-10-12");
    expect(meeting).toHaveTextContent("Früh 07:30");
    expect(meeting).toHaveAccessibleName("Frühbesprechung 07:30–08:00, Monday 12 October, Klinikum Mitte, 0.5 hours");
    // Free space counts per lane: Demos (bottom lane) is labelled beside the night's end.
    const [demos] = bars(container, "lh:demo:2026-10-15");
    expect(demos).toHaveTextContent(/07:15$/);
  });

  it("names the row's date, location and hours after the bar text, and lifts the selected bar", () => {
    const plan = monthPlan([assign("lh", "demo", "2026-10-15")]);
    const { container } = renderList(plan, { selectedShiftId: "lh:nacht:2026-10-14" });
    const [evening, continuation] = bars(container, "lh:nacht:2026-10-14");
    expect(evening).toHaveAccessibleName(
      "Nachtdienst 17:00 →, Wednesday 14 October, Klinikum Mitte, 15.0 hours, duty",
    );
    expect(continuation).toHaveAccessibleName(
      "Nachtdienst until 08:00, Thursday 15 October, Klinikum Mitte, 15.0 hours, duty",
    );
    // Demos in the other lane must not paint over the selected continuation's outline.
    const [demos] = bars(container, "lh:demo:2026-10-15");
    expect(continuation).toHaveClass("z-[4]");
    expect(demos).toHaveClass("z-[2]");
  });
});

describe("AgendaList", () => {
  it("lists the hours an entry adds to the totals: '–' when a longer own shift counts them (R4)", () => {
    const meetingId = week42.days[0].segments[0].shiftId; // Mon: Frühbesprechung 07:30–08:00
    const shifts = new Map(week42.shifts);
    shifts.set(meetingId, { ...shifts.get(meetingId)!, countedHours: 0 });
    render(<AgendaList {...viewProps({ ...week42, shifts }, { isMobile: true })} />);
    fireEvent.click(screen.getByRole("button", { name: /Mon 12 Oct – Tue 13 Oct/ }));
    const meeting = screen.getByRole("button", { name: /^Frühbesprechung, Monday 12 October/ });
    expect(meeting).toHaveTextContent("–");
    expect(meeting).not.toHaveTextContent("0.5 h");
    expect(screen.getByRole("button", { name: /^MRT, Monday 12 October/ })).toHaveTextContent("8.5 h");
  });
});

describe("WeekLeftView", () => {
  it("renders day rows with an outside label for the tiny morning meeting", () => {
    const { container } = render(<WeekLeftView {...viewProps(week42)} />);
    expect(screen.getByText("Week 42")).toBeInTheDocument();
    const fb = container.querySelector<HTMLElement>(`[data-shift-id="${week42.days[0].segments[0].shiftId}"]`)!;
    expect(fb).toHaveTextContent("Früh 07:30");
    expect(container.querySelectorAll("[data-now-line]")).toHaveLength(1);
  });

  it("renders the agenda list on mobile with past days collapsed", () => {
    const onSelectShift = vi.fn();
    render(<WeekLeftView {...viewProps(week42, { isMobile: true, onSelectShift })} />);
    const toggle = screen.getByRole("button", { name: /Mon 12 Oct – Tue 13 Oct/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Sonographie")).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.getByText("Sonographie")).toBeInTheDocument();
    expect(screen.getByText(/free until 17:00/)).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: /^Nachtdienst/ })[0]);
    expect(onSelectShift).toHaveBeenCalledWith(nightId, expect.any(HTMLElement));
  });

  it("agenda shows the rest day after the night continuation", () => {
    render(<AgendaList {...viewProps(week42, { isMobile: true })} />);
    expect(screen.getByText("ND-Frei")).toBeInTheDocument();
    expect(screen.getByText("from 08:00")).toBeInTheDocument();
  });
});

describe("Day views", () => {
  const day = planFor("lh", "2026-10-14", "2026-10-14");
  const lane = (clinicianId: string, name: string, group: DayLane["group"]): DayLane => ({
    clinicianId,
    name,
    colorIndex: 0,
    isMe: group === "me",
    group,
    plan: planFor(clinicianId, "2026-10-14", "2026-10-14"),
  });
  const lanes = [
    lane("lh", "Dr. Lena Hoffmann", "me"),
    lane("jw", "Jonas Weber", "sameDuty"),
    lane("sk", "Sophie Klein", "sameTimeAtLocation"),
  ];
  const dayProps = { ...viewProps(day, { days: day.days }), lanes, hiddenColleagueCount: 4 };

  it("day · top: lanes with group labels, an unsplit night and the next-day chip", () => {
    const { container } = render(<DayTopView {...dayProps} detailSlot={<p>detail here</p>} />);
    // Desktop: the detail is the inline column, so blocks are toggles (no dialog).
    const night = container.querySelector<HTMLElement>(`[data-shift-id="${nightId}"]`)!;
    expect(night).toHaveAttribute("aria-pressed", "false");
    expect(night).not.toHaveAttribute("aria-haspopup");
    expect(screen.getByText("Same duty")).toBeInTheDocument();
    expect(screen.getByText("Same time at location")).toBeInTheDocument();
    expect(screen.getByText("Me")).toBeInTheDocument();
    expect(container.querySelectorAll(`[data-shift-id="${nightId}"]`)).toHaveLength(1);
    expect(screen.getByText("Thu 15")).toBeInTheDocument();
    expect(container.querySelector("[data-midnight-line]")).not.toBeNull();
    expect(screen.getByText("free until 17:00")).toBeInTheDocument();
    expect(screen.getByText("+4 more at location")).toBeInTheDocument();
    expect(screen.getByText("detail here")).toBeInTheDocument();
  });

  it("day · top on mobile: only my lane, colleagues listed below", () => {
    const onSelectShift = vi.fn();
    const { container } = render(<DayTopView {...dayProps} isMobile onSelectShift={onSelectShift} />);
    expect(container.querySelectorAll("[data-plan-block]")).toHaveLength(1);
    const list = screen.getByRole("region", { name: "Working with you" });
    const jonas = within(list).getByRole("button", { name: /Jonas Weber/ });
    fireEvent.click(jonas);
    expect(onSelectShift).toHaveBeenCalledWith(expect.stringContaining("jw:"), jonas);
  });

  it("draws the now-line in yesterday's window when it runs past midnight into today", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 15, 7, 0));
    try {
      const wed = buildPersonPlan({ ...source, clinicianId: "lh", fromISO: "2026-10-14", toISO: "2026-10-14", todayISO: "2026-10-15" });
      const props = { ...viewProps(wed, { days: wed.days, nowMin: 7 * 60 }), lanes: [], hiddenColleagueCount: 0 };
      const { container } = render(<DayTopView {...props} />);
      expect(container.querySelectorAll("[data-now-line]")).toHaveLength(1);
      expect(container.querySelector("[data-now-pill]")).toHaveTextContent("07:00");
    } finally {
      vi.useRealTimers();
    }
  });

  it("day · left: lane rows with totals", () => {
    const { container } = render(<DayLeftView {...dayProps} />);
    expect(container.querySelectorAll("[data-plan-block]").length).toBeGreaterThanOrEqual(3);
    expect(screen.getAllByText("15.0 h").length).toBeGreaterThan(0);
    expect(screen.getByText(/Same time at location · Klinikum Mitte/)).toBeInTheDocument();
  });

  it("day · left label cell: the name keeps the width ('Me' on line 2) and may wrap; the tooltip names all", () => {
    render(<DayLeftView {...dayProps} />);
    const me = screen.getByTitle("Dr. Lena Hoffmann · 15.0 h · Klinikum Mitte");
    const name = within(me).getByText("Lena Hoffmann");
    expect(name).toHaveClass("line-clamp-2");
    expect(name.parentElement).not.toHaveTextContent("Me");
    expect(within(me).getByText("Me")).toBeInTheDocument();
    // The hours are in the Hours column of the same row.
    expect(me).not.toHaveTextContent("15.0 h");
    expect(me).toHaveTextContent("Klinikum Mitte");
    const jonas = screen.getByTitle("Jonas Weber · 15.0 h · Klinikum Mitte");
    expect(within(jonas).getByText("Jonas Weber")).toHaveClass("line-clamp-2");
  });
});

describe("dayLanes / axis helpers", () => {
  it("clips the previous night to the window start (flat top) on the next day", () => {
    const thu = planFor("lh", "2026-10-15", "2026-10-15");
    const segments = daySegments(thu, "2026-10-15", { startMin: 0, endMin: 22 * 60 });
    expect(segments[0]).toMatchObject({ startMin: 0, endMin: 480, cutStart: true, cutEnd: false });
  });

  it("puts overlapping segments into two lanes", () => {
    const base = { shiftId: "x", dateISO: "2026-10-15", cutStart: false, cutEnd: false, lane: 0 as const, lanes: 1 as const };
    const placed = assignOverlapLanes([
      { ...base, key: "a", startMin: 0, endMin: 480 },
      { ...base, key: "b", startMin: 435, endMin: 465 },
      { ...base, key: "c", startMin: 600, endMin: 700 },
    ]);
    expect(placed.map((s) => [s.key, s.lane, s.lanes])).toEqual([
      ["a", 0, 2],
      ["b", 1, 2],
      ["c", 0, 1],
    ]);
  });

  it("merges night zones across midnight", () => {
    expect(nightZones(0, 1440)).toEqual([[0, 360], [1320, 1440]]);
    expect(nightZones(360, 1920)).toEqual([[1320, 1800]]);
  });
});
