BEGIN;

ALTER TABLE mbox.products
  ADD COLUMN product_kind text NOT NULL DEFAULT 'single'
    CHECK (product_kind IN ('single', 'bundle'));

CREATE TABLE mbox.product_bundle_components (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  bundle_product_id uuid NOT NULL,
  component_product_id uuid NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0 AND quantity <= 999),
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, bundle_product_id)
    REFERENCES mbox.products(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, component_product_id)
    REFERENCES mbox.products(tenant_id, store_id, id),
  CHECK (bundle_product_id <> component_product_id),
  UNIQUE (tenant_id, store_id, bundle_product_id, component_product_id),
  UNIQUE (tenant_id, store_id, id)
);

CREATE INDEX product_bundle_components_bundle_idx
  ON mbox.product_bundle_components
    (tenant_id, store_id, bundle_product_id, sort_order, component_product_id);

CREATE FUNCTION mbox.validate_product_bundle_component()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  bundle_kind text;
  component_kind text;
BEGIN
  SELECT product_kind INTO bundle_kind
  FROM mbox.products
  WHERE tenant_id = NEW.tenant_id AND store_id = NEW.store_id
    AND id = NEW.bundle_product_id;

  SELECT product_kind INTO component_kind
  FROM mbox.products
  WHERE tenant_id = NEW.tenant_id AND store_id = NEW.store_id
    AND id = NEW.component_product_id;

  IF bundle_kind IS DISTINCT FROM 'bundle' THEN
    RAISE EXCEPTION 'bundle product must have product_kind=bundle';
  END IF;
  IF component_kind IS DISTINCT FROM 'single' THEN
    RAISE EXCEPTION 'bundle components must have product_kind=single';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER product_bundle_components_validate
  BEFORE INSERT OR UPDATE ON mbox.product_bundle_components
  FOR EACH ROW EXECUTE FUNCTION mbox.validate_product_bundle_component();

CREATE FUNCTION mbox.protect_product_kind_with_bundle_links()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.product_kind = OLD.product_kind THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1 FROM mbox.product_bundle_components AS component
    WHERE component.tenant_id = OLD.tenant_id AND component.store_id = OLD.store_id
      AND (
        (component.bundle_product_id = OLD.id AND NEW.product_kind <> 'bundle')
        OR (component.component_product_id = OLD.id AND NEW.product_kind <> 'single')
      )
  ) THEN
    RAISE EXCEPTION 'product kind cannot invalidate an existing bundle relationship';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER products_protect_bundle_kind
  BEFORE UPDATE OF product_kind ON mbox.products
  FOR EACH ROW EXECUTE FUNCTION mbox.protect_product_kind_with_bundle_links();

CREATE TRIGGER product_bundle_components_touch_updated_at
  BEFORE UPDATE ON mbox.product_bundle_components
  FOR EACH ROW EXECUTE FUNCTION mbox.touch_updated_at();

ALTER TABLE mbox.product_bundle_components ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.product_bundle_components FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.product_bundle_components
  USING (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id())
  WITH CHECK (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id());

REVOKE ALL ON TABLE mbox.product_bundle_components FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE mbox.product_bundle_components TO mbox_runtime;

COMMENT ON TABLE mbox.product_bundle_components IS
  'Structured bundle definition. Paid parent lines expand into zero-price operational child lines for KDS and inventory.';
COMMENT ON COLUMN mbox.order_items.parent_order_item_id IS
  'When set, this is a zero-price operational component of the paid parent bundle item.';

COMMIT;
