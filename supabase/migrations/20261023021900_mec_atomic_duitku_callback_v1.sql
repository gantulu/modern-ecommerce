CREATE OR REPLACE FUNCTION public.mec_process_duitku_callback(
  p_merchant_order_id text,
  p_amount bigint,
  p_merchant_code text,
  p_result_code text,
  p_signature_valid boolean,
  p_event_fingerprint text,
  p_payload jsonb DEFAULT '{}'::jsonb,
  p_reference text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_payment public.mec_payments%ROWTYPE;
  v_order public.mec_orders%ROWTYPE;
  v_event public.mec_payment_events%ROWTYPE;
  v_success boolean;
BEGIN
  IF coalesce(length(btrim(p_merchant_order_id)), 0) = 0
     OR p_amount IS NULL OR p_amount <= 0
     OR coalesce(length(btrim(p_merchant_code)), 0) = 0
     OR coalesce(length(btrim(p_result_code)), 0) = 0
     OR coalesce(length(btrim(p_event_fingerprint)), 0) = 0 THEN
    RAISE EXCEPTION 'Required callback fields are missing' USING ERRCODE = '22023';
  END IF;

  IF p_result_code NOT IN ('00', '01') THEN
    RAISE EXCEPTION 'Unsupported Duitku result code' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.mec_payment_events (
    payment_id, merchant_order_id, provider, event_fingerprint,
    signature_valid, event_type, provider_status_code, processing_status,
    error_code, payload
  )
  SELECT p.id, p_merchant_order_id, 'duitku', p_event_fingerprint,
         coalesce(p_signature_valid, false), 'callback', p_result_code,
         CASE WHEN coalesce(p_signature_valid, false) THEN 'received' ELSE 'failed' END,
         CASE WHEN coalesce(p_signature_valid, false) THEN NULL ELSE 'INVALID_SIGNATURE' END,
         coalesce(p_payload, '{}'::jsonb)
  FROM (SELECT 1) seed
  LEFT JOIN public.mec_payments p ON p.merchant_order_id = p_merchant_order_id
  ON CONFLICT (event_fingerprint) DO NOTHING;

  SELECT * INTO v_event
  FROM public.mec_payment_events
  WHERE event_fingerprint = p_event_fingerprint
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Callback event could not be recorded' USING ERRCODE = 'P0001';
  END IF;

  IF v_event.processing_status = 'processed' AND v_event.signature_valid THEN
    RETURN jsonb_build_object('outcome', 'duplicate', 'http_status', 200);
  END IF;

  IF NOT coalesce(p_signature_valid, false) OR NOT v_event.signature_valid THEN
    UPDATE public.mec_payment_events
    SET processing_status = 'failed', error_code = 'INVALID_SIGNATURE'
    WHERE id = v_event.id;
    RETURN jsonb_build_object('outcome', 'invalid_signature', 'http_status', 401);
  END IF;

  SELECT * INTO v_payment
  FROM public.mec_payments
  WHERE merchant_order_id = p_merchant_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    UPDATE public.mec_payment_events
    SET processing_status = 'failed', error_code = 'PAYMENT_NOT_FOUND'
    WHERE id = v_event.id;
    RETURN jsonb_build_object('outcome', 'payment_not_found', 'http_status', 200);
  END IF;

  UPDATE public.mec_payment_events
  SET payment_id = v_payment.id
  WHERE id = v_event.id;

  IF v_payment.amount_idr <> p_amount THEN
    UPDATE public.mec_payment_events
    SET processing_status = 'failed', error_code = 'AMOUNT_MISMATCH'
    WHERE id = v_event.id;
    RETURN jsonb_build_object('outcome', 'amount_mismatch', 'http_status', 200);
  END IF;

  SELECT * INTO v_order
  FROM public.mec_orders
  WHERE id = v_payment.order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    UPDATE public.mec_payment_events
    SET processing_status = 'failed', error_code = 'ORDER_NOT_FOUND'
    WHERE id = v_event.id;
    RETURN jsonb_build_object('outcome', 'order_not_found', 'http_status', 200);
  END IF;

  v_success := p_result_code = '00';

  IF v_success THEN
    IF v_payment.payment_status <> 'paid' THEN
      UPDATE public.mec_payments
      SET payment_status = 'paid',
          provider_reference = coalesce(nullif(p_reference, ''), provider_reference),
          provider_status_code = p_result_code,
          provider_status_message = 'SUCCESS',
          paid_at = coalesce(paid_at, now()),
          updated_at = now()
      WHERE id = v_payment.id;
    END IF;

    IF v_order.order_status = 'cancelled'
       OR v_order.inventory_reservation_status = 'released' THEN
      UPDATE public.mec_payment_events
      SET processing_status = 'failed',
          error_code = 'PAID_AFTER_RESERVATION_RELEASED'
      WHERE id = v_event.id;
      RETURN jsonb_build_object('outcome', 'reconciliation_required', 'http_status', 200);
    END IF;

    IF v_order.order_status = 'pending_payment'
       AND v_order.inventory_reservation_status = 'reserved' THEN
      UPDATE public.mec_orders
      SET order_status = 'confirmed',
          inventory_reservation_status = 'consumed',
          updated_at = now()
      WHERE id = v_order.id;
    ELSIF v_order.order_status = 'pending_payment'
       AND v_order.inventory_reservation_status <> 'reserved' THEN
      UPDATE public.mec_payment_events
      SET processing_status = 'failed',
          error_code = 'ORDER_RESERVATION_STATE_CONFLICT'
      WHERE id = v_event.id;
      RETURN jsonb_build_object('outcome', 'reconciliation_required', 'http_status', 200);
    END IF;

    UPDATE public.mec_payment_events
    SET processing_status = 'processed', processed_at = now(), error_code = NULL
    WHERE id = v_event.id;
    RETURN jsonb_build_object('outcome', 'processed_success', 'http_status', 200);
  END IF;

  IF v_payment.payment_status <> 'paid' THEN
    UPDATE public.mec_payments
    SET payment_status = 'failed',
        provider_reference = coalesce(nullif(p_reference, ''), provider_reference),
        provider_status_code = p_result_code,
        provider_status_message = 'FAILED',
        updated_at = now()
    WHERE id = v_payment.id;
  END IF;

  UPDATE public.mec_payment_events
  SET processing_status = 'processed', processed_at = now(), error_code = NULL
  WHERE id = v_event.id;

  RETURN jsonb_build_object('outcome', 'processed_failure', 'http_status', 200);
END;
$function$;

REVOKE ALL ON FUNCTION public.mec_process_duitku_callback(text, bigint, text, text, boolean, text, jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mec_process_duitku_callback(text, bigint, text, text, boolean, text, jsonb, text) TO service_role;
