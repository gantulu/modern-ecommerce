-- Disposable contract test for the payment-attempt partial unique index.
-- This tests PostgreSQL semantics using a temporary fixture; it does not apply
-- the proposed index to the live MEC table or validate target-project data.
BEGIN;

CREATE TEMP TABLE mec_payment_attempt_guard_fixture (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id uuid NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  payment_status text NOT NULL CHECK (
    payment_status IN ('created','requesting','pending','paid','failed','expired','cancelled','unknown')
  )
);

CREATE UNIQUE INDEX mec_payment_attempt_guard_fixture_one_active
  ON mec_payment_attempt_guard_fixture(order_id)
  WHERE payment_status IN ('created','requesting','pending','unknown','paid');

INSERT INTO mec_payment_attempt_guard_fixture(order_id,idempotency_key,payment_status)
VALUES ('11111111-1111-4111-8111-111111111111','attempt-key-00000001','requesting');

DO $test$
BEGIN
  BEGIN
    INSERT INTO mec_payment_attempt_guard_fixture(order_id,idempotency_key,payment_status)
    VALUES ('11111111-1111-4111-8111-111111111111','attempt-key-00000002','requesting');
    RAISE EXCEPTION 'Expected a unique_violation for concurrent active attempts';
  EXCEPTION
    WHEN unique_violation THEN
      NULL;
  END;
END;
$test$;

-- Unknown outcomes deliberately block replacement attempts.
UPDATE mec_payment_attempt_guard_fixture SET payment_status='unknown' WHERE id=1;
DO $test$
BEGIN
  BEGIN
    INSERT INTO mec_payment_attempt_guard_fixture(order_id,idempotency_key,payment_status)
    VALUES ('11111111-1111-4111-8111-111111111111','attempt-key-00000003','pending');
    RAISE EXCEPTION 'Expected unknown to block a replacement attempt';
  EXCEPTION
    WHEN unique_violation THEN
      NULL;
  END;
END;
$test$;

-- A known terminal failure releases the index predicate, allowing a new attempt
-- only after application policy has accepted that failure as final.
UPDATE mec_payment_attempt_guard_fixture SET payment_status='failed' WHERE id=1;
INSERT INTO mec_payment_attempt_guard_fixture(order_id,idempotency_key,payment_status)
VALUES ('11111111-1111-4111-8111-111111111111','attempt-key-00000004','requesting');

DO $assert$
BEGIN
  IF (SELECT count(*) FROM mec_payment_attempt_guard_fixture
      WHERE order_id='11111111-1111-4111-8111-111111111111'
        AND payment_status IN ('created','requesting','pending','unknown','paid')) <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one active payment attempt';
  END IF;
END;
$assert$;

ROLLBACK;
