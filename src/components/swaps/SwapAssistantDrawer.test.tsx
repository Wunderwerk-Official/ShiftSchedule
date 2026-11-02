import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SwapApiError, type Clinician } from "../../api/client";
import type {
  SwapCandidatesRequest,
  SwapCandidatesResponse,
  SwapCheck,
  SwapFinding,
  SwapItem,
  SwapOption,
  SwapRecord,
  SwapTargetInfo,
  SwapUnit,
  SwapWarning,
} from "../../lib/swaps/types";
import { SwapSaveBlockedError, type SwapSearchResult } from "../../pages/swapFlow";
import SwapAssistantDrawer, { type SwapAssistantDrawerProps } from "./SwapAssistantDrawer";
import SwapHistoryButton from "./SwapHistoryButton";

// Fixtures after the example of SPEC §3.2: Anna Weber's Thursday night; Carl
// is the best match, Ben possible (a short rest, a note, Rest Day changes),
// Julia blocked.

const clinicians: Clinician[] = [
  ["clin-anna", "Anna Weber"],
  ["clin-ben", "Ben Ott"],
  ["clin-carl", "Carl Brandt"],
  ["clin-julia", "Julia Meier"],
].map(([id, name]) => ({ id, name, qualifiedClassIds: [], preferredClassIds: [], vacations: [] }));

const item = (overrides: Partial<SwapItem>): SwapItem => ({
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
  ...overrides,
});
const unit = (only: SwapItem, overrides: Partial<SwapUnit> = {}): SwapUnit => ({
  clinicianId: only.clinicianId,
  startDateISO: only.dateISO,
  start: only.start,
  end: only.end,
  minutes: only.minutes,
  kind: "shift",
  overnight: false,
  blockCount: 1,
  primarySectionName: only.sectionName,
  items: [only],
  ...overrides,
});
const ct = (rowId: string, dateISO: string, clinicianId: string | null): SwapItem =>
  item({
    assignmentId: clinicianId ? `as-${rowId}` : null,
    rowId,
    dateISO,
    clinicianId,
    sectionId: "sec-ct",
    sectionName: "CT",
    start: `${dateISO}T08:00`,
    end: `${dateISO}T16:00`,
    minutes: 480,
    fp: "480-960@loc-mitte#sec-ct",
  });

const night = item({});
const annaRef = { assignmentId: "as-lw3k-anna", rowId: "night-thu", dateISO: "2026-11-19", clinicianId: "clin-anna" };
const target: SwapTargetInfo = {
  mode: "swap",
  holderId: "clin-anna",
  holderName: "Anna Weber",
  dateISO: "2026-11-19",
  sectionName: "Night duty",
  unit: unit(night, { kind: "duty", overnight: true }),
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
};
const checks: SwapCheck[] = [
  { code: "qualification", label: "Qualified for both shifts" },
  { code: "overlap", label: "No new overlapping shifts" },
  { code: "weekly_hours", label: "No new week over contract + tolerance" },
  { code: "rest", label: "No new rest under 11 h between shifts" },
];
const week = (minutesBefore: number, minutesAfter: number) => ({
  isoYear: 2026,
  isoWeek: 47,
  weekStartISO: "2026-11-16",
  beforeMinutes: minutesBefore,
  afterMinutes: minutesAfter,
  contractMinutes: 2400,
  limitMinutes: 2700,
});
const option = (overrides: Partial<SwapOption>): SwapOption => ({
  key: "",
  partnerId: "",
  partnerName: "",
  take: null,
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
  takeHoursUntilStart: null,
  preexisting: [],
  ...overrides,
});
const restWarning: SwapWarning = {
  id: "rest:clin-ben:2026-11-19T16:00:2026-11-19T20:00",
  code: "rest_short",
  check: "rest",
  clinicianId: "clin-ben",
  message: "Ben Ott: only 4.0 h rest between Thu 19 Nov 16:00 and Thu 19 Nov 20:00 (minimum 11 h).",
  short: "Short rest 4 h",
};
const moveToBen = { fromClinicianId: "clin-anna", toClinicianId: "clin-ben", dateISO: "2026-11-20" };
const carl = option({
  key: "clin-carl|ct-wed@2026-11-18",
  partnerId: "clin-carl",
  partnerName: "Carl Brandt",
  take: unit(ct("ct-wed", "2026-11-18", "clin-carl")),
  chips: [
    { code: "same_week", label: "Same week", tone: "neutral" },
    { code: "hours_even", label: "Hours even", tone: "neutral" },
  ],
  takeHoursUntilStart: 46,
});
const ben = option({
  key: "clin-ben|ct-sat@2026-11-21",
  partnerId: "clin-ben",
  partnerName: "Ben Ott",
  take: unit(ct("ct-sat", "2026-11-21", "clin-ben")),
  group: "possible",
  chips: [{ code: "same_week", label: "Same week", tone: "neutral" }],
  warnings: [restWarning],
  findings: [
    { code: "hours_above_contract", clinicianId: "clin-ben", message: "Ben Ott: week 47 at 44.0 h (contract 40 h).", short: "+4 h over contract" },
  ],
  hours: [
    { clinicianId: "clin-anna", name: "Anna Weber", weeks: [week(2400, 2160)] },
    { clinicianId: "clin-ben", name: "Ben Ott", weeks: [week(2400, 2640)] },
  ],
  restDayMoves: [moveToBen],
  restDayRemovals: [{ clinicianId: "clin-anna", name: "Anna Weber", dateISO: "2026-11-21" }],
  preexisting: ["weekly_hours"],
  takeHoursUntilStart: 94.5,
});
const julia = option({
  key: "clin-julia|mri-thu@2026-11-19",
  partnerId: "clin-julia",
  partnerName: "Julia Meier",
  take: unit(item({ rowId: "mri-thu", clinicianId: "clin-julia", sectionName: "MRI", start: "2026-11-19T08:00", end: "2026-11-19T16:00" })),
  group: "blocked",
  reason: { code: "overlap", message: "Julia Meier already works MRI on Thu 19 Nov (08:00–16:00)." },
  blockerCount: 1,
  takeHoursUntilStart: 82.5,
});
const response: SwapCandidatesResponse = {
  revision: "9f2c4e",
  target,
  checks,
  targetFindings: [],
  best: [carl],
  possible: [ben],
  blocked: [julia],
  closest: [],
  totals: { best: 1, possible: 1, blocked: 14 },
  checked: 16,
  truncated: false,
};

