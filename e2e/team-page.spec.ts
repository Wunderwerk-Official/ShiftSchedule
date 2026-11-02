import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import type { AppState, Assignment } from "../src/api/client";

// Team page behaviour on a mocked API: the rule-violation and split-shift
// popovers, badge jumps in the phone day view, the "template too large"
// banner, Reset on vacation days, the backup before a shifts file import and
// loading public holidays without losing those added by hand (the state
// filter itself is covered by holiday-region.spec.ts).

const defaultState = JSON.parse(
  readFileSync(new URL("../backend/default_state.json", import.meta.url), "utf8"),
) as AppState;

const [FIRST, SECOND] = defaultState.clinicians.map((clinician) => clinician.id);

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

const assignment = (
  id: string,
  dayType: string,
  section: string,
  clinicianId: string,
  extra: Partial<Assignment> = {},
): Assignment => ({
  id,
  rowId: slotId(dayType, section),
  dateISO: "2026-01-05",
  clinicianId,
  source: "manual",
  ...extra,
});

/**
 * The team grid shows the built-in demo calendar (src/data/mockData.ts) at
 * once and swaps in the mocked one only when GET /v1/state has answered, so a
 * visible grid is not enough: wait for a cell of the mocked template, or a
 * test may read or click the demo calendar.
 */
async function waitForMockedCalendar(page: Page, state: AppState) {
  const slotIds = state.weeklyTemplate!.locations.flatMap((location) => location.slots.map((slot) => slot.id));
  await expect
    .poll(
      () =>
        page
          .locator('[data-schedule-cell="true"]')
          .evaluateAll((cells, ids) => cells.some((cell) => ids.includes(cell.getAttribute("data-row-id") ?? "")), slotIds),
      { message: "the mocked calendar replaces the built-in demo calendar" },
    )
    .toBe(true);
}

