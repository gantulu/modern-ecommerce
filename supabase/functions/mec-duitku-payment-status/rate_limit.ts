/**
 * Per-isolate fallback limiter for the MEC payment status endpoint.
 *
 * Important: Supabase Edge Function isolates do not share this Map. This is
 * abuse-friction, not a distributed production rate limiter. Before public
 * production traffic, replace/augment it with a shared atomic limiter (for
 * example, a dedicated database RPC or external rate-limit service).
 */
export class SlidingWindowRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys = 10_000,
    private readonly now: () => number = () => Date.now(),
  ) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("limit must be positive");
    if (!Number.isFinite(windowMs) || windowMs < 1) throw new Error("windowMs must be positive");
  }

  check(key: string): { allowed: boolean; retryAfterSeconds: number } {
    const currentTime = this.now();
    const windowStart = currentTime - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((time) => time > windowStart);

    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((recent[0] + this.windowMs - currentTime) / 1000)),
      };
    }

    recent.push(currentTime);
    this.hits.set(key, recent);

    if (this.hits.size > this.maxKeys) {
      for (const [storedKey, timestamps] of this.hits) {
        if (!timestamps.some((time) => time > windowStart)) this.hits.delete(storedKey);
      }
      while (this.hits.size > this.maxKeys) {
        const oldestKey = this.hits.keys().next().value;
        if (oldestKey === undefined) break;
        this.hits.delete(oldestKey);
      }
    }

    return { allowed: true, retryAfterSeconds: 0 };
  }
}

export function rateLimitKey(request: Request): string {
  // This header is supplied by the Supabase/Cloudflare edge, not browser JS.
  // If absent, all such requests share one bucket rather than trusting a
  // caller-controlled X-Forwarded-For value.
  const address = request.headers.get("cf-connecting-ip")?.trim();
  return address ? `ip:${address}` : "ip:unknown";
}
