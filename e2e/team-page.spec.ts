import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import type { AppState, Assignment } from "../src/api/client";

// Team page behaviour on a mocked API: the rule-violation and split-shift
// popovers, badge jumps in the phone day view, the "template too large"
// banner and "Reset Solver Only" on vacation days.

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

  test("importing a schedule snapshot is refused", async ({ page }) => {
    const api = await openCalendar(page, oversizedState().state, "2026-01-05T08:00:00Z");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.locator('input[type="file"][accept="application/json"]').setInputFiles({
      name: "snapshot.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify({ assignments: [assignment("ct", "mon", "CT", FIRST)] })),
    });
    await page.getByRole("button", { name: "Import snapshot" }).click();
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

test("Reset Solver Only also removes planner entries on vacation days", async ({ page }) => {
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
  await page.getByRole("button", { name: /Reset Solver Only/ }).click();
  await expect
    .poll(() => api.state().assignments.map((item) => item.id).sort())
    .toEqual(["manual"]);
  expect(api.errors).toEqual([]);
});

test("Reset Unfixed removes planner entries on vacation days and keeps manual ones there", async ({ page }) => {
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
  await page.getByRole("button", { name: /Reset Unfixed/ }).click();
  await expect
    .poll(() => api.state().assignments.map((item) => item.id).sort())
    .toEqual(["fixed", "hidden-manual"]);
  expect(api.errors).toEqual([]);
});
