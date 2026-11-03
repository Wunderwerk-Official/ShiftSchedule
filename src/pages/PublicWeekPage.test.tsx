import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicWebWeekResponse } from "../api/client";
import PublicWeekPage from "./PublicWeekPage";

vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  getPublicWebWeek: vi.fn(),
}));

import { getPublicWebWeek } from "../api/client";

const MON = "2026-01-05";

const basePayload = (scheduleLayout: "classic" | "clinicSheet"): PublicWebWeekResponse => ({
  published: true,
  weekStartISO: MON,
  weekEndISO: "2026-01-11",
  locations: [{ id: "loc-default", name: "Default" }],
  locationsEnabled: true,
  rows: [
    {
      id: "section-a",
      name: "MRI",
      kind: "class",
      dotColorClass: "bg-slate-400",
      blockColor: "#FDE2E4",
    },
    { id: "pool-rest-day", name: "Rest Day", kind: "pool", dotColorClass: "bg-slate-200" },
    { id: "pool-vacation", name: "Vacation", kind: "pool", dotColorClass: "bg-emerald-500" },
  ],
  clinicians: [
    {
      id: "clin-1",
      name: "Anna Bergmann",
      qualifiedClassIds: ["section-a"],
      preferredClassIds: [],
      vacations: [],
    },
  ],
  assignments: [
    { id: "as-1", rowId: "slot-a__mon", dateISO: MON, clinicianId: "clin-1" },
  ],
  minSlotsByRowId: {},
  slotOverridesByKey: {},
  weeklyTemplate: {
    version: 4,
    blocks: [{ id: "block-a", sectionId: "section-a", requiredSlots: 1 }],
    locations: [
      {
        locationId: "loc-default",
        rowBands: [{ id: "band-1", label: "MRT 08:00–17:00", order: 1 }],
        colBands: [{ id: "col-mon-1", label: "", order: 1, dayType: "mon" }],
        slots: [
          {
            id: "slot-a__mon",
            locationId: "loc-default",
            rowBandId: "band-1",
            colBandId: "col-mon-1",
            blockId: "block-a",
            requiredSlots: 1,
            startTime: "08:00",
            endTime: "17:00",
          },
        ],
      },
    ],
  },
  holidays: [],
  solverSettings: {
    enforceSameLocationPerDay: true,
    onCallRestEnabled: false,
    onCallRestDaysBefore: 1,
    onCallRestDaysAfter: 1,
    preferContinuousShifts: true,
    scheduleLayout,
  },
  solverRules: [],
});

describe("PublicWeekPage", () => {
  beforeEach(() => {
    vi.mocked(getPublicWebWeek).mockReset();
    window.history.pushState({}, "", `/public/tok?start=${MON}`);
  });

  it("renders the clinic sheet when the publisher uses the sheet layout", async () => {
    vi.mocked(getPublicWebWeek).mockResolvedValue(basePayload("clinicSheet"));
    render(<PublicWeekPage token="tok" theme="light" />);
    await waitFor(() => {
      expect(screen.getByText("Bergmann")).toBeTruthy();
    });
    // Sheet markers: plain-text surname, no classic pill wrapper, German weekday header.
    expect(screen.getByText("Bergmann").closest("[data-sheet-name]")?.getAttribute("data-sheet-name")).toBe("true");
    expect(document.querySelector('[data-assignment-pill="true"]')).toBeNull();
    expect(screen.getAllByText("Montag").length).toBeGreaterThan(0);
  });

  it("renders the classic grid when the publisher uses the classic layout", async () => {
    vi.mocked(getPublicWebWeek).mockResolvedValue(basePayload("classic"));
    render(<PublicWeekPage token="tok" theme="light" />);
    await waitFor(() => {
      expect(screen.getByText("Anna Bergmann")).toBeTruthy();
    });
    expect(
      screen.getByText("Anna Bergmann").closest('[data-assignment-pill="true"]'),
    ).not.toBeNull();
    expect(document.querySelector("[data-sheet-name]")).toBeNull();
  });

  it("shows the unpublished card regardless of layout", async () => {
    vi.mocked(getPublicWebWeek).mockResolvedValue({
      published: false,
      weekStartISO: MON,
      weekEndISO: "2026-01-11",
    } as PublicWebWeekResponse);
    render(<PublicWeekPage token="tok" theme="light" />);
    await waitFor(() => {
      expect(screen.getByText("This week is not published yet.")).toBeTruthy();
    });
    expect(document.querySelector("[data-schedule-grid]")).toBeNull();
  });

  it("shows a temporary error, not 'Link invalid', when loading fails without a 404", async () => {
    vi.mocked(getPublicWebWeek).mockRejectedValue(new Error("Failed to fetch"));
    render(<PublicWeekPage token="tok" theme="light" />);
    await waitFor(() => {
      expect(screen.getByText("Could not load the schedule. Please try again later.")).toBeTruthy();
    });
    expect(screen.queryByText("Link invalid or expired.")).toBeNull();
  });

  it("shows 'Link invalid or expired.' for a 404", async () => {
    vi.mocked(getPublicWebWeek).mockRejectedValue(
      Object.assign(new Error("Not found"), { status: 404 }),
    );
    render(<PublicWeekPage token="tok" theme="light" />);
    await waitFor(() => {
      expect(screen.getByText("Link invalid or expired.")).toBeTruthy();
    });
    expect(screen.queryByText(/Could not load the schedule/)).toBeNull();
  });
});

