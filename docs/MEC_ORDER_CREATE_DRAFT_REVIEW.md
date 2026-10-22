# MEC Order Creation — Draft Contract

Status: implementation draft only; not deployed and not connected to a live database.
Branch: `feat/mec-order-idempotency-draft`

## Files in this draft

- `docs/proposed-migrations/20261023_mec_order_idempotency_rate_limit_DRAFT.sql` — proposed additive SQL contract. Deliberately outside `supabase/migrations/` so it is not treated as an applicable migration.
- `supabase/functions/mec-order-create/index.ts` — trusted order-creation endpoint, dependent on the draft SQL RPCs.
- This document — review gates and known constraints.

## Proposed request contract

- `POST /functions/v1/mec-order-create`
- Header `Idempotency-Key`: 16–128 characters, generated once per checkout attempt and reused unchanged on retry.
- Authenticated checkout: `Authorization: Bearer <Supabase access token>`; server derives `p_user_id` from validated Supabase Auth, never from request JSON.
- Guest checkout: `X-MEC-Guest-Token` header. Client should generate a high-entropy random token before the first request and retain it in session-scoped storage along with the idempotency key before sending the request. The endpoint stores only SHA-256(token) in the order and does not return/log the raw token.
- JSON body includes customer name/email/phone and items containing only `product_id` and `quantity`. Client-supplied price, totals, order status, and user ID are not accepted.
- Server canonicalizes item IDs and quantities, computes a request hash, and calls the proposed `mec_create_order_idempotent` RPC. Prices and stock are determined by the existing MEC database routine.
- The endpoint uses the proposed shared atomic limiter RPC for IP and identity buckets. If the limiter is unavailable, it fails closed with 503 before creating an order.

## Response-loss recovery

The client must persist the random guest token and idempotency key before the initial request. On timeout or ambiguous 503, retry the same payload with the same key and token. Do not generate a replacement key/token automatically. If the browser session loses both, do not create a replacement order blindly; provide a reconciliation/support path.

This avoids requiring the server to store or reissue plaintext guest tokens. Browser session storage is still readable by same-origin JavaScript, so XSS prevention remains essential.

## Draft SQL semantics

- `mec_order_idempotency` uniquely binds an idempotency key to a server-computed request hash and resulting order.
- The order row, stock reservation, items, and idempotency record are committed in one database transaction. Concurrent same-key requests wait on the unique constraint; same-key/different-request is rejected.
- Rate limiting uses atomic upsert in a shared PostgreSQL table, keyed only by a server-computed SHA-256 bucket hash. Raw IPs are not stored.
- A cleanup function is provided for rate-limit rows, but a scheduled invocation must be configured and monitored before production. Database-backed rate limiting needs load testing; an external shared limiter may be preferable.

## Blocking review gates

1. **No SQL execution:** validate syntax, object ownership, grants, constraints, and concurrent transaction semantics in a disposable test project first.
2. **RPC privileges:** confirm `SECURITY DEFINER` owner, fixed `search_path`, and service-role-only execution under actual Supabase role behavior.
3. **Limiter semantics:** test threshold, concurrent calls, retry-after accuracy, retention, table growth, and fail-closed behavior.
4. **Request canonicalization:** add automated tests for stable hashes, duplicate item IDs, invalid UUIDs, invalid quantities, idempotency conflicts, authenticated/guest identity scoping, and guest token entropy.
5. **CORS:** `https://asricollection.online` is still only a candidate origin; verify the actual frontend host before deployment.
6. **Existing Create Invoice contract:** frontend must pass order ID, a stable payment idempotency key, and guest token using the already-audited function contract. An order creation retry key and payment attempt idempotency key are different values/scopes.
7. **No payment proof by redirect:** payment return route must use the read-only status endpoint; redirect query parameters are not authoritative.
8. **Sandbox only after explicit approval:** no production payments, deployment, migration, or merge is authorized by this draft.

## Follow-up hardening performed on the draft branch

- All three proposed `SECURITY DEFINER` functions now set an empty `search_path`; referenced application tables/functions are schema-qualified.
- The shared limiter explicitly rejects NULL window, request-limit, and retention parameters.
- Limiter window comparisons and retry-after calculation use fresh wall-clock timestamps rather than relying solely on a timestamp captured before a possible row-lock wait.
- The Edge Function rejects declared or streamed request bodies larger than 32 KiB before JSON parsing.

These are draft-only code changes. They do not prove function ownership/grants are safe in the target database, nor do they establish SQL correctness or concurrency behavior.

## Verification status

- Deno type-check passed in GitHub Actions run [39844566944](https://github.com/gantulu/modern-ecommerce/actions/runs/39844566944) for the latest Edge Function changes at that run's commit.
- SQL syntax/runtime validation and concurrent transaction tests: not run.
- Live Edge Function test: not run.
- Checkout or guest-token end-to-end: not implemented/verified.
- Frontend production origin remains unverified; no deployment authorized.