/** With a `stateGate`, GET /v1/state waits for it and the demo calendar is still shown on return. */
async function openCalendar(
  page: Page,
  state: AppState,
  now: string,
  { stateGate }: { stateGate?: Promise<void> } = {},
) {
  let current = { ...state, revision: "r0" } as AppState;
  const statePosts: AppState[] = [];
  const errors: string[] = [];
  const dialogs: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.message());
    void dialog.accept();
  });
  await page.clock.setFixedTime(new Date(now));
  await page.addInitScript(() => localStorage.setItem("authToken", "test-token"));
  await page.route("**/auth/me", (route) =>
    route.fulfill({ json: { username: "test", role: "user", active: true } }),
  );
  await page.route("**/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/v1/state")) {
      if (request.method() === "GET" && stateGate) await stateGate;
      if (request.method() === "POST") {
        statePosts.push(request.postDataJSON() as AppState);
        current = { ...request.postDataJSON(), revision: `r${statePosts.length}` };
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
  if (stateGate) {
    // Until the calendar has loaded the Team plan shows a loading card (v1.82).
    await expect(page.getByRole("region", { name: "Team plan" }).getByText("Loading calendar…")).toBeVisible();
  } else {
    await expect(page.locator('[data-schedule-grid="true"]')).toBeVisible();
    await waitForMockedCalendar(page, state);
  }
  return { state: () => current, statePosts, errors, dialogs };
}

/** The default state with 16 copies of its location: 16 x 21 = 336 > 300 columns. */
function oversizedState(): { state: AppState; total: number } {
  const state = structuredClone(defaultState);
  const template = state.weeklyTemplate!;
  const base = template.locations[0];
  for (let i = 1; i < 16; i += 1) {
    const id = `loc-copy-${i}`;
    const suffix = (value: string) => `${value}-copy-${i}`;
    state.locations.push({ id, name: `Copy ${i}` });
    template.locations.push({
      ...base,
      locationId: id,
      rowBands: base.rowBands.map((band) => ({ ...band, id: suffix(band.id) })),
      colBands: base.colBands.map((band) => ({ ...band, id: suffix(band.id) })),
      slots: base.slots.map((slot) => ({
        ...slot,
        id: suffix(slot.id),
        locationId: id,
        rowBandId: suffix(slot.rowBandId),
        colBandId: suffix(slot.colBandId),
      })),
    });
  }
  const total = template.locations.reduce((sum, location) => sum + location.colBands.length, 0);
  return { state, total };
}

test.use({ timezoneId: "Europe/Berlin", viewport: { width: 1400, height: 900 } });

test("items in the rule-violation and split-shift popovers can be clicked", async ({ page }) => {
  const state = structuredClone(defaultState);
  state.assignments = [
    // Overlapping shifts on Monday morning: one rule violation.
    assignment("ct", "mon", "CT", FIRST),
    assignment("mri", "mon", "MRI", FIRST),
    // Morning shift plus on-call from 16:00: a split shift.
    assignment("sono", "mon", "Sonography", SECOND),
    assignment("oncall", "mon", "On Call", SECOND),
  ];
  const api = await openCalendar(page, state, "2026-01-05T08:00:00Z");

  await page.getByTitle("Show the violation list").click();
  const violations = page.getByText("Rule violations in view");
  await expect(violations).toBeVisible();
  const violationItem = page.getByRole("button", { name: /overlapping shifts/ });
  await violationItem.click();
  // The press inside the portal popover no longer closes it before the click.
  await expect(violations).toBeVisible();
  await expect(violationItem).toHaveAttribute("aria-pressed", "true");
  // A press outside still closes it.
  await page.mouse.click(5, 300);
  await expect(violations).toBeHidden();

  await expect(page.getByRole("button", { name: /^1 rule violation/ })).toBeVisible();
  await page.getByRole("button", { name: /^1 split shift$/ }).click();
  const splitShifts = page.getByText("Split shifts (gaps between assignments)");
  await expect(splitShifts).toBeVisible();
  const splitItem = page.getByRole("button", { name: /Gap between shifts/ });
  await splitItem.click();
  await expect(splitShifts).toBeVisible();
  await expect(splitItem).toHaveClass(/bg-rose-50/);
  await page.mouse.click(5, 300);
  await expect(splitShifts).toBeHidden();
  expect(api.errors).toEqual([]);
});

test("dragging into and out of the Vacation row adds and removes the vacation day", async ({ page }) => {
  const state = structuredClone(defaultState);
  state.assignments = [assignment("ct", "mon", "CT", FIRST)];
  const api = await openCalendar(page, state, "2026-01-05T08:00:00Z");
  const cell = (rowId: string) =>
    page.locator(`[data-schedule-cell="true"][data-row-id="${rowId}"][data-date-iso="2026-01-05"]`);
  const vacationOf = () =>
    api.state().clinicians.find((clinician) => clinician.id === FIRST)?.vacations ?? [];

  // Into Vacation: a vacation day appears and the day's assignment is gone.
  await cell(slotId("mon", "CT")).locator('div[draggable="true"]').first().dragTo(cell("pool-vacation"));
  await expect
    .poll(() => vacationOf().map((vacation) => [vacation.startISO, vacation.endISO]))
    .toEqual([["2026-01-05", "2026-01-05"]]);
  await expect.poll(() => api.state().assignments.length).toBe(0);

  // Out of Vacation into a shift: the vacation day is removed, the shift assigned.
  await cell("pool-vacation").locator('div[draggable="true"]').first().dragTo(cell(slotId("mon", "MRI")));
  await expect.poll(() => vacationOf()).toEqual([]);
  await expect
    .poll(() => api.state().assignments.map((item) => [item.rowId, item.clinicianId]))
    .toEqual([[slotId("mon", "MRI"), FIRST]]);
  expect(api.errors).toEqual([]);
});

test("moving a planner shift by hand locks it (v1.69)", async ({ page }) => {
  const state = structuredClone(defaultState);
  state.assignments = [assignment("ct", "mon", "CT", FIRST, { source: "solver" })];
  const api = await openCalendar(page, state, "2026-01-05T08:00:00Z");
  const cell = (rowId: string) =>
    page.locator(`[data-schedule-cell="true"][data-row-id="${rowId}"][data-date-iso="2026-01-05"]`);
  const lockIn = (rowId: string) => cell(rowId).getByRole("button", { name: /^Lock assignment for/ });
  await expect(lockIn(slotId("mon", "CT"))).toHaveAttribute("aria-pressed", "false");

  await cell(slotId("mon", "CT")).locator('div[draggable="true"]').first().dragTo(cell(slotId("mon", "MRI")));
  await expect
    .poll(() => api.state().assignments.map((item) => [item.rowId, item.source, item.locked ?? null]))
    .toEqual([[slotId("mon", "MRI"), "manual", null]]);
  await expect(lockIn(slotId("mon", "MRI"))).toHaveAttribute("aria-pressed", "true");
  expect(api.errors).toEqual([]);
});

test("printed short names stand for one person of the team (v1.82)", async ({ page }) => {
  // A PDF has no hover: two people may never print under one label, and
  // "Last, First" names with titles must not shorten to "Müller, D." or "M. Dr.".
  const state = structuredClone(defaultState);
  state.clinicians[0].name = "Mehmet Yildirim";
  state.clinicians[1].name = "Mehmet Yılmaz";
  state.clinicians.push({ ...state.clinicians[0], id: "c-mueller", name: "Müller, Jörg; Dr." });
  state.assignments = [
    assignment("ct", "mon", "CT", FIRST),
    assignment("mri", "mon", "MRI", SECOND),
    assignment("sono", "mon", "Sonography", "c-mueller"),
  ];
  await page.addInitScript(() => localStorage.setItem("authToken", "test-token"));
  await page.route("**/auth/me", (route) =>
    route.fulfill({ json: { username: "test", role: "user", active: true } }),
  );
  await page.route("**/v1/**", (route) =>
    new URL(route.request().url()).pathname.endsWith("/v1/state")
      ? route.fulfill({ json: { ...state, revision: "r0" } })
      : route.fulfill({ json: {} }),
  );
  const labelOf = (clinicianId: string) =>
    page
      // The pill's name (one line, or wrapped when even its last level is too wide).
      .locator(`[data-assignment-key$="__${clinicianId}"] span.text-center`)
      .first()
      .innerText();
  for (const layout of ["", "&layout=portrait"]) {
    await page.goto(`/print/week?start=2026-01-05${layout}`);
    await page.waitForFunction("window.__PDF_READY__ === true");
    const [yildirim, yilmaz, mueller] = [await labelOf(FIRST), await labelOf(SECOND), await labelOf("c-mueller")];
    // Landscape prints whole names where they fit; the compact portrait week
    // shortens them, never to one label for both.
    if (layout) expect(yildirim).not.toBe("Mehmet Yildirim");
    expect(yildirim).not.toBe(yilmaz);
    expect([yildirim, yilmaz]).not.toContain("Mehmet Y.");
    expect([yildirim, yilmaz]).not.toContain("M. Y.");
    // A whole name prints as entered; a shortened one keeps the given name
    // and drops the title.
    if (layout) expect(mueller).not.toBe("Müller, Jörg; Dr.");
    if (mueller !== "Müller, Jörg; Dr.") {
      expect(mueller).toMatch(/J/);
      expect(mueller).not.toMatch(/Dr\./);
    }
  }
});

test("team grid pills never show two people under one visible name (v1.82)", async ({ page }) => {
  // Person colors cut a long "First L." with an ellipsis: "Sophie Wa." and
  // "Sophie We." would both read "Sophie…", so those two show "S. Wa." /
  // "S. We." where the full label does not fit.
  const state = structuredClone(defaultState);
  state.clinicians[0].name = "Sophie Wagner";
  state.clinicians[1].name = "Sophie Weber";
  state.assignments = [
    assignment("ct", "mon", "CT", FIRST),
    assignment("mri", "mon", "MRI", SECOND),
    assignment("sono", "mon", "Sonography", FIRST, { locked: true }),
    assignment("ctn", "mon", "CT Neuro", SECOND, { locked: true }),
  ];
  const api = await openCalendar(page, state, "2026-01-05T08:00:00Z");
  const shown = () =>
    page.$$eval("[data-assignment-pill] span.min-w-0", (spans) =>
      spans.map((span) => {
        const text = span.textContent ?? "";
        if (span.classList.contains("sr-only")) return { text, visible: "" };
        // What the ellipsis leaves: the text up to the row's right edge.
        const cut = span.scrollWidth > span.clientWidth + 1;
        return { text, visible: cut ? `${text}…(cut)` : text };
      }),
    );
  const times = page.getByRole("group", { name: "Times" });
  for (const layout of ["Side by side", "Stacked"]) {
    await times.getByRole("button", { name: layout }).click();
    await page.waitForTimeout(300);
    const pills = await shown();
    expect(pills).toHaveLength(4);
    for (const pill of pills) {
      // Each pill shows a label of its own in full: the team-unique
      // "Sophie Wa." where it fits, "S. Wa." where it does not.
      expect(pill.visible, layout).toMatch(/^(Sophie Wagner|Sophie Weber|Sophie Wa\.|Sophie We\.|S\. Wa\.|S\. We\.)$/);
    }
  }
  expect(api.errors).toEqual([]);
});

test("a locked shift moved into the Rest Day row becomes a plain rest day entry (v1.69)", async ({ page }) => {
  const state = structuredClone(defaultState);
  state.assignments = [assignment("ct", "mon", "CT", FIRST, { source: "solver", locked: true })];
  const api = await openCalendar(page, state, "2026-01-05T08:00:00Z");
  const cell = (rowId: string) =>
    page.locator(`[data-schedule-cell="true"][data-row-id="${rowId}"][data-date-iso="2026-01-05"]`);

  await cell(slotId("mon", "CT")).locator('div[draggable="true"]').first().dragTo(cell("pool-rest-day"));
  // Pool rows have no lock: no hidden lock may stay behind.
  await expect
    .poll(() => api.state().assignments.map((item) => [item.rowId, item.source, item.locked ?? null]))
    .toEqual([["pool-rest-day", "manual", null]]);
  await expect(cell("pool-rest-day").getByRole("button", { name: /^Lock assignment for/ })).toHaveCount(0);

  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await page.getByRole("button", { name: /^Unlocked shifts and rest days/ }).click();
  await expect.poll(() => api.state().assignments.length).toBe(0);
  expect(api.errors).toEqual([]);
});

test("a hand-placed rest day moves to another day and leaves when dragged out; an automatic one explains itself", async ({ page }) => {
  const state = structuredClone(defaultState);
  state.assignments = [
    { id: "rest", rowId: "pool-rest-day", dateISO: "2026-01-05", clinicianId: FIRST, source: "manual" },
    // On call on Wednesday: automatic rest days on Tuesday and Thursday.
    { ...assignment("oncall", "wed", "On Call", SECOND), dateISO: "2026-01-07" },
  ];
  const api = await openCalendar(page, state, "2026-01-05T08:00:00Z");
  const cell = (rowId: string, dateISO: string) =>
    page.locator(`[data-schedule-cell="true"][data-row-id="${rowId}"][data-date-iso="${dateISO}"]`);
  const pillOf = (rowId: string, dateISO: string, clinicianId: string) =>
    page.locator(`[data-schedule-grid="true"] [data-assignment-key="${rowId}__${dateISO}__${clinicianId}"]`);
  const outside = page.getByRole("button", { name: "Open Vacation Planner" });
  const restDays = () =>
    api.state().assignments.filter((item) => item.rowId === "pool-rest-day").map((item) => item.dateISO);

  // Hand-placed: onto Wednesday's Rest Day cell it moves, out of the grid it is removed.
  await pillOf("pool-rest-day", "2026-01-05", FIRST).dragTo(cell("pool-rest-day", "2026-01-07"));
  await expect.poll(restDays).toEqual(["2026-01-07"]);
  await expect(pillOf("pool-rest-day", "2026-01-07", FIRST)).toBeVisible();
  await pillOf("pool-rest-day", "2026-01-07", FIRST).dragTo(outside);
  await expect.poll(restDays).toEqual([]);
  await expect(pillOf("pool-rest-day", "2026-01-07", FIRST)).toHaveCount(0);

  // Automatic (on-call rule): nothing changes, a notice says why.
  const postsBefore = api.statePosts.length;
  await pillOf("pool-rest-day", "2026-01-08", SECOND).dragTo(outside);
  await expect(page.getByRole("status").filter({ hasText: "Automatic rest day" })).toHaveText(
    "Automatic rest day after on-call duty on Wed 07.01. Change the on-call shift or the rest-day rule to change it.",
  );
  await pillOf("pool-rest-day", "2026-01-08", SECOND).dragTo(cell("pool-rest-day", "2026-01-09"));
  await page.waitForTimeout(700);
  expect(api.statePosts.length).toBe(postsBefore);
  await expect(pillOf("pool-rest-day", "2026-01-08", SECOND)).toBeVisible();
  await expect(pillOf("pool-rest-day", "2026-01-09", SECOND)).toHaveCount(0);

  // Into a shift on that day: shown once, in the shift, and flagged.
  await pillOf("pool-rest-day", "2026-01-08", SECOND).dragTo(cell(slotId("thu", "MRI"), "2026-01-08"));
  await expect
    .poll(() => api.state().assignments.filter((item) => item.dateISO === "2026-01-08").map((item) => item.rowId))
    .toEqual([slotId("thu", "MRI")]);
  await expect(pillOf(slotId("thu", "MRI"), "2026-01-08", SECOND)).toBeVisible();
  await expect(pillOf("pool-rest-day", "2026-01-08", SECOND)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^1 rule violation/ })).toBeVisible();
  expect(api.errors).toEqual([]);
});

