import { createClient } from "npm:@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const db = supabaseUrl && serviceRoleKey
  ? createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })
  : null;

const headers = {
  "content-type": "application/json",
  "cache-control": "no-store",
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, apikey, content-type, x-client-info",
  "access-control-allow-methods": "POST, OPTIONS",
};

const respond = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers });

type CheckoutItem = { product_id: string; quantity: number };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") return respond({ error: "Method not allowed" }, 405);
  if (!db) return respond({ error: "Checkout service is not configured" }, 500);

  const authorization = req.headers.get("authorization") ?? "";
  const token = authorization.replace(/^Bearer\s+/i, "").trim();
  if (!token) return respond({ error: "Authentication required" }, 401);

  const { data: authData, error: authError } = await db.auth.getUser(token);
  if (authError || !authData.user) return respond({ error: "Invalid or expired session" }, 401);

  let input: Record<string, unknown>;
  try {
    const parsed = await req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    input = parsed as Record<string, unknown>;
  } catch {
    return respond({ error: "A valid JSON object is required" }, 400);
  }

  const customerName = typeof input.customer_name === "string" ? input.customer_name.trim() : "";
  const customerEmail = typeof input.customer_email === "string" ? input.customer_email.trim() : "";
  const customerPhone = typeof input.customer_phone === "string" ? input.customer_phone.trim() : "";
  const idempotencyKey = typeof input.idempotency_key === "string" ? input.idempotency_key.trim() : "";
  if (!customerName || customerName.length > 160) return respond({ error: "Customer name is required (maximum 160 characters)" }, 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail) || customerEmail.length > 254) {
    return respond({ error: "A valid customer email is required" }, 400);
  }
  if (!customerPhone || customerPhone.length > 50) return respond({ error: "Customer phone is required (maximum 50 characters)" }, 400);
  if (idempotencyKey.length < 16 || idempotencyKey.length > 128) {
    return respond({ error: "A valid checkout idempotency key is required" }, 400);
  }
  if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 100) {
    return respond({ error: "Cart must contain between 1 and 100 item entries" }, 400);
  }

  const items: CheckoutItem[] = [];
  for (const entry of input.items) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return respond({ error: "Each cart item must contain product_id and quantity" }, 400);
    }
    const item = entry as Record<string, unknown>;
    const productId = typeof item.product_id === "string" ? item.product_id.trim() : "";
    const quantity = item.quantity;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(productId)) {
      return respond({ error: "Invalid product identifier in cart" }, 400);
    }
    if (!Number.isSafeInteger(quantity) || Number(quantity) < 1 || Number(quantity) > 1000) {
      return respond({ error: "Each item quantity must be an integer between 1 and 1000" }, 400);
    }
    items.push({ product_id: productId, quantity: Number(quantity) });
  }

  const { data, error } = await db.rpc("mec_create_order_idempotent", {
    p_checkout_idempotency_key: idempotencyKey,
    p_customer_name: customerName,
    p_customer_email: customerEmail,
    p_customer_phone: customerPhone,
    p_items: items,
    p_user_id: authData.user.id,
  });

  if (error) {
    const message = error.message ?? "";
    if (error.code === "23514" || error.code === "22023") {
      return respond({ error: "Cart validation failed: a product may be inactive or stock may be insufficient" }, 409);
    }
    if (error.code === "42501") return respond({ error: "Checkout authorization failed" }, 403);
    if (error.code === "55000") return respond({ error: "The previous checkout is no longer payable. Reconcile its payment status before starting another attempt." }, 409);
    console.error("MEC order creation failed", { code: error.code });
    return respond({ error: "Unable to create checkout order" }, 500);
  }

  const order = Array.isArray(data) ? data[0] : data;
  if (!order?.order_id) return respond({ error: "Checkout order response was incomplete" }, 500);
  return respond({
    order: {
      id: order.order_id,
      order_number: order.order_number,
      subtotal_amount: order.subtotal_amount,
      inventory_reserved_until: order.inventory_reserved_until,
    },
    reused: Boolean(order.reused),
  });
});
