import { describe, expect, it, vi } from "vitest";
import { StateSaveQueue } from "./stateSaveQueue";

type State = { revision?: string | null; value: number };
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

describe("calendar save ordering", () => {
  it("serializes rapid edits using the preceding successful save's revision", async () => {
    const queue = new StateSaveQueue<State>();
    queue.adopt({ revision: "r0", value: 0 });
    const first = deferred<State>();
    const send = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce({ revision: "r2", value: 2 });
    const one = queue.save({ value: 1 }, send);
    const two = queue.save({ value: 2 }, send);
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(1);
    first.resolve({ revision: "r1", value: 1 });
    await Promise.all([one, two]);
    expect(send.mock.calls.map(([state]) => state)).toEqual([
      { revision: "r0", value: 1 }, { revision: "r1", value: 2 },
    ]);
  });

  it("cancels queued old saves when an applied or restored calendar is adopted", async () => {
    const queue = new StateSaveQueue<State>();
    queue.adopt({ revision: "old", value: 0 });
    const first = deferred<State>();
    const send = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue({ revision: "newer", value: 4 });
    const one = queue.save({ value: 1 }, send);
    const two = queue.save({ value: 2 }, send);
    const rejected = expect(two).rejects.toThrow("older save was cancelled");
    await Promise.resolve();
    queue.adopt({ revision: "applied", value: 3 });
    first.resolve({ revision: "old-response", value: 1 });
    await one;
    await rejected;
    await queue.save({ value: 4 }, send);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0]).toEqual({ revision: "applied", value: 4 });
  });

  it("blocks queued saves after a conflict and never refreshes the revision to force a retry", async () => {
    const queue = new StateSaveQueue<State>();
    queue.adopt({ revision: "base", value: 0 });
    const send = vi.fn().mockRejectedValue(new Error("calendar changed"));
    const one = queue.save({ value: 1 }, send);
    const two = queue.save({ value: 2 }, send);
    await expect(one).rejects.toThrow("calendar changed");
    await expect(two).rejects.toThrow("calendar changed");
    await expect(queue.drain()).rejects.toThrow("calendar changed");
    expect(send).toHaveBeenCalledTimes(1);
    queue.retry();
    await expect(queue.save({ value: 2 }, send)).rejects.toThrow("calendar changed");
    expect(send.mock.calls[1][0].revision).toBe("base");
  });

  it("drains in-flight writes before another calendar operation proceeds", async () => {
    const queue = new StateSaveQueue<State>();
    const response = deferred<State>();
    const saved = queue.save({ value: 1 }, () => response.promise);
    const operation = vi.fn();
    const drained = queue.drain().then(operation);
    await Promise.resolve();
    expect(operation).not.toHaveBeenCalled();
    response.resolve({ revision: "saved", value: 1 });
    await saved;
    await drained;
    expect(operation).toHaveBeenCalledOnce();
  });
});

describe("base revision", () => {
  it("follows the adopted calendar and each confirmed save", async () => {
    const queue = new StateSaveQueue<State>();
    queue.adopt({ revision: "r0", value: 0 });
    expect(queue.baseRevision).toBe("r0");
    const saved = deferred<State>();
    const pending = queue.save({ value: 1 }, () => saved.promise);
    // A save in flight has not moved it yet; draining waits for it.
    expect(queue.baseRevision).toBe("r0");
    saved.resolve({ revision: "r1", value: 1 });
    await queue.drain();
    await pending;
    expect(queue.baseRevision).toBe("r1");
  });
});
