import { test, expect, type Locator, type Page, type Route } from "@playwright/test";
import { readFileSync } from "node:fs";
import type { AppState, Assignment } from "../src/api/client";
import type {
  SwapApplyRequest,
  SwapCandidatesRequest,
  SwapCandidatesResponse,
  SwapCheck,
  SwapItem,
  SwapMode,
  SwapOption,
  SwapRecord,
  SwapUnit,
} from "../src/lib/swaps/types";

// The swap assistant on the real UI with a mocked API (SPEC §6.5): find a
// swap from a pill, apply it and undo it from the toast; the S key; a refused
// apply (also far down the list: its message is shown where focus went); an
// apply that another tab's save refuses; what the page saves before a search
// or an apply; the modals that close the drawer; Reveal on hover; the phone
// sheet and its Tab trap; cover from the person list; the TopBar history and
// its Undo (focus stays in the drawer, as after a refused apply); and the
// touch layout of the ⇄ button next to the lock. The mocked server keeps one
// calendar and checks revisions like the real one.

const defaultState = JSON.parse(
  readFileSync(new URL("../backend/default_state.json", import.meta.url), "utf8"),
) as AppState;

const [FIRST, SECOND] = defaultState.clinicians.map((clinician) => clinician.id);
const NAME = Object.fromEntries(defaultState.clinicians.map((clinician) => [clinician.id, clinician.name]));
const LOCATION = defaultState.locations![0];

/** Slot id of a section on a day type in the default template. */
function slotId(dayType: string, sectionName: string): string {
  const template = defaultState.weeklyTemplate!;
  const sectionId = defaultState.rows.find((row) => row.name === sectionName)?.id;
  const location = template.locations[0];
  const slot = location.slots.find((candidate) => {
    const col = location.colBands.find((band) => band.id === candidate.colBandId);
    const block = template.blocks.find((item) => item.id === candidate.blockId);
    return col?.dayType === dayType && block?.sectionId === sectionId;
  });
  if (!slot) throw new Error(`No ${sectionName} slot on ${dayType}`);
  return slot.id;
}

const THU_CT = slotId("thu", "CT");
const FRI_MRI = slotId("fri", "MRI");
const WED_CT = slotId("wed", "CT");
const WED_MRI = slotId("wed", "MRI");
// Monday 07:00 in Berlin: the page opens on 5–11 Jan, every shift starts > 48 h later.
const NOW = "2026-01-05T06:00:00Z";

// --- Calendar states -------------------------------------------------------

const assignment = (
  id: string,
  rowId: string,
  dateISO: string,
  clinicianId: string,
  extra: Partial<Assignment> = {},
): Assignment => ({ id, rowId, dateISO, clinicianId, source: "manual", ...extra });

/** Galileo on Thu CT, Leonardo on Fri MRI; Wed CT stays open. */
function calendarState(leonardoSource: "manual" | "solver" = "manual"): AppState {
  const state = structuredClone(defaultState);
  state.assignments = [
    assignment("galileo-thu", THU_CT, "2026-01-08", FIRST),
    assignment("leonardo-fri", FRI_MRI, "2026-01-09", SECOND, { source: leonardoSource }),
  ];
  return state;
}

type Shift = Pick<Assignment, "rowId" | "dateISO" | "clinicianId">;
const keyOf = (shift: Shift) => `${shift.rowId}__${shift.dateISO}__${shift.clinicianId}`;
const GALILEO_WED: Shift = { rowId: WED_MRI, dateISO: "2026-01-07", clinicianId: FIRST };

/** The calendar with a third shift that no swap moves: Galileo on Wed MRI. */
function calendarWithGalileoWed(): AppState {
  const state = calendarState();
  state.assignments.push(assignment("galileo-wed", WED_MRI, "2026-01-07", FIRST));
  return state;
}

/** The shifts a swap takes from their holders, and the locked ones it gives in their place. */
function swapChanges(mode: SwapMode): { taken: Assignment[]; given: Assignment[] } {
  const [galileoThu, leonardoFri] = calendarState().assignments;
  const locked = { locked: true } as const;
  const leonardoThu = assignment("swap-1-a", THU_CT, "2026-01-08", SECOND, locked);
  if (mode === "swap") {
    const galileoFri = assignment("swap-1-b", FRI_MRI, "2026-01-09", FIRST, locked);
    return { taken: [galileoThu, leonardoFri], given: [leonardoThu, galileoFri] };
  }
  if (mode === "handover") return { taken: [galileoThu], given: [leonardoThu] };
  return { taken: [], given: [assignment("swap-1-a", WED_CT, "2026-01-07", SECOND, locked)] };
}

/** The server's calendar after it applied a swap: every other saved edit stays. */
function withSwap(saved: AppState, mode: SwapMode): AppState {
  const { taken, given } = swapChanges(mode);
  const gone = new Set(taken.map(keyOf));
  return { ...saved, assignments: [...saved.assignments.filter((item) => !gone.has(keyOf(item))), ...given] };
}

/** The server's calendar after it undid that swap: the shifts are back with their holders. */
function withoutSwap(saved: AppState, mode: SwapMode): AppState {
  const { taken, given } = swapChanges(mode);
  const gone = new Set(given.map(keyOf));
  return { ...saved, assignments: [...saved.assignments.filter((item) => !gone.has(keyOf(item))), ...taken] };
}

/** Who holds a slot on a day in a calendar. */
const holdersOf = (state: AppState, rowId: string, dateISO: string) =>
  state.assignments.filter((item) => item.rowId === rowId && item.dateISO === dateISO).map((item) => item.clinicianId);

/** A shift's `locked` flag in a calendar (undefined: the default of its source). */
const lockedIn = (state: AppState, shift: Shift) =>
  state.assignments.find((item) => keyOf(item) === keyOf(shift))?.locked;

// --- Swap API fixtures (SPEC §3) --------------------------------------------

function sectionIdOf(name: string): string {
  return defaultState.rows.find((row) => row.name === name)!.id;
}

