import { Buffer } from "node:buffer";
import { expect, test } from "./fixtures";
import { attachStepScreenshot } from "./utils/screenshots";
import { fetchAuthToken, seedAuthToken } from "./utils/auth";

const API_BASE = process.env.PLAYWRIGHT_API_URL ?? "http://localhost:8000";
const UI_USERNAME = process.env.E2E_USERNAME ?? "testuser";
const UI_PASSWORD = process.env.E2E_PASSWORD ?? "sdjhfl34-wfsdfwsd2";
const DAY_TYPES = [
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
  "sun",
  "holiday",
] as const;

const toISODate = (date: Date) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};

const startOfWeek = (date: Date) => {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - day);
  return d;
};

const getDayTypeForISO = (dateISO: string) => {
  const [year, month, day] = dateISO.split("-").map((value) => Number(value));
  const date = new Date(Date.UTC(year, (month ?? 1) - 1, day ?? 1));
  const idx = date.getUTCDay();
  const byIndex = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
  return byIndex[idx] ?? "mon";
};

const slotRowIdForDate = (baseRowId: string, dateISO: string) =>
  `${baseRowId}__${getDayTypeForISO(dateISO)}`;

const countPdfPages = (buffer: Buffer) => {
  const text = buffer.toString("latin1");
  const matches = text.match(/\/Type\s*\/Page\b(?!s)/g);
  return matches ? matches.length : 0;
};

const PRINT_DPI = 96;
const MM_TO_PX = PRINT_DPI / 25.4;
const PRINT_PAGE_WIDTH_MM = 297;
const PRINT_PAGE_HEIGHT_MM = 210;
const PRINT_PAGE_MARGIN_MM = 6;
const getPrintableAreaPx = () => {
  const longEdge = (PRINT_PAGE_WIDTH_MM - PRINT_PAGE_MARGIN_MM * 2) * MM_TO_PX;
  const shortEdge = (PRINT_PAGE_HEIGHT_MM - PRINT_PAGE_MARGIN_MM * 2) * MM_TO_PX;
  return {
    landscape: { width: longEdge, height: shortEdge },
    portrait: { width: shortEdge, height: longEdge },
  };
};

type TestClassRow = {
  id: string;
  name: string;
  locationId?: string;
  startTime?: string;
  endTime?: string;
  endDayOffset?: number;
};

type TestAssignment = {
  id: string;
  rowId: string;
  dateISO: string;
  clinicianId: string;
};

const poolRowId = "pool-rest-day";
const primaryClassId = "class-1";
const secondaryClassId = "class-2";
const classRowId = `${primaryClassId}::s1`;

const defaultSolverSettings = {
  enforceSameLocationPerDay: false,
  onCallRestEnabled: false,
  onCallRestClassId: "",
  onCallRestDaysBefore: 0,
  onCallRestDaysAfter: 0,
};

const makeClassRow = (row: TestClassRow) => ({
  id: row.id,
  name: row.name,
  kind: "class",
  dotColorClass: "bg-slate-200",
  locationId: row.locationId ?? "loc-default",
  subShifts: [
    {
      id: "s1",
      name: "Shift 1",
      order: 1,
      startTime: row.startTime ?? "08:00",
      endTime: row.endTime ?? "16:00",
      endDayOffset: row.endDayOffset ?? 0,
    },
  ],
});

