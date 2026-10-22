import { assertEquals } from "jsr:@std/assert@1";
import { SlidingWindowRateLimiter, rateLimitKey } from "./rate_limit.ts";

Deno.test("allows requests until the configured limit", () => {
  let now = 1_000;
  const limiter = new SlidingWindowRateLimiter(2, 60_000, 100, () => now);
  assertEquals(limiter.check("ip:a").allowed, true);
  assertEquals(limiter.check("ip:a").allowed, true);
  assertEquals(limiter.check("ip:a").allowed, false);
  now += 60_001;
  assertEquals(limiter.check("ip:a").allowed, true);
});

Deno.test("isolates rate-limit buckets by key", () => {
  const limiter = new SlidingWindowRateLimiter(1, 60_000);
  assertEquals(limiter.check("ip:a").allowed, true);
  assertEquals(limiter.check("ip:b").allowed, true);
  assertEquals(limiter.check("ip:a").allowed, false);
});

Deno.test("reports a retry delay when the limit is reached", () => {
  let now = 10_000;
  const limiter = new SlidingWindowRateLimiter(1, 5_000, 100, () => now);
  limiter.check("ip:a");
  now += 1_000;
  assertEquals(limiter.check("ip:a"), { allowed: false, retryAfterSeconds: 4 });
});

Deno.test("does not trust caller-controlled X-Forwarded-For", () => {
  const request = new Request("https://example.test", {
    headers: { "x-forwarded-for": "spoofed-address" },
  });
  assertEquals(rateLimitKey(request), "ip:unknown");
});

Deno.test("uses the edge-provided connecting IP", () => {
  const request = new Request("https://example.test", {
    headers: { "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "spoofed" },
  });
  assertEquals(rateLimitKey(request), "ip:203.0.113.7");
});