const coverTarget: SwapTargetInfo = {
  ...target,
  mode: "cover",
  holderId: null,
  holderName: null,
  sectionName: "CT",
  unit: unit(ct("ct-thu", "2026-11-19", null)),
  openCount: 1,
  hiddenHolder: { clinicianId: "clin-anna", name: "Anna Weber", assignmentId: "as-hidden" },
  excludedPartnerIds: ["clin-anna", "clin-julia"],
};
const coverResponse: SwapCandidatesResponse = {
  ...response,
  target: coverTarget,
  best: [
    option({
      key: "clin-ben|-",
      partnerId: "clin-ben",
      partnerName: "Ben Ott",
      hours: [{ clinicianId: "clin-ben", name: "Ben Ott", weeks: [week(1920, 2400)] }],
      hiddenRemoval: { clinicianId: "clin-anna", name: "Anna Weber", assignmentId: "as-hidden", required: true },
    }),
  ],
  possible: [],
  blocked: [],
  totals: { best: 1, possible: 0, blocked: 0 },
  checked: 1,
};

const record = (overrides: Partial<SwapRecord>): SwapRecord => ({
  id: "swp-1",
  kind: "swap",
  status: "applied",
  requesterId: "clin-anna",
  requesterName: "Anna Weber",
  partnerId: "clin-ben",
  partnerName: "Ben Ott",
  give: [{ rowId: "night-thu", dateISO: "2026-11-19", sectionName: "Night duty", start: night.start, end: night.end }],
  take: [{ rowId: "ct-sat", dateISO: "2026-11-21", sectionName: "CT", start: "2026-11-21T08:00", end: "2026-11-21T16:00" }],
  restDayMoves: [],
  restDaysRemoved: [],
  hiddenRemoved: null,
  note: "Ben agreed by phone",
  approverName: "K. Berger",
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

const APPROVER_KEY = "shiftSchedule.swapApproverName";
/** History's Undo button for the default record (visible text "Undo"). */
const UNDO_ANNA_BEN = "Undo swap of Anna Weber and Ben Ott (Thu 19 / Sat 21 Nov)";

/** A search's result as the page resolves it; `reloaded`: the page reloaded the calendar first. */
const found = (answer: SwapCandidatesResponse, reloaded = false): SwapSearchResult => ({ response: answer, reloaded });

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  window.localStorage.clear();
});

const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
/** Past the search debounce, twice: an answer can start the next step (a refresh after a refusal). */
const settle = async () => {
  await advance(250);
  await advance(250);
};

