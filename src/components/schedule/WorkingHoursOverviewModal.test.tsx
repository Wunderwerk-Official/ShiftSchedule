import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import WorkingHoursOverviewModal from "./WorkingHoursOverviewModal";
import type { Assignment, WeeklyCalendarTemplate } from "../../api/client";
import type { ScheduleRow } from "../../lib/shiftRows";
import { toISODate } from "../../lib/date";

// Today is Wed 4 Nov 2026 (W45) in every test.
const NOW = new Date(2026, 10, 4, 10, 0);

const template: WeeklyCalendarTemplate = {
  version: 4,
  blocks: [{ id: "block-1", sectionId: "section-1", requiredSlots: 1 }],
  locations: [
    {
      locationId: "loc-1",
      rowBands: [],
      colBands: [],
      slots: [
        { id: "day", locationId: "loc-1", rowBandId: "r", colBandId: "c", blockId: "block-1", startTime: "08:00", endTime: "16:00" },
        { id: "night", locationId: "loc-1", rowBandId: "r", colBandId: "c", blockId: "block-1", startTime: "19:00", endTime: "07:00", endDayOffset: 1 },
      ],
    },
  ],
};
const scheduleRows: ScheduleRow[] = [
  { id: "day", name: "CT", kind: "class", dotColorClass: "", sectionName: "CT", startTime: "08:00", endTime: "16:00", endDayOffset: 0 },
];

const clinicians = [
  { id: "ann", name: "Ann Arbor", workingHoursPerWeek: 40, vacations: [] },
  { id: "ben", name: "Ben Brook", workingHoursPerWeek: 20, workingHoursToleranceHours: 2, vacations: [{ startISO: "2026-11-04", endISO: "2026-11-06" }] },
  { id: "cat", name: "Cat Cole", vacations: [] },
];
const W45 = ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08"];
let nextId = 0;
const shift = (clinicianId: string, dateISO: string, rowId = "day"): Assignment => ({
  id: `a${(nextId += 1)}`,
  rowId,
  dateISO,
  clinicianId,
});
const assignments: Assignment[] = [
  // W44: one test entry (not counted).
  shift("ann", "2026-11-01", "night"),
  // W45: Ann Mon–Thu (32 h, under), Ben Mon + Tue (16 h, over), Cat Wed.
  ...W45.slice(0, 4).map((dateISO) => shift("ann", dateISO)),
  shift("ben", W45[0]),
  shift("ben", W45[1]),
  shift("cat", W45[2]),
  { id: "rest", rowId: "pool-rest-day", dateISO: W45[4], clinicianId: "ann" },
];

