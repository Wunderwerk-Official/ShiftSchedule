import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { mockProgressStream } from "./progress-stream";
import type { AppState, SolverRunSummary } from "../src/api/client";

const defaultState = JSON.parse(readFileSync(new URL("../backend/default_state.json", import.meta.url), "utf8"));

// Real UI, deterministic API responses. No model calls or shared database.
async function calendar(page: Page, options: {
  holdFirstSave?: boolean; confirmations?: boolean; emptyAbort?: boolean; saveConflict?: boolean;
  backgroundRun?: boolean;
  runError?: number; abortFails?: boolean; changeAfterPdf?: boolean;
} = {}) {
  await mockProgressStream(page);
  let state = { ...structuredClone(defaultState), assignments: [], revision: "r0" } as AppState;
  const assignment = {
    id: "applied-assignment", dateISO: "2026-01-05", source: "solver" as const,
    rowId: state.weeklyTemplate!.locations[0].slots[0].id, clinicianId: state.clinicians[0].id,
  };
  const run: SolverRunSummary = {
    id: "draft", status: options.backgroundRun ? "running" : options.emptyAbort ? "aborted" : "finished", has_result: true,
    start_iso: "2026-01-05", end_iso: "2026-01-05", attempt: 1,
    created_at: "2026-01-05T10:00:00", finished_at: "2026-01-05T10:01:00",
    apply_blocked_reason: options.emptyAbort ? "Stopped before producing a plan. Your calendar has been kept." : null,
    incomplete_dates: options.confirmations ? ["2026-01-05"] : [],
  };
  const saves: AppState[] = [];
  const applyCalls: URLSearchParams[] = [];
  const detailCalls: string[] = [];
  const pdfCalls: URLSearchParams[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  let releaseFirstSave!: () => void;
  const firstSave = new Promise<void>((resolve) => { releaseFirstSave = resolve; });
  await page.clock.setFixedTime(new Date("2026-01-05T12:00:00Z"));
  await page.addInitScript(() => {
    localStorage.setItem("authToken", "test-token");
  });
  await page.route("**/auth/me", (route) => route.fulfill({ json: { username: "test", role: "user", active: true } }));
  await page.route("**/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.endsWith("/v1/state")) {
      if (request.method() === "POST") {
        const payload = request.postDataJSON() as AppState;
        saves.push(payload);
        if (options.holdFirstSave && saves.length === 1) await firstSave;
        if (options.saveConflict || payload.revision !== state.revision) {
          return route.fulfill({ status: 409, json: { detail: {
            code: "state_changed", message: "The calendar changed in another window. Reload before saving.",
          } } });
        }
        state = { ...payload, revision: `r${saves.length}` };
      }
      return route.fulfill({ json: state });
    }
    if (url.pathname.endsWith("/v1/solve/runs")) return route.fulfill({ json: { runs: [run] } });
    if (url.pathname.endsWith("/v1/solve/runs/draft")) {
      detailCalls.push(url.pathname);
      return route.fulfill({ status: options.runError ?? 200, json: run });
    }
    if (url.pathname.endsWith("/v1/solve/abort")) {
      if (options.abortFails) return route.fulfill({ status: 500, json: { detail: "Stop failed" } });
      run.status = "aborted";
      return route.fulfill({ json: { status: "aborting", message: "Stopping" } });
    }
    if (url.pathname.includes("/v1/pdf/")) {
      pdfCalls.push(url.searchParams);
      if (url.searchParams.get("expected_revision") !== state.revision) {
        return route.fulfill({ status: 409, json: { detail: "The calendar changed during export. Reload and start a new export." } });
      }
      if (options.changeAfterPdf) state.revision = "external-edit";
      return route.fulfill({ contentType: "application/pdf", body: "%PDF-test" });
    }
    if (url.pathname.endsWith("/draft/apply")) {
      applyCalls.push(url.searchParams);
      if (options.confirmations && applyCalls.length <= 2) {
        const changed = applyCalls.length === 1;
        return route.fulfill({ status: 409, json: { detail: {
          code: changed ? "calendar_changed" : "partial_result", revision: state.revision,
          message: changed ? "The calendar changed. Apply this draft anyway?"
            : "Incomplete draft: 2 positions remain open on 2026-01-05. Applying removes 1 assignment. Apply anyway?",
        } } });
      }
      state = { ...state, assignments: [assignment], revision: "applied" };
      run.status = "applied";
      return route.fulfill({ json: { status: "applied", added: 1, replaced: 0 } });
    }
    if (url.pathname.endsWith("/v1/agent/settings")) return route.fulfill({ json: {
      model: "mock", provider: "openai", effective_model: "mock", budget_usd: 5, spent_usd: 0, remaining_usd: 5,
    } });
    return route.fulfill({ json: { enabled: false } });
  });
  await page.goto("/");
  await expect(page.locator('[data-schedule-grid="true"]')).toBeVisible();
  if (!options.backgroundRun) {
    await page.getByTitle("Solver history, weights & timeout").click();
    await expect(page.getByRole("button", { name: "Apply", exact: true })).toBeVisible();
  }
  return { saves, applyCalls, detailCalls, pdfCalls, releaseFirstSave, pageErrors,
    finishRun: () => { run.status = "finished"; }, state: () => state };
}

