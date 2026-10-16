import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import type { AppState, Assignment, UserPreferences } from "../src/api/client";

// "My plan" end to end on the real UI with a mocked API (state and per-user
// preferences): switch scope, link the account to a person, change range
// and orientation, open a shift and jump back into the team plan.

const defaultState = JSON.parse(
  readFileSync(new URL("../backend/default_state.json", import.meta.url), "utf8"),
) as AppState;

const ME = "alex-hartmann"; // "Galileo Galilei"
const COLLEAGUE = defaultState.clinicians[1].id;

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

const NEXT_MONDAY_CT = slotId("mon", "CT");
// Per-user preferences must never leak into the shared calendar (AppState).
const PREFERENCE_KEYS = [
  "clinicianId",
  "savedViews",
  "teamColorBy",
  "teamTimeLayout",
  "myPlanRange",
  "myPlanRangeMobile",
  "orientationByRange",
  "orientationByRangeMobile",
  "startViewDesktop",
  "startViewMobile",
];

function assignments(): Assignment[] {
  const mine: Array<[string, string, string]> = [
    ["2026-01-05", "mon", "MRI"],
    ["2026-01-07", "wed", "CT"],
    ["2026-01-07", "wed", "MRI Neuro"],
    ["2026-01-09", "fri", "Sonography"],
  ];
  return [
    ...mine.map(([dateISO, dayType, section], index) => ({
      id: `mine-${index}`,
      rowId: slotId(dayType, section),
      dateISO,
      clinicianId: ME,
      source: "manual" as const,
    })),
    { id: "mine-next", rowId: NEXT_MONDAY_CT, dateISO: "2026-01-12", clinicianId: ME, source: "manual" },
    { id: "colleague", rowId: slotId("wed", "MRI"), dateISO: "2026-01-07", clinicianId: COLLEAGUE, source: "manual" },
  ];
}

function initialCalendarState(): AppState {
  return { ...structuredClone(defaultState), assignments: assignments(), revision: "r0" } as AppState;
}

async function openCalendar(
  page: Page,
  {
    waitForGrid = true,
    initialState = initialCalendarState(),
    initialPrefs = {},
    stateGate,
  }: {
    waitForGrid?: boolean;
    initialState?: AppState;
    initialPrefs?: Partial<UserPreferences>;
    /** GET /v1/state answers only once this resolves (a slow calendar load). */
    stateGate?: Promise<void>;
  } = {},
) {
  let state = initialState;
  let prefs: Partial<UserPreferences> = initialPrefs;
  const prefsPuts: Partial<UserPreferences>[] = [];
  const prefsPutAuth: (string | undefined)[] = [];
  const statePosts: AppState[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // Wed 7 Jan 2026, 09:00 in Berlin (the test pins the browser time zone).
  await page.clock.setFixedTime(new Date("2026-01-07T08:00:00Z"));
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
        state = { ...request.postDataJSON(), revision: `r${Date.now()}` };
      }
      return route.fulfill({ json: state });
    }
    if (path.endsWith("/v1/me/preferences")) {
      if (request.method() === "PUT") {
        // Like the server: store only the top-level keys sent, return the merged document.
        const changes = request.postDataJSON() as Partial<UserPreferences>;
        prefsPuts.push(changes);
        prefsPutAuth.push(request.headers().authorization);
        prefs = { ...prefs, ...changes };
      }
      return route.fulfill({ json: prefs });
    }
    if (path.endsWith("/solve/runs")) return route.fulfill({ json: { runs: [] } });
    if (path.endsWith("/agent/settings")) {
      return route.fulfill({ json: { effective_model: "mock", budget_usd: 5, remaining_usd: 5 } });
    }
    return route.fulfill({ json: { enabled: false } });
  });
  await page.goto("/");
  if (waitForGrid) await expect(page.locator('[data-schedule-grid="true"]')).toBeVisible();
  return { state: () => state, prefs: () => prefs, prefsPuts, prefsPutAuth, statePosts, errors };
}

function expectNoPreferencesInState(statePosts: AppState[]) {
  for (const body of statePosts) {
    expect(Object.keys(body).filter((key) => PREFERENCE_KEYS.includes(key))).toEqual([]);
  }
}

test.use({ timezoneId: "Europe/Berlin", viewport: { width: 1400, height: 900 } });

