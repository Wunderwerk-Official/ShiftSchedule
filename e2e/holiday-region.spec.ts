import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import type { AppState } from "../src/api/client";

// Settings → Holidays on a mocked API: the state picked there filters the
// regional holidays date.nager.at returns and is saved with the calendar. A
// holiday change that removes planned shifts asks first and backs up.

const defaultState = JSON.parse(
  readFileSync(new URL("../backend/default_state.json", import.meta.url), "utf8"),
) as AppState;

const nationwide = (date: string, localName: string) => ({ date, localName, global: true, counties: null });
const regional = (date: string, localName: string, counties: string[]) => ({
  date,
  localName,
  global: false,
  counties,
});

// date.nager.at's answer for Germany 2026, reduced to the fields the app reads.
const germany2026 = [
  nationwide("2026-01-01", "Neujahr"),
  regional("2026-01-06", "Heilige Drei Könige", ["DE-BW", "DE-BY", "DE-ST"]),
  regional("2026-03-08", "Internationaler Frauentag", ["DE-BE", "DE-MV"]),
  nationwide("2026-04-03", "Karfreitag"),
  regional("2026-04-05", "Ostersonntag", ["DE-BB"]),
  nationwide("2026-04-06", "Ostermontag"),
  nationwide("2026-05-01", "Tag der Arbeit"),
  nationwide("2026-05-14", "Christi Himmelfahrt"),
  regional("2026-05-24", "Pfingstsonntag", ["DE-BB"]),
  nationwide("2026-05-25", "Pfingstmontag"),
  regional("2026-06-04", "Fronleichnam", ["DE-BW", "DE-BY", "DE-HE", "DE-NW", "DE-RP", "DE-SL"]),
  regional("2026-08-15", "Mariä Himmelfahrt", ["DE-SL"]),
  regional("2026-09-20", "Weltkindertag", ["DE-TH"]),
  nationwide("2026-10-03", "Tag der Deutschen Einheit"),
  regional("2026-10-31", "Reformationstag", [
    "DE-BB", "DE-MV", "DE-SN", "DE-ST", "DE-TH", "DE-HB", "DE-HH", "DE-NI", "DE-SH",
  ]),
  regional("2026-11-01", "Allerheiligen", ["DE-BW", "DE-BY", "DE-NW", "DE-RP", "DE-SL"]),
  regional("2026-11-18", "Buß- und Bettag", ["DE-SN"]),
  nationwide("2026-12-25", "Erster Weihnachtstag"),
  nationwide("2026-12-26", "Zweiter Weihnachtstag"),
];

// Holds a mocked request until release() is called.
function gate() {
  let release!: () => void;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { opened, release };
}

async function openHolidaySettings(
  page: Page,
  state: AppState,
  hold: { backup?: Promise<void>; holidays?: Promise<void> } = {},
) {
  let current = { ...state, revision: "r0" } as AppState;
  const statePosts: AppState[] = [];
  const holidayRequests: string[] = [];
  const backups: Array<{ state: AppState; reason?: string }> = [];
  await page.addInitScript(() => localStorage.setItem("authToken", "test-token"));
  await page.route("**/auth/me", (route) =>
    route.fulfill({ json: { username: "test", role: "user", active: true } }),
  );
  await page.route("https://date.nager.at/**", async (route) => {
    holidayRequests.push(new URL(route.request().url()).pathname);
    await hold.holidays;
    return route.fulfill({ json: germany2026 });
  });
  await page.route("**/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/v1/state")) {
      if (request.method() === "POST") {
        statePosts.push(request.postDataJSON() as AppState);
        current = { ...request.postDataJSON(), revision: `r${statePosts.length}` };
      }
      return route.fulfill({ json: current });
    }
    if (path.endsWith("/v1/state/snapshots/import-backup")) {
      backups.push(request.postDataJSON());
      await hold.backup;
      return route.fulfill({
        status: 201,
        json: { id: "backup", name: "Auto-backup before holiday change", kind: "auto_backup",
          created_at: "", updated_at: "", size_bytes: 1 },
      });
    }
    if (path.endsWith("/v1/me/preferences")) return route.fulfill({ json: {} });
    if (path.endsWith("/solve/runs")) return route.fulfill({ json: { runs: [] } });
    if (path.endsWith("/agent/settings")) {
      return route.fulfill({ json: { effective_model: "mock", budget_usd: 5, remaining_usd: 5 } });
    }
    return route.fulfill({ json: { enabled: false } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByText("Load public holidays")).toBeVisible();
  return { saved: () => statePosts.at(-1), holidayRequests, backups };
}

