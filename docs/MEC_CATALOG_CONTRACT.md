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
| price | Integer whole-IDR amount mapped directly from `mec_products.price_idr`; display only |
| image_url | Public URL generated from `mec_product_images.storage_path` in the dedicated `mec-products` bucket, or the local placeholder until the bucket is provisioned |
| category | `mec_categories.name` joined by `mec_products.category_id` |
| stock | Nonnegative available-to-sell quantity mapped from `mec_products.stock_quantity` |
| created_at | MEC/catalog timestamp or a documented source timestamp |

The TypeScript UI type can remain a presentation model, but the source query, currency formatting, filters, product cards, cart, and checkout must all agree on the unit. Do not use the UI price value as payment authority.

### MEC database / checkout

- mec_products.id is the stable UUID consumed by the cart and order RPC.
- mec_products.price_idr is the server-authoritative unit price in whole IDR.
- `mec_products.stock_quantity` is the available-to-sell quantity used by server-side reservation/decrement; values must be owner-verified before activation.
- `mec_products.category_id` references `mec_categories.id`; the storefront reads the category name from that MEC relationship.
- Order creation accepts product UUIDs and positive integer quantities only. It reads current MEC prices/stock under the existing database transaction/locking rules; it must not trust browser price, total, title, category, or stock.
- mec_order_items snapshots product name and unit price at order time. Duitku paymentAmount must be derived from the persisted order amount and its item details must reconcile to that same amount.
- Keep MEC product UUIDs stable. No legacy source mapping/import is permitted under the locked source boundary.
- The storefront reads `price_idr` directly; no legacy conversion, promotion fallback, or currency inference is permitted.
- Keep order/payment state transitions and stock reservation on the server/database; the client return URL is not payment confirmation.

## Explicitly unresolved — do not implement assumptions

1. The owner-supplied MEC-native catalog values and operator review must be completed before product activation.
2. Each `price_idr` value must be approved as a whole-IDR price for that MEC product.
3. Promotions remain unsupported until a separate MEC-only promotion schema and contract is reviewed.
4. Each `stock_quantity` value must be owner-verified available-to-sell stock.
5. Each separately purchasable SKU is represented by a separate MEC product row until a variant model is approved.
6. Category assignment uses only the MEC `category_id` foreign key.
7. The dedicated `mec-products` Storage bucket must be separately provisioned and verified before MEC image rows are entered.
8. Storefront, cart, and product detail display whole IDR consistently.

## Gate before catalog schema changes

The initial catalog population mechanism is controlled manual entry of owner-supplied values directly into `mec_categories`, `mec_products`, and `mec_product_images`. Do not read, join, copy, sync, or import from any non-`mec_` table or external catalog feed. Do not draft/apply schema migrations or create catalog rows as part of this documentation/code change. Promotion schema and storage-bucket provisioning require separate review.

## Acceptance criteria

- Catalog values are entered directly into MEC by an authorized operator from values supplied specifically for MEC; no non-MEC source is queried or imported.
- Promotion behavior remains disabled; independently purchasable SKUs are separate MEC product rows until a dedicated variant contract is reviewed.
- Sellable stock field and reservation behavior are confirmed.
- MEC UUIDs remain stable; no legacy source-ID mapping/import exists.
- Storefront, cart, and server use the same product UUID and a consistent currency presentation contract.
- Server totals and Duitku item details reconcile exactly in whole IDR.
- Remote image handling and category mapping are documented.
- Preflight counts/samples, dry-run mapping results, duplicate checks, SQL validation, concurrency tests, and sandbox payment tests are ready before rollout.


## Out-of-scope audit evidence — not an MEC source

A follow-up read-only search found catalog display configuration in [gantulu/oktavia/app/all.json](https://github.com/gantulu/oktavia/blob/2a3162afc5dd8e148a96b9a5f7bcfbc6ae3cc04f/app/all.json) and [app/home/flashSale.json](https://github.com/gantulu/oktavia/blob/2a3162afc5dd8e148a96b9a5f7bcfbc6ae3cc04f/app/home/flashSale.json). It reads a Google Sheet through OpenSheet and displays sale_price as primary when present, otherwise price; it also transforms quantity_to_sell_on_facebook using minMax(1, 99). This is evidence of a separate storefront only. Under the locked source boundary above, the related sheet/configuration must not feed MEC behavior and must not be imported into MEC. It does not establish currency/unit or real sellable stock.

The one live public.products sample includes a 128GB sale effective interval of 2026-04-01 through 2026-04-10, which has expired as of 2026-10-23. Do not use that sample's sale price as current checkout price without a verified effective-date policy.

The MEC-only frontend contract and controlled manual-entry procedure are documented. Catalog activation still depends on owner-supplied product values and verification of price, stock, and images. No catalog migration or non-MEC import is authorized.
