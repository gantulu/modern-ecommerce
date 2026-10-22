# MEC catalog source audit and migration preflight

Status: **BLOCKED — authoritative source, price semantics, and storefront currency contract are not yet verified. No catalog migration has been created or applied.**

## Repository contract

The frontend Product type in `src/types/supabase.ts` expects:
- `id` (string identifier), `name`, `description`, numeric `price`, `image_url`, `category`, `stock`, `created_at`, and optional `category_id`.

`src/pages/Products.tsx` queries `public.products` and filters/searches/sorts using top-level `category`, `price`, `name`, and `created_at`. The checkout cart passes product IDs to the MEC order Edge Function, whose input validation requires UUID product IDs matching `public.mec_products.id`.

There is a presentation mismatch: `src/components/ProductCard.tsx` formats prices with a dollar sign, while `src/pages/Cart.tsx` formats them as IDR. The product filter also starts with a maximum price of 1000, with no verified currency unit. Align display, filters, and cart only after source price/unit is verified; do not treat UI prices as payment authority.

See also [MEC Catalog Contract Alignment](./MEC_CATALOG_CONTRACT.md), which records the provisional storefront-to-MEC contract without authorizing import or migration.

## Read-only database observations

The connected Supabase project inspected during this audit is:
- Project name: `No signal`
- Project ref: `oszqantvugvbvydlizix`
- Region: `ap-northeast-1`
- Status: `ACTIVE_HEALTHY`

The repository's MEC migration history and the Edge Function URLs in `docs/MEC_DUITKU_EDGE_FUNCTIONS.md` reference this same project ref. This establishes project alignment, not source-catalog authority. The inspected repository tree contains no seed/import migration or source-ingestion script that explains how `public.products` or `public.applestore` were populated; live tables also have no table/column comments or user-defined triggers documenting commercial price or stock semantics.

Observed tables and counts:
- `public.products`: 1 row. Its actual columns include `item_group_id`, `title`, `currency`, `inventory_quantity`, `link`, and nested feed fields; it does not expose the normalized `id`, `name`, `price`, `category`, `stock` contract currently used by the frontend. The sample row is `group-iphone-14` / `iPhone 14`, currency `IDR`, inventory quantity `50`, and link `https://example.com/product-iphone-14`. Its nested `sizes[].price` includes text such as `12000000.00 IDR`; this is evidence for that sample feed value, but not a normalized top-level price, not proof that this table is the intended source of the full catalog, and not sufficient to implement variants or a payable price mapping. The example.com link also appears placeholder-like.
- `public.applestore`: 222 rows, with text `id`, `title`, integer `price` and `sale_price`, text `category`, `availability`, and `quantity_to_sell_on_facebook`. Read-only aggregate: base `price` ranges from 1795 to 9999; `sale_price` ranges from 399 to 7999; all 222 rows have a sale price lower than base price. Categories are iPhone 144, iPad 36, and iWatch 42. Sample rows use URLs under `applesmy.oneapp.dev`, include feed-oriented fields such as `quantity_to_sell_on_facebook`, `custom_label_*`, and `dummySold`, and have no currency column. This resembles a channel/catalog feed but does not prove the business price currency or make the table the authoritative checkout source.
- `public.mec_products`: 0 rows; primary key `id` is UUID and `price_idr` is bigint.
- `public.mec_categories`: 0 rows; primary key `id` is UUID.

The `applestore` table has 222 distinct IDs, no blank titles, no null/nonpositive base prices, no nonpositive non-null sale prices, and no null/negative `quantity_to_sell_on_facebook` values. However, a stock consistency check found 210 rows labelled `in stock` and 12 labelled `out of stock`; all 222 rows have a positive `quantity_to_sell_on_facebook`. Therefore the Facebook quantity field conflicts with the availability status for all 12 out-of-stock rows and cannot be treated as authoritative sellable stock without explaining this discrepancy. The table's RLS is enabled, but its policy `public can do all` grants `ALL` with `USING (true)` and `WITH CHECK (true)` to `public`; this is a data-integrity and security concern and means the table's current contents are not protected by a restrictive catalog write policy. Do not change the policy as part of this catalog audit. These checks establish basic data quality only. They do **not** establish that `applestore` is the intended source for this generic e-commerce repository, that its price fields are IDR, or that `quantity_to_sell_on_facebook` is the authoritative stock field for checkout.

## Provisional mapping contract — not approved for import

