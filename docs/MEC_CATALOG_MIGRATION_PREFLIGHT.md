# MEC catalog source audit and migration preflight

Status: **BLOCKED — source catalog and currency unit are not yet verified. No catalog migration has been created or applied.**

## Repository contract

The current frontend contract in `src/types/supabase.ts` expects products with:
- `id` (string identifier),
- `name`,
- `description`,
- `price` (number),
- `image_url`,
- `category`,
- `stock`,
- optional `category_id`.

`src/pages/Products.tsx` queries `public.products` and filters/searches using `category`, `price`, and `name`. The checkout cart passes each product's `id` to the MEC order Edge Function, whose database contract expects UUID product IDs in `public.mec_products`.

## Read-only database observations

The connected Supabase project inspected during this audit is:
- Project name: `No signal`
- Project ref: `oszqantvugvbvydlizix`
- Region: `ap-northeast-1`
- Status: `ACTIVE_HEALTHY`

The repository's existing MEC migration history and the Edge Function URLs in `docs/MEC_DUITKU_EDGE_FUNCTIONS.md` reference this same project ref. However, the product data itself does **not** match the repository's current frontend contract, so the correct commercial source catalog is still unconfirmed.

Observed tables and counts:
- `public.products`: 1 row. Its actual columns include `item_group_id`, `title`, `currency`, and `inventory_quantity`; it does not expose the `id`, `name`, `price`, `category`, `stock` contract currently used by the frontend. The sampled row is `group-iphone-14` / `iPhone 14`, currency `IDR`, inventory quantity `50`, and link `https://example.com/product-iphone-14`. Although that row declares IDR, the table has no price field and its link looks like a placeholder, so it cannot currently supply a payable price.
- `public.applestore`: 222 rows, with text `id`, `title`, integer `price` and `sale_price`, text `category`, `availability`, and `quantity_to_sell_on_facebook`.
- `public.mec_products`: 0 rows; primary key `id` is UUID and `price_idr` is bigint.
- `public.mec_categories`: 0 rows; primary key `id` is UUID.

The `applestore` table has 222 distinct IDs, no blank titles, no null/nonpositive base prices, no nonpositive non-null sale prices, and no null/negative `quantity_to_sell_on_facebook` values. Category counts are iPhone 144, iPad 36, and iWatch 42.

These checks establish basic data quality only. They do **not** establish that `applestore` is the intended source for this generic e-commerce repository, that `price` or `sale_price` is denominated in IDR, or that `quantity_to_sell_on_facebook` is the stock field used for checkout. Values must not be converted or charged as IDR based on magnitude or column name alone.

## Mapping contract — provisional, not approved

Do not assume the earlier mapping from `public.products.id` to `mec_products.id`: the live `public.products` table does not have an `id` column, and the actual row uses a different schema.

Do not map `public.applestore.id` directly to `mec_products.id`: it is text while the MEC key is UUID. If this catalog is confirmed as authoritative, define a deterministic, collision-safe mapping strategy and ensure the cart and order RPC use the same product identity. Do not silently generate fresh UUIDs on every run.

Do not map `sale_price` to checkout price or use `quantity_to_sell_on_facebook` as stock until the owner confirms those semantics. Do not infer currency from the numeric values. The previous choice to treat `public.products.price` as IDR is inapplicable to the observed schema because that column does not exist on the live table.

Do not copy historical legacy orders/order items into MEC payable orders. Do not convert remote image URLs into Storage paths without a separately reviewed image mapping.

## Required source and currency verification

Before drafting the catalog migration, establish all of the following from authoritative project configuration, product source documentation, or explicit owner confirmation:

1. Which table is the source of truth for the products shown by `src/pages/Products.tsx`: the existing `public.products` feed, `public.applestore`, or a different catalog/database?
2. What currency and unit are used by the selected source's base and sale prices (for example, whole IDR, major-unit currency, or minor units)? Use source documentation or known authoritative product records; numeric magnitude is not evidence.
3. Which price is charged: base price or sale price, and under what conditions?
4. Which source field is the authoritative sellable stock quantity?
5. How should category labels map to MEC categories, and should original source IDs be preserved in an explicit source-ID mapping column/table?
6. How should remote image URLs be represented without pretending they are Supabase Storage paths?

## Migration acceptance criteria

- Source catalog and currency/price semantics are confirmed.
- Frontend product query, Product type, cart IDs, and server-side order creation all share one consistent product identity and schema contract.
- Prices convert to positive whole IDR amounts without implicit rounding; any conversion is explicitly documented and tested.
- Stock source and reservation semantics are verified.
- Category mapping and source-ID mapping are deterministic and collision-safe.
- Existing MEC IDs and slugs have no conflicting records, or a reviewed resolution exists.
- Migration is additive and guarded; it does not modify legacy source tables, historical orders, or existing payment records.
- Read-only preflight and post-migration count/sample checks are documented.
- Build, lint, SQL validation, concurrency tests, and sandbox end-to-end tests pass before deployment.

Until these criteria pass, catalog migration and production checkout activation remain blocked. All database inspection for this report was read-only.
