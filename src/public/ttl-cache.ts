interface ICacheEntry<T> {
  value: T;
  expiresAt: number;
}

/** Minimal in-memory cache with TTL and a hard size cap (oldest entry evicted). */
export class TtlCache<T> {
  private readonly entries = new Map<string, ICacheEntry<T>>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 200,
  ) {}

  async getOrLoad(key: string, loader: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const hit = this.entries.get(key);
    if (hit && hit.expiresAt > now) {
      return hit.value;
    }

    const value = await loader();
    this.entries.delete(key);
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) {
        this.entries.delete(oldest.value);
      }
    }
    this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    return value;
  }
}
