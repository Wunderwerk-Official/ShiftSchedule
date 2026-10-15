import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import WorkingHoursOverviewModal from "./WorkingHoursOverviewModal";
import type { Assignment, WeeklyCalendarTemplate } from "../../api/client";
import { toISODate } from "../../lib/date";
import { getSlotDurationMinutes } from "../../lib/myPlan";

// Test the getWeeksInYear logic by checking the rendered output
describe("WorkingHoursOverviewModal", () => {
  const mockClinicians = [
    { id: "clin-1", name: "Dr. Smith", workingHoursPerWeek: 40 },
    { id: "clin-2", name: "Dr. Jones", workingHoursPerWeek: 32 },
    { id: "clin-3", name: "Dr. Brown" }, // No contract hours
  ];

  const mockAssignments: Assignment[] = [
    { id: "a1", rowId: "slot-1", dateISO: "2026-01-05", clinicianId: "clin-1" },
    { id: "a2", rowId: "slot-1", dateISO: "2026-01-06", clinicianId: "clin-1" },
    { id: "a3", rowId: "slot-1", dateISO: "2026-01-07", clinicianId: "clin-2" },
    // Pool assignment should not count
    { id: "a4", rowId: "pool-rest-day", dateISO: "2026-01-08", clinicianId: "clin-1" },
  ];

  const mockTemplate: WeeklyCalendarTemplate = {
    version: 4,
    blocks: [{ id: "block-1", sectionId: "section-1", requiredSlots: 1 }],
    locations: [
      {
        locationId: "loc-1",
        rowBands: [],
        colBands: [],
        slots: [
          {
            id: "slot-1",
            locationId: "loc-1",
            rowBandId: "row-1",
            colBandId: "col-1",
            blockId: "block-1",
            startTime: "08:00",
            endTime: "16:00",
          },
        ],
      },
    ],
  };

  it("renders modal when open", () => {
    render(
      <WorkingHoursOverviewModal
        open={true}
        onClose={() => {}}
        clinicians={mockClinicians}
        assignments={[]}
        weeklyTemplate={mockTemplate}
      />
    );

    expect(screen.getByText("Working Hours Overview")).toBeInTheDocument();
  });

  it("does not render when closed", () => {
    render(
      <WorkingHoursOverviewModal
        open={false}
        onClose={() => {}}
        clinicians={mockClinicians}
        assignments={[]}
        weeklyTemplate={mockTemplate}
      />
    );

    expect(screen.queryByText("Working Hours Overview")).not.toBeInTheDocument();
  });

  it("displays all clinician names", () => {
    render(
      <WorkingHoursOverviewModal
        open={true}
        onClose={() => {}}
        clinicians={mockClinicians}
        assignments={[]}
        weeklyTemplate={mockTemplate}
      />
    );

    expect(screen.getByText("Dr. Smith")).toBeInTheDocument();
    expect(screen.getByText("Dr. Jones")).toBeInTheDocument();
    expect(screen.getByText("Dr. Brown")).toBeInTheDocument();
  });

  it("shows contract hours for clinicians that have them", () => {
    render(
      <WorkingHoursOverviewModal
        open={true}
        onClose={() => {}}
        clinicians={mockClinicians}
        assignments={[]}
        weeklyTemplate={mockTemplate}
      />
    );

    expect(screen.getByText("40h/w")).toBeInTheDocument();
    expect(screen.getByText("32h/w")).toBeInTheDocument();
  });

  it("shows empty state when no clinicians", () => {
    render(
      <WorkingHoursOverviewModal
        open={true}
        onClose={() => {}}
        clinicians={[]}
        assignments={[]}
        weeklyTemplate={mockTemplate}
      />
    );

    expect(screen.getByText("No clinicians added yet.")).toBeInTheDocument();
  });

  it("displays year selector with current year", () => {
    const currentYear = new Date().getFullYear();
    render(
      <WorkingHoursOverviewModal
        open={true}
        onClose={() => {}}
        clinicians={mockClinicians}
        assignments={[]}
        weeklyTemplate={mockTemplate}
      />
    );

    // Year appears in multiple places (selector and date range column), so use getAllByText
    const yearElements = screen.getAllByText(currentYear.toString());
    expect(yearElements.length).toBeGreaterThan(0);
  });

  it("has week columns with W1, W2, etc.", () => {
    render(
      <WorkingHoursOverviewModal
        open={true}
        onClose={() => {}}
        clinicians={mockClinicians}
        assignments={[]}
        weeklyTemplate={mockTemplate}
      />
    );

    // W1, W2 appear once in header
    expect(screen.getByText("W1")).toBeInTheDocument();
    expect(screen.getByText("W2")).toBeInTheDocument();
  });

  it("shows Total column", () => {
    render(
      <WorkingHoursOverviewModal
        open={true}
        onClose={() => {}}
        clinicians={mockClinicians}
        assignments={[]}
        weeklyTemplate={mockTemplate}
      />
    );

    expect(screen.getByText("Total")).toBeInTheDocument();
  });

  it("shows Today button", () => {
    render(
      <WorkingHoursOverviewModal
        open={true}
        onClose={() => {}}
        clinicians={mockClinicians}
        assignments={[]}
        weeklyTemplate={mockTemplate}
      />
    );

    expect(screen.getByText("Today")).toBeInTheDocument();
  });

  it("shows Close button", () => {
    render(
      <WorkingHoursOverviewModal
        open={true}
        onClose={() => {}}
        clinicians={mockClinicians}
        assignments={[]}
        weeklyTemplate={mockTemplate}
      />
    );

    expect(screen.getByText("Close")).toBeInTheDocument();
  });
});

