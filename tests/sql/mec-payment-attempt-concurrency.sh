#!/usr/bin/env bash
set -euo pipefail

table="public.mec_payment_attempt_guard_concurrency_fixture"
order_id="11111111-1111-4111-8111-111111111111"
log1="$(mktemp)"
log2="$(mktemp)"
cleanup() {
  psql -v ON_ERROR_STOP=1 -c "DROP TABLE IF EXISTS $table" >/dev/null 2>&1 || true
  rm -f "$log1" "$log2"
}
trap cleanup EXIT

psql -v ON_ERROR_STOP=1 <<'SQL'
CREATE TABLE public.mec_payment_attempt_guard_concurrency_fixture (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id uuid NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  payment_status text NOT NULL CHECK (
    payment_status IN ('created','requesting','pending','paid','failed','expired','cancelled','unknown')
  )
);
CREATE UNIQUE INDEX mec_payment_attempt_guard_concurrency_fixture_one_active
  ON public.mec_payment_attempt_guard_concurrency_fixture(order_id)
  WHERE payment_status IN ('created','requesting','pending','unknown','paid');
SQL

insert_attempt() {
  local key="$1"
  local logfile="$2"
  psql -v ON_ERROR_STOP=1 >"$logfile" 2>&1 <<SQL
BEGIN;
SELECT pg_sleep(0.25);
INSERT INTO $table(order_id,idempotency_key,payment_status)
VALUES ('$order_id','$key','requesting');
COMMIT;
SQL
}

set +e
insert_attempt "concurrent-attempt-key-0001" "$log1" &
pid1=$!
insert_attempt "concurrent-attempt-key-0002" "$log2" &
pid2=$!
wait "$pid1"; status1=$?
wait "$pid2"; status2=$?
set -e

if [[ "$status1" -eq 0 && "$status2" -eq 0 ]]; then
  echo "ERROR: both concurrent active attempts were admitted" >&2
  cat "$log1" "$log2" >&2
  exit 1
fi
if [[ "$status1" -ne 0 && "$status2" -ne 0 ]]; then
  echo "ERROR: both concurrent attempts failed; expected exactly one winner" >&2
  cat "$log1" "$log2" >&2
  exit 1
fi

fail_log="$log1"
[[ "$status1" -ne 0 ]] || fail_log="$log2"
if ! grep -qi "unique constraint\|duplicate key" "$fail_log"; then
  echo "ERROR: losing request did not fail due to the unique active-attempt invariant" >&2
  cat "$fail_log" >&2
  exit 1
fi

count="$(psql -At -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM $table WHERE order_id='$order_id' AND payment_status IN ('created','requesting','pending','unknown','paid')")"
if [[ "$count" != "1" ]]; then
  echo "ERROR: expected exactly one active attempt, got $count" >&2
  exit 1
fi

echo "PASS: two concurrent inserts with different idempotency keys admitted exactly one active attempt."
