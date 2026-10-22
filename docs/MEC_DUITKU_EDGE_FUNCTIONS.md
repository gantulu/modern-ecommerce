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

## Audit update — 2026-10-23 (read-only target verification)

Target: Supabase project `No signal` (`oszqantvugvbvydlizix`), PostgreSQL 17.6.

### Verified live state

- The seven MEC tables `mec_products`, `mec_categories`, `mec_product_images`, `mec_orders`, `mec_order_items`, `mec_payments`, and `mec_payment_events` each contained **0 rows** at audit time.
- The target database exposes `mec_create_order` and `mec_release_order_inventory`, with execution granted to `service_role` but not to `anon` or `authenticated`.
- The deployed `mec_process_duitku_callback` RPC is owned by `postgres`, is `SECURITY DEFINER`, fixes `search_path=pg_catalog, public`, and is executable by `service_role` only.
- The target database does **not** expose the proposed `mec_create_order_idempotent` RPC. PR #4's order-idempotency SQL remains a draft dependency and has not been applied.
- Read-only inspection did not identify a MEC payment-status lookup/reconciliation endpoint. No new status endpoint or reconciliation worker is implemented in this branch at this point.

### Payment-state and callback assessment

The branch Create Invoice function checks that an order is `pending_payment` with inventory `reserved`, derives the amount from `mec_orders.total_amount`, reconciles order-item line totals, and blocks new attempts when an existing attempt is `created`, `requesting`, `pending`, `unknown`, or `paid`. A unique-constraint conflict is handled without deliberately sending a second provider request. These are code-level findings only; the proposed partial unique index is not installed in the target database.

The callback RPC contract and prior rolled-back synthetic SQL test provide evidence for atomic event deduplication, row locking, amount validation, paid-state protection, and the late-success-after-reservation-release anomaly path. They do **not** prove live Duitku Sandbox behavior. A return redirect is not payment authority.

### Still unverified / blocking

- End-to-end Sandbox Create Invoice and signed callback, including actual provider request/response and signature interoperability.
- Duplicate and reordered callbacks, invalid signature, amount mismatch, failure after success, provider timeout/unknown outcome, and success after reservation release.
- Read-only payment status lookup and a documented reconciliation mechanism for `unknown`; until implemented, `unknown` must remain blocking and must not trigger automatic replacement attempts.
- Target-schema validation of the payment-attempt partial unique index and realistic concurrent insert behavior.
- Effective grants/ownership for the proposed order-idempotency RPC, which does not exist in the target schema.
- Frontend return route and actual CORS origin.

No live SQL, catalog data, secrets, Edge Functions, payment requests, or deployment were changed during this audit. PR #4 and PR #5 remain drafts.

## Cross-PR order and inventory verification update — 2026-10-23

- PR #4 remains the canonical order-idempotency contract; the current head is still a draft and the proposed RPC/table are absent from the live target database.
- PR #4 expanded disposable CI to apply the actual MEC schema migration and test the actual `mec_private.create_order` routine: same-key replay, same-key conflict, rollback after stock decrement/order-item insertion, same-key retry, two different keys competing for the last stock unit, and idempotent inventory release. SQL run [39868701615](https://github.com/gantulu/modern-ecommerce/actions/runs/39868701615) and Deno run [39868701695](https://github.com/gantulu/modern-ecommerce/actions/runs/39868701695) passed.
- This is stronger transaction evidence than the previous simplified fixture, but it is still disposable PostgreSQL, not a test against live data or proof of Supabase default privileges. Remaining transaction cases include overlapping multi-product lock/deadlock behavior and the callback-success vs reservation-release race.
- PR #5's payment-attempt partial unique index remains draft-only. Its previous disposable CI passed the partial-index semantics and two concurrent different-key inserts; the new PR #4 order/inventory tests do not install the payment index in the live database or prove payment provider behavior.
- Step 2 outcome: order creation and inventory decrement are atomic in the actual MEC routine and are now covered by schema-based disposable tests. Step 3 remains blocked on a verified payment status/inquiry contract and reconciliation path for `unknown`; no replacement attempt should be created automatically.
- No live migration, deployment, secret change, payment submission, or merge was performed. PR #5 remains draft.


## Frontend validation CI added — 2026-10-23