test("a hand-placed rest day is not moved onto a vacation day (re-QA)", async ({ page }) => {
  const state = structuredClone(defaultState);
  state.assignments = [
    { id: "rest", rowId: "pool-rest-day", dateISO: "2026-01-05", clinicianId: FIRST, source: "manual" },
  ];
  state.clinicians[0].vacations = [{ id: "v1", startISO: "2026-01-06", endISO: "2026-01-06" }];
  const api = await openCalendar(page, state, "2026-01-05T08:00:00Z");
  const restPill = page.locator(`[data-schedule-grid="true"] [data-assignment-key="pool-rest-day__2026-01-05__${FIRST}"]`);
  await restPill.dragTo(
    page.locator('[data-schedule-cell="true"][data-row-id="pool-rest-day"][data-date-iso="2026-01-06"]'),
  );
  // Vacation would hide it there: it stays where it was, and a notice says why.
  await expect(page.getByRole("status").filter({ hasText: "is on vacation" })).toContainText(
    "is on vacation on Tue 06.01. The rest day stays on Mon 05.01.",
  );
  await page.waitForTimeout(700);
  expect(api.state().assignments.map((item) => `${item.rowId} ${item.dateISO}`)).toEqual(["pool-rest-day 2026-01-05"]);
  await expect(restPill).toBeVisible();
  expect(api.errors).toEqual([]);
});