const holidayNames = (state: AppState | undefined) =>
  (state?.holidays ?? []).filter((holiday) => holiday.dateISO.startsWith("2026-")).map((holiday) => holiday.name);

// Shifts on days whose plan the NW holidays change: the holiday column of
// Buß- und Bettag (Wed 18.11., Sachsen only) and Heilige Drei Könige
// (Tue 06.01., not NW). Fronleichnam stays a holiday, 02.11. a Monday.
const HOLIDAY_DAY = "slot-b790ae7e-9254-4986-8056-085d54e8679f";
const HOLIDAY_NIGHT = "slot-c34ea56c-f2da-48f9-bd11-fd4a0fc8ec12";
const MONDAY = "slot-f5d6e25c-f2b1-4459-94bc-53f2bb2ecdad";
const plannedShifts: AppState["assignments"] = [
  { id: "bbt-1", rowId: HOLIDAY_NIGHT, dateISO: "2026-11-18", clinicianId: "alex-hartmann", source: "solver" },
  { id: "bbt-2", rowId: HOLIDAY_DAY, dateISO: "2026-11-18", clinicianId: "clin-leonardo-davinci-mjyhx959", source: "manual" },
  { id: "hdk", rowId: HOLIDAY_DAY, dateISO: "2026-01-06", clinicianId: "alex-hartmann", source: "solver", locked: true },
  { id: "fron", rowId: HOLIDAY_DAY, dateISO: "2026-06-04", clinicianId: "alex-hartmann", source: "solver" },
  { id: "mon", rowId: MONDAY, dateISO: "2026-11-02", clinicianId: "alex-hartmann", source: "solver" },
];
const shiftIds = (state: AppState | undefined) => (state?.assignments ?? []).map((a) => a.id).sort();

test("a chosen state filters the loaded holidays and is saved with the calendar", async ({ page }) => {
  const api = await openHolidaySettings(page, defaultState);
  // The start state holds the holidays of all 16 states.
  await expect(page.getByText("Without a state, the regional holidays of all states are included.")).toBeVisible();
  await expect(page.getByText("Buß- und Bettag", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "All states" }).click();
  await page.getByRole("button", { name: "Nordrhein-Westfalen" }).click();
  await expect.poll(() => api.saved()?.holidayRegion).toBe("DE-NW");
  // Choosing a state does not rewrite the stored list by itself.
  await expect(page.getByText("The list below is unchanged until you load holidays again.")).toBeVisible();
  await expect(page.getByText("Buß- und Bettag", { exact: true })).toBeVisible();
  expect(holidayNames(api.saved())).toHaveLength(19);

  await page.getByRole("button", { name: "Load Holidays" }).click();
  await expect(page.getByText("Buß- und Bettag", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Heilige Drei Könige", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Fronleichnam", { exact: true })).toBeVisible();
  await expect(page.getByText("Allerheiligen", { exact: true })).toBeVisible();
  await expect(page.getByText(/unchanged until you load holidays again/)).toHaveCount(0);
  expect(api.holidayRequests).toEqual(["/api/v3/PublicHolidays/2026/DE"]);
  await expect.poll(() => holidayNames(api.saved()).length).toBe(11);
  expect(holidayNames(api.saved())).not.toContain("Buß- und Bettag");
  expect(api.saved()?.holidayRegion).toBe("DE-NW");
});