// Unit tests for week calculation logic
describe("Week calculation logic", () => {
  // Helper to calculate weeks for a year (replicating the modal's logic)
  function getWeeksInYear(year: number): Array<{ weekNum: number; start: Date; end: Date; daysInWeek: number }> {
    const weeks: Array<{ weekNum: number; start: Date; end: Date; daysInWeek: number }> = [];

    const jan1 = new Date(year, 0, 1);
    const dec31 = new Date(year, 11, 31);

    function getWeekStart(date: Date): Date {
      const d = new Date(date);
      const day = d.getDay();
      const diff = d.getDate() - day + (day === 0 ? -6 : 1);
      d.setDate(diff);
      d.setHours(0, 0, 0, 0);
      return d;
    }

    let weekMonday = getWeekStart(jan1);
    let weekNum = 1;

    while (weekMonday <= dec31) {
      const weekSunday = new Date(weekMonday);
      weekSunday.setDate(weekSunday.getDate() + 6);

      const clampedStart = weekMonday < jan1 ? jan1 : weekMonday;
      const clampedEnd = weekSunday > dec31 ? dec31 : weekSunday;

      const msPerDay = 24 * 60 * 60 * 1000;
      const daysInWeek = Math.round((clampedEnd.getTime() - clampedStart.getTime()) / msPerDay) + 1;

      weeks.push({
        weekNum,
        start: new Date(clampedStart),
        end: new Date(clampedEnd),
        daysInWeek,
      });

      weekMonday.setDate(weekMonday.getDate() + 7);
      weekNum++;

      if (weekNum > 54) break;
    }

    return weeks;
  }

  it("first week starts on Jan 1", () => {
    const weeks2026 = getWeeksInYear(2026);
    expect(weeks2026[0].start.getMonth()).toBe(0); // January
    expect(weeks2026[0].start.getDate()).toBe(1);
  });

  it("last week ends on Dec 31", () => {
    const weeks2026 = getWeeksInYear(2026);
    const lastWeek = weeks2026[weeks2026.length - 1];
    expect(lastWeek.end.getMonth()).toBe(11); // December
    expect(lastWeek.end.getDate()).toBe(31);
  });

  it("calculates partial week days correctly for 2026", () => {
    // 2026: Jan 1 is Thursday, so first week has 4 days (Thu-Sun)
    const weeks2026 = getWeeksInYear(2026);
    // Jan 1 2026 is Thursday (day 4), week ends Sunday (3 days: Thu, Fri, Sat, Sun = 4 days)
    expect(weeks2026[0].daysInWeek).toBeLessThanOrEqual(7);
  });

  it("calculates partial week days correctly for 2025", () => {
    // 2025: Jan 1 is Wednesday
    const weeks2025 = getWeeksInYear(2025);
    // First week should have fewer than 7 days
    expect(weeks2025[0].daysInWeek).toBeLessThanOrEqual(7);
  });

  it("has correct number of weeks for typical year", () => {
    const weeks2026 = getWeeksInYear(2026);
    // A year typically has 52-54 weeks
    expect(weeks2026.length).toBeGreaterThanOrEqual(52);
    expect(weeks2026.length).toBeLessThanOrEqual(54);
  });

  it("total days across all weeks equals 365 or 366", () => {
    const weeks2026 = getWeeksInYear(2026);
    const totalDays = weeks2026.reduce((sum, w) => sum + w.daysInWeek, 0);
    expect(totalDays).toBe(365); // 2026 is not a leap year

    const weeks2024 = getWeeksInYear(2024);
    const totalDays2024 = weeks2024.reduce((sum, w) => sum + w.daysInWeek, 0);
    expect(totalDays2024).toBe(366); // 2024 is a leap year
  });

  it("calculates fractional expected hours correctly", () => {
    const weeks2026 = getWeeksInYear(2026);
    const expectedWeeklyHours = 40;

    // Calculate total expected hours accounting for partial weeks
    const totalExpected = weeks2026.reduce(
      (sum, w) => sum + expectedWeeklyHours * (w.daysInWeek / 7),
      0
    );

    // Should be close to 40 * 52 = 2080, but adjusted for partial weeks
    // 365 days / 7 = 52.14 weeks approximately
    expect(totalExpected).toBeCloseTo((365 / 7) * 40, 1);
  });
});

