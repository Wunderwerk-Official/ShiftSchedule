import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

const state = JSON.parse(readFileSync(new URL("../backend/default_state.json", import.meta.url), "utf8"));
async function settings(page: Page, options: { holdSave?: boolean; failSave?: boolean; holdCheck?: boolean; holdChat?: boolean } = {}) {
  const puts: unknown[] = [];
  const checks: string[] = [];
  const chats: unknown[] = [];
  const deliveredChecks: number[] = [];
  const deliveredChats: number[] = [];
  let releaseSave!: () => void;
  const saveGate = new Promise<void>((resolve) => { releaseSave = resolve; });
  let releaseCheck!: () => void;
  const checkGate = new Promise<void>((resolve) => { releaseCheck = resolve; });
  let releaseChat!: () => void;
  const chatGate = new Promise<void>((resolve) => { releaseChat = resolve; });
  let config = { provider: "openai", model: "mock", openai_model: "custom-old", effective_model: "custom-old", openai_base_url: "https://example.test/v1" };
  await page.addInitScript(() => localStorage.setItem("authToken", "test-token"));
  await page.route("**/auth/me", (route) => route.fulfill({ json: { username: "test", role: "admin", active: true } }));
  await page.route("**/auth/users", (route) => route.fulfill({ json: [] }));
  await page.route("**/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/state")) return route.fulfill({ json: { ...state, revision: "r0" } });
    if (path.endsWith("/solve/runs")) return route.fulfill({ json: { runs: [] } });
    if (path.endsWith("/admin/run-feedback")) return route.fulfill({ json: { feedback: [] } });
    if (path.endsWith("/agent/settings")) {
      if (route.request().method() === "PUT") {
        const patch = route.request().postDataJSON();
        puts.push(patch);
        if (options.holdSave && puts.length === 1) await saveGate;
        if (options.failSave) return route.fulfill({ status: 500, json: { detail: "Cannot save" } });
        config = { ...config, ...patch };
      }
      return route.fulfill({ json: config });
    }
    if (path.endsWith("/agent/model-check")) {
      checks.push(route.request().postDataJSON().model);
      const index = checks.length;
      if (options.holdCheck && index === 1) await checkGate;
      await route.fulfill({ json: index === 1 ? { ok: true, latency_seconds: 12 } : { ok: false, error: "Latest model unavailable" } }).catch(() => {});
      deliveredChecks.push(index);
      return;
    }
    if (path.endsWith("/agent/chat-test")) {
      chats.push(route.request().postDataJSON());
      if (options.holdChat) await chatGate;
      await route.fulfill({ json: { provider: "openai", model: "custom-old", text: "OLD MODEL REPLY", error: null,
        duration_seconds: 1, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, tokens_per_second: 1, cost_usd: null } }).catch(() => {});
      deliveredChats.push(chats.length);
      return;
    }
    return route.fulfill({ json: { enabled: false } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByPlaceholder("model name on your endpoint")).toHaveValue("custom-old");
  return { puts, checks, chats, deliveredChecks, deliveredChats, releaseSave, releaseCheck, releaseChat };
}

async function chooseModel(page: Page, name: string) {
  const input = page.getByPlaceholder("model name on your endpoint");
  await input.fill(name);
  await input.press("Tab");
}

test("model and chat checks wait until their settings save succeeds", async ({ page }) => {
  const api = await settings(page, { holdSave: true });
  await chooseModel(page, "custom-new");
  await expect.poll(() => api.puts.length).toBe(1);
  await page.getByPlaceholder("Type a test message…").fill("ping");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  expect(api.checks).toHaveLength(0);
  expect(api.chats).toHaveLength(0);
  api.releaseSave();
  await expect.poll(() => api.checks.length).toBe(1);
  await expect.poll(() => api.chats.length).toBe(1);
  expect(api.checks[0]).toBe("custom-new");
});

test("failed settings save blocks both model probes and chat test", async ({ page }) => {
  const api = await settings(page, { failSave: true });
  await chooseModel(page, "custom-new");
  await expect(page.getByText(/Could not save AI agent settings/).first()).toBeVisible();
  await page.getByPlaceholder("Type a test message…").fill("ping");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText(/Save them successfully before testing/).last()).toBeVisible();
  expect(api.checks).toHaveLength(0);
  expect(api.chats).toHaveLength(0);
});

test("delayed previous-model responses cannot replace the current model check", async ({ page }) => {
  const api = await settings(page, { holdCheck: true });
  await chooseModel(page, "model-a");
  await expect.poll(() => api.checks.length).toBe(1);
  await chooseModel(page, "model-b");
  await expect(page.getByText("Model not usable: Latest model unavailable")).toBeVisible();
  api.releaseCheck();
  await expect.poll(() => api.deliveredChecks.length).toBe(2);
  await expect(page.getByText(/Model responds/)).toBeHidden();
});

test("editing the endpoint invalidates a delayed chat reply", async ({ page }) => {
  const api = await settings(page, { holdChat: true });
  await page.getByPlaceholder("Type a test message…").fill("ping");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => api.chats.length).toBe(1);
  await page.locator('input[value="https://example.test/v1"]').fill("https://new.example.test/v1");
  api.releaseChat();
  await expect.poll(() => api.deliveredChats.length).toBe(1);
  await expect(page.getByText("OLD MODEL REPLY")).toBeHidden();
});
