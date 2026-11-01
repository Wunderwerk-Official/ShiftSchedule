import { describe, expect, it } from "vitest";
import {
  assignmentKey,
  buildApplyRequest,
  consentLabel,
  dayLabel,
  dayMonthPair,
  firstName,
  highlightCss,
  hoursLabel,
  hoursText,
  noticeHoursLeft,
  optionHighlightKeys,
  previewTitle,
  primaryLabel,
  recordItemLine,
  stampLabel,
  swapTargetKey,
  swapToastMessage,
  targetHighlightKeys,
  targetSummary,
  timeRange,
  undoToastMessage,
  unitLine,
  unitSummary,
  weekChange,
  weekHoursLine,
  type SwapApplyForm,
} from "./format";
import type { SwapItem, SwapOption, SwapRecord, SwapTargetInfo, SwapUnit, SwapWeekHours } from "./types";

// Fixtures after the examples of SPEC §3.2: Anna's Thursday night, Ben's Saturday CT.
const night: SwapItem = {
  assignmentId: "as-lw3k-anna",
  rowId: "night-thu",
  dateISO: "2026-11-19",
  clinicianId: "clin-anna",
  sectionId: "sec-night",
  sectionName: "Night duty",
  slotLabel: null,
  locationId: "loc-mitte",
  locationName: "Mitte",
  start: "2026-11-19T20:00",
  end: "2026-11-20T08:00",
  minutes: 720,
  fp: "1200-1920@loc-mitte#sec-night",
};
const ct: SwapItem = {
  ...night,
  assignmentId: "as-ben-ct",
  rowId: "ct-sat",
  dateISO: "2026-11-21",
  clinicianId: "clin-ben",
  sectionId: "sec-ct",
  sectionName: "CT",
  start: "2026-11-21T08:00",
  end: "2026-11-21T16:00",
  minutes: 480,
  fp: "480-960@loc-mitte#sec-ct",
};
const unitOf = (items: SwapItem[], overrides: Partial<SwapUnit> = {}): SwapUnit => ({
  clinicianId: items[0].clinicianId,
  startDateISO: items[0].dateISO,
  start: items[0].start,
  end: items[items.length - 1].end,
  minutes: items.reduce((sum, item) => sum + item.minutes, 0),
  kind: "shift",
  overnight: false,
  blockCount: 1,
  primarySectionName: items[0].sectionName,
  items,
  ...overrides,
});
const target = (overrides: Partial<SwapTargetInfo> = {}): SwapTargetInfo => ({
  mode: "swap",
  holderId: "clin-anna",
  holderName: "Anna Weber",
  dateISO: "2026-11-19",
  sectionName: "Night duty",
  unit: unitOf([night], { kind: "duty", overnight: true }),
  blocksOnDate: 1,
  wholeDay: false,
  startsAt: "2026-11-19T20:00+01:00",
  hoursUntilStart: 82.5,
  insideNotice: false,
  noticeHours: 48,
  timeZone: "Europe/Berlin",
  blocked: null,
  openCount: null,
  hiddenHolder: null,
  excludedPartnerIds: ["clin-anna"],
  ...overrides,
});
const option = (overrides: Partial<SwapOption> = {}): SwapOption => ({
  key: "clin-ben|ct-sat@2026-11-21",
  partnerId: "clin-ben",
  partnerName: "Ben Ott",
  take: unitOf([ct]),
  group: "best",
  chips: [],
  reason: null,
  blockerCount: 0,
  warnings: [],
  findings: [],
  hours: [],
  restDayMoves: [],
  restDayRemovals: [],
  hiddenRemoval: null,
  insideNotice: false,
  takeHoursUntilStart: 46,
  preexisting: [],
  ...overrides,
});
const coverTarget = target({
  mode: "cover",
  holderId: null,
  holderName: null,
  sectionName: "CT",
  unit: unitOf([{ ...ct, assignmentId: null, clinicianId: null, rowId: "ct-thu", dateISO: "2026-11-19", start: "2026-11-19T08:00", end: "2026-11-19T16:00" }]),
  openCount: 1,
  hiddenHolder: { clinicianId: "clin-anna", name: "Anna Weber", assignmentId: "as-hidden" },
  excludedPartnerIds: ["clin-anna"],
});
const form = (overrides: Partial<SwapApplyForm> = {}): SwapApplyForm => ({
  consent: true,
  acknowledgedWarnings: [],
  overrideNotice: false,
  restDayMoves: [],
  removeHidden: true,
  note: "",
  approverName: "",
  ...overrides,
});
const record = (overrides: Partial<SwapRecord> = {}): SwapRecord => ({
  id: "swp-1",
  kind: "swap",
  status: "applied",
  requesterId: "clin-anna",
  requesterName: "Dr. Anna Weber",
  partnerId: "clin-ben",
  partnerName: "Ben Ott",
  give: [{ rowId: "night-thu", dateISO: "2026-11-19", sectionName: "Night duty", start: night.start, end: night.end }],
  take: [{ rowId: "ct-sat", dateISO: "2026-11-21", sectionName: "CT", start: ct.start, end: ct.end }],
  restDayMoves: [],
  restDaysRemoved: [],
  hiddenRemoved: null,
  note: null,
  approverName: null,
  consent: "confirmed_by_planner",
  noticeOverride: false,
  acknowledgedWarnings: [],
  createdAt: "2026-11-12T10:42:07+00:00",
  appliedAt: "2026-11-12T10:42:07+00:00",
  revertedAt: null,
  canUndo: true,
  undoBlockedReason: null,
  ...overrides,
});
const week = (overrides: Partial<SwapWeekHours> = {}): SwapWeekHours => ({
  isoYear: 2026,
  isoWeek: 47,
  weekStartISO: "2026-11-16",
  beforeMinutes: 2400,
  afterMinutes: 2160,
  contractMinutes: 2400,
  limitMinutes: 2700,
  ...overrides,
});

