import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { mockProgressStream } from "./progress-stream";
import type { AgentActivityData, SolverProgressEvent } from "../src/api/client";

const state = JSON.parse(readFileSync(new URL("../backend/default_state.json", import.meta.url), "utf8"));
const run = { id: "live-demo", status: "running", has_result: false, attempt: 1,
  start_iso: "2026-01-05", end_iso: "2026-01-09", created_at: "2026-01-05T11:58:00Z" };

// Exercise the real calendar subscription, bounded state and overlay. No model
// call or shared calendar is modified by this replay.
async function start(page: Page) {
  await mockProgressStream(page);
  await page.clock.setFixedTime(new Date("2026-01-05T12:00:00Z"));
  await page.addInitScript(() => {
    localStorage.setItem("authToken", "test-token");
  });
  await page.route("**/auth/me", (route) => route.fulfill({ json: { username: "test", role: "user", active: true } }));
  await page.route("**/v1/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/state")) return route.fulfill({ json: { ...state, assignments: [], revision: "r0" } });
    if (path.endsWith("/solve/runs")) return route.fulfill({ json: { runs: [run] } });
    if (path.endsWith("/solve/runs/live-demo")) return route.fulfill({ json: run });
    if (path.endsWith("/agent/settings")) return route.fulfill({ json: { model: "mock", provider: "openai", effective_model: "mock" } });
    return route.fulfill({ json: { enabled: false } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Solver running..." }).click();
  await expect(page.getByText("AI Agent Planning", { exact: true })).toBeVisible();
}

async function send(page: Page, data: Partial<AgentActivityData>, token = run.id) {
  await progress(page, { event: "agent", data: { kind: "iteration", iteration: 17, max_iterations: 2000,
    moves_accepted: 23, time_ms: 100000, stage: "improve", phase_label: "Build the daily plan",
    day_index: 2, total_days: 5, planning_date: "2026-01-06", checks_progress: { revision: 23, total: 5, complete: 1 }, ...data, run_token: token } });
}

async function progress(page: Page, event: SolverProgressEvent) {
  await page.evaluate((value) => {
    (window as unknown as { activitySource: { onmessage: (e: { data: string }) => void } }).activitySource.onmessage({ data: JSON.stringify(value) });
  }, event);
}

test("live planning shows actual work, survives 300 events and keeps the reader's position", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await start(page);
  await send(page, { kind: "tool_start", tool: "suggest_rescue_moves", activity_id: 1,
    phase_label: "Build the daily plan", day_index: 2, total_days: 5, planning_date: "2026-01-06" });
  await expect(page.getByRole("status").filter({ hasText: "Searching for swaps" })).toBeVisible();
  await expect(page.getByText("Day 2 of 5 · Tue 06.01.", { exact: true })).toBeVisible();
  await send(page, { kind: "tool_result", tool: "suggest_rescue_moves", activity_id: 1, outcome: "warning",
    summary: "No option found in this search. More options remain unchecked.", duration_ms: 12400 });
  const feed = page.getByRole("region", { name: "Planning activity" });
  await expect(feed.getByText(/More options remain unchecked/)).toBeVisible();
  for (let i = 0; i < 300; i++) await send(page, { kind: "tool_result", tool: "get_day_priorities", activity_id: i + 2, time_ms: 101000 + i,
    summary: `Checked staffing needs ${i}`, duration_ms: 3 });
  await page.getByRole("button", { name: "Jump to latest ↓" }).click();
  await expect(feed.getByText("Checked staffing needs 299")).toBeVisible();
  await feed.evaluate((el) => { el.scrollTop = 80; });
  const before = await feed.evaluate((el) => el.scrollTop);
  await send(page, { kind: "iteration", iteration: 18, time_ms: 115000 });
  expect(await feed.evaluate((el) => el.scrollTop)).toBe(before);
  await expect(page.getByRole("status").filter({ hasText: "Waiting for the model" })).toBeVisible();
  await send(page, { kind: "stage", stage: "finalize" }, "unrelated-run");
  await expect(page.locator('[aria-label="Agent stage: AI improving"]')).toBeVisible();
  await expect(page.getByText("Day 2 of 5 · Tue 06.01.", { exact: true })).toBeVisible();

  await page.evaluate(() => (window as unknown as { activitySource: { onerror: (e: Event) => void } }).activitySource.onerror(new Event("error")));
  await expect(page.getByRole("status").filter({ hasText: "Live updates interrupted" })).toBeVisible();
  await progress(page, { event: "connected", data: {} });
  await send(page, { kind: "phase", phase_label: "Review the whole planning range", day_index: null, planning_date: null });
  await expect(page.getByText("Review the whole planning range").first()).toBeVisible();
  expect(errors).toEqual([]);
});

