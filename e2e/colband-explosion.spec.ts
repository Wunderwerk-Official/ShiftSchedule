import type { APIRequestContext, Page } from "@playwright/test";
import { saveTestState } from "./state-fixture";
import { expect, test } from "./fixtures";
import { attachStepScreenshot } from "./utils/screenshots";
import { fetchAuthToken, seedAuthToken } from "./utils/auth";
import { applyNewestRun } from "./utils/run-inbox";

const API_BASE = process.env.PLAYWRIGHT_API_URL ?? "http://localhost:8000";

// Maximum allowed colBands per dayType - should match the safeguard in code
const MAX_COLBANDS_PER_DAY = 50;

const DAY_TYPES = ["mon", "tue", "wed", "thu", "fri", "sat", "sun", "holiday"] as const;

type TemplateCounts = {
  total: number;
  byDay: Record<string, number>;
  byLocation: Record<string, number>;
  /** colBand ids per dayType (all locations), to detect a replaced day. */
  idsByDay: Record<string, string[]>;
  /** Template slots per dayType of their column (all locations). */
  slotsByDay: Record<string, number>;
  locationNames: string[];
};

/**
 * Helper to count colBands in the current state via API
 */
async function getColBandCount(request: APIRequestContext, token: string): Promise<TemplateCounts> {
  const response = await request.get(`${API_BASE}/v1/state`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.ok(), `GET /v1/state failed: ${response.status()}`).toBeTruthy();
  const state = await response.json();
  const template = state?.weeklyTemplate;
  const locations = template?.locations ?? [];

  let total = 0;
  const byDay: Record<string, number> = {};
  const byLocation: Record<string, number> = {};
  const idsByDay: Record<string, string[]> = {};
  const slotsByDay: Record<string, number> = {};

  for (const loc of locations) {
    const locId = loc.locationId ?? "unknown";
    byLocation[locId] = loc.colBands?.length ?? 0;
    total += byLocation[locId];

    const dayByColBand = new Map<string, string>();
    for (const cb of loc.colBands ?? []) {
      const day = cb.dayType ?? "unknown";
      byDay[day] = (byDay[day] ?? 0) + 1;
      (idsByDay[day] ??= []).push(cb.id);
      dayByColBand.set(cb.id, day);
    }
    for (const slot of loc.slots ?? []) {
      const day = dayByColBand.get(slot.colBandId) ?? "unknown";
      slotsByDay[day] = (slotsByDay[day] ?? 0) + 1;
    }
  }

  const locationNames = (state?.locations ?? []).map((loc: { name: string }) => loc.name);
  return { total, byDay, byLocation, idsByDay, slotsByDay, locationNames };
}

/** The counts worth logging (without the id lists). */
const summarize = ({ total, byDay, byLocation, slotsByDay }: TemplateCounts) => ({
  total,
  byDay,
  byLocation,
  slotsByDay,
});

/**
 * Poll the saved state until `check` holds. Edits in the app reach the
 * server through a debounced autosave, so assertions on the saved template
 * must wait for it instead of sleeping a fixed time.
 */
async function waitForSavedCounts(
  request: APIRequestContext,
  token: string,
  check: (counts: TemplateCounts) => boolean,
  message: string,
): Promise<TemplateCounts> {
  let last: TemplateCounts | null = null;
  await expect
    .poll(
      async () => {
        last = await getColBandCount(request, token);
        return check(last);
      },
      { message, timeout: 15_000 },
    )
    .toBe(true);
  return last!;
}

const SECTION_ID = "section-1";

/**
 * Helper to reset state to a clean template via API.
 *
 * `withSection` adds one section ("Morning Shift") with a template slot on
 * Monday, so Copy Day has slots to copy as well as columns.
 */
