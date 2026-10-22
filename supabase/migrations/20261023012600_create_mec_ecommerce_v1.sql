-- MEC e-commerce V1 schema. This migration is intentionally additive:
-- it creates only mec_* tables and mec_private helper functions.
-- Do not run against production until reviewed in a non-production environment.
BEGIN;

CREATE SCHEMA IF NOT EXISTS mec_private;
REVOKE ALL ON SCHEMA mec_private FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA mec_private TO service_role;

CREATE TABLE public.mec_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  description text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mec_categories_name_nonempty CHECK (length(btrim(name)) > 0),
  CONSTRAINT mec_categories_slug_nonempty CHECK (length(btrim(slug)) > 0)
);

CREATE TABLE public.mec_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id uuid REFERENCES public.mec_categories(id) ON DELETE SET NULL,
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  description text,
  price_idr bigint NOT NULL CHECK (price_idr >= 0),
  stock_quantity integer NOT NULL DEFAULT 0 CHECK (stock_quantity >= 0),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mec_products_name_nonempty CHECK (length(btrim(name)) > 0),
  CONSTRAINT mec_products_slug_nonempty CHECK (length(btrim(slug)) > 0)
);

CREATE TABLE public.mec_product_images (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES public.mec_products(id) ON DELETE CASCADE,
  storage_path text NOT NULL,
  alt_text text,
  display_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mec_product_images_storage_path_nonempty CHECK (length(btrim(storage_path)) > 0),
  CONSTRAINT mec_product_images_product_path_unique UNIQUE (product_id, storage_path)
);

CREATE TABLE public.mec_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number text NOT NULL UNIQUE,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  customer_name text NOT NULL,
  customer_email text NOT NULL,
  customer_phone text NOT NULL,
  currency text NOT NULL DEFAULT 'IDR' CHECK (currency = 'IDR'),
  subtotal_amount bigint NOT NULL CHECK (subtotal_amount >= 0),
  total_amount bigint NOT NULL CHECK (total_amount >= 0),
  order_status text NOT NULL DEFAULT 'pending_payment'
    CHECK (order_status IN ('pending_payment','confirmed','processing','shipped','completed','cancelled')),
  inventory_reservation_status text NOT NULL DEFAULT 'reserved'
    CHECK (inventory_reservation_status IN ('reserved','released','consumed','not_reserved')),
  inventory_reserved_until timestamptz NOT NULL,
  guest_token_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mec_orders_customer_name_nonempty CHECK (length(btrim(customer_name)) > 0),
  CONSTRAINT mec_orders_customer_email_nonempty CHECK (length(btrim(customer_email)) > 0),
  CONSTRAINT mec_orders_customer_phone_nonempty CHECK (length(btrim(customer_phone)) > 0),
  CONSTRAINT mec_orders_guest_token_rule CHECK (user_id IS NOT NULL OR guest_token_hash IS NOT NULL),
  CONSTRAINT mec_orders_total_matches_subtotal CHECK (total_amount = subtotal_amount)
);

CREATE TABLE public.mec_order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.mec_orders(id) ON DELETE RESTRICT,
  product_id uuid REFERENCES public.mec_products(id) ON DELETE SET NULL,
  product_name_snapshot text NOT NULL,
  unit_price_idr bigint NOT NULL CHECK (unit_price_idr >= 0),
  quantity integer NOT NULL CHECK (quantity > 0),
  line_total_idr bigint GENERATED ALWAYS AS (unit_price_idr * quantity::bigint) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mec_order_items_product_name_nonempty CHECK (length(btrim(product_name_snapshot)) > 0)
);

CREATE TABLE public.mec_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.mec_orders(id) ON DELETE RESTRICT,
  provider text NOT NULL DEFAULT 'duitku' CHECK (provider = 'duitku'),
  merchant_order_id text NOT NULL UNIQUE,
  amount_idr bigint NOT NULL CHECK (amount_idr > 0),
  currency text NOT NULL DEFAULT 'IDR' CHECK (currency = 'IDR'),
  payment_status text NOT NULL DEFAULT 'created'
    CHECK (payment_status IN ('created','requesting','pending','paid','failed','expired','cancelled','unknown')),
  payment_method text,
  provider_reference text,
  payment_url text,
  provider_status_code text,
  provider_status_message text,
  idempotency_key text NOT NULL UNIQUE,
  paid_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mec_payments_paid_at_rule CHECK (payment_status <> 'paid' OR paid_at IS NOT NULL)
);

