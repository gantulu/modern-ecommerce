# MEC catalog source audit and migration preflight

## Locked source boundary — owner decision

**MEC must not use any table outside the `mec_` prefix as an operational data source.** This includes storefront reads, product/category data, pricing, promotions, stock, cart identity, checkout, joins, fallbacks, and imports.

- Allowed operational table family: `mec_*` only.
- `public.products`, `public.applestore`, Google Sheets, and other non-`mec_` sources are out of scope for MEC. They must not be joined, queried for live MEC behavior, or imported/copied into MEC.
- The live MEC product and category tables are empty. No fallback to a non-MEC table is permitted; the MEC-native catalog population method requires a separate explicit decision.
- This branch now reads the storefront catalog through `src/lib/mecCatalog.ts`, using `mec_products`, `mec_categories`, and `mec_product_images`; the public storefront remains read-only.
- Legacy table observations below are retained only as read-only audit evidence of the existing mismatch, not as source recommendations or import candidates.


Status: **MEC-only frontend query implemented in this branch; catalog population, storage bucket provisioning, and product activation remain pending. No catalog migration has been created or applied.**

## Repository contract

The frontend Product type in `src/types/supabase.ts` expects:
- `id` (string identifier), `name`, `description`, numeric `price`, `image_url`, `category`, `stock`, `created_at`, and optional `category_id`.

`src/lib/mecCatalog.ts` reads active MEC products and their category/image relations. Products, Categories, and Featured Products use this helper; prices are mapped from `price_idr`, stock from `stock_quantity`, and category names from `mec_categories`. The checkout cart passes MEC product UUIDs and quantities to server-side order creation; browser prices remain display-only.

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

## MEC-native contract — no legacy mapping or import

- Do not use either legacy table as a source for MEC. Their schema/row observations below are audit evidence only and must not drive MEC catalog reads, mapping, imports, or operational decisions.
- No IDs or records are mapped from `public.products` or any other non-`mec_` source.
- Legacy ID mapping/import is out of scope and prohibited by the locked MEC-only source boundary.
- MEC uses `mec_products.price_idr` as the whole-IDR price and `mec_products.stock_quantity` as available-to-sell inventory; owner verification is required before activation.
- No sale-price logic or stock fallback to legacy feed fields is permitted. MEC has no promotion field/table at present.
- The UI reads the MEC `price_idr` field directly; no legacy price conversion or inference is performed.
- Do not copy historical legacy orders/order items into MEC payable orders.
- Images are represented only by `mec_product_images.storage_path`; the `mec-products` bucket is not yet provisioned. The current schema has no variant model, so separate SKUs must be separate MEC product rows until reviewed.

## Required MEC-native contract verification

Before drafting a catalog migration, establish from authoritative project configuration, source documentation, representative product records, or explicit owner confirmation:

1. Ensure the owner supplies product/category values specifically for MEC entry; do not query or copy data from any non-`mec_` table or external feed.
2. Verify each `price_idr` value is a whole-IDR amount approved for that MEC product.
3. Keep promotions disabled; the current MEC schema has no sale-price field or promotion table.
4. Verify `stock_quantity` directly as owner-approved available-to-sell stock for MEC.
5. Treat each separately purchasable SKU as its own MEC product row until a dedicated variant schema is reviewed.
6. Confirm each `category_id` references an active `mec_categories` row.
7. Provision and verify the dedicated `mec-products` Storage bucket separately before adding MEC image rows.
8. Verify the storefront displays whole IDR and the filter maximum is derived from active MEC product prices.

## Migration acceptance criteria

- Frontend catalog reads use only MEC-prefixed tables.
- Storefront query, Product type, currency formatting, filters, cart IDs, and server-side order creation share one consistent contract.
- Prices are read directly from `price_idr`; no legacy conversion, sale-price fallback, or currency inference occurs.
- Sale-price eligibility, variant identity, stock source, and reservation semantics are verified.
- Category mapping uses the MEC `category_id` foreign key; no legacy source-ID mapping is used.
- Existing MEC IDs and slugs have no conflicting records, or a reviewed resolution exists.
- Migration is additive and guarded; it does not modify legacy source tables, historical orders, or existing payment records.
- Read-only preflight and post-import count/sample checks are documented.
- Build, lint, SQL validation, concurrency tests, and sandbox end-to-end tests pass before deployment.

Catalog rows must remain inactive until reviewed. Schema changes and storage-bucket provisioning remain separate operations. Database inspection for this report was read-only; no catalog migration was drafted/applied and no catalog rows were inserted.


## Additional cross-repository evidence found during follow-up audit

A read-only search across the owner's accessible GitHub repositories found separate catalog-display configuration in [gantulu/oktavia/app/all.json](https://github.com/gantulu/oktavia/blob/2a3162afc5dd8e148a96b9a5f7bcfbc6ae3cc04f/app/all.json) and [app/home/flashSale.json](https://github.com/gantulu/oktavia/blob/2a3162afc5dd8e148a96b9a5f7bcfbc6ae3cc04f/app/home/flashSale.json). This is out-of-scope audit evidence only. Under the locked source boundary, this separate sheet/configuration must not be used to populate MEC or drive MEC behavior.

The related UI config reads catalog data through OpenSheet from a Google Sheet (ID: 1x2Rtyeyq3WR6yFybA8stGP0mdI2dlKvBz6fhx7FIjhQ, tab Sheet1) and maps:
- price as the crossed-out price when a sale price is present.
- sale_price as the primary display price when present, otherwise price.
- quantity_to_sell_on_facebook through a minMax(1, 99) transform for the product card.

This reveals a **display selection rule** in that separate UI: show sale_price when populated, otherwise price. It does not establish the authoritative checkout price, currency/unit, promotion eligibility/effective dates, or whether this sheet feeds either live MEC legacy table. The quantity transform also means that field must not be assumed to be raw sellable inventory for checkout.

The single public.products sample has a sale_price_effective_date of 2026-04-01T00:00:00/2026-04-10T23:59:59 for its 128GB variant. That interval has elapsed as of this audit date (2026-10-23); it is only one feed-shaped sample and does not establish the production promotion policy. The source contract must define whether effective dates are enforced and what happens when a sale price is blank, expired, or malformed.

Still unresolved: define the MEC-native catalog population, currency, promotion, variant, and stock contracts. The oktavia sheet is not an allowed MEC source. No schema or data changes were made.