const buildTestState = ({
  dateISO,
  classRows = [{ id: primaryClassId, name: "On Call" }],
  assignments,
  solverSettings = {},
  locationsEnabled = true,
}: {
  dateISO: string;
  classRows?: TestClassRow[];
  assignments?: TestAssignment[];
  solverSettings?: Partial<typeof defaultSolverSettings>;
  locationsEnabled?: boolean;
}) => {
  const classRowDefs = classRows.map((row) => makeClassRow(row));
  const clinician = {
    id: "clin-1",
    name: "Dr. Test",
    qualifiedClassIds: classRowDefs.map((row) => row.id),
    preferredClassIds: classRowDefs.map((row) => row.id),
    vacations: [],
  };
  const nextAssignments =
    assignments ??
    [
      {
        id: `assign-${dateISO}-clin-1`,
        rowId: poolRowId,
        dateISO,
        clinicianId: "clin-1",
      },
    ];
  const minSlotsByRowId = Object.fromEntries(
    classRowDefs.map((row) => [`${row.id}::s1`, { weekday: 1, weekend: 1 }]),
  );

  return {
    locations: [{ id: "loc-default", name: "Default" }],
    locationsEnabled,
    rows: [
      {
        id: "pool-rest-day",
        name: "Rest Day",
        kind: "pool",
        dotColorClass: "bg-slate-200",
      },
      {
        id: "pool-vacation",
        name: "Vacation",
        kind: "pool",
        dotColorClass: "bg-slate-200",
      },
      ...classRowDefs,
    ],
    clinicians: [clinician],
    assignments: nextAssignments,
    minSlotsByRowId,
    slotOverridesByKey: {},
    holidays: [],
    publishedWeekStartISOs: [],
    solverSettings: { ...defaultSolverSettings, ...solverSettings },
    solverRules: [],
  };
};

const buildTemplateState = ({
  dateISO,
  classRows,
  blocks,
  slots,
  rowBands,
  columnCounts,
  solverSettings = {},
}: {
  dateISO: string;
  classRows: TestClassRow[];
  blocks: Array<{ id: string; sectionId: string; label?: string }>;
  slots: Array<{
    id: string;
    locationId: string;
    rowBandId: string;
    colBandId: string;
    blockId: string;
    requiredSlots: number;
    startTime?: string;
    endTime?: string;
    endDayOffset?: number;
  }>;
  rowBands: Array<{ id: string; label: string; order: number }>;
  columnCounts?: Partial<Record<(typeof DAY_TYPES)[number], number>>;
  solverSettings?: Partial<typeof defaultSolverSettings>;
}) => {
  const base = buildTestState({ dateISO, classRows, solverSettings });
  const locationId = base.locations[0]?.id ?? "loc-default";
  const colBands = DAY_TYPES.flatMap((dayType) => {
    const count = Math.max(1, columnCounts?.[dayType] ?? 1);
    return Array.from({ length: count }, (_, index) => ({
      id: `${locationId}-col-${dayType}-${index + 1}`,
      label: "",
      order: index + 1,
      dayType,
    }));
  });
  return {
    ...base,
    weeklyTemplate: {
      version: 4,
      blocks: blocks.map((block) => ({
        id: block.id,
        sectionId: block.sectionId,
        label: block.label,
        requiredSlots: 0,
      })),
      locations: [
        {
          locationId,
          rowBands,
          colBands,
          slots,
        },
      ],
    },
  };
};

const today = new Date();
const weekStart = startOfWeek(today);
const testDateISO = toISODate(weekStart);
const slotRowId = slotRowIdForDate(classRowId, testDateISO);

const loginViaUI = async (
  page: import("@playwright/test").Page,
  testInfo?: import("@playwright/test").TestInfo,
) => {
  await page.goto("/");
  if (testInfo) {
    await attachStepScreenshot(page, testInfo, "login-screen");
  }
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.fill("#login-username", UI_USERNAME);
  await page.fill("#login-password", UI_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator('[data-schedule-grid="true"]')).toBeVisible();
  if (testInfo) {
    await attachStepScreenshot(page, testInfo, "schedule-after-login");
  }
};

