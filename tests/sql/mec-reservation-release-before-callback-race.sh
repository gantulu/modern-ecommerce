#!/usr/bin/env bash
set -euo pipefail

: "${MEC_TEST_DATABASE_URL:?Set MEC_TEST_DATABASE_URL to a disposable PostgreSQL/Supabase test database. Refusing to use the default connection.}"
psql_test() { psql "$MEC_TEST_DATABASE_URL" -v ON_ERROR_STOP=1 "$@"; }

order_id="$(psql_test -Atc 'select gen_random_uuid()')"
product_id="$(psql_test -Atc 'select gen_random_uuid()')"
payment_id="$(psql_test -Atc 'select gen_random_uuid()')"
order_number="RELEASE-FIRST-$(printf '%s' "$order_id" | tr -d '-')"
merchant_order_id="RELEASE-FIRST-$(printf '%s' "$payment_id" | tr -d '-')"
idem_key="release-first-$(printf '%s' "$payment_id" | tr -d '-')"
event_fingerprint="release-first-event-$(printf '%s' "$payment_id" | tr -d '-')"
slug="release-first-$(printf '%s' "$product_id" | tr -d '-')"
log_release="$(mktemp)"
log_callback="$(mktemp)"
cleanup() {
  psql_test <<SQL >/dev/null 2>&1 || true
DELETE FROM public.mec_payment_events WHERE merchant_order_id = '$merchant_order_id';
DELETE FROM public.mec_payment_provider_responses WHERE payment_id = '$payment_id';
DELETE FROM public.mec_payments WHERE id = '$payment_id';
DELETE FROM public.mec_order_items WHERE order_id = '$order_id';
DELETE FROM public.mec_orders WHERE id = '$order_id';
DELETE FROM public.mec_products WHERE id = '$product_id';
SQL
  rm -f "$log_release" "$log_callback"
}
trap cleanup EXIT

psql_test <<SQL
INSERT INTO public.mec_products(id,name,slug,price_idr,stock_quantity,is_active)
VALUES ('$product_id','Release-first test product','$slug',100,0,true);
INSERT INTO public.mec_orders(
  id,order_number,customer_name,customer_email,customer_phone,currency,
  subtotal_amount,total_amount,order_status,inventory_reservation_status,
  inventory_reserved_until,guest_token_hash
) VALUES (
  '$order_id','$order_number','Race test','race@example.invalid','0000000000','IDR',
  100,100,'pending_payment','reserved',now()+interval '15 minutes','release-first-test-guest-hash'
);
INSERT INTO public.mec_order_items(
  order_id,product_id,product_name_snapshot,unit_price_idr,quantity
) VALUES ('$order_id','$product_id','Release-first test product',100,1);
INSERT INTO public.mec_payments(
  id,order_id,merchant_order_id,amount_idr,currency,payment_status,idempotency_key
) VALUES ('$payment_id','$order_id','$merchant_order_id',100,'IDR','failed','$idem_key');
SQL

# Hold the payment row, release the reservation, then allow the callback to proceed.
# This simulates the release transaction winning the shared payment-row lock.
psql_test >"$log_release" 2>&1 <<SQL &
BEGIN;
SELECT id FROM public.mec_payments WHERE id = '$payment_id' FOR UPDATE;
SELECT pg_sleep(1);
SELECT public.mec_release_order_inventory('$order_id','cancelled');
COMMIT;
SQL
release_pid=$!

sleep 0.2
psql_test >"$log_callback" 2>&1 <<SQL
SELECT public.mec_process_duitku_callback(
  '$merchant_order_id',100,'TESTMERCHANT','00',true,'$event_fingerprint',
  jsonb_build_object('test_fixture',true),'RELEASE-FIRST-REFERENCE'
);
SQL
wait "$release_pid"

payment_status="$(psql_test -Atc "SELECT payment_status FROM public.mec_payments WHERE id='$payment_id'")"
order_state="$(psql_test -Atc "SELECT order_status || ':' || inventory_reservation_status FROM public.mec_orders WHERE id='$order_id'")"
stock="$(psql_test -Atc "SELECT stock_quantity FROM public.mec_products WHERE id='$product_id'")"
event_error="$(psql_test -Atc "SELECT error_code FROM public.mec_payment_events WHERE event_fingerprint='$event_fingerprint'")"

if [[ "$payment_status" != "paid" || "$order_state" != "cancelled:released" || "$stock" != "1" || "$event_error" != "PAID_AFTER_RESERVATION_RELEASED" ]]; then
  echo "FAIL: release-first race did not land in the explicit reconciliation state" >&2
  echo "payment_status=$payment_status order_state=$order_state stock=$stock event_error=$event_error" >&2
  cat "$log_release" "$log_callback" >&2
  exit 1
fi

echo "PASS: release-first race preserves inventory and marks the late successful payment for reconciliation."
