# MEC Payment Status API V1 — Audit and Verification Notes

Date: 2026-10-23
Scope: read-only audit of deployed MEC backend and the repository checkout/token flow, plus branch-only endpoint hardening and unit-test additions.

## Current branch implementation

Branch: `feat/mec-payment-status-api-v1`
Review PR: https://github.com/gantulu/modern-ecommerce/pull/3

New files:
- `supabase/functions/mec-duitku-payment-status/index.ts`
- `supabase/functions/mec-duitku-payment-status/authorization.ts`
- `supabase/functions/mec-duitku-payment-status/authorization_test.ts`
- `supabase/functions/mec-duitku-payment-status/rate_limit.ts`
- `supabase/functions/mec-duitku-payment-status/rate_limit_test.ts`

The endpoint is read-only. It looks up a payment by `merchantOrderId`, loads the associated order, authorizes the order owner or verifies the guest token against `guest_token_hash`, and returns a minimal status payload. It does not call Duitku or mutate records.

## Rate-limit limitation

The current implementation is a per-isolate sliding-window limiter (30 requests per minute per edge-provided `cf-connecting-ip`, with a shared `ip:unknown` bucket when that header is absent). Unit tests cover limit enforcement, bucket separation, retry delay, and refusing caller-controlled `X-Forwarded-For`.

**This is not a distributed or production-grade limiter.** Supabase Edge Function isolates do not share memory, so a caller can receive a higher effective limit across isolates or cold starts. Before enabling public production traffic, replace or augment this with a shared atomic limiter (e.g. a dedicated server-side database RPC or an external rate-limit service). That requires a separately reviewed implementation and, if a database RPC/table is chosen, explicit database-change approval.

## Authorization tests

Unit tests cover:
- Authenticated order owner allowed.
- Different authenticated user denied.
- Invalid bearer token denied.
- Guest order allowed with matching raw token and SHA-256 hash.
- Guest token missing or incorrect denied.
- Malformed hash rejected; uppercase hex digest accepted.

The test files have been committed to this branch, but the Deno test runner has not yet been executed in a controlled environment. Test presence is not test-pass evidence.

## Guest-token lifecycle audit

Verified in the MEC schema migration:
- `mec_orders.guest_token_hash` exists.
- Guest order creation requires a non-empty hash when `p_user_id` is NULL.
- `mec_private.create_order` stores the supplied hash.
- The public `mec_create_order` wrapper is executable only by `service_role`.
- `mec-duitku-create-invoice` expects the raw guest token in its request body and hashes it before comparing it to the stored digest.

Not verified / blocking:
- No MEC order-creation Edge Function was found in the deployed Edge Function list or repository's `supabase/functions` tree.
- The RPC accepts only the hash and does not return the raw token.
- The current frontend checkout does not generate a high-entropy token, submit its hash through a trusted server-side creation flow, or retain/pass the raw token to Create Invoice.
- Consequently, the full lifecycle (generate once → hash → persist hash → deliver raw token to browser → use token for invoice and status reads) is not implemented/verified end-to-end.

Do not weaken the hash comparison or expose guest orders through RLS to work around this gap.

## Checkout-to-MEC audit

The current `src/pages/Cart.tsx`:
- Requires a signed-in user and redirects guests to `/auth`.
- Inserts directly into legacy `orders` and `order_items`.
- Uses browser cart prices for the legacy order totals.
- Does not invoke `mec_create_order` or `mec-duitku-create-invoice`.

MEC order creation and invoice creation therefore are not wired into the current checkout. The deployed MEC Create Invoice and callback functions exist, but that does not establish an end-to-end storefront payment flow.

## Live backend observations

- Deployed MEC Edge Functions observed: `mec-duitku-create-invoice` v5 and `mec-duitku-callback` v6, both `verify_jwt=false` with explicit application-level authorization/verification.
- No deployed `mec-duitku-payment-status` function was observed during this audit. This PR is code-only and does not deploy the endpoint.
- MEC tables were empty at audit time, so no live order/payment status path could be exercised.
- A separate live database advisory reported `public.ns_invest` has RLS disabled. This is outside the MEC scope and was not changed; it should be reviewed separately because it may expose that table through Supabase client roles.

## Verification status

- Repository source and branch contents inspected: yes.
- Authorization/rate-limit tests added: yes.
- Deno tests executed: no.
- Type-check/build executed: no.
- Live endpoint tests: no (endpoint not deployed).
- Guest lifecycle verified end-to-end: no.
- Checkout-to-MEC verified end-to-end: no.
- Sandbox payment tested: no.
- Database, secrets, deployment, or merge changed: no.

## Release gates

1. Execute Deno tests and type-check/build; fix failures before review approval.
2. Replace the per-isolate limiter with shared atomic rate limiting before production.
3. Design and implement a trusted MEC order-creation endpoint that generates a cryptographically random guest token, stores only its SHA-256 hash via the restricted RPC, and returns the raw token only to the requesting guest once. Authenticated checkout must derive the user ID from the validated access token, not client-supplied identity.
4. Integrate checkout with the MEC order endpoint and Create Invoice, using server-computed prices and the existing no-auto-retry policy for `unknown`.
5. Verify guest token retention/delivery and access through both Create Invoice and Payment Status API.
6. Run isolated tests for owner/other-user/guest access, duplicate requests, callback handling, unknown timeout, and inventory reservation; then run sandbox-only end-to-end tests after explicit approval.
7. Confirm the real frontend origin before finalizing CORS allowlist.
8. Keep production payments disabled until all release gates pass.