// On-call rest rule with a night section: the Sunday night before the week
// (Anna) and the Monday night after it (Tom) put rest days on the week's
// first and last day. The payload sends those nights as rest context only.
const restPayload = (scheduleLayout: "classic" | "clinicSheet"): PublicWebWeekResponse => {
  const base = basePayload(scheduleLayout);
  const template = base.weeklyTemplate!;
  const location = template.locations[0];
  const night = {
    locationId: "loc-default",
    rowBandId: "band-2",
    blockId: "block-n",
    requiredSlots: 1,
    startTime: "20:00",
    endTime: "08:00",
    endDayOffset: 1,
  };
  return {
    ...base,
    rows: [
      base.rows![0],
      { id: "section-n", name: "Night", kind: "class", dotColorClass: "bg-slate-400", blockColor: "#DEE8FF" },
      ...base.rows!.slice(1),
    ],
    clinicians: [
      { ...base.clinicians![0], qualifiedClassIds: ["section-a", "section-n"] },
      {
        id: "clin-2",
        name: "Tom Finck",
        qualifiedClassIds: ["section-a", "section-n"],
        preferredClassIds: [],
        vacations: [],
      },
    ],
    assignments: [],
    restContextAssignments: [
      { clinicianId: "clin-1", dateISO: "2026-01-04", rowId: "slot-n__sun" },
      { clinicianId: "clin-2", dateISO: "2026-01-12", rowId: "slot-n__mon" },
    ],
    weeklyTemplate: {
      ...template,
      blocks: [...template.blocks, { id: "block-n", sectionId: "section-n", requiredSlots: 1 }],
      locations: [
        {
          ...location,
          rowBands: [...location.rowBands, { id: "band-2", label: "Night", order: 2 }],
          colBands: [...location.colBands, { id: "col-sun-1", label: "", order: 1, dayType: "sun" }],
          slots: [
            ...location.slots,
            { ...night, id: "slot-n__sun", colBandId: "col-sun-1" },
            { ...night, id: "slot-n__mon", colBandId: "col-mon-1" },
          ],
        },
      ],
    },
    solverSettings: {
      ...base.solverSettings!,
      onCallRestEnabled: true,
      onCallRestClassId: "section-n",
      onCallRestDaysBefore: 1,
      onCallRestDaysAfter: 1,
    },
  };
};

const cellText = (rowId: string, dateISO: string) =>
  document.querySelector(
    `[data-schedule-cell="true"][data-row-id="${rowId}"][data-date-iso="${dateISO}"]`,
  )?.textContent ?? "";

describe("PublicWeekPage rest days at the week's edges", () => {
  beforeEach(() => {
    vi.mocked(getPublicWebWeek).mockReset();
    window.history.pushState({}, "", `/public/tok?start=${MON}`);
  });

  it("derives rest days from on-call shifts in the neighbouring weeks without showing them", async () => {
    vi.mocked(getPublicWebWeek).mockResolvedValue(restPayload("classic"));
    render(<PublicWeekPage token="tok" theme="light" />);
    await waitFor(() => expect(cellText("pool-rest-day", MON)).toContain("Anna Bergmann"));
    expect(cellText("pool-rest-day", "2026-01-11")).toContain("Tom Finck");
    expect(cellText("pool-rest-day", MON)).not.toContain("Tom Finck");
    for (const day of ["2026-01-06", "2026-01-07", "2026-01-08", "2026-01-09", "2026-01-10"]) {
      expect(cellText("pool-rest-day", day)).toBe("");
    }
    // The nights themselves are not shifts of this week.
    expect(screen.getAllByText("Anna Bergmann")).toHaveLength(1);
    expect(screen.getAllByText("Tom Finck")).toHaveLength(1);
  });

  it("shows the same rest days in the clinic sheet layout", async () => {
    vi.mocked(getPublicWebWeek).mockResolvedValue(restPayload("clinicSheet"));
    render(<PublicWeekPage token="tok" theme="light" />);
    await waitFor(() => expect(cellText("pool-rest-day", MON)).toContain("Bergmann"));
    expect(cellText("pool-rest-day", "2026-01-11")).toContain("Finck");
  });
});