function renderDrawer(overrides: Partial<SwapAssistantDrawerProps> = {}) {
  const props: SwapAssistantDrawerProps = {
    target: { kind: "assignment", assignment: annaRef },
    clinicians,
    isMobile: false,
    isDark: false,
    publishedWeekStartISOs: [],
    planToken: {},
    historyToken: 0,
    // Every answer is a new object, as from the network.
    onSearch: vi.fn(async () => found({ ...response })),
    onApply: vi.fn().mockResolvedValue(undefined),
    onUndo: vi.fn().mockResolvedValue(undefined),
    onLoadHistory: vi.fn().mockResolvedValue([]),
    onRevealKey: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  const utils = render(<SwapAssistantDrawer {...props} />);
  return { ...utils, props };
}

const optionRow = (key: string) => document.querySelector(`[data-swap-option="${key}"]`) as HTMLElement;
/** Elements with this text outside the hidden list (the preview replaces it). */
const shownText = (text: string) => screen.queryAllByText(text).filter((element) => !element.closest("[hidden]"));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function openBenPreview(overrides: Partial<SwapAssistantDrawerProps> = {}) {
  const view = renderDrawer(overrides);
  await settle();
  fireEvent.click(screen.getByRole("button", { name: "Preview swap with Ben Ott" }));
  return view;
}

describe("SwapAssistantDrawer: search", () => {
  it("searches once after mounting and shows the summary, groups, footer and announcement", async () => {
    const { props } = renderDrawer();
    expect(props.onSearch).not.toHaveBeenCalled();
    await settle();
    expect(props.onSearch).toHaveBeenCalledTimes(1);
    expect(props.onSearch).toHaveBeenCalledWith({
      mode: "swap",
      assignment: annaRef,
      slot: null,
      wholeDay: false,
      partnerId: null,
      range: "fourWeeks",
      dates: [],
      sameTypeOnly: false,
    });
    const dialog = screen.getByRole("dialog", { name: "Find a swap" });
    expect(dialog).toHaveAttribute("aria-modal", "false");
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Find a swap" }));
    expect(screen.getByText("Anna Weber · Thu 19 Nov · Night duty 20:00 → 08:00 · 12.0 h")).toBeInTheDocument();
    expect(screen.getByText("Best matches (1)")).toBeInTheDocument();
    expect(screen.getByText("Also possible (1)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Not possible (14)" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("Checked 16 options against all planning rules.")).toBeInTheDocument();
    expect(screen.getByText("1 best matches, 1 also possible, 14 not possible. Checked 16 options.")).toBeInTheDocument();
    // Rows: the partner's shift, chips, and the amber notes of a possible option.
    expect(within(optionRow(carl.key)).getByText("Wed 18 Nov · CT · 08:00–16:00 · Mitte")).toBeInTheDocument();
    expect(within(optionRow(carl.key)).getByText("Hours even")).toBeInTheDocument();
    expect(within(optionRow(ben.key)).getByText("Short rest 4 h")).toBeInTheDocument();
    expect(within(optionRow(ben.key)).getByText("+4 h over contract")).toBeInTheDocument();
  });

  it("moves between the Preview buttons with the arrow keys", async () => {
    renderDrawer();
    await settle();
    const carlPreview = screen.getByRole("button", { name: "Preview swap with Carl Brandt" });
    carlPreview.focus();
    fireEvent.keyDown(carlPreview, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Preview swap with Ben Ott" }));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowUp" });
    expect(document.activeElement).toBe(carlPreview);
  });

  it("searches hand-overs, and covers a slot without the mode switch or the slot's holders", async () => {
    const { props, unmount } = renderDrawer();
    await settle();
    fireEvent.click(within(screen.getByRole("group", { name: "Mode" })).getByRole("button", { name: "Hand over" }));
    await settle();
    expect(props.onSearch).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "handover" }));
    unmount();

    const onSearch = vi.fn().mockResolvedValue(found(coverResponse));
    renderDrawer({ target: { kind: "slot", slot: { rowId: "ct-thu", dateISO: "2026-11-19" } }, onSearch });
    await settle();
    expect(onSearch).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "cover", slot: { rowId: "ct-thu", dateISO: "2026-11-19" }, assignment: null }),
    );
    expect(screen.getByRole("heading", { name: "Find cover" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Mode" })).toBeNull();
    expect(screen.getByText("Open slot · CT · Thu 19 Nov · 08:00–16:00")).toBeInTheDocument();
    expect(screen.getByText("Anna Weber is on vacation, so this shift is hidden.")).toBeInTheDocument();
    const partners = within(screen.getByLabelText("With")).getAllByRole("option").map((entry) => entry.textContent);
    expect(partners).toEqual(["Anyone", "Ben Ott", "Carl Brandt"]);
    expect(screen.queryByLabelText("Their shift")).toBeNull();
    expect(within(optionRow("clin-ben|-")).getByText("Week 47: 32.0 → 40.0 h")).toBeInTheDocument();
  });

  it("does not search again when only the callbacks change; a filter change searches once after the debounce", async () => {
    const { props, rerender } = renderDrawer();
    await settle();
    expect(props.onSearch).toHaveBeenCalledTimes(1);
    const fresh: SwapAssistantDrawerProps = {
      ...props,
      onSearch: vi.fn().mockResolvedValue(found(response)),
      onApply: vi.fn(),
      onUndo: vi.fn(),
      onLoadHistory: vi.fn(),
      onRevealKey: vi.fn(),
      onClose: vi.fn(),
    };
    rerender(<SwapAssistantDrawer {...fresh} />);
    await settle();
    expect(props.onSearch).toHaveBeenCalledTimes(1);
    expect(fresh.onSearch).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("With"), { target: { value: "clin-ben" } });
    await advance(150);
    expect(fresh.onSearch).not.toHaveBeenCalled();
    await settle();
    expect(fresh.onSearch).toHaveBeenCalledTimes(1);
    expect(fresh.onSearch).toHaveBeenCalledWith(expect.objectContaining({ partnerId: "clin-ben" }));
    expect(props.onSearch).toHaveBeenCalledTimes(1);
  });

  it("asks for a date before searching picked dates, and sends the picked ones", async () => {
    const { props } = renderDrawer();
    await settle();
    fireEvent.change(screen.getByLabelText("Their shift"), { target: { value: "dates" } });
    await settle();
    expect(props.onSearch).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Pick at least one date.")).toBeInTheDocument();
    expect(screen.getByText("Pick the dates of their shifts (up to 31).")).toBeInTheDocument();
    // 28 days from the Monday of X's week (16 Nov).
    expect(screen.getByRole("button", { name: "Mon 16 Nov" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByRole("button", { name: "Sun 13 Dec" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Wed 18 Nov" }));
    await settle();
    expect(screen.getByRole("button", { name: "Wed 18 Nov" })).toHaveAttribute("aria-pressed", "true");
    expect(props.onSearch).toHaveBeenLastCalledWith(expect.objectContaining({ range: "dates", dates: ["2026-11-18"] }));
  });

  it("shows a blocked target's fallback summary and reason, and no filters", async () => {
    const message = "Anna Weber is on vacation on Thu 19 Nov; this shift is hidden. Use Find cover on the open slot instead.";
    const blocked: SwapCandidatesResponse = {
      ...response,
      target: {
        ...target,
        unit: null,
        blocksOnDate: 0,
        startsAt: null,
        hoursUntilStart: null,
        blocked: { code: "vacation_hidden", message },
      },
      checks: [],
      best: [],
      possible: [],
      blocked: [],
      totals: { best: 0, possible: 0, blocked: 0 },
      checked: 0,
    };
    renderDrawer({ onSearch: vi.fn().mockResolvedValue(found(blocked)) });
    await settle();
    expect(screen.getByText("Anna Weber · Thu 19 Nov · Night duty")).toBeInTheDocument();
    expect(screen.getByText(message, { selector: "p" })).toHaveClass("text-rose-700");
    expect(screen.queryByLabelText("With")).toBeNull();
    expect(screen.queryByRole("group", { name: "Mode" })).toBeNull();
    expect(screen.queryByText(/Checked/)).toBeNull();
  });

  it("explains a blocked save and searches again on request", async () => {
    const onSearch = vi
      .fn()
      .mockRejectedValueOnce(new SwapSaveBlockedError("The calendar changed in another tab."))
      .mockResolvedValue(found(response));
    renderDrawer({ onSearch });
    await settle();
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(
      "The calendar changed in another tab. Use Retry saving or Reload saved calendar at the top of the page, then search again.",
    );
    fireEvent.click(within(alert).getByRole("button", { name: "Search again" }));
    await settle();
    expect(onSearch).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Best matches (1)")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reports a calendar changed during the search", async () => {
    const onSearch = vi.fn().mockRejectedValue(new SwapApiError("Changed.", 409, "state_changed", { revision: "r9" }));
    renderDrawer({ onSearch });
    await settle();
    expect(screen.getByRole("alert")).toHaveTextContent("The calendar changed while searching. Search again.");
  });

  it("marks the list stale when the plan changes, and refreshes it", async () => {
    const { props, rerender } = renderDrawer();
    await settle();
    expect(screen.queryByText("The plan changed since this list was made.")).toBeNull();
    rerender(<SwapAssistantDrawer {...props} planToken={{}} />);
    expect(screen.getByText("The plan changed since this list was made.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await settle();
    expect(props.onSearch).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("The plan changed since this list was made.")).toBeNull();
  });

  it("marks an answer stale when the plan changed while it was searched", async () => {
    const pending = deferred<SwapSearchResult>();
    const onSearch = vi.fn(() => pending.promise);
    const { props, rerender } = renderDrawer({ onSearch, planToken: { gen: 1 } });
    await advance(250);
    expect(onSearch).toHaveBeenCalledOnce();
    // An edit in the grid while the server still checks the options.
    rerender(<SwapAssistantDrawer {...props} planToken={{ gen: 2 }} />);
    await act(async () => pending.resolve(found({ ...response })));
    expect(screen.getByText("Best matches (1)")).toBeInTheDocument();
    expect(screen.getByText("The plan changed since this list was made.")).toBeInTheDocument();
  });

  it("does not mark an answer stale for a reload inside its search", async () => {
    const pending = deferred<SwapSearchResult>();
    const onSearch = vi.fn(() => pending.promise);
    const { props, rerender } = renderDrawer({ onSearch, planToken: { gen: 1 } });
    await advance(250);
    // The page hydrated the reloaded calendar before the answer, which was searched on it.
    rerender(<SwapAssistantDrawer {...props} planToken={{ gen: 2 }} />);
    await act(async () => pending.resolve(found({ ...response }, true)));
    expect(screen.getByText("Best matches (1)")).toBeInTheDocument();
    expect(screen.queryByText("The plan changed since this list was made.")).toBeNull();
    rerender(<SwapAssistantDrawer {...props} planToken={{ gen: 3 }} />);
    expect(screen.getByText("The plan changed since this list was made.")).toBeInTheDocument();
  });

  it("Search again drops the old error and shows the progress until the answer is in", async () => {
    const retry = deferred<SwapSearchResult>();
    const onSearch = vi.fn().mockRejectedValueOnce(new Error("Failed to fetch")).mockImplementationOnce(() => retry.promise);
    renderDrawer({ onSearch });
    await settle();
    const again = within(screen.getByRole("alert")).getByRole("button", { name: "Search again" });
    again.focus();
    fireEvent.click(again);
    await advance(250);
    expect(onSearch).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Checking options…")).toBeInTheDocument();
    // Its button is gone: focus goes to the heading, not to <body>.
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Find a swap" }));
    await act(async () => retry.resolve(found({ ...response })));
    expect(screen.getByText("Best matches (1)")).toBeInTheDocument();
  });

  it("keeps a blocking Whole day ticked and in place, so it can be unticked", async () => {
    const twoBlocks: SwapCandidatesResponse = { ...response, target: { ...target, blocksOnDate: 2 } };
    const dayStarted: SwapCandidatesResponse = {
      ...twoBlocks,
      target: { ...twoBlocks.target, wholeDay: true, blocked: { code: "started", message: "A shift of this day has already started." } },
      checks: [],
      best: [],
      possible: [],
      blocked: [],
      totals: { best: 0, possible: 0, blocked: 0 },
      checked: 0,
    };
    const onSearch = vi.fn(async (request: SwapCandidatesRequest) => found(request.wholeDay ? dayStarted : { ...twoBlocks }));
    renderDrawer({ onSearch });
    await settle();
    const wholeDay = screen.getByRole("checkbox", { name: "Whole day (2 blocks)" });
    wholeDay.focus();
    fireEvent.click(wholeDay);
    await settle();
    expect(screen.getByText("A shift of this day has already started.", { selector: "p" })).toHaveClass("text-rose-700");
    expect(screen.queryByRole("group", { name: "Mode" })).toBeNull();
    // The same box, still focused, explains the way back.
    expect(screen.getByRole("checkbox", { name: "Whole day (2 blocks)" })).toBe(wholeDay);
    expect(wholeDay).toBeChecked();
    expect(wholeDay).toHaveAccessibleDescription("Untick Whole day to search for this shift only.");
    expect(document.activeElement).toBe(wholeDay);
    fireEvent.click(wholeDay);
    await settle();
    expect(onSearch.mock.calls.map(([request]) => request.wholeDay)).toEqual([false, true, false]);
    expect(screen.getByText("Best matches (1)")).toBeInTheDocument();
    expect(wholeDay).not.toBeChecked();
    expect(screen.queryByText("Untick Whole day to search for this shift only.")).toBeNull();
  });

  it("describes each Preview button by its option's line", async () => {
    renderDrawer();
    await settle();
    expect(screen.getByRole("button", { name: "Preview swap with Carl Brandt" })).toHaveAccessibleDescription(
      "Wed 18 Nov · CT · 08:00–16:00 · Mitte",
    );
    expect(screen.getByRole("button", { name: "Preview swap with Ben Ott" })).toHaveAccessibleDescription(
      "Sat 21 Nov · CT · 08:00–16:00 · Mitte",
    );
  });

  it("keeps \"Not possible\" collapsed until opened; with nothing possible it shows the closest options", async () => {
    const { unmount } = renderDrawer();
    await settle();
    const toggle = screen.getByRole("button", { name: "Not possible (14)" });
    expect(screen.queryByText(julia.reason!.message)).toBeNull();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(julia.reason!.message)).toHaveClass("text-rose-700");
    expect(screen.getByText("Showing 1 of 14")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Preview swap with Julia Meier" })).toBeNull();
    unmount();

    const nothing = { ...response, best: [], possible: [], closest: [julia], totals: { best: 0, possible: 0, blocked: 14 } };
    renderDrawer({ onSearch: vi.fn().mockResolvedValue(found(nothing)) });
    await settle();
    expect(screen.getByText("Nobody can take this shift without breaking a rule.")).toBeInTheDocument();
    expect(screen.getByText("Closest options")).toBeInTheDocument();
    expect(screen.getByText(julia.reason!.message)).toBeInTheDocument();
  });

  it("names the chosen partner when there was nothing to check", async () => {
    const empty = { ...response, best: [], possible: [], blocked: [], totals: { best: 0, possible: 0, blocked: 0 }, checked: 0 };
    const onSearch = vi.fn().mockResolvedValue(found(empty));
    renderDrawer({ onSearch });
    await settle();
    expect(screen.getByText("No one to check.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("With"), { target: { value: "clin-ben" } });
    await settle();
    expect(screen.getByText("Ben Ott has no shift to swap in this range.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Hand over" }));
    await settle();
    expect(screen.getByText("Ben Ott can't take this shift here.")).toBeInTheDocument();
  });

  it("shows a hand-over's target notes once under the summary and beside the preview's checks, never in swap mode", async () => {
    const belowContract: SwapFinding = {
      code: "giver_below_contract",
      clinicianId: "clin-anna",
      message: "Anna Weber: week 47 drops to 28.0 h (contract 40 h).",
      short: "−12 h under contract",
    };
    const handover: SwapCandidatesResponse = {
      ...response,
      target: { ...target, mode: "handover" },
      targetFindings: [belowContract],
      best: [{ ...carl, key: "clin-carl|-", take: null, chips: [] }],
      possible: [],
      totals: { ...response.totals, possible: 0 },
    };
    const onSearch = vi.fn(async (request: SwapCandidatesRequest) =>
      found(request.mode === "handover" ? handover : { ...response }),
    );
    renderDrawer({ onSearch });
    await settle();
    expect(screen.getByText("Best matches (1)")).toBeInTheDocument();
    expect(screen.queryByText(belowContract.message)).toBeNull();

    fireEvent.click(within(screen.getByRole("group", { name: "Mode" })).getByRole("button", { name: "Hand over" }));
    await settle();
    // Once, for the target: no option carries it.
    expect(screen.getAllByText(belowContract.message)).toHaveLength(1);
    expect(screen.getByText(belowContract.message)).toHaveClass("text-amber-800");
    expect(screen.queryByText(belowContract.short)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Preview hand over to Carl Brandt" }));
    const checks = screen.getByRole("heading", { name: "Checks" }).closest("section") as HTMLElement;
    expect(within(checks).getByText("Qualified for both shifts")).toBeInTheDocument();
    expect(within(checks).getByText(belowContract.message)).toHaveClass("text-amber-800");

    // Back in swap mode the note goes at once, before the swap answer arrives.
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(within(screen.getByRole("group", { name: "Mode" })).getByRole("button", { name: "Swap" }));
    expect(screen.queryByText(belowContract.message)).toBeNull();
    await settle();
    expect(screen.queryByText(belowContract.message)).toBeNull();
    expect(onSearch.mock.calls.map(([request]) => request.mode)).toEqual(["swap", "handover", "swap"]);
  });
});

describe("SwapAssistantDrawer: preview", () => {
  it("lists weeks, checks, warnings, notes and Rest Day changes, and applies only when everything is confirmed", async () => {
    window.localStorage.setItem(APPROVER_KEY, "K. Berger");
    const { props } = await openBenPreview();
    expect(screen.getByRole("heading", { name: "Swap Anna Weber ⇄ Ben Ott" })).toBeInTheDocument();
    expect(screen.getByText("Gives Thu 19 Nov Night duty · takes Sat 21 Nov CT")).toBeInTheDocument();
    expect(screen.getByText("Gives Sat 21 Nov CT · takes Thu 19 Nov Night duty")).toBeInTheDocument();
    const benWeek = screen.getByText("Week 47: 40.0 → 44.0 h (limit 45.0 h)");
    expect(benWeek).toHaveAttribute("title", expect.stringContaining("Counted like the weekly-hours rule"));
    // Checks: a warning's check shows the warning, a pre-existing one is amber, the others pass.
    expect(screen.getAllByText(restWarning.message)).toHaveLength(2);
    expect(screen.queryByText("No new rest under 11 h between shifts")).toBeNull();
    expect(
      screen.getByText("No new week over contract + tolerance: already broken before this change, not made worse."),
    ).toBeInTheDocument();
    expect(screen.getByText("Qualified for both shifts")).toBeInTheDocument();
    expect(screen.getByText("Ben Ott: week 47 at 44.0 h (contract 40 h).")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Move Anna Weber's Rest Day on Fri 20 Nov to Ben Ott" })).toBeChecked();
    expect(screen.getByText("Anna Weber's Rest Day on Sat 21 Nov will be removed (works that day).")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /notice period/ })).toBeNull();

    const apply = screen.getByRole("button", { name: "Swap shifts" });
    expect(apply).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Ben Ott agreed to this swap" }));
    expect(apply).toBeDisabled();
    const acknowledge = screen.getByRole("checkbox", { name: "Acknowledge" });
    expect(acknowledge).toHaveAccessibleDescription(restWarning.message);
    fireEvent.click(acknowledge);
    expect(apply).toBeEnabled();

    expect(screen.getByLabelText("Approved by (optional)")).toHaveValue("K. Berger");
    fireEvent.change(screen.getByLabelText("Approved by (optional)"), { target: { value: " Dr. K. Berger " } });
    fireEvent.change(screen.getByLabelText("Note (optional)"), { target: { value: "Ben agreed by phone" } });
    expect(screen.getByText("19/280")).toBeInTheDocument();
    fireEvent.click(apply);
    await settle();
    expect(props.onApply).toHaveBeenCalledWith({
      mode: "swap",
      give: [{ rowId: "night-thu", dateISO: "2026-11-19", clinicianId: "clin-anna", fp: night.fp }],
      wholeDay: false,
      slot: null,
      partnerId: "clin-ben",
      take: [{ rowId: "ct-sat", dateISO: "2026-11-21", clinicianId: "clin-ben", fp: "480-960@loc-mitte#sec-ct" }],
      restDayMoves: [moveToBen],
      removeHidden: null,
      expectedRevision: "",
      consent: true,
      note: "Ben agreed by phone",
      approverName: "Dr. K. Berger",
      overrideNotice: false,
      acknowledgedWarnings: [restWarning.id],
    });
    expect(window.localStorage.getItem(APPROVER_KEY)).toBe("Dr. K. Berger");
  });

  it("sends only the ticked Rest Day moves", async () => {
    const { props } = await openBenPreview();
    fireEvent.click(screen.getByRole("checkbox", { name: "Move Anna Weber's Rest Day on Fri 20 Nov to Ben Ott" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Ben Ott agreed to this swap" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Acknowledge" }));
    fireEvent.click(screen.getByRole("button", { name: "Swap shifts" }));
    await settle();
    expect(props.onApply).toHaveBeenCalledWith(expect.objectContaining({ restDayMoves: [] }));
  });

  it("requires the notice override inside the notice period, counting from the earlier shift", async () => {
    const inside = { ...ben, insideNotice: true, takeHoursUntilStart: 10, warnings: [] };
    const { props } = await openBenPreview({
      onSearch: vi.fn().mockResolvedValue(found({ ...response, possible: [inside] })),
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Ben Ott agreed to this swap" }));
    const apply = screen.getByRole("button", { name: "Swap shifts" });
    expect(apply).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Starts in 10 h – apply inside the 48 h notice period" }));
    fireEvent.click(apply);
    await settle();
    expect(props.onApply).toHaveBeenCalledWith(expect.objectContaining({ overrideNotice: true }));
  });

  it("cover: the required hidden removal is ticked and locked, and sent", async () => {
    const { props } = renderDrawer({
      target: { kind: "slot", slot: { rowId: "ct-thu", dateISO: "2026-11-19" } },
      onSearch: vi.fn().mockResolvedValue(found(coverResponse)),
    });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Preview Ben Ott covering" }));
    expect(screen.getByRole("heading", { name: "Ben Ott covers CT" })).toBeInTheDocument();
    expect(screen.getByText("Takes Thu 19 Nov CT")).toBeInTheDocument();
    const hidden = screen.getByRole("checkbox", { name: "Remove Anna Weber's hidden shift (on vacation)" });
    expect(hidden).toBeChecked();
    expect(hidden).toBeDisabled();
    expect(screen.getByText("Needed: the slot would be overfilled otherwise.")).toBeInTheDocument();
    expect(screen.getByText("The shift will be locked so replanning keeps it.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Ben Ott agreed to take this shift" }));
    fireEvent.click(screen.getByRole("button", { name: "Assign" }));
    await settle();
    expect(props.onApply).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "cover",
        give: [],
        take: null,
        slot: { rowId: "ct-thu", dateISO: "2026-11-19", fp: "480-960@loc-mitte#sec-ct" },
        removeHidden: { clinicianId: "clin-anna" },
      }),
    );
  });

  it("names published weeks and goes back to the list", async () => {
    await openBenPreview({ publishedWeekStartISOs: ["2026-11-16"] });
    expect(
      screen.getByText("Week 47 is published: subscribed calendars update on their next refresh."),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByText("Best matches (1)")).toBeVisible();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Preview swap with Ben Ott" }));
  });
});

describe("SwapAssistantDrawer: refused apply", () => {
  const confirm = () => {
    fireEvent.click(screen.getByRole("checkbox", { name: "Ben Ott agreed to this swap" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Acknowledge" }));
    fireEvent.click(screen.getByRole("button", { name: "Swap shifts" }));
  };

  it("swap_invalid: names the reasons and searches again, keeping the preview while the option is valid", async () => {
    const invalid = new SwapApiError("This swap breaks a planning rule.", 409, "swap_invalid", {
      reasons: ["Ben Ott: week 47 would reach 48.0 h (limit 45.0 h)."],
    });
    const { props } = await openBenPreview({ onApply: vi.fn().mockRejectedValue(invalid) });
    confirm();
    await settle();
    expect(props.onSearch).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "This swap no longer works: Ben Ott: week 47 would reach 48.0 h (limit 45.0 h).",
    );
    expect(screen.getByRole("heading", { name: "Swap Anna Weber ⇄ Ben Ott" })).toBeInTheDocument();
  });

  it("warnings_unacknowledged: shows the new warnings unticked", async () => {
    const newer: SwapWarning = { ...restWarning, id: "rest:clin-ben:new", message: "Ben Ott: only 2.0 h rest between Fri 20 Nov 06:00 and Fri 20 Nov 08:00 (minimum 11 h)." };
    const refused = new SwapApiError("Check the working-time warnings first.", 409, "warnings_unacknowledged", {
      warnings: [newer],
    });
    const { props } = await openBenPreview({ onApply: vi.fn().mockRejectedValue(refused) });
    confirm();
    await settle();
    expect(props.onSearch).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert")).toHaveTextContent("New warnings came up. Check them and try again.");
    expect(screen.getAllByText(newer.message)).toHaveLength(2);
    expect(screen.queryByText(restWarning.message)).toBeNull();
    expect(screen.getByRole("checkbox", { name: "Acknowledge" })).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Swap shifts" })).toBeDisabled();
  });

  it("swap_stale: refreshes the list and returns to it when the option is gone", async () => {
    const stale = new SwapApiError("Ben Ott's shift on Sat 21 Nov changed. Refresh and try again.", 409, "swap_stale");
    const onSearch = vi
      .fn()
      .mockResolvedValueOnce(found(response))
      .mockResolvedValue(found({ ...response, possible: [], totals: { ...response.totals, possible: 0 } }));
    await openBenPreview({ onSearch, onApply: vi.fn().mockRejectedValue(stale) });
    confirm();
    await settle();
    expect(onSearch).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("heading", { name: "Swap Anna Weber ⇄ Ben Ott" })).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Ben Ott's shift on Sat 21 Nov changed. Refresh and try again. The list was refreshed.",
    );
    expect(screen.getByText("Best matches (1)")).toBeVisible();
  });

  it("notice_override_required: shows the notice checkbox; consent_required names the partner", async () => {
    const notice = new SwapApiError("This swap starts in 47 h, inside the 48 h notice period. Confirm the override to apply it.", 409, "notice_override_required", { hoursLeft: 47 });
    const onApply = vi.fn().mockRejectedValueOnce(notice).mockRejectedValueOnce(new SwapApiError("x", 400, "consent_required"));
    await openBenPreview({ onApply });
    confirm();
    await settle();
    expect(screen.getByRole("alert")).toHaveTextContent(notice.message);
    // The server's hours, newer than the list's 82.5 h.
    const override = screen.getByRole("checkbox", { name: "Starts in 47 h – apply inside the 48 h notice period" });
    expect(screen.getByRole("button", { name: "Swap shifts" })).toBeDisabled();
    fireEvent.click(override);
    fireEvent.click(screen.getByRole("button", { name: "Swap shifts" }));
    await settle();
    expect(screen.getByRole("alert")).toHaveTextContent("Confirm that Ben Ott agreed.");
  });

  it("says the list was refreshed only once it was; while it is checked again the apply waits", async () => {
    const stale = new SwapApiError("Ben Ott's shift on Sat 21 Nov changed. Refresh and try again.", 409, "swap_stale");
    const onApply = vi.fn().mockRejectedValue(stale);
    await openBenPreview({ onApply });
    confirm();
    await advance(0);
    expect(screen.getByRole("alert")).toHaveTextContent(/^Ben Ott's shift on Sat 21 Nov changed\. Refresh and try again\.$/);
    expect(shownText("Checking options…")).toHaveLength(1);
    const apply = screen.getByRole("button", { name: "Swap shifts" });
    expect(apply).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(apply);
    await settle();
    expect(onApply).toHaveBeenCalledOnce();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Ben Ott's shift on Sat 21 Nov changed. Refresh and try again. The list was refreshed.",
    );
    expect(shownText("Checking options…")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Swap shifts" })).not.toHaveAttribute("aria-disabled");
  });

  it("a refused apply whose new search fails returns to the list with the error and claims no refresh", async () => {
    const stale = new SwapApiError("Ben Ott's shift on Sat 21 Nov changed. Refresh and try again.", 409, "swap_stale");
    const onSearch = vi
      .fn()
      .mockResolvedValueOnce(found({ ...response }))
      .mockRejectedValue(new SwapSaveBlockedError("Failed to fetch"));
    const { props } = await openBenPreview({ onSearch, onApply: vi.fn().mockRejectedValue(stale) });
    confirm();
    await settle();
    expect(onSearch).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("heading", { name: "Swap Anna Weber ⇄ Ben Ott" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Swap shifts" })).toBeNull();
    expect(screen.getAllByRole("alert").map((alert) => alert.textContent)).toEqual([
      "Ben Ott's shift on Sat 21 Nov changed. Refresh and try again.",
      "Failed to fetch Use Retry saving or Reload saved calendar at the top of the page, then search again.Search again",
    ]);
    expect(props.onApply).toHaveBeenCalledOnce();
  });

  it("a failing Refresh in the preview returns to the list with the error", async () => {
    const gone = new SwapApiError("This shift no longer exists. Refresh the plan.", 409, "swap_stale");
    const onSearch = vi.fn().mockResolvedValueOnce(found({ ...response })).mockRejectedValue(gone);
    const { props, rerender } = await openBenPreview({ onSearch });
    rerender(<SwapAssistantDrawer {...props} planToken={{}} />);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await settle();
    expect(screen.queryByRole("heading", { name: "Swap Anna Weber ⇄ Ben Ott" })).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent("This shift no longer exists. Refresh the plan.Search again");
  });

  it("state_changed: says the calendar was reloaded only when the page or the new search reloaded it", async () => {
    const notReloaded = new SwapApiError("Changed.", 409, "state_changed", { revision: "r9", reloaded: false });
    const onSearch = vi
      .fn()
      .mockResolvedValueOnce(found({ ...response }))
      .mockResolvedValueOnce(found({ ...response }, true));
    const { unmount } = await openBenPreview({ onSearch, onApply: vi.fn().mockRejectedValue(notReloaded) });
    confirm();
    await advance(0);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The calendar changed in another tab. Reload the page, then check the options again.",
    );
    await settle();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The calendar changed in another tab. It was reloaded; check the options again.",
    );
    expect(screen.getByRole("heading", { name: "Swap Anna Weber ⇄ Ben Ott" })).toBeInTheDocument();
    unmount();

    const reloaded = new SwapApiError("Changed.", 409, "state_changed", { revision: "r9", reloaded: true });
    await openBenPreview({ onApply: vi.fn().mockRejectedValue(reloaded) });
    confirm();
    await advance(0);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The calendar changed in another tab. It was reloaded; check the options again.",
    );
  });
});

describe("SwapAssistantDrawer: focus", () => {
  const newer: SwapWarning = { ...restWarning, id: "rest:clin-ben:new", message: "Ben Ott: only 2.0 h rest between Fri 20 Nov 06:00 and Fri 20 Nov 08:00 (minimum 11 h)." };
  const findHeading = () => screen.getByRole("heading", { name: "Find a swap" });

  it("applying keeps focus on the button and ignores clicks; when a refusal disables it, focus goes to the message", async () => {
    const refused = deferred<void>();
    const onApply = vi.fn(() => refused.promise);
    const { props } = await openBenPreview({ onApply });
    fireEvent.click(screen.getByRole("checkbox", { name: "Ben Ott agreed to this swap" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Acknowledge" }));
    const apply = screen.getByRole("button", { name: "Swap shifts" });
    apply.focus();
    fireEvent.click(apply);
    // Busy: aria-disabled, not disabled (a disabled focused button drops focus to <body>).
    expect(apply).toHaveTextContent("Applying…");
    expect(apply).toHaveAttribute("aria-disabled", "true");
    expect(apply).not.toBeDisabled();
    expect(document.activeElement).toBe(apply);
    fireEvent.click(apply);
    expect(onApply).toHaveBeenCalledOnce();

    const warned = new SwapApiError("Check the working-time warnings first.", 409, "warnings_unacknowledged", { warnings: [newer] });
    await act(async () => refused.reject(warned));
    await advance(0);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("New warnings came up. Check them and try again.");
    expect(apply).toBeDisabled();
    expect(document.activeElement).toBe(alert);
    fireEvent.keyDown(alert, { key: "Escape" });
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  // user-event clicks focus like a browser does. Real timers: Testing Library's
  // async wrapper waits on a timer that only Jest's fake timers would advance.
  it("closes on Escape after a click on the drawer's text, on desktop and phone", async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    const summary = "Anna Weber · Thu 19 Nov · Night duty 20:00 → 08:00 · 12.0 h";
    for (const isMobile of [false, true]) {
      const { props, unmount } = renderDrawer({ isMobile });
      await user.click(await screen.findByText(summary));
      expect(document.activeElement).toBe(screen.getByRole("dialog"));
      await user.keyboard("{Escape}");
      expect(props.onClose).toHaveBeenCalledOnce();
      unmount();
    }
  });

  it("History: focus stays on Undo while it runs and when it fails; after an undo it goes to the row", async () => {
    const refused = deferred<void>();
    const failing = renderDrawer({
      target: { kind: "history" },
      onLoadHistory: vi.fn().mockResolvedValue([record({})]),
      onUndo: vi.fn(() => refused.promise),
    });
    await settle();
    const undo = screen.getByRole("button", { name: UNDO_ANNA_BEN });
    undo.focus();
    fireEvent.click(undo);
    expect(undo).toHaveAccessibleName("Undoing swap of Anna Weber and Ben Ott (Thu 19 / Sat 21 Nov)");
    expect(undo).toHaveAttribute("aria-disabled", "true");
    expect(undo).not.toBeDisabled();
    fireEvent.click(undo);
    expect(failing.props.onUndo).toHaveBeenCalledOnce();
    await act(async () => refused.reject(new Error("The shifts changed after the swap. Edit them in the plan.")));
    await advance(0);
    expect(screen.getByRole("alert")).toHaveTextContent("The shifts changed after the swap. Edit them in the plan.");
    expect(document.activeElement).toBe(undo);
    failing.unmount();

    const onLoadHistory = vi
      .fn()
      .mockResolvedValueOnce([record({})])
      .mockResolvedValue([record({ status: "reverted", canUndo: false, revertedAt: "2026-11-12T10:50:00+00:00" })]);
    const { props, rerender } = renderDrawer({ target: { kind: "history" }, onLoadHistory });
    await settle();
    const again = screen.getByRole("button", { name: UNDO_ANNA_BEN });
    again.focus();
    fireEvent.click(again);
    await advance(0);
    // The page counts the undo: the history loads again, and the row has no Undo any more.
    rerender(<SwapAssistantDrawer {...props} historyToken={1} />);
    await settle();
    expect(screen.queryByRole("button", { name: /^Undo/ })).toBeNull();
    expect(document.activeElement).toBe(screen.getByText("Anna Weber ⇄ Ben Ott").closest("li"));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" });
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it("after Refresh the heading takes focus once the hint is gone", async () => {
    const { props, rerender } = renderDrawer();
    await settle();
    rerender(<SwapAssistantDrawer {...props} planToken={{}} />);
    const refreshButton = screen.getByRole("button", { name: "Refresh" });
    refreshButton.focus();
    fireEvent.click(refreshButton);
    await settle();
    expect(screen.queryByText("The plan changed since this list was made.")).toBeNull();
    expect(document.activeElement).toBe(findHeading());
  });

  it("a refused apply whose option is gone after the new search focuses the message above the list", async () => {
    const stale = new SwapApiError("Ben Ott's shift on Sat 21 Nov changed. Refresh and try again.", 409, "swap_stale");
    const onSearch = vi
      .fn()
      .mockResolvedValueOnce(found(response))
      .mockResolvedValue(found({ ...response, possible: [], totals: { ...response.totals, possible: 0 } }));
    await openBenPreview({ onSearch, onApply: vi.fn().mockRejectedValue(stale) });
    fireEvent.click(screen.getByRole("checkbox", { name: "Ben Ott agreed to this swap" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Acknowledge" }));
    const apply = screen.getByRole("button", { name: "Swap shifts" });
    apply.focus();
    fireEvent.click(apply);
    await settle();
    expect(screen.queryByRole("heading", { name: "Swap Anna Weber ⇄ Ben Ott" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("alert"));
  });

  it("keeps focus in the drawer when the phone sheet and the desktop drawer swap places", async () => {
    const { props, rerender } = renderDrawer({ isMobile: true });
    await settle();
    screen.getByRole("button", { name: "Close" }).focus();
    // The window grew past the phone width: a new panel element, new content.
    rerender(<SwapAssistantDrawer {...props} isMobile={false} />);
    await advance(0);
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-modal", "false");
    expect(document.activeElement).toBe(findHeading());
    rerender(<SwapAssistantDrawer {...props} isMobile />);
    await advance(0);
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-modal", "true");
    expect(screen.getByRole("dialog")).toContainElement(document.activeElement as HTMLElement);
  });

  it("does not pull focus back after a press outside the drawer", async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    const grid = document.createElement("div");
    grid.innerHTML = "<p>Mon 16 Nov</p><button type=\"button\">Lock</button>";
    document.body.append(grid);
    try {
      const { props, rerender } = renderDrawer();
      await screen.findByText("Best matches (1)");
      for (const outside of [grid.querySelector("p")!, grid.querySelector("button")!]) {
        rerender(<SwapAssistantDrawer {...props} planToken={{}} />);
        const refreshButton = screen.getByRole("button", { name: "Refresh" });
        refreshButton.focus();
        // The hint goes once the new answer is in; meanwhile the planner clicks in the grid.
        fireEvent.click(refreshButton);
        await user.click(outside);
        const focused = document.activeElement;
        expect(focused).toBe(outside instanceof HTMLButtonElement ? outside : document.body);
        await waitFor(() => expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull());
        expect(document.activeElement).toBe(focused);
      }
    } finally {
      grid.remove();
    }
  });
});

describe("SwapAssistantDrawer: shell", () => {
  it("phone: a modal sheet that closes on Escape inside it and restores the page scroll", async () => {
    document.body.style.overflow = "auto";
    const { props, unmount } = renderDrawer({ isMobile: true });
    await settle();
    expect(screen.getByRole("dialog", { name: "Find a swap" })).toHaveAttribute("aria-modal", "true");
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(props.onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("button", { name: "Close" }), { key: "Escape" });
    expect(props.onClose).toHaveBeenCalledOnce();
    unmount();
    expect(document.body.style.overflow).toBe("auto");
    document.body.style.overflow = "";
  });

  it("phone: Tab cycles inside the sheet", async () => {
    renderDrawer({ isMobile: true });
    await settle();
    const close = screen.getByRole("button", { name: "Close" });
    const buttons = within(screen.getByRole("dialog")).getAllByRole("button");
    const last = buttons[buttons.length - 1];
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
    // After a tap on its text the sheet itself has focus: Shift+Tab still stays inside.
    const sheet = screen.getByRole("dialog");
    sheet.focus();
    expect(document.activeElement).toBe(sheet);
    fireEvent.keyDown(sheet, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("phone: Tab from a History row after the last control stays in the sheet", async () => {
    // Focus lands on a row when its Undo is done; here the older row is undone already.
    const undone = { id: "swp-0", status: "reverted", canUndo: false, revertedAt: "2026-11-12T10:50:00+00:00" } as const;
    renderDrawer({ isMobile: true, onLoadHistory: vi.fn().mockResolvedValue([record({}), record(undone)]) });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    await settle();
    const [newer, older] = screen.getAllByText("Anna Weber ⇄ Ben Ott").map((title) => title.closest("li")!);
    expect(within(newer).getByRole("button", { name: /^Undo swap of / })).toBeInTheDocument();
    // Controls follow (the row's Undo) or come before: the browser's own Tab and Shift+Tab stay inside.
    newer.focus();
    fireEvent.keyDown(newer, { key: "Tab" });
    expect(document.activeElement).toBe(newer);
    older.focus();
    fireEvent.keyDown(older, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(older);
    // No control after the last row: Tab goes round to the first one.
    fireEvent.keyDown(older, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));
  });

  it("History tab: lists swaps, undoes one, marks undone ones", async () => {
    const records = [
      record({}),
      record({ id: "swp-0", status: "reverted", canUndo: false, revertedAt: "2026-11-12T10:50:00+00:00", note: null }),
      record({ id: "swp-old", kind: "handover", take: [], canUndo: false, undoBlockedReason: "Already started.", note: null }),
    ];
    const { props } = renderDrawer({ onLoadHistory: vi.fn().mockResolvedValue(records) });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    await settle();
    expect(props.onLoadHistory).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText("Anna Weber ⇄ Ben Ott")).toHaveLength(2);
    expect(screen.getByText("Anna Weber → Ben Ott")).toBeInTheDocument();
    expect(screen.getAllByText("Thu 19 Nov · Night duty 20:00 → 08:00")).toHaveLength(3);
    expect(screen.getByText("“Ben agreed by phone”")).toBeInTheDocument();
    expect(screen.getAllByText(/^Applied .* · approved by K\. Berger$/)).toHaveLength(3);
    expect(screen.getByText("Undone")).toBeInTheDocument();
    expect(screen.getByText("Already started.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: UNDO_ANNA_BEN }));
    await settle();
    expect(props.onUndo).toHaveBeenCalledWith("swp-1");
  });

  it("History: an undo error stays in its row", async () => {
    const onUndo = vi.fn().mockRejectedValue(new Error("The shifts changed after the swap. Edit them in the plan."));
    renderDrawer({ target: { kind: "history" }, onLoadHistory: vi.fn().mockResolvedValue([record({})]), onUndo });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: UNDO_ANNA_BEN }));
    await settle();
    expect(screen.getByRole("alert")).toHaveTextContent("The shifts changed after the swap. Edit them in the plan.");
  });

  it("a history target opens on History without tabs and without searching", async () => {
    const { props, rerender } = renderDrawer({
      target: { kind: "history" },
      onLoadHistory: vi.fn().mockResolvedValue([]),
    });
    await settle();
    expect(screen.getByRole("heading", { name: "Swap history" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Find" })).toBeNull();
    expect(screen.getByText("No swaps yet.")).toBeInTheDocument();
    expect(props.onSearch).not.toHaveBeenCalled();
    rerender(<SwapAssistantDrawer {...props} historyToken={1} />);
    await settle();
    expect(props.onLoadHistory).toHaveBeenCalledTimes(2);
  });

  it("outlines the target's pills, adds the hovered option's shift, reveals it, and cleans up", async () => {
    const { props, unmount } = renderDrawer();
    await settle();
    const styles = document.head.querySelectorAll("style[data-swap-highlight]");
    expect(styles).toHaveLength(1);
    const targetKey = CSS.escape("night-thu__2026-11-19__clin-anna");
    expect(styles[0].textContent).toContain(`[data-assignment-key="${targetKey}"]`);
    expect(styles[0].textContent).toContain(`[data-sheet-assignment-key="${targetKey}"]`);

    fireEvent.mouseEnter(optionRow(ben.key));
    const style = document.head.querySelector("style[data-swap-highlight]");
    expect(style?.textContent).toContain(`[data-assignment-key="${CSS.escape("ct-sat__2026-11-21__clin-ben")}"]`);
    expect(props.onRevealKey).not.toHaveBeenCalled();
    await advance(400);
    expect(props.onRevealKey).toHaveBeenCalledWith("ct-sat__2026-11-21__clin-ben");
    fireEvent.mouseLeave(optionRow(ben.key));
    expect(document.head.querySelector("style[data-swap-highlight]")?.textContent).not.toContain("clin-ben");

    unmount();
    expect(document.head.querySelector("style[data-swap-highlight]")).toBeNull();
  });
});

describe("SwapHistoryButton", () => {
  it("is pressed while the history is open and reports clicks", () => {
    const onClick = vi.fn();
    const { rerender } = render(<SwapHistoryButton pressed={false} onClick={onClick} />);
    const button = screen.getByRole("button", { name: "Swap history" });
    expect(button).toHaveAttribute("aria-pressed", "false");
    expect(button).toHaveAttribute("title", "Swap history");
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
    rerender(<SwapHistoryButton pressed onClick={onClick} />);
    expect(button).toHaveAttribute("aria-pressed", "true");
  });
});