/** A 08:00–12:00 shift (the template's time for all three slots). */
function shiftItem(rowId: string, dateISO: string, sectionName: string, holder: string | null): SwapItem {
  return {
    assignmentId: holder === FIRST ? "galileo-thu" : holder === SECOND ? "leonardo-fri" : null,
    rowId,
    dateISO,
    clinicianId: holder,
    sectionId: sectionIdOf(sectionName),
    sectionName,
    slotLabel: null,
    locationId: LOCATION.id,
    locationName: LOCATION.name,
    start: `${dateISO}T08:00`,
    end: `${dateISO}T12:00`,
    minutes: 240,
    fp: `480-720@${LOCATION.id}#${sectionIdOf(sectionName)}`,
  };
}

const GALILEO_THU = shiftItem(THU_CT, "2026-01-08", "CT", FIRST);
const LEONARDO_FRI = shiftItem(FRI_MRI, "2026-01-09", "MRI", SECOND);
const OPEN_WED = shiftItem(WED_CT, "2026-01-07", "CT", null);

function unitOf(item: SwapItem): SwapUnit {
  return {
    clinicianId: item.clinicianId,
    startDateISO: item.dateISO,
    start: item.start,
    end: item.end,
    minutes: item.minutes,
    kind: "shift",
    overnight: false,
    blockCount: 1,
    primarySectionName: item.sectionName,
    items: [item],
  };
}

const CHECKS: SwapCheck[] = [
  { code: "qualification", label: "Qualified for both shifts" },
  { code: "vacation", label: "No shift moved onto a vacation day" },
  { code: "overlap", label: "No new overlapping shifts" },
  { code: "weekly_hours", label: "No new week over contract + tolerance" },
  { code: "rest", label: "No new rest under 11 h between shifts" },
];

const week = (beforeMinutes: number, afterMinutes: number) => ({
  isoYear: 2026,
  isoWeek: 2,
  weekStartISO: "2026-01-05",
  beforeMinutes,
  afterMinutes,
  contractMinutes: 2400,
  limitMinutes: 2700,
});

function leonardoOption(mode: SwapMode): SwapOption {
  const take = mode === "swap" ? unitOf(LEONARDO_FRI) : null;
  const giverHours = { clinicianId: FIRST, name: NAME[FIRST], weeks: [week(240, mode === "swap" ? 240 : 0)] };
  const takerHours = { clinicianId: SECOND, name: NAME[SECOND], weeks: [week(240, mode === "swap" ? 240 : 480)] };
  return {
    key: `${SECOND}|${take ? `${FRI_MRI}@2026-01-09` : "-"}`,
    partnerId: SECOND,
    partnerName: NAME[SECOND],
    take,
    group: "best",
    chips:
      mode === "swap"
        ? [
            { code: "same_week", label: "Same week", tone: "neutral" },
            { code: "hours_even", label: "Hours even", tone: "neutral" },
          ]
        : [],
    reason: null,
    blockerCount: 0,
    warnings: [],
    findings: [],
    hours: mode === "cover" ? [takerHours] : [giverHours, takerHours],
    restDayMoves: [],
    restDayRemovals: [],
    hiddenRemoval: null,
    insideNotice: false,
    takeHoursUntilStart: take ? 97 : null,
    preexisting: [],
  };
}

function candidates(request: SwapCandidatesRequest, revision: string): SwapCandidatesResponse {
  const cover = request.mode === "cover";
  const unit = unitOf(cover ? OPEN_WED : GALILEO_THU);
  return {
    revision,
    target: {
      mode: request.mode,
      holderId: cover ? null : FIRST,
      holderName: cover ? null : NAME[FIRST],
      dateISO: unit.startDateISO,
      sectionName: unit.primarySectionName,
      unit,
      blocksOnDate: 1,
      wholeDay: false,
      startsAt: `${unit.start}+01:00`,
      hoursUntilStart: cover ? 49 : 73,
      insideNotice: false,
      noticeHours: 48,
      timeZone: "Europe/Berlin",
      blocked: null,
      openCount: cover ? 1 : null,
      hiddenHolder: null,
      excludedPartnerIds: cover ? [] : [FIRST],
    },
    checks: CHECKS,
    targetFindings: [],
    best: [leonardoOption(request.mode)],
    possible: [],
    blocked: [],
    closest: [],
    totals: { best: 1, possible: 0, blocked: 0 },
    checked: 1,
    truncated: false,
  };
}

const recordItem = (item: SwapItem) => ({
  rowId: item.rowId,
  dateISO: item.dateISO,
  sectionName: item.sectionName,
  start: item.start,
  end: item.end,
});

function swapRecord(mode: SwapMode, status: "applied" | "reverted"): SwapRecord {
  return {
    id: "swap-1",
    kind: mode,
    status,
    requesterId: mode === "cover" ? null : FIRST,
    requesterName: mode === "cover" ? null : NAME[FIRST],
    partnerId: SECOND,
    partnerName: NAME[SECOND],
    give: [recordItem(mode === "cover" ? OPEN_WED : GALILEO_THU)],
    take: mode === "swap" ? [recordItem(LEONARDO_FRI)] : [],
    restDayMoves: [],
    restDaysRemoved: [],
    hiddenRemoved: null,
    note: null,
    approverName: null,
    consent: "confirmed_by_planner",
    noticeOverride: false,
    acknowledgedWarnings: [],
    createdAt: NOW,
    appliedAt: NOW,
    revertedAt: status === "reverted" ? NOW : null,
    canUndo: status === "applied",
    undoBlockedReason: null,
  };
}

// --- Page setup ---------------------------------------------------------------

/** A POST /v1/state and the revision the server saved it as; null: refused (409 state_changed). */
type StatePost = { body: AppState; revision: string | null };

/**
 * Opens the team plan on a mocked server that keeps one calendar. As on the
 * real one, a save names the revision it replaces and is refused when the
 * calendar was saved since. `clock: "manual"` installs fake page timers
 * (page.clock) instead of only fixing the date.
 */