const renderModal = (extra: Partial<Parameters<typeof WorkingHoursOverviewModal>[0]> = {}) => {
  const onClose = vi.fn();
  render(
    <WorkingHoursOverviewModal
      open
      onClose={onClose}
      clinicians={clinicians}
      assignments={assignments}
      weeklyTemplate={template}
      scheduleRows={scheduleRows}
      {...extra}
    />,
  );
  return { onClose };
};
const row = (id: string) => screen.getByTestId(`hours-week-row-${id}`);
const cellOf = (id: string, testId: string) => within(row(id)).getByTestId(testId);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("WorkingHoursOverviewModal — week view", () => {
  it("opens on this week with each person's days, planned hours and target", () => {
    renderModal();
    expect(screen.getByRole("dialog", { name: "Working Hours Overview" })).toBeInTheDocument();
    expect(screen.getByTestId("hours-period")).toHaveTextContent("W45 · 02.11.–08.11.2026");
    expect(screen.getByRole("group", { name: "View" }).querySelector('[aria-pressed="true"]')).toHaveTextContent("Week");
    // Ann: 8 h Mon–Thu, a rest day on Friday, the shift's name in the tooltip.
    const days = within(row("ann")).getAllByTestId("hours-day");
    expect(days.map((day) => day.textContent)).toEqual(["8", "8", "8", "8", "Rest", "–", "–"]);
    expect(days[0]).toHaveAttribute("title", "CT 08:00–16:00");
    expect(cellOf("ann", "hours-planned")).toHaveTextContent("32");
    expect(cellOf("ann", "hours-target")).toHaveTextContent("40");
    expect(within(row("ann")).getByText("40 h/wk")).toBeInTheDocument();
    expect(within(row("cat")).getByText("No contract hours")).toBeInTheDocument();
  });

  it("shows differences with their status, vacation days and the year's balance", () => {
    renderModal();
    expect(cellOf("ann", "hours-difference")).toHaveTextContent("−8");
    expect(cellOf("ann", "hours-difference")).toHaveTextContent("Under target");
    // Ben: Wed–Fri on vacation, target 20 h × 4/7 = 11.4 h, 16 h planned.
    expect(within(row("ben")).getAllByText("Vac")).toHaveLength(3);
    expect(cellOf("ben", "hours-target")).toHaveTextContent("11.43 d vac");
    expect(cellOf("ben", "hours-target")).toHaveAttribute("title", "20 h/wk × 4/7 days (3 vacation days)");
    expect(cellOf("ben", "hours-difference")).toHaveTextContent("+4.6");
    expect(cellOf("ben", "hours-difference")).toHaveTextContent("Over target");
    // W45 is the first counted week: balance = this week's difference.
    expect(cellOf("ann", "hours-balance")).toHaveTextContent("−8");
    expect(cellOf("cat", "hours-balance")).toHaveTextContent("–");
    expect(screen.getByTestId("hours-count-under")).toHaveTextContent("1");
    expect(screen.getByTestId("hours-count-over")).toHaveTextContent("1");
    expect(screen.getByTestId("hours-week-summary")).toHaveTextContent("Planned 56 h");
  });

  it("sorts the most under target first on request, people without a target last", () => {
    // Team order: Cat (no target), Ben (+4.6 h), Ann (−8 h).
    renderModal({ clinicians: [clinicians[2], clinicians[1], clinicians[0]] });
    const order = () =>
      screen.getAllByTestId(/^hours-week-row-/).map((element) => element.dataset.testid!.replace("hours-week-row-", ""));
    expect(order()).toEqual(["cat", "ben", "ann"]);
    fireEvent.click(within(screen.getByRole("group", { name: "Sort" })).getByRole("button", { name: "Most under first" }));
    expect(order()).toEqual(["ann", "ben", "cat"]);
  });

  it("explains a week that does not count yet and steps between weeks and years", () => {
    renderModal();
    fireEvent.click(screen.getByRole("button", { name: "Previous week" }));
    expect(screen.getByTestId("hours-period")).toHaveTextContent("W44 · 26.10.–01.11.2026");
    // 12 of 60 target hours planned.
    expect(screen.getByTestId("hours-week-not-counted")).toHaveTextContent(
      "20% of the team's target hours are planned. The week counts from 50%.",
    );
    expect(cellOf("ann", "hours-planned")).toHaveTextContent("12");
    expect(cellOf("ann", "hours-target")).toHaveTextContent("–");
    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    expect(screen.getByTestId("hours-period")).toHaveTextContent("W45");
    // Back over the year boundary: W1 of 2026 → the last week of 2025.
    for (let step = 0; step < 44; step += 1) fireEvent.click(screen.getByRole("button", { name: "Previous week" }));
    expect(screen.getByTestId("hours-period")).toHaveTextContent("W1 · 01.01.–04.01.2026");
    fireEvent.click(screen.getByRole("button", { name: "Previous week" }));
    expect(screen.getByTestId("hours-period")).toHaveTextContent("W1 · 29.12.–31.12.2025");
    fireEvent.click(screen.getByRole("button", { name: "Next week" }));
    expect(screen.getByTestId("hours-period")).toHaveTextContent("W1 · 01.01.–04.01.2026");
  });
});

