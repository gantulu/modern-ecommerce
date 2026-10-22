# MEC Catalog Contract Alignment (provisional)

## Locked source boundary — owner decision

**MEC may use only tables whose names begin with `mec_` as operational data sources.** This is a hard scope constraint.

- MEC product/category reads, storefront queries, cart identity, checkout validation, pricing, stock, and order creation must use MEC-prefixed tables only.
- `public.products`, `public.applestore`, Google Sheets, and other non-`mec_` tables/systems are out of scope as MEC data sources. Do not join them, read them for live MEC behavior, copy/import their rows, or derive MEC prices/stock from them.
- The live `mec_products` and `mec_categories` tables are empty. That means the MEC-native catalog still needs an explicitly approved population plan; it does **not** authorize fallback to a non-MEC source.
- Current frontend code that queries `public.products` is a contract violation to fix in a separately reviewed code change. Do not silently switch to another legacy table.
- Non-MEC tables may be mentioned only as read-only audit evidence explaining existing mismatches, never as a proposed operational source.


Status: **MEC-only frontend contract implemented in this branch; native catalog population, storage bucket provisioning, and product activation remain pending. No catalog migration is authorized or included.**

## Purpose

Define the boundary between the storefront, MEC order creation, and Duitku POP while the authoritative commercial catalog is still being verified. This document is a contract for the next implementation phase, not approval to import data or activate checkout.

## Evidence-backed current state

- Frontend Product type in src/types/supabase.ts expects id, name, description, numeric price, image_url, category, stock, and created_at.
- The original storefront query read `public.products`; this feature branch replaces catalog reads in Products, Categories, and Featured Products with a shared MEC-only query over `mec_products`, `mec_categories`, and `mec_product_images`.
- Product cards and Quick View now format MEC `price_idr` as whole IDR, matching the cart estimate formatter.
- Product price filters now derive their maximum from active MEC product `price_idr` values and display IDR.
- Cart checkout sends only product_id and quantity to mec-create-order; the client total is display-only. The Edge Function requires UUID-shaped product IDs and calls mec_create_order_idempotent.
- MEC order creation reads MEC product data server-side. public.mec_products.id is UUID and its payable price field is price_idr bigint; inventory field is stock_quantity integer. Order items preserve a product-name and unit-price snapshot. These are the intended server-side checkout fields, not a mapping approval for any legacy table.
- Live public.products has one feed-shaped row with item_group_id, title, currency, inventory_quantity, and nested sizes[].price strings. The sample includes strings such as 12000000.00 IDR, but its product URL is an example.com placeholder and there is no normalized top-level price/frontend id contract.
- Live public.applestore has 222 rows and text IDs, with integer price / sale_price, category, availability, and quantity_to_sell_on_facebook. All observed sale prices are below base prices; no source documentation currently establishes currency/unit, sale-price eligibility, or whether the Facebook quantity is the authoritative sellable inventory.
- Live MEC product and category tables are empty. MEC product IDs are UUIDs; the candidate applestore.id values are text.

## Canonical contract to preserve

### Storefront product view

The UI may display a normalized product view with:

| Field | Contract |
|---|---|
| id | Stable MEC product UUID, also used as the cart/order product ID |
| name | Display title |
| description | Description; nullable source values must be normalized explicitly |
| price | Integer whole-IDR amount for display only; source conversion must be verified |
| image_url | Valid remote URL or an explicitly mapped Storage URL; do not label arbitrary URLs as Storage paths |
| category | Canonical display category sourced from a documented mapping |
| stock | Nonnegative sellable quantity derived from the verified inventory source |
| created_at | MEC/catalog timestamp or a documented source timestamp |

The TypeScript UI type can remain a presentation model, but the source query, currency formatting, filters, product cards, cart, and checkout must all agree on the unit. Do not use the UI price value as payment authority.

### MEC database / checkout