async function openCalendar(page: Page, state: AppState, options: { clock?: "manual" } = {}) {
  let current = { ...state, revision: "r0" } as AppState;
  let saves = 0;
  const statePosts: StatePost[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  if (options.clock === "manual") await page.clock.install({ time: new Date(NOW) });
  else await page.clock.setFixedTime(new Date(NOW));
  await page.addInitScript(() => localStorage.setItem("authToken", "test-token"));
  await page.route("**/auth/me", (route) =>
    route.fulfill({ json: { username: "test", role: "user", active: true } }),
  );
  await page.route("**/v1/**", (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/v1/state")) {
      if (request.method() === "POST") {
        const body = request.postDataJSON() as AppState;
        if (body.revision !== current.revision) {
          statePosts.push({ body, revision: null });
          const message = "The calendar changed in another tab or operation. Your changes were not saved.";
          return route.fulfill({ status: 409, json: { detail: { code: "state_changed", message } } });
        }
        saves += 1;
        current = { ...body, revision: `r${saves}` };
        statePosts.push({ body, revision: current.revision ?? null });
      }
      return route.fulfill({ json: current });
    }
    if (path.endsWith("/v1/me/preferences")) return route.fulfill({ json: {} });
    if (path.endsWith("/solve/runs")) return route.fulfill({ json: { runs: [] } });
    if (path.endsWith("/agent/settings")) {
      return route.fulfill({ json: { effective_model: "mock", budget_usd: 5, remaining_usd: 5 } });
    }
    return route.fulfill({ json: { enabled: false } });
  });
  await page.goto("/");
  await expect(page.locator('[data-schedule-grid="true"]')).toBeVisible();
  /** Another tab saves the calendar: the revision this page holds goes stale. */
  const saveElsewhere = () => {
    current = { ...current, revision: "r-other" };
  };
  /** An apply or undo changed the server's calendar: it now holds `next` as `revision`. */
  const commit = (next: AppState, revision: string) => {
    current = { ...next, revision };
    return current;
  };
  return { state: () => current, statePosts, errors, saveElsewhere, commit };
}

type Calendar = Awaited<ReturnType<typeof openCalendar>>;

/** Waits for the page's next save after its first `count`; the server must take it. */
async function nextSave(api: Calendar, count: number): Promise<AppState> {
  await expect.poll(() => api.statePosts.length).toBeGreaterThan(count);
  const post = api.statePosts[count];
  expect(post.revision, "the server refused the save").not.toBeNull();
  return post.body;
}

/**
 * The swap endpoints. Registered after openCalendar: Playwright tries the
 * newest matching route first, and openCalendar's catch-all for /v1/ would
 * otherwise answer them. As on the server, each checks the revision the page
 * sends against the calendar it holds; apply and undo change that calendar.
 */
async function mockSwapApi(page: Page, api: Calendar, refuseApply?: object) {
  // `savedRevision`: the revision the server held; `statePosts`: how many
  // states the page had posted by then.
  const calls = {
    candidates: [] as { body: SwapCandidatesRequest; statePosts: number }[],
    apply: [] as { body: SwapApplyRequest; savedRevision: string | null | undefined; statePosts: number }[],
    undo: [] as {
      path: string;
      body: { expectedRevision: string };
      savedRevision: string | null | undefined;
      statePosts: number;
    }[],
    history: 0,
  };
  const pathIs = (suffix: RegExp) => (url: URL) => suffix.test(url.pathname);
  const stateChanged = (route: Route) => {
    const detail = { code: "state_changed", message: "The calendar changed.", revision: api.state().revision };
    return route.fulfill({ status: 409, json: { detail } });
  };
  await page.route(pathIs(/\/v1\/swaps\/candidates$/), (route) => {
    const body = route.request().postDataJSON() as SwapCandidatesRequest;
    calls.candidates.push({ body, statePosts: api.statePosts.length });
    if (body.expectedRevision && body.expectedRevision !== api.state().revision) return stateChanged(route);
    return route.fulfill({ json: candidates(body, api.state().revision ?? "r0") });
  });
  let appliedMode: SwapMode = "swap";
  // The history's one swap; as on the server, undone ones can no longer be undone.
  let status: "applied" | "reverted" = "applied";
  await page.route(pathIs(/\/v1\/swaps\/apply$/), (route) => {
    const body = route.request().postDataJSON() as SwapApplyRequest;
    calls.apply.push({ body, savedRevision: api.state().revision, statePosts: api.statePosts.length });
    if (body.expectedRevision !== api.state().revision) return stateChanged(route);
    if (refuseApply) return route.fulfill({ status: 409, json: { detail: refuseApply } });
    appliedMode = body.mode;
    status = "applied";
    const state = api.commit(withSwap(api.state(), body.mode), "rS");
    return route.fulfill({ json: { swap: swapRecord(body.mode, "applied"), state } });
  });
  await page.route(pathIs(/\/v1\/swaps\/[^/]+\/undo$/), (route) => {
    const body = route.request().postDataJSON() as { expectedRevision: string };
    calls.undo.push({
      path: new URL(route.request().url()).pathname,
      body,
      savedRevision: api.state().revision,
      statePosts: api.statePosts.length,
    });
    if (body.expectedRevision !== api.state().revision) return stateChanged(route);
    status = "reverted";
    const state = api.commit(withoutSwap(api.state(), appliedMode), "rU");
    return route.fulfill({ json: { swap: swapRecord(appliedMode, "reverted"), state } });
  });
  await page.route(pathIs(/\/v1\/swaps\/history$/), (route) => {
    calls.history += 1;
    return route.fulfill({ json: { swaps: [swapRecord(appliedMode, status)] } });
  });
  return calls;
}

const pillOf = (page: Page, rowId: string, dateISO: string, clinicianId: string) =>
  page.locator(`[data-assignment-key="${rowId}__${dateISO}__${clinicianId}"]`);
