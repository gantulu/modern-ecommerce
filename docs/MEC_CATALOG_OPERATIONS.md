# MEC Catalog Operations — Native Population Only

Status: **PROCESS DEFINED; no catalog rows or storage bucket created by this change.**

## Hard source boundary

MEC operational catalog data must be stored and read only from tables whose names begin with `mec_`. Do not query, join, copy, sync, import, or fall back to `public.products`, `public.applestore`, Google Sheets, or any other non-`mec_` source. Existing legacy data may only appear in a separate audit and must never be used to populate MEC.

## Catalog read path

The storefront reads:
- `public.mec_products`: product identity, name, slug, description, whole-IDR `price_idr`, sellable `stock_quantity`, active state, timestamps, and category FK.
- `public.mec_categories`: category name/slug/description and active state.
- `public.mec_product_images`: image storage path, alt text, and display order for each MEC product.

Public frontend access is read-only and relies on existing RLS policies for active MEC products/categories and images attached to active products. Product prices used for checkout are always recalculated by the server-side MEC order function; the browser value is display-only.

## Initial population mechanism

Use a **manual, controlled MEC-native entry process** performed by an authorized project operator in the Supabase Dashboard Table Editor (or an equivalent trusted administrative database session). This is direct entry of newly owner-supplied catalog values into MEC—not a data import, query, join, copy, or sync from another table, spreadsheet, or catalog feed. Do not expose catalog writes through the public storefront or anon/authenticated client.

1. Obtain the product/category values directly from the owner specifically for MEC entry. Do not query or copy values from non-`mec_` tables or external feeds.
2. Create active categories in `mec_categories` with unique `name` and `slug`, using category definitions explicitly approved for this MEC storefront.
3. Create each product directly in `mec_products` with a stable UUID (database default is acceptable), matching `category_id`, unique `slug`, name/description, `price_idr` as a non-negative whole-IDR integer, verified `stock_quantity`, and `is_active = false` until reviewed.
4. Review product name, slug, category, price in whole IDR, stock quantity, and active state. Do not invent prices, promotional prices, or inventory values. Do not enter sale-price behavior: current MEC schema has no promotion field.
5. For images, create a dedicated public Supabase Storage bucket named `mec-products` only after an operator verifies the intended public-image policy. Upload approved images there, then insert bucket-relative object paths into `mec_product_images.storage_path`, with optional `alt_text` and `display_order`. Never store arbitrary remote URLs in `storage_path`. The bucket does not currently exist; until provisioned, the UI uses a local placeholder image.
6. Review the product record and image path, then set `is_active = true`. Only active MEC products/categories are visible to anon/authenticated storefront clients.
7. After each batch, verify there are no duplicate slugs, every non-null category ID references an active MEC category, `price_idr` is a whole-IDR integer, `stock_quantity` is non-negative and owner-verified, and image paths resolve from the dedicated MEC bucket.
8. Record operator, date, and change reason in the team's operational change log. Do not put secrets in catalog rows or frontend code.

## Current schema limitations and rules

- No promotion/sale-price column or promotion table exists in the current MEC schema. The storefront displays `price_idr` as the sole catalog price. Do not infer a sale price or add promotion logic until a separately reviewed MEC-only schema/contract defines it.
- Product variants are not represented in the current MEC product contract. Each independently purchasable SKU should be entered as its own MEC product row until a dedicated variant model is reviewed.
- Stock reservation/decrement is server-side in the MEC order transaction. `stock_quantity` is the available-to-sell quantity; only set it from a direct owner-approved, verified stock count.
- The schema has no admin UI for catalog maintenance. This manual trusted-operator process is the initial maintenance mechanism; public browser writes remain prohibited.
- This procedure does not create or apply migrations, insert catalog rows, or provision a storage bucket. Those actions remain separate operations.

## Verification checklist

- [ ] All frontend catalog queries use only `mec_products`, `mec_categories`, and `mec_product_images`.
- [ ] No frontend fallback query to a non-`mec_` table exists.
- [ ] Products remain inactive until reviewed.
- [ ] Prices are whole IDR values; checkout never trusts browser-provided price.
- [ ] Stock quantity is owner-verified and represents available-to-sell inventory.
- [ ] Images use only the dedicated `mec-products` Storage bucket and MEC image rows.
- [ ] No legacy catalog rows were copied or imported.
