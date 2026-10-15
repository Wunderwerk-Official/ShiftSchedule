import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HttpError, login } from "./client";

const values = new Map<string, string>();
beforeEach(() => {
  values.clear();
  values.set("authToken", "old-token");
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
});
afterEach(() => vi.unstubAllGlobals());

it("rejects wrong credentials with an HttpError 401 and no auth-expired event", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 401 })));
  const expired = vi.fn();
  window.addEventListener("auth-expired", expired);
  try {
    const error = await login("anna", "wrong").catch((err: unknown) => err);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(401);
    expect(expired).not.toHaveBeenCalled();
    expect(values.get("authToken")).toBe("old-token");
  } finally {
    window.removeEventListener("auth-expired", expired);
  }
});

it("keeps the status of server errors", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 503 })));
  const error = await login("anna", "secret").catch((err: unknown) => err);
  expect(error).toBeInstanceOf(HttpError);
  expect((error as HttpError).status).toBe(503);
});