const galileoPill = (page: Page) => pillOf(page, THU_CT, "2026-01-08", FIRST);
/** Anchored: a cell's accessible name contains its pills' button labels. */
const findSwapIn = (pill: Locator) => pill.getByRole("button", { name: /^Find swap for / });
const drawer = (page: Page) => page.getByRole("dialog");
/** Chromium moves focus to <body> when it disables or removes the focused button. */
const focusInDrawer = (page: Page) => page.evaluate(() => document.activeElement?.closest('[role="dialog"]') != null);

/** Opens the drawer from Galileo's pill the way a mouse does: point at it, click ⇄. */
async function findSwapForGalileo(page: Page) {
  await galileoPill(page).hover();
  await findSwapIn(galileoPill(page)).click();
}

test.use({ timezoneId: "Europe/Berlin", viewport: { width: 1280, height: 800 } });

test("find a swap from a pill, apply it and undo it from the toast", async ({ page }) => {
  const api = await openCalendar(page, calendarState());
  const calls = await mockSwapApi(page, api);

  await findSwapForGalileo(page);
  await expect(page.getByRole("heading", { name: "Find a swap" })).toBeVisible();
  await expect(page.getByText("Best matches (1)")).toBeVisible();
  expect(calls.candidates.map(({ body }) => body)).toEqual([
    expect.objectContaining({
      mode: "swap",
      assignment: { assignmentId: "galileo-thu", rowId: THU_CT, dateISO: "2026-01-08", clinicianId: FIRST },
      range: "fourWeeks",
    }),
  ]);

  await page.getByRole("button", { name: `Preview swap with ${NAME[SECOND]}` }).click();
  const apply = page.getByRole("button", { name: "Swap shifts" });
  await expect(apply).toBeDisabled();
  await page.getByLabel(`${NAME[SECOND]} agreed to this swap`).check();
  await apply.click();

  await expect.poll(() => calls.apply.length).toBe(1);
  const [{ body, savedRevision }] = calls.apply;
  expect(body).toMatchObject({
    mode: "swap",
    consent: true,
    partnerId: SECOND,
    give: [{ rowId: THU_CT, dateISO: "2026-01-08", clinicianId: FIRST, fp: GALILEO_THU.fp }],
    take: [{ rowId: FRI_MRI, dateISO: "2026-01-09", clinicianId: SECOND, fp: LEONARDO_FRI.fp }],
  });
  // The apply carries the revision of the calendar the page last saved.
  expect(api.statePosts.length).toBeGreaterThan(0);
  expect(body.expectedRevision).toBe(savedRevision);

  const leonardoThu = pillOf(page, THU_CT, "2026-01-08", SECOND);
  await expect(leonardoThu).toBeVisible();
  await expect(drawer(page)).toBeHidden();
  // Focus moves to the shift's new holder.
  await expect(findSwapIn(leonardoThu)).toBeFocused();
  await expect(page.getByText(`Swapped: ${NAME[FIRST]} ⇄ ${NAME[SECOND]} (Thu 8 / Fri 9 Jan)`)).toBeVisible();
  // The page took the applied calendar's revision: its next autosave saves the swap.
  const afterApply = await nextSave(api, calls.apply[0].statePosts);
  expect(holdersOf(afterApply, THU_CT, "2026-01-08")).toEqual([SECOND]);
  expect(holdersOf(afterApply, FRI_MRI, "2026-01-09")).toEqual([FIRST]);

  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect.poll(() => calls.undo.length).toBe(1);
  expect(calls.undo[0].path).toMatch(/\/v1\/swaps\/swap-1\/undo$/);
  expect(calls.undo[0].body.expectedRevision).toBe(calls.undo[0].savedRevision);
  await expect(galileoPill(page)).toBeVisible();
  await expect(leonardoThu).toHaveCount(0);
  await expect(page.getByText(`Swap undone: ${NAME[FIRST]} ⇄ ${NAME[SECOND]} (Thu 8 / Fri 9 Jan)`)).toBeVisible();
  // ...and after the undo the restored calendar.
  const afterUndo = await nextSave(api, calls.undo[0].statePosts);
  expect(holdersOf(afterUndo, THU_CT, "2026-01-08")).toEqual([FIRST]);
  expect(holdersOf(afterUndo, FRI_MRI, "2026-01-09")).toEqual([SECOND]);
  expect(api.statePosts.filter((post) => post.revision === null)).toEqual([]);
  await expect(page.getByRole("button", { name: "Retry saving" })).toHaveCount(0);
  expect(api.errors).toEqual([]);
});

test("S on a pill's lock opens the drawer; Escape closes it and focus returns", async ({ page }) => {
  const api = await openCalendar(page, calendarState());
  await mockSwapApi(page, api);
  const lock = galileoPill(page).getByRole("button", { name: /^Lock assignment for/ });

  await lock.focus();
  await page.keyboard.press("s");
  const heading = page.getByRole("heading", { name: "Find a swap" });
  await expect(heading).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(drawer(page)).toBeHidden();
  await expect(lock).toBeFocused();
  expect(api.errors).toEqual([]);
});

