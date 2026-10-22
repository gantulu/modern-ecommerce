import { assertEquals } from "jsr:@std/assert@1";
import {
  authorizeOrderStatusRead,
  constantTimeEqualHex,
  sha256Hex,
} from "./authorization.ts";

const guestToken = "test-guest-token-with-sufficient-entropy";
const guestHash = await sha256Hex(guestToken);

Deno.test("authenticated order is readable by its owner", async () => {
  const allowed = await authorizeOrderStatusRead(
    { user_id: "user-1", guest_token_hash: null },
    "valid-access-token",
    null,
    async () => "user-1",
  );
  assertEquals(allowed, true);
});

Deno.test("authenticated order is not readable by another user", async () => {
  const allowed = await authorizeOrderStatusRead(
    { user_id: "user-1", guest_token_hash: null },
    "other-users-token",
    guestToken,
    async () => "user-2",
  );
  assertEquals(allowed, false);
});

Deno.test("invalid bearer token denies access to authenticated order", async () => {
  const allowed = await authorizeOrderStatusRead(
    { user_id: "user-1", guest_token_hash: null },
    "invalid-token",
    null,
    async () => null,
  );
  assertEquals(allowed, false);
});

Deno.test("guest order is readable with matching raw token hash", async () => {
  const allowed = await authorizeOrderStatusRead(
    { user_id: null, guest_token_hash: guestHash },
    null,
    guestToken,
    async () => null,
  );
  assertEquals(allowed, true);
});

Deno.test("guest order rejects invalid or missing token", async () => {
  assertEquals(await authorizeOrderStatusRead(
    { user_id: null, guest_token_hash: guestHash },
    null,
    "wrong-token",
    async () => null,
  ), false);
  assertEquals(await authorizeOrderStatusRead(
    { user_id: null, guest_token_hash: guestHash },
    null,
    null,
    async () => null,
  ), false);
});

Deno.test("hex comparison rejects malformed hashes and accepts uppercase hex", () => {
  assertEquals(constantTimeEqualHex(guestHash, guestHash.toUpperCase()), true);
  assertEquals(constantTimeEqualHex("not-a-hash", guestHash), false);
});
