-- DRAFT ONLY — DO NOT APPLY.
-- Enforces at most one unresolved/active payment attempt per MEC order.
-- This is separate from the canonical order idempotency contract in PR #4:
-- docs/proposed-migrations/20261023_mec_order_idempotency_rate_limit_DRAFT.sql
-- No live database has been changed by adding this file.

BEGIN;

-- Preflight: stop rather than silently choose a winner if historical data
-- already has more than one unresolved attempt for an order.
DO $preflight$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.mec_payments
    WHERE payment_status IN ('created', 'requesting', 'pending', 'unknown', 'paid')
    GROUP BY order_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'MEC payment-attempt guard preflight failed: duplicate active attempts exist; reconcile them before creating the unique index';
  END IF;
END;
$preflight$;

-- A failed/expired/cancelled attempt may be replaced only after the existing
-- application policy permits it. 'unknown' is deliberately blocking until
-- verified provider reconciliation is available.
CREATE UNIQUE INDEX mec_payments_one_active_attempt_per_order_uidx
  ON public.mec_payments (order_id)
  WHERE payment_status IN ('created', 'requesting', 'pending', 'unknown', 'paid');

COMMENT ON INDEX public.mec_payments_one_active_attempt_per_order_uidx IS
  'MEC draft invariant: at most one active or unresolved Duitku payment attempt per order. Promote only after preflight and concurrency tests pass.';

COMMIT;

-- Release gates:
-- * Verify no duplicate active attempts in the target schema before applying.
-- * Test concurrent inserts for the same order with different idempotency keys.
-- * Verify duplicate-key retry behavior in the Create Invoice Edge Function.
-- * Keep unknown outcomes non-retryable until verified Duitku reconciliation exists.
-- * Never apply this draft without separate explicit approval.