describe("swap text helpers", () => {
  it("builds the team grid's pill key", () => {
    expect(assignmentKey("night-thu", "2026-11-19", "clin-anna")).toBe("night-thu__2026-11-19__clin-anna");
  });

  it("names days, and day pairs with the month written once when both share it", () => {
    expect(dayLabel("2026-11-19")).toBe("Thu 19 Nov");
    expect(dayMonthPair("2026-11-19", "2026-11-21")).toBe("Thu 19 / Sat 21 Nov");
    expect(dayMonthPair("2026-11-30", "2026-12-01")).toBe("Mon 30 Nov / Tue 1 Dec");
    expect(dayMonthPair("2026-11-19", "2026-11-19")).toBe("Thu 19 Nov");
  });

  it("writes same-day ranges with an en dash and overnight ones with an arrow", () => {
    expect(timeRange("2026-11-21T08:00", "2026-11-21T16:00")).toBe("08:00–16:00");
    expect(timeRange("2026-11-19T20:00", "2026-11-20T08:00")).toBe("20:00 → 08:00");
  });

  it("formats hours and weekly hours lines", () => {
    expect(hoursLabel(720)).toBe("12.0 h");
    expect(hoursText(10)).toBe("10");
    expect(hoursText(82.46)).toBe("82.5");
    expect(weekChange(week())).toBe("Week 47: 40.0 → 36.0 h");
    expect(weekHoursLine(week())).toBe("Week 47: 40.0 → 36.0 h (limit 45.0 h)");
    expect(weekHoursLine(week({ contractMinutes: null, limitMinutes: null }))).toBe(
      "Week 47: 40.0 → 36.0 h (no contract hours)",
    );
  });

  it("summarizes a unit and writes a partner's shift as one line", () => {
    const demo: SwapItem = { ...night, rowId: "demo-fri", dateISO: "2026-11-20", sectionName: "Demo", start: "2026-11-20T07:15", end: "2026-11-20T07:45", minutes: 30 };
    expect(unitSummary(unitOf([night, demo]))).toBe("Night duty 20:00 → 08:00 + Demo 07:15–07:45");
    expect(unitLine(unitOf([ct]))).toBe("Sat 21 Nov · CT · 08:00–16:00 · Mitte");
    expect(unitLine(unitOf([{ ...ct, locationName: null }]))).toBe("Sat 21 Nov · CT · 08:00–16:00");
  });

  it("takes the first name without titles", () => {
    expect(firstName("Dr. Lena Hoffmann")).toBe("Lena");
    expect(firstName("Prof. Dr. med. Hans Maier")).toBe("Hans");
    expect(firstName("PD DR Eva Roth")).toBe("Eva");
    expect(firstName("Ben Ott")).toBe("Ben");
  });

  it("writes the toasts of all three kinds and of their undo with full names", () => {
    expect(swapToastMessage(record())).toBe("Swapped: Dr. Anna Weber ⇄ Ben Ott (Thu 19 / Sat 21 Nov)");
    expect(
      swapToastMessage(record({ take: [{ ...record().take[0], dateISO: "2026-12-01" }], give: [{ ...record().give[0], dateISO: "2026-11-30" }] })),
    ).toBe("Swapped: Dr. Anna Weber ⇄ Ben Ott (Mon 30 Nov / Tue 1 Dec)");
    const handover = record({ kind: "handover", take: [] });
    expect(swapToastMessage(handover)).toBe("Handed over: Dr. Anna Weber → Ben Ott (Thu 19 Nov)");
    const cover = record({
      kind: "cover",
      requesterId: null,
      requesterName: null,
      give: [{ rowId: "ct-thu", dateISO: "2026-11-19", sectionName: "CT", start: "2026-11-19T08:00", end: "2026-11-19T16:00" }],
      take: [],
    });
    expect(swapToastMessage(cover)).toBe("Assigned: Ben Ott covers CT (Thu 19 Nov)");
    expect(undoToastMessage(record({ status: "reverted" }))).toBe("Swap undone: Dr. Anna Weber ⇄ Ben Ott (Thu 19 / Sat 21 Nov)");
    expect(undoToastMessage(handover)).toBe("Hand-over undone: Dr. Anna Weber → Ben Ott (Thu 19 Nov)");
    expect(undoToastMessage(cover)).toBe("Cover undone: Ben Ott no longer covers CT (Thu 19 Nov)");
    // First names repeat in a team; the full names keep two Evas apart.
    expect(swapToastMessage(record({ requesterName: "Eva One", partnerName: "Eva Two" }))).toBe(
      "Swapped: Eva One ⇄ Eva Two (Thu 19 / Sat 21 Nov)",
    );
  });

  it("labels consent, the primary button and the preview per mode", () => {
    expect(consentLabel("swap", "Ben Ott")).toBe("Ben Ott agreed to this swap");
    expect(consentLabel("handover", "Ben Ott")).toBe("Ben Ott agreed to take this shift");
    expect(consentLabel("cover", "Ben Ott")).toBe("Ben Ott agreed to take this shift");
    expect([primaryLabel("swap"), primaryLabel("handover"), primaryLabel("cover")]).toEqual(["Swap shifts", "Hand over", "Assign"]);
    expect(previewTitle("swap", target(), option())).toBe("Swap Anna Weber ⇄ Ben Ott");
    expect(previewTitle("handover", target(), option({ take: null }))).toBe("Hand over to Ben Ott");
    expect(previewTitle("cover", coverTarget, option({ take: null }))).toBe("Ben Ott covers CT");
  });

  it("summarizes the target, with the blocked fallback when it has no unit", () => {
    expect(targetSummary(target())).toBe("Anna Weber · Thu 19 Nov · Night duty 20:00 → 08:00 · 12.0 h");
    expect(targetSummary(coverTarget)).toBe("Open slot · CT · Thu 19 Nov · 08:00–16:00");
    const blocked = { code: "vacation_hidden" as const, message: "Anna Weber is on vacation." };
    expect(targetSummary(target({ unit: null, blocked }))).toBe("Anna Weber · Thu 19 Nov · Night duty");
    expect(targetSummary(target({ unit: null, blocked, sectionName: null }))).toBe("Anna Weber · Thu 19 Nov");
    expect(
      targetSummary({ ...coverTarget, unit: null, blocked: { code: "inactive_slot", message: "No slot." } }),
    ).toBe("Open slot · Thu 19 Nov · CT");
  });

  it("takes the smaller of the known hours until start", () => {
    expect(noticeHoursLeft(target({ hoursUntilStart: 30 }), option({ takeHoursUntilStart: 10 }))).toBe(10);
    expect(noticeHoursLeft(target({ hoursUntilStart: 30 }), option({ takeHoursUntilStart: null }))).toBe(30);
    expect(noticeHoursLeft(target({ hoursUntilStart: null }), option({ takeHoursUntilStart: null }))).toBeNull();
  });

  it("writes history stamps in local time and moved shifts as one line each", () => {
    expect(stampLabel(new Date(2026, 10, 12, 10, 42).toISOString())).toBe("12 Nov, 10:42");
    expect(recordItemLine(record().give[0])).toBe("Thu 19 Nov · Night duty 20:00 → 08:00");
  });
});

