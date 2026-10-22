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
      '[{""product_id"":""fixture"",""quantity"":1}]'::jsonb,
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
echo "PASS: shared limiter admitted exactly 20 of 40 concurrent requests."