test("a hand-placed rest day on an automatic one leaves it in its place, and the notice says why", async ({ page }) => {
  const state = structuredClone(defaultState);
  state.assignments = [
    // On call on Wednesday: automatic rest days on Tuesday and Thursday.
    { ...assignment("oncall", "wed", "On Call", SECOND), dateISO: "2026-01-07" },
    { id: "rest", rowId: "pool-rest-day", dateISO: "2026-01-06", clinicianId: SECOND, source: "manual" },
  ];
  const api = await openCalendar(page, state, "2026-01-05T08:00:00Z");
  const restPill = page.locator(
    `[data-schedule-grid="true"] [data-assignment-key="pool-rest-day__2026-01-06__${SECOND}"]`,
  );
  await restPill.dragTo(page.getByRole("button", { name: "Open Vacation Planner" }));
  await expect
    .poll(() => api.state().assignments.filter((item) => item.rowId === "pool-rest-day"))
    .toEqual([]);
  await expect(restPill).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Automatic rest day" })).toHaveText(
    "Automatic rest day before on-call duty on Wed 07.01. Change the on-call shift or the rest-day rule to change it.",
  );
  expect(api.errors).toEqual([]);
});

test("a vacation day ends only when its pill leaves the calendar", async ({ page }) => {
  const state = structuredClone(defaultState);
  state.assignments = [];
  state.clinicians[0].vacations = [{ id: "v1", startISO: "2026-01-05", endISO: "2026-01-09" }];
  const api = await openCalendar(page, state, "2026-01-05T08:00:00Z");
  const vacationPill = (dateISO: string) =>
    page.locator(`[data-schedule-grid="true"] [data-assignment-key="pool-vacation__${dateISO}__${FIRST}"]`);
  const vacations = () => api.state().clinicians[0].vacations.map(({ startISO, endISO }) => `${startISO}..${endISO}`);

  // Onto another day's Vacation cell (like moving a rest day) or slot: nothing changes.
  await vacationPill("2026-01-05").dragTo(
    page.locator('[data-schedule-cell="true"][data-row-id="pool-vacation"][data-date-iso="2026-01-06"]'),
  );
  await vacationPill("2026-01-05").dragTo(
    page.locator('[data-schedule-cell="true"][data-row-kind="class"][data-date-iso="2026-01-06"]').first(),
  );
  // Onto its row label or a day header (inside the calendar, not a cell): nothing changes (re-QA).
  const grid = page.locator('[data-schedule-grid="true"]');
  await vacationPill("2026-01-05").dragTo(grid.getByText("Vacation", { exact: true }).first());
  await vacationPill("2026-01-05").dragTo(grid.getByText(/^tue/i).first());
  await page.waitForTimeout(700);
  expect(vacations()).toEqual(["2026-01-05..2026-01-09"]);
  await expect(vacationPill("2026-01-05")).toBeVisible();

  // Out of the calendar: that day's vacation ends.
  await vacationPill("2026-01-05").dragTo(page.getByRole("button", { name: "Open Vacation Planner" }));
  await expect.poll(vacations).toEqual(["2026-01-06..2026-01-09"]);
  await expect(vacationPill("2026-01-05")).toHaveCount(0);
  expect(api.errors).toEqual([]);
});

test("a shift on a rest day after on-call duty in the week before is still flagged", async ({ page }) => {
  const state = structuredClone(defaultState);
  state.assignments = [
    // On call on Sunday 04.01, the last day of the week before; MRI on Monday 05.01.
    { ...assignment("oncall", "sun", "On Call", SECOND), dateISO: "2026-01-04" },
    assignment("mri", "mon", "MRI", SECOND),
  ];
  const api = await openCalendar(page, state, "2026-01-05T08:00:00Z");
  const range = page.getByRole("button", { name: "Pick a week" });
  const badge = page.getByRole("button", { name: /^1 rule violation/ });
  // Shown once (in MRI, no Rest Day pill), and the badge names the conflict.
  await expect(
    page.locator(`[data-schedule-grid="true"] [data-assignment-key="pool-rest-day__2026-01-05__${SECOND}"]`),
  ).toHaveCount(0);
  await expect(badge).toBeVisible();
  await page.getByTitle("Show the violation list").click();
  await expect(
    page.getByRole("button", { name: /Scheduled on 05\.01\.2026, but needs 1 rest day after On Call shift on 04\.01\.2026/ }),
  ).toBeVisible();
  // Picking it stays in this week (the on-call day is in the week before).
  await page.getByRole("button", { name: /Scheduled on 05\.01\.2026/ }).click();
  await expect(range).toHaveText(/05\.01\.2026 – 11\.01\.2026/);
  await page.mouse.click(5, 300);
  // The week before, with the on-call shift, flags it as well.
  await page.getByRole("button", { name: "Previous week" }).click();
  await expect(range).toHaveText(/29\.12\.2025 – 04\.01\.2026/);
  await expect(badge).toBeVisible();
  expect(api.errors).toEqual([]);
});

test("the clinic sheet marks a shift on an automatic rest day", async ({ page }) => {
  const state = structuredClone(defaultState);
  state.solverSettings = { ...state.solverSettings, scheduleLayout: "clinicSheet" };
  state.assignments = [
    { ...assignment("oncall", "wed", "On Call", SECOND), dateISO: "2026-01-14" },
    { ...assignment("mri", "thu", "MRI", SECOND), dateISO: "2026-01-15" },
  ];
  const api = await openCalendar(page, state, "2026-01-05T08:00:00Z");
  const name = page.locator(
    `[data-schedule-cell="true"][data-row-id="${slotId("thu", "MRI")}"][data-date-iso="2026-01-15"] [data-sheet-name="true"]`,
  );
  await expect(name).toHaveAttribute("title", "Leonardo DaVinci — scheduled on a rest day");
  await expect(
    page.locator('[data-schedule-cell="true"][data-row-id="pool-rest-day"][data-date-iso="2026-01-15"]'),
  ).not.toContainText("DaVinci");
  expect(api.errors).toEqual([]);
});

test("a hand-placed rest day next to a shift that day is flagged as a rule violation", async ({ page }) => {
  const state = structuredClone(defaultState);
  state.assignments = [
    { id: "rest", rowId: "pool-rest-day", dateISO: "2026-01-05", clinicianId: FIRST, source: "manual" },
    assignment("ct", "mon", "CT", FIRST),
  ];
  const api = await openCalendar(page, state, "2026-01-05T08:00:00Z");
  await page.getByTitle("Show the violation list").click();
  await expect(page.getByRole("button", { name: /that day is a rest day \(Rest Day row\)/ })).toBeVisible();
  // The rest day pill turns red with the shift.
  await expect(
    page.locator(`[data-schedule-grid="true"] [data-assignment-key="pool-rest-day__2026-01-05__${FIRST}"]`),
  ).toHaveClass(/rose|red/);
  expect(api.errors).toEqual([]);
});

