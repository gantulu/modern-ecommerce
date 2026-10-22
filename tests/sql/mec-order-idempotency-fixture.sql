-- Seed/trigger fixture after applying the repository's real MEC schema migration.
-- Disposable PostgreSQL only. Never run against a live project.
INSERT INTO public.mec_products(id, name, slug, price_idr, stock_quantity, is_active)
VALUES
  ('11111111-1111-4111-8111-111111111111', 'Fixture Standard Product', 'fixture-standard-product', 100, 100, true),
  ('22222222-2222-4222-8222-222222222222', 'Fixture Last-Unit Product', 'fixture-last-unit-product', 100, 1, true);

-- Inject failure after create_order has decremented stock and inserted the order,
-- when its next order-item insert runs. PostgreSQL must roll back all effects.
CREATE OR REPLACE FUNCTION public.mec_test_fail_order_item_after_stock_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.mec_orders o
    WHERE o.id = NEW.order_id AND o.customer_name = 'ROLLBACK_TEST'
  ) THEN
    RAISE EXCEPTION 'fixture failure after stock decrement' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER mec_test_fail_order_item_after_stock_update
BEFORE INSERT ON public.mec_order_items
FOR EACH ROW EXECUTE FUNCTION public.mec_test_fail_order_item_after_stock_update();
