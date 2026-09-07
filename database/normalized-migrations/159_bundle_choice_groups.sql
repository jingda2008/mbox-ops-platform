BEGIN;

CREATE TABLE mbox.product_bundle_choice_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  bundle_product_id uuid NOT NULL,
  code text NOT NULL CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$'),
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 80),
  selection_count smallint NOT NULL DEFAULT 1 CHECK (selection_count BETWEEN 1 AND 20),
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, bundle_product_id)
    REFERENCES mbox.products(tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, bundle_product_id, code),
  UNIQUE (tenant_id, store_id, id)
);

CREATE TABLE mbox.product_bundle_choice_options (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  choice_group_id uuid NOT NULL,
  component_product_id uuid NOT NULL,
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity BETWEEN 1 AND 999),
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, choice_group_id)
    REFERENCES mbox.product_bundle_choice_groups(tenant_id, store_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, store_id, component_product_id)
    REFERENCES mbox.products(tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, choice_group_id, component_product_id),
  UNIQUE (tenant_id, store_id, id)
);

CREATE INDEX product_bundle_choice_groups_bundle_idx
  ON mbox.product_bundle_choice_groups(tenant_id, store_id, bundle_product_id, sort_order, id);
CREATE INDEX product_bundle_choice_options_group_idx
  ON mbox.product_bundle_choice_options(tenant_id, store_id, choice_group_id, sort_order, id);

CREATE FUNCTION mbox.validate_product_bundle_choice_group()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM mbox.products product
    WHERE product.tenant_id=NEW.tenant_id AND product.store_id=NEW.store_id
      AND product.id=NEW.bundle_product_id AND product.product_kind='bundle'
  ) THEN
    RAISE EXCEPTION 'bundle choice group owner must have product_kind=bundle';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION mbox.validate_product_bundle_choice_option()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE bundle_id uuid;
BEGIN
  SELECT bundle_product_id INTO bundle_id
  FROM mbox.product_bundle_choice_groups
  WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=NEW.choice_group_id;
  IF bundle_id IS NULL THEN
    RAISE EXCEPTION 'bundle choice group is unavailable';
  END IF;
  IF bundle_id=NEW.component_product_id OR NOT EXISTS (
    SELECT 1 FROM mbox.products product
    WHERE product.tenant_id=NEW.tenant_id AND product.store_id=NEW.store_id
      AND product.id=NEW.component_product_id AND product.product_kind='single'
  ) THEN
    RAISE EXCEPTION 'bundle choice options must be non-self single products';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER product_bundle_choice_groups_validate
  BEFORE INSERT OR UPDATE ON mbox.product_bundle_choice_groups
  FOR EACH ROW EXECUTE FUNCTION mbox.validate_product_bundle_choice_group();
CREATE TRIGGER product_bundle_choice_options_validate
  BEFORE INSERT OR UPDATE ON mbox.product_bundle_choice_options
  FOR EACH ROW EXECUTE FUNCTION mbox.validate_product_bundle_choice_option();
CREATE TRIGGER product_bundle_choice_groups_touch_updated_at
  BEFORE UPDATE ON mbox.product_bundle_choice_groups
  FOR EACH ROW EXECUTE FUNCTION mbox.touch_updated_at();
CREATE TRIGGER product_bundle_choice_options_touch_updated_at
  BEFORE UPDATE ON mbox.product_bundle_choice_options
  FOR EACH ROW EXECUTE FUNCTION mbox.touch_updated_at();

CREATE FUNCTION mbox.protect_product_kind_with_bundle_choices()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.product_kind=OLD.product_kind THEN RETURN NEW; END IF;
  IF EXISTS (
    SELECT 1 FROM mbox.product_bundle_choice_groups choice_group
    WHERE choice_group.tenant_id=OLD.tenant_id AND choice_group.store_id=OLD.store_id
      AND choice_group.bundle_product_id=OLD.id AND NEW.product_kind<>'bundle'
  ) OR EXISTS (
    SELECT 1 FROM mbox.product_bundle_choice_options choice_option
    WHERE choice_option.tenant_id=OLD.tenant_id AND choice_option.store_id=OLD.store_id
      AND choice_option.component_product_id=OLD.id AND NEW.product_kind<>'single'
  ) THEN
    RAISE EXCEPTION 'product kind cannot invalidate an existing bundle choice relationship';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER products_protect_bundle_choice_kind
  BEFORE UPDATE OF product_kind ON mbox.products
  FOR EACH ROW EXECUTE FUNCTION mbox.protect_product_kind_with_bundle_choices();

