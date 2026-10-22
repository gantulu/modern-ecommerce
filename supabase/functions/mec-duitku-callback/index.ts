import { createClient } from "npm:@supabase/supabase-js@2";

const url = Deno.env.get("SUPABASE_URL");
const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const merchant = Deno.env.get("DUITKU_MERCHANT_CODE");
const apiKey = Deno.env.get("DUITKU_API_KEY");
const db = url && key ? createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }) : null;

const text = (s: string, n: number) => new Response(s, {
  status: n,
  headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
});
const hex = (b: Uint8Array) => [...b].map(x => x.toString(16).padStart(2, "0")).join("");
async function hmac(s: string, k: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(k), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(s))));
}
async function sha(s: string) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))));
}
function equal(a: string, b: string) {
  const x = new TextEncoder().encode(a.toLowerCase());
  const y = new TextEncoder().encode(b.toLowerCase());
  if (x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

Deno.serve(async req => {
  if (req.method !== "POST") return text("Method Not Allowed", 405);
  if (!db || !merchant || !apiKey) return text("Server Configuration Error", 500);

  let p: Record<string, unknown>;
  try {
    const raw = await req.text();
    const ct = req.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      const v = JSON.parse(raw);
      if (!v || typeof v !== "object" || Array.isArray(v)) return text("Bad Parameter", 400);
      p = v;
    } else {
      p = Object.fromEntries(new URLSearchParams(raw).entries());
    }
  } catch {
    return text("Bad Parameter", 400);
  }

  const g = (k: string) => String(p[k] ?? "").trim();
  const mc = g("merchantCode");
  const amountText = g("amount");
  const merchantOrderId = g("merchantOrderId");
  const signature = g("signature");
  const resultCode = g("resultCode");
  const reference = g("reference");

  if (!mc || !amountText || !merchantOrderId || !signature || !resultCode) return text("Bad Parameter", 400);
  if (!/^\d+$/.test(amountText)) return text("Bad Amount", 400);
  const amount = Number(amountText);
  if (!Number.isSafeInteger(amount) || amount <= 0) return text("Bad Amount", 400);
  if (resultCode !== "00" && resultCode !== "01") return text("Unsupported Result Code", 400);

  // Duitku POP official callback contract: HMAC-SHA256(merchantCode + amount + merchantOrderId, API key).
  const valid = mc === merchant && equal(signature, await hmac(mc + amountText + merchantOrderId, apiKey));
  const eventFingerprint = await sha([
    mc, amountText, merchantOrderId, resultCode, reference,
    g("paymentCode"), g("settlementDate"), signature,
  ].join("|"));

  const payload = {
    merchantCode: mc,
    amount: amountText,
    merchantOrderId,
    resultCode,
    reference,
    paymentCode: g("paymentCode"),
    settlementDate: g("settlementDate"),
  };

  // All event/payment/order/reservation mutations occur in one PostgreSQL transaction inside this RPC.
  const { data, error } = await db.rpc("mec_process_duitku_callback", {
    p_merchant_order_id: merchantOrderId,
    p_amount: amount,
    p_merchant_code: mc,
    p_result_code: resultCode,
    p_signature_valid: valid,
    p_event_fingerprint: eventFingerprint,
    p_payload: payload,
    p_reference: reference || null,
  });

  if (error) {
    console.error("Atomic Duitku callback RPC failed", error.code, error.message);
    return text("Server Error", 500);
  }

  const outcome = String(data?.outcome ?? "");
  const status = Number(data?.http_status ?? 500);
  if (outcome === "invalid_signature" || status === 401) return text("Bad Signature", 401);
  if (status !== 200) return text("Server Error", 500);

  if (outcome === "reconciliation_required") {
    console.error("Duitku callback requires reconciliation", merchantOrderId);
    return text("SUCCESS", 200);
  }
  if (outcome === "amount_mismatch" || outcome === "payment_not_found" || outcome === "order_not_found") {
    console.error("Duitku callback anomaly", outcome, merchantOrderId);
    return text("SUCCESS", 200);
  }
  if (outcome === "processed_success" || outcome === "processed_failure" || outcome === "duplicate") {
    return text("SUCCESS", 200);
  }

  console.error("Unexpected atomic callback RPC outcome", outcome);
  return text("Server Error", 500);
});