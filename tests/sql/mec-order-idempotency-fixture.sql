-- Disposable PostgreSQL fixture only. Never run against a live project.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END
$$;

CREATE SCHEMA mec_private;

CREATE TABLE public.mec_orders (
  id uuid PRIMARY KEY,
  order_number text NOT NULL UNIQUE,
  subtotal_amount bigint NOT NULL,
  inventory_reserved_until timestamptz NOT NULL
);

CREATE OR REPLACE FUNCTION mec_private.create_order(
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
  inventory_reserved_until timestamptz
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  INSERT INTO public.mec_orders AS o (
    id, order_number, subtotal_amount, inventory_reserved_until
  )
  VALUES (
    gen_random_uuid(),
    'MEC-' || substr(gen_random_uuid()::text, 1, 8),
    100,
    clock_timestamp() + make_interval(mins => p_reservation_minutes)
  )
  RETURNING o.id, o.order_number, o.subtotal_amount, o.inventory_reserved_until;
END
$$;
