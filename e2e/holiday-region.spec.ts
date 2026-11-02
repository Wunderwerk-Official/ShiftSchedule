import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import type { AppState } from "../src/api/client";

// Settings → Holidays on a mocked API: the state picked there filters the
// regional holidays date.nager.at returns and is saved with the calendar.

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

async function openHolidaySettings(page: Page, state: AppState) {
  let current = { ...state, revision: "r0" } as AppState;
  const statePosts: AppState[] = [];
  const holidayRequests: string[] = [];
  await page.addInitScript(() => localStorage.setItem("authToken", "test-token"));
  await page.route("**/auth/me", (route) =>
    route.fulfill({ json: { username: "test", role: "user", active: true } }),
  );
  await page.route("https://date.nager.at/**", (route) => {
    holidayRequests.push(new URL(route.request().url()).pathname);
    return route.fulfill({ json: germany2026 });
  });
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
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByText("Load public holidays")).toBeVisible();
  return { saved: () => statePosts.at(-1), holidayRequests };
}

const holidayNames = (state: AppState | undefined) =>
  (state?.holidays ?? []).filter((holiday) => holiday.dateISO.startsWith("2026-")).map((holiday) => holiday.name);

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