describe("PublicWeekPage Times layout", () => {
  beforeEach(() => {
    vi.mocked(getPublicWebWeek).mockReset();
    window.history.pushState({}, "", `/public/tok?start=${MON}`);
  });

  it("stacks the times when the owner uses the stacked layout", async () => {
    vi.mocked(getPublicWebWeek).mockResolvedValue({ ...basePayload("classic"), teamTimeLayout: "stacked" });
    render(<PublicWeekPage token="tok" theme="light" />);
    await waitFor(() => expect(screen.getByText("Anna Bergmann")).toBeTruthy());
    expect(document.querySelector("[data-stacked-label]")).not.toBeNull();
  });

  it.each([
    ["side by side", { teamTimeLayout: "columns" as const }],
    ["no layout in the payload", {}],
  ])("keeps the times side by side for %s", async (_label, extra) => {
    vi.mocked(getPublicWebWeek).mockResolvedValue({ ...basePayload("classic"), ...extra });
    render(<PublicWeekPage token="tok" theme="light" />);
    await waitFor(() => expect(screen.getByText("Anna Bergmann")).toBeTruthy());
    expect(document.querySelector("[data-stacked-label]")).toBeNull();
  });
});

describe("PublicWeekPage on a phone", () => {
  const shownDates = () =>
    Array.from(
      new Set(
        Array.from(document.querySelectorAll("[data-schedule-cell][data-date-iso]")).map((cell) =>
          cell.getAttribute("data-date-iso"),
        ),
      ),
    );

  beforeEach(() => {
    vi.mocked(getPublicWebWeek).mockReset();
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(max-width: 640px)",
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows one day at a time with its name and moves by day into the next week", async () => {
    window.history.pushState({}, "", "/public/tok?start=2026-01-11");
    vi.mocked(getPublicWebWeek).mockImplementation(async (_token, weekStartISO) => ({
      ...basePayload("classic"),
      weekStartISO,
    }));
    render(<PublicWeekPage token="tok" theme="light" />);
    await waitFor(() => expect(shownDates()).toEqual(["2026-01-11"]));
    expect(screen.getByText("Sun 11.01.2026")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Previous week" })).toBeNull();
    expect(getPublicWebWeek).toHaveBeenLastCalledWith("tok", MON);

    fireEvent.click(screen.getByRole("button", { name: "Next day" }));
    await waitFor(() => expect(shownDates()).toEqual(["2026-01-12"]));
    expect(screen.getByText("Mon 12.01.2026")).toBeTruthy();
    expect(getPublicWebWeek).toHaveBeenLastCalledWith("tok", "2026-01-12");
    expect(window.location.search).toBe("?start=2026-01-12");

    fireEvent.click(screen.getByRole("button", { name: "Previous day" }));
    await waitFor(() => expect(shownDates()).toEqual(["2026-01-11"]));
  });

  it("stacks the day's times even when the owner uses side by side", async () => {
    window.history.pushState({}, "", `/public/tok?start=${MON}`);
    vi.mocked(getPublicWebWeek).mockResolvedValue({ ...basePayload("classic"), teamTimeLayout: "columns" });
    render(<PublicWeekPage token="tok" theme="light" />);
    await waitFor(() => expect(screen.getByText("Anna Bergmann")).toBeTruthy());
    // A stacked single day labels each time lane in its section's color.
    expect(document.querySelector(".stacked-label-tint")).not.toBeNull();
  });

  it("uses the day view for the clinic sheet layout too", async () => {
    window.history.pushState({}, "", `/public/tok?start=${MON}`);
    vi.mocked(getPublicWebWeek).mockResolvedValue(basePayload("clinicSheet"));
    render(<PublicWeekPage token="tok" theme="light" />);
    await waitFor(() => expect(screen.getByText("Anna Bergmann")).toBeTruthy());
    expect(document.querySelector("[data-sheet-name]")).toBeNull();
    expect(shownDates()).toEqual([MON]);
  });
});
