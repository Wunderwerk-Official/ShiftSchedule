import { afterEach, describe, expect, it, vi } from "vitest";
import { createImportBackup, type AppState } from "./client";

describe("createImportBackup", () => {
  afterEach(() => vi.unstubAllGlobals());

  const sentBody = async (call: () => Promise<unknown>) => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ name: "backup" }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    await call();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/v1\/state\/snapshots\/import-backup$/);
    return JSON.parse(String(init.body));
  };
  const state = { assignments: [] } as unknown as AppState;

  it("sends no reason for a shifts file import, as before", async () => {
    expect(await sentBody(() => createImportBackup(state))).toEqual({ state });
  });

  it("names a backup before a holiday change", async () => {
    expect(await sentBody(() => createImportBackup(state, { reason: "holiday_change" }))).toEqual({
      state,
      reason: "holiday_change",
    });
  });
});