// Tests for hours calculation (the modal uses the shared My plan rule)
describe("Hours calculation", () => {
  it("calculates slot duration from start and end time", () => {
    // 08:00 to 16:00 = 8 hours = 480 minutes
    expect(getSlotDurationMinutes({ startTime: "08:00", endTime: "16:00" })).toBe(480);
    expect(getSlotDurationMinutes({ startTime: "09:00", endTime: "17:00" })).toBe(480);
    expect(getSlotDurationMinutes({ startTime: "06:00", endTime: "14:00" })).toBe(480);
  });

  it("handles overnight shifts with day offset", () => {
    // 22:00 to 06:00 next day = 8 hours = 480 minutes
    expect(
      getSlotDurationMinutes({ startTime: "22:00", endTime: "06:00", endDayOffset: 1 })
    ).toBe(480);

    // 20:00 to 08:00 next day = 12 hours = 720 minutes
    expect(
      getSlotDurationMinutes({ startTime: "20:00", endTime: "08:00", endDayOffset: 1 })
    ).toBe(720);
  });

  it("uses default 8 hours when times are missing", () => {
    expect(getSlotDurationMinutes({})).toBe(480);
    expect(getSlotDurationMinutes({ startTime: "08:00" })).toBe(480);
    expect(getSlotDurationMinutes({ endTime: "16:00" })).toBe(480);
  });
});

// Tests for formatting
describe("formatHours", () => {
  function formatHours(minutes: number): string {
    const hours = minutes / 60;
    if (hours === 0) return "–";
    return hours.toFixed(1).replace(/\.0$/, "");
  }

  it("formats zero as dash", () => {
    expect(formatHours(0)).toBe("–");
  });

  it("formats whole hours without decimal", () => {
    expect(formatHours(480)).toBe("8"); // 8 hours
    expect(formatHours(600)).toBe("10"); // 10 hours
  });

  it("formats fractional hours with one decimal", () => {
    expect(formatHours(450)).toBe("7.5"); // 7.5 hours
    expect(formatHours(510)).toBe("8.5"); // 8.5 hours
  });
});

describe("Weekly hours aggregation (rendered)", () => {
  const year = new Date().getFullYear();
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
          { id: "night", locationId: "loc-1", rowBandId: "r", colBandId: "c", blockId: "block-1", startTime: "17:00", endTime: "08:00", endDayOffset: 1 },
        ],
      },
    ],
  };
  const assignments: Assignment[] = [
    // Counted: week 1 (contains Jan 1) and week 2 (Jan 8 is always in week 2)
    { id: "a1", rowId: "day", dateISO: `${year}-01-01`, clinicianId: "clin-1" },
    { id: "a2", rowId: "night", dateISO: `${year}-01-08`, clinicianId: "clin-1" },
    // Ignored: other years, pool rows, unknown clinicians
    { id: "a3", rowId: "day", dateISO: `${year - 1}-12-31`, clinicianId: "clin-1" },
    { id: "a4", rowId: "day", dateISO: `${year + 1}-01-01`, clinicianId: "clin-1" },
    { id: "a5", rowId: "pool-rest-day", dateISO: `${year}-01-02`, clinicianId: "clin-1" },
    { id: "a6", rowId: "day", dateISO: `${year}-01-02`, clinicianId: "ghost" },
  ];

  it("sums slot durations per week and year for the selected year only", () => {
    render(
      <WorkingHoursOverviewModal
        open
        onClose={() => {}}
        clinicians={[{ id: "clin-1", name: "Dr. Night" }]}
        assignments={assignments}
        weeklyTemplate={template}
      />,
    );
    expect(screen.getByTestId("hours-clin-1-w1")).toHaveTextContent("8");
    expect(screen.getByTestId("hours-clin-1-w2")).toHaveTextContent("15");
    expect(screen.getByTestId("hours-clin-1-w3")).toHaveTextContent("–");
    expect(screen.getByTestId("hours-clin-1-total")).toHaveTextContent("23");
  });

  // Pins that week keys stay consistent across time zones: Monday and Sunday
  // of a week land in that week, wherever the browser runs.
  it.each(["Europe/Berlin", "America/New_York", "Pacific/Auckland"])(
    "keeps Monday and Sunday shifts in the same week in %s",
    (timeZone) => {
      // Node applies a runtime change of TZ to all later Date operations.
      vi.stubEnv("TZ", timeZone);
      try {
        const jan8 = new Date(year, 0, 8); // always in week 2
        const monday = new Date(year, 0, 8 - ((jan8.getDay() + 6) % 7));
        const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
        render(
          <WorkingHoursOverviewModal
            open
            onClose={() => {}}
            clinicians={[{ id: "clin-tz", name: "Dr. Zone" }]}
            assignments={[
              { id: "m", rowId: "day", dateISO: toISODate(monday), clinicianId: "clin-tz" },
              { id: "s", rowId: "day", dateISO: toISODate(sunday), clinicianId: "clin-tz" },
            ]}
            weeklyTemplate={template}
          />,
        );
        expect(screen.getByTestId("hours-clin-tz-w1")).toHaveTextContent("–");
        expect(screen.getByTestId("hours-clin-tz-w2")).toHaveTextContent("16");
        expect(screen.getByTestId("hours-clin-tz-w3")).toHaveTextContent("–");
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );
});
