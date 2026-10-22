# MEC Checkout Integration Contract — Design Gate

Status: design/audit only; no migration or live database change.
Branch: `feat/mec-payment-status-api-v1`
Date: 2026-10-23

## Verified source contract

Source inspected:
- `supabase/migrations/20261022180316_create_mec_ecommerce_v1.sql`
- `supabase/functions/mec-duitku-create-invoice/index.ts`
- `src/pages/Cart.tsx`
- `src/store/authStore.ts`
- `src/store/cartStore.ts`

The current `public.mec_create_order` signature accepts customer fields, `p_items`, `p_user_id`, `p_guest_token_hash`, and reservation minutes. Execution is granted only to `service_role`. Its underlying `mec_private.create_order` recalculates price from active product rows, reserves inventory with product row locks, inserts order/items atomically, and requires a hash for guest orders.

The current order schema has no order-creation idempotency key or uniqueness constraint. The payment table has a unique `idempotency_key`, but that only protects payment attempts, not order creation or inventory reservation.

The existing Cart checkout writes to legacy `orders` / `order_items`, computes totals from browser cart prices, requires sign-in, and does not call MEC order creation or Create Invoice.

The existing Create Invoice function accepts the order ID and idempotency key; authenticated orders require an access token. Guest orders require the raw guest token in request JSON and compare its SHA-256 hash to `mec_orders.guest_token_hash`.

## Required guest token lifecycle

1. Trusted order-creation endpoint generates 32 random bytes using Web Crypto.
2. Endpoint stores only SHA-256(token) through the service-role-only order RPC.
3. Raw token is returned only in the successful response to the same guest request; it must never be written to logs, query parameters, analytics, or persistent database columns.
4. Frontend retains the token only as long as needed to invoke Create Invoice and read payment status; session-scoped storage is preferable to long-lived local storage.
5. Both Create Invoice and Payment Status API validate the token against the stored hash.
6. If the response is lost after order creation, a new order must not be created blindly; the client needs a safe idempotent recovery contract.

## Blocking contract gaps before implementation

### 1. Order creation is not idempotent

The existing RPC creates a new order and reserves inventory on each call. A browser retry, timeout, or duplicate click can create multiple orders and reserve stock repeatedly. A frontend-only button lock does not solve retries or concurrent requests. Payment idempotency does not solve this earlier transaction.

A safe implementation requires an additive database contract that atomically associates a client idempotency key with the resulting order and returns the existing order on replay, while rejecting key reuse with different request content. This likely requires an order idempotency table or columns plus a transactionally enforced RPC. No such schema change has been applied or included by this audit.

### 2. Guest token response-loss recovery

If the database commits the order but the response carrying the raw guest token is lost, the server has only the hash and cannot reissue the original token. The idempotent recovery design must explicitly handle this without storing plaintext tokens. Options include a one-time encrypted token envelope with a narrowly scoped key-management design, or a recovery protocol that avoids needing the raw token to be reissued. Do not choose one without security review.

### 3. Customer details

MEC order creation requires customer name, email, and phone. Auth state currently exposes profile fields, but checkout does not collect/validate the full MEC customer contract. The frontend must collect missing values and validate them before submitting. The server must derive authenticated `p_user_id` from the validated bearer token, never from request JSON.

### 4. Shared rate limiting

The current status endpoint's in-memory limiter is not distributed. A production-ready shared atomic limiter also requires a server-side shared store or external service. No DB schema/RPC for rate limiting has been approved or added.

### 5. CORS

`https://asricollection.online` is still only a candidate origin; verify the actual production frontend origin before deployment. Do not deploy with an assumed origin.

## Recommended implementation sequence after design approval

1. Approve a narrowly scoped additive migration/RPC design for order idempotency and any shared rate-limit storage (or select an external rate-limit service).
2. Implement and test the trusted MEC order-creation Edge Function on a separate branch. Keep the service-role key server-only.
3. Add tests for concurrent duplicate order requests, idempotency-key conflict, token generation/hash, response-loss recovery, invalid identity, and stock reservation.
4. Integrate Cart to MEC order creation then Create Invoice; do not clear cart until a confirmed order/invoice response is safely handled.
5. Integrate PaymentReturn with the read-only status endpoint, passing guest token in a header/body as designed, never URL parameters.
6. Verify all tests/build and run Sandbox-only end-to-end checks after explicit approval.

No migration has been applied, no secrets were read or changed, and no function has been deployed.
