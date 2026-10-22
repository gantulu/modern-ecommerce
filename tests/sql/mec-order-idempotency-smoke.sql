\set ON_ERROR_STOP on

DO $$
DECLARE
  first_id uuid;
  replay_id uuid;
  conflict_seen boolean := false;
  null_limit_rejected boolean := false;
  order_count bigint;
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
END
$$;