test.describe.serial("app flows", () => {
  let token = "";
  let originalState: unknown = null;

  test.beforeAll(async ({ request }) => {
    token = await fetchAuthToken(request);
    const stateRes = await request.get(`${API_BASE}/v1/state`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!stateRes.ok()) {
      throw new Error(`Failed to fetch state: ${stateRes.status()}`);
    }
    originalState = await stateRes.json();
  });

  test.afterAll(async ({ request }) => {
    if (!token || !originalState) return;
    await request.post(`${API_BASE}/v1/state`, {
      headers: { Authorization: `Bearer ${token}` },
      data: originalState,
    });
  });

  test.beforeEach(async ({ page, request }) => {
    await seedAuthToken(page, token);
    await request.post(`${API_BASE}/v1/state`, {
      headers: { Authorization: `Bearer ${token}` },
      data: buildTestState({ dateISO: testDateISO }),
    });
  });

  test("schedule view loads with core panels", async ({ page }, testInfo) => {
    await page.goto("/");
    await attachStepScreenshot(page, testInfo, "schedule-core-panels");
    await expect(page.getByText("Automated Shift Planning")).toBeVisible();
    await expect(page.getByRole("button", { name: "Open Export" })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Open Vacation Planner" }),
    ).toBeVisible();
    await expect(page.locator('[data-schedule-grid="true"]')).toBeVisible();
    const shell = page.locator('[data-schedule-shell="true"]');
    await expect(shell).toBeVisible();
    const cornersAreClipped = await shell.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const inset = 2;
      const points = [
        [rect.left + inset, rect.top + inset],
        [rect.right - inset, rect.top + inset],
        [rect.left + inset, rect.bottom - inset],
        [rect.right - inset, rect.bottom - inset],
      ];
      return points.every(([x, y]) => {
        const element = document.elementFromPoint(x, y);
        return element ? !element.closest('[data-schedule-grid="true"]') : true;
      });
    });
    expect(cornersAreClipped).toBe(true);
  });

  test("settings view opens from top bar", async ({ page }, testInfo) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Settings" }).click();
    await attachStepScreenshot(page, testInfo, "settings-open");
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    await expect(page.getByText("Weekly Calendar Template")).toBeVisible();
  });

  test("template delete buttons appear on hover (row + column)", async ({
    page,
    request,
  }, testInfo) => {
    const locationId = "loc-default";
    const rowBandId = "row-1";
    const colBandId = `${locationId}-col-mon-1`;
    const state = buildTemplateState({
      dateISO: testDateISO,
      classRows: [{ id: primaryClassId, name: "MRI" }],
      blocks: [{ id: "block-1", sectionId: primaryClassId }],
      rowBands: [{ id: rowBandId, label: "Row 1", order: 1 }],
      slots: [
        {
          id: "slot-1",
          locationId,
          rowBandId,
          colBandId,
          blockId: "block-1",
          requiredSlots: 1,
          startTime: "08:00",
          endTime: "16:00",
          endDayOffset: 0,
        },
      ],
      columnCounts: { mon: 1 },
    });
    await request.post(`${API_BASE}/v1/state`, {
      headers: { Authorization: `Bearer ${token}` },
      data: state,
    });
    await page.goto("/");
    await page.getByRole("button", { name: "Settings" }).click();
    const rowCell = page.locator(`[data-row-band-id="${rowBandId}"]`).first();
    const deleteRow = page.getByTestId(`delete-row-${locationId}-${rowBandId}`);
    // Button exists but has opacity-0 when not hovered
    await expect(deleteRow).toHaveCSS("opacity", "0");
    await rowCell.hover();
    await expect(deleteRow).toHaveCSS("opacity", "1");
    const columnCell = page.locator('[data-column-key="mon-0"]').first();
    const deleteColumn = page.getByTestId("delete-column-mon-0");
    // Move mouse away first so button isn't hovered
    await page.mouse.move(0, 0);
    await expect(deleteColumn).toHaveCSS("opacity", "0");
    await columnCell.hover();
    await expect(deleteColumn).toHaveCSS("opacity", "1");
    await attachStepScreenshot(page, testInfo, "template-delete-hover");
  });

  test("vacation overview modal opens", async ({ page }, testInfo) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Open Vacation Planner" }).click();
    await attachStepScreenshot(page, testInfo, "vacation-overview-open");
    await expect(page.getByText("Vacation Overview")).toBeVisible();
    await page
      .getByRole("button", { name: "Close" })
      .filter({ hasText: "Close" })
      .click();
    await attachStepScreenshot(page, testInfo, "vacation-overview-closed");
    await expect(page.getByText("Vacation Overview")).toBeHidden();
  });

  test("dragging a clinician from pool assigns them to a shift", async ({ page }, testInfo) => {
    await page.goto("/");
    const poolCell = page.locator(
      `[data-schedule-cell=\"true\"][data-row-id=\"${poolRowId}\"][data-date-iso=\"${testDateISO}\"]`,
    );
    const shiftCell = page.locator(
      `[data-schedule-cell=\"true\"][data-row-id=\"${slotRowId}\"][data-date-iso=\"${testDateISO}\"]`,
    );
    const draggable = poolCell.locator('div[draggable="true"]').first();
    await expect(draggable).toBeVisible();
    await attachStepScreenshot(page, testInfo, "drag-before");
    await draggable.dragTo(shiftCell);
    await attachStepScreenshot(page, testInfo, "drag-after");
    await expect(shiftCell.getByText("Dr. Test")).toBeVisible();
  });

  test("solver allocates open slots in the visible week", async ({ page }, testInfo) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Current week" }).click();
    await attachStepScreenshot(page, testInfo, "solver-before");
    await page.getByRole("button", { name: "Run" }).click();
    const shiftCell = page.locator(
      `[data-schedule-cell=\"true\"][data-row-id=\"${slotRowId}\"][data-date-iso=\"${testDateISO}\"]`,
    );
    await expect(shiftCell.getByText("Dr. Test")).toBeVisible();
    await attachStepScreenshot(page, testInfo, "solver-after");
  });

  test("overlapping shifts block a second drop", async ({ page, request }, testInfo) => {
    const locationId = "loc-default";
    const dayType = getDayTypeForISO(testDateISO);
    const colBandId1 = `${locationId}-col-${dayType}-1`;
    const colBandId2 = `${locationId}-col-${dayType}-2`;
    await request.post(`${API_BASE}/v1/state`, {
      headers: { Authorization: `Bearer ${token}` },
      data: buildTemplateState({
        dateISO: testDateISO,
        classRows: [{ id: primaryClassId, name: "MRI" }],
        solverSettings: {},
        blocks: [{ id: "block-1", sectionId: primaryClassId }],
        rowBands: [
          { id: `${locationId}-row-1`, label: "", order: 1 },
          { id: `${locationId}-row-2`, label: "", order: 2 },
        ],
        columnCounts: { [dayType]: 2 },
        slots: [
          {
            id: "slot-1",
            locationId,
            rowBandId: `${locationId}-row-1`,
            colBandId: colBandId1,
            blockId: "block-1",
            requiredSlots: 1,
            startTime: "08:00",
            endTime: "12:00",
            endDayOffset: 0,
          },
          {
            id: "slot-2",
            locationId,
            rowBandId: `${locationId}-row-2`,
            colBandId: colBandId2,
            blockId: "block-1",
            requiredSlots: 1,
            startTime: "10:00",
            endTime: "14:00",
            endDayOffset: 0,
          },
        ],
      }),
    });
    await page.goto("/");
    const poolCell = page.locator(
      `[data-schedule-cell=\"true\"][data-row-id=\"${poolRowId}\"][data-date-iso=\"${testDateISO}\"]`,
    );
    const firstCell = page.locator(
      `[data-schedule-cell=\"true\"][data-row-id=\"slot-1\"][data-date-iso=\"${testDateISO}\"]`,
    );
    const secondCell = page.locator(
      `[data-schedule-cell=\"true\"][data-row-id=\"slot-2\"][data-date-iso=\"${testDateISO}\"]`,
    );
    await poolCell.locator('div[draggable="true"]').first().dragTo(firstCell);
    await attachStepScreenshot(page, testInfo, "overlap-first-drop");
    await expect(firstCell.getByText("Dr. Test")).toBeVisible();
    await expect(poolCell.getByText("Dr. Test")).toHaveCount(0);
    await attachStepScreenshot(page, testInfo, "overlap-after");
    await expect(secondCell.getByText("Dr. Test")).toHaveCount(0);
  });

  test("adding a block in settings does not change another slot time", async ({
    page,
    request,
  }, testInfo) => {
    const locationId = "loc-default";
    const dayType = getDayTypeForISO(testDateISO);
    const colBandId = `${locationId}-col-${dayType}-1`;
    const rowBand1 = `${locationId}-row-1`;
    const rowBand2 = `${locationId}-row-2`;
    await request.post(`${API_BASE}/v1/state`, {
      headers: { Authorization: `Bearer ${token}` },
      data: buildTemplateState({
        dateISO: testDateISO,
        classRows: [
          { id: primaryClassId, name: "MRI Prostate" },
          { id: secondaryClassId, name: "CT" },
        ],
        blocks: [
          { id: "block-1", sectionId: primaryClassId },
          { id: "block-2", sectionId: secondaryClassId },
        ],
        rowBands: [
          { id: rowBand1, label: "", order: 1 },
          { id: rowBand2, label: "", order: 2 },
        ],
        slots: [
          {
            id: "slot-1",
            locationId,
            rowBandId: rowBand1,
            colBandId,
            blockId: "block-1",
            requiredSlots: 1,
            startTime: "08:00",
            endTime: "12:00",
            endDayOffset: 0,
          },
        ],
      }),
    });
    await page.goto("/");
    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    const timeTrigger = page.locator('[data-slot-time-trigger="slot-1"]');
    await expect(timeTrigger).toHaveText(/0?8:00\s*-\s*12:00/);
    await attachStepScreenshot(page, testInfo, "settings-time-before");
    const emptyCell = page.locator(
      `[data-add-block-trigger="true"][data-day-type="${dayType}"][data-col-index="0"]`,
    );
    await expect(emptyCell).toHaveCount(1);
    await emptyCell.click();
    const addPanel = page.locator("[data-add-block-panel]");
    await expect(addPanel).toBeVisible();
    await addPanel.getByRole("button", { name: "CT" }).click();
    await expect(timeTrigger).toHaveText(/0?8:00\s*-\s*12:00/);
    await attachStepScreenshot(page, testInfo, "settings-time-after");
  });

  test("dragging a clinician back to the pool removes the shift assignment", async ({
    page,
    request,
  }, testInfo) => {
    await request.post(`${API_BASE}/v1/state`, {
      headers: { Authorization: `Bearer ${token}` },
      data: buildTestState({
        dateISO: testDateISO,
        assignments: [
          {
            id: `assign-${testDateISO}-clin-1`,
            rowId: slotRowId,
            dateISO: testDateISO,
            clinicianId: "clin-1",
          },
        ],
      }),
    });
    await page.goto("/");
    const poolCell = page.locator(
      `[data-schedule-cell=\"true\"][data-row-id=\"${poolRowId}\"][data-date-iso=\"${testDateISO}\"]`,
    );
    const shiftCell = page.locator(
      `[data-schedule-cell=\"true\"][data-row-id=\"${slotRowId}\"][data-date-iso=\"${testDateISO}\"]`,
    );
    const draggable = shiftCell.locator('div[draggable="true"]').first();
    await expect(draggable).toBeVisible();
    await attachStepScreenshot(page, testInfo, "drag-back-before");
    await draggable.dragTo(poolCell);
    await attachStepScreenshot(page, testInfo, "drag-back-after");
    await expect(shiftCell.getByText("Dr. Test")).toHaveCount(0);
    await expect(poolCell.getByText("Dr. Test")).toBeVisible();
  });

  test("reset clears assignments in range", async ({
    page,
    request,
  }, testInfo) => {
    await request.post(`${API_BASE}/v1/state`, {
      headers: { Authorization: `Bearer ${token}` },
      data: buildTestState({
        dateISO: testDateISO,
        assignments: [
          {
            id: `assign-${testDateISO}-clin-1`,
            rowId: slotRowId,
            dateISO: testDateISO,
            clinicianId: "clin-1",
          },
        ],
      }),
    });
    await page.goto("/");
    const shiftCell = page.locator(
      `[data-schedule-cell=\"true\"][data-row-id=\"${slotRowId}\"][data-date-iso=\"${testDateISO}\"]`,
    );
    // Verify initial assignment exists
    await expect(shiftCell.getByText("Dr. Test")).toBeVisible();
    await attachStepScreenshot(page, testInfo, "reset-before");
    await page.getByRole("button", { name: "Current week" }).click();
    // "Reset" now opens a panel with "Reset Solver Only" / "Reset All"
    // instead of resetting directly behind a confirm dialog.
    await page.getByRole("button", { name: "Reset", exact: true }).click();
    await page.getByRole("button", { name: /Reset All/ }).click();
    // Verify assignment was removed
    await expect(shiftCell.getByText("Dr. Test")).toHaveCount(0);
    await attachStepScreenshot(page, testInfo, "reset-after");
  });

  test("weekly template day toggle switches the visible day", async ({ page }, testInfo) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByText("Weekly Calendar Template")).toBeVisible();
    await page
      .locator('[data-template-day-toggle="holiday"]')
      .click();
    await expect(
      page.locator('[data-template-day-header="holiday"]'),
    ).toBeVisible();
    await attachStepScreenshot(page, testInfo, "settings-day-toggle");
  });
});