test("the viewed week is kept in the address: reload, links, Today and invalid values", async ({ page }) => {
  const state = structuredClone(defaultState);
  state.assignments = [];
  const api = await openCalendar(page, state, "2026-01-05T08:00:00Z");
  const range = page.getByRole("button", { name: "Pick a week" });
  const search = () => page.evaluate(() => window.location.search);
  await expect(range).toHaveText(/05\.01\.2026 – 11\.01\.2026/);
  expect(await search()).toBe("");
  await expect(page.getByRole("switch", { name: "Publish week 05.01.2026 – 11.01.2026" })).toBeVisible();

  const historyLength = await page.evaluate(() => window.history.length);
  await page.getByRole("button", { name: "Next week" }).click();
  await page.getByRole("button", { name: "Next week" }).click();
  await expect.poll(search).toBe("?week=2026-01-19");
  // One history entry, replaced on every step.
  expect(await page.evaluate(() => window.history.length)).toBe(historyLength);
  await expect(page.getByRole("switch", { name: "Publish week 19.01.2026 – 25.01.2026" })).toBeVisible();

  await page.reload();
  await expect(range).toHaveText(/19\.01\.2026 – 25\.01\.2026/);
  expect(await search()).toBe("?week=2026-01-19");

  // The week navigator's Today (the planning panel below has one for its timeframe).
  await page.getByRole("button", { name: "Today", exact: true }).first().click();
  await expect(range).toHaveText(/05\.01\.2026 – 11\.01\.2026/);
  await expect.poll(search).toBe("");

  // A link to a day opens its week (and names its Monday); nonsense is ignored.
  await page.goto("/?week=2026-03-25");
  await expect(range).toHaveText(/23\.03\.2026 – 29\.03\.2026/);
  await expect.poll(search).toBe("?week=2026-03-23");
  await page.goto("/?week=2026-02-30");
  await expect(range).toHaveText(/05\.01\.2026 – 11\.01\.2026/);
  await expect.poll(search).toBe("");
  expect(api.errors).toEqual([]);
});

test("the team plan shows a loading card instead of the demo calendar, and stops waiting when loading fails", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-01-05T08:00:00Z"));
  await page.addInitScript(() => localStorage.setItem("authToken", "test-token"));
  await page.route("**/auth/me", (route) =>
    route.fulfill({ json: { username: "test", role: "user", active: true } }),
  );
  await page.route("**/v1/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/v1/state")) return route.fulfill({ status: 500, json: { detail: "boom" } });
    if (path.endsWith("/v1/me/preferences")) return route.fulfill({ json: {} });
    return route.fulfill({ json: { runs: [] } });
  });
  await page.goto("/");
  const card = page.getByRole("region", { name: "Team plan" });
  await expect(card.getByRole("status")).toHaveText(/The calendar could not be loaded\./);
  await expect(card.getByRole("button", { name: "Reload saved calendar" })).toBeVisible();
  await expect(page.getByText("Loading calendar…")).toHaveCount(0);
  // Neither the demo calendar nor its controls.
  await expect(page.locator('[data-schedule-grid="true"]')).toHaveCount(0);
  await expect(page.getByRole("switch")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Run", exact: true })).toBeHidden();
  await expect(page.getByText("Berlin", { exact: true })).toHaveCount(0);
});

test("Times switches between side-by-side and stacked columns and stores the choice", async ({ page }) => {
  const state = structuredClone(defaultState);
  state.assignments = [assignment("ct", "mon", "CT", FIRST)];
  const api = await openCalendar(page, state, "2026-01-05T08:00:00Z");
  const saved: Record<string, unknown>[] = [];
  let stored: Record<string, unknown> = {};
  await page.route("**/v1/me/preferences", (route) => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      saved.push(body);
      stored = { ...stored, ...body };
    }
    return route.fulfill({ json: stored });
  });
  const grid = page.locator('[data-schedule-grid="true"]');
  const columnCount = async () =>
    // The day columns (Stacked also repeats three label columns first).
    Number(/repeat\((\d+), minmax/.exec((await grid.getAttribute("style")) ?? "")?.[1]);
  const times = page.getByRole("group", { name: "Times" });
  const pill = page.locator(
    `[data-schedule-cell="true"][data-row-id="${slotId("mon", "CT")}"][data-date-iso="2026-01-05"] [data-assignment-pill="true"]`,
  );

  // Stacked by default: one column per day, the assignment in its slot.
  await expect(times.getByRole("button", { name: "Stacked" })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(columnCount).toBe(7);
  await expect(pill).toBeVisible();

  await times.getByRole("button", { name: "Side by side" }).click();
  await expect.poll(columnCount).toBeGreaterThan(7);
  await expect(pill).toBeVisible();
  await expect.poll(() => saved).toContainEqual({ teamTimeLayout: "columns" });
  // The saved answer keeps the choice.
  await page.waitForTimeout(300);
  expect(await columnCount()).toBeGreaterThan(7);
  expect(api.errors).toEqual([]);
});

