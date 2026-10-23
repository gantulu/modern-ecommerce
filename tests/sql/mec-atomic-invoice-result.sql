-- Run only against a disposable PostgreSQL/Supabase test database after applying
-- the proposed migration. The entire test rolls back and creates no persistent fixtures.
BEGIN;

DO $test$
DECLARE
  v_case text;
  v_order_id uuid;
  v_payment_id uuid;
  v_order_number text;
  v_merchant_order_id text;
  v_status text;
  v_expected_status text;
  v_result jsonb;
  v_guard_order_id uuid;
  v_guard_payment_id uuid;
  v_guard_second_payment_id uuid;
  v_guard_order_number text;
  v_unique_violation_seen boolean;
BEGIN
  IF has_function_privilege('anon', 'public.mec_record_duitku_invoice_result(uuid,text,text,text,text,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.mec_record_duitku_invoice_result(uuid,text,text,text,text,text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.mec_record_duitku_invoice_result(uuid,text,text,text,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Unexpected invoice-result RPC grants';
  END IF;

  IF has_function_privilege('anon', 'public.mec_consume_status_rate_limit(text,integer,integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.mec_consume_status_rate_limit(text,integer,integer)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.mec_consume_status_rate_limit(text,integer,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Unexpected status-rate-limit RPC grants';
  END IF;

  v_result := public.mec_consume_status_rate_limit(repeat('a', 64), 2, 60);
  IF v_result->>'allowed' <> 'true' THEN RAISE EXCEPTION 'First rate-limited request should be allowed'; END IF;
  v_result := public.mec_consume_status_rate_limit(repeat('a', 64), 2, 60);
  IF v_result->>'allowed' <> 'true' THEN RAISE EXCEPTION 'Second rate-limited request should be allowed'; END IF;
  v_result := public.mec_consume_status_rate_limit(repeat('a', 64), 2, 60);
  IF v_result->>'allowed' <> 'false' OR coalesce((v_result->>'retry_after_seconds')::integer, 0) < 1 THEN
    RAISE EXCEPTION 'Third rate-limited request should be rejected with a retry interval';
  END IF;

  -- Exercise PR5's real partial unique index on public.mec_payments, not only a
  -- temporary fixture table. Active and unknown attempts must block replacements.
  v_guard_order_id := gen_random_uuid();
  v_guard_payment_id := gen_random_uuid();
  v_guard_second_payment_id := gen_random_uuid();
  v_guard_order_number := 'GUARD-' || replace(v_guard_order_id::text, '-', '');

  INSERT INTO public.mec_orders (
    id, order_number, customer_name, customer_email, customer_phone, currency,
    subtotal_amount, total_amount, order_status, inventory_reservation_status,
    inventory_reserved_until, guest_token_hash
  ) VALUES (
    v_guard_order_id, v_guard_order_number, 'Guard Test', 'guard-test@example.invalid', '0000000000', 'IDR',
    100, 100, 'pending_payment', 'reserved', now() + interval '15 minutes',
    'guard-token-' || replace(v_guard_order_id::text, '-', '')
  );

  INSERT INTO public.mec_payments (
    id, order_id, merchant_order_id, amount_idr, currency, payment_status, idempotency_key
  ) VALUES (
    v_guard_payment_id, v_guard_order_id, 'GUARD-' || replace(v_guard_payment_id::text, '-', ''),
    100, 'IDR', 'requesting', 'guard-' || replace(v_guard_payment_id::text, '-', '')
  );

  v_unique_violation_seen := false;
  BEGIN
    INSERT INTO public.mec_payments (
      id, order_id, merchant_order_id, amount_idr, currency, payment_status, idempotency_key
    ) VALUES (
      v_guard_second_payment_id, v_guard_order_id, 'GUARD-' || replace(v_guard_second_payment_id::text, '-', ''),
      100, 'IDR', 'requesting', 'guard-' || replace(v_guard_second_payment_id::text, '-', '')
    );
  EXCEPTION WHEN unique_violation THEN
    v_unique_violation_seen := true;
  END;
  IF NOT v_unique_violation_seen THEN
    RAISE EXCEPTION 'PR5 active-attempt index allowed two requesting attempts for one order';
  END IF;

  UPDATE public.mec_payments SET payment_status = 'unknown' WHERE id = v_guard_payment_id;
  v_unique_violation_seen := false;
  BEGIN
    INSERT INTO public.mec_payments (
      id, order_id, merchant_order_id, amount_idr, currency, payment_status, idempotency_key
    ) VALUES (
      v_guard_second_payment_id, v_guard_order_id, 'GUARD-' || replace(v_guard_second_payment_id::text, '-', ''),
      100, 'IDR', 'requesting', 'guard-' || replace(v_guard_second_payment_id::text, '-', '')
    );
  EXCEPTION WHEN unique_violation THEN
    v_unique_violation_seen := true;
  END;
  IF NOT v_unique_violation_seen THEN
    RAISE EXCEPTION 'PR5 active-attempt index allowed replacement while prior attempt was unknown';
  END IF;

  UPDATE public.mec_payments SET payment_status = 'failed' WHERE id = v_guard_payment_id;
  INSERT INTO public.mec_payments (
    id, order_id, merchant_order_id, amount_idr, currency, payment_status, idempotency_key
  ) VALUES (
    v_guard_second_payment_id, v_guard_order_id, 'GUARD-' || replace(v_guard_second_payment_id::text, '-', ''),
    100, 'IDR', 'requesting', 'guard-' || replace(v_guard_second_payment_id::text, '-', '')
  );

  DELETE FROM public.mec_payments WHERE id IN (v_guard_payment_id, v_guard_second_payment_id);
  DELETE FROM public.mec_orders WHERE id = v_guard_order_id;

  FOR v_case IN SELECT unnest(ARRAY[
    'callback_before_invoice',
    'invoice_before_callback',
    'timeout_after_callback_success',
    'failed_response_after_callback_success',
    'timeout_without_callback_stays_unknown'
  ]) LOOP
    v_order_id := gen_random_uuid();
    v_payment_id := gen_random_uuid();
    v_order_number := 'TEST-' || replace(v_order_id::text, '-', '');
    v_merchant_order_id := 'TEST-' || replace(v_payment_id::text, '-', '');

    INSERT INTO public.mec_orders (
      id, order_number, customer_name, customer_email, customer_phone, currency,
      subtotal_amount, total_amount, order_status, inventory_reservation_status,
      inventory_reserved_until, guest_token_hash
    ) VALUES (
      v_order_id, v_order_number, 'Atomic Test', 'atomic-test@example.invalid', '0000000000', 'IDR',
      100, 100, 'pending_payment', 'reserved', now() + interval '15 minutes',
      'test-token-' || replace(v_order_id::text, '-', '')
    );

    INSERT INTO public.mec_payments (
      id, order_id, merchant_order_id, amount_idr, currency, payment_status,
      idempotency_key, expires_at
    ) VALUES (
      v_payment_id, v_order_id, v_merchant_order_id, 100, 'IDR', 'requesting',
      'test-' || replace(v_payment_id::text, '-', ''), now() + interval '60 minutes'
    );

    v_expected_status := 'paid';

    IF v_case = 'timeout_without_callback_stays_unknown' THEN
      v_result := public.mec_record_duitku_invoice_result(
        v_payment_id, 'unknown', NULL, NULL, NULL, 'Create Invoice transport outcome unknown'
      );
      v_expected_status := 'unknown';
    ELSIF v_case = 'invoice_before_callback' THEN
      PERFORM public.mec_record_duitku_invoice_result(
        v_payment_id, 'pending', 'REF-' || v_payment_id::text,
        'https://example.invalid/pay', '00', 'SUCCESS'
      );
      UPDATE public.mec_payments
      SET payment_status = 'paid', paid_at = now(), provider_status_code = '00'
      WHERE id = v_payment_id;
    ELSE
      UPDATE public.mec_payments
      SET payment_status = 'paid', paid_at = now(), provider_status_code = '00'
      WHERE id = v_payment_id;

      IF v_case = 'callback_before_invoice' THEN
        v_result := public.mec_record_duitku_invoice_result(
          v_payment_id, 'pending', 'REF-' || v_payment_id::text,
          'https://example.invalid/pay', '00', 'SUCCESS'
        );
      ELSIF v_case = 'timeout_after_callback_success' THEN
        v_result := public.mec_record_duitku_invoice_result(
          v_payment_id, 'unknown', NULL, NULL, NULL, 'Create Invoice transport outcome unknown'
        );
      ELSE
        v_result := public.mec_record_duitku_invoice_result(
          v_payment_id, 'failed', NULL, NULL, 'XX', 'Provider rejection response arrived late'
        );
      END IF;
    END IF;

    SELECT payment_status INTO v_status
    FROM public.mec_payments WHERE id = v_payment_id;

    IF v_status <> v_expected_status THEN
      RAISE EXCEPTION 'Case % expected status %, got %', v_case, v_expected_status, v_status;
    END IF;

    IF (SELECT count(*) FROM public.mec_payment_provider_responses WHERE payment_id = v_payment_id) <> 1 THEN
      RAISE EXCEPTION 'Provider response metadata was not recorded for case %', v_case;
    END IF;

    DELETE FROM public.mec_payment_provider_responses WHERE payment_id = v_payment_id;
    DELETE FROM public.mec_payments WHERE id = v_payment_id;
    DELETE FROM public.mec_orders WHERE id = v_order_id;
  END LOOP;
END;
$test$;

ROLLBACK;