describe("swap highlight", () => {
  it("keys the holder's unit and the partner's taken shift", () => {
    expect(targetHighlightKeys(target())).toEqual(["night-thu__2026-11-19__clin-anna"]);
    expect(targetHighlightKeys(target({ unit: null }))).toEqual([]);
    expect(targetHighlightKeys(coverTarget)).toEqual([]);
    expect(optionHighlightKeys(option())).toEqual(["ct-sat__2026-11-21__clin-ben"]);
    expect(optionHighlightKeys(option({ take: null }))).toEqual([]);
  });

  it("outlines pills and sheet names, with a dark-mode color, escaping the keys", () => {
    const css = highlightCss(["night-thu__2026-11-19__clin-anna", 'odd "row"__2026-11-21__b']);
    const escaped = CSS.escape('odd "row"__2026-11-21__b');
    expect(escaped).not.toBe('odd "row"__2026-11-21__b');
    expect(css).toContain(
      `:is([data-assignment-key="night-thu__2026-11-19__clin-anna"], [data-assignment-key="${escaped}"]):not([data-pill-drag-preview]) { outline: 2px solid #0d9488 !important; outline-offset: 1px !important; }`,
    );
    expect(css).toContain(`.dark :is([data-assignment-key="night-thu__2026-11-19__clin-anna"]`);
    expect(css).toContain("outline-color: #5eead4 !important;");
    expect(css).toContain(
      `:is([data-sheet-assignment-key="night-thu__2026-11-19__clin-anna"], [data-sheet-assignment-key="${escaped}"]) { outline: 2px solid #0d9488 !important; outline-offset: -1px !important; }`,
    );
    expect(highlightCss([])).toBe("");
  });
});