- Added a draft-branch GitHub Actions job to run `npm ci --ignore-scripts`, `npm run build` (TypeScript check + Vite production build), and `npm run lint` for the checkout/catalog frontend.
- First run [39869101344](https://github.com/gantulu/modern-ecommerce/actions/runs/39869101344) confirmed the production build passes but exposed a pre-existing ESLint 9 incompatibility: the lint script passed removed `--ext` and the config mixed legacy and flat-config syntax. The script and config were corrected on the draft branch; rerun [39869317064](https://github.com/gantulu/modern-ecommerce/actions/runs/39869317064) is in progress, so lint is not yet considered passed.
- The existing Deno checks for `mec-create-order` and `mec-duitku-create-invoice` passed in the first workflow. `npm ci` also reported 38 dependency vulnerabilities (4 low, 6 moderate, 28 high); no dependency upgrades or `npm audit fix` were run. The payment-attempt SQL test workflow is separate.


## Step 3 — payment status and reconciliation contract audit

- Official Duitku POP documentation: https://docs.duitku.com/pop/id/
- The POP Create Invoice response includes a `reference` that the merchant should persist; the POP HTTP callback carries `merchantOrderId`, `amount`, `resultCode`, `reference`, and HMAC-SHA256 signature material.
- POP documentation explicitly warns not to use the redirect query parameter `resultCode` to update payment state because the URL can be manually changed by the customer. The HTTP callback, after signature and amount validation, remains the authoritative automated status signal.
- The POP API reference reviewed for this audit does not document a POP transaction Inquiry Status endpoint. Other Duitku products (for example Disbursement or SNAP) expose different inquiry APIs and must not be assumed compatible with POP.
- Therefore, do not invent an inquiry URL, request signature, response schema, or cron-based reconciliation API. For an unresolved Create Invoice outcome (`unknown`), keep the attempt blocking and use callback evidence or an explicitly approved merchant-dashboard/manual support process until Duitku confirms a supported POP inquiry contract.
- Step 3 implementation remains blocked on official confirmation of a supported POP status inquiry/reconciliation mechanism and the frontend order/payment status endpoint contract. No payment attempt or live change was made.


## Verification follow-up — lint, dependencies, and POP reconciliation (2026-10-23)

### Frontend lint
- The last completed frontend run, [39869471623](https://github.com/gantulu/modern-ecommerce/actions/runs/39869471623), passed TypeScript + Vite production build but failed lint with nine existing findings: unused caught error in `scripts/deploy.js`; unused signup response binding and an explicit `any` catch in `src/pages/Auth.tsx`; three unused icon imports in `src/pages/Sitemap.tsx`; and three explicit `any` types in `src/store/authStore.ts`.
- The draft branch has now removed the unused bindings/imports and replaced `any` with typed/unknown-safe error handling. A fresh CI run is required before calling lint clean.

### Dependency findings
- The previous `npm ci` output reported 38 audit findings: 4 low, 6 moderate, and 28 high. This is a count, not yet a reviewed package-by-package assessment.
- Added a CI report step that runs `npm audit --json` and emits severity, direct/transitive classification, affected range, and fix availability without running `npm audit fix`, changing package versions, or rewriting the lockfile. The exact package-level report must be reviewed from the new run before deciding on minimal updates.

### Verified POP reconciliation contract
- Official POP reference: https://docs.duitku.com/pop/id/
- Create Invoice is HTTP POST to the documented sandbox endpoint `https://api-sandbox.duitku.com/api/merchant/createInvoice` (production endpoint is documented separately). Its response contains `reference`, `paymentUrl`, `statusCode`, and `statusMessage`; persist `reference` for tracing. Duitku warns that requests for the same order ID may return the same response for five minutes and that repeated Create Invoice requests can return HTTP 409 while a transaction is in progress. This supports keeping `unknown` attempts blocking and not blindly retrying.
- Callback is HTTP POST `application/x-www-form-urlencoded`. The documented signature is HMAC-SHA256 of `merchantCode + amount + merchantOrderId`, keyed with the merchant API key. Callback delivery can be retried when HTTP 200 is not received (documentation states up to five attempts); return HTTP 200 only after durable processing or durable anomaly recording.
- Redirect/JS callback `resultCode` is for user-facing feedback only and must not change stored payment state. Use the signed server-to-server HTTP callback as the provider status signal.
- The reviewed POP reference does not document a POP transaction-status inquiry endpoint. Do not invent one or substitute a Disbursement/SNAP endpoint. For `unknown`, retain the blocking state and reconcile from a valid callback, Duitku dashboard/report + provider-supported resend, or a documented merchant support procedure. Obtain written provider confirmation before implementing an automated inquiry job.
- No Sandbox payment test has been started. It remains gated on explicit authorization.


### CI status snapshot — 2026-10-23
- Fresh checkout workflow: [39869943212](https://github.com/gantulu/modern-ecommerce/actions/runs/39869943212) is in progress. Its frontend job includes the new dependency audit report and reruns build + lint; do not treat either the lint or package-level audit as complete until the workflow finishes.
- Payment-attempt guard workflow: [39869942992](https://github.com/gantulu/modern-ecommerce/actions/runs/39869942992) is in progress.