test("Stacked gives every section of a row band its own lanes, named in the label (v1.76)", async ({ page }) => {
  const state = structuredClone(defaultState);
  const template = state.weeklyTemplate!;
  // Wednesday's morning CT slot becomes a Sonography slot: before v1.76 it
  // shared the CT lane and only a tag in its cell named it. (Tuesday Jan 6 is
  // a holiday in the default state.)
  const movedId = slotId("wed", "CT");
  const sonographyId = state.rows.find((row) => row.name === "Sonography")!.id;
  const sonographyBlock = template.blocks.find((block) => block.sectionId === sonographyId)!;
  const moved = template.locations[0].slots.find((slot) => slot.id === movedId)!;
  moved.blockId = sonographyBlock.id;
  state.assignments = [
    { id: "sono-wed", rowId: movedId, dateISO: "2026-01-07", clinicianId: FIRST, source: "manual" },
  ];
  const api = await openCalendar(page, state, "2026-01-05T08:00:00Z");
  const labels = (kind: string) =>
    page.locator(`[data-stacked-label="${kind}"]`).evaluateAll((cells) => cells.map((cell) => cell.textContent));

  // evaluateAll reads once: poll, so the labels are those of the mocked calendar.
  await expect.poll(() => labels("band")).toEqual(["MRI", "CT", "Sonography", "On call"]);
  // CT row: its own section (named by the row), then Sonography, then CT Neuro.
  await expect.poll(() => labels("section")).toEqual(["", "MRI Neuro", "", "Sonography", "CT Neuro", "", ""]);
  const ctGroup = `group-${template.locations[0].locationId}__${moved.rowBandId}`;
  // Wednesday in the CT lane is hatched; the Sonography slot sits in its own lane.
  await expect(
    page.locator(`[data-schedule-cell="true"][data-row-id="${ctGroup}__t1"][data-date-iso="2026-01-07"]`),
  ).toHaveClass(/stacked-off-cell/);
  const sonoCell = page.locator(`[data-schedule-cell="true"][data-row-id="${movedId}"][data-date-iso="2026-01-07"]`);
  await expect(sonoCell.locator('[data-assignment-pill="true"]')).toBeVisible();
  await expect(sonoCell).toHaveAttribute("title", "Sonography · 08:00 - 12:00");
  await expect(page.locator("[data-other-section]")).toHaveCount(0);
  expect(api.errors).toEqual([]);
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the open-slots badge switches the day view to the open slot's day", async ({ page }) => {
    const state = structuredClone(defaultState);
    state.assignments = [];
    // Today is Wednesday; the first open slot of the week is on Monday.
    const api = await openCalendar(page, state, "2026-01-07T08:00:00Z");
    // The day in the desktop date style.
    await expect(page.getByText("Wed 07.01.2026")).toBeVisible();
    await page.getByRole("button", { name: /open slots?$/ }).click();
    await expect(page.getByText("Mon 05.01.2026")).toBeVisible();
    expect(api.errors).toEqual([]);
  });
});

test.describe("template above the column limit", () => {
  const banner = (page: Page) => page.getByText(/The weekly template has \d+ columns in total/);

  test("shows a banner and is not saved", async ({ page }) => {
    const { state, total } = oversizedState();
    expect(total).toBeGreaterThan(300);
    const api = await openCalendar(page, state, "2026-01-05T08:00:00Z");

    await expect(page.getByRole("alert")).toContainText(
      `The weekly template has ${total} columns in total (max 300).`,
    );
    // The autosave after loading (normally within 500 ms) is held back.
    await page.waitForTimeout(1500);
    expect(api.statePosts).toEqual([]);
    expect(api.errors).toEqual([]);
  });

  test("importing a shifts file is refused", async ({ page }) => {
    const api = await openCalendar(page, oversizedState().state, "2026-01-05T08:00:00Z");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.locator('input[type="file"][accept="application/json"]').setInputFiles({
      name: "snapshot.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify({ assignments: [assignment("ct", "mon", "CT", FIRST)] })),
    });
    // Refused before the question to replace the shifts.
    await expect(
      page.getByText("The current calendar cannot be saved. Fix its template first."),
    ).toBeVisible();
    await expect(page.getByRole("dialog")).toBeHidden();
    expect(api.statePosts).toEqual([]);
    expect(api.errors).toEqual([]);
  });

  test("restoring a snapshot backs up the last saved calendar, then saving resumes", async ({ page }) => {
    const api = await openCalendar(page, oversizedState().state, "2026-01-05T08:00:00Z");
    const restoreBodies: unknown[] = [];
    await page.route("**/v1/state/snapshots**", (route) => {
      if (new URL(route.request().url()).pathname.endsWith("/restore")) {
        restoreBodies.push(route.request().postDataJSON());
        return route.fulfill({ json: { ...structuredClone(defaultState), revision: "restored" } });
      }
      const at = "2026-01-04T10:00:00Z";
      return route.fulfill({
        json: [{ id: "snap-1", name: "Good calendar", kind: "named", created_at: at, updated_at: at, size_bytes: 1 }],
      });
    });

    await page.getByRole("button", { name: "Calendar snapshots" }).click();
    await page.getByRole("button", { name: "Restore", exact: true }).click();
    await page.getByRole("button", { name: "Restore", exact: true }).click(); // confirm
    await expect.poll(() => restoreBodies).toEqual([{ currentState: null }]);
    await expect(banner(page)).toBeHidden();
    // Autosave runs again on its own (no "Retry saving" needed).
    await expect.poll(() => api.statePosts.length).toBeGreaterThan(0);
    await expect(page.getByRole("button", { name: "Retry saving" })).toBeHidden();
    expect(api.errors).toEqual([]);
  });

  test("signing out asks first and skips the save", async ({ page }) => {
    const api = await openCalendar(page, oversizedState().state, "2026-01-05T08:00:00Z");
    await expect(banner(page)).toBeVisible();
    await page.getByRole("button", { name: "Account" }).click();
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
    expect(api.dialogs).toEqual([expect.stringContaining("Sign out anyway?")]);
    expect(api.statePosts).toEqual([]);
    expect(api.errors).toEqual([]);
  });
});

test("Calendar snapshots wait until the calendar has loaded (v1.79)", async ({ page }) => {
  let releaseState!: () => void;
  const stateGate = new Promise<void>((resolve) => (releaseState = resolve));
  const state = structuredClone(defaultState);
  const api = await openCalendar(page, state, "2026-01-05T08:00:00Z", { stateGate });
  const saved: { name: string; state: AppState }[] = [];
  await page.route("**/v1/state/snapshots**", (route) => {
    const at = "2026-01-04T10:00:00Z";
    if (route.request().method() === "POST") {
      saved.push(route.request().postDataJSON() as { name: string; state: AppState });
      return route.fulfill({
        status: 201,
        json: { id: "snap-2", name: "Before the changes", kind: "named", created_at: at, updated_at: at, size_bytes: 1 },
      });
    }
    return route.fulfill({
      json: [{ id: "snap-1", name: "Good calendar", kind: "named", created_at: at, updated_at: at, size_bytes: 1 }],
    });
  });
  const hint = page.getByText("Saving and restoring are available once the calendar has loaded.");
  const save = page.getByRole("button", { name: "Save", exact: true });
  const restore = page.getByRole("button", { name: "Restore", exact: true });

  // The screen still holds the built-in demo calendar: it must not be saved,
  // and a restore would save it first.
  await page.getByRole("button", { name: "Calendar snapshots" }).click();
  await expect(hint).toBeVisible();
  await page.getByPlaceholder("Snapshot name").fill("Before the changes");
  await expect(save).toBeDisabled();
  await expect(restore).toBeDisabled();

  releaseState();
  await waitForMockedCalendar(page, state);
  await expect(hint).toBeHidden();
  await expect(restore).toBeEnabled();
  await save.click();
  await expect.poll(() => saved.length).toBe(1);
  // The snapshot holds the loaded calendar, not the demo one.
  expect(saved[0].name).toBe("Before the changes");
  expect(saved[0].state.clinicians.map((clinician) => clinician.name)).toEqual(
    state.clinicians.map((clinician) => clinician.name),
  );
  expect(api.errors).toEqual([]);
});

