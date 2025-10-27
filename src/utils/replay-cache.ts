type CacheEntry = { expiresAt: number };

/**
 * A small TTL cache for replay protection. Stores message IDs until expiry.
 */
export class ReplayCache {
  private store: Map<string, CacheEntry> = new Map();
  private readonly ttlMs: number;

  constructor(ttlMs: number) {
    this.ttlMs = ttlMs;
  }

  /**
   * Returns true if the id has already been seen (and records it if not)
   */
  public seen(id: string): boolean {
    const now = Date.now();
    this.cleanup(now);
    const entry = this.store.get(id);
    if (entry && entry.expiresAt > now) return true;
    this.store.set(id, { expiresAt: now + this.ttlMs });
    return false;
  }

  /**
   * Remove expired entries
   */
  public cleanup(now: number = Date.now()): void {
    for (const [key, entry] of this.store.entries()) {
      if (entry.expiresAt <= now) this.store.delete(key);
    }
  }
}


