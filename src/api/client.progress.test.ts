import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HttpError, subscribeSolverProgress } from "./client";

beforeEach(() => {
  const values = new Map([["authToken", "test-token"]]);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  vi.useFakeTimers();
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
function stream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancelled = vi.fn();
  const response = new Response(new ReadableStream<Uint8Array>({
    start(value) { controller = value; }, cancel: cancelled,
  }));
  return { response, controller, cancelled };
}
it("uses header auth and parses fragmented UTF-8/CRLF, multiline data and comments", async () => {
  const feed = stream();
  const fetcher = vi.fn().mockResolvedValue(feed.response);
  vi.stubGlobal("fetch", fetcher);
  const received = vi.fn();
  const stop = subscribeSolverProgress(received);
  await vi.advanceTimersByTimeAsync(0);
  expect(fetcher.mock.calls[0][0]).toMatch(/\/v1\/solve\/progress$/);
  expect(fetcher.mock.calls[0][1].headers.Authorization).toBe("Bearer test-token");
  const bytes = new TextEncoder().encode(': keepalive\r\ndata: {"event":"agent",\r\ndata: "data":{"text":"Ä🩺"}}\r\n\r\n');
  for (const byte of bytes) feed.controller.enqueue(new Uint8Array([byte]));
  await vi.advanceTimersByTimeAsync(0);
  expect(received).toHaveBeenCalledWith({ event: "agent", data: { text: "Ä🩺" } });
  stop();
  await vi.advanceTimersByTimeAsync(0);
  expect(feed.cancelled).toHaveBeenCalledOnce();
});
it("reconnects after transient failure and cancels pending retry on cleanup", async () => {
  const feed = stream();
  const fetcher = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(feed.response);
  vi.stubGlobal("fetch", fetcher);
  const error = vi.fn();
  const stop = subscribeSolverProgress(vi.fn(), error);
  await vi.advanceTimersByTimeAsync(999);
  expect(fetcher).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(fetcher).toHaveBeenCalledTimes(2);
  feed.controller.error(new Error("offline again"));
  await vi.advanceTimersByTimeAsync(0);
  stop();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(error).toHaveBeenCalledTimes(2);
});
it.each([401, 403, 404])("ends HTTP %s without retrying", async (status) => {
  const fetcher = vi.fn().mockResolvedValue(new Response(null, { status }));
  vi.stubGlobal("fetch", fetcher);
  const error = vi.fn();
  const stop = subscribeSolverProgress(vi.fn(), error);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(fetcher).toHaveBeenCalledOnce();
  expect(error.mock.calls[0][0]).toBeInstanceOf(HttpError);
  if (status === 401) expect(localStorage.getItem("authToken")).toBeNull();
  stop();
});
it("bounds network failures and stops reconnecting after account changes", async () => {
  const fetcher = vi.fn().mockRejectedValue(new Error("offline"));
  vi.stubGlobal("fetch", fetcher);
  const error = vi.fn();
  const stop = subscribeSolverProgress(vi.fn(), error);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(fetcher).toHaveBeenCalledTimes(6);
  expect(error.mock.lastCall?.[0].message).toContain("stopped after repeated");
  stop();
  fetcher.mockClear();
  const stopOther = subscribeSolverProgress(vi.fn());
  await vi.advanceTimersByTimeAsync(0);
  localStorage.setItem("authToken", "other-account");
  await vi.advanceTimersByTimeAsync(60_000);
  expect(fetcher).toHaveBeenCalledOnce();
  stopOther();
});

it("an old cancelled run response cannot sign out a newer account", async () => {
  const { getSolverRun } = await import("./client");
  let respond!: (response: Response) => void;
  vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise<Response>((resolve) => { respond = resolve; })));
  const controller = new AbortController();
  const pending = getSolverRun("old-run", controller.signal);
  const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  controller.abort();
  localStorage.setItem("authToken", "new-account-token");
  respond(new Response(null, { status: 401 }));
  await rejected;
  expect(localStorage.getItem("authToken")).toBe("new-account-token");
});