async function resetToCleanState(
  request: APIRequestContext,
  token: string,
  { withSection = false }: { withSection?: boolean } = {},
) {
  const cleanState = {
    locations: [{ id: "loc-default", name: "Location 1" }],
    locationsEnabled: true,
    rows: withSection
      ? [
          {
            id: SECTION_ID,
            name: "Morning Shift",
            kind: "class",
            dotColorClass: "bg-blue-500",
            locationId: "loc-default",
            subShifts: [
              { id: "s1", name: "Shift 1", order: 1, startTime: "08:00", endTime: "16:00", endDayOffset: 0 },
            ],
          },
        ]
      : [],
    clinicians: [],
    assignments: [],
    // Required by the AppState model (POST /v1/state answers 422 without it).
    minSlotsByRowId: withSection ? { [`${SECTION_ID}::s1`]: { weekday: 1, weekend: 0 } } : {},
    weeklyTemplate: {
      version: 4,
      blocks: withSection ? [{ id: "block-1", sectionId: SECTION_ID, requiredSlots: 0 }] : [],
      locations: [
        {
          locationId: "loc-default",
          rowBands: withSection ? [{ id: "row-1", label: "", order: 1 }] : [],
          colBands: [
            { id: "col-mon-1", label: "", order: 1, dayType: "mon" },
            { id: "col-tue-1", label: "", order: 1, dayType: "tue" },
            { id: "col-wed-1", label: "", order: 1, dayType: "wed" },
            { id: "col-thu-1", label: "", order: 1, dayType: "thu" },
            { id: "col-fri-1", label: "", order: 1, dayType: "fri" },
            { id: "col-sat-1", label: "", order: 1, dayType: "sat" },
            { id: "col-sun-1", label: "", order: 1, dayType: "sun" },
            { id: "col-holiday-1", label: "", order: 1, dayType: "holiday" },
          ],
          slots: withSection
            ? [
                {
                  id: "slot-mon-1",
                  locationId: "loc-default",
                  rowBandId: "row-1",
                  colBandId: "col-mon-1",
                  blockId: "block-1",
                  requiredSlots: 1,
                  startTime: "08:00",
                  endTime: "16:00",
                  endDayOffset: 0,
                },
              ]
            : [],
        },
      ],
    },
    solverSettings: {
      allowMultipleShiftsPerDay: false,
      enforceSameLocationPerDay: false,
      onCallRestEnabled: false,
      showDistributionPool: true,
      showReservePool: true,
    },
  };

  await saveTestState(request, `${API_BASE}/v1/state`, {
    headers: { Authorization: `Bearer ${token}` },
    data: cleanState,
  });
}

async function openSettings(page: Page) {
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
}

async function backToSchedule(page: Page) {
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.locator('[data-schedule-grid="true"]')).toBeVisible();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeHidden();
}

/**
 * Add one column to `dayLabel` ("Mon", ...) and wait until the saved
 * template has `expectedCount` colBands for that day.
 */
async function addColumn(
  page: Page,
  request: APIRequestContext,
  token: string,
  dayLabel: string,
  expectedCount: number,
) {
  const dayType = dayLabel.toLowerCase();
  const addColumnButton = page.getByRole("button", { name: `Add ${dayLabel} column` });
  await expect(addColumnButton).toBeVisible();
  await addColumnButton.click();
  await waitForSavedCounts(
    request,
    token,
    (counts) => counts.byDay[dayType] === expectedCount,
    `${dayLabel} should have ${expectedCount} columns after "Add ${dayLabel} column"`,
  );
}

/**
 * Copy the active template day (the Copy Day dialog's default source) to
 * `targetDay` through the Copy Day dialog.
 *
 * The dialog only asks for the "I understand this will overwrite the target
 * day" confirmation when the target day already has content (more than one
 * column or any slot); copying onto an empty day needs no confirmation.
 */
async function copyActiveDayTo(
  page: Page,
  targetDay: string,
  { overwrite }: { overwrite: boolean },
) {
  await page.getByRole("button", { name: "Copy Day", exact: true }).click();
  const modal = page.getByRole("heading", { name: "Copy Day" }).locator("..");
  await expect(modal).toBeVisible();

  // "Copy to" is a CustomSelect (button + option list), not a native select.
  const copyTo = modal.locator("label", { hasText: "Copy to" }).locator("..");
  await copyTo.getByRole("button").first().click();
  await copyTo.getByRole("button", { name: targetDay, exact: true }).last().click();
  await expect(modal.getByText(`${targetDay} (target)`)).toBeVisible();

  const copyButton = modal.getByRole("button", { name: "Copy", exact: true });
  const understand = modal.getByRole("checkbox", {
    name: "I understand this will overwrite the target day",
  });
  if (overwrite) {
    await expect(
      modal.getByText("The target day has existing content that will be overwritten."),
    ).toBeVisible();
    await expect(copyButton).toBeDisabled();
    await understand.check();
    await expect(copyButton).toBeEnabled();
  } else {
    await expect(understand).toHaveCount(0);
    await expect(copyButton).toBeEnabled();
  }
  await copyButton.click();
  await expect(modal).toBeHidden();
}