- Do not select either legacy table as authoritative based only on its name or schema. `public.products` has the only observed explicit `currency = IDR`, but only one feed-shaped row and example.com placeholder links; treat it as test/sample-like evidence, not proof of the full commercial catalog. `public.applestore` has 222 richer variants and storefront links but no currency field, and its feed-specific stock quantity conflicts with 12 `out of stock` availability values.
- Do not map `public.products.id` to `mec_products.id`: the live source table has no `id` column.
- Do not map `public.applestore.id` directly to `mec_products.id`: source IDs are text while MEC product IDs are UUIDs. If this source is confirmed, define a deterministic, collision-safe source-ID mapping and make the storefront/cart/order RPC use the same MEC UUID. Never generate a new random UUID on every import.
- MEC's current server-side contract uses `mec_products.price_idr` as the whole-IDR unit price and `mec_products.stock_quantity` as the inventory quantity. This defines the destination contract, not a conversion rule for unverified source fields.
- Do not map `sale_price` to checkout price or use `quantity_to_sell_on_facebook` as sellable stock until their semantics are confirmed. The fact that all observed sale prices are lower than base prices does not establish sale eligibility or currency.
- The previous assumption to treat a top-level `public.products.price` as IDR is inapplicable: that column does not exist on the live table.
- Do not copy historical legacy orders/order items into MEC payable orders.
- Do not convert remote image URLs into Supabase Storage paths without an explicit, reviewed mapping. Do not collapse `sizes` / color variants into a single SKU without an approved variant contract.

## Required source and currency verification

Before drafting a catalog migration, establish from authoritative project configuration, source documentation, representative product records, or explicit owner confirmation:

1. Which table is the commercial source of truth for products displayed by `src/pages/Products.tsx`: `public.products`, `public.applestore`, or another catalog/database? Current repo files and database metadata do not establish provenance; identify the owner/system that writes each table.
2. What currency and unit are used by each selected price field and each purchasable variant? Do not infer unit from magnitude or column names.
3. Which price is charged: base or sale price, and under what effective-date/eligibility conditions?
4. Which source field is authoritative sellable stock, and does it represent global stock or channel-specific stock? In `applestore`, `quantity_to_sell_on_facebook` is positive even on all 12 rows marked `out of stock`, so the discrepancy must be resolved first.
5. Does each `sizes` / color entry represent a distinct SKU? How is a selected variant identified in cart and order creation?
6. How do source category labels map to MEC categories, and where is stable source-ID provenance stored?
7. Can remote image URLs be used directly, or is there a verified image mapping?
8. What storefront currency formatting and price-filter range should be used?

## Migration acceptance criteria

- Source catalog and currency/price semantics are confirmed.
- Storefront query, Product type, currency formatting, filters, cart IDs, and server-side order creation share one consistent contract.
- Prices convert to positive whole-IDR amounts without implicit rounding; conversion is documented and tested.
- Sale-price eligibility, variant identity, stock source, and reservation semantics are verified.
- Category mapping and source-ID mapping are deterministic and collision-safe.
- Existing MEC IDs and slugs have no conflicting records, or a reviewed resolution exists.
- Migration is additive and guarded; it does not modify legacy source tables, historical orders, or existing payment records.
- Read-only preflight and post-import count/sample checks are documented.
- Build, lint, SQL validation, concurrency tests, and sandbox end-to-end tests pass before deployment.

Until these criteria pass, catalog migration and production checkout activation remain blocked. Database inspection for this report was read-only. No catalog migration was drafted or applied.


## Additional cross-repository evidence found during follow-up audit

A read-only search across the owner's accessible GitHub repositories found related catalog-display configuration in [gantulu/oktavia/app/all.json](https://github.com/gantulu/oktavia/blob/2a3162afc5dd8e148a96b9a5f7bcfbc6ae3cc04f/app/all.json) and [app/home/flashSale.json](https://github.com/gantulu/oktavia/blob/2a3162afc5dd8e148a96b9a5f7bcfbc6ae3cc04f/app/home/flashSale.json). This is a useful lead, **not proof that this is the source that populates modern-ecommerce's live tables**.

The related UI config reads catalog data through OpenSheet from a Google Sheet (ID: 1x2Rtyeyq3WR6yFybA8stGP0mdI2dlKvBz6fhx7FIjhQ, tab Sheet1) and maps:
- price as the crossed-out price when a sale price is present.
- sale_price as the primary display price when present, otherwise price.
- quantity_to_sell_on_facebook through a minMax(1, 99) transform for the product card.

This reveals a **display selection rule** in that separate UI: show sale_price when populated, otherwise price. It does not establish the authoritative checkout price, currency/unit, promotion eligibility/effective dates, or whether this sheet feeds either live MEC legacy table. The quantity transform also means that field must not be assumed to be raw sellable inventory for checkout.

The single public.products sample has a sale_price_effective_date of 2026-04-01T00:00:00/2026-04-10T23:59:59 for its 128GB variant. That interval has elapsed as of this audit date (2026-10-23); it is only one feed-shaped sample and does not establish the production promotion policy. The source contract must define whether effective dates are enforced and what happens when a sale price is blank, expired, or malformed.

Still unresolved: confirm whether the oktavia Google Sheet is the actual commercial source for this MEC storefront, confirm the currency/unit used in that sheet, and confirm whether the display rule is also the checkout charging rule. No schema or data changes were made.