test.describe.serial("ui login flows", () => {
  let token = "";
  let originalState: unknown = null;

  test.beforeAll(async ({ request }) => {
    token = await fetchAuthToken(request);
    const stateRes = await request.get(`${API_BASE}/v1/state`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!stateRes.ok()) {
      throw new Error(`Failed to fetch state: ${stateRes.status()}`);
    }
    originalState = await stateRes.json();
  });

  test.afterAll(async ({ request }) => {
    if (!token || !originalState) return;
    await request.post(`${API_BASE}/v1/state`, {
      headers: { Authorization: `Bearer ${token}` },
      data: originalState,
    });
  });

  test.beforeEach(async ({ request }) => {
    await request.post(`${API_BASE}/v1/state`, {
      headers: { Authorization: `Bearer ${token}` },
      data: buildTestState({ dateISO: testDateISO }),
    });
  });

  test("signs in via UI and loads the schedule view", async ({ page }, testInfo) => {
    await loginViaUI(page, testInfo);
    await expect(page.getByText("Automated Shift Planning")).toBeVisible();
    await attachStepScreenshot(page, testInfo, "ui-login-schedule");
  });

  test("signs in via UI and opens settings", async ({ page }, testInfo) => {
    await loginViaUI(page, testInfo);
    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    await expect(page.getByText("Weekly Calendar Template")).toBeVisible();
    await attachStepScreenshot(page, testInfo, "ui-login-settings");
  });

  test("signs in via UI and opens vacation overview", async ({ page }, testInfo) => {
    await loginViaUI(page, testInfo);
    await page.getByRole("button", { name: "Open Vacation Planner" }).click();
    await expect(page.getByText("Vacation Overview")).toBeVisible();
    await attachStepScreenshot(page, testInfo, "ui-login-vacation-open");
    await page
      .getByRole("button", { name: "Close" })
      .filter({ hasText: "Close" })
      .click();
    await expect(page.getByText("Vacation Overview")).toBeHidden();
    await attachStepScreenshot(page, testInfo, "ui-login-vacation-closed");
  });

  test("signs in via UI and allows dragging from pool to a shift", async ({
    page,
  }, testInfo) => {
    await loginViaUI(page, testInfo);
    const poolCell = page.locator(
      `[data-schedule-cell=\"true\"][data-row-id=\"${poolRowId}\"][data-date-iso=\"${testDateISO}\"]`,
    );
    const shiftCell = page.locator(
      `[data-schedule-cell=\"true\"][data-row-id=\"${slotRowId}\"][data-date-iso=\"${testDateISO}\"]`,
    );
    const draggable = poolCell.locator('div[draggable="true"]').first();
    await expect(draggable).toBeVisible();
    await attachStepScreenshot(page, testInfo, "ui-login-drag-before");
    await draggable.dragTo(shiftCell);
    await expect(shiftCell.getByText("Dr. Test")).toBeVisible();
    await attachStepScreenshot(page, testInfo, "ui-login-drag-after");
  });

  test("signs in via UI and runs automated planning for the visible week", async ({
    page,
  }, testInfo) => {
    await loginViaUI(page, testInfo);
    await page.getByRole("button", { name: "Current week" }).click();
    await attachStepScreenshot(page, testInfo, "ui-login-solver-before");
    await page.getByRole("button", { name: "Run" }).click();
    const shiftCell = page.locator(
      `[data-schedule-cell=\"true\"][data-row-id=\"${slotRowId}\"][data-date-iso=\"${testDateISO}\"]`,
    );
    await expect(shiftCell.getByText("Dr. Test")).toBeVisible();
    await attachStepScreenshot(page, testInfo, "ui-login-solver-after");
  });


  test("pdf export fits the full weekly table on one page", async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(60000);
    const locationId = "loc-default";
    const dayType = getDayTypeForISO(testDateISO);
    const colBandId = `${locationId}-col-${dayType}-1`;
    const rowBands = Array.from({ length: 12 }, (_, index) => ({
      id: `${locationId}-row-${index + 1}`,
      label: `Row ${index + 1}`,
      order: index + 1,
    }));
    const slots = rowBands.map((rowBand, index) => ({
      id: `slot-${index + 1}`,
      locationId,
      rowBandId: rowBand.id,
      colBandId,
      blockId: "block-1",
      requiredSlots: 1,
      startTime: "08:00",
      endTime: "16:00",
      endDayOffset: 0,
    }));
    await request.post(`${API_BASE}/v1/state`, {
      headers: { Authorization: `Bearer ${token}` },
      data: buildTemplateState({
        dateISO: testDateISO,
        classRows: [{ id: primaryClassId, name: "MRI" }],
        blocks: [{ id: "block-1", sectionId: primaryClassId }],
        rowBands,
        slots,
      }),
    });
    await seedAuthToken(page, token);
    await page.emulateMedia({ media: "print" });
    await page.goto(`/print/week?start=${encodeURIComponent(testDateISO)}`);
    await page.waitForFunction("window.__PDF_READY__ === true");
    await attachStepScreenshot(page, testInfo, "print-week-preview");
    const response = await request.get(
      `${API_BASE}/v1/pdf/week?start=${encodeURIComponent(testDateISO)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(response.ok()).toBeTruthy();
    const buffer = Buffer.from(await response.body());
    expect(buffer.toString("ascii", 0, 4)).toBe("%PDF");
    await testInfo.attach("week.pdf", {
      body: buffer,
      contentType: "application/pdf",
    });
    const pageCount = countPdfPages(buffer);
    expect(pageCount).toBe(1);

  });

  test("pdf export renders the clinic sheet layout, one week per page", async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(90000);
    const locationId = "loc-default";
    const dayType = getDayTypeForISO(testDateISO);
    const colBandId = `${locationId}-col-${dayType}-1`;
    const rowBands = Array.from({ length: 6 }, (_, index) => ({
      id: `${locationId}-row-${index + 1}`,
      label: `Arbeitsplatz ${index + 1}`,
      order: index + 1,
    }));
    const slots = rowBands.map((rowBand, index) => ({
      id: `slot-${index + 1}`,
      locationId,
      rowBandId: rowBand.id,
      colBandId,
      blockId: "block-1",
      requiredSlots: 1,
      startTime: "08:00",
      endTime: "16:00",
      endDayOffset: 0,
    }));
    await request.post(`${API_BASE}/v1/state`, {
      headers: { Authorization: `Bearer ${token}` },
      data: buildTemplateState({
        dateISO: testDateISO,
        classRows: [{ id: primaryClassId, name: "MRI" }],
        blocks: [{ id: "block-1", sectionId: primaryClassId }],
        rowBands,
        slots,
        solverSettings: { scheduleLayout: "clinicSheet" },
      }),
    });
    await seedAuthToken(page, token);
    await page.emulateMedia({ media: "print" });
    await page.goto(`/print/week?start=${encodeURIComponent(testDateISO)}`);
    await page.waitForFunction("window.__PDF_READY__ === true");
    // Sheet markers: German weekday headers and no classic assignment pills.
    await expect(page.locator("[data-schedule-grid]").first()).toBeVisible();
    expect(await page.locator("[data-assignment-pill]").count()).toBe(0);
    await attachStepScreenshot(page, testInfo, "print-week-clinic-sheet");
    const response = await request.get(
      `${API_BASE}/v1/pdf/week?start=${encodeURIComponent(testDateISO)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(response.ok()).toBeTruthy();
    const buffer = Buffer.from(await response.body());
    expect(buffer.toString("ascii", 0, 4)).toBe("%PDF");
    await testInfo.attach("week-clinic-sheet.pdf", {
      body: buffer,
      contentType: "application/pdf",
    });
    expect(countPdfPages(buffer)).toBe(1);

    const multiResponse = await request.get(
      `${API_BASE}/v1/pdf/weeks?start=${encodeURIComponent(testDateISO)}&weeks=3`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(multiResponse.ok()).toBeTruthy();
    const multiBuffer = Buffer.from(await multiResponse.body());
    expect(multiBuffer.toString("ascii", 0, 4)).toBe("%PDF");
    await testInfo.attach("weeks-clinic-sheet.pdf", {
      body: multiBuffer,
      contentType: "application/pdf",
    });
    expect(countPdfPages(multiBuffer)).toBe(3);
  });

  test("print layout fits within one A4 page and fills at least one dimension", async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(60000);
    const locationId = "loc-default";
    const dayType = getDayTypeForISO(testDateISO);
    const colBandId = `${locationId}-col-${dayType}-1`;
    const rowBands = Array.from({ length: 12 }, (_, index) => ({
      id: `${locationId}-row-${index + 1}`,
      label: `Row ${index + 1}`,
      order: index + 1,
    }));
    const slots = rowBands.map((rowBand, index) => ({
      id: `slot-${index + 1}`,
      locationId,
      rowBandId: rowBand.id,
      colBandId,
      blockId: "block-1",
      requiredSlots: 1,
      startTime: "08:00",
      endTime: "16:00",
      endDayOffset: 0,
    }));
    await request.post(`${API_BASE}/v1/state`, {
      headers: { Authorization: `Bearer ${token}` },
      data: buildTemplateState({
        dateISO: testDateISO,
        classRows: [{ id: primaryClassId, name: "MRI" }],
        blocks: [{ id: "block-1", sectionId: primaryClassId }],
        rowBands,
        slots,
      }),
    });
    await seedAuthToken(page, token);
    await page.emulateMedia({ media: "print" });
    await page.goto(`/print/week?start=${encodeURIComponent(testDateISO)}`);
    await page.waitForFunction("window.__PDF_READY__ === true");
    await attachStepScreenshot(page, testInfo, "print-layout");
    // The printable-area wrapper is positioned via inline styles (no
    // Tailwind "relative" class), so match the direct child instead.
    const layoutBox = await page
      .locator(".print-page > div")
      .first()
      .boundingBox();
    expect(layoutBox).not.toBeNull();
    const printable = getPrintableAreaPx();
    const landscapeFit =
      layoutBox!.width <= printable.landscape.width + 1 &&
      layoutBox!.height <= printable.landscape.height + 1;
    const portraitFit =
      layoutBox!.width <= printable.portrait.width + 1 &&
      layoutBox!.height <= printable.portrait.height + 1;
    expect(layoutBox!.width).toBeGreaterThan(0);
    expect(layoutBox!.height).toBeGreaterThan(0);
    expect(landscapeFit || portraitFit).toBeTruthy();
    const target = landscapeFit ? printable.landscape : printable.portrait;
    const coverageWidth = layoutBox!.width / target.width;
    const coverageHeight = layoutBox!.height / target.height;
    expect(Math.max(coverageWidth, coverageHeight)).toBeGreaterThanOrEqual(0.7);

    // Verify the content is centered on the page (the print layout centers
    // both axes via inline styles; the wrapper divs carry no Tailwind classes).
    const pageBox = await page.locator(".print-page").first().boundingBox();
    expect(pageBox).not.toBeNull();
    const contentBox = await page
      .locator(".print-page > div > div")
      .first()
      .boundingBox();
    expect(contentBox).not.toBeNull();
    // Horizontal centering: left and right margins should be approximately equal
    // Using a larger tolerance due to scale transforms and browser rendering differences
    const leftMargin = contentBox!.x - pageBox!.x;
    const rightMargin = (pageBox!.x + pageBox!.width) - (contentBox!.x + contentBox!.width);
    const marginDifference = Math.abs(leftMargin - rightMargin);
    expect(marginDifference).toBeLessThanOrEqual(80); // Within 80px of center (accounts for scaling)
    // Vertical centering: top and bottom margins should be approximately equal
    const topMargin = contentBox!.y - pageBox!.y;
    const bottomMargin = (pageBox!.y + pageBox!.height) - (contentBox!.y + contentBox!.height);
    expect(Math.abs(topMargin - bottomMargin)).toBeLessThanOrEqual(80);
  });
});
