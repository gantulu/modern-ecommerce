// Trust only the edge-provided client address header; never use caller-controlled X-Forwarded-For.
export function rateLimitKey(request: Request): string {
  return request.headers.get("cf-connecting-ip")?.trim() || "ip:unknown";
}
