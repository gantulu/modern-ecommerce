// Durable limiter key is derived from an authenticated Supabase user ID.
// The database stores only the SHA-256 hash, not the user ID itself.
export function rateLimitKey(userId: string): string {
  return `user:${userId}`;
}
