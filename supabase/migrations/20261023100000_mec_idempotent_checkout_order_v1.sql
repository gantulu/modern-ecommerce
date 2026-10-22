-- Add idempotent authenticated checkout order creation without modifying legacy tables.
BEGIN;

ALTER TABLE public.mec_orders
  ADD COLUMN IF NOT EXISTS checkout_idempotency_key text;

CREATE UNIQUE INDEX IF NOT EXISTS mec_orders_checkout_idempotency_key_uidx
  ON public.mec_orders(checkout_idempotency_key)
  WHERE checkout_idempotency_key IS NOT NULL;

CREATE OR REPLACE FUNCTION public.mec_create_order_idempotent(
  p_checkout_idempotency_key text,
  p_customer_name text,
  p_customer_email text,
  p_customer_phone text,
  p_items jsonb,
  p_user_id uuid
)
RETURNS TABLE(
  order_id uuid,
  order_number text,
  subtotal_amount bigint,
  inventory_reserved_until timestamptz,
  reused boolean
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, mec_private
AS $mec$
DECLARE
  v_existing public.mec_orders%ROWTYPE;
  v_created record;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'Authenticated user is required' USING ERRCODE = '22023';
  END IF;
  IF p_checkout_idempotency_key IS NULL
     OR length(btrim(p_checkout_idempotency_key)) < 16
     OR length(p_checkout_idempotency_key) > 128 THEN
    RAISE EXCEPTION 'Valid checkout idempotency key is required' USING ERRCODE = '22023';
  END IF;

  -- Serialize retries using the same key, including concurrent HTTP requests.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_checkout_idempotency_key, 0));

  SELECT * INTO v_existing
  FROM public.mec_orders o
  WHERE o.checkout_idempotency_key = p_checkout_idempotency_key
  FOR UPDATE;

  IF FOUND THEN
    IF v_existing.user_id IS DISTINCT FROM p_user_id THEN
      RAISE EXCEPTION 'Checkout idempotency key belongs to another user' USING ERRCODE = '42501';
    END IF;
    IF v_existing.order_status <> 'pending_payment'
       OR v_existing.inventory_reservation_status <> 'reserved' THEN
      RAISE EXCEPTION 'Previous checkout order is no longer payable; do not retry with a new payment attempt until reconciled' USING ERRCODE = '55000';
    END IF;
    RETURN QUERY SELECT v_existing.id, v_existing.order_number, v_existing.subtotal_amount,
      v_existing.inventory_reserved_until, true;
    RETURN;
  END IF;

  SELECT * INTO v_created
  FROM mec_private.create_order(
    p_customer_name,
    p_customer_email,
    p_customer_phone,
    p_items,
    p_user_id,
    NULL,
    15
  );

  UPDATE public.mec_orders
  SET checkout_idempotency_key = p_checkout_idempotency_key
  WHERE id = v_created.order_id;

  RETURN QUERY SELECT v_created.order_id, v_created.order_number, v_created.subtotal_amount,
    v_created.inventory_reserved_until, false;
END;
$mec$;

REVOKE ALL ON FUNCTION public.mec_create_order_idempotent(text, text, text, text, jsonb, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mec_create_order_idempotent(text, text, text, text, jsonb, uuid)
  TO service_role;

COMMIT;