test("My plan: link yourself, change views and jump back into the team plan", async ({ page }) => {
  const api = await openCalendar(page);
  const scope = page.getByRole("group", { name: "Choose plan" });
  await expect(scope.getByRole("button", { name: "Team" })).toHaveAttribute("aria-pressed", "true");

  // Switch to My plan → not linked yet → "That's me".
  await scope.getByRole("button", { name: "My plan" }).click();
  await expect(page.getByRole("heading", { name: "Who are you in the plan?" })).toBeVisible();
  await page.getByLabel("I am", { exact: true }).selectOption({ label: "Galileo Galilei" });
  await page.getByRole("button", { name: "That's me" }).click();
  await expect.poll(() => api.prefs().clinicianId).toBe(ME);

  // The week shows the person's shifts (Mon MRI, Wed CT + MRI Neuro, Fri Sonography).
  const week = page.getByRole("group", { name: "Week, days side by side" });
  await expect(week).toBeVisible();
  const myShift = (name: string) => page.getByRole("button", { name: new RegExp(`^${name}, `) });
  await expect(myShift("MRI").first()).toBeVisible();
  await expect(myShift("CT")).toHaveCount(1);
  await expect(myShift("MRI Neuro")).toHaveCount(1);
  await expect(myShift("Sonography")).toHaveCount(1);
  // The colleague's Wednesday MRI is not part of my week.
  await expect(myShift("MRI")).toHaveCount(1);
  await expect(page.locator('[data-schedule-grid="true"]')).toHaveCount(0);
  // Planning panels below the calendar are hidden in My plan.
  await expect(page.getByRole("button", { name: "Open Vacation Planner" })).toBeHidden();

  const period = page.getByRole("group", { name: "Period" });
  const arrangement = page.getByRole("group", { name: "Arrangement of days" });

  // Day view (today = Wed): both Wednesday shifts, then date on left.
  await period.getByRole("button", { name: "Day" }).click();
  await expect(page.getByRole("group", { name: "Day, time runs down" }).first()).toBeVisible();
  await expect(myShift("CT").first()).toBeVisible();
  await arrangement.getByRole("button", { name: /Date on left/ }).click();
  await expect(page.getByRole("group", { name: "Day, time runs right" }).first()).toBeVisible();
  await expect(myShift("MRI Neuro").first()).toBeVisible();

  // Month: calendar, then the list (date on left).
  await period.getByRole("button", { name: "Month" }).click();
  await expect(page.getByRole("button", { name: /^Monday, 5 Jan 2026: / })).toBeVisible();
  await arrangement.getByRole("button", { name: /Date on left/ }).click();
  await expect(page.getByRole("button", { name: /^Monday, 5 Jan 2026: / })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Sonography 08:00/ }).first()).toBeVisible();

  // Week, date on left, then back to date on top.
  await period.getByRole("button", { name: "Week" }).click();
  await arrangement.getByRole("button", { name: /Date on left/ }).click();
  await expect(page.getByRole("group", { name: "Week, days stacked" })).toBeVisible();
  await expect(myShift("Sonography")).toHaveCount(1);
  await arrangement.getByRole("button", { name: /Date on top/ }).click();
  await expect(week).toBeVisible();
  await expect
    .poll(() => api.prefs().orientationByRange)
    .toEqual({ day: "left", week: "top", month: "left" });

  // Next week: open Monday's CT shift and show it in the team plan.
  await page.getByRole("button", { name: "Next week" }).click();
  const nextMonday = myShift("CT");
  await expect(nextMonday).toHaveCount(1);
  await expect(nextMonday).toHaveAccessibleName(/Monday 12 January, 08:00 to 12:00/);
  await nextMonday.click();
  const detail = page.getByRole("dialog");
  await expect(detail).toBeVisible();
  await detail.getByRole("button", { name: "Show in team plan" }).click();

  await expect(scope.getByRole("button", { name: "Team" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('[data-schedule-grid="true"]')).toBeVisible();
  await expect(
    page.locator(`[data-assignment-key="${NEXT_MONDAY_CT}__2026-01-12__${ME}"]`),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Open Vacation Planner" })).toBeVisible();
  // The team default look is unchanged although I am linked now: no inline
  // colors on any pill and no own outline (that belongs to Color by: Person).
  const grid = page.locator('[data-schedule-grid="true"]');
  const myPill = page.locator(`[data-assignment-key="${NEXT_MONDAY_CT}__2026-01-12__${ME}"]`);
  await expect(myPill).not.toHaveAttribute("style", /.+/);
  await expect(myPill).toHaveCSS("outline-style", "none");
  await expect(grid.locator('[data-assignment-pill="true"][style]')).toHaveCount(0);
  expectNoPreferencesInState(api.statePosts);
  expect(api.errors).toEqual([]);
});

test("My plan as start page opens directly; Color by person colors the team pills", async ({ page }) => {
  const api = await openCalendar(page);
  // Link + make My plan the start page on computers via the star.
  await page.getByRole("group", { name: "Choose plan" }).getByRole("button", { name: "My plan" }).click();
  await page.getByLabel("I am", { exact: true }).selectOption({ label: "Galileo Galilei" });
  await page.getByRole("button", { name: "That's me" }).click();
  await page.getByRole("button", { name: "Start page on computers" }).click();
  await expect.poll(() => api.prefs().startViewDesktop?.scope).toBe("me");

  // Reload: the start view is applied once the preferences have loaded, and
  // the team grid is never painted first (the calendar waits for them).
  await page.addInitScript(() => {
    new MutationObserver(() => {
      if (document.querySelector('[data-schedule-grid="true"]')) {
        (window as unknown as { teamGridSeen?: boolean }).teamGridSeen = true;
      }
    }).observe(document, { childList: true, subtree: true });
  });
  await page.reload();
  await expect(page.getByRole("group", { name: "Week, days side by side" })).toBeVisible();
  const teamGridSeen = await page.evaluate(() => (window as unknown as { teamGridSeen?: boolean }).teamGridSeen);
  expect(teamGridSeen ?? false).toBe(false);

  // Team plan, Color by: Person → my pills get my person color and the outline.
  const scope = page.getByRole("group", { name: "Choose plan" });
  await scope.getByRole("button", { name: "Team" }).click();
  const colorBy = page.getByRole("group", { name: "Color by" });
  await expect(colorBy.getByRole("button", { name: "Section" })).toHaveAttribute("aria-pressed", "true");
  await colorBy.getByRole("button", { name: "Person" }).click();
  const myPill = page.locator(`[data-assignment-key$="__2026-01-07__${ME}"]`).first();
  // Person palette p01 (first clinician): strong #1D4ED8, light #DBEAFE.
  await expect(myPill).toHaveCSS("border-top-color", "rgb(29, 78, 216)");
  await expect(myPill).toHaveCSS("background-color", "rgb(219, 234, 254)");
  await expect(myPill).toHaveCSS("outline-style", "solid");
  await expect.poll(() => api.prefs().teamColorBy).toBe("person");
  // Section again: the outline goes with the person colors.
  await colorBy.getByRole("button", { name: "Section" }).click();
  await expect(myPill).toHaveCSS("outline-style", "none");
  await expect(myPill).not.toHaveAttribute("style", /.+/);
  await expect.poll(() => api.prefs().teamColorBy).toBe("section");
  expectNoPreferencesInState(api.statePosts);
  expect(api.errors).toEqual([]);
});

test("My plan as start page waits for the calendar instead of calling the link stale", async ({ page }) => {
  // Real ids are not among the built-in demo people the page holds until
  // GET /v1/state answers (the e2e default state reuses the demo ids).
  const REAL = "clinician-real-1";
  const state = JSON.parse(
    JSON.stringify(initialCalendarState()).replaceAll(`"${ME}"`, `"${REAL}"`),
  ) as AppState;
  let releaseState!: () => void;
  const stateGate = new Promise<void>((resolve) => {
    releaseState = resolve;
  });
  const prefsAnswered = page.waitForResponse((response) =>
    response.url().endsWith("/v1/me/preferences"),
  );
  const api = await openCalendar(page, {
    waitForGrid: false,
    initialState: state,
    initialPrefs: {
      clinicianId: REAL,
      startViewDesktop: { scope: "me", range: "week", orientation: "top", colorBy: "section" },
    },
    stateGate,
  });

  // Preferences are in (start page: My plan), the calendar is not: only the
  // placeholder, no "Who are you" card listing the demo people.
  await prefsAnswered;
  await page.waitForTimeout(300);
  await expect(page.getByText("Loading calendar…")).toBeAttached();
  await expect(page.getByRole("heading", { name: "Who are you in the plan?" })).toHaveCount(0);
  await expect(page.locator('[data-schedule-grid="true"]')).toHaveCount(0);

  releaseState();
  await expect(page.getByRole("group", { name: "Week, days side by side" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^CT, / })).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "Who are you in the plan?" })).toHaveCount(0);
  expect(api.prefsPuts).toEqual([]);
  expect(api.errors).toEqual([]);
});

