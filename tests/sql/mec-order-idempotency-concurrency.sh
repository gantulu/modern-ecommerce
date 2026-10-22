#!/usr/bin/env bash
set -euo pipefail

: "\${PGHOST:=127.0.0.1}"
: "\${PGPORT:=5432}"
: "\${PGUSER:=postgres}"
: "\${PGPASSWORD:=postgres}"
export PGHOST PGPORT PGUSER PGPASSWORD
export PGDATABASE=postgres

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# Two simultaneous calls using one key must resolve to one order ID.
call_order() {
  psql -X -qAt -v ON_ERROR_STOP=1 -c "
    SELECT order_id
    FROM public.mec_create_order_idempotent(
      'concurrent-idempotency-key-0001',
      repeat('e', 64),
      'Concurrent Customer',
      'concurrent@example.com',
      '5550102',
      jsonb_build_array(jsonb_build_object('product_id', '11111111-1111-4111-8111-111111111111', 'quantity', 1)),
      NULL,
      repeat('f', 64),
      15
    );" | tr -d '[:space:]'
}
call_order >"$tmp/order1" &
pid1=$!
call_order >"$tmp/order2" &
pid2=$!
wait "$pid1"
wait "$pid2"
id1="$(cat "$tmp/order1")"
id2="$(cat "$tmp/order2")"
test -n "$id1"
test "$id1" = "$id2"

orders_for_key="$(psql -X -qAt -v ON_ERROR_STOP=1 -c \
  "SELECT count(*) FROM public.mec_order_idempotency WHERE idempotency_key='concurrent-idempotency-key-0001' AND order_id IS NOT NULL;")"
test "$orders_for_key" = "1"

# Same key + different request hashes racing must create exactly one order;
# the loser must receive a contract conflict, not a second order.
conflict_orders_before="$(psql -X -qAt -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM public.mec_orders;")"
conflict_stock_before="$(psql -X -qAt -v ON_ERROR_STOP=1 -c "SELECT stock_quantity FROM public.mec_products WHERE id='11111111-1111-4111-8111-111111111111';")"
conflicting_call() {
  local hash="$1"
  local customer="$2"
  psql -X -qAt -v ON_ERROR_STOP=1 -c "
    SELECT order_id
    FROM public.mec_create_order_idempotent(
      'concurrent-conflicting-key-0001', '$hash', '$customer',
      'conflict@example.com', '5550105',
      jsonb_build_array(jsonb_build_object('product_id', '11111111-1111-4111-8111-111111111111', 'quantity', 1)),
      NULL, repeat('d', 64), 15
    );" >"$tmp/$customer.out" 2>"$tmp/$customer.err"
}
set +e
conflicting_call "$(printf 'e%.0s' {1..64})" "CONFLICTING_CUSTOMER_A" &
conflict1=$!
conflicting_call "$(printf 'f%.0s' {1..64})" "CONFLICTING_CUSTOMER_B" &
conflict2=$!
wait "$conflict1"; conflict_status1=$?
wait "$conflict2"; conflict_status2=$?
set -e
if [[ "$conflict_status1" -eq 0 && "$conflict_status2" -eq 0 ]]; then
  echo "ERROR: concurrent same-key/different-hash requests both succeeded" >&2
  exit 1
fi
if [[ "$conflict_status1" -ne 0 && "$conflict_status2" -ne 0 ]]; then
  echo "ERROR: both conflicting same-key requests failed" >&2
  cat "$tmp/CONFLICTING_CUSTOMER_A.err" "$tmp/CONFLICTING_CUSTOMER_B.err" >&2
  exit 1
fi
conflict_orders_after="$(psql -X -qAt -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM public.mec_orders;")"
conflict_stock_after="$(psql -X -qAt -v ON_ERROR_STOP=1 -c "SELECT stock_quantity FROM public.mec_products WHERE id='11111111-1111-4111-8111-111111111111';")"
test "$((conflict_orders_after - conflict_orders_before))" = "1"
test "$((conflict_stock_before - conflict_stock_after))" = "1"

# Two different idempotency keys compete for the only remaining unit.
# Product row locking + stock revalidation must admit one order, not oversell.
orders_before="$(psql -X -qAt -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM public.mec_orders;")"
compete_order() {
  local key="$1"
  psql -X -qAt -v ON_ERROR_STOP=1 -c "
    SELECT order_id
    FROM public.mec_create_order_idempotent(
      '$key',
      repeat('a', 64),
      'Last Unit Customer',
      'last-unit@example.com',
      '5550103',
      jsonb_build_array(jsonb_build_object('product_id', '22222222-2222-4222-8222-222222222222', 'quantity', 1)),
      NULL,
      repeat('b', 64),
      15
    );" >"$tmp/$key.out" 2>"$tmp/$key.err"
}
set +e
compete_order "different-key-stock-race-0001" &
race1=$!
compete_order "different-key-stock-race-0002" &
race2=$!
wait "$race1"; race_status1=$?
wait "$race2"; race_status2=$?
set -e
if [[ "$race_status1" -eq 0 && "$race_status2" -eq 0 ]]; then
  echo "ERROR: both competing orders consumed the final stock unit" >&2
  exit 1
