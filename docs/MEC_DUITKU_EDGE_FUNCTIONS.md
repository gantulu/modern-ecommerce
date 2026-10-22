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

Duitku sends a form-encoded POST. The function:
1. Verifies HMAC-SHA256 over `merchantCode + amount + merchantOrderId` and checks the merchant code.
2. Matches `merchantOrderId` and amount against `mec_payments`.
3. Persists an event in `mec_payment_events` with a fingerprint for duplicate detection.
4. Updates payment status; a later failure callback cannot downgrade a payment already marked paid.
5. Marks the order confirmed and reservation consumed on verified success if it is still awaiting payment and the reservation remains active.
6. Returns HTTP 200 only after the callback is processed. Failed processing returns a non-200 response so Duitku can retry.

## Current implementation limits / release gates

- The callback updates payment, order, and event rows through separate PostgREST requests rather than a single PostgreSQL transaction. Before enabling real customer payments, replace this with an atomic MEC-only RPC so a partial write can be recovered deterministically.
- A successful callback arriving after the order's reservation was already released is flagged for manual reconciliation; it does not silently recreate inventory.
- There is no verified POP-specific transaction inquiry/reconciliation job yet. Do not auto-retry a payment in `unknown`.
- No real payment or callback test has been run because that would require an actual sandbox merchant transaction and configured secrets.
- Confirm that `MEC_DUITKU_RETURN_URL`, Duitku merchant credentials, and `DUITKU_ENVIRONMENT=sandbox` are set before sandbox testing. Production traffic should remain disabled until callback concurrency/idempotency and failure recovery are tested.

## Official contract references

- Duitku POP Create Invoice and callback: https://docs.duitku.com/pop/id/
- Supabase Edge Functions: https://supabase.com/docs/guides/functions
- Supabase Edge Function secrets: https://supabase.com/docs/guides/functions/secrets
