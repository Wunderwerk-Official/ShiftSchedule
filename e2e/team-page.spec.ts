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

async function openCalendar(page: Page, state: AppState, now: string) {
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
  await page.route("**/v1/**", (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/v1/state")) {
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
  await expect(page.locator('[data-schedule-grid="true"]')).toBeVisible();
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

  await page.getByRole("button", { name: /^1 Split Shift$/ }).click();
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
  expect(await columnCount()).toBe(7);
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

  // Poll: the labels first render from the state before the mocked one is
  // applied (a one-shot read failed locally in 5 of 6 runs).
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
    await expect(page.getByText("Wed, Jan 7")).toBeVisible();
    await page.getByRole("button", { name: /Open Slots$/ }).click();
    await expect(page.getByText("Mon, Jan 5")).toBeVisible();
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
    await page.getByRole("button", { name: "Replace shifts" }).click();
    await expect(
      page.getByText("The current calendar cannot be saved. Fix its template first."),
    ).toBeVisible();
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
  const importFile = (page: Page) =>
    page.locator('input[type="file"][accept="application/json"]').setInputFiles({
      name: "shifts.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify({ assignments: [assignment("new", "mon", "MRI", SECOND)] })),
    });
  const hasNew = (posted: AppState) => (posted.assignments ?? []).some((item) => item.id === "new");

  test("saves a backup of the shown calendar before replacing the shifts", async ({ page }) => {
    const state = structuredClone(defaultState);
    state.assignments = [assignment("old", "mon", "CT", FIRST)];
    const api = await openCalendar(page, state, "2026-01-05T08:00:00Z");
    const backups: AppState[] = [];
    let postsAtBackup = -1;
    await page.route("**/v1/state/snapshots/import-backup", (route) => {
      backups.push((route.request().postDataJSON() as { state: AppState }).state);
      postsAtBackup = api.statePosts.length;
      const at = "2026-01-05T08:00:00Z";
      return route.fulfill({
        status: 201,
        json: { id: "auto", name: BACKUP_NAME, kind: "auto_backup", created_at: at, updated_at: at, size_bytes: 1 },
      });
    });

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await importFile(page);
    await expect(page.getByRole("dialog")).toContainText("The current calendar is saved in Calendar snapshots first.");
    await page.getByRole("button", { name: "Replace shifts" }).click();

    await expect(page.getByText(`A backup of the previous calendar is in Calendar snapshots: “${BACKUP_NAME}”.`)).toBeVisible();
    expect(backups).toHaveLength(1);
    expect(backups[0].assignments?.map((item) => item.id)).toEqual(["old"]);
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
