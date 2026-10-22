\set ON_ERROR_STOP on

DO $$
DECLARE
  first_id uuid;
  replay_id uuid;
  conflict_seen boolean := false;
  null_limit_rejected boolean := false;
  order_count bigint;
  rollback_failure_seen boolean := false;
  retry_id uuid;
  function_owner text;
  function_settings text[];
BEGIN
  SELECT order_id INTO first_id
  FROM public.mec_create_order_idempotent(
    'test-idempotency-key-0001',
    repeat('a', 64),
    'Test Customer',
    'test@example.com',
    '5550100',
    '[{"product_id":"fixture","quantity":1}]'::jsonb,
    NULL,
    repeat('b', 64),
    15
  );

  SELECT order_id INTO replay_id
  FROM public.mec_create_order_idempotent(
    'test-idempotency-key-0001',
    repeat('a', 64),
    'Test Customer',
    'test@example.com',
    '5550100',
    '[{"product_id":"fixture","quantity":1}]'::jsonb,
    NULL,
    repeat('b', 64),
    15
  );

  IF first_id IS NULL OR replay_id IS DISTINCT FROM first_id THEN
    RAISE EXCEPTION 'same-key replay did not return the original order';
  END IF;

  SELECT count(*) INTO order_count FROM public.mec_orders;
  IF order_count <> 1 THEN
    RAISE EXCEPTION 'expected exactly one order after replay, got %', order_count;
  END IF;

  BEGIN
    PERFORM * FROM public.mec_create_order_idempotent(
      'test-idempotency-key-0001',
      repeat('c', 64),
      'Different Customer',
      'different@example.com',
      '5550101',
      '[{"product_id":"fixture","quantity":2}]'::jsonb,
      NULL,
      repeat('b', 64),
      15
    );
  EXCEPTION WHEN SQLSTATE '22023' THEN
    conflict_seen := true;
  END;
  IF NOT conflict_seen THEN
    RAISE EXCEPTION 'same-key/different-request was not rejected';
  END IF;

  BEGIN
    PERFORM * FROM public.mec_consume_rate_limit(repeat('d', 64), NULL, 20);
  EXCEPTION WHEN SQLSTATE '22023' THEN
    null_limit_rejected := true;
  END;
  IF NOT null_limit_rejected THEN
    RAISE EXCEPTION 'NULL rate-limit window was not rejected';
  END IF;

  -- A failed order operation must roll back both the key claim and order row.
  BEGIN
    PERFORM * FROM public.mec_create_order_idempotent(
      'rollback-retry-key-00001', repeat('9', 64), 'ROLLBACK_TEST',
      'rollback@example.com', '5550199',
      '[{"product_id":"fixture","quantity":1}]'::jsonb,
      NULL, repeat('8', 64), 15
    );
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    rollback_failure_seen := true;
  END;
  IF NOT rollback_failure_seen THEN
    RAISE EXCEPTION 'fixture failure was not triggered';
  END IF;
  IF EXISTS (SELECT 1 FROM public.mec_order_idempotency WHERE idempotency_key='rollback-retry-key-00001')
     OR (SELECT count(*) FROM public.mec_orders) <> 1 THEN
    RAISE EXCEPTION 'failed order call left partial idempotency/order rows';
  END IF;

  -- Same key is reusable after rollback, because no claim was committed.
  SELECT order_id INTO retry_id
  FROM public.mec_create_order_idempotent(
    'rollback-retry-key-00001', repeat('9', 64), 'Retry Customer',
    'retry@example.com', '5550198',
    '[{"product_id":"fixture","quantity":1}]'::jsonb,
    NULL, repeat('8', 64), 15
  );
  IF retry_id IS NULL OR (SELECT count(*) FROM public.mec_orders) <> 2 THEN
    RAISE EXCEPTION 'same key could not be retried after transaction rollback';
  END IF;

  IF has_function_privilege('anon',
       'public.mec_create_order_idempotent(text,text,text,text,text,jsonb,uuid,text,integer)', 'EXECUTE')
     OR has_function_privilege('authenticated',
       'public.mec_create_order_idempotent(text,text,text,text,text,jsonb,uuid,text,integer)', 'EXECUTE')
     OR NOT has_function_privilege('service_role',
       'public.mec_create_order_idempotent(text,text,text,text,text,jsonb,uuid,text,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'unexpected effective RPC EXECUTE grants';
  END IF;

  IF has_table_privilege('service_role', 'public.mec_order_idempotency', 'SELECT')
     OR has_table_privilege('service_role', 'public.mec_order_idempotency', 'INSERT')
     OR has_table_privilege('service_role', 'mec_private.rate_limit_buckets', 'SELECT')
     OR has_table_privilege('service_role', 'mec_private.rate_limit_buckets', 'INSERT') THEN
    RAISE EXCEPTION 'service_role must use the SECURITY DEFINER RPC boundary, not direct backing-table grants';
  END IF;

  SELECT pg_get_userbyid(p.proowner), p.proconfig
    INTO function_owner, function_settings
  FROM pg_proc p
  WHERE p.oid = 'public.mec_create_order_idempotent(text,text,text,text,text,jsonb,uuid,text,integer)'::regprocedure;
  IF function_owner <> current_user OR NOT (function_settings @> ARRAY['search_path=""']) THEN
    RAISE EXCEPTION 'RPC owner/search_path fixture assertion failed: owner %, settings %',
      function_owner, function_settings;
  END IF;
END
$$;