test("signing out first sends a preference change still waiting to be saved, with the token", async ({ page }) => {
  const api = await openCalendar(page);
  await page.getByRole("group", { name: "Color by" }).getByRole("button", { name: "Person" }).click();
  // Sign out at once, before the 600 ms save delay is over.
  await page.getByRole("button", { name: "Account", exact: true }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  expect(api.prefsPuts).toEqual([{ teamColorBy: "person" }]);
  expect(api.prefsPutAuth).toEqual(["Bearer test-token"]);
  expect(api.errors).toEqual([]);
});

test("a location color is saved with the calendar and tints the team rows", async ({ page }) => {
  const api = await openCalendar(page);
  const sand = 'background-color: rgb(238, 223, 196)'; // #EEDFC4
  const grid = page.locator('[data-schedule-grid="true"]');
  await expect(grid.locator(`[style*="${sand}"]`)).toHaveCount(0);

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Location color for Berlin" }).click();
  await page.getByRole("dialog", { name: "Location color for Berlin" }).getByRole("button", { name: "Sand" }).click();
  await expect.poll(() => api.state().locations?.[0]?.color).toBe("#EEDFC4");

  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(grid).toBeVisible();
  await expect(grid.locator(`[style*="${sand}"]`).first()).toBeVisible();
  // A row label cell gets the ground, its location line the ink (#5A3E0E).
  const locationLine = grid.locator('span[title="Berlin"]').first();
  await expect(locationLine).toHaveCSS("color", "rgb(90, 62, 14)");
  await expect(grid.locator('div.row:has(span[title="Berlin"])').first()).toHaveCSS(
    "background-color",
    "rgb(238, 223, 196)",
  );

  const colored = api.statePosts.at(-1)!;
  expect(colored.locations).toEqual([{ id: "loc-default", name: "Berlin", color: "#EEDFC4" }]);

  // "None" removes the color again; both saves differ in nothing but the color.
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Location color for Berlin" }).click();
  await page.getByRole("dialog", { name: "Location color for Berlin" }).getByRole("button", { name: "None" }).click();
  await expect.poll(() => api.state().locations?.[0]?.color ?? null).toBeNull();
  const cleared = api.statePosts.at(-1)!;
  expect(cleared.locations?.map(({ id, name }) => ({ id, name }))).toEqual([{ id: "loc-default", name: "Berlin" }]);
  expect({ ...colored, locations: cleared.locations, revision: cleared.revision }).toEqual(cleared);
  expectNoPreferencesInState(api.statePosts);
  expect(api.errors).toEqual([]);
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the scope switch leads to My plan and hides the planning panels", async ({ page }) => {
    const api = await openCalendar(page, { waitForGrid: false });
    const scope = page.getByRole("group", { name: "Choose plan" });
    await expect(scope.getByRole("button", { name: "Team" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator('[data-schedule-grid="true"]')).toBeVisible();
    const vacationPlanner = page.getByRole("button", { name: "Open Vacation Planner" });
    await expect(vacationPlanner).toBeVisible();

    await scope.getByRole("button", { name: "My plan" }).click();
    await page.getByLabel("I am", { exact: true }).selectOption({ label: "Galileo Galilei" });
    await page.getByRole("button", { name: "That's me" }).click();
    await expect.poll(() => api.prefs().clinicianId).toBe(ME);
    await expect(page.locator('[data-schedule-grid="true"]')).toHaveCount(0);
    await expect(vacationPlanner).toBeHidden();
    // Phones keep their own range: the week as a list of days.
    await expect(page.getByRole("button", { name: /^CT, / }).first()).toBeVisible();

    await scope.getByRole("button", { name: "Team" }).click();
    await expect(page.locator('[data-schedule-grid="true"]')).toBeVisible();
    await expect(vacationPlanner).toBeVisible();
    expectNoPreferencesInState(api.statePosts);
    expect(api.errors).toEqual([]);
  });
});