describe("buildApplyRequest", () => {
  const anna = "clin-anna";
  const moveToBen = { fromClinicianId: anna, toClinicianId: "clin-ben", dateISO: "2026-11-20" };
  const moveToAnna = { fromClinicianId: "clin-ben", toClinicianId: anna, dateISO: "2026-11-22" };

  it("swap: both units as item refs, only the ticked rest-day moves, trimmed texts", () => {
    const request = buildApplyRequest(
      "swap",
      target(),
      option({
        restDayMoves: [moveToBen, moveToAnna],
        restDayRemovals: [{ clinicianId: anna, name: "Anna Weber", dateISO: "2026-11-21" }],
      }),
      form({
        restDayMoves: [moveToAnna],
        acknowledgedWarnings: ["rest:clin-ben:2026-11-19T16:00:2026-11-19T20:00"],
        note: "  Ben agreed by phone ",
        approverName: "   ",
        overrideNotice: true,
      }),
    );
    expect(request).toEqual({
      mode: "swap",
      give: [{ rowId: "night-thu", dateISO: "2026-11-19", clinicianId: anna, fp: night.fp }],
      wholeDay: false,
      slot: null,
      partnerId: "clin-ben",
      take: [{ rowId: "ct-sat", dateISO: "2026-11-21", clinicianId: "clin-ben", fp: ct.fp }],
      restDayMoves: [moveToAnna],
      removeHidden: null,
      expectedRevision: "",
      consent: true,
      note: "Ben agreed by phone",
      approverName: null,
      overrideNotice: true,
      acknowledgedWarnings: ["rest:clin-ben:2026-11-19T16:00:2026-11-19T20:00"],
    });
  });

  it("hand-over: no take, the effective whole-day flag", () => {
    const wholeDay = target({ wholeDay: true, blocksOnDate: 2 });
    const request = buildApplyRequest("handover", wholeDay, option({ take: null }), form({ approverName: "K. Berger" }));
    expect(request.take).toBeNull();
    expect(request.wholeDay).toBe(true);
    expect(request.give).toHaveLength(1);
    expect(request.approverName).toBe("K. Berger");
  });

  it("cover: the slot with its fingerprint, nothing given, the hidden removal when ticked or required", () => {
    const hidden = { clinicianId: anna, name: "Anna Weber", assignmentId: "as-hidden", required: false };
    const optional = buildApplyRequest("cover", coverTarget, option({ take: null, hiddenRemoval: hidden }), form());
    expect(optional.give).toEqual([]);
    expect(optional.take).toBeNull();
    expect(optional.slot).toEqual({ rowId: "ct-thu", dateISO: "2026-11-19", fp: ct.fp });
    expect(optional.removeHidden).toEqual({ clinicianId: anna });
    expect(
      buildApplyRequest("cover", coverTarget, option({ take: null, hiddenRemoval: hidden }), form({ removeHidden: false }))
        .removeHidden,
    ).toBeNull();
    expect(
      buildApplyRequest(
        "cover",
        coverTarget,
        option({ take: null, hiddenRemoval: { ...hidden, required: true } }),
        form({ removeHidden: false }),
      ).removeHidden,
    ).toEqual({ clinicianId: anna });
  });
});

describe("swapTargetKey", () => {
  it("keys assignment, slot and history targets", () => {
    expect(
      swapTargetKey({
        kind: "assignment",
        assignment: { assignmentId: "as-1", rowId: "night-thu", dateISO: "2026-11-19", clinicianId: "clin-anna" },
      }),
    ).toBe("a:night-thu__2026-11-19__clin-anna");
    expect(swapTargetKey({ kind: "slot", slot: { rowId: "ct-thu", dateISO: "2026-11-19" } })).toBe("s:ct-thu__2026-11-19");
    expect(swapTargetKey({ kind: "history" })).toBe("h");
  });
});