test("a stored state is shown and another country starts without one", async ({ page }) => {
  const api = await openHolidaySettings(page, { ...defaultState, holidayRegion: "DE-NW" });
  await expect(page.getByRole("button", { name: "Nordrhein-Westfalen" })).toBeVisible();
  await expect(page.getByText(/regional holidays of all states/)).toHaveCount(0);

  await page.getByRole("button", { name: "Germany 🇩🇪" }).click();
  await page.getByRole("button", { name: "Switzerland 🇨🇭" }).click();
  await expect(page.getByRole("button", { name: "All cantons" })).toBeVisible();
  await expect.poll(() => api.saved()?.holidayCountry).toBe("CH");
  expect(api.saved()).not.toHaveProperty("holidayRegion");
});

test("loading another state's holidays asks before it removes the shifts that no longer fit", async ({ page }) => {
  const api = await openHolidaySettings(page, { ...defaultState, assignments: plannedShifts });
  await page.getByRole("button", { name: "All states" }).click();
  await page.getByRole("button", { name: "Nordrhein-Westfalen" }).click();
  await expect.poll(() => api.saved()?.holidayRegion).toBe("DE-NW");

  await page.getByRole("button", { name: "Load Holidays" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(
    "3 shifts, 2 of them locked, no longer fit their day's plan and will be removed: " +
      "Tue 06.01.2026 (1 shift), Wed 18.11.2026 (2 shifts).",
  );
  await expect(dialog).toContainText("An automatic backup of the calendar is saved in Calendar snapshots first.");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  // Cancelled: the holidays and the shifts stay, nothing is backed up.
  await expect(page.getByText("Buß- und Bettag", { exact: true })).toBeVisible();
  await expect(page.getByText(/unchanged until you load holidays again/)).toBeVisible();
  await page.waitForTimeout(700); // longer than the save debounce
  expect(api.backups).toHaveLength(0);
  expect(holidayNames(api.saved())).toHaveLength(19);
  expect(shiftIds(api.saved())).toEqual(["bbt-1", "bbt-2", "fron", "hdk", "mon"]);

  await page.getByRole("button", { name: "Load Holidays" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Remove 3 shifts" }).click();
  await expect(page.getByText("Loaded 11 public holidays for 2026.")).toBeVisible();
  await expect(page.getByText("Buß- und Bettag", { exact: true })).toHaveCount(0);
  // The backup holds the calendar as it was; the saved one lacks the shifts.
  expect(api.backups).toHaveLength(1);
  expect(api.backups[0].reason).toBe("holiday_change");
  expect(shiftIds(api.backups[0].state)).toEqual(["bbt-1", "bbt-2", "fron", "hdk", "mon"]);
  expect(holidayNames(api.backups[0].state)).toHaveLength(19);
  await expect.poll(() => holidayNames(api.saved()).length).toBe(11);
  expect(shiftIds(api.saved())).toEqual(["fron", "mon"]);
});

test("removed shifts stay removed when the holiday comes back", async ({ page }) => {
  const api = await openHolidaySettings(page, { ...defaultState, assignments: plannedShifts });
  const bussUndBettag = page.locator("div.grid", { hasText: "Buß- und Bettag" });
  await bussUndBettag.getByRole("button", { name: "Remove" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("2 shifts, 1 of them locked, no longer fit their day's plan");
  await dialog.getByRole("button", { name: "Remove 2 shifts" }).click();
  await expect(page.getByText("Buß- und Bettag", { exact: true })).toHaveCount(0);
  await expect.poll(() => shiftIds(api.saved())).toEqual(["fron", "hdk", "mon"]);
  expect(api.backups.map((backup) => backup.reason)).toEqual(["holiday_change"]);

  // Loading all states' holidays brings Buß- und Bettag back without
  // touching other days (no question), and not the removed shifts.
  await page.getByRole("button", { name: "Load Holidays" }).click();
  await expect(page.getByText("Loaded 19 public holidays for 2026.")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(() => holidayNames(api.saved())).toContain("Buß- und Bettag");
  expect(shiftIds(api.saved())).toEqual(["fron", "hdk", "mon"]);
  expect(api.backups).toHaveLength(1);
});

test("the screen waits while the backup is saved, so no other change is lost", async ({ page }) => {
  const backup = gate();
  const api = await openHolidaySettings(page, { ...defaultState, assignments: plannedShifts }, {
    backup: backup.opened,
  });
  await page.locator("div.grid", { hasText: "Buß- und Bettag" }).getByRole("button", { name: "Remove" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Remove 2 shifts" }).click();
  // While the backup is being saved, the calendar cannot be changed: removing
  // Neujahr (no shifts, so no question) is blocked instead of being undone
  // when the first change applies.
  await expect(page.getByRole("status")).toHaveText("Updating calendar…");
  await expect.poll(() => api.backups.length).toBe(1);
  const neujahr = page.locator("div.grid", { hasText: "Neujahr" }).getByRole("button", { name: "Remove" });
  await expect(neujahr.click({ timeout: 500 })).rejects.toThrow();
  await expect(page.getByText("Buß- und Bettag", { exact: true })).toBeVisible();

  backup.release();
  await expect(page.getByRole("status")).toHaveCount(0);
  await expect(page.getByText("Buß- und Bettag", { exact: true })).toHaveCount(0);
  await neujahr.click();
  await expect(page.getByText("Neujahr", { exact: true })).toHaveCount(0);
  await expect.poll(() => holidayNames(api.saved())).toHaveLength(17);
  expect(holidayNames(api.saved())).not.toContain("Neujahr");
  expect(holidayNames(api.saved())).not.toContain("Buß- und Bettag");
  expect(shiftIds(api.saved())).toEqual(["fron", "hdk", "mon"]);
  expect(api.backups).toHaveLength(1);
});

test("holidays loaded while a removal waits for its answer are refused, not overwritten", async ({ page }) => {
  const holidays = gate();
  const withoutLabourDay = (defaultState.holidays ?? []).filter((holiday) => holiday.dateISO !== "2026-05-01");
  const api = await openHolidaySettings(
    page,
    { ...defaultState, holidays: withoutLabourDay, assignments: plannedShifts },
    { holidays: holidays.opened },
  );
  await expect(page.getByText("Tag der Arbeit", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Load Holidays" }).click();
  await expect.poll(() => api.holidayRequests.length).toBe(1);
  await page.locator("div.grid", { hasText: "Buß- und Bettag" }).getByRole("button", { name: "Remove" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("2 shifts, 1 of them locked");

  // The loaded list (which brings back Tag der Arbeit) arrives meanwhile.
  holidays.release();
  await expect(
    page.getByText("Another change to the calendar is in progress, so the holidays were not changed. Try again when it is done."),
  ).toBeVisible();
  await expect(page.getByText("Tag der Arbeit", { exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Remove 2 shifts" }).click();
  await expect(page.getByText("Buß- und Bettag", { exact: true })).toHaveCount(0);
  await expect.poll(() => shiftIds(api.saved())).toEqual(["fron", "hdk", "mon"]);
  expect(holidayNames(api.saved())).toHaveLength(17);

  // Loading again applies the list.
  await page.getByRole("button", { name: "Load Holidays" }).click();
  await expect(page.getByText("Loaded 19 public holidays for 2026.")).toBeVisible();
  await expect(page.getByText("Tag der Arbeit", { exact: true })).toBeVisible();
  await expect.poll(() => holidayNames(api.saved())).toHaveLength(19);
  expect(shiftIds(api.saved())).toEqual(["fron", "hdk", "mon"]);
  expect(api.backups).toHaveLength(1);
});
