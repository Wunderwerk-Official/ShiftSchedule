import { afterEach, describe, expect, it, vi } from "vitest";
import { exportWeekPdf, exportWeeksPdf } from "./client";

describe("PDF export requests", () => {
  afterEach(() => vi.unstubAllGlobals());

  const stubFetch = () => {
    const fetchMock = vi.fn(async () => new Response(new Blob(["%PDF"]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  };
  const requestedUrl = (fetchMock: ReturnType<typeof stubFetch>) =>
    new URL(String((fetchMock.mock.calls[0] as unknown[])[0]), "http://localhost");

  it("asks for the portrait page only when chosen", async () => {
    let fetchMock = stubFetch();
    await exportWeekPdf("2026-01-05", "r1", "portrait");
    expect(requestedUrl(fetchMock).searchParams.get("layout")).toBe("portrait");
    expect(requestedUrl(fetchMock).searchParams.get("expected_revision")).toBe("r1");

    fetchMock = stubFetch();
    await exportWeekPdf("2026-01-05", "r1");
    expect(requestedUrl(fetchMock).searchParams.has("layout")).toBe(false);
  });

  it("hands the cancel signal to the request", async () => {
    const fetchMock = stubFetch();
    const abort = new AbortController();
    await exportWeekPdf("2026-01-05", "r1", "landscape", abort.signal);
    await exportWeeksPdf("2026-01-05", 2, "r1", "portrait", abort.signal);
    for (const call of fetchMock.mock.calls as unknown[][]) {
      expect((call[1] as RequestInit).signal).toBe(abort.signal);
    }
  });

  it("passes the layout for a multi-week export", async () => {
    const fetchMock = stubFetch();
    await exportWeeksPdf("2026-01-05", 3, "r2", "portrait");
    const url = requestedUrl(fetchMock);
    expect(url.pathname).toMatch(/\/v1\/pdf\/weeks$/);
    expect(url.searchParams.get("weeks")).toBe("3");
    expect(url.searchParams.get("layout")).toBe("portrait");
  });
});