test("a refused apply shows the reasons and searches again", async ({ page }) => {
  const api = await openCalendar(page, calendarState());
  const reason = `${NAME[SECOND]}: week 2 would reach 48.0 h (limit 45.0 h).`;
  const calls = await mockSwapApi(page, api, {
    code: "swap_invalid",
    message: `This swap breaks a planning rule: ${reason}`,
    violations: [],
    reasons: [reason],
  });

  await findSwapForGalileo(page);
  await page.getByRole("button", { name: `Preview swap with ${NAME[SECOND]}` }).click();
  await page.getByLabel(`${NAME[SECOND]} agreed to this swap`).check();
  await page.getByRole("button", { name: "Swap shifts" }).click();

  await expect(drawer(page).getByRole("alert")).toHaveText(`This swap no longer works: ${reason}`);
  await expect(page.getByRole("heading", { name: "Find a swap" })).toBeVisible();
  await expect.poll(() => calls.candidates.length).toBe(2);
  // Focus never left the drawer while it applied and searched again, so Escape still closes it.
  await expect.poll(() => focusInDrawer(page)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(drawer(page)).toBeHidden();
  expect(api.errors).toEqual([]);
});

test("another tab's save refuses a clean screen's apply: reload, search again, no save first", async ({ page }) => {
  const api = await openCalendar(page, calendarState());
  const calls = await mockSwapApi(page, api);

  await findSwapForGalileo(page);
  await page.getByRole("button", { name: `Preview swap with ${NAME[SECOND]}` }).click();
  await page.getByLabel(`${NAME[SECOND]} agreed to this swap`).check();
  // Nothing is left to save once no state was posted for longer than the autosave waits.
  let posts = -1;
  const settled = () => {
    const quiet = api.statePosts.length === posts;
    posts = api.statePosts.length;
    return quiet;
  };
  await expect.poll(settled, { intervals: [700] }).toBe(true);
  const saved = api.state().revision;
  api.saveElsewhere();

  const apply = page.getByRole("button", { name: "Swap shifts" });
  await apply.click();
  await expect(drawer(page).getByRole("alert")).toHaveText(
    "The calendar changed in another tab. It was reloaded; check the options again.",
  );
  // No save before the apply: it went out against the revision the page had saved.
  expect(calls.apply[0]).toMatchObject({ body: { expectedRevision: saved }, statePosts: posts });
  await expect.poll(() => calls.candidates.length).toBe(2);
  await expect(page.getByRole("heading", { name: `Swap ${NAME[FIRST]} ⇄ ${NAME[SECOND]}` })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reload saved calendar" })).toHaveCount(0);

  // The reloaded calendar carries the other tab's revision, so the next apply goes through.
  await page.getByLabel(`${NAME[SECOND]} agreed to this swap`).check();
  await apply.click();
  await expect(page.getByText(`Swapped: ${NAME[FIRST]} ⇄ ${NAME[SECOND]} (Thu 8 / Fri 9 Jan)`)).toBeVisible();
  expect(calls.apply[1].body.expectedRevision).toBe(calls.apply[1].savedRevision);
  expect(api.errors).toEqual([]);
});

test.describe("saving before a search or an apply", () => {
  /**
   * Opens the calendar with fake page timers and lets the load's autosave
   * land. From then on the clock only moves when the test moves it, so an
   * edit stays inside the autosave's 500 ms window.
   */
  async function openPaused(page: Page, state: AppState) {
    const api = await openCalendar(page, state, { clock: "manual" });
    const calls = await mockSwapApi(page, api);
    // The grid shows the built-in calendar until the mocked one has loaded.
    await expect(galileoPill(page)).toBeVisible();
    await page.clock.pauseAt(new Date(Date.parse(NOW) + 60_000));
    await expect
      .poll(async () => {
        await page.clock.runFor(600);
        return api.statePosts.length;
      })
      .toBeGreaterThan(0);
    await nextSave(api, 0);
    return { api, calls };
  }
  /** Past the drawer's 200 ms search debounce, short of the 500 ms autosave. */
  const startSearch = (page: Page) => page.clock.runFor(250);
  const toggleLock = async (pill: Locator) => {
    await pill.hover();
    await pill.getByRole("button", { name: /^Lock assignment for/ }).click();
  };
  const LEONARDO_FRI_SHIFT: Shift = { rowId: FRI_MRI, dateISO: "2026-01-09", clinicianId: SECOND };

  test("a clean screen searches against its saved revision and saves nothing", async ({ page }) => {
    const { api, calls } = await openPaused(page, calendarState());
    const saved = api.statePosts.length;

    await findSwapForGalileo(page);
    await startSearch(page);
    await expect(page.getByText("Best matches (1)")).toBeVisible();
    expect(calls.candidates).toEqual([
      { body: expect.objectContaining({ expectedRevision: api.statePosts[saved - 1].revision }), statePosts: saved },
    ]);
    await page.clock.runFor(1_000);
    expect(api.statePosts).toHaveLength(saved);
    expect(api.errors).toEqual([]);
  });

  test("an edit inside the autosave window is saved before the search, which names that save", async ({ page }) => {
    const { api, calls } = await openPaused(page, calendarState());
    const saved = api.statePosts.length;
    const leonardoFri = pillOf(page, FRI_MRI, "2026-01-09", SECOND);
    await toggleLock(leonardoFri);
    await expect(leonardoFri).toHaveAttribute("data-locked", "false");

    await findSwapForGalileo(page);
    await startSearch(page);
    await expect(page.getByText("Best matches (1)")).toBeVisible();
    const [search] = calls.candidates;
    const saves = api.statePosts.slice(saved, search.statePosts);
    expect(saves.map((post) => lockedIn(post.body, LEONARDO_FRI_SHIFT))).toEqual([false]);
    expect(saves[0].revision).not.toBeNull();
    expect(search.body.expectedRevision).toBe(saves[0].revision);
    expect(api.errors).toEqual([]);
  });

  test("a lock toggled just before Swap shifts is saved first and survives the apply", async ({ page }) => {
    const { api, calls } = await openPaused(page, calendarWithGalileoWed());
    await findSwapForGalileo(page);
    await startSearch(page);
    await page.getByRole("button", { name: `Preview swap with ${NAME[SECOND]}` }).click();
    await page.getByLabel(`${NAME[SECOND]} agreed to this swap`).check();
    const saved = api.statePosts.length;
    // The desktop drawer is non-modal: a shift that the swap leaves alone is unlocked meanwhile.
    const galileoWed = pillOf(page, WED_MRI, "2026-01-07", FIRST);
    await toggleLock(galileoWed);
    await expect(galileoWed).toHaveAttribute("data-locked", "false");

    await page.getByRole("button", { name: "Swap shifts" }).click();
    await expect(page.getByText(`Swapped: ${NAME[FIRST]} ⇄ ${NAME[SECOND]} (Thu 8 / Fri 9 Jan)`)).toBeVisible();
    const [apply] = calls.apply;
    const saves = api.statePosts.slice(saved, apply.statePosts);
    expect(saves.map((post) => lockedIn(post.body, GALILEO_WED))).toEqual([false]);
    expect(saves[0].revision).not.toBeNull();
    expect(apply.body.expectedRevision).toBe(saves[0].revision);
    // The server swapped on top of the saved edit, and the page shows both.
    expect(lockedIn(api.state(), GALILEO_WED)).toBe(false);
    await expect(pillOf(page, THU_CT, "2026-01-08", SECOND)).toBeVisible();
    await expect(galileoWed).toHaveAttribute("data-locked", "false");

    await page.clock.runFor(1_000);
    const afterApply = await nextSave(api, apply.statePosts);
    expect(lockedIn(afterApply, GALILEO_WED)).toBe(false);
    expect(holdersOf(afterApply, THU_CT, "2026-01-08")).toEqual([SECOND]);
    await expect(page.getByRole("button", { name: "Retry saving" })).toHaveCount(0);
    expect(api.errors).toEqual([]);
  });
});

test("the Vacation Planner, Working Hours and Export close the drawer before they open", async ({ page }) => {
  const api = await openCalendar(page, calendarState());
  await mockSwapApi(page, api);
  const modals = [
    ["Open Vacation Planner", "Year planner for clinician vacations."],
    ["Open Working Hours", "Track working hours by week for all clinicians."],
    ["Open Export", "Choose a format and configure your export."],
  ] as const;
  for (const [opener, subtitle] of modals) {
    await findSwapForGalileo(page);
    await expect(drawer(page)).toBeVisible();
    // The desktop drawer is non-modal: the panels below the grid stay usable.
    await page.getByRole("button", { name: opener }).click();
    await expect(drawer(page)).toBeHidden();
    await expect(page.getByText(subtitle)).toBeVisible();
    // Nothing covers the modal's own Close button.
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    await expect(page.getByText(subtitle)).toBeHidden();
  }
  expect(api.errors).toEqual([]);
});

/**
 * Whether all of a pill or clinic sheet name shows: the topmost element just
 * inside both its ends is its own, not the drawer, a sticky label or nothing.
 */
function fullyShown(target: Locator): Promise<boolean> {
  return target.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const y = (rect.top + rect.bottom) / 2;
    return [rect.left + 2, rect.right - 2].every((x) => {
      const hit = document.elementFromPoint(x, y);
      return hit !== null && element.contains(hit);
    });
  });
}