ALTER TABLE mbox.guest_shared_cart_lines
  ADD COLUMN bundle_selections jsonb NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(bundle_selections)='array');

ALTER TABLE mbox.guest_shared_cart_operations
  DROP CONSTRAINT guest_shared_cart_operations_command_check,
  ADD CONSTRAINT guest_shared_cart_operations_command_check
    CHECK (command IN ('adjust','replace_selection','remove','clear','submit','expire'));

ALTER TABLE mbox.guest_shared_cart_write_attempts
  DROP CONSTRAINT guest_shared_cart_write_attempts_action_check,
  ADD CONSTRAINT guest_shared_cart_write_attempts_action_check
    CHECK (action IN ('adjust','replace_selection','remove','clear','checkout'));

ALTER TABLE mbox.order_items
  DROP CONSTRAINT order_items_cost_source_ck,
  DROP CONSTRAINT order_items_submission_cost_ck,
  ADD CONSTRAINT order_items_cost_source_ck CHECK (cost_source IN (
    'catalog_product','bundle_components','legacy_snapshot','included_in_parent','unavailable'
  )),
  ADD CONSTRAINT order_items_submission_cost_ck CHECK (
    CASE cost_source
      WHEN 'catalog_product' THEN
        parent_order_item_id IS NULL
        AND unit_cost_minor_at_submission IS NOT NULL
        AND total_cost_minor_at_submission=unit_cost_minor_at_submission*quantity
        AND unit_cost_minor_at_submission>=0
        AND cost_reference_product_id=product_id
        AND cost_reference_order_item_id IS NULL
        AND cost_reference_product_updated_at IS NOT NULL
      WHEN 'bundle_components' THEN
        parent_order_item_id IS NULL
        AND total_cost_minor_at_submission IS NOT NULL
        AND total_cost_minor_at_submission>=0
        AND (unit_cost_minor_at_submission IS NULL OR (
          unit_cost_minor_at_submission>=0
          AND total_cost_minor_at_submission=unit_cost_minor_at_submission*quantity
        ))
        AND cost_reference_product_id=product_id
        AND cost_reference_order_item_id IS NULL
        AND cost_reference_product_updated_at IS NULL
      WHEN 'legacy_snapshot' THEN
        parent_order_item_id IS NULL
        AND total_cost_minor_at_submission IS NOT NULL
        AND total_cost_minor_at_submission>=0
        AND (unit_cost_minor_at_submission IS NULL OR (
          unit_cost_minor_at_submission>=0
          AND total_cost_minor_at_submission=unit_cost_minor_at_submission*quantity
        ))
        AND cost_reference_product_id=product_id
        AND cost_reference_order_item_id IS NULL
        AND cost_reference_product_updated_at IS NULL
      WHEN 'included_in_parent' THEN
        parent_order_item_id IS NOT NULL
        AND unit_cost_minor_at_submission=0
        AND total_cost_minor_at_submission=0
        AND cost_reference_product_id IS NULL
        AND cost_reference_order_item_id=parent_order_item_id
        AND cost_reference_product_updated_at IS NULL
      ELSE
        unit_cost_minor_at_submission IS NULL
        AND total_cost_minor_at_submission IS NULL
        AND cost_reference_product_id IS NULL
        AND cost_reference_order_item_id IS NULL
        AND cost_reference_product_updated_at IS NULL
    END
  );

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'product_bundle_choice_groups',
    'product_bundle_choice_options'
  ]
  LOOP
    EXECUTE format('ALTER TABLE mbox.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE mbox.%I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format(
      'CREATE POLICY tenant_store_isolation ON mbox.%I '
      'USING (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) '
      'WITH CHECK (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())',
      table_name
    );
    EXECUTE format('REVOKE ALL ON TABLE mbox.%I FROM PUBLIC',table_name);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE mbox.%I TO mbox_runtime',table_name);
  END LOOP;
END $$;

COMMENT ON TABLE mbox.product_bundle_choice_groups IS
  'Required exact-count choice groups that a customer or employee must resolve before ordering a bundle.';
COMMENT ON TABLE mbox.product_bundle_choice_options IS
  'Allowed concrete single-product choices. The selected products become operational order items for KDS and inventory.';
COMMENT ON COLUMN mbox.guest_shared_cart_lines.bundle_selections IS
  'One validated selection object per physical bundle unit in the cart; empty for products without choice groups.';

UPDATE mbox.normalized_schema_metadata
SET schema_version='159',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
