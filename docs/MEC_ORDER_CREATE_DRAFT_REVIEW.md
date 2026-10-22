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

1. **Disposable CI validation passed; target-project validation remains blocking:** the latest GitHub Actions run applied this draft SQL to a disposable PostgreSQL 16 service and passed the SQL contract smoke tests plus concurrent idempotency/rate-limit tests. This does not validate the real Supabase schema, object owners, default privileges, service-role grants, or production-like load.
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

## Verification status — latest CI evidence

- SQL workflow [39860380323](https://github.com/gantulu/modern-ecommerce/actions/runs/39860380323): **passed** on a disposable PostgreSQL 16 service. It created a simplified fixture, applied the draft SQL, passed smoke tests for same-key replay, one-order persistence, same-key/different-request rejection, and NULL limiter-window rejection, then passed concurrency checks for two simultaneous same-key calls and 40 concurrent limiter calls with exactly 20 admitted.
- Deno workflow [39860380403](https://github.com/gantulu/modern-ecommerce/actions/runs/39860380403): **passed** for the draft Edge Function type-check.
- Test scope limitation: the PostgreSQL fixture is deliberately simplified and is not the live MEC schema. These runs do not prove actual Supabase object ownership/default privileges, target-project RPC access controls, real order/stock semantics, production load behavior, or end-to-end integration.
- Live Edge Function test: not run.
- Checkout or guest-token end-to-end: not implemented/verified.
- Duitku Sandbox payment, callback, status, and reconciliation E2E: not run.
- Frontend production origin remains unverified; no migration, deployment, or merge is authorized.

## Additional security and test findings

- **RPC ownership/grants:** explicit REVOKE/GRANT statements exist in the draft, but CI does not assert effective privileges for `anon`, `authenticated`, and `service_role`, nor does it verify the actual function owner. Add role-level assertions against a Supabase-like fixture and verify ownership/default privileges in the target project before promotion.
- **Order idempotency:** current CI proves the happy-path concurrent same-key replay and a conflicting request hash. It does not cover concurrent same-key/different-hash races, rollback/retry after an injected failure, guest-vs-user identity scoping, canonical hash stability, duplicate item IDs, malformed UUIDs/quantities, or order/stock rollback atomicity.
- **Rate limiter:** current CI proves the exact admission count for one fresh bucket under 40 concurrent calls. It does not cover window rollover, retry-after near the boundary, NULL/invalid max and retention parameters, bucket cleanup, row-growth behavior, or load/fail-closed behavior through the Edge Function. The cleanup DELETE is unbounded; production retention needs a bounded/batched strategy and a monitored schedule.
- **Shared limiter side effect:** the Edge Function consumes the IP bucket before the identity bucket. Requests denied by the second bucket still consume the first bucket; verify that this is the intended policy and test denial behavior.
- **Release remains blocked:** do not promote the SQL into supabase/migrations/, deploy the function, connect frontend checkout, run payment tests, or merge until these gates and the separate checkout/Duitku E2E gates are complete.


## Cross-PR checkout and Duitku integration audit (read-only)

- **Order-idempotency contract aligned in the PR #5 draft branch; CI verification pending.** PR #4 remains the canonical contract: `mec_create_order_idempotent(text, text, text, text, text, jsonb, uuid, text, integer)`, using a server-computed request hash and `mec_order_idempotency`. PR #5's checkout Edge Function now computes the same canonical request hash and calls this nine-argument RPC; the competing `p_checkout_idempotency_key` overload and `mec_orders.checkout_idempotency_key` migration were removed from `supabase/migrations/`. The canonical SQL is still draft-only and has not been applied to any database.
- **Live checkout deployment remains absent.** The connected Supabase project has the MEC catalog/order/payment schema and active `mec-duitku-create-invoice` / `mec-duitku-callback` functions, but no `mec-create-order` or `mec-order-create` Edge Function. The live `mec_orders` table has no `checkout_idempotency_key` column, and no `mec_order_idempotency` table exists. PR #4's canonical idempotency SQL and PR #5's payment-attempt guard remain proposed drafts. No deployment or migration was performed.
- **MEC-only source boundary:** PR #5's catalog helper reads `mec_products`, `mec_categories`, and `mec_product_images`; Cart sends product IDs and quantities and labels its total as a display estimate. Live MEC catalog tables currently contain zero rows. The `mec-products` Storage bucket is absent. No non-`mec_*` source may be used as a fallback or import source. The schema currently defaults `mec_products.is_active` to true, so controlled catalog entry must explicitly insert inactive products until owner verification, or the default must be separately reviewed.
- **Create Invoice concurrency guard drafted; CI semantics test passed, production-like proof remains open.** PR #5 proposes a partial unique index over `mec_payments(order_id)` for `created/requesting/pending/unknown/paid`; its disposable SQL test passed in [run 39864130533](https://github.com/gantulu/modern-ecommerce/actions/runs/39864130533). The Create Invoice Edge Function handles unique conflicts by rereading the existing attempt and does not issue another provider request for a losing concurrent insert. The disposable test proves the partial-index concurrency behavior in its fixture only; it does not prove the draft index against the live MEC schema or replace Sandbox end-to-end tests. Same-key concurrent insert conflicts should recover by re-reading the existing attempt rather than returning an opaque error.
- **Reconciliation is not implemented:** the repository's Duitku contract states there is no POP-specific inquiry/reconciliation job, and no payment-status/reconciliation Edge Function was found in the live MEC function set. Unknown Create Invoice outcomes must remain non-retryable until a verified provider inquiry/manual reconciliation process exists; do not create replacement invoices automatically.
- **Duitku signature contract matches current official docs:** Create Invoice uses HMAC-SHA256 over `merchantCode + timestamp`; callback validation uses HMAC-SHA256 over `merchantCode + amount + merchantOrderId`. The callback RPC is owned by `postgres`, uses a pinned search path, and effective execution is denied to `anon`/ `authenticated` and allowed to `service_role`. Callback state changes are transactional and duplicate events are fingerprint-deduplicated. Still required: Sandbox E2E for invalid signature, amount mismatch, duplicate/reordered callbacks, failure-after-success, and success after reservation release.
- **Payment return is not authoritative:** the official Duitku docs explicitly say not to update payment state from redirect query parameters. A read-only status endpoint and a reconciliation process remain release gates.

## Audit update — 2026-10-23

### Live target-project evidence (read-only)

- The connected Supabase project is **No signal** (`oszqantvugvbvydlizix`), PostgreSQL 17.6.
- The live schema contains MEC catalog/order/payment/event tables, but it does **not** contain the proposed `mec_order_idempotency` table or `mec_create_order_idempotent(...)` RPC. The proposed contract cannot yet be validated against the target schema.
- Live `mec_create_order` and `mec_release_order_inventory` are executable by `service_role`, not by `anon` or `authenticated`. The deployed `mec_process_duitku_callback` is owned by `postgres`, is `SECURITY DEFINER`, has fixed `search_path=pg_catalog, public`, and is executable by `service_role` only. These findings apply to the existing callback RPC, not the proposed order-idempotency RPC.
- All seven queried MEC catalog/order/payment/event tables contained zero rows at audit time. No live write was performed.

### Additional disposable SQL coverage added

- Simulate an exception inside the order creator and assert the idempotency claim/order insert roll back together.
- Retry the same key after the failed transaction and assert a new order can be created.
- Assert effective RPC EXECUTE privileges deny `anon` and `authenticated` while allowing `service_role`.
- Assert the fixture RPC owner and empty `search_path` configuration.

**CI rerun passed**: [SQL contract + concurrency run 39867476942](https://github.com/gantulu/modern-ecommerce/actions/runs/39867476942) and [Deno type-check run 39867476958](https://github.com/gantulu/modern-ecommerce/actions/runs/39867476958). The fixture remains simplified and does not exercise actual MEC stock locks, row-level security, target-project default privileges, or real Supabase API role behavior. Do not infer production readiness from this fixture.

## Final contract audit — 2026-10-23

### Findings and changes

- **Canonical RPC contract confirmed:** `mec_create_order_idempotent(text,text,text,text,text,jsonb,uuid,text,integer)` remains the single proposed order-idempotency contract. PR #5's authenticated checkout sends the same nine named arguments and computes SHA-256 over normalized customer data, authenticated-user scope, and sorted/merged product UUID + quantity pairs. The live database still has no idempotency table/RPC; this contract is not live.
- **Atomicity boundary confirmed at code level:** the idempotency claim, call to `mec_private.create_order`, and assignment of `order_id` occur inside one PostgreSQL function transaction. A thrown exception rolls back the key claim together with order and inventory changes performed by the called routine. The latest draft CI changes now apply the repository's real MEC schema migration to disposable PostgreSQL, seed test products, inject a failure after stock decrement, and assert rollback plus same-key retry; the new CI result is pending.
- **Least-privilege hardening applied to this draft branch:** removed direct `service_role` CRUD grants on `mec_order_idempotency` and `mec_private.rate_limit_buckets`. The intended boundary is `service_role` EXECUTE on the three `SECURITY DEFINER` RPCs; backing tables should not also be directly exposed to the service client. Added fixture assertions for the RPC grants and absence of direct backing-table grants.
- **Fixed search path:** all three proposed `SECURITY DEFINER` RPCs set an empty `search_path`; referenced functions and tables in their bodies are schema-qualified. The target owner/effective privileges cannot be proven until the proposed SQL is applied to an approved disposable Supabase-like target.
- **Concurrency evidence:** existing disposable tests cover same-key replay, same-key/different-hash rejection, two concurrent same-key calls resolving to one order, rollback/retry, RPC grants, and 40 concurrent rate-limit calls. The latest draft CI adds two different keys competing for the final stock unit against the real MEC create-order routine; its CI result is pending. Same-key/different-hash concurrency races and production Supabase role setup remain unverified.
- **Known contract limitation:** idempotency key is globally unique, while the request hash includes identity scope. Reuse by a different identity is rejected as a payload conflict and does not return the other identity's order, but a key collision can cause a denial/conflict. This is safe against cross-identity replay but should remain an explicit client contract: generate high-entropy keys and never share them across checkout identities.
- **Target schema compatibility:** read-only target inspection confirms `mec_private.create_order(text,text,text,jsonb,uuid,text,integer)` exists and locks product rows in deterministic UUID order, validates active status and stock, derives price from `mec_products.price_idr`, creates order/items, and decrements stock within the same transaction. Target has no proposed idempotency RPC/table. All seven inspected MEC tables were empty at audit time.

### Step 1 decision

**Contract shape accepted for continued draft development; production approval withheld.** The table grants were tightened and corresponding fixture assertions added. Remaining blockers: run CI on the latest commits; expand the fixture to model inventory/order-item rollback and competing checkout payloads; verify actual ownership/default privileges and RPC execution in an approved Supabase-like environment; and do not apply to the live project without separate authorization.

## Step 2 — checkout and inventory transaction audit (started automatically)

### Verified transaction properties

- The live `mec_private.create_order` routine obtains `FOR UPDATE` locks on distinct product rows in deterministic product-ID order before checking stock and pricing.
- It validates that every requested product exists, is active, and has enough stock; calculates subtotal from database-owned `mec_products.price_idr`; inserts the order; decrements stock; and inserts order-item snapshots in the same database transaction.
- The PR #4 idempotency wrapper calls that routine and writes the idempotency-to-order link in the same surrounding transaction. A failure at any point should roll back all these database changes.

### Step 2 gaps still blocking approval

- New disposable CI now applies the real MEC schema migration and tests the real product row locks, inventory decrement, order-item insert, and rollback after an injected order-item failure. Its latest run is pending; it still does not test inventory release/restock idempotency or the payment callback race.
- Disposable CI now includes deterministic tests for two different idempotency keys competing for the final stock unit and a failure after stock decrement/order-item insertion proving rollback. A release-twice assertion also verifies that stock is restored once only. The latest CI run for these additions is pending.
- Still need a concurrent overlapping multi-product cart test for deadlock resistance and a payment-success callback racing reservation expiry/release test proving the anomaly is recorded rather than silently restoring or consuming stock twice.
- The target catalog is empty, so live checkout behavior cannot be functionally exercised with current data. No live writes or payment attempts are authorized.

Next branch-only work is to extend disposable transaction tests and document their scope. Step 3 (payment state/reconciliation) remains dependent on these transaction results and the missing status/inquiry contract.