/** Points at the drawer's first option; after 400 ms the page reveals its partner's shift. */
const hoverFirstOption = (page: Page) => drawer(page).locator("li[data-swap-option]").first().hover();

test("Reveal on hover finds a clinic sheet name and brings it out from under the row labels", async ({ page }) => {
  const state = calendarState();
  state.solverSettings = { ...state.solverSettings!, scheduleLayout: "clinicSheet" };
  const api = await openCalendar(page, state);
  await mockSwapApi(page, api);
  const sheetName = (rowId: string, dateISO: string, clinicianId: string) =>
    page.locator(`[data-sheet-assignment-key="${rowId}__${dateISO}__${clinicianId}"]`);
  const galileo = sheetName(THU_CT, "2026-01-08", FIRST);
  await galileo.hover();
  await findSwapIn(galileo).click();
  await expect(page.getByText("Best matches (1)")).toBeVisible();
  const leonardo = sheetName(FRI_MRI, "2026-01-09", SECOND);
  const sheetScroll = () => leonardo.evaluate((element) => element.closest(".calendar-scroll")!.scrollLeft);

  // Leonardo's Friday shows at the sheet's right edge while its cell runs on out of view: nothing moves.
  await leonardo.evaluate((element) => {
    const scroller = element.closest(".calendar-scroll")!;
    const left = element.getBoundingClientRect().right - (scroller.getBoundingClientRect().right - 10);
    scroller.scrollBy({ left, behavior: "instant" });
  });
  expect(await fullyShown(leonardo)).toBe(true);
  const shown = await sheetScroll();
  await hoverFirstOption(page);
  await page.waitForTimeout(1_000);
  expect(await sheetScroll()).toBe(shown);

  // Under the row labels it does not show: the reveal scrolls it out to their right.
  await drawer(page).getByRole("heading", { name: "Find a swap" }).hover();
  await leonardo.evaluate((element) => {
    const labels = element.closest("[data-schedule-grid]")!.firstElementChild!.getBoundingClientRect();
    const left = element.getBoundingClientRect().left - (labels.left + 20);
    element.closest(".calendar-scroll")!.scrollBy({ left, behavior: "instant" });
  });
  expect(await fullyShown(leonardo)).toBe(false);
  await hoverFirstOption(page);
  await expect.poll(() => fullyShown(leonardo)).toBe(true);
  expect(api.errors).toEqual([]);
});

test.describe("drawer over the grid", () => {
  // Below lg the desktop drawer overlays the grid instead of narrowing the page.
  test.use({ viewport: { width: 900, height: 800 } });

  test("Reveal on hover scrolls the partner's pill out from under the drawer", async ({ page }) => {
    const api = await openCalendar(page, calendarState());
    await mockSwapApi(page, api);
    const grid = page.locator('[data-schedule-grid="true"]');
    await expect(galileoPill(page)).toBeVisible();
    const before = (await grid.boundingBox())!;
    await findSwapForGalileo(page);
    await expect(page.getByText("Best matches (1)")).toBeVisible();
    // The grid keeps its place and width, so Leonardo's Friday lies under the drawer.
    const after = (await grid.boundingBox())!;
    expect([after.x, after.width]).toEqual([before.x, before.width]);
    const leonardoFri = pillOf(page, FRI_MRI, "2026-01-09", SECOND);
    expect(await fullyShown(leonardoFri)).toBe(false);

    await hoverFirstOption(page);
    await expect.poll(() => fullyShown(leonardoFri)).toBe(true);
    expect(api.errors).toEqual([]);
  });
});

