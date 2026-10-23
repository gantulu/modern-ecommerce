#!/usr/bin/env bash
set -euo pipefail

: "${MEC_TEST_DATABASE_URL:?Set MEC_TEST_DATABASE_URL to a disposable PostgreSQL/Supabase test database. Refusing to use the default connection.}"

psql_test() { psql "$MEC_TEST_DATABASE_URL" -v ON_ERROR_STOP=1 "$@"; }

order_id="$(psql_test -Atc 'select gen_random_uuid()')"
product_id="$(psql_test -Atc 'select gen_random_uuid()')"
payment_id="$(psql_test -Atc 'select gen_random_uuid()')"
order_number="RACE-$(printf '%s' "$order_id" | tr -d '-')"
merchant_order_id="RACE-$(printf '%s' "$payment_id" | tr -d '-')"
idem_key="race-test-$(printf '%s' "$payment_id" | tr -d '-')"
event_fingerprint="race-event-$(printf '%s' "$payment_id" | tr -d '-')"
slug="race-test-$(printf '%s' "$product_id" | tr -d '-')"
log_callback="$(mktemp)"
log_release="$(mktemp)"
cleanup() {
  psql_test <<SQL >/dev/null 2>&1 || true
DELETE FROM public.mec_payment_events WHERE merchant_order_id = '$merchant_order_id';
DELETE FROM public.mec_payment_provider_responses WHERE payment_id = '$payment_id';
DELETE FROM public.mec_payments WHERE id = '$payment_id';
DELETE FROM public.mec_order_items WHERE order_id = '$order_id';
DELETE FROM public.mec_orders WHERE id = '$order_id';
DELETE FROM public.mec_products WHERE id = '$product_id';
SQL
  rm -f "$log_callback" "$log_release"
}
trap cleanup EXIT

psql_test <<SQL
INSERT INTO public.mec_products(id,name,slug,price_idr,stock_quantity,is_active)
VALUES ('$product_id','Race test product','$slug',100,0,true);
INSERT INTO public.mec_orders(
  id,order_number,customer_name,customer_email,customer_phone,currency,
  subtotal_amount,total_amount,order_status,inventory_reservation_status,
  inventory_reserved_until,guest_token_hash
) VALUES (
  '$order_id','$order_number','Race test','race@example.invalid','0000000000','IDR',
  100,100,'pending_payment','reserved',now()+interval '15 minutes','race-test-guest-hash'
);
INSERT INTO public.mec_order_items(
  order_id,product_id,product_name_snapshot,unit_price_idr,quantity
) VALUES ('$order_id','$product_id','Race test product',100,1);
-- A failed payment is releasable unless the concurrent callback wins the payment-row lock.
INSERT INTO public.mec_payments(
  id,order_id,merchant_order_id,amount_idr,currency,payment_status,idempotency_key
) VALUES ('$payment_id','$order_id','$merchant_order_id',100,'IDR','failed','$idem_key');
SQL

# Hold the payment row first, then process a success callback in the same transaction.
# The release operation starts while that row is locked and must wait before locking the order.
psql_test >"$log_callback" 2>&1 <<SQL &
BEGIN;
SELECT id FROM public.mec_payments WHERE id = '$payment_id' FOR UPDATE;
SELECT pg_sleep(1);
SELECT public.mec_process_duitku_callback(
  '$merchant_order_id',100,'TESTMERCHANT','00',true,'$event_fingerprint',
  jsonb_build_object('test_fixture',true),'RACE-REFERENCE'
);
COMMIT;
SQL
callback_pid=$!

sleep 0.2
psql_test -At >"$log_release" 2>&1 <<SQL
SELECT public.mec_release_order_inventory('$order_id','cancelled');
SQL

wait "$callback_pid"

release_result="$(tr -d '\r' <"$log_release" | tail -n 1)"
payment_status="$(psql_test -Atc "SELECT payment_status FROM public.mec_payments WHERE id='$payment_id'")"
order_state="$(psql_test -Atc "SELECT order_status || ':' || inventory_reservation_status FROM public.mec_orders WHERE id='$order_id'")"
stock="$(psql_test -Atc "SELECT stock_quantity FROM public.mec_products WHERE id='$product_id'")"

if [[ "$release_result" != "f" || "$payment_status" != "paid" || "$order_state" != "confirmed:consumed" || "$stock" != "0" ]]; then
  echo "FAIL: callback/release race invariant was violated" >&2
  echo "release_result=$release_result payment_status=$payment_status order_state=$order_state stock=$stock" >&2
  cat "$log_callback" "$log_release" >&2
  exit 1
fi

echo "PASS: callback success wins over inventory release; paid/confirmed/consumed remains consistent."