for (const mode of ["desktop", "dark", "mobile"] as const) {
  test(`planning display preview (${mode})`, async ({ page }, testInfo) => {
    await page.setViewportSize(mode === "mobile" ? { width: 390, height: 844 } : { width: 1440, height: 1024 });
    await start(page);
    if (mode === "dark") await page.evaluate(() => document.documentElement.classList.add("dark"));
    await send(page, { kind: "phase", time_ms: 10000 });
    await send(page, { kind: "tool_result", tool: "get_day_priorities", activity_id: 1, summary: "Open positions on this day: 4.", duration_ms: 124, time_ms: 30000 });
    await send(page, { kind: "tool_result", tool: "suggest_day_blocks", activity_id: 2, summary: "6 options returned.", duration_ms: 3420, time_ms: 52000 });
    await send(page, { kind: "moves_applied", improved: true, retained_best: true, time_ms: 60000, moves: [
      { action: "assign", clinician: "Dr. Jean Schmit", section: "MRI", dateISO: "2026-01-06", start: "08:00", end: "16:00" },
    ] });
    await progress(page, { event: "solution", data: { solution_num: 1, objective: 1, time_ms: 60000, run_token: run.id, assignments: [{
      id: "demo", rowId: state.weeklyTemplate.locations[0].slots[0].id, clinicianId: state.clinicians[0].id, dateISO: "2026-01-05", source: "solver",
    }] } });
    await send(page, { kind: "tool_start", tool: "suggest_balance_moves", activity_id: 3, time_ms: 100000 });
    await expect(page.getByText("Best saved draft", { exact: true })).toBeVisible();
    await expect(page.getByText("Day 2 of 5 · Tue 06.01.", { exact: true }).first()).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`${mode}.png`), animations: "disabled" });
  });
}

test("mobile planning actions and full model text remain accessible", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await start(page);
  await send(page, { kind: "tool_start", tool: "suggest_balance_moves", activity_id: 1,
    phase_label: "Build the daily plan", day_index: 2, total_days: 5, planning_date: "2026-01-06" });
  const action = page.getByRole("button", { name: "Run in background" });
  const box = await action.boundingBox();
  expect(box && box.x >= 0 && box.x + box.width <= 390).toBeTruthy();
  await send(page, { kind: "thought", reasoning: true, text: "MODEL START " + "Detailed model output. ".repeat(120) + "MODEL END" });
  await page.getByRole("checkbox", { name: "Include model text" }).check();
  await page.getByRole("button", { name: "Show full text" }).click();
  const dialog = page.getByRole("dialog", { name: "Model reasoning (full text)" });
  await expect(dialog.getByText(/MODEL END/)).toBeAttached();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "Show full text" })).toBeFocused();
  await action.click();
  await expect(page.getByRole("button", { name: "Solver running..." })).toBeVisible();
});

for (const width of [390, 1440]) {
  test(`full model response can be read and copied through its final character (${width}px)`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 700 });
    await start(page);
    const text = "START Äé🩺\n" + "Long model response with multiple lines.\n".repeat(900)
      + "UNBROKEN_" + "x".repeat(6000) + "\nEND OF COMPLETE RESPONSE";
    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
        writeText: async (value: string) => { Object.assign(window, { copiedModelText: value }); },
      } });
    });
    await send(page, { kind: "thought", reasoning: true, text, output_truncated: true });
    await page.getByRole("checkbox", { name: "Include model text" }).check();
    await page.getByRole("button", { name: "Show full text" }).click();
    const dialog = page.getByRole("dialog", { name: "Model reasoning (full text)" });
    await expect(dialog.getByText(/All received text is shown/)).toBeVisible();
    expect(await dialog.locator("pre").textContent()).toBe(text);
    const body = dialog.locator("pre").locator("..");
    const size = await body.evaluate((el) => ({ width: el.clientWidth, full: el.scrollWidth }));
    expect(size.full).toBeLessThanOrEqual(size.width + 1);
    await body.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    const endVisible = await dialog.locator("pre").evaluate((el) => {
      const textNode = el.firstChild!;
      const range = document.createRange();
      range.setStart(textNode, textNode.textContent!.length - 24);
      range.setEnd(textNode, textNode.textContent!.length);
      const rect = range.getBoundingClientRect();
      const body = el.parentElement!.getBoundingClientRect();
      return rect.top >= body.top && rect.bottom <= body.bottom + 1 && rect.right <= body.right;
    });
    expect(endVisible).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`full-model-text-${width}.png`), animations: "disabled" });
    await dialog.getByRole("button", { name: "Copy", exact: true }).click();
    expect(await page.evaluate(() => (window as unknown as { copiedModelText: string }).copiedModelText)).toBe(text);
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(dialog).toBeHidden();
  });
}
