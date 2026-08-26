BEGIN;

-- Product category_code is an operational identifier already used by orders,
-- imports and historical snapshots.  Keep it stable and place the customer
-- menu hierarchy beside it, so a bar can rename/reorder/hide categories
-- without rewriting financial or fulfillment facts.
CREATE TABLE mbox.menu_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  code text NOT NULL CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$'),
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 32),
  parent_code text,
  sort_order integer NOT NULL DEFAULT 100 CHECK (sort_order BETWEEN 0 AND 100000),
  guest_visible boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
  UNIQUE (tenant_id,store_id,code),
  UNIQUE (tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,parent_code)
    REFERENCES mbox.menu_categories(tenant_id,store_id,code),
  CHECK (parent_code IS NULL OR parent_code <> code)
);

CREATE INDEX menu_categories_guest_hierarchy_idx
  ON mbox.menu_categories(tenant_id,store_id,guest_visible,parent_code,sort_order,code);

CREATE TRIGGER menu_categories_touch_updated_at
  BEFORE UPDATE ON mbox.menu_categories
  FOR EACH ROW EXECUTE FUNCTION mbox.touch_updated_at();

-- The staff API exposes a deliberately simple two-level editor.  Keep that
-- invariant in the database too, so imports or future integrations cannot
-- accidentally create a third customer-facing navigation level.
CREATE FUNCTION mbox.enforce_menu_category_two_levels()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_parent_code text;
BEGIN
  IF NEW.parent_code IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT category.parent_code
  INTO parent_parent_code
  FROM mbox.menu_categories AS category
  WHERE category.tenant_id=NEW.tenant_id
    AND category.store_id=NEW.store_id
    AND category.code=NEW.parent_code
  FOR KEY SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'menu category parent does not exist'
      USING ERRCODE='23503';
  END IF;

  IF parent_parent_code IS NOT NULL THEN
    RAISE EXCEPTION 'customer menu supports at most two category levels'
      USING ERRCODE='23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM mbox.menu_categories AS child
    WHERE child.tenant_id=NEW.tenant_id
      AND child.store_id=NEW.store_id
      AND child.parent_code=NEW.code
  ) THEN
    RAISE EXCEPTION 'a category with children cannot become a child category'
      USING ERRCODE='23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER menu_categories_two_levels
  BEFORE INSERT OR UPDATE OF parent_code ON mbox.menu_categories
  FOR EACH ROW EXECUTE FUNCTION mbox.enforce_menu_category_two_levels();

-- Seed a useful customer-facing starting hierarchy.  It is configuration, not
-- a hard-coded mini-program taxonomy: stores may rename, reorder, hide or add
-- entries in the catalog screen after this migration.  The same routine runs
-- when a new store is provisioned, so fresh stores do not regress to exposing
-- internal codes such as "cocktail" to guests.
CREATE FUNCTION mbox.seed_default_menu_categories_for_store(
  target_tenant_id uuid,
  target_store_id uuid
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO mbox.menu_categories (
    tenant_id,store_id,code,display_name,parent_code,sort_order,guest_visible
  ) VALUES
    (target_tenant_id,target_store_id,'bundles','组合甄选',NULL,10,true),
    (target_tenant_id,target_store_id,'drinks','酒水',NULL,20,true),
    (target_tenant_id,target_store_id,'food','鲜果与冷食',NULL,30,true),
    (target_tenant_id,target_store_id,'other','其他',NULL,90,true)
  ON CONFLICT (tenant_id,store_id,code) DO NOTHING;

  INSERT INTO mbox.menu_categories (
    tenant_id,store_id,code,display_name,parent_code,sort_order,guest_visible
  ) VALUES
    (target_tenant_id,target_store_id,'cocktail','鸡尾酒','drinks',10,true),
    (target_tenant_id,target_store_id,'beer','啤酒','drinks',20,true),
    (target_tenant_id,target_store_id,'wine','葡萄酒','drinks',30,true),
    (target_tenant_id,target_store_id,'sparkling','起泡酒','drinks',40,true),
    (target_tenant_id,target_store_id,'whisky','威士忌','drinks',50,true),
    (target_tenant_id,target_store_id,'spirits','烈酒','drinks',60,true),
    (target_tenant_id,target_store_id,'non_alcoholic','无酒精','drinks',70,true),
    (target_tenant_id,target_store_id,'fruit','鲜果','food',10,true),
    (target_tenant_id,target_store_id,'cold_food','冷食','food',20,true),
    (target_tenant_id,target_store_id,'snack','小食','food',30,true)
  ON CONFLICT (tenant_id,store_id,code) DO NOTHING;
END;
$$;

CREATE FUNCTION mbox.seed_default_menu_categories_on_store_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM mbox.seed_default_menu_categories_for_store(NEW.tenant_id,NEW.id);
  RETURN NEW;
END;
$$;

CREATE TRIGGER stores_seed_default_menu_categories
  AFTER INSERT ON mbox.stores
  FOR EACH ROW EXECUTE FUNCTION mbox.seed_default_menu_categories_on_store_insert();

SELECT mbox.seed_default_menu_categories_for_store(store.tenant_id,store.id)
FROM mbox.stores AS store;

-- Preserve every pre-existing product category as an editable entry.  Common
-- legacy codes are placed under the same top-level families; unfamiliar codes
-- remain visible to staff for a deliberate rename/re-parent decision rather
-- than being silently discarded.
INSERT INTO mbox.menu_categories (
  tenant_id,store_id,code,display_name,parent_code,sort_order,guest_visible
)
SELECT DISTINCT
  product.tenant_id,
  product.store_id,
  product.category_code,
  CASE product.category_code
    WHEN 'drink' THEN '其他酒水'
    WHEN 'food' THEN '鲜果与冷食'
    WHEN 'bundle' THEN '组合套餐'
    WHEN 'bottle' THEN '整瓶酒'
    ELSE COALESCE(
      NULLIF(btrim(product.product_snapshot->>'categoryName'), ''),
      NULLIF(btrim(product.product_snapshot->'source'->>'categoryName'), ''),
      '其他'
    )
  END,
  CASE product.category_code
    WHEN 'drink' THEN 'drinks'
    WHEN 'food' THEN NULL
    WHEN 'bundle' THEN 'bundles'
    WHEN 'bottle' THEN 'drinks'
    ELSE 'other'
  END,
  9000,
  true
FROM mbox.products AS product
WHERE btrim(product.category_code) <> ''
ON CONFLICT (tenant_id,store_id,code) DO NOTHING;

ALTER TABLE mbox.menu_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.menu_categories FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.menu_categories
  USING (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())
  WITH CHECK (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());

REVOKE ALL ON TABLE mbox.menu_categories FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON TABLE mbox.menu_categories TO mbox_runtime;
REVOKE EXECUTE ON FUNCTION mbox.enforce_menu_category_two_levels() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION mbox.seed_default_menu_categories_for_store(uuid,uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION mbox.seed_default_menu_categories_on_store_insert() FROM PUBLIC;

UPDATE mbox.normalized_schema_metadata
SET schema_version='144',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