test("Find cover… in an open slot's person list searches for cover", async ({ page }) => {
  const api = await openCalendar(page, calendarState());
  const calls = await mockSwapApi(page, api);

  await page
    .locator(`[data-schedule-cell="true"][data-row-id="${WED_CT}"][data-date-iso="2026-01-07"]`)
    .click();
  await page.getByRole("button", { name: "Find cover for this slot" }).click();
  await expect(page.getByRole("heading", { name: "Find cover" })).toBeVisible();
  await expect.poll(() => calls.candidates.length).toBe(1);
  expect(calls.candidates[0].body).toMatchObject({
    mode: "cover",
    assignment: null,
    slot: { rowId: WED_CT, dateISO: "2026-01-07" },
  });
  await expect(page.getByRole("button", { name: `Preview ${NAME[SECOND]} covering` })).toBeVisible();
  expect(api.errors).toEqual([]);
});

test("the TopBar opens and closes the swap history", async ({ page }) => {
  const api = await openCalendar(page, calendarState());
  const calls = await mockSwapApi(page, api);
  const historyButton = page.getByRole("button", { name: "Swap history" });

  await historyButton.click();
  await expect(page.getByRole("heading", { name: "Swap history" })).toBeVisible();
  await expect(historyButton).toHaveAttribute("aria-pressed", "true");
  await expect(drawer(page).getByText("Galileo Galilei ⇄ Leonardo DaVinci")).toBeVisible();
  // At least once: the dev server's StrictMode runs the load effect twice.
  expect(calls.history).toBeGreaterThan(0);
  await expect(drawer(page).getByRole("button", { name: "Find", exact: true })).toHaveCount(0);
  expect(calls.candidates).toEqual([]);

  await historyButton.click();
  await expect(drawer(page)).toBeHidden();
  await expect(historyButton).toHaveAttribute("aria-pressed", "false");
  expect(api.errors).toEqual([]);
});

test("Undo in the history keeps focus in the drawer, so Escape still closes it", async ({ page }) => {
  const api = await openCalendar(page, calendarState());
  const calls = await mockSwapApi(page, api);

  await page.getByRole("button", { name: "Swap history" }).click();
  await drawer(page).getByRole("button", { name: /^Undo swap of / }).click();
  await expect.poll(() => calls.undo.length).toBe(1);
  await expect(page.getByText(`Swap undone: ${NAME[FIRST]} ⇄ ${NAME[SECOND]} (Thu 8 / Fri 9 Jan)`)).toBeVisible();
  // The reloaded row is undone and has no Undo any more: focus went to the row.
  await expect(drawer(page).getByText("Undone", { exact: true })).toBeVisible();
  await expect(drawer(page).getByRole("button", { name: /^Undo swap of / })).toHaveCount(0);
  await expect.poll(() => focusInDrawer(page)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(drawer(page)).toBeHidden();
  expect(api.errors).toEqual([]);
});

test("a refused apply far down the list shows its message in view, where focus is", async ({ page }) => {
  const api = await openCalendar(page, calendarState());
  const message = `${NAME[SECOND]}'s shift on Mon 11 Jan changed. Refresh and try again.`;
  const calls = await mockSwapApi(page, api, { code: "swap_stale", message });
  // 14 options with the same partner on Fri 9 to Sun 11 Jan; the new search no longer has the last one.
  await page.route(/\/v1\/swaps\/candidates$/, (route) => {
    const body = route.request().postDataJSON() as SwapCandidatesRequest;
    calls.candidates.push({ body, statePosts: api.statePosts.length });
    const answer = candidates(body, api.state().revision ?? "r0");
    const option = answer.best[0];
    const options = Array.from({ length: 14 }, (_, k): SwapOption => {
      const dateISO = `2026-01-${String(9 + (k % 3)).padStart(2, "0")}`;
      const take = { ...option.take!, startDateISO: dateISO, items: option.take!.items.map((item) => ({ ...item, dateISO })) };
      return { ...option, key: `${SECOND}|option-${k}`, take, group: k < 3 ? "best" : "possible" };
    }).slice(0, calls.candidates.length > 1 ? 13 : 14);
    const best = options.filter((item) => item.group === "best");
    const possible = options.filter((item) => item.group === "possible");
    const totals = { best: best.length, possible: possible.length, blocked: 0 };
    return route.fulfill({ json: { ...answer, best, possible, totals, checked: options.length } });
  });

  await findSwapForGalileo(page);
  await expect(drawer(page).getByText("Also possible (11)")).toBeVisible();
  const lastOption = drawer(page).locator(`[data-swap-option="${SECOND}|option-13"]`);
  await lastOption.scrollIntoViewIfNeeded();
  await lastOption.locator("[data-swap-preview]").click();
  await page.getByLabel(`${NAME[SECOND]} agreed to this swap`).check();
  await page.getByRole("button", { name: "Swap shifts" }).click();

  // The option is gone after the new search: the list is back, from the top, with the refusal.
  await expect(drawer(page).getByText("Also possible (10)")).toBeVisible();
  const notice = drawer(page).getByRole("alert").filter({ hasText: message });
  await expect(notice).toBeInViewport({ ratio: 1 });
  await expect(notice).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(drawer(page)).toBeHidden();
  expect(api.errors).toEqual([]);
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("hand over in the sheet", async ({ page }) => {
    const api = await openCalendar(page, calendarState());
    const calls = await mockSwapApi(page, api);
    for (let day = 0; day < 3; day += 1) await page.getByRole("button", { name: "Next day" }).click();
    await expect(page.getByText("Thu, Jan 8")).toBeVisible();

    await findSwapForGalileo(page);
    const sheet = drawer(page);
    await expect(sheet).toHaveAttribute("aria-modal", "true");
    await sheet.getByRole("button", { name: "Hand over", exact: true }).click();
    await expect.poll(() => calls.candidates.map(({ body }) => body.mode)).toEqual(["swap", "handover"]);
    await sheet.getByRole("button", { name: `Preview hand over to ${NAME[SECOND]}` }).click();
    await sheet.getByLabel(`${NAME[SECOND]} agreed to take this shift`).check();
    await sheet.getByRole("button", { name: "Hand over", exact: true }).click();

    await expect(sheet).toBeHidden();
    await expect(page.getByText(`Handed over: ${NAME[FIRST]} → ${NAME[SECOND]} (Thu 8 Jan)`)).toBeVisible();
    expect(calls.apply.map(({ body }) => [body.mode, body.take])).toEqual([["handover", null]]);
    expect(api.errors).toEqual([]);
  });

  test("after Undo in the history, Tab and Shift+Tab stay in the sheet", async ({ page }) => {
    const api = await openCalendar(page, calendarState());
    const calls = await mockSwapApi(page, api);
    await page.getByRole("button", { name: "Swap history" }).click();
    const sheet = drawer(page);
    await sheet.getByRole("button", { name: /^Undo swap of / }).focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => calls.undo.length).toBe(1);
    // The undone row has no Undo any more; focus went to the row, after the sheet's last control.
    await expect(sheet.getByText("Undone", { exact: true })).toBeVisible();
    await expect(sheet.getByRole("button", { name: /^Undo swap of / })).toHaveCount(0);
    await expect.poll(() => focusInDrawer(page)).toBe(true);
    for (const key of ["Tab", "Tab", "Shift+Tab", "Shift+Tab", "Shift+Tab"]) {
      await page.keyboard.press(key);
      expect(await focusInDrawer(page), `focus after ${key}`).toBe(true);
    }
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    expect(api.errors).toEqual([]);
  });
});

