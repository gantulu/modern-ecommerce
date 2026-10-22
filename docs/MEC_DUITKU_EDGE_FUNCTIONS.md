# MEC Duitku POP Edge Functions

## Current integration gate

**Checkout integration is not ready for end-to-end validation.** The live schema inspection found that `public.products` does not match the repository's frontend Product contract, while `public.applestore` is a separate 222-row candidate catalog with unverified currency semantics. Do not create a catalog migration, deploy functions, or enable checkout until the authoritative source table, price currency/unit, sale-price rule, sellable stock field, and stable product-ID mapping are verified. See [MEC catalog source audit and migration preflight](./MEC_CATALOG_MIGRATION_PREFLIGHT.md).

The existing checkout branch is a draft implementation only. The presence of MEC tables and prior payment migrations does not by itself verify that the displayed catalog, order pricing, and inventory source are aligned.


## Deployed function endpoints

- Create Invoice: `POST https://oszqantvugvbvydlizix.supabase.co/functions/v1/mec-duitku-create-invoice`
- Callback: `POST https://oszqantvugvbvydlizix.supabase.co/functions/v1/mec-duitku-callback`

These are new, isolated function slugs. Existing `duitku`, `duitku-callback`, and all other deployed functions were not edited or redeployed.

## Secrets and environment

Required server-side secrets:
- `DUITKU_MERCHANT_CODE`
- `DUITKU_API_KEY`
- `MEC_DUITKU_RETURN_URL` — return/redirect destination for this e-commerce app; deliberately separate from the legacy `DUITKU_RETURN_URL`.
- `DUITKU_ENVIRONMENT` — `sandbox` by default; set to `production` only when production merchant credentials and return URL are configured.

