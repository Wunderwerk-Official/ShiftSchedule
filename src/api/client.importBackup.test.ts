import { afterEach, describe, expect, it, vi } from "vitest";
import { adoptSavedState, createImportBackup, savedStateRevision, type AppState } from "./client";

describe("import backup request", () => {
  afterEach(() => vi.unstubAllGlobals());

  const state = { assignments: [] } as unknown as AppState;
  const stubFetch = (response: Response) => {
    const fetchMock = vi.fn(async () => response);
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  };
  const sentBody = (fetchMock: ReturnType<typeof stubFetch>) =>
    JSON.parse(String(((fetchMock.mock.calls[0] as unknown[])[1] as RequestInit).body));

  it("sends the revision the calendar is based on when there is one", async () => {
    let fetchMock = stubFetch(Response.json({ name: "Backup" }, { status: 201 }));
    await createImportBackup(state, "r3");
    expect(sentBody(fetchMock)).toEqual({ state, expectedRevision: "r3" });

    fetchMock = stubFetch(Response.json({ name: "Backup" }, { status: 201 }));
    await createImportBackup(state);
    expect(sentBody(fetchMock)).toEqual({ state });
  });

  it("passes on the server's reason for a refused backup", async () => {
    stubFetch(
      Response.json(
        { detail: { code: "state_changed", message: "The calendar changed in another tab or operation." } },
        { status: 409 },
      ),
    );
    await expect(createImportBackup(state, "old")).rejects.toThrow(
      "The calendar changed in another tab or operation.",
    );
  });

  it("knows the revision of the loaded calendar", async () => {
    adoptSavedState({ ...state, revision: "r9" });
    await expect(savedStateRevision()).resolves.toBe("r9");
  });
});
