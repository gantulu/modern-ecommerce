import { createClient } from "npm:@supabase/supabase-js@2";
import { SlidingWindowRateLimiter, rateLimitKey } from "./rate_limit.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const statusRateLimiter = new SlidingWindowRateLimiter(30, 60_000);

const allowedOrigins = new Set([
  "https://asricollection.online",
  "http://localhost:5173",
]);

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store, max-age=0",
  "pragma": "no-cache",
  "vary": "Origin",
};

function headersFor(origin: string | null): HeadersInit {
  const headers: Record<string, string> = { ...jsonHeaders };
  if (origin && allowedOrigins.has(origin)) {
    headers["access-control-allow-origin"] = origin;
    headers["access-control-allow-headers"] =
      "authorization, apikey, content-type, x-mec-guest-token";
    headers["access-control-allow-methods"] = "GET, OPTIONS";
    headers["access-control-max-age"] = "600";
  }
  return headers;
}

function respond(
  body: Record<string, unknown>,
  status: number,
  origin: string | null,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: headersFor(origin),
  });
}

function bearerToken(request: Request): string | null {
  const value = request.headers.get("authorization") ?? "";
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return toHex(new Uint8Array(digest));
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left.toLowerCase());
  const b = new TextEncoder().encode(right.toLowerCase());
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index++) {
    difference |= a[index] ^ b[index];
  }
  return difference === 0;
}

Deno.serve(async (request: Request) => {
  const origin = request.headers.get("origin");

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: headersFor(origin) });
  }

  if (request.method !== "GET") {
    return respond({ success: false, error: "METHOD_NOT_ALLOWED" }, 405, origin);
  }

  const rateLimit = statusRateLimiter.check(rateLimitKey(request));
  if (!rateLimit.allowed) {
    const rateHeaders = new Headers(headersFor(origin));
    rateHeaders.set("retry-after", String(rateLimit.retryAfterSeconds));
    return new Response(JSON.stringify({ success: false, error: "RATE_LIMITED" }), {
      status: 429,
      headers: rateHeaders,
    });
  }

  if (!supabaseUrl || !serviceRoleKey) {
    return respond({ success: false, error: "STATUS_LOOKUP_FAILED" }, 500, origin);
  }

  const url = new URL(request.url);
  const merchantOrderId = url.searchParams.get("merchantOrderId")?.trim() ?? "";
  if (
    !merchantOrderId ||
    merchantOrderId.length > 128 ||
    /[\u0000-\u001f\u007f]/.test(merchantOrderId)
  ) {
    return respond({ success: false, error: "INVALID_REQUEST" }, 400, origin);
  }

  const accessToken = bearerToken(request);
  const guestToken = request.headers.get("x-mec-guest-token")?.trim() ?? "";
  if (!accessToken && !guestToken) {
    return respond({ success: false, error: "AUTHENTICATION_REQUIRED" }, 401, origin);
  }
  if (guestToken.length > 512) {
    return respond({ success: false, error: "PAYMENT_NOT_AVAILABLE" }, 404, origin);
  }

  const db = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    const { data: payment, error: paymentError } = await db
      .from("mec_payments")
      .select("id, order_id, merchant_order_id, payment_status, updated_at")
      .eq("merchant_order_id", merchantOrderId)
      .maybeSingle();

    if (paymentError) {
      return respond({ success: false, error: "STATUS_LOOKUP_FAILED" }, 500, origin);
    }
    if (!payment) {
      return respond({ success: false, error: "PAYMENT_NOT_AVAILABLE" }, 404, origin);
    }

    const { data: order, error: orderError } = await db
      .from("mec_orders")
      .select("id, user_id, order_status, guest_token_hash, updated_at")
      .eq("id", payment.order_id)
      .maybeSingle();

    if (orderError) {
      return respond({ success: false, error: "STATUS_LOOKUP_FAILED" }, 500, origin);
    }
    if (!order) {
      return respond({ success: false, error: "PAYMENT_NOT_AVAILABLE" }, 404, origin);
    }

    let authorized = false;
    if (order.user_id) {
      if (accessToken) {
        const { data: authData, error: authError } = await db.auth.getUser(accessToken);
        authorized = !authError && authData.user?.id === order.user_id;
      }
    } else if (guestToken && order.guest_token_hash) {
      authorized = constantTimeEqual(
        await sha256(guestToken),
        String(order.guest_token_hash),
      );
    }

    // Keep inaccessible and nonexistent orders indistinguishable.
    if (!authorized) {
      return respond({ success: false, error: "PAYMENT_NOT_AVAILABLE" }, 404, origin);
    }

    return respond({
      success: true,
      payment: {
        merchantOrderId: payment.merchant_order_id,
        paymentStatus: payment.payment_status,
        orderStatus: order.order_status,
        updatedAt: payment.updated_at,
      },
    }, 200, origin);
  } catch {
    // Do not return database errors, tokens, or internal details to callers.
    return respond({ success: false, error: "STATUS_LOOKUP_FAILED" }, 500, origin);
  }
});
