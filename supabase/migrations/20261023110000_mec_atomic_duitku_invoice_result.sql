-- Atomic, monotonic handling of asynchronous Duitku Create Invoice responses.
-- This migration is a proposal on the PR branch only; it has not been applied to any database.
BEGIN;

CREATE TABLE IF NOT EXISTS public.mec_payment_provider_responses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id uuid NOT NULL REFERENCES public.mec_payments(id) ON DELETE RESTRICT,
  merchant_order_id text NOT NULL,
  provider text NOT NULL DEFAULT 'duitku' CHECK (provider = 'duitku'),
  response_outcome text NOT NULL CHECK (response_outcome IN ('pending','failed','unknown')),
  provider_reference text,
  payment_url text,
  provider_status_code text,
  provider_status_message text,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mec_payment_provider_responses_payment_received_idx
  ON public.mec_payment_provider_responses(payment_id, received_at DESC);

ALTER TABLE public.mec_payment_provider_responses ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.mec_payment_provider_responses FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.mec_record_duitku_invoice_result(
  p_payment_id uuid,
  p_outcome text,
  p_provider_reference text DEFAULT NULL,
  p_payment_url text DEFAULT NULL,
  p_provider_status_code text DEFAULT NULL,
  p_provider_status_message text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_payment public.mec_payments%ROWTYPE;
  v_status text;
  v_changed boolean := false;
BEGIN
  IF p_payment_id IS NULL OR p_outcome IS NULL OR p_outcome NOT IN ('pending','failed','unknown') THEN
    RAISE EXCEPTION 'Invalid payment ID or invoice response outcome' USING ERRCODE = '22023';
  END IF;

  -- This row lock serializes invoice responses with callback processing.
  SELECT * INTO v_payment
  FROM public.mec_payments
  WHERE id = p_payment_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment attempt not found' USING ERRCODE = '22023';
  END IF;

  -- Keep provider-response audit data separate from the authoritative payment state.
  INSERT INTO public.mec_payment_provider_responses (
    payment_id, merchant_order_id, provider, response_outcome,
    provider_reference, payment_url, provider_status_code, provider_status_message
  ) VALUES (
    v_payment.id, v_payment.merchant_order_id, 'duitku', p_outcome,
    nullif(p_provider_reference, ''), nullif(p_payment_url, ''),
    nullif(p_provider_status_code, ''), left(p_provider_status_message, 500)
  );

  -- A Create Invoice response may transition only the in-flight requesting state.
  -- Callback-confirmed paid (and any other state that moved first) is never downgraded.
  IF v_payment.payment_status = 'requesting' THEN
    UPDATE public.mec_payments
    SET payment_status = p_outcome,
        provider_reference = coalesce(nullif(p_provider_reference, ''), provider_reference),
        payment_url = coalesce(nullif(p_payment_url, ''), payment_url),
        provider_status_code = coalesce(nullif(p_provider_status_code, ''), provider_status_code),
        provider_status_message = coalesce(left(p_provider_status_message, 500), provider_status_message),
        updated_at = now()
    WHERE id = v_payment.id
    RETURNING payment_status INTO v_status;
    v_changed := true;
  ELSE
    -- Metadata may arrive late, but status is owned by the first valid state transition.
    UPDATE public.mec_payments
    SET provider_reference = coalesce(nullif(p_provider_reference, ''), provider_reference),
        payment_url = coalesce(nullif(p_payment_url, ''), payment_url),
        provider_status_code = coalesce(nullif(p_provider_status_code, ''), provider_status_code),
        provider_status_message = coalesce(left(p_provider_status_message, 500), provider_status_message),
        updated_at = now()
    WHERE id = v_payment.id;
    v_status := v_payment.payment_status;
  END IF;

  RETURN jsonb_build_object(
    'payment_id', v_payment.id,
    'payment_status', v_status,
    'status_changed', v_changed
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.mec_record_duitku_invoice_result(uuid, text, text, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mec_record_duitku_invoice_result(uuid, text, text, text, text, text)
  TO service_role;

-- Align lock order with mec_process_duitku_callback: lock payment row(s) before order.
-- This avoids a callback/release lock inversion. The payment rows are acquired in stable order.
CREATE OR REPLACE FUNCTION mec_private.release_order_inventory(
  p_order_id uuid,
  p_new_status text DEFAULT 'cancelled'
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, mec_private
AS $function$
DECLARE
  v_order public.mec_orders%ROWTYPE;
  v_item record;
BEGIN
  IF p_new_status IS NULL OR p_new_status NOT IN ('cancelled') THEN
    RAISE EXCEPTION 'Unsupported release target status' USING ERRCODE = '22023';
  END IF;

  PERFORM 1
  FROM public.mec_payments
  WHERE order_id = p_order_id
  ORDER BY id
  FOR UPDATE;

  SELECT * INTO v_order
  FROM public.mec_orders
  WHERE id = p_order_id
  FOR UPDATE;

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
    UPDATE public.mec_products
    SET stock_quantity = stock_quantity + v_item.quantity, updated_at = now()
    WHERE id = v_item.product_id;
  END LOOP;

  UPDATE public.mec_orders
  SET inventory_reservation_status = 'released', order_status = p_new_status, updated_at = now()
  WHERE id = p_order_id;

  UPDATE public.mec_payments
  SET payment_status = 'cancelled', updated_at = now()
  WHERE order_id = p_order_id
    AND payment_status IN ('created','failed','expired','cancelled');

  RETURN true;
END;
$function$;

REVOKE ALL ON FUNCTION mec_private.release_order_inventory(uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION mec_private.release_order_inventory(uuid, text) TO service_role;

COMMIT;
