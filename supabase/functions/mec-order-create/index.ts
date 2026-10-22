// DRAFT branch only. Depends on the proposed SQL contract in docs/proposed-migrations.
// Do not deploy until the draft SQL is reviewed, applied with explicit approval,
// the real frontend origin is confirmed, and the shared limiter is tested.
import { createClient } from "npm:@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("Missing server-side Supabase environment configuration");
}
const db = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// CORS candidate only: confirm the real production origin before deployment.
const allowedOrigins = new Set([
  "https://asricollection.online",
  "http://localhost:5173",
]);
const baseHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "vary": "Origin",
  "access-control-allow-headers": "authorization, apikey, content-type, idempotency-key, x-mec-guest-token",
  "access-control-allow-methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200, origin?: string) => {
  const headers = new Headers(baseHeaders);
  if (origin && allowedOrigins.has(origin)) headers.set("access-control-allow-origin", origin);
  return new Response(JSON.stringify(body), { status, headers });
};
const encoder = new TextEncoder();
const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
async function sha256(value: string) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}
function validText(v: unknown, max: number) {
  return typeof v === "string" && v.trim().length > 0 && v.trim().length <= max;
}
function normalizeItems(input: unknown): { product_id: string; quantity: number }[] | null {
  if (!Array.isArray(input) || input.length === 0 || input.length > 100) return null;
  const merged = new Map<string, number>();
  for (const item of input) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const productId = (item as Record<string, unknown>).product_id;
    const quantity = (item as Record<string, unknown>).quantity;
    if (typeof productId !== "string" || typeof quantity !== "number" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(productId) ||
        !Number.isSafeInteger(quantity) || Number(quantity) < 1 || Number(quantity) > 100) return null;
    const id = productId.toLowerCase();
    const next = (merged.get(id) ?? 0) + Number(quantity);
    if (next > 100) return null;
    merged.set(id, next);
  }
  return [...merged.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([product_id, quantity]) => ({ product_id, quantity }));
}
Deno.serve(async (req) => {
  const origin = req.headers.get("origin") ?? undefined;
  if (req.method === "OPTIONS") {
    if (origin && !allowedOrigins.has(origin)) return json({ error: "Origin not allowed" }, 403);
    return new Response(null, { status: 204, headers: {
      ...baseHeaders,
      ...(origin && allowedOrigins.has(origin) ? { "access-control-allow-origin": origin } : {}),
    } });
  }
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, origin);
  if (origin && !allowedOrigins.has(origin)) return json({ error: "Origin not allowed" }, 403);

  const idem = req.headers.get("idempotency-key")?.trim() ?? "";
  if (idem.length < 16 || idem.length > 128) {
    return json({ error: "A valid Idempotency-Key header is required" }, 400, origin);
  }
  let input: Record<string, unknown>;
  try {
    const parsed = await req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    input = parsed as Record<string, unknown>;
  } catch {
    return json({ error: "Valid JSON object required" }, 400, origin);
  }
  if (!validText(input.customer_name, 150) ||
      !validText(input.customer_email, 254) ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(input.customer_email).trim()) ||
      !validText(input.customer_phone, 50)) {
    return json({ error: "Valid customer name, email, and phone are required" }, 400, origin);
  }
  const items = normalizeItems(input.items);
  if (!items) return json({ error: "items must contain valid product_id and quantity values" }, 400, origin);

  let userId: string | null = null;
  const bearer = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (bearer) {
    const { data, error } = await db.auth.getUser(bearer);
    if (error || !data.user) return json({ error: "Invalid authentication" }, 401, origin);
    userId = data.user.id;
  }
  const rawGuestToken = req.headers.get("x-mec-guest-token") ?? "";
  if (!userId && !/^[A-Za-z0-9_-]{40,100}$/.test(rawGuestToken)) {
    return json({ error: "A high-entropy guest token is required" }, 401, origin);
  }
  if (userId && rawGuestToken) return json({ error: "Do not send a guest token for authenticated checkout" }, 400, origin);

  const guestTokenHash = userId ? null : await sha256(rawGuestToken);
  const customer = {
    name: String(input.customer_name).trim(),
    email: String(input.customer_email).trim().toLowerCase(),
    phone: String(input.customer_phone).trim(),
  };
  const identityScope = userId ? `user:${userId}` : `guest:${guestTokenHash}`;
  const canonicalRequest = JSON.stringify({
    identityScope, customer, items,
  });
  const requestHash = await sha256(canonicalRequest);

  // Shared atomic limiter: two dimensions, IP and authenticated/guest identity.
  // Cloudflare's cf-connecting-ip is used instead of spoofable X-Forwarded-For.
  const ip = req.headers.get("cf-connecting-ip") ?? "ip-unknown";
  const buckets = [
    await sha256(`mec-order-create:ip:${ip}`),
    await sha256(`mec-order-create:identity:${identityScope}`),
  ];
  for (const bucket of buckets) {
    const { data, error } = await db.rpc("mec_consume_rate_limit", {
      p_bucket_hash: bucket,
      p_window_seconds: 60,
      p_max_requests: 20,
    });
    if (error || !Array.isArray(data) || !data[0]) {
      console.error("Shared rate limiter unavailable", error?.code ?? "no_result");
      return json({ error: "Order service temporarily unavailable" }, 503, origin);
    }
    if (!data[0].allowed) {
      const headers = new Headers(baseHeaders);
      if (origin && allowedOrigins.has(origin)) headers.set("access-control-allow-origin", origin);
      headers.set("retry-after", String(data[0].retry_after_seconds));
      return new Response(JSON.stringify({ error: "Rate limit exceeded" }), { status: 429, headers });
    }
  }

  const { data, error } = await db.rpc("mec_create_order_idempotent", {
    p_idempotency_key: idem,
    p_request_hash: requestHash,
    p_customer_name: customer.name,
    p_customer_email: customer.email,
    p_customer_phone: customer.phone,
    p_items: items,
    p_user_id: userId,
    p_guest_token_hash: guestTokenHash,
    p_reservation_minutes: 15,
  });
  if (error || !Array.isArray(data) || !data[0]) {
    // Do not log customer fields, tokens, or the request body.
    console.error("MEC order creation failed", error?.code ?? "no_result");
    if (error?.code === "22023") return json({ error: "Invalid order request or idempotency conflict" }, 409, origin);
    if (error?.code === "23514" || error?.code === "22003") return json({ error: "Product inactive or stock insufficient" }, 409, origin);
    return json({ error: "Order creation outcome may be unknown; retry with the same key and same request" }, 503, origin);
  }
  const order = data[0];
  return json({
    order: {
      id: order.order_id,
      order_number: order.order_number,
      subtotal_amount: order.subtotal_amount,
      inventory_reserved_until: order.inventory_reserved_until,
    },
    replayed: Boolean(order.replayed),
  }, order.replayed ? 200 : 201, origin);
});