CREATE TABLE public.mec_payment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id uuid REFERENCES public.mec_payments(id) ON DELETE SET NULL,
  merchant_order_id text NOT NULL,
  provider text NOT NULL DEFAULT 'duitku' CHECK (provider = 'duitku'),
  event_fingerprint text NOT NULL UNIQUE,
  signature_valid boolean NOT NULL DEFAULT false,
  event_type text NOT NULL,
  provider_status_code text,
  processing_status text NOT NULL DEFAULT 'received'
    CHECK (processing_status IN ('received','processed','ignored','failed')),
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  error_code text,
  payload jsonb,
  CONSTRAINT mec_payment_events_type_nonempty CHECK (length(btrim(event_type)) > 0)
);

CREATE INDEX mec_products_active_category_idx ON public.mec_products(category_id) WHERE is_active;
CREATE INDEX mec_products_active_slug_idx ON public.mec_products(slug) WHERE is_active;
CREATE INDEX mec_product_images_order_idx ON public.mec_product_images(product_id, display_order);
CREATE INDEX mec_orders_user_created_idx ON public.mec_orders(user_id, created_at DESC);
CREATE INDEX mec_orders_reservation_expiry_idx ON public.mec_orders(inventory_reserved_until)
  WHERE inventory_reservation_status = 'reserved';
CREATE INDEX mec_order_items_order_idx ON public.mec_order_items(order_id);
CREATE INDEX mec_payments_order_created_idx ON public.mec_payments(order_id, created_at DESC);
CREATE INDEX mec_payments_status_idx ON public.mec_payments(payment_status, created_at);
CREATE INDEX mec_payment_events_order_idx ON public.mec_payment_events(merchant_order_id, received_at DESC);

ALTER TABLE public.mec_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mec_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mec_product_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mec_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mec_order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mec_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mec_payment_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY mec_categories_public_active_read ON public.mec_categories
  FOR SELECT TO anon, authenticated USING (is_active);
CREATE POLICY mec_products_public_active_read ON public.mec_products
  FOR SELECT TO anon, authenticated USING (is_active);
CREATE POLICY mec_product_images_public_active_read ON public.mec_product_images
  FOR SELECT TO anon, authenticated USING (
    EXISTS (SELECT 1 FROM public.mec_products p WHERE p.id = product_id AND p.is_active)
  );
CREATE POLICY mec_orders_owner_read ON public.mec_orders
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));
CREATE POLICY mec_order_items_owner_read ON public.mec_order_items
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM public.mec_orders o WHERE o.id = order_id AND o.user_id = (SELECT auth.uid()))
  );
CREATE POLICY mec_payments_owner_read ON public.mec_payments
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM public.mec_orders o WHERE o.id = order_id AND o.user_id = (SELECT auth.uid()))
  );

REVOKE ALL ON public.mec_categories, public.mec_products, public.mec_product_images,
  public.mec_orders, public.mec_order_items, public.mec_payments, public.mec_payment_events
  FROM anon, authenticated;
GRANT SELECT ON public.mec_categories, public.mec_products, public.mec_product_images TO anon, authenticated;
GRANT SELECT ON public.mec_orders, public.mec_order_items, public.mec_payments TO authenticated;
GRANT ALL ON public.mec_categories, public.mec_products, public.mec_product_images,
  public.mec_orders, public.mec_order_items, public.mec_payments, public.mec_payment_events TO service_role;

