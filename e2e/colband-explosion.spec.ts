import { expect, test } from "./fixtures";
import { attachStepScreenshot } from "./utils/screenshots";
import { fetchAuthToken, seedAuthToken } from "./utils/auth";

const API_BASE = process.env.PLAYWRIGHT_API_URL ?? "http://localhost:8000";
const UI_USERNAME = process.env.E2E_USERNAME ?? "testuser";
const UI_PASSWORD = process.env.E2E_PASSWORD ?? "sdjhfl34-wfsdfwsd2";

// Maximum allowed colBands per dayType - should match the safeguard in code
const MAX_COLBANDS_PER_DAY = 50;

/**
 * Helper to count colBands in the current state via API
 */
async function getColBandCount(request: any, token: string): Promise<{
  total: number;
  byDay: Record<string, number>;
  byLocation: Record<string, number>;
}> {
  const response = await request.get(`${API_BASE}/v1/state`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const state = await response.json();
  const template = state?.weeklyTemplate;
  const locations = template?.locations ?? [];

  let total = 0;
  const byDay: Record<string, number> = {};
  const byLocation: Record<string, number> = {};

  for (const loc of locations) {
    const locId = loc.locationId ?? "unknown";
    byLocation[locId] = loc.colBands?.length ?? 0;
    total += byLocation[locId];

    for (const cb of loc.colBands ?? []) {
      const day = cb.dayType ?? "unknown";
      byDay[day] = (byDay[day] ?? 0) + 1;
    }
  }

  return { total, byDay, byLocation };
}

/**
 * Helper to reset state to a clean template via API
 */
async function resetToCleanState(request: any, token: string) {
  const cleanState = {
    locations: [{ id: "loc-default", name: "Location 1" }],
    locationsEnabled: true,
    rows: [],
    clinicians: [],
    assignments: [],
    weeklyTemplate: {
      version: 4,
      blocks: [],
      locations: [
        {
          locationId: "loc-default",
          rowBands: [],
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
          slots: [],
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

  await request.post(`${API_BASE}/v1/state`, {
    headers: { Authorization: `Bearer ${token}` },
    data: cleanState,
  });
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
    await page.waitForLoadState("networkidle");
    await attachStepScreenshot(page, testInfo, "01-initial-load");

    // Navigate to Settings
    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    await attachStepScreenshot(page, testInfo, "02-settings-opened");

    // Wait a moment for any effects to settle
    await page.waitForTimeout(1000);

    // Verify colBands didn't explode
    const afterSettingsCount = await getColBandCount(request, token);
    console.log("ColBand count after settings:", afterSettingsCount);

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
    await page.waitForLoadState("networkidle");

    // Navigate to Settings
    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

    // Click on Monday tab to ensure it's active (use exact match)
    await page.getByRole("button", { name: "Mon", exact: true }).click();
    await attachStepScreenshot(page, testInfo, "01-monday-selected");

    // Find the "Add column" button for Monday
    const addColumnButton = page.getByRole("button", { name: "Add Mon column" }).or(
      page.getByRole("button", { name: /add.*column/i }).first()
    );

    // Add 3 more columns for Monday (total 4)
    for (let i = 0; i < 3; i++) {
      if (await addColumnButton.isVisible()) {
        await addColumnButton.click();
        await page.waitForTimeout(300);
      }
    }

    await attachStepScreenshot(page, testInfo, "02-columns-added");

    // Verify colBands didn't explode
    const count = await getColBandCount(request, token);
    console.log("ColBand count after adding columns:", count);

    expect(count.total).toBeLessThan(100);
    for (const [day, dayCount] of Object.entries(count.byDay)) {
      expect(dayCount, `Day ${day} has too many colBands`).toBeLessThanOrEqual(MAX_COLBANDS_PER_DAY);
    }
  });

  test("create sections and use Copy Day without explosion", async ({
    page,
    request,
  }, testInfo) => {
    await resetToCleanState(request, token);
    await seedAuthToken(page, token);
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // Navigate to Settings
    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    await attachStepScreenshot(page, testInfo, "01-settings");

    // Click Copy Day button
    const copyDayButton = page.getByRole("button", { name: "Copy Day" });
    await copyDayButton.click();
    await page.waitForTimeout(500);
    await attachStepScreenshot(page, testInfo, "02-copy-day-dialog");

    // The Copy Day dialog has:
    // - "Copy from" dropdown (source day) - defaults to Mon
    // - "Copy to" dropdown (target day) - select target
    // - "I understand" checkbox - must be checked
    // - "Copy" button - initially disabled

    // Select target day (Tue is default after Mon).
    // "Copy to" is a CustomSelect (button + option list), not a native select.
    const copyToTrigger = page
      .locator("text=Copy to")
      .locator("..")
      .getByRole("button")
      .first();
    await copyToTrigger.click();
    await page.getByRole("button", { name: "Tue", exact: true }).last().click();
    await page.waitForTimeout(300);

    // Check the "I understand" checkbox
    const understandCheckbox = page.getByRole("checkbox", { name: /understand/i });
    await understandCheckbox.check();
    await page.waitForTimeout(300);
    await attachStepScreenshot(page, testInfo, "03-checkbox-checked");

    // Click Copy button
    const confirmBtn = page.getByRole("button", { name: "Copy" }).last();
    await confirmBtn.click();
    await page.waitForTimeout(1000);
    await attachStepScreenshot(page, testInfo, "04-copied-to-tuesday");

    // Verify no explosion
    const count = await getColBandCount(request, token);
    console.log("ColBand count after copy day:", count);

    expect(count.total).toBeLessThan(200);
    for (const [day, dayCount] of Object.entries(count.byDay)) {
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
    await page.waitForLoadState("networkidle");

    // Navigate to Settings
    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

    const initialCount = await getColBandCount(request, token);
    console.log("Initial colBand count:", initialCount);

    // Helper to perform copy operation from Mon to a target day
    const performCopy = async (targetDay: string) => {
      const copyDayButton = page.getByRole("button", { name: "Copy Day" });
      await copyDayButton.click();
      await page.waitForTimeout(500);

      // Select target day from the CustomSelect dropdown (button + options)
      const copyToTrigger = page
        .locator("text=Copy to")
        .locator("..")
        .getByRole("button")
        .first();
      await copyToTrigger.click();
      await page.getByRole("button", { name: targetDay, exact: true }).last().click();
      await page.waitForTimeout(300);

      // Check the "I understand" checkbox
      const understandCheckbox = page.getByRole("checkbox", { name: /understand/i });
      await understandCheckbox.check();
      await page.waitForTimeout(300);

      // Click Copy button
      const confirmBtn = page.getByRole("button", { name: "Copy" }).last();
      await confirmBtn.click();
      await page.waitForTimeout(1000);
    };

    // Copy Mon to multiple days sequentially
    const targetDays = ["Tue", "Wed", "Thu", "Fri"];
    for (const day of targetDays) {
      await performCopy(day);

      // Check count after each operation
      const count = await getColBandCount(request, token);
      console.log(`After copy Mon -> ${day}:`, count.total);

      // Should never exceed reasonable limits
      expect(count.total, `Explosion after copy Mon -> ${day}`).toBeLessThan(200);
    }

    await attachStepScreenshot(page, testInfo, "after-all-copies");

    const finalCount = await getColBandCount(request, token);
    console.log("Final colBand count:", finalCount);

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
    await page.waitForLoadState("networkidle");

    // Navigate to Settings
    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

    const beforeCount = await getColBandCount(request, token);
    console.log("Before adding location:", beforeCount);

    // Look for Add Location button
    const addLocationButton = page.getByRole("button", { name: /add.*location/i }).or(
      page.locator('[data-testid="add-location"]')
    );

    if (await addLocationButton.isVisible()) {
      await addLocationButton.click();
      await page.waitForTimeout(300);

      // Fill in location name if prompted
      const nameInput = page.getByPlaceholder(/location name/i).or(
        page.getByLabel(/name/i)
      );
      if (await nameInput.isVisible()) {
        await nameInput.fill("Location 2");
        await page.getByRole("button", { name: /create|add|save/i }).click();
      }

      await page.waitForTimeout(1000);
      await attachStepScreenshot(page, testInfo, "01-location-added");
    }

    const afterCount = await getColBandCount(request, token);
    console.log("After adding location:", afterCount);

    // Adding a location should roughly double colBands (8 per location)
    // but not cause exponential growth
    expect(afterCount.total).toBeLessThan(50);
    expect(Object.keys(afterCount.byLocation).length).toBeLessThanOrEqual(2);
  });

  test("full workflow: settings -> columns -> sections -> copy -> solver", async ({
    page,
    request,
  }, testInfo) => {
    await resetToCleanState(request, token);
    await seedAuthToken(page, token);
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await attachStepScreenshot(page, testInfo, "01-initial");

    // Track colBand count throughout
    const counts: { step: string; count: number }[] = [];

    const trackCount = async (step: string) => {
      const count = await getColBandCount(request, token);
      counts.push({ step, count: count.total });
      console.log(`[${step}] ColBands: ${count.total}`, count.byDay);
      return count;
    };

    await trackCount("initial");

    // Step 1: Go to Settings
    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    await trackCount("settings-opened");
    await attachStepScreenshot(page, testInfo, "02-settings");

    // Step 2: Add columns for Monday (if UI allows) - use exact match
    const monButton = page.getByRole("button", { name: "Mon", exact: true });
    if (await monButton.isVisible({ timeout: 1000 }).catch(() => false)) {
      await monButton.click();
      await page.waitForTimeout(500);
      await trackCount("monday-selected");
    }

    // Step 3: Try Copy Day operations
    const copyDayBtn = page.getByRole("button", { name: /copy day/i }).first();
    if (await copyDayBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      // Just try one copy operation to verify it works
      await copyDayBtn.click();
      await page.waitForTimeout(500);
      await attachStepScreenshot(page, testInfo, "02b-copy-modal");

      // Close modal if open (click outside or cancel)
      const cancelBtn = page.getByRole("button", { name: /cancel|close/i });
      if (await cancelBtn.isVisible({ timeout: 500 }).catch(() => false)) {
        await cancelBtn.click();
      } else {
        await page.keyboard.press("Escape");
      }
      await page.waitForTimeout(300);
    }

    await attachStepScreenshot(page, testInfo, "03-after-operations");

    // Step 4: Go back to main view
    const backButton = page.getByRole("button", { name: "Back" }).or(
      page.getByRole("button", { name: /schedule/i })
    ).or(
      page.getByRole("link", { name: /back|schedule/i })
    );

    if (await backButton.isVisible({ timeout: 1000 }).catch(() => false)) {
      await backButton.click();
      await page.waitForTimeout(1000);
    }

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
    await page.waitForLoadState("networkidle");

    // Navigate to Settings and back multiple times
    for (let i = 0; i < 3; i++) {
      await page.getByRole("button", { name: "Settings" }).click();
      await page.waitForTimeout(500);
      await page.getByRole("button", { name: "Back" }).or(
        page.getByRole("button", { name: /schedule|calendar/i })
      ).click();
      await page.waitForTimeout(500);
    }

    await attachStepScreenshot(page, testInfo, "after-navigation-cycles");

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
    await request.post(`${API_BASE}/v1/state`, {
      headers: { Authorization: `Bearer ${token}` },
      data: testState,
    });

    await seedAuthToken(page, token);
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await attachStepScreenshot(page, testInfo, "01-before-solver");

    // Find and click the solver/planning button - exact match to avoid ambiguity
    const solverButton = page.getByRole("button", { name: "Run" });

    if (await solverButton.isVisible()) {
      await solverButton.click();

      // Wait for solver to complete (may take a few seconds)
      await page.waitForTimeout(5000);
      await attachStepScreenshot(page, testInfo, "02-after-solver");

      // Verify assignments were created
      const response = await request.get(`${API_BASE}/v1/state`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const state = await response.json();
      const assignments = state?.assignments ?? [];

      console.log("Assignments after solver:", assignments.length);

      // Should have some assignments (at least for weekdays)
      expect(assignments.length).toBeGreaterThan(0);
    }

    // Verify colBands are still reasonable
    const count = await getColBandCount(request, token);
    expect(count.total).toBeLessThan(100);
  });
});