Supabase runtime values `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are read server-side. Never expose them to browser code. No secret values are committed to Git.

## Create Invoice request

JSON body:
```json
{
  "order_id": "<mec_orders.id>",
  "idempotency_key": "<unique client-generated key>",
  "guest_token": "<required only for guest orders>",
  "payment_method": "<optional Duitku payment method code>",
  "expiry_period": 60
}
```

- For authenticated orders, send `Authorization: Bearer <Supabase access token>`; the function validates the user and verifies order ownership.
- For guest orders, pass the raw guest token issued at order creation. `mec_orders.guest_token_hash` must contain the lowercase hexadecimal SHA-256 digest of that token.
- The server derives amount and item details from MEC order rows; it ignores client-supplied price/total.
- Allowed expiry periods are 5, 10, or 60 minutes.
- A timeout/uncertain Create Invoice response is stored as `unknown`. Do not generate a replacement attempt until reconciliation.
- This endpoint uses `verify_jwt=false` at the gateway because guest checkout is supported; it performs explicit bearer-token validation for authenticated orders and SHA-256 guest-token verification for guest orders.

## Callback behavior

Duitku POP callback signature follows the official contract: HMAC-SHA256 over `merchantCode + amount + merchantOrderId`, using the API key. Create Invoice request signature is HMAC-SHA256 over `merchantCode + timestamp`, using the API key.

The deployed callback function delegates all event/payment/order/reservation writes to `public.mec_process_duitku_callback`, a PostgreSQL RPC that runs in one transaction:

1. Records the callback event and deduplicates it by `event_fingerprint`.
2. Locks the matching payment and order rows before validating amount and applying state transitions.
3. Updates payment status and, for a valid success callback with an active reservation, confirms the order and consumes the reservation atomically.
4. Does not downgrade an already-paid payment when a later failure callback arrives.
5. If payment succeeds after inventory reservation release, records `PAID_AFTER_RESERVATION_RELEASED` and flags reconciliation rather than silently recreating inventory.
6. Grants RPC execution only to `service_role`; `anon` and `authenticated` cannot execute it directly.
7. Acknowledges a valid callback after durable processing/anomaly recording with HTTP 200 to avoid needless provider retries; invalid signatures are rejected, and database/RPC failures return HTTP 500 for retry.

## Verification and release gates

- Atomic success + duplicate replay were tested in a rolled-back SQL transaction using synthetic MEC rows; the test data was not retained.
- RPC grants were verified: execute is denied to `anon` and `authenticated`, and allowed to `service_role`.
- No end-to-end sandbox payment has been run yet. The MEC product/order/payment/event tables currently have zero rows, so a real test requires a valid sandbox merchant setup and a test product/order.
- Verify that `MEC_DUITKU_RETURN_URL` resolves to a real frontend route before checkout testing. Duitku documents that the return URL must be a landing page, and return parameters must not be used as payment authority.
- No POP-specific transaction inquiry/reconciliation job has been implemented. Do not auto-retry an attempt in `unknown`.
- Keep production traffic disabled until end-to-end sandbox success/failure, duplicate callback, invalid signature, amount mismatch, timeout/unknown, and reservation-release race tests pass.

## Official contract references

- Duitku POP Create Invoice and callback: https://docs.duitku.com/pop/id/
- Supabase Edge Functions: https://supabase.com/docs/guides/functions
- Supabase Edge Function secrets: https://supabase.com/docs/guides/functions/secrets

## Frontend checkout integration — branch implementation

The checkout UI in `src/pages/Cart.tsx` now uses the MEC flow instead of writing to legacy `orders` / `order_items` tables:

1. Requires an authenticated Supabase session and collects customer name, email, and phone.
2. Sends only product IDs and quantities to `mec-create-order`; browser prices and totals are display estimates and are not submitted as payment amounts.
3. The order Edge Function validates the bearer token, canonicalizes customer/items, computes a server-side SHA-256 request hash scoped to the authenticated user, and calls the same service-role-only `mec_create_order_idempotent(text,text,text,text,text,jsonb,uuid,text,integer)` RPC defined by PR #4. Same key + same canonical request replays the original order; same key + different request is rejected. The checkout-specific `checkout_idempotency_key` column/RPC overload has been removed to avoid competing contracts.
4. The RPC serializes retries by checkout idempotency key and delegates inventory locking, database-price calculation, order creation, and stock reservation to the existing atomic `mec_private.create_order` routine.
5. The frontend calls `mec-duitku-create-invoice` with a stable per-order idempotency key and redirects only to the HTTPS `payment_url` returned by the backend.
6. The cart is cleared only after a valid payment URL is returned. A failed or uncertain invoice result does not automatically create a replacement payment attempt.

### Required rollout order

- Resolve and review the canonical order-idempotency contract in PR #4: `docs/proposed-migrations/20261023_mec_order_idempotency_rate_limit_DRAFT.sql`. It is a dependency, not yet a live migration; do not deploy `mec-create-order` until its SQL is validated and separately approved for a controlled environment.
- Review the payment-attempt guard draft at `docs/proposed-migrations/20261023_mec_payment_attempt_guard_DRAFT.sql`. Its partial unique index is the database-level invariant for at most one active/unresolved payment attempt per order. It is not applied to any database.
- Deploy `mec-create-order` with the normal authenticated Edge Function JWT verification enabled. It also validates the bearer token server-side.
- Confirm `mec-duitku-create-invoice` is deployed with the required server-side secrets and `MEC_DUITKU_RETURN_URL` points to the intended frontend landing route.
- Build and test the frontend and run the end-to-end sandbox cases before enabling production checkout.

This repository branch does not apply the migration to any database, deploy Edge Functions, set secrets, or enable production traffic. Guest checkout remains outside the frontend flow for this implementation; the current Cart requires sign-in.


## Cross-PR contract and concurrency update (draft)

- PR #4 is the canonical order-idempotency contract. PR #5's former `checkout_idempotency_key` column and alternate six-argument RPC migration were removed from the migration directory to avoid a competing contract. The checkout Edge Function now computes the canonical request hash server-side and calls the nine-argument RPC from PR #4.
- Canonical request fields are authenticated user scope, normalized customer name/email/phone, and normalized item UUID/quantity pairs sorted by product UUID. Duplicate product IDs are merged before hashing and order creation. Reusing a key with a changed customer or item payload returns a conflict rather than silently reusing a different order.
- Create Invoice retains a preflight lookup for a friendly response, but preflight reads alone do not prevent races. The new draft partial unique index blocks more than one payment row in `created`, `requesting`, `pending`, `unknown`, or `paid` state per order. Concurrent unique-violation handling rereads the existing attempt and returns a conflict/reuse response without issuing another provider request.
- The payment-attempt index is in `docs/proposed-migrations/20261023_mec_payment_attempt_guard_DRAFT.sql`, deliberately outside `supabase/migrations/`. It includes a preflight that stops if historical duplicate active attempts exist. A disposable SQL test and CI workflow verify the partial-unique-index semantics; neither applies the index to the live database.
- These changes do not resolve provider inquiry/reconciliation for `unknown` outcomes. Such attempts remain blocked from replacement. The Sandbox end-to-end gate remains closed.
