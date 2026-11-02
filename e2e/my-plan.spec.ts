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
  // Now that I am linked, my team pills carry the own outline (people are
  // always colored by person since v1.69).
  const myPill = page.locator(`[data-assignment-key="${NEXT_MONDAY_CT}__2026-01-12__${ME}"]`);
  await expect(myPill).toHaveCSS("outline-style", "solid");
  expectNoPreferencesInState(api.statePosts);
  expect(api.errors).toEqual([]);
});

test("the calendar always opens in Team, even with a stored My-plan start view; the team pills carry person colors", async ({ page }) => {
  // A start view saved before v1.74 (the star is gone) is stored but ignored.
  const api = await openCalendar(page, {
    initialPrefs: { startViewDesktop: { scope: "me", range: "week", orientation: "top" } },
  });
  const scope = page.getByRole("group", { name: "Choose plan" });
  await expect(scope.getByRole("button", { name: "Team" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Start page on computers" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Views", exact: true })).toHaveCount(0);

  // Link via "That's me".
  await scope.getByRole("button", { name: "My plan" }).click();
  await page.getByLabel("I am", { exact: true }).selectOption({ label: "Galileo Galilei" });
  await page.getByRole("button", { name: "That's me" }).click();
  await expect.poll(() => api.prefs().clinicianId).toBe(ME);
  await expect(page.getByRole("group", { name: "Week, days side by side" })).toBeVisible();
  // The circle's initials are named in the tooltip and the accessible name.
  const myPlan = scope.getByRole("button", { name: "My plan (Galileo Galilei)" });
  await expect(myPlan).toHaveAttribute("title", "My plan · Galileo Galilei");
  await expect(myPlan).toContainText("GG");
  const putsBeforeReload = api.prefsPuts.length;

  // Reload: still Team (no My-plan flash once the preferences arrive), and
  // opening the app writes nothing.
  await page.addInitScript(() => {
    new MutationObserver(() => {
      if (document.querySelector('[aria-label="Week, days side by side"]')) {
        (window as unknown as { myPlanSeen?: boolean }).myPlanSeen = true;
      }
    }).observe(document, { childList: true, subtree: true });
  });
  const prefsLoaded = page.waitForResponse(
    (response) => response.url().endsWith("/v1/me/preferences") && response.request().method() === "GET",
  );
  await page.reload();
  await prefsLoaded;
  await expect(page.locator('[data-schedule-grid="true"]')).toBeVisible();
  // Longer than the 600 ms save delay: a start view applied late would show
  // up here (scope switch or a PUT).
  await page.waitForTimeout(900);
  await expect(scope.getByRole("button", { name: "Team" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('[data-schedule-grid="true"]')).toBeVisible();
  const myPlanSeen = await page.evaluate(() => (window as unknown as { myPlanSeen?: boolean }).myPlanSeen);
  expect(myPlanSeen ?? false).toBe(false);
  expect(api.prefsPuts.slice(putsBeforeReload)).toEqual([]);
  expect(api.prefs().startViewDesktop?.scope).toBe("me");

  // Team plan: people always have their own color (no "Color by" switch
  // since v1.69); my pills get my person color and the outline.
  await expect(page.getByRole("group", { name: "Color by" })).toHaveCount(0);
  const myPill = page.locator(`[data-assignment-key$="__2026-01-07__${ME}"]`).first();
  // Person palette p01 (first clinician): strong #4338CA, light #A5B4FC.
  await expect(myPill).toHaveCSS("border-top-color", "rgb(67, 56, 202)");
  await expect(myPill).toHaveCSS("background-color", "rgb(165, 180, 252)");
  await expect(myPill).toHaveCSS("outline-style", "solid");
  expectNoPreferencesInState(api.statePosts);
  expect(api.errors).toEqual([]);
});

test("'Not <name>? Change who you are' unlinks the account, so My plan asks again", async ({ page }) => {
  const api = await openCalendar(page, { initialPrefs: { clinicianId: ME } });
  const scope = page.getByRole("group", { name: "Choose plan" });
  await scope.getByRole("button", { name: "My plan (Galileo Galilei)" }).click();
  await expect(page.getByRole("group", { name: "Week, days side by side" })).toBeVisible();

  // The arrow next to the switch: its last entry names the linked person.
  await page.getByRole("button", { name: "Open the plan of another person" }).click();
  const picker = page.getByRole("dialog", { name: "Choose person" });
  await picker.getByRole("button", { name: "Not Galileo Galilei? Change who you are" }).click();
  await expect(picker).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Who are you in the plan?" })).toBeVisible();
  await expect.poll(() => api.prefsPuts).toEqual([{ clinicianId: null }]);
  expect(api.prefs().clinicianId).toBeNull();
  // The circle is gone with the link.
  await expect(scope.getByRole("button", { name: "My plan", exact: true })).toBeVisible();
  expectNoPreferencesInState(api.statePosts);
  expect(api.errors).toEqual([]);
});

test("both plans wait for the calendar: no demo calendar in Team, no stale link in My plan", async ({ page }) => {
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
    initialPrefs: { clinicianId: REAL },
    stateGate,
  });

  // Preferences are in (linked to REAL), the calendar is not. The team plan
  // shows the loading card instead of the built-in demo calendar and its
  // controls (edits there would be lost); My plan shows it too, with no
  // "Who are you" card listing the demo people.
  await prefsAnswered;
  const scope = page.getByRole("group", { name: "Choose plan" });
  await expect(scope.getByRole("button", { name: "Team" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("region", { name: "Team plan" }).getByText("Loading calendar…")).toBeVisible();
  await expect(page.locator('[data-schedule-grid="true"]')).toHaveCount(0);
  await expect(page.getByRole("switch")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /open slots?$/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open Vacation Planner" })).toBeHidden();
  await scope.getByRole("button", { name: "My plan" }).click();
  await page.waitForTimeout(300);
  await expect(page.getByRole("region", { name: "My plan" }).getByText("Loading calendar…")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Who are you in the plan?" })).toHaveCount(0);
  await expect(page.locator('[data-schedule-grid="true"]')).toHaveCount(0);

  // The loading card keeps the switch (v1.77): back to Team and again to My plan.
  await expect(scope.getByRole("button", { name: "My plan" })).toHaveAttribute("aria-pressed", "true");
  await scope.getByRole("button", { name: "Team" }).click();
  await expect(page.getByRole("region", { name: "Team plan" }).getByText("Loading calendar…")).toBeVisible();
  await expect(page.locator('[data-schedule-grid="true"]')).toHaveCount(0);
  await scope.getByRole("button", { name: "My plan" }).click();
  await expect(page.getByText("Loading calendar…")).toBeVisible();

  // Settings wait too: the demo calendar's people, shifts and rules are not
  // offered for editing (the real calendar would overwrite those edits).
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("region", { name: "Settings" }).getByText("Loading calendar…")).toBeVisible();
  await expect(page.getByText("Set up locations, shifts, people, holidays and planning rules")).toHaveCount(0);
  await expect(page.getByRole("textbox")).toHaveCount(0);
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.getByRole("region", { name: "My plan" }).getByText("Loading calendar…")).toBeVisible();

  releaseState();
  await expect(page.getByRole("group", { name: "Week, days side by side" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^CT, / })).toHaveCount(1);
  await expect(page.getByText("Loading calendar…")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Who are you in the plan?" })).toHaveCount(0);
  // Back in Team: the real calendar.
  await scope.getByRole("button", { name: "Team" }).click();
  await expect(page.locator('[data-schedule-grid="true"]')).toBeVisible();
  expect(api.prefsPuts).toEqual([]);
  expect(api.errors).toEqual([]);
});

test("My plan keeps its own day in the address: a reload brings back its month and day", async ({ page }) => {
  const api = await openCalendar(page, { initialPrefs: { clinicianId: ME, myPlanRange: "month" } });
  const scope = page.getByRole("group", { name: "Choose plan" });
  const search = () => page.evaluate(() => window.location.search);
  const showsText = (text: string | RegExp) =>
    expect(page.locator('[aria-live="polite"]').filter({ hasText: text })).toHaveCount(1);

  await scope.getByRole("button", { name: "My plan" }).click();
  await showsText(/^January 2026,/);
  await page.getByRole("button", { name: "Next month" }).click();
  await showsText(/^February 2026,/);
  // 1 February is a Sunday: the Monday of its team week lies in January.
  await expect.poll(search).toBe("?week=2026-02-01");

  // The calendar reopens in Team, on that day's week (named by its Monday);
  // My plan still shows February, not the Monday's January.
  await page.reload();
  await expect(page.getByRole("button", { name: "Pick a week" })).toHaveText(/26\.01\.2026 – 01\.02\.2026/);
  await expect.poll(search).toBe("?week=2026-01-26");
  await scope.getByRole("button", { name: "My plan" }).click();
  await showsText(/^February 2026,/);
  await expect.poll(search).toBe("?week=2026-02-01");

  // Day range: the day itself, not its Monday.
  await page.getByRole("group", { name: "Period" }).getByRole("button", { name: "Day" }).click();
  await page.getByRole("button", { name: "Next day" }).click();
  await page.getByRole("button", { name: "Next day" }).click();
  await expect.poll(search).toBe("?week=2026-02-03");
  await page.reload();
  await scope.getByRole("button", { name: "My plan" }).click();
  await showsText(/3 Feb 2026/);
  expect(api.errors).toEqual([]);
});

test("signing out first sends a preference change still waiting to be saved, with the token", async ({ page }) => {
  const api = await openCalendar(page);
  await page.getByRole("group", { name: "Times" }).getByRole("button", { name: "Side by side" }).click();
  // Sign out at once, before the 600 ms save delay is over.
  await page.getByRole("button", { name: "Account", exact: true }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  expect(api.prefsPuts).toEqual([{ teamTimeLayout: "columns" }]);
  expect(api.prefsPutAuth).toEqual(["Bearer test-token"]);
  expect(api.errors).toEqual([]);
});

test("a location color is saved with the calendar and colors the team rows", async ({ page }) => {
  const api = await openCalendar(page);
  const grid = page.locator('[data-schedule-grid="true"]');
  const firstLabel = grid.locator("[data-label-shade]").first();
  const band = grid.locator('[data-location-band="true"]').first();
  // Without a color of its own the first location is blue (Auto): label
  // ground #DBEAFE, band #1D4ED8 with the name in white.
  await expect(firstLabel).toHaveCSS("background-color", "rgb(219, 234, 254)");
  await expect(band).toHaveText("Berlin");
  await expect(band).toHaveCSS("color", "rgb(255, 255, 255)");
  await expect(grid.locator('div.row:has([data-location-band="true"])').first()).toHaveCSS(
    "background-color",
    "rgb(29, 78, 216)",
  );

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Location color for Berlin: Auto (Blue)" }).click();
  await page.getByRole("dialog", { name: "Location color for Berlin" }).getByRole("button", { name: "Sand" }).click();
  await expect.poll(() => api.state().locations?.[0]?.color).toBe("#EEDFC4");

  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(grid).toBeVisible();
  // Sand: the first row band's labels get the ground #EEDFC4 and the ink
  // #5A3E0E, the band #7A5E2E; the next row band the stronger #E2C99E.
  await expect(firstLabel).toHaveCSS("background-color", "rgb(238, 223, 196)");
  await expect(firstLabel.locator("span").first()).toHaveCSS("color", "rgb(90, 62, 14)");
  await expect(grid.locator('[data-label-shade="#E2C99E"]').first()).toBeVisible();
  await expect(grid.locator('div.row:has([data-location-band="true"])').first()).toHaveCSS(
    "background-color",
    "rgb(122, 94, 46)",
  );

  const colored = api.statePosts.at(-1)!;
  expect(colored.locations).toEqual([{ id: "loc-default", name: "Berlin", color: "#EEDFC4" }]);

  // "Auto" removes the color again; both saves differ in nothing but the color.
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Location color for Berlin: Sand" }).click();
  await page.getByRole("dialog", { name: "Location color for Berlin" }).getByRole("button", { name: "Auto" }).click();
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