test.describe("ColBand Explosion Prevention", () => {
  let token: string;

  test.beforeEach(async ({ request }) => {
    token = await fetchAuthToken(request);
  });

  test("login and navigate to settings without colBand explosion", async ({
    page,
    request,
  }, testInfo) => {
    // Reset to clean state first
    await resetToCleanState(request, token);
    await seedAuthToken(page, token);

    // Check initial colBand count
    const initialCount = await getColBandCount(request, token);
    expect(initialCount.total).toBe(8); // 1 per dayType

    await page.goto("/");
    await expect(page.locator('[data-schedule-grid="true"]')).toBeVisible();
    await attachStepScreenshot(page, testInfo, "01-initial-load");

    // Navigate to Settings
    await openSettings(page);
    await expect(page.getByText("Weekly Calendar Template")).toBeVisible();
    await attachStepScreenshot(page, testInfo, "02-settings-opened");

    // Nothing is edited here, so there is no save to wait for. Give any
    // effect-driven save (the template sync effect, 500 ms autosave
    // debounce) a window to land before checking that nothing grew.
    await page.waitForTimeout(1000);

    // Verify colBands didn't explode
    const afterSettingsCount = await getColBandCount(request, token);
    console.log("ColBand count after settings:", summarize(afterSettingsCount));

    // Should have at most a small increase (e.g., if locations were synced)
    expect(afterSettingsCount.total).toBeLessThan(50);

    // No single day should have more than MAX_COLBANDS_PER_DAY
    for (const [day, count] of Object.entries(afterSettingsCount.byDay)) {
      expect(count, `Day ${day} has too many colBands`).toBeLessThanOrEqual(MAX_COLBANDS_PER_DAY);
    }
  });

  test("create multiple columns for Monday without explosion", async ({
    page,
    request,
  }, testInfo) => {
    await resetToCleanState(request, token);
    await seedAuthToken(page, token);
    await page.goto("/");
    await expect(page.locator('[data-schedule-grid="true"]')).toBeVisible();

    // Navigate to Settings
    await openSettings(page);

    // Click on Monday tab to ensure it's active (use exact match)
    await page.getByRole("button", { name: "Mon", exact: true }).click();
    await attachStepScreenshot(page, testInfo, "01-monday-selected");

    // Add 3 more columns for Monday (total 4), waiting for each to be saved
    for (let i = 0; i < 3; i++) {
      await addColumn(page, request, token, "Mon", i + 2);
    }

    await attachStepScreenshot(page, testInfo, "02-columns-added");

    // Verify colBands didn't explode
    const count = await getColBandCount(request, token);
    console.log("ColBand count after adding columns:", summarize(count));

    // Exactly the three added columns, nothing else
    expect(count.byDay.mon).toBe(4);
    for (const day of DAY_TYPES.filter((d) => d !== "mon")) {
      expect(count.byDay[day], `Day ${day} changed`).toBe(1);
    }
    expect(count.total).toBe(11);
    expect(count.total).toBeLessThan(100);
    for (const [day, dayCount] of Object.entries(count.byDay)) {
      expect(dayCount, `Day ${day} has too many colBands`).toBeLessThanOrEqual(MAX_COLBANDS_PER_DAY);
    }
  });

  test("create sections and use Copy Day without explosion", async ({
    page,
    request,
  }, testInfo) => {
    // A section with a template slot on Monday, so Copy Day copies slots
    // as well as columns.
    await resetToCleanState(request, token, { withSection: true });
    await seedAuthToken(page, token);
    await page.goto("/");
    await expect(page.locator('[data-schedule-grid="true"]')).toBeVisible();

    // Navigate to Settings
    await openSettings(page);
    await page.getByRole("button", { name: "Mon", exact: true }).click();
    await attachStepScreenshot(page, testInfo, "01-settings");

    // Give Monday 3 columns (it already holds the section's slot)
    await addColumn(page, request, token, "Mon", 2);
    await addColumn(page, request, token, "Mon", 3);
    const beforeCopy = await getColBandCount(request, token);
    expect(beforeCopy.slotsByDay.mon).toBe(1);

    // Copy Mon -> Tue. Tuesday is empty (one column, no slots), so the
    // dialog copies without asking for the overwrite confirmation.
    await copyActiveDayTo(page, "Tue", { overwrite: false });
    await expect(page.getByText("Copied Mon to Tue (3 columns)")).toBeVisible();
    await attachStepScreenshot(page, testInfo, "02-copied-to-tuesday");

    const afterCopy = await waitForSavedCounts(
      request,
      token,
      (counts) => counts.byDay.tue === 3,
      "Tuesday should have Monday's 3 columns after Copy Day",
    );
    console.log("ColBand count after copy day:", summarize(afterCopy));
    expect(afterCopy.slotsByDay.tue).toBe(1);
    expect(afterCopy.byDay.mon).toBe(3);
    expect(afterCopy.slotsByDay.mon).toBe(1);
    expect(afterCopy.total).toBe(beforeCopy.total + 2);

    // Copy Mon -> Tue again. Tuesday now has content, so the dialog warns
    // and requires the "I understand" confirmation before copying.
    const tueIdsBefore = afterCopy.idsByDay.tue;
    await copyActiveDayTo(page, "Tue", { overwrite: true });
    await attachStepScreenshot(page, testInfo, "03-copied-to-tuesday-again");

    // The overwrite replaces Tuesday's columns (new ids) instead of
    // appending to them.
    const afterOverwrite = await waitForSavedCounts(
      request,
      token,
      (counts) => !(counts.idsByDay.tue ?? []).some((id) => tueIdsBefore.includes(id)),
      "Tuesday's columns should be replaced by the second Copy Day",
    );
    console.log("ColBand count after overwriting copy:", summarize(afterOverwrite));
    expect(afterOverwrite.byDay.tue).toBe(3);
    expect(afterOverwrite.slotsByDay.tue).toBe(1);
    expect(afterOverwrite.total).toBe(afterCopy.total);

    // Verify no explosion
    expect(afterOverwrite.total).toBeLessThan(200);
    for (const [day, dayCount] of Object.entries(afterOverwrite.byDay)) {
      expect(dayCount, `Day ${day} has too many colBands`).toBeLessThanOrEqual(MAX_COLBANDS_PER_DAY);
    }
  });

  test("repeated Copy Day operations don't cause exponential growth", async ({
    page,
    request,
  }, testInfo) => {
    await resetToCleanState(request, token);
    await seedAuthToken(page, token);
    await page.goto("/");
    await expect(page.locator('[data-schedule-grid="true"]')).toBeVisible();

    // Navigate to Settings
    await openSettings(page);
    await page.getByRole("button", { name: "Mon", exact: true }).click();

    // Give Monday a second column so every copy has something to grow by
    await addColumn(page, request, token, "Mon", 2);

    const initialCount = await getColBandCount(request, token);
    console.log("Initial colBand count:", summarize(initialCount));
    expect(initialCount.total).toBe(9);

    // Copy Mon to multiple days sequentially. Each target starts empty,
    // so no overwrite confirmation is needed.
    const targetDays = ["Tue", "Wed", "Thu", "Fri"];
    for (const [index, day] of targetDays.entries()) {
      await copyActiveDayTo(page, day, { overwrite: false });

      // Check count after each operation
      const count = await waitForSavedCounts(
        request,
        token,
        (counts) => counts.byDay[day.toLowerCase()] === 2,
        `${day} should have Monday's 2 columns after Copy Day`,
      );
      console.log(`After copy Mon -> ${day}:`, count.total);

      // Linear growth: each copy adds exactly one column (2 replace 1)
      expect(count.total, `Unexpected growth after copy Mon -> ${day}`).toBe(
        initialCount.total + index + 1,
      );
      // Should never exceed reasonable limits
      expect(count.total, `Explosion after copy Mon -> ${day}`).toBeLessThan(200);
    }

    // Repeat the first copy: Tuesday now has content (overwrite path)
    const beforeRepeat = await getColBandCount(request, token);
    await copyActiveDayTo(page, "Tue", { overwrite: true });
    const afterRepeat = await waitForSavedCounts(
      request,
      token,
      (counts) =>
        !(counts.idsByDay.tue ?? []).some((id) => beforeRepeat.idsByDay.tue.includes(id)),
      "Tuesday's columns should be replaced by the repeated Copy Day",
    );
    expect(afterRepeat.byDay.tue, "Repeated copy must replace, not append").toBe(2);
    expect(afterRepeat.total).toBe(beforeRepeat.total);

    await attachStepScreenshot(page, testInfo, "after-all-copies");

    const finalCount = await getColBandCount(request, token);
    console.log("Final colBand count:", summarize(finalCount));

    // Final check - should be roughly linear, not exponential
    expect(finalCount.total).toBeLessThan(200);
    for (const [day, dayCount] of Object.entries(finalCount.byDay)) {
      expect(dayCount, `Day ${day} has too many colBands`).toBeLessThanOrEqual(MAX_COLBANDS_PER_DAY);
    }
  });

  test("adding second location doesn't cause explosion", async ({
    page,
    request,
  }, testInfo) => {
    await resetToCleanState(request, token);
    await seedAuthToken(page, token);
    await page.goto("/");
    await expect(page.locator('[data-schedule-grid="true"]')).toBeVisible();

    // Navigate to Settings
    await openSettings(page);

    const beforeCount = await getColBandCount(request, token);
    console.log("Before adding location:", summarize(beforeCount));
    expect(Object.keys(beforeCount.byLocation)).toHaveLength(1);

    // "+ Location" adds a location named "New Location" at the top; its
    // name is edited in place.
    await page.getByRole("button", { name: "+ Location", exact: true }).click();
    const nameInput = page.getByRole("textbox", { name: "Location name" }).first();
    await expect(nameInput).toHaveValue("New Location");
    await nameInput.fill("Location 2");
    await nameInput.press("Tab");

    const afterCount = await waitForSavedCounts(
      request,
      token,
      (counts) =>
        Object.keys(counts.byLocation).length === 2 && counts.locationNames.includes("Location 2"),
      "The second location should be saved with its template columns",
    );
    await attachStepScreenshot(page, testInfo, "01-location-added");
    console.log("After adding location:", summarize(afterCount));

    // The new location is seeded with one column per dayType (8), so the
    // total doubles - but no exponential growth.
    for (const [locationId, count] of Object.entries(afterCount.byLocation)) {
      expect(count, `Location ${locationId} colBands`).toBe(8);
    }
    expect(afterCount.total).toBe(16);
    expect(afterCount.total).toBeLessThan(50);
    expect(Object.keys(afterCount.byLocation).length).toBeLessThanOrEqual(2);
  });

  test("full workflow: settings -> columns -> sections -> copy -> solver", async ({
    page,
    request,
  }, testInfo) => {
    // Start with a section that has a template slot on Monday
    await resetToCleanState(request, token, { withSection: true });
    await seedAuthToken(page, token);
    await page.goto("/");
    await expect(page.locator('[data-schedule-grid="true"]')).toBeVisible();
    await attachStepScreenshot(page, testInfo, "01-initial");

    // Track colBand count throughout
    const counts: { step: string; count: number }[] = [];

    const trackCount = async (step: string, expected?: number) => {
      const count =
        expected === undefined
          ? await getColBandCount(request, token)
          : await waitForSavedCounts(
              request,
              token,
              (c) => c.total === expected,
              `[${step}] expected ${expected} colBands`,
            );
      counts.push({ step, count: count.total });
      console.log(`[${step}] ColBands: ${count.total}`, count.byDay);
      return count;
    };

    await trackCount("initial");

    // Step 1: Go to Settings
    await openSettings(page);
    await trackCount("settings-opened");
    await attachStepScreenshot(page, testInfo, "02-settings");

    // Step 2: Select Monday and add a column
    await page.getByRole("button", { name: "Mon", exact: true }).click();
    await trackCount("monday-selected");
    await addColumn(page, request, token, "Mon", 2);
    await trackCount("monday-column-added", 9);

    // Step 3: Copy Day - open the dialog and cancel it (nothing changes),
    // then copy Mon -> Tue for real.
    await page.getByRole("button", { name: "Copy Day", exact: true }).click();
    const copyModal = page.getByRole("heading", { name: "Copy Day" }).locator("..");
    await expect(copyModal).toBeVisible();
    await attachStepScreenshot(page, testInfo, "02b-copy-modal");
    await copyModal.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(copyModal).toBeHidden();
    await trackCount("copy-cancelled");

    await copyActiveDayTo(page, "Tue", { overwrite: false });
    const afterCopy = await trackCount("copied-mon-to-tue", 10);
    // The section's Monday slot was copied along with the columns
    expect(afterCopy.byDay.tue).toBe(2);
    expect(afterCopy.slotsByDay.tue).toBe(1);
    expect(afterCopy.slotsByDay.mon).toBe(1);

    await attachStepScreenshot(page, testInfo, "03-after-operations");

    // Step 4: Go back to main view
    await backToSchedule(page);

    await trackCount("back-to-main");
    await attachStepScreenshot(page, testInfo, "04-main-view");

    // Step 5: Verify no explosion occurred
    const finalCount = await trackCount("final");

    console.log("\n=== ColBand Count History ===");
    for (const { step, count } of counts) {
      console.log(`${step}: ${count}`);
    }

    // Assertions
    expect(finalCount.total, "ColBand explosion detected!").toBeLessThan(500);
    expect(finalCount.total).toBe(10);

    // Check that growth was reasonable (no doubling or worse)
    const growthRates = counts.slice(1).map((c, i) =>
      counts[i].count > 0 ? c.count / counts[i].count : 1
    );
    const maxGrowthRate = Math.max(...growthRates.filter(r => r > 1), 1);
    expect(maxGrowthRate, "Exponential growth detected").toBeLessThan(3);
  });

  test("console shows no colBand explosion errors", async ({
    page,
    request,
    diagnostics,
  }, testInfo) => {
    await resetToCleanState(request, token);
    await seedAuthToken(page, token);

    // Collect console errors
    const explosionErrors: string[] = [];
    page.on("console", (msg) => {
      const text = msg.text();
      if (text.includes("BLOCKING colBand explosion") ||
          text.includes("BLOCKING SAVE") ||
          text.includes("colBand explosion")) {
        explosionErrors.push(text);
      }
    });

    await page.goto("/");
    await expect(page.locator('[data-schedule-grid="true"]')).toBeVisible();

    // Navigate to Settings and back multiple times. Settings has a single
    // "Back" button to return to the calendar.
    for (let i = 0; i < 3; i++) {
      await openSettings(page);
      await expect(page.getByText("Weekly Calendar Template")).toBeVisible();
      await backToSchedule(page);
    }

    await attachStepScreenshot(page, testInfo, "after-navigation-cycles");

    // The cycles must not have changed the template either
    const count = await getColBandCount(request, token);
    expect(count.total).toBeLessThan(50);

    // Check no explosion errors were logged
    if (explosionErrors.length > 0) {
      console.error("ColBand explosion errors detected:", explosionErrors);
    }
    expect(explosionErrors, "ColBand explosion errors in console").toHaveLength(0);
  });
});

