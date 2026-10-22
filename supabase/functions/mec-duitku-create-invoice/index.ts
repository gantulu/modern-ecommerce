import { createClient } from "npm:@supabase/supabase-js@2";
const url = Deno.env.get("SUPABASE_URL")!;
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const merchant = Deno.env.get("DUITKU_MERCHANT_CODE");
const apiKey = Deno.env.get("DUITKU_API_KEY");
const returnUrl = Deno.env.get("MEC_DUITKU_RETURN_URL");
const env = Deno.env.get("DUITKU_ENVIRONMENT") ?? "sandbox";
const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const headers = { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, apikey, content-type", "access-control-allow-methods": "POST, OPTIONS" };
const out = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers });
const hex = (b: Uint8Array) => [...b].map(x => x.toString(16).padStart(2, "0")).join("");
async function hmac(s: string, k: string) { const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(k), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]); return hex(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(s)))); }
async function sha(s: string) { return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))); }
Deno.serve(async req => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") return out({ error: "Method not allowed" }, 405);
  if (!merchant || !apiKey || !returnUrl) return out({ error: "Missing DUITKU_MERCHANT_CODE, DUITKU_API_KEY, or MEC_DUITKU_RETURN_URL secret" }, 500);
  let input: Record<string, unknown>;
  try { input = await req.json(); if (!input || Array.isArray(input) || typeof input !== "object") throw new Error(); } catch { return out({ error: "Valid JSON object required" }, 400); }
  const orderId = String(input.order_id ?? "").trim(), idem = String(input.idempotency_key ?? "").trim();
  if (!orderId || !idem || idem.length > 128) return out({ error: "order_id and idempotency_key are required" }, 400);
  const { data: order, error } = await db.from("mec_orders").select("id,order_number,user_id,guest_token_hash,customer_name,customer_email,customer_phone,total_amount,order_status,inventory_reservation_status").eq("id", orderId).maybeSingle();
  if (error) return out({ error: "Order lookup failed" }, 500);
  if (!order) return out({ error: "Order not found" }, 404);
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (order.user_id) {
    if (!bearer) return out({ error: "Authentication required" }, 401);
    const { data: auth, error: authError } = await db.auth.getUser(bearer);
    if (authError || auth.user?.id !== order.user_id) return out({ error: "Order access denied" }, 403);
  } else {
    const token = String(input.guest_token ?? "");
    if (!token || !order.guest_token_hash || !(await sha(token)).toLowerCase().localeCompare(String(order.guest_token_hash).toLowerCase()) === 0) return out({ error: "Valid guest token required" }, 403);
  }
  if (order.order_status !== "pending_payment" || order.inventory_reservation_status !== "reserved") return out({ error: "Order is not payable" }, 409);
  const amount = Number(order.total_amount);
  if (!Number.isSafeInteger(amount) || amount <= 0) return out({ error: "Invalid stored order amount" }, 409);
  const { data: prior, error: priorErr } = await db.from("mec_payments").select("id,order_id,merchant_order_id,amount_idr,payment_status,payment_url,provider_reference,expires_at").eq("idempotency_key", idem).maybeSingle();
  if (priorErr) return out({ error: "Idempotency lookup failed" }, 500);
  if (prior) {
    if (prior.order_id !== order.id || Number(prior.amount_idr) !== amount) return out({ error: "Idempotency key conflict" }, 409);
    if (["pending","paid"].includes(prior.payment_status)) return out({ payment: prior, reused: true });
    return out({ error: "Attempt exists in unresolved/non-retryable state; reconcile first", payment_status: prior.payment_status, merchant_order_id: prior.merchant_order_id }, 409);
  }
  const { data: attempts, error: attemptsErr } = await db.from("mec_payments").select("payment_status").eq("order_id", order.id);
  if (attemptsErr) return out({ error: "Payment attempt lookup failed" }, 500);
  if ((attempts ?? []).some(p => ["paid","pending","requesting","unknown"].includes(p.payment_status))) return out({ error: "Existing attempt requires reconciliation before a new attempt" }, 409);
  const { data: items, error: itemsErr } = await db.from("mec_order_items").select("product_name_snapshot,unit_price_idr,quantity").eq("order_id", order.id);
  if (itemsErr || !items?.length) return out({ error: "Order items unavailable" }, 500);
  const itemDetails = items.map(i => ({ name: String(i.product_name_snapshot).slice(0,50), price: Number(i.unit_price_idr), quantity: Number(i.quantity) }));
  if (itemDetails.reduce((s,i)=>s+i.price*i.quantity,0) !== amount) return out({ error: "Order item total mismatch" }, 409);
  const expiry = Number(input.expiry_period ?? 60);
  if (![5,10,60].includes(expiry)) return out({ error: "expiry_period must be 5, 10, or 60" }, 400);
  const merchantOrderId = "MEC-" + crypto.randomUUID().replaceAll("-","").slice(0,32);
  const { data: payment, error: insertErr } = await db.from("mec_payments").insert({
    order_id: order.id, provider: "duitku", merchant_order_id: merchantOrderId, amount_idr: amount,
    currency: "IDR", payment_status: "requesting", idempotency_key: idem,
    expires_at: new Date(Date.now()+expiry*60000).toISOString()
  }).select("id").single();
  if (insertErr || !payment) return out({ error: "Payment attempt could not be created" }, 500);
  const timestamp = String(Date.now()), signature = await hmac(merchant + timestamp, apiKey);
  const callbackUrl = url.replace(/\/$/,"") + "/functions/v1/mec-duitku-callback";
  const body: Record<string,unknown> = {
    paymentAmount: amount, merchantOrderId, productDetails: ("Order "+order.order_number).slice(0,255),
    email: order.customer_email, customerVaName: String(order.customer_name).slice(0,20),
    phoneNumber: String(order.customer_phone).slice(0,50), itemDetails, callbackUrl, returnUrl, expiryPeriod: expiry
  };
  if (typeof input.payment_method === "string" && input.payment_method.trim()) body.paymentMethod = input.payment_method.trim().slice(0,2);
  let response: Response, raw: string;
  try {
    response = await fetch(env === "production" ? "https://api-prod.duitku.com/api/merchant/createInvoice" : "https://api-sandbox.duitku.com/api/merchant/createInvoice", {
      method: "POST", headers: { "content-type":"application/json", "x-duitku-timestamp":timestamp, "x-duitku-signature":signature, "x-duitku-merchantcode":merchant },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15000)
    });
    raw = await response.text();
  } catch (e) {
    await db.from("mec_payments").update({ payment_status:"unknown", provider_status_message:"Create Invoice transport outcome unknown", updated_at:new Date().toISOString() }).eq("id",payment.id);
    console.error("Duitku transport outcome unknown", e);
    return out({ error:"Payment outcome unknown; reconcile before retry", merchant_order_id:merchantOrderId },504);
  }
  let result: Record<string,unknown> = {};
  try { result = JSON.parse(raw); } catch {}
  const code = String(result.statusCode ?? "");
  if (!response.ok || code !== "00") {
    const known = response.ok && code !== "";
    await db.from("mec_payments").update({ payment_status:known?"failed":"unknown", provider_status_code:code||null, provider_status_message:String(result.statusMessage??"Unconfirmed provider response").slice(0,500), updated_at:new Date().toISOString() }).eq("id",payment.id);
    return out({ error:known?"Duitku rejected invoice":"Duitku outcome unknown; reconcile before retry", status_code:code||null, merchant_order_id:merchantOrderId },502);
  }
  const reference = String(result.reference??""), paymentUrl = String(result.paymentUrl??"");
  if (!reference || !paymentUrl.startsWith("https://")) {
    await db.from("mec_payments").update({ payment_status:"unknown", provider_status_code:code, provider_status_message:"Missing reference/payment URL in provider response", updated_at:new Date().toISOString() }).eq("id",payment.id);
    return out({ error:"Incomplete provider response; reconcile before retry", merchant_order_id:merchantOrderId },502);
  }
  const { data: updated, error: updateErr } = await db.from("mec_payments").update({
    payment_status:"pending", provider_reference:reference, payment_url:paymentUrl, provider_status_code:code,
    provider_status_message:String(result.statusMessage??"SUCCESS").slice(0,500), updated_at:new Date().toISOString()
  }).eq("id",payment.id).select("id,order_id,merchant_order_id,amount_idr,payment_status,payment_url,provider_reference,expires_at").single();
  if (updateErr || !updated) return out({ error:"Invoice may exist but DB update failed; do not create another attempt", merchant_order_id:merchantOrderId },500);
  return out({ payment:updated, reused:false });
});