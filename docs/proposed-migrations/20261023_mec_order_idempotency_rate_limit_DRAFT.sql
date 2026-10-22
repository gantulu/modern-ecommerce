-- DRAFT ONLY — DO NOT APPLY.
-- Proposed additive MEC order idempotency + shared rate-limit contract.
-- Keep outside supabase/migrations/ until reviewed and explicitly approved.
-- Target: existing MEC schema from 20261022180316_create_mec_ecommerce_v1.sql.

BEGIN;

-- 1) Durable order-creation idempotency.
CREATE TABLE public.mec_order_idempotency (
  idempotency_key text PRIMARY KEY,
  request_hash text NOT NULL,
  order_id uuid UNIQUE REFERENCES public.mec_orders(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mec_order_idempotency_key_length
    CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  CONSTRAINT mec_order_idempotency_request_hash_format
    CHECK (request_hash ~ '^[0-9a-f]{64}$')
);

ALTER TABLE public.mec_order_idempotency ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.mec_order_idempotency FROM PUBLIC, anon, authenticated;
-- The SECURITY DEFINER RPC owner performs table access; callers need RPC EXECUTE only.

-- This function wraps the existing transactional order creator. The request_hash
-- must be computed server-side from canonicalized inputs, identity scope, and
-- (for guests) the hash of the guest token. Never accept a client-supplied hash.
CREATE OR REPLACE FUNCTION public.mec_create_order_idempotent(
  p_idempotency_key text,
  p_request_hash text,
  p_customer_name text,
  p_customer_email text,
  p_customer_phone text,
  p_items jsonb,
  p_user_id uuid DEFAULT NULL,
  p_guest_token_hash text DEFAULT NULL,
  p_reservation_minutes integer DEFAULT 15
)
RETURNS TABLE(
  order_id uuid,
  order_number text,
  subtotal_amount bigint,
  inventory_reserved_until timestamptz,
  replayed boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_inserted_key text;
  v_existing public.mec_order_idempotency%ROWTYPE;
  v_order record;
BEGIN
  IF p_idempotency_key IS NULL
     OR length(p_idempotency_key) < 16
     OR length(p_idempotency_key) > 128
     OR p_request_hash IS NULL
     OR p_request_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Invalid idempotency contract' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.mec_order_idempotency(idempotency_key, request_hash)
  VALUES (p_idempotency_key, p_request_hash)
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING idempotency_key INTO v_inserted_key;

  IF v_inserted_key IS NULL THEN
    -- ON CONFLICT waits for an in-flight insert to commit/rollback. Lock the
    -- committed record and reject key reuse with a different request.
    SELECT * INTO v_existing
    FROM public.mec_order_idempotency
    WHERE idempotency_key = p_idempotency_key
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Idempotency record unavailable; retry safely'
        USING ERRCODE = '40001';
    END IF;

    IF v_existing.request_hash <> p_request_hash THEN
      RAISE EXCEPTION 'Idempotency key reused with different request'
        USING ERRCODE = '22023';
    END IF;

    IF v_existing.order_id IS NULL THEN
      RAISE EXCEPTION 'Idempotency record has no completed order; reconcile'
        USING ERRCODE = '55000';
    END IF;

    RETURN QUERY
    SELECT o.id, o.order_number, o.subtotal_amount,
           o.inventory_reserved_until, true
    FROM public.mec_orders o
    WHERE o.id = v_existing.order_id;
    RETURN;
  END IF;

  -- Existing MEC function recalculates prices from product rows, locks stock,
  -- reserves inventory, and inserts the order and items in this transaction.
  SELECT * INTO v_order
  FROM mec_private.create_order(
    p_customer_name, p_customer_email, p_customer_phone, p_items,
    p_user_id, p_guest_token_hash, p_reservation_minutes
  );

  UPDATE public.mec_order_idempotency
  SET order_id = v_order.order_id
  WHERE idempotency_key = p_idempotency_key;

  RETURN QUERY SELECT v_order.order_id, v_order.order_number,
                      v_order.subtotal_amount, v_order.inventory_reserved_until,
                      false;
END;
$function$;

REVOKE ALL ON FUNCTION public.mec_create_order_idempotent(
  text, text, text, text, text, jsonb, uuid, text, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mec_create_order_idempotent(
  text, text, text, text, text, jsonb, uuid, text, integer
) TO service_role;

-- 2) Shared atomic rate limiting (draft; validate load/retention before adoption).
-- Store only a server-derived hash of the limiter bucket, not raw IP/address.
CREATE TABLE mec_private.rate_limit_buckets (
  bucket_hash text PRIMARY KEY,
  window_started_at timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mec_rate_limit_bucket_hash_format
    CHECK (bucket_hash ~ '^[0-9a-f]{64}$')
);

REVOKE ALL ON mec_private.rate_limit_buckets FROM PUBLIC, anon, authenticated;
-- The SECURITY DEFINER limiter RPC owner performs table access; callers need RPC EXECUTE only.

CREATE OR REPLACE FUNCTION public.mec_consume_rate_limit(
  p_bucket_hash text,
  p_window_seconds integer DEFAULT 60,
  p_max_requests integer DEFAULT 30
)
RETURNS TABLE(allowed boolean, remaining integer, retry_after_seconds integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_row mec_private.rate_limit_buckets%ROWTYPE;
  v_now timestamptz;
BEGIN
  v_now := clock_timestamp();
  IF p_bucket_hash IS NULL OR p_bucket_hash !~ '^[0-9a-f]{64}$'
     OR p_window_seconds IS NULL OR p_window_seconds < 1 OR p_window_seconds > 3600
     OR p_max_requests IS NULL OR p_max_requests < 1 OR p_max_requests > 10000 THEN
    RAISE EXCEPTION 'Invalid rate-limit parameters' USING ERRCODE = '22023';
  END IF;

  INSERT INTO mec_private.rate_limit_buckets(
    bucket_hash, window_started_at, request_count, updated_at
  ) VALUES (p_bucket_hash, v_now, 1, v_now)
  ON CONFLICT (bucket_hash) DO UPDATE SET
    window_started_at = CASE
      WHEN mec_private.rate_limit_buckets.window_started_at
           + make_interval(secs => p_window_seconds) <= clock_timestamp()
      THEN clock_timestamp()
      ELSE mec_private.rate_limit_buckets.window_started_at
    END,
    request_count = CASE
      WHEN mec_private.rate_limit_buckets.window_started_at
           + make_interval(secs => p_window_seconds) <= clock_timestamp()
      THEN 1
      ELSE least(mec_private.rate_limit_buckets.request_count + 1, p_max_requests + 1)
    END,
    updated_at = clock_timestamp()
  RETURNING * INTO v_row;

  v_now := clock_timestamp();
  RETURN QUERY SELECT
    v_row.request_count <= p_max_requests,
    greatest(0, p_max_requests - v_row.request_count),
    CASE WHEN v_row.request_count > p_max_requests
      THEN greatest(1, ceil(extract(epoch FROM (
        v_row.window_started_at + make_interval(secs => p_window_seconds) - v_now
      )))::integer)
      ELSE 0
    END;
END;
$function$;

REVOKE ALL ON FUNCTION public.mec_consume_rate_limit(text, integer, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mec_consume_rate_limit(text, integer, integer)
  TO service_role;

-- Retention cleanup must be scheduled/observed before production use.
-- Do not run unbounded cleanup synchronously on every API request.
CREATE OR REPLACE FUNCTION public.mec_cleanup_rate_limit_buckets(
  p_retention interval DEFAULT interval '24 hours'
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_deleted bigint;
BEGIN
  IF p_retention IS NULL OR p_retention < interval '1 hour' OR p_retention > interval '30 days' THEN
    RAISE EXCEPTION 'Invalid retention interval' USING ERRCODE = '22023';
  END IF;

  DELETE FROM mec_private.rate_limit_buckets
  WHERE updated_at < clock_timestamp() - p_retention;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$function$;

REVOKE ALL ON FUNCTION public.mec_cleanup_rate_limit_buckets(interval)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mec_cleanup_rate_limit_buckets(interval)
  TO service_role;

COMMIT;

-- Review gates before promotion to a real migration:
-- * Test concurrent same-key calls and same-key/different-request conflict.
-- * Verify SECURITY DEFINER ownership and grants in target Supabase project.
-- * Add request canonicalization + token handling tests in the Edge Function.
-- * Select and configure scheduled cleanup for rate_limit_buckets.
-- * Load-test shared DB limiter; an external shared limiter may be preferable.
-- * Never apply this draft without separate explicit approval.
