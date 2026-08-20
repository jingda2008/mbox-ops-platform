BEGIN;

ALTER TABLE mbox.products
  ADD COLUMN inventory_control_mode text NOT NULL DEFAULT 'tracked',
  ADD CONSTRAINT products_inventory_control_mode_check
    CHECK (inventory_control_mode IN ('tracked', 'not_managed'));

-- The current food category is fruit and cold snacks. The store explicitly does
-- not quantity-manage these products yet; cost, KDS and fulfillment remain active.
UPDATE mbox.products
SET inventory_control_mode = 'not_managed',
    updated_at = clock_timestamp()
WHERE category_code = 'food';

COMMENT ON COLUMN mbox.products.inventory_control_mode IS
  'tracked requires an active inventory recipe and balance; not_managed bypasses quantity inventory only and does not bypass cost, pricing, KDS, fulfillment, or sales audit';

COMMIT;