test("Reset → Unlocked shifts also removes planner entries on vacation days", async ({ page }) => {
  const state = structuredClone(defaultState);
  state.clinicians = state.clinicians.map((clinician) =>
    clinician.id === FIRST
      ? { ...clinician, vacations: [{ id: "vac-test", startISO: "2026-01-05", endISO: "2026-01-05" }] }
      : clinician,
  );
  state.assignments = [
    // Hidden by the vacation; applying a solver draft would replace it too.
    assignment("hidden", "mon", "CT", FIRST, { source: "solver" }),
    assignment("manual", "mon", "MRI", SECOND),
  ];
  const api = await openCalendar(page, state, "2026-01-05T12:00:00Z");
  await expect.poll(() => api.statePosts.length).toBeGreaterThan(0);

  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await page.getByRole("button", { name: /^Unlocked shifts Removes/ }).click();
  await expect
    .poll(() => api.state().assignments.map((item) => item.id).sort())
    .toEqual(["manual"]);
  expect(api.errors).toEqual([]);
});

test("Reset → Unlocked shifts and rest days removes planner entries on vacation days and keeps locked ones", async ({ page }) => {
  const state = structuredClone(defaultState);
  state.clinicians = state.clinicians.map((clinician) =>
    clinician.id === FIRST
      ? { ...clinician, vacations: [{ id: "vac-test", startISO: "2026-01-05", endISO: "2026-01-05" }] }
      : clinician,
  );
  state.assignments = [
    assignment("hidden-solver", "mon", "CT", FIRST, { source: "solver" }),
    assignment("hidden-manual", "mon", "MRI", FIRST),
    assignment("manual", "mon", "Sonography", SECOND),
    assignment("fixed", "mon", "On Call", SECOND, { source: "solver", locked: true }),
  ];
  const api = await openCalendar(page, state, "2026-01-05T12:00:00Z");
  await expect.poll(() => api.statePosts.length).toBeGreaterThan(0);

  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await page.getByRole("button", { name: /^Unlocked shifts and rest days/ }).click();
  // Hand-placed shifts are locked (v1.69), like the planner shift locked later.
  await expect
    .poll(() => api.state().assignments.map((item) => item.id).sort())
    .toEqual(["fixed", "hidden-manual", "manual"]);
  expect(api.errors).toEqual([]);
});

test.describe("shifts file import", () => {
  const BACKUP_NAME = "Auto-backup before shifts file import";
  const importFile = (
    page: Page,
    assignments: unknown[] = [assignment("new", "mon", "MRI", SECOND)],
  ) =>
    page.locator('input[type="file"][accept="application/json"]').setInputFiles({
      name: "shifts.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify({ assignments })),
    });
  const backupMeta = (at = "2026-01-05T08:00:00Z") => ({
    id: "auto", name: BACKUP_NAME, kind: "auto_backup", created_at: at, updated_at: at, size_bytes: 1,
  });
  const hasNew = (posted: AppState) => (posted.assignments ?? []).some((item) => item.id === "new");

  test("saves a backup of the shown calendar before replacing the shifts", async ({ page }) => {
    const state = structuredClone(defaultState);
    state.assignments = [assignment("old", "mon", "CT", FIRST)];
    const api = await openCalendar(page, state, "2026-01-05T08:00:00Z");
    const backups: AppState[] = [];
    const expectedRevisions: unknown[] = [];
    let postsAtBackup = -1;
    await page.route("**/v1/state/snapshots/import-backup", (route) => {
      const body = route.request().postDataJSON() as { state: AppState; expectedRevision?: string };
      backups.push(body.state);
      expectedRevisions.push(body.expectedRevision);
      postsAtBackup = api.statePosts.length;
      return route.fulfill({ status: 201, json: backupMeta() });
    });

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await importFile(page);
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("Replace all 1 current shift with 1 shift from “shifts.json”?");
    await expect(dialog).toContainText(
      "The current calendar is saved in Calendar snapshots first; this automatic backup replaces the previous one.",
    );
    await page.getByRole("button", { name: "Replace shifts" }).click();

    await expect(page.getByText(`A backup of the previous calendar is in Calendar snapshots: “${BACKUP_NAME}”.`)).toBeVisible();
    expect(backups).toHaveLength(1);
    expect(backups[0].assignments?.map((item) => item.id)).toEqual(["old"]);
    // The backup names the revision this tab's calendar is based on.
    expect(expectedRevisions).toEqual([`r${postsAtBackup}`]);
    // The imported calendar is saved only after the backup.
    expect(api.statePosts.slice(0, postsAtBackup).some(hasNew)).toBe(false);
    await expect.poll(() => api.statePosts.slice(postsAtBackup).some(hasNew)).toBe(true);
    expect(api.state().assignments.map((item) => item.id)).toEqual(["new"]);
    expect(api.errors).toEqual([]);
  });

  test("imports nothing when the backup cannot be saved", async ({ page }) => {
    const state = structuredClone(defaultState);
    state.assignments = [assignment("old", "mon", "CT", FIRST)];
    const api = await openCalendar(page, state, "2026-01-05T08:00:00Z");
    await page.route("**/v1/state/snapshots/import-backup", (route) =>
      route.fulfill({ status: 500, json: { detail: "Database is locked" } }),
    );

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await importFile(page);
    await page.getByRole("button", { name: "Replace shifts" }).click();

    await expect(
      page.getByText("The backup could not be saved, so nothing was imported. (Database is locked)"),
    ).toBeVisible();
    await page.waitForTimeout(800);
    expect(api.statePosts.some(hasNew)).toBe(false);
    expect(api.state().assignments.map((item) => item.id)).toEqual(["old"]);
    expect(api.errors).toEqual([]);
  });

  test("imports nothing from a tab whose calendar changed elsewhere", async ({ page }) => {
    const state = structuredClone(defaultState);
    state.assignments = [assignment("old", "mon", "CT", FIRST)];
    const api = await openCalendar(page, state, "2026-01-05T08:00:00Z");
    await page.route("**/v1/state/snapshots/import-backup", (route) =>
      route.fulfill({
        status: 409,
        json: { detail: { code: "state_changed", message: "The calendar changed in another tab or operation." } },
      }),
    );

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await importFile(page);
    await page.getByRole("button", { name: "Replace shifts" }).click();

    await expect(page.getByText(/The calendar changed in another tab or operation\./)).toBeVisible();
    await page.waitForTimeout(800);
    expect(api.statePosts.some(hasNew)).toBe(false);
    expect(api.errors).toEqual([]);
  });

  test("refuses a file without shifts for this calendar before asking", async ({ page }) => {
    const state = structuredClone(defaultState);
    state.assignments = [assignment("old", "mon", "CT", FIRST)];
    const api = await openCalendar(page, state, "2026-01-05T08:00:00Z");
    let backups = 0;
    await page.route("**/v1/state/snapshots/import-backup", (route) => {
      backups += 1;
      return route.fulfill({ status: 201, json: backupMeta() });
    });
    await page.getByRole("button", { name: "Settings", exact: true }).click();

    for (const assignments of [
      [],
      [{ foo: 1 }, { bar: 2 }],
      [assignment("foreign", "mon", "MRI", "someone-else")],
    ]) {
      await importFile(page, assignments);
      await expect(
        page.getByText("This file contains no shifts for this calendar. Nothing was changed."),
      ).toBeVisible();
      await expect(page.getByRole("dialog")).toBeHidden();
    }
    await page.waitForTimeout(800);
    expect(backups).toBe(0);
    expect(api.state().assignments.map((item) => item.id)).toEqual(["old"]);
    expect(api.errors).toEqual([]);
  });

  test("keeps each shift once and reports duplicates and invalid entries", async ({ page }) => {
    const state = structuredClone(defaultState);
    state.assignments = [assignment("old", "mon", "CT", FIRST)];
    const api = await openCalendar(page, state, "2026-01-05T08:00:00Z");
    await page.route("**/v1/state/snapshots/import-backup", (route) =>
      route.fulfill({ status: 201, json: backupMeta() }),
    );

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await importFile(page, [
      assignment("new", "mon", "MRI", SECOND),
      assignment("new-copy", "mon", "MRI", SECOND),
      assignment("new-copy-2", "mon", "MRI", SECOND),
      { ...assignment("bad-date", "mon", "MRI", FIRST), dateISO: "2026-02-30" },
    ]);
    await expect(page.getByRole("dialog")).toContainText(
      "Skipped from the file: 1 entry that is not a valid shift, 2 duplicates.",
    );
    await page.getByRole("button", { name: "Replace shifts" }).click();

    await expect(page.getByText(/^Imported 1 shift\. Skipped 1 entry that is not a valid shift, 2 duplicates\./)).toBeVisible();
    await expect.poll(() => api.state().assignments.map((item) => item.id)).toEqual(["new"]);
    expect(api.errors).toEqual([]);
  });
});

