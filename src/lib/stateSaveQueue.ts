/** Serialize local edits; never rebase a stale screen onto a newly loaded plan. */
export class StateSaveQueue<T extends { revision?: string | null }> {
  private tail: Promise<unknown> = Promise.resolve();
  private epoch = 0;
  private revision: string | null | undefined;
  private failure: Error | null = null;

  adopt(state: T) {
    this.epoch += 1;
    this.revision = state.revision;
    this.failure = null;
  }

  save(state: T, send: (state: T) => Promise<T>): Promise<T> {
    const epoch = this.epoch;
    const snapshot = JSON.parse(JSON.stringify(state)) as T;
    const pending = this.tail.then(async () => {
      if (epoch !== this.epoch) throw new Error("A newer calendar was loaded. This older save was cancelled.");
      if (this.failure) throw this.failure;
      try {
        const saved = await send({ ...snapshot, revision: this.revision });
        if (epoch === this.epoch) this.revision = saved.revision;
        return saved;
      } catch (error) {
        if (epoch === this.epoch) this.failure = error instanceof Error ? error : new Error("Saving failed.");
        throw error;
      }
    });
    this.tail = pending.catch(() => undefined);
    return pending;
  }

  async drain() {
    await this.tail;
    if (this.failure) throw this.failure;
  }

  /** The revision the next save is based on: the last one adopted or confirmed. */
  get baseRevision(): string | null | undefined {
    return this.revision;
  }

  retry() {
    // Keep the old revision. An uncertain earlier write must still pass CAS.
    this.failure = null;
  }
}