fi
if [[ "$race_status1" -ne 0 && "$race_status2" -ne 0 ]]; then
  echo "ERROR: both competing orders failed; expected one stock reservation winner" >&2
  cat "$tmp/different-key-stock-race-0001.err" "$tmp/different-key-stock-race-0002.err" >&2
  exit 1
fi
orders_after="$(psql -X -qAt -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM public.mec_orders;")"
stock_after="$(psql -X -qAt -v ON_ERROR_STOP=1 -c "SELECT stock_quantity FROM public.mec_products WHERE id='22222222-2222-4222-8222-222222222222';")"
test "$((orders_after - orders_before))" = "1"
test "$stock_after" = "0"

# Opposite item ordering under overlapping transactions must not deadlock.
# create_order locks all distinct product rows in sorted UUID order.
multi_orders_before="$(psql -X -qAt -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM public.mec_orders;")"
stock_a_before="$(psql -X -qAt -v ON_ERROR_STOP=1 -c "SELECT stock_quantity FROM public.mec_products WHERE id='11111111-1111-4111-8111-111111111111';")"
stock_b_before="$(psql -X -qAt -v ON_ERROR_STOP=1 -c "SELECT stock_quantity FROM public.mec_products WHERE id='33333333-3333-4333-8333-333333333333';")"
multi_cart() {
  local key="$1"
  local customer="$2"
  local hash="$3"
  local items="$4"
  psql -X -qAt -v ON_ERROR_STOP=1 -c "
    SELECT order_id
    FROM public.mec_create_order_idempotent(
      '$key', '$hash', '$customer', 'multi-cart@example.com', '5550104',
      '$items'::jsonb, NULL, repeat('c', 64), 15
    );" >"$tmp/$key.out" 2>"$tmp/$key.err"
}
set +e
multi_cart "multi-cart-opposite-order-0001" "MULTI_CART_A" "$(printf 'c%.0s' {1..64})" '[{"product_id":"11111111-1111-4111-8111-111111111111","quantity":1},{"product_id":"33333333-3333-4333-8333-333333333333","quantity":1}]' &
multi1=$!
multi_cart "multi-cart-opposite-order-0002" "MULTI_CART_B" "$(printf 'd%.0s' {1..64})" '[{"product_id":"33333333-3333-4333-8333-333333333333","quantity":1},{"product_id":"11111111-1111-4111-8111-111111111111","quantity":1}]' &
multi2=$!
wait "$multi1"; multi_status1=$?
wait "$multi2"; multi_status2=$?
set -e
if [[ "$multi_status1" -ne 0 || "$multi_status2" -ne 0 ]]; then
  echo "ERROR: overlapping multi-product orders failed; expected deterministic lock ordering" >&2
  cat "$tmp/multi-cart-opposite-order-0001.err" "$tmp/multi-cart-opposite-order-0002.err" >&2
  exit 1
fi
multi_orders_after="$(psql -X -qAt -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM public.mec_orders;")"
stock_a_after="$(psql -X -qAt -v ON_ERROR_STOP=1 -c "SELECT stock_quantity FROM public.mec_products WHERE id='11111111-1111-4111-8111-111111111111';")"
stock_b_after="$(psql -X -qAt -v ON_ERROR_STOP=1 -c "SELECT stock_quantity FROM public.mec_products WHERE id='33333333-3333-4333-8333-333333333333';")"
test "$((multi_orders_after - multi_orders_before))" = "2"
test "$((stock_a_before - stock_a_after))" = "2"
test "$((stock_b_before - stock_b_after))" = "2"


# Forty concurrent requests against a fresh bucket with a limit of twenty:
# exactly twenty must be admitted.
bucket="$(printf 'rate-limit-concurrency-test' | sha256sum | cut -d' ' -f1)"
for i in $(seq 1 40); do
  (
    psql -X -qAt -v ON_ERROR_STOP=1 -c \
      "SELECT allowed FROM public.mec_consume_rate_limit('$bucket', 60, 20);" \
      >"$tmp/limit-$i"
  ) &
done
wait
allowed="$(for f in "$tmp"/limit-*; do cat "$f"; done | grep -c '^t$' || true)"
test "$allowed" = "20"

echo "PASS: concurrent same-key order calls returned one order."
echo "PASS: concurrent same-key/different-hash calls produced one order and one conflict."
echo "PASS: different-key checkout race reserved the final stock unit exactly once."
echo "PASS: overlapping multi-product orders with opposite item orderings both committed without deadlock."
echo "PASS: shared limiter admitted exactly 20 of 40 concurrent requests."