test("apply waits for pending saves and subsequent autosave preserves the applied plan", async ({ page }) => {
  const api = await calendar(page, { holdFirstSave: true });
  await expect.poll(() => api.saves.length).toBe(1);
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.getByText("Updating calendar…", { exact: true })).toBeVisible();
  expect(api.applyCalls).toHaveLength(0);
  api.releaseFirstSave();
  await expect.poll(() => api.saves.some((s) => s.revision === "applied")).toBe(true);
  expect(api.applyCalls).toHaveLength(1);
  expect(api.saves[1].revision).toBe("r1");
  expect(api.state().assignments.map((a) => a.id)).toEqual(["applied-assignment"]);
  await expect(page.getByText("Updating calendar…", { exact: true })).toBeHidden();
  expect(api.pageErrors).toEqual([]);
});

test("applying the best background draft preserves edits made while the run was active", async ({ page }) => {
  const api = await calendar(page, { backgroundRun: true });
  await expect(page.getByRole("button", { name: "Solver running..." })).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator('input[value="Rest Day"]').fill("Protected rest pool");
  await expect.poll(() => api.state().rows.find((row) => row.id === "pool-rest-day")?.name)
    .toBe("Protected rest pool");
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await page.getByRole("button", { name: "Solver running..." }).click();
  await page.evaluate(() => {
    (window as unknown as { activitySource: { onmessage: (e: { data: string }) => void } })
      .activitySource.onmessage({ data: JSON.stringify({ event: "solution", data: {
        run_token: "draft", solution_num: 1, objective: 1, time_ms: 1000, assignments: [],
      } }) });
  });
  await page.getByRole("button", { name: "Apply best plan", exact: true }).click();
  await expect.poll(() => api.applyCalls.length).toBe(1);
  await expect(page.getByText("Updating calendar…", { exact: true })).toBeHidden();
  await expect.poll(() => api.state().rows.find((row) => row.id === "pool-rest-day")?.name)
    .toBe("Protected rest pool");
  expect(api.state().assignments.map((a) => a.id)).toEqual(["applied-assignment"]);
  expect(api.pageErrors).toEqual([]);
});

test("changed and partial drafts require separate confirmations tied to the saved revision", async ({ page }) => {
  const api = await calendar(page, { confirmations: true });
  const dialogs: string[] = [];
  page.on("dialog", async (dialog) => { dialogs.push(dialog.message()); await dialog.accept(); });
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect.poll(() => api.applyCalls.length).toBe(3);
  expect(dialogs).toHaveLength(2);
  expect(dialogs[1]).toContain("2 positions remain open on 2026-01-05");
  expect(api.applyCalls[1].get("force")).toBe("true");
  expect(api.applyCalls[1].get("allow_partial")).toBeNull();
  expect(api.applyCalls[2].get("allow_partial")).toBe("true");
  expect(api.applyCalls[2].get("expected_revision")).toBe(api.applyCalls[1].get("expected_revision"));
  await expect.poll(() => api.state().assignments.length).toBe(1);
  expect(api.pageErrors).toEqual([]);
});

test("declining the partial draft keeps the calendar", async ({ page }) => {
  const api = await calendar(page, { confirmations: true });
  let count = 0;
  page.on("dialog", async (dialog) => { if (++count === 1) await dialog.accept(); else await dialog.dismiss(); });
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect.poll(() => count).toBe(2);
  await expect(page.getByText("Updating calendar…", { exact: true })).toBeHidden();
  expect(api.applyCalls).toHaveLength(2);
  expect(api.state().assignments).toEqual([]);
});

test("an empty aborted run cannot be applied from history", async ({ page }) => {
  const api = await calendar(page, { emptyAbort: true });
  await expect(page.getByRole("button", { name: "Apply", exact: true })).toBeDisabled();
  await expect(page.getByText("Stopped before producing a plan. Your calendar has been kept.")).toBeVisible();
  expect(api.applyCalls).toHaveLength(0);
});