test.describe("touch screen", () => {
  test.use({ viewport: { width: 1024, height: 768 }, isMobile: true, hasTouch: true });

  type Box = { left: number; right: number; top: number; bottom: number };
  const overlaps = (a: Box, b: Box) =>
    a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

  /** Boxes of a name's text, its ⇄ button and its lock, and whether both buttons show. */
  async function layoutOf(name: Locator, textSelector: string) {
    return name.evaluate((root, selector) => {
      const box = (element: Element | null): Box => {
        if (!element) throw new Error("missing element");
        const { left, right, top, bottom } = element.getBoundingClientRect();
        return { left, right, top, bottom };
      };
      const swap = root.querySelector('button[aria-label^="Find swap"]');
      const lock = root.querySelector('button[aria-label^="Lock assignment"]');
      const shown = [swap, lock].every((button) => button && getComputedStyle(button).opacity !== "0");
      return { text: box(root.querySelector(selector)), swap: box(swap), lock: box(lock), shown };
    }, textSelector);
  }

  async function expectSwapLeftOfLock(name: Locator, textSelector: string) {
    await expect(findSwapIn(name)).toBeVisible();
    await expect(name.getByRole("button", { name: /^Lock assignment for/ })).toBeVisible();
    const layout = await layoutOf(name, textSelector);
    expect(layout.shown).toBe(true);
    expect(overlaps(layout.swap, layout.lock)).toBe(false);
    expect(layout.swap.right).toBeLessThanOrEqual(layout.lock.left);
    expect(layout.text.right).toBeLessThanOrEqual(layout.swap.left);
  }

  // Galileo's hand-placed shift is locked, Leonardo's planner shift is not.
  const touchState = () => calendarState("solver");

  test("pills show ⇄ left of the lock, beside the name", async ({ page }) => {
    const api = await openCalendar(page, touchState());
    await mockSwapApi(page, api);
    expect(await page.evaluate(() => matchMedia("(hover: none)").matches)).toBe(true);
    const leonardoPill = pillOf(page, FRI_MRI, "2026-01-09", SECOND);
    await expect(galileoPill(page)).toHaveAttribute("data-locked", "true");
    await expect(leonardoPill).toHaveAttribute("data-locked", "false");
    for (const pill of [galileoPill(page), leonardoPill]) {
      // The pill's row holds the initials, then the name.
      await expectSwapLeftOfLock(pill, ":scope > div > span:last-child");
    }

    await findSwapIn(galileoPill(page)).tap();
    await expect(page.getByRole("heading", { name: "Find a swap" })).toBeVisible();
    await drawer(page).getByRole("button", { name: "Close" }).tap();
    await expect(drawer(page)).toBeHidden();
    await galileoPill(page).getByRole("button", { name: /^Lock assignment for/ }).tap();
    await expect(galileoPill(page)).toHaveAttribute("data-locked", "false");
    await expect(drawer(page)).toBeHidden();
    expect(api.errors).toEqual([]);
  });

  test("clinic sheet names show ⇄ left of the lock, beside the name", async ({ page }) => {
    const state = touchState();
    state.solverSettings = { ...state.solverSettings!, scheduleLayout: "clinicSheet" };
    const api = await openCalendar(page, state);
    expect(await page.evaluate(() => matchMedia("(hover: none)").matches)).toBe(true);
    const sheetName = (rowId: string, dateISO: string, clinicianId: string) =>
      page.locator(`[data-sheet-assignment-key="${rowId}__${dateISO}__${clinicianId}"]`);
    const galileo = sheetName(THU_CT, "2026-01-08", FIRST);
    const leonardo = sheetName(FRI_MRI, "2026-01-09", SECOND);
    const lockOf = (name: Locator) => name.getByRole("button", { name: /^Lock assignment for/ });
    await expect(lockOf(galileo)).toHaveAttribute("aria-pressed", "true");
    await expect(lockOf(leonardo)).toHaveAttribute("aria-pressed", "false");
    for (const name of [galileo, leonardo]) await expectSwapLeftOfLock(name, ":scope > span:first-child");
    expect(api.errors).toEqual([]);
  });
});
