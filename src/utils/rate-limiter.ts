import { logger } from '../logger';

type RateBucket = { count: number; resetAt: number };

export class RateLimiter {
  private buckets: Map<string, RateBucket>;
  private windowMs: number;
  private maxEvents: number;

  constructor(windowMs: number = 30_000, maxEvents: number = 4) {
    this.buckets = new Map();
    this.windowMs = windowMs;
    this.maxEvents = maxEvents;
  }

  /**
   * Check if an event is allowed for a given user
   * @param userId User identifier
   * @returns true if the event is allowed, false if rate limit exceeded
   */
  allowEvent(userId: string): boolean {
    const now = Date.now();
    const bucket = this.buckets.get(userId);

    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(userId, { count: 1, resetAt: now + this.windowMs });
      return true;
    }

    if (bucket.count < this.maxEvents) {
      bucket.count += 1;
      return true;
    }

    logger.debug({ userId, bucket }, 'Rate limit exceeded');
    return false;
  }

  /**
   * Clean up expired rate limit buckets to prevent memory leaks
   * @returns number of cleaned buckets
   */
  cleanExpired(): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [userId, bucket] of this.buckets.entries()) {
      if (bucket.resetAt <= now) {
        this.buckets.delete(userId);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.debug({ cleaned }, 'Cleaned expired rate limit buckets');
    }

    return cleaned;
  }

  /**
   * Start automatic cleanup of expired buckets
   * @param intervalMs Cleanup interval in milliseconds (default: 60000 = 1 minute)
   * @returns Interval timer
   */
  startAutoCleanup(intervalMs: number = 60000): NodeJS.Timeout {
    return setInterval(() => {
      this.cleanExpired();
    }, intervalMs);
  }

  /**
   * Get current bucket stats (useful for monitoring)
   */
  getStats() {
    return {
      activeBuckets: this.buckets.size,
      windowMs: this.windowMs,
      maxEvents: this.maxEvents
    };
  }
}

