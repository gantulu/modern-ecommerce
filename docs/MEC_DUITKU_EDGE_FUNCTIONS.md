# MEC Duitku POP Edge Functions

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