-- Internal order creation is callable only by service_role-backed trusted server code.
-- Stock is decremented under row locks in the same transaction as order/item creation.
CREATE OR REPLACE FUNCTION mec_private.create_order(
  p_customer_name text,
  p_customer_email text,
  p_customer_phone text,
  p_items jsonb,
  p_user_id uuid DEFAULT NULL,
  p_guest_token_hash text DEFAULT NULL,
  p_reservation_minutes integer DEFAULT 15
)
RETURNS TABLE(order_id uuid, order_number text, subtotal_amount bigint, inventory_reserved_until timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, mec_private
AS $$
DECLARE
  v_order_id uuid := gen_random_uuid();
  v_order_number text := 'MEC-' || to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISSMS') || '-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));
  v_reserved_until timestamptz := now() + make_interval(mins => greatest(1, least(coalesce(p_reservation_minutes, 15), 1440)));
  v_subtotal bigint;
  v_item record;
BEGIN
  IF length(btrim(coalesce(p_customer_name, ''))) = 0
     OR length(btrim(coalesce(p_customer_email, ''))) = 0
     OR length(btrim(coalesce(p_customer_phone, ''))) = 0 THEN
    RAISE EXCEPTION 'Customer name, email, and phone are required' USING ERRCODE = '22023';
  END IF;
  IF p_user_id IS NULL AND (p_guest_token_hash IS NULL OR length(btrim(p_guest_token_hash)) = 0) THEN
    RAISE EXCEPTION 'Guest checkout requires a guest token hash' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'At least one item is required' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_to_recordset(p_items) AS x(product_id uuid, quantity integer)
    WHERE x.product_id IS NULL OR x.quantity IS NULL OR x.quantity <= 0
  ) THEN
    RAISE EXCEPTION 'Each item requires product_id and positive quantity' USING ERRCODE = '22023';
  END IF;

  -- Lock all distinct products in deterministic order to reduce deadlock risk.
  PERFORM p.id
  FROM public.mec_products p
  JOIN (SELECT DISTINCT x.product_id FROM jsonb_to_recordset(p_items) AS x(product_id uuid, quantity integer)) i
    ON i.product_id = p.id
  ORDER BY p.id
  FOR UPDATE OF p;

  IF (SELECT count(DISTINCT x.product_id) FROM jsonb_to_recordset(p_items) AS x(product_id uuid, quantity integer))
     <> (SELECT count(*) FROM public.mec_products p
         JOIN (SELECT DISTINCT x.product_id FROM jsonb_to_recordset(p_items) AS x(product_id uuid, quantity integer)) i
           ON i.product_id = p.id) THEN
    RAISE EXCEPTION 'One or more products do not exist' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      SELECT x.product_id, sum(x.quantity)::bigint AS quantity
      FROM jsonb_to_recordset(p_items) AS x(product_id uuid, quantity integer)
      GROUP BY x.product_id
    ) i
    JOIN public.mec_products p ON p.id = i.product_id
    WHERE NOT p.is_active OR p.stock_quantity < i.quantity
  ) THEN
    RAISE EXCEPTION 'Product is inactive or stock is insufficient' USING ERRCODE = '23514';
  END IF;

  SELECT sum(p.price_idr * i.quantity)::bigint INTO v_subtotal
  FROM (
    SELECT x.product_id, sum(x.quantity)::bigint AS quantity
    FROM jsonb_to_recordset(p_items) AS x(product_id uuid, quantity integer)
    GROUP BY x.product_id
  ) i
  JOIN public.mec_products p ON p.id = i.product_id;

  INSERT INTO public.mec_orders (
    id, order_number, user_id, customer_name, customer_email, customer_phone,
    subtotal_amount, total_amount, inventory_reservation_status,
    inventory_reserved_until, guest_token_hash
  ) VALUES (
    v_order_id, v_order_number, p_user_id, btrim(p_customer_name), btrim(p_customer_email),
    btrim(p_customer_phone), v_subtotal, v_subtotal, 'reserved', v_reserved_until, p_guest_token_hash
  );

  FOR v_item IN
    SELECT p.id AS product_id, p.name, p.price_idr, sum(i.quantity)::integer AS quantity
    FROM jsonb_to_recordset(p_items) AS i(product_id uuid, quantity integer)
    JOIN public.mec_products p ON p.id = i.product_id
    GROUP BY p.id, p.name, p.price_idr
    ORDER BY p.id
  LOOP
    UPDATE public.mec_products SET stock_quantity = stock_quantity - v_item.quantity, updated_at = now()
    WHERE id = v_item.product_id;
    INSERT INTO public.mec_order_items(order_id, product_id, product_name_snapshot, unit_price_idr, quantity)
    VALUES (v_order_id, v_item.product_id, v_item.name, v_item.price_idr, v_item.quantity);
  END LOOP;

  RETURN QUERY SELECT v_order_id, v_order_number, v_subtotal, v_reserved_until;
