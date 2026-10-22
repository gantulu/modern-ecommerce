# Legacy catalog → MEC catalog preflight

Status: **audit only; do not apply a catalog migration until these checks pass against the correct Supabase project**.

## Mapping contract

- Legacy source: `public.products`, `public.categories`, and optional `public.product_images`.
- MEC destination: `public.mec_products`, `public.mec_categories`, and `public.mec_product_images`.
- Currency decision: legacy `products.price` is treated as **IDR**. MEC stores whole rupiah as `bigint price_idr`.
- Preserve `products.id` as `mec_products.id`. The frontend cart sends legacy product IDs; preserving IDs avoids a lookup/translation race between cart and checkout.
- Preserve category IDs where possible. Resolve products with null `category_id` using the legacy `products.category` label.
- Do not copy `orders` or `order_items` into MEC order tables. They represent historical checkout data and must not be converted into new payable orders.
- Do not reinterpret `image_url` as a Storage path. Product imagery remains served by the existing catalog until an explicit image mapping is defined.
- No live schema or row values have been read by this audit. The connected Supabase project visible to the tools is named `No signal` and has not been assumed to be the database for this repository.

## Read-only SQL preflight

Run these queries only against the Supabase project that is confirmed to back `gantulu/modern-ecommerce`.

### 1. Data quality and IDR integer compatibility

```sql
SELECT
  count(*) AS product_count,
  count(*) FILTER (WHERE price IS NULL) AS null_price_count,
  count(*) FILTER (WHERE price <= 0) AS nonpositive_price_count,
  count(*) FILTER (WHERE price <> trunc(price)) AS fractional_idr_price_count,
  count(*) FILTER (WHERE stock IS NULL OR stock < 0) AS invalid_stock_count,
  count(*) FILTER (WHERE length(btrim(name)) = 0) AS empty_name_count
FROM public.products;
```

Payment amounts are integer IDR and must be positive. If `fractional_idr_price_count` is nonzero, **stop**: do not round silently. Review the affected records and correct the source data or approve a documented conversion rule first.

```sql
SELECT id, name, price, stock, category, category_id
FROM public.products
WHERE price IS NULL OR price <= 0 OR price <> trunc(price)
   OR stock IS NULL OR stock < 0
   OR length(btrim(name)) = 0
ORDER BY name, id;
```

### 2. Verify category references and labels

```sql
SELECT p.id, p.name, p.category, p.category_id,
       c.name AS referenced_category_name
FROM public.products p
LEFT JOIN public.categories c ON c.id = p.category_id
WHERE p.category_id IS NOT NULL AND c.id IS NULL
ORDER BY p.name, p.id;
```

```sql
SELECT lower(btrim(category)) AS normalized_product_category,
       count(*) AS products_using_category
FROM public.products
GROUP BY lower(btrim(category))
ORDER BY normalized_product_category;
```

Compare these labels with `public.categories.name`. Differences in spelling/case should be reviewed before mapping; do not silently merge distinct categories.

### 3. Detect existing MEC ID collisions

```sql
SELECT p.id, p.name AS legacy_name, m.name AS mec_name,
       p.price AS legacy_price_idr, m.price_idr AS mec_price_idr,
       p.stock AS legacy_stock, m.stock_quantity AS mec_stock
FROM public.products p
JOIN public.mec_products m ON m.id = p.id
WHERE p.name IS DISTINCT FROM m.name
   OR p.price IS DISTINCT FROM m.price_idr::numeric
   OR p.stock IS DISTINCT FROM m.stock_quantity
ORDER BY p.id;
```

```sql
SELECT c.id, c.name AS legacy_name, m.name AS mec_name
FROM public.categories c
JOIN public.mec_categories m ON m.id = c.id
WHERE c.name IS DISTINCT FROM m.name
ORDER BY c.id;
```

Any returned collision must be resolved before upsert. A matching ID is not sufficient if the stored product/category values differ.

### 4. Row counts and orphan image references

```sql
SELECT 'products' AS source, count(*) AS rows FROM public.products
UNION ALL
SELECT 'categories', count(*) FROM public.categories
UNION ALL
SELECT 'product_images', count(*) FROM public.product_images;
```

```sql
SELECT pi.id, pi.product_id, pi.image_url
FROM public.product_images pi
LEFT JOIN public.products p ON p.id = pi.product_id
WHERE p.id IS NULL;
```

## Migration acceptance criteria

- The database/project identity is confirmed; schema inspection is read-only.
- All legacy prices are positive whole IDR amounts, or a separate approved conversion rule exists.
- All stock values are non-negative.
- Every category reference resolves and the category-label mapping is documented.
- Existing MEC IDs have no conflicting data, or conflicts have a reviewed resolution.
- The migration preserves legacy product UUIDs and does not modify legacy tables, legacy triggers, historical orders, or existing payment records.
- Post-migration row counts and sampled ID/name/price/stock/category mappings match the preflight report.
- The checkout Edge Function and frontend build/tests pass before deployment.

Until the checks above have been executed against the confirmed project, catalog migration is **blocked**. This is a guard against charging a price or reserving stock from a different catalog than the one shown to the customer.