- mec_products.id is the stable UUID consumed by the cart and order RPC.
- mec_products.price_idr is the server-authoritative unit price in whole IDR.
- mec_products.stock_quantity is the server-authoritative sellable stock quantity only after the source stock semantics are verified.
- mec_products.category_id references mec_categories.id; source category labels require a deterministic mapping.
- Order creation accepts product UUIDs and positive integer quantities only. It reads current MEC prices/stock under the existing database transaction/locking rules; it must not trust browser price, total, title, category, or stock.
- mec_order_items snapshots product name and unit price at order time. Duitku paymentAmount must be derived from the persisted order amount and its item details must reconcile to that same amount.
- Keep MEC product UUIDs stable. No legacy source mapping/import is permitted under the locked source boundary.
- Product price conversion must be deterministic, lossless, positive, and tested. No implicit rounding or unit assumptions.
- Keep order/payment state transitions and stock reservation on the server/database; the client return URL is not payment confirmation.

## Explicitly unresolved — do not implement assumptions

1. Authoritative catalog source: public.products, public.applestore, or another source.
2. Price currency and unit for every selected source field and variant. The embedded IDR text in one feed-shaped row is evidence about that row only; it does not define the whole source or resolve which table is authoritative.
3. Price selection: base price versus sale price, and the effective-date / eligibility rules.
4. Sellable stock: source field and semantics; whether inventory is global stock, feed quantity, or channel-specific quantity.
5. Variant handling: whether sizes / colors represent distinct purchasable SKUs and how variant identity is passed to the cart/order.
6. Category mapping and stable source-ID provenance.
7. Image URL provenance and whether remote images can be used directly.
8. Storefront currency display and price filter ranges.

## Gate before catalog schema changes

The initial catalog population mechanism is controlled manual entry of owner-supplied values directly into `mec_categories`, `mec_products`, and `mec_product_images`. Do not read, join, copy, sync, or import from any non-`mec_` table or external catalog feed. Do not draft/apply schema migrations or create catalog rows as part of this documentation/code change. Promotion schema and storage-bucket provisioning require separate review.

## Acceptance criteria

- One named source of truth and documented currency/unit are confirmed.
- Sale-price and variant-selection rules are explicit.
- Sellable stock field and reservation behavior are confirmed.
- Stable source-ID-to-MEC-UUID mapping is deterministic and collision-safe.
- Storefront, cart, and server use the same product UUID and a consistent currency presentation contract.
- Server totals and Duitku item details reconcile exactly in whole IDR.
- Remote image handling and category mapping are documented.
- Preflight counts/samples, dry-run mapping results, duplicate checks, SQL validation, concurrency tests, and sandbox payment tests are ready before rollout.


## Out-of-scope audit evidence — not an MEC source

A follow-up read-only search found catalog display configuration in [gantulu/oktavia/app/all.json](https://github.com/gantulu/oktavia/blob/2a3162afc5dd8e148a96b9a5f7bcfbc6ae3cc04f/app/all.json) and [app/home/flashSale.json](https://github.com/gantulu/oktavia/blob/2a3162afc5dd8e148a96b9a5f7bcfbc6ae3cc04f/app/home/flashSale.json). It reads a Google Sheet through OpenSheet and displays sale_price as primary when present, otherwise price; it also transforms quantity_to_sell_on_facebook using minMax(1, 99). This is evidence of a separate storefront only. Under the locked source boundary above, the related sheet/configuration must not feed MEC behavior and must not be imported into MEC. It does not establish currency/unit or real sellable stock.

The one live public.products sample includes a 128GB sale effective interval of 2026-04-01 through 2026-04-10, which has expired as of 2026-10-23. Do not use that sample's sale price as current checkout price without a verified effective-date policy.

The contract remains blocked pending confirmation of the MEC-native catalog population method, price/unit semantics, promotion eligibility/date handling, and authoritative sellable stock. No catalog migration or non-MEC import is authorized.
