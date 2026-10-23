import { createClient } from "npm:@supabase/supabase-js@2";
import { authorizeOrderStatusRead, sha256Hex } from "./authorization.ts";
import { rateLimitKey } from "./rate_limit.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

function parseAllowedOrigins(raw: string | undefined): Set<string> {
  const origins = new Set<string>();
  for (const value of (raw ?? "").split(",")) {
    const candidate = value.trim();
    if (!candidate) continue;
    try {
      const parsed = new URL(candidate);
      const isLocalDev = parsed.protocol === "http:" && ["localhost", "127.0.0.1"].includes(parsed.hostname);
      if (parsed.origin === candidate && (parsed.protocol === "https:" || isLocalDev)) origins.add(candidate);
    } catch {
      // Invalid entries are ignored; never fall back to wildcard CORS.
    }
  }
  return origins;
}

const allowedOrigins = parseAllowedOrigins(Deno.env.get("MEC_ALLOWED_ORIGINS"));
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
    headers["access-control-allow-headers"] = "authorization, apikey, content-type, x-mec-guest-token";
    headers["access-control-allow-methods"] = "GET, OPTIONS";
    headers["access-control-max-age"] = "600";
  }
  return headers;
}

function respond(body: Record<string, unknown>, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), { status, headers: headersFor(origin) });
}

function bearerToken(request: Request): string | null {
  const match = (request.headers.get("authorization") ?? "").match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

Deno.serve(async (request: Request) => {
  const origin = request.headers.get("origin");

  // The actual frontend origin has not yet been verified. Fail closed until an
  // explicit MEC_ALLOWED_ORIGINS allowlist is configured server-side.
  if (allowedOrigins.size === 0) {
    return respond({ success: false, error: "STATUS_API_ORIGIN_NOT_CONFIGURED" }, 503, origin);
  }

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: headersFor(origin) });
  }
  if (request.method !== "GET") {
    return respond({ success: false, error: "METHOD_NOT_ALLOWED" }, 405, origin);
  }
  if (!supabaseUrl || !serviceRoleKey) {
    return respond({ success: false, error: "STATUS_LOOKUP_FAILED" }, 500, origin);
  }

  const merchantOrderId = new URL(request.url).searchParams.get("merchantOrderId")?.trim() ?? "";
  if (!merchantOrderId || merchantOrderId.length > 128 || /[\u0000-\u001f\u007f]/.test(merchantOrderId)) {
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
    // Durable database-backed rate limit; the in-memory per-isolate limiter is not used.
    const keyHash = await sha256Hex(rateLimitKey(request));
    const { data: rateLimit, error: rateLimitError } = await db.rpc("mec_consume_status_rate_limit", {
      p_key_hash: keyHash,
      p_limit: 30,
      p_window_seconds: 60,
    });
    if (rateLimitError || !rateLimit) {
      return respond({ success: false, error: "STATUS_LOOKUP_FAILED" }, 500, origin);
    }
    if (rateLimit.allowed !== true) {
      const response = respond({ success: false, error: "RATE_LIMITED" }, 429, origin);
      response.headers.set("retry-after", String(Math.max(1, Number(rateLimit.retry_after_seconds) || 1)));
      return response;
    }

    const { data: payment, error: paymentError } = await db
      .from("mec_payments")
      .select("id,order_id,merchant_order_id,payment_status,updated_at")
      .eq("merchant_order_id", merchantOrderId)
      .maybeSingle();

    if (paymentError) return respond({ success: false, error: "STATUS_LOOKUP_FAILED" }, 500, origin);
    if (!payment) return respond({ success: false, error: "PAYMENT_NOT_AVAILABLE" }, 404, origin);

    const { data: order, error: orderError } = await db
      .from("mec_orders")
      .select("id,user_id,order_status,guest_token_hash,updated_at")
      .eq("id", payment.order_id)
      .maybeSingle();

    if (orderError) return respond({ success: false, error: "STATUS_LOOKUP_FAILED" }, 500, origin);
    if (!order) return respond({ success: false, error: "PAYMENT_NOT_AVAILABLE" }, 404, origin);

    const authorized = await authorizeOrderStatusRead(
      { user_id: order.user_id, guest_token_hash: order.guest_token_hash },
      accessToken,
      guestToken || null,
      async (token) => {
        const { data, error } = await db.auth.getUser(token);
        return !error && data.user?.id ? data.user.id : null;
      },
    );
    if (!authorized) return respond({ success: false, error: "PAYMENT_NOT_AVAILABLE" }, 404, origin);

    return respond({
      success: true,
      payment: {
        merchant_order_id: payment.merchant_order_id,
        payment_status: payment.payment_status,
        order_status: order.order_status,
        updated_at: payment.updated_at,
      },
    }, 200, origin);
  } catch {
    return respond({ success: false, error: "STATUS_LOOKUP_FAILED" }, 500, origin);
  }
});
