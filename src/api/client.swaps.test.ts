import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SwapApplyRequest, SwapCandidatesRequest } from "../lib/swaps/types";
import { SwapApiError, applySwap, findSwapCandidates, listSwapHistory, undoSwap } from "./client";

const values = new Map<string, string>();
beforeEach(() => {
  values.clear();
  values.set("authToken", "token-1");
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
});
afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const stubFetch = (response: Response) => {
  const fetchMock = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};
const call = (fetchMock: ReturnType<typeof stubFetch>) => {
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return { url: new URL(url, "http://localhost"), init };
};

const candidatesRequest: SwapCandidatesRequest = {
  mode: "swap",
  assignment: { assignmentId: "as-1", rowId: "night-thu", dateISO: "2026-11-19", clinicianId: "clin-anna" },
  slot: null,
  wholeDay: false,
  partnerId: null,
  range: "fourWeeks",
  dates: [],
  sameTypeOnly: false,
  expectedRevision: "rev-1",
};
const applyRequest: SwapApplyRequest = {
  mode: "handover",
  give: [{ rowId: "night-thu", dateISO: "2026-11-19", clinicianId: "clin-anna", fp: "1200-1920@loc#sec" }],
  wholeDay: false,
  slot: null,
  partnerId: "clin-ben",
  take: null,
  restDayMoves: [],
  removeHidden: null,
  expectedRevision: "rev-1",
  consent: true,
  note: null,
  approverName: null,
  overrideNotice: false,
  acknowledgedWarnings: [],
};
const caught = (promise: Promise<unknown>) => promise.then(() => null, (err: unknown) => err);

describe("swap API client", () => {
  it("posts the candidates request with the auth header and returns the JSON body", async () => {
    const fetchMock = stubFetch(json({ revision: "rev-1", best: [] }));
    await expect(findSwapCandidates(candidatesRequest)).resolves.toEqual({ revision: "rev-1", best: [] });
    const { url, init } = call(fetchMock);
    expect(url.pathname).toBe("/v1/swaps/candidates");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual(candidatesRequest);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer token-1");
  });

  it("posts apply and undo bodies to their paths (the swap id URL-encoded)", async () => {
    let fetchMock = stubFetch(json({ swap: { id: "swp-1" }, state: {} }));
    await applySwap(applyRequest);
    expect(call(fetchMock).url.pathname).toBe("/v1/swaps/apply");
    expect(JSON.parse(String(call(fetchMock).init.body))).toEqual(applyRequest);

    fetchMock = stubFetch(json({ swap: { id: "swp/1 a" }, state: {} }));
    await undoSwap("swp/1 a", "rev-2");
    const { url, init } = call(fetchMock);
    expect(url.pathname).toBe("/v1/swaps/swp%2F1%20a/undo");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ expectedRevision: "rev-2" });
  });

  it("loads the history with the keyset cursor as query parameters", async () => {
    let fetchMock = stubFetch(json({ swaps: [] }));
    await expect(listSwapHistory()).resolves.toEqual({ swaps: [] });
    expect(call(fetchMock).url.pathname).toBe("/v1/swaps/history");
    expect(call(fetchMock).url.search).toBe("");
    expect(call(fetchMock).init.method).toBeUndefined();

    fetchMock = stubFetch(json({ swaps: [] }));
    await listSwapHistory({ limit: 50, before: "2026-11-12T10:42:07+00:00", beforeId: "swp-9" });
    const params = call(fetchMock).url.searchParams;
    expect(params.get("limit")).toBe("50");
    expect(params.get("before")).toBe("2026-11-12T10:42:07+00:00");
    expect(params.get("beforeId")).toBe("swp-9");
  });

  it("turns a refusal into a SwapApiError with the server's code and message", async () => {
    stubFetch(json({ detail: { code: "swap_stale", message: "x" } }, 409));
    const error = await caught(applySwap(applyRequest));
    expect(error).toBeInstanceOf(SwapApiError);
    expect(error).toMatchObject({ status: 409, code: "swap_stale", message: "x" });
  });

  it("exposes revision, warnings and reasons of the detail", async () => {
    const warning = {
      id: "rest:clin-ben:2026-11-19T16:00:2026-11-19T20:00",
      code: "rest_short",
      check: "rest",
      clinicianId: "clin-ben",
      message: "Ben Ott: only 4.0 h rest.",
      short: "Short rest 4 h",
    };
    stubFetch(json({ detail: { code: "warnings_unacknowledged", message: "Check the warnings.", warnings: [warning] } }, 409));
    const unacknowledged = (await caught(applySwap(applyRequest))) as SwapApiError;
    expect(unacknowledged.warnings).toEqual([warning]);
    expect(unacknowledged.revision).toBeUndefined();
    expect(unacknowledged.reasons).toEqual([]);

    stubFetch(json({ detail: { code: "state_changed", message: "Changed.", revision: "rev-9" } }, 409));
    expect(((await caught(undoSwap("swp-1", "rev-1"))) as SwapApiError).revision).toBe("rev-9");

    stubFetch(json({ detail: { code: "swap_invalid", message: "Breaks a rule.", reasons: ["One.", "Two."] } }, 409));
    const invalid = (await caught(applySwap(applyRequest))) as SwapApiError;
    expect(invalid.reasons).toEqual(["One.", "Two."]);
    expect(invalid.warnings).toEqual([]);
  });

  it("keeps a plain string detail as the message, with no code", async () => {
    stubFetch(json({ detail: "Bad request." }, 400));
    expect(await caught(findSwapCandidates(candidatesRequest))).toMatchObject({
      status: 400,
      code: "",
      message: "Bad request.",
    });
  });

  it("falls back to a status message for unreadable bodies and validation lists", async () => {
    stubFetch(new Response("Bad gateway", { status: 502 }));
    expect(await caught(listSwapHistory())).toMatchObject({
      status: 502,
      code: "",
      message: "Failed to load swap history: 502",
    });
    stubFetch(json({ detail: [{ loc: ["body", "mode"], msg: "field required" }] }, 422));
    expect(await caught(findSwapCandidates(candidatesRequest))).toMatchObject({
      status: 422,
      code: "",
      message: "Failed to find swaps: 422",
    });
  });

  it("signals an expired session on 401 and drops the token", async () => {
    stubFetch(json({ detail: "Not authenticated" }, 401));
    const expired = vi.fn();
    window.addEventListener("auth-expired", expired);
    try {
      const error = await caught(listSwapHistory());
      expect(error).toBeInstanceOf(SwapApiError);
      expect((error as SwapApiError).status).toBe(401);
      expect(expired).toHaveBeenCalledOnce();
      expect(values.has("authToken")).toBe(false);
    } finally {
      window.removeEventListener("auth-expired", expired);
    }
  });
});
