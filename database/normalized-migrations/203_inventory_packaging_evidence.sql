BEGIN;
-- Capture new facts only. Old sales and stock balances are never rewritten.
ALTER TABLE mbox.inventory_order_reservations ADD COLUMN packaging_snapshot jsonb;
ALTER TABLE mbox.quantity_remake_stocks ADD COLUMN packaging_snapshot jsonb;
CREATE FUNCTION mbox.capture_stock_packaging() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE fact jsonb;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.packaging_snapshot IS DISTINCT FROM OLD.packaging_snapshot THEN RAISE EXCEPTION 'original packaging evidence is immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 SELECT jsonb_build_object('baseUnit',base_unit,'itemType',item_type,'packageVolumeMl',package_volume_ml::text,'capturedAt',clock_timestamp()) INTO fact
 FROM mbox.inventory_items WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=NEW.inventory_item_id FOR SHARE;
 NEW.packaging_snapshot=fact; RETURN NEW;
END $$;
CREATE TRIGGER stock_packaging_evidence BEFORE INSERT OR UPDATE ON mbox.inventory_order_reservations FOR EACH ROW EXECUTE FUNCTION mbox.capture_stock_packaging();
CREATE TRIGGER stock_packaging_evidence BEFORE INSERT OR UPDATE ON mbox.quantity_remake_stocks FOR EACH ROW EXECUTE FUNCTION mbox.capture_stock_packaging();
CREATE FUNCTION mbox.capture_sale_packaging() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE fact jsonb;
BEGIN
 IF NEW.movement_type<>'sale' THEN RETURN NEW; END IF;
 SELECT jsonb_build_object('baseUnit',base_unit,'itemType',item_type,'packageVolumeMl',package_volume_ml::text,'capturedAt',clock_timestamp()) INTO fact
 FROM mbox.inventory_items WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=NEW.inventory_item_id FOR SHARE;
 NEW.metadata=COALESCE(NEW.metadata,'{}')||jsonb_build_object('packagingEvidence',fact); RETURN NEW;
END $$;
CREATE TRIGGER sale_packaging_evidence BEFORE INSERT ON mbox.inventory_movements FOR EACH ROW EXECUTE FUNCTION mbox.capture_sale_packaging();

-- Validate edited, explicitly whole-bottle configurations at transaction end,
-- so retiring a recipe and creating its replacement remains one operation.
CREATE FUNCTION mbox.check_whole_bottle_configuration() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE product_ids uuid[]; target_id uuid; checked_recipe_id uuid; yield_value numeric; valid boolean; product_name text; scope_tenant uuid; scope_store uuid;
BEGIN
 scope_tenant=COALESCE(NEW.tenant_id,OLD.tenant_id); scope_store=COALESCE(NEW.store_id,OLD.store_id);
 IF TG_TABLE_NAME='products' THEN product_ids=ARRAY[NEW.id];
 ELSIF TG_TABLE_NAME='recipes' THEN product_ids=ARRAY[NEW.product_id];
 ELSIF TG_TABLE_NAME='recipe_items' THEN
  SELECT array_agg(product_id) INTO product_ids FROM mbox.recipes WHERE tenant_id=scope_tenant AND store_id=scope_store AND id IN (NEW.recipe_id,OLD.recipe_id);
 ELSE
  IF (NEW.package_volume_ml,NEW.base_unit,NEW.item_type) IS NOT DISTINCT FROM (OLD.package_volume_ml,OLD.base_unit,OLD.item_type) THEN RETURN NEW; END IF;
  SELECT array_agg(DISTINCT recipe.product_id) INTO product_ids FROM mbox.recipe_items part JOIN mbox.recipes recipe
    ON recipe.tenant_id=part.tenant_id AND recipe.store_id=part.store_id AND recipe.id=part.recipe_id
    WHERE part.tenant_id=NEW.tenant_id AND part.store_id=NEW.store_id AND part.inventory_item_id=NEW.id AND recipe.status='active';
 END IF;
 FOREACH target_id IN ARRAY COALESCE(product_ids,ARRAY[]::uuid[]) LOOP
  SELECT name INTO product_name FROM mbox.products WHERE tenant_id=scope_tenant AND store_id=scope_store AND id=target_id
   AND product_snapshot->>'salesSpecificationType'='whole_bottle';
  IF NOT FOUND THEN CONTINUE; END IF;
  SELECT id,yield_quantity INTO checked_recipe_id,yield_value FROM mbox.recipes WHERE tenant_id=scope_tenant AND store_id=scope_store AND product_id=target_id AND status='active' ORDER BY version DESC LIMIT 1;
  IF NOT FOUND THEN CONTINUE; END IF;
  SELECT count(*)=1 AND bool_and(part.expected_waste_quantity=0 AND (
    (inventory.base_unit='ml' AND inventory.item_type='bottle' AND inventory.package_volume_ml>0 AND part.quantity=yield_value*inventory.package_volume_ml)
    OR (inventory.base_unit IN ('bottle','piece') AND inventory.item_type IN ('bottle','food') AND part.quantity=yield_value))) INTO valid
  FROM mbox.recipe_items part JOIN mbox.inventory_items inventory
    ON inventory.tenant_id=part.tenant_id AND inventory.store_id=part.store_id AND inventory.id=part.inventory_item_id
  WHERE part.tenant_id=scope_tenant AND part.store_id=scope_store AND part.recipe_id=checked_recipe_id;
  IF NOT COALESCE(valid,false) THEN RAISE EXCEPTION '整瓶商品“%”的配方用量与包装容量不一致，请核对库存扣减配方和单瓶容量',product_name USING ERRCODE='23514',CONSTRAINT='inventory_packaging_recipe_ck'; END IF;
 END LOOP;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER whole_bottle_recipe_check AFTER INSERT OR UPDATE ON mbox.recipes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION mbox.check_whole_bottle_configuration();
CREATE CONSTRAINT TRIGGER whole_bottle_recipe_check AFTER INSERT OR UPDATE OR DELETE ON mbox.recipe_items DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION mbox.check_whole_bottle_configuration();
CREATE CONSTRAINT TRIGGER whole_bottle_product_check AFTER INSERT OR UPDATE OF product_snapshot,status ON mbox.products DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION mbox.check_whole_bottle_configuration();
CREATE CONSTRAINT TRIGGER whole_bottle_inventory_check AFTER UPDATE OF package_volume_ml,base_unit,item_type ON mbox.inventory_items DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION mbox.check_whole_bottle_configuration();
REVOKE ALL ON FUNCTION mbox.capture_stock_packaging(),mbox.capture_sale_packaging(),mbox.check_whole_bottle_configuration() FROM PUBLIC;
UPDATE mbox.normalized_schema_metadata SET schema_version='203',updated_at=clock_timestamp() WHERE singleton=true AND schema_flavor='normalized-core-v1';
COMMIT;