test.describe("Solver Integration with Template", () => {
  let token: string;

  test.beforeEach(async ({ request }) => {
    token = await fetchAuthToken(request);
  });

  test("solver works correctly after template modifications", async ({
    page,
    request,
  }, testInfo) => {
    // Set up a state with clinicians and sections that can be solved
    const testState = {
      locations: [{ id: "loc-default", name: "Location 1" }],
      locationsEnabled: true,
      rows: [
        {
          id: "section-1",
          name: "Morning Shift",
          kind: "class",
          dotColorClass: "bg-blue-500",
          locationId: "loc-default",
          subShifts: [
            { id: "s1", name: "Shift 1", order: 1, startTime: "08:00", endTime: "16:00", endDayOffset: 0 },
          ],
        },
        {
          id: "pool-not-allocated",
          name: "Not Allocated",
          kind: "pool",
          dotColorClass: "bg-slate-200",
        },
      ],
      clinicians: [
        {
          id: "clin-1",
          name: "Dr. Smith",
          qualifiedClassIds: ["section-1"],
          preferredClassIds: ["section-1"],
          vacations: [],
          workingHoursPerWeek: 40,
        },
        {
          id: "clin-2",
          name: "Dr. Jones",
          qualifiedClassIds: ["section-1"],
          preferredClassIds: ["section-1"],
          vacations: [],
          workingHoursPerWeek: 40,
        },
      ],
      assignments: [],
      weeklyTemplate: {
        version: 4,
        blocks: [
          { id: "block-1", sectionId: "section-1", label: "Morning", requiredSlots: 1 },
        ],
        locations: [
          {
            locationId: "loc-default",
            rowBands: [{ id: "row-1", label: "", order: 1 }],
            colBands: [
              { id: "col-mon-1", label: "", order: 1, dayType: "mon" },
              { id: "col-tue-1", label: "", order: 1, dayType: "tue" },
              { id: "col-wed-1", label: "", order: 1, dayType: "wed" },
              { id: "col-thu-1", label: "", order: 1, dayType: "thu" },
              { id: "col-fri-1", label: "", order: 1, dayType: "fri" },
              { id: "col-sat-1", label: "", order: 1, dayType: "sat" },
              { id: "col-sun-1", label: "", order: 1, dayType: "sun" },
              { id: "col-holiday-1", label: "", order: 1, dayType: "holiday" },
            ],
            slots: [
              { id: "slot-1", blockId: "block-1", rowBandId: "row-1", colBandId: "col-mon-1", locationId: "loc-default", requiredSlots: 1 },
              { id: "slot-2", blockId: "block-1", rowBandId: "row-1", colBandId: "col-tue-1", locationId: "loc-default", requiredSlots: 1 },
              { id: "slot-3", blockId: "block-1", rowBandId: "row-1", colBandId: "col-wed-1", locationId: "loc-default", requiredSlots: 1 },
              { id: "slot-4", blockId: "block-1", rowBandId: "row-1", colBandId: "col-thu-1", locationId: "loc-default", requiredSlots: 1 },
              { id: "slot-5", blockId: "block-1", rowBandId: "row-1", colBandId: "col-fri-1", locationId: "loc-default", requiredSlots: 1 },
            ],
          },
        ],
      },
      minSlotsByRowId: {
        "section-1::s1": { weekday: 1, weekend: 0 },
      },
      solverSettings: {
        allowMultipleShiftsPerDay: false,
        enforceSameLocationPerDay: false,
        onCallRestEnabled: false,
        showDistributionPool: true,
        showReservePool: true,
      },
    };

    // Save test state
    await saveTestState(request, `${API_BASE}/v1/state`, {
      headers: { Authorization: `Bearer ${token}` },
      data: testState,
    });

    await seedAuthToken(page, token);
    await page.goto("/");
    await expect(page.locator('[data-schedule-grid="true"]')).toBeVisible();
    await attachStepScreenshot(page, testInfo, "01-before-solver");

    // Find and click the solver/planning button - exact match to avoid ambiguity
    const solverButton = page.getByRole("button", { name: "Run", exact: true });
    await expect(solverButton).toBeVisible();
    // Plan the week shown in the calendar
    await page.getByRole("button", { name: "Current week" }).click();
    await solverButton.click();

    // Since v1.53 a finished run waits in the run inbox and only reaches
    // the calendar once it is applied.
    await applyNewestRun(page);
    await attachStepScreenshot(page, testInfo, "02-after-solver");

    // Verify assignments were created and saved
    const slotIds = new Set(testState.weeklyTemplate.locations[0].slots.map((slot) => slot.id));
    const clinicianIds = new Set(testState.clinicians.map((clinician) => clinician.id));
    let assignments: Array<{ rowId: string; clinicianId: string; dateISO: string; source?: string }> = [];
    await expect
      .poll(
        async () => {
          const response = await request.get(`${API_BASE}/v1/state`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          const state = await response.json();
          assignments = state?.assignments ?? [];
          return assignments.length;
        },
        { message: "the applied run should save assignments" },
      )
      .toBeGreaterThan(0);

    console.log("Assignments after solver:", assignments.length);

    // Should have some assignments (at least for weekdays), all of them
    // made by the solver (the state started without any), in the template's
    // slots and given to the two qualified clinicians
    expect(assignments.length).toBeGreaterThan(0);
    for (const assignment of assignments) {
      expect(assignment.source).toBe("solver");
      expect(slotIds.has(assignment.rowId), `assignment row ${assignment.rowId}`).toBe(true);
      expect(clinicianIds.has(assignment.clinicianId)).toBe(true);
    }

    // ... and they show up in the calendar
    await expect(page.locator("[data-assignment-key]").first()).toBeVisible();

    // Verify colBands are still reasonable
    const count = await getColBandCount(request, token);
    expect(count.total).toBeLessThan(100);
  });
});
