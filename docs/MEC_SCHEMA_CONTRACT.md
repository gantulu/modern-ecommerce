# MEC E-commerce V1 — Schema Contract

## Scope and isolation
- All new commerce tables use the `mec_` prefix. Existing tables, views, functions, triggers, policies, and deployed Edge Functions must remain untouched.
- This contract is additive and intended for the `gantulu/modern-ecommerce` project.
- Currency is IDR; monetary values are integer rupiah stored as `bigint`.
- Shipping and discounts are deferred from V1.
- Guest and authenticated checkout are supported.
- Inventory is reserved atomically at order creation by decrementing available `mec_products.stock_quantity`. A release restores quantities once only.
- Every Duitku payment attempt is a separate `mec_payments` row. A timeout must become `unknown`; do not automatically create a replacement attempt until reconciliation.
- This migration file is not applied to any database by committing it to GitHub.

## Tables
| Table | Purpose | Important constraints |
|---|---|---|
| `mec_categories` | New product categories | unique slug, active flag |
| `mec_products` | New catalog and available stock | unique slug, non-negative integer price/stock |
| `mec_product_images` | Product images by Storage path | FK to product, unique path per product |
| `mec_orders` | Guest/auth order and reservation lifecycle | unique order number, IDR totals, reservation state, guest token hash required for guests |
| `mec_order_items` | Immutable purchase snapshots | product name/price snapshots; line total generated from price × quantity |
| `mec_payments` | One record per Duitku attempt | unique merchant order ID and idempotency key; explicit `unknown` state |
| `mec_payment_events` | Callback/event audit and deduplication | unique logical event fingerprint, signature validity and processing state |

## Transaction contract
1. Trusted Edge Function validates request shape and creates a cryptographically random guest token; store only its hash.
2. Edge Function calls `mec_private.create_order` with the token hash, server-verified user ID (if authenticated), and requested product IDs/quantities. Client prices and totals are ignored.
3. The RPC locks product rows in deterministic order, validates active products and stock, computes prices from the database, decrements stock, then inserts order and snapshots in the same transaction. Any failure rolls back all changes.
4. Create a distinct `mec_payments` row per payment attempt. Use the exact current official Duitku POP Create Invoice signing contract; do not use browser redirects as authoritative payment status.
5. Callback handler verifies the official signature and matches merchant order ID and amount before updating payment/order state. It records callback events idempotently and acknowledges only after durable processing.
6. A reservation release operation is idempotent and must not restore stock while any related payment is paid, pending, requesting, or unknown.
7. Expiration/cancellation jobs must first reconcile unknown payments; they must not blindly release inventory based only on local expiry.

## Access model
- Anonymous and authenticated users can read active MEC catalog rows only.
- Authenticated users can read their own orders, order items, and payments.
- Guest order retrieval must be implemented through a trusted endpoint that verifies the raw guest token against `guest_token_hash`; no public table policy exposes guest orders.
- Writes to order, inventory, payment, and event data are server-only via service-role Edge Functions and restricted internal RPCs.
- Raw callback payloads may contain personal/payment metadata; retain only necessary fields and restrict access.
- The migration adds no policies or grants to legacy tables and does not modify existing Edge Functions.

## Status contracts
- Order: `pending_payment`, `confirmed`, `processing`, `shipped`, `completed`, `cancelled`.
- Inventory reservation: `reserved`, `released`, `consumed`, `not_reserved`.
- Payment: `created`, `requesting`, `pending`, `paid`, `failed`, `expired`, `cancelled`, `unknown`.
- A verified paid state must not be downgraded by a later failure callback.

## Required verification before production
- Apply only to a disposable/local development database first.
- Test concurrent checkout for the same last item, duplicate items in one request, insufficient stock rollback, and repeated reservation release.
- Test guest token entropy/hash comparison, RLS/grants, callback signature and amount/order matching, duplicate callback handling, and paid-state monotonicity.
- Confirm the Duitku inquiry/status endpoint applies to the exact POP merchant/product configuration before using it for reconciliation.
- Confirm callback response requirements and status-code semantics against the current official Duitku POP documentation.