describe("WorkingHoursOverviewModal — year view", () => {
  const openYear = () => {
    renderModal();
    fireEvent.click(within(screen.getByRole("group", { name: "View" })).getByRole("button", { name: "Year" }));
  };

  it("shows one row per person: counted weeks tinted, others hatched, totals over counted weeks", () => {
    openYear();
    expect(screen.getByTestId("hours-period")).toHaveTextContent("2026");
    expect(screen.getByTestId("hours-year-row-ann")).toBeInTheDocument();
    const w45 = screen.getByTestId("hours-ann-w45");
    expect(w45).toHaveTextContent("32");
    expect(w45.className).toContain("bg-amber-50");
    expect(w45.getAttribute("title")).toContain("32 h planned · target 40 h · −8 h (under target) · balance −8 h");
    // W44's test entry: shown, hatched, not counted.
    const w44 = screen.getByTestId("hours-ann-w44");
    expect(w44).toHaveTextContent("12");
    expect(w44.className).toContain("hours-unplanned");
    expect(screen.getByTestId("hours-ann-w43")).toHaveTextContent("");
    // Totals count only the counted weeks.
    expect(screen.getByTestId("hours-ann-total")).toHaveTextContent("32");
    expect(screen.getByTestId("hours-ann-target")).toHaveTextContent("40");
    expect(screen.getByTestId("hours-ann-balance")).toHaveTextContent("−8");
    expect(screen.getByTestId("hours-cat-target")).toHaveTextContent("–");
  });

  it("switches the cells between hours, difference and balance", () => {
    openYear();
    const show = screen.getByRole("group", { name: "Show" });
    fireEvent.click(within(show).getByRole("button", { name: "Difference" }));
    expect(screen.getByTestId("hours-ben-w45")).toHaveTextContent("+4.6");
    fireEvent.click(within(show).getByRole("button", { name: "Balance" }));
    expect(screen.getByTestId("hours-ann-w45")).toHaveTextContent("−8");
    // Balance status: −8 h is beyond Ann's ± 5 h.
    expect(screen.getByTestId("hours-ann-w45").className).toContain("bg-amber-50");
  });

  it("opens a week from its header and changes years", () => {
    openYear();
    fireEvent.click(screen.getByRole("button", { name: "Open W44 · 26.10.–01.11.2026 in the week view" }));
    expect(screen.getByTestId("hours-period")).toHaveTextContent("W44 · 26.10.–01.11.2026");
    fireEvent.click(within(screen.getByRole("group", { name: "View" })).getByRole("button", { name: "Year" }));
    fireEvent.click(screen.getByRole("button", { name: "Previous year" }));
    expect(screen.getByTestId("hours-period")).toHaveTextContent("2025");
    expect(screen.getByTestId("hours-ann-total")).toHaveTextContent("–");
  });

  // Week keys stay consistent across time zones: Monday and Sunday of a
  // week land in that week, wherever the browser runs.
  it.each(["Europe/Berlin", "America/New_York", "Pacific/Auckland"])(
    "keeps Monday and Sunday shifts in the same week in %s",
    (timeZone) => {
      vi.stubEnv("TZ", timeZone);
      try {
        const monday = new Date(2026, 0, 12);
        const sunday = new Date(2026, 0, 18);
        render(
          <WorkingHoursOverviewModal
            open
            onClose={() => {}}
            clinicians={[{ id: "tz", name: "Dr. Zone" }]}
            assignments={[
              { id: "m", rowId: "day", dateISO: toISODate(monday), clinicianId: "tz" },
              { id: "s", rowId: "day", dateISO: toISODate(sunday), clinicianId: "tz" },
            ]}
            weeklyTemplate={template}
            timeZone="Europe/Berlin"
          />,
        );
        fireEvent.click(within(screen.getByRole("group", { name: "View" })).getByRole("button", { name: "Year" }));
        expect(screen.getByTestId("hours-tz-w2")).toHaveTextContent("");
        expect(screen.getByTestId("hours-tz-w3")).toHaveTextContent("16");
        expect(screen.getByTestId("hours-tz-w4")).toHaveTextContent("");
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );
});

describe("WorkingHoursOverviewModal — shell", () => {
  it("renders nothing while closed", () => {
    render(
      <WorkingHoursOverviewModal open={false} onClose={() => {}} clinicians={clinicians} assignments={[]} weeklyTemplate={template} />,
    );
    expect(screen.queryByText("Working Hours Overview")).not.toBeInTheDocument();
  });

  it("closes with the button and with Escape", () => {
    const { onClose } = renderModal();
    // The backdrop is a "Close" button too; this is the labelled one.
    fireEvent.click(screen.getByText("Close", { selector: "button" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("shows an empty state without clinicians", () => {
    renderModal({ clinicians: [] });
    expect(screen.getByText("No clinicians added yet.")).toBeInTheDocument();
  });
});
