-- Shared atomic rate limiting for MEC payment-status reads.
-- Proposal only: do not apply to the target/live database without approval.
BEGIN;

CREATE TABLE IF NOT EXISTS public.mec_status_rate_limit_buckets (
  bucket_key_hash text PRIMARY KEY CHECK (bucket_key_hash ~ '^[0-9a-f]{64}$'),
  window_started_at timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count >= 1),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.mec_status_rate_limit_buckets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.mec_status_rate_limit_buckets FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.mec_consume_status_rate_limit(
  p_key_hash text,
  p_limit integer DEFAULT 30,
  p_window_seconds integer DEFAULT 60
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_started timestamptz;
  v_count integer;
  v_now timestamptz := clock_timestamp();
  v_allowed boolean;
  v_retry integer;
BEGIN
  IF p_key_hash IS NULL OR p_key_hash !~ '^[0-9a-f]{64}$'
     OR p_limit < 1 OR p_limit > 100
     OR p_window_seconds < 1 OR p_window_seconds > 3600 THEN
    RAISE EXCEPTION 'Invalid rate-limit arguments' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.mec_status_rate_limit_buckets AS existing(
    bucket_key_hash, window_started_at, request_count, updated_at
  ) VALUES (p_key_hash, v_now, 1, v_now)
  ON CONFLICT (bucket_key_hash) DO UPDATE
  SET window_started_at = CASE
        WHEN existing.window_started_at
             + make_interval(secs => p_window_seconds) <= v_now
          THEN v_now
        ELSE existing.window_started_at
      END,
      request_count = CASE
        WHEN existing.window_started_at
             + make_interval(secs => p_window_seconds) <= v_now
          THEN 1
        ELSE existing.request_count + 1
      END,
      updated_at = v_now
  RETURNING window_started_at, request_count INTO v_started, v_count;

  v_allowed := v_count <= p_limit;
  v_retry := greatest(1, ceil(extract(epoch FROM (v_started + make_interval(secs => p_window_seconds) - v_now)))::integer);

  RETURN jsonb_build_object(
    'allowed', v_allowed,
    'retry_after_seconds', CASE WHEN v_allowed THEN 0 ELSE v_retry END
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.mec_consume_status_rate_limit(text, integer, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mec_consume_status_rate_limit(text, integer, integer)
  TO service_role;

COMMIT;
