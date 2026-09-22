import type { Page } from "@playwright/test";

/** Replay authenticated fetch-SSE without a server or model call. */
export async function mockProgressStream(page: Page) {
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    const pending: string[] = [];
    const encoder = new TextEncoder();
    const source = {
      onmessage: (event: { data: string }) => {
        const chunk = `data: ${event.data}\n\n`;
        if (controller) controller.enqueue(encoder.encode(chunk));
        else pending.push(chunk);
      },
      onerror: () => {
        controller?.error(new Error("Connection interrupted"));
        controller = null;
      },
    };
    Object.assign(window, { activitySource: source });
    window.fetch = async (input, options) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!new URL(url, window.location.origin).pathname.endsWith("/v1/solve/progress")) {
        return originalFetch(input, options);
      }
      const stream = new ReadableStream<Uint8Array>({
        start(active) {
          controller = active;
          for (const chunk of pending.splice(0)) active.enqueue(encoder.encode(chunk));
          options?.signal?.addEventListener("abort", () => {
            Object.assign(window, { progressAborted: true });
            if (controller === active) { controller = null; active.close(); }
          }, { once: true });
        },
        cancel() { controller = null; },
      });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
    };
  });
}