test("loading holidays for the chosen state keeps the holidays added by hand", async ({ page }) => {
  const state = structuredClone(defaultState);
  state.holidayCountry = "DE";
  state.holidayRegion = "DE-NW";
  state.holidays = [
    { dateISO: "2026-03-02", name: "Clinic day", source: "manual" },
    // Loaded for all states before holidays carried a source: the service
    // lists it, so loading replaces it.
    { dateISO: "2026-03-08", name: "Internationaler Frauentag" },
    // Added by hand before holidays carried a source: not listed, so kept.
    { dateISO: "2026-12-24", name: "Heiligabend (Klinik)" },
  ];
  const api = await openCalendar(page, state, "2026-01-05T08:00:00Z");
  await page.route("https://date.nager.at/api/v3/PublicHolidays/2026/DE", (route) =>
    route.fulfill({
      headers: { "Access-Control-Allow-Origin": "*" },
      json: [
        { date: "2026-01-01", localName: "Neujahr", name: "New Year's Day", global: true, counties: null },
        { date: "2026-01-06", localName: "Heilige Drei Könige", name: "Epiphany", global: false, counties: ["DE-BW", "DE-BY", "DE-ST"] },
        { date: "2026-03-08", localName: "Internationaler Frauentag", name: "Women's Day", global: false, counties: ["DE-BE", "DE-MV"] },
        { date: "2026-06-04", localName: "Fronleichnam", name: "Corpus Christi", global: false, counties: ["DE-NW", "DE-BY"] },
      ],
    }),
  );

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("button", { name: "State: Nordrhein-Westfalen" })).toBeVisible();
  // A holiday added by hand now is tagged and survives the load as well.
  await page.getByRole("button", { name: "Add Holiday", exact: true }).click();
  await page.getByRole("button", { name: "DD.MM.YYYY", exact: true }).click();
  await page.getByRole("button", { name: "15", exact: true }).click();
  await page.getByPlaceholder("Holiday name").fill("Team day");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Team day")).toContainText("added by hand");

  await page.getByRole("button", { name: "Load holidays for 2026" }).click();

  await expect(page.getByText("Loaded 2 public holidays for 2026.")).toBeVisible();
  await expect(page.getByText("Neujahr", { exact: true })).toBeVisible();
  await expect(page.getByText("Fronleichnam", { exact: true })).toBeVisible();
  await expect(page.getByText("Clinic day")).toContainText("added by hand");
  await expect(page.getByText("Team day")).toContainText("added by hand");
  await expect(page.getByText("Heiligabend (Klinik)")).toBeVisible();
  await expect(page.getByText("Heilige Drei Könige")).toHaveCount(0);
  await expect(page.getByText("Internationaler Frauentag")).toHaveCount(0);
  await expect
    .poll(() => {
      const saved = api.state();
      return {
        region: saved.holidayRegion,
        holidays: (saved.holidays ?? []).map((h) => `${h.dateISO} ${h.name}:${h.source ?? "untagged"}`).sort(),
      };
    })
    .toEqual({
      region: "DE-NW",
      holidays: [
        "2026-01-01 Neujahr:public",
        "2026-01-15 Team day:manual",
        "2026-03-02 Clinic day:manual",
        "2026-06-04 Fronleichnam:public",
        "2026-12-24 Heiligabend (Klinik):untagged",
      ],
    });
  expect(api.errors).toEqual([]);
});
