import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
    expect(screen.getByText("Bergmann").getAttribute("data-sheet-name")).toBe("true");
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
});
