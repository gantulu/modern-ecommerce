export interface OrderAccessRecord {
  user_id: string | null;
  guest_token_hash: string | null;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

export function constantTimeEqualHex(left: string, right: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(left) || !/^[0-9a-f]{64}$/i.test(right)) {
    return false;
  }
  const a = new TextEncoder().encode(left.toLowerCase());
  const b = new TextEncoder().encode(right.toLowerCase());
  let difference = 0;
  for (let index = 0; index < a.length; index++) difference |= a[index] ^ b[index];
  return difference === 0;
}

export async function authorizeOrderStatusRead(
  order: OrderAccessRecord,
  accessToken: string | null,
  guestToken: string | null,
  resolveUserId: (token: string) => Promise<string | null>,
): Promise<boolean> {
  if (order.user_id) {
    if (!accessToken) return false;
    const userId = await resolveUserId(accessToken);
    return userId !== null && userId === order.user_id;
  }

  if (!guestToken || !order.guest_token_hash) return false;
  return constantTimeEqualHex(
    await sha256Hex(guestToken),
    order.guest_token_hash,
  );
}