END;
$$;

REVOKE ALL ON FUNCTION mec_private.create_order(text, text, text, jsonb, uuid, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION mec_private.create_order(text, text, text, jsonb, uuid, text, integer) TO service_role;

-- Idempotent release: inventory is restored only if the reservation is still active.
CREATE OR REPLACE FUNCTION mec_private.release_order_inventory(p_order_id uuid, p_new_status text DEFAULT 'cancelled')
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, mec_private
AS $$
DECLARE
  v_order public.mec_orders%ROWTYPE;
  v_item record;
BEGIN
  IF p_new_status NOT IN ('cancelled') THEN
    RAISE EXCEPTION 'Unsupported release target status' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_order FROM public.mec_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF v_order.inventory_reservation_status <> 'reserved' THEN RETURN false; END IF;
  IF v_order.order_status <> 'pending_payment' THEN RETURN false; END IF;

  -- Never release while a payment attempt is paid, pending, requesting, or unknown.
  IF EXISTS (
    SELECT 1 FROM public.mec_payments pay
    WHERE pay.order_id = p_order_id
      AND pay.payment_status IN ('paid','pending','requesting','unknown')
  ) THEN
    RETURN false;
  END IF;

  FOR v_item IN
    SELECT product_id, sum(quantity)::integer AS quantity
    FROM public.mec_order_items
    WHERE order_id = p_order_id AND product_id IS NOT NULL
    GROUP BY product_id
    ORDER BY product_id
  LOOP
    UPDATE public.mec_products SET stock_quantity = stock_quantity + v_item.quantity, updated_at = now()
    WHERE id = v_item.product_id;
  END LOOP;

  UPDATE public.mec_orders
  SET inventory_reservation_status = 'released', order_status = p_new_status, updated_at = now()
  WHERE id = p_order_id;
  UPDATE public.mec_payments
  SET payment_status = 'cancelled', updated_at = now()
  WHERE order_id = p_order_id AND payment_status IN ('created','failed','expired','cancelled');
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION mec_private.release_order_inventory(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION mec_private.release_order_inventory(uuid, text) TO service_role;

-- Public RPC wrappers are required for PostgREST RPC routing. Execution is restricted
-- to service_role; anon/authenticated cannot call these SECURITY DEFINER entry points.
CREATE OR REPLACE FUNCTION public.mec_create_order(
  p_customer_name text,
  p_customer_email text,
  p_customer_phone text,
  p_items jsonb,
  p_user_id uuid DEFAULT NULL,
  p_guest_token_hash text DEFAULT NULL,
  p_reservation_minutes integer DEFAULT 15
)
RETURNS TABLE(order_id uuid, order_number text, subtotal_amount bigint, inventory_reserved_until timestamptz)
LANGUAGE sql
SECURITY INVOKER
SET search_path = pg_catalog, public, mec_private
AS $mec$
  SELECT * FROM mec_private.create_order(
    p_customer_name, p_customer_email, p_customer_phone, p_items,
    p_user_id, p_guest_token_hash, p_reservation_minutes
  );
$mec$;
REVOKE ALL ON FUNCTION public.mec_create_order(text, text, text, jsonb, uuid, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mec_create_order(text, text, text, jsonb, uuid, text, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.mec_release_order_inventory(p_order_id uuid, p_new_status text DEFAULT 'cancelled')
RETURNS boolean
LANGUAGE sql
SECURITY INVOKER
SET search_path = pg_catalog, public, mec_private
AS $mec$
  SELECT mec_private.release_order_inventory(p_order_id, p_new_status);
$mec$;
REVOKE ALL ON FUNCTION public.mec_release_order_inventory(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mec_release_order_inventory(uuid, text) TO service_role;

COMMIT;