test("a save conflict stays visible and retry never forces stale state over the server", async ({ page }) => {
  const api = await calendar(page, { saveConflict: true });
  await page.getByRole("button", { name: "Close", exact: true }).click();
  const alert = page.getByRole("alert").filter({ hasText: "The calendar changed in another window" });
  await expect(alert).toBeVisible();
  await alert.getByRole("button", { name: "Retry saving" }).click();
  await expect.poll(() => api.saves.length).toBe(2);
  await expect(alert).toBeVisible();
  expect(api.saves.map((s) => s.revision)).toEqual(["r0", "r0"]);
  expect(api.state().revision).toBe("r0");
});

for (const status of [401, 404]) {
  test(`run polling stops on terminal ${status}`, async ({ page }) => {
    const api = await calendar(page, { backgroundRun: true, runError: status });
    await expect.poll(() => api.detailCalls.length, { timeout: 8000 }).toBe(1);
    await expect(page.getByRole("button", { name: "Solver running..." })).toBeHidden();
    await page.waitForTimeout(4500);
    expect(api.detailCalls).toHaveLength(1);
    if (status === 401) expect(await page.evaluate(() => localStorage.getItem("authToken"))).toBeNull();
  });
}

test("signing out stops polling and the live stream", async ({ page }) => {
  const api = await calendar(page, { backgroundRun: true });
  await expect(page.getByRole("button", { name: "Solver running..." })).toBeVisible();
  await page.getByRole("button", { name: "Account", exact: true }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { progressAborted?: boolean }).progressAborted)).toBe(true);
  const count = api.detailCalls.length;
  await page.waitForTimeout(4500);
  expect(api.detailCalls).toHaveLength(count);
});

test("failed stop stays visible and never automatically applies the later result", async ({ page }) => {
  const api = await calendar(page, { backgroundRun: true, abortFails: true });
  await page.getByRole("button", { name: "Solver running..." }).click();
  await page.evaluate(() => {
    (window as unknown as { activitySource: { onmessage: (event: { data: string }) => void } }).activitySource.onmessage({
      data: JSON.stringify({ event: "solution", data: { solution_num: 1, objective: 1, time_ms: 1, assignments: [], run_token: "draft" } }),
    });
  });
  await page.getByRole("button", { name: "Apply best plan", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Stopping failed" })).toBeVisible();
  api.finishRun();
  await expect(page.getByRole("button", { name: "Apply", exact: true })).toBeVisible({ timeout: 8000 });
  expect(api.applyCalls).toHaveLength(0);
});

test("PDF export waits for saves and requests their exact revision", async ({ page }) => {
  const api = await calendar(page, { holdFirstSave: true });
  await expect.poll(() => api.saves.length).toBe(1);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Open Export", exact: true }).click();
  await page.getByRole("button", { name: "Export PDF", exact: true }).click();
  await expect(page.getByText("Saving calendar for export…", { exact: true })).toBeVisible();
  expect(api.pdfCalls).toHaveLength(0);
  api.releaseFirstSave();
  await expect.poll(() => api.pdfCalls.length).toBe(1);
  expect(api.pdfCalls[0].get("expected_revision")).toBe("r2");
});

test("PDF export refuses unsaved conflicts", async ({ page }) => {
  const api = await calendar(page, { saveConflict: true });
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Open Export", exact: true }).click();
  await page.getByRole("button", { name: "Export PDF", exact: true }).click();
  await expect(page.getByText("The calendar changed in another window. Reload before saving.").last()).toBeVisible();
  expect(api.pdfCalls).toHaveLength(0);
});

test("individual PDF batch keeps one revision and stops clearly after an external edit", async ({ page }) => {
  const api = await calendar(page, { changeAfterPdf: true });
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Open Export", exact: true }).click();
  await page.getByRole("button", { name: "Export PDF as individual files", exact: true }).click();
  await page.getByRole("button", { name: "1", exact: true }).click();
  await page.getByRole("button", { name: "2", exact: true }).click();
  await page.getByRole("button", { name: "Export PDF", exact: true }).click();
  await expect(page.getByText(/1 of 2 weeks downloaded. Export stopped/)).toBeVisible();
  expect(api.pdfCalls).toHaveLength(2);
  expect(api.pdfCalls[0].get("expected_revision")).toBe(api.pdfCalls[1].get("expected_revision"));
});
