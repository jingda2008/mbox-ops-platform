BEGIN;

-- New purchases freeze evidence; existing purchases are deliberately not valued
-- using today's catalog. Historical gaps remain visible in operating reports.
CREATE TABLE mbox.activity_purchase_finance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  registration_id uuid NOT NULL,
  registration_cycle integer NOT NULL,
  business_date date NOT NULL,
  purchased_at timestamptz NOT NULL,
  goods_cost_minor bigint CHECK (goods_cost_minor >= 0),
  missing_cost_count integer NOT NULL CHECK (missing_cost_count >= 0),
  cost_items jsonb NOT NULL CHECK (jsonb_typeof(cost_items)='array'),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(tenant_id,store_id,registration_id)
    REFERENCES mbox.community_activity_registrations(tenant_id,store_id,id),
  UNIQUE(tenant_id,store_id,registration_id,registration_cycle),
  CHECK ((goods_cost_minor IS NULL) = (missing_cost_count > 0))
);
ALTER TABLE mbox.activity_purchase_finance ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.activity_purchase_finance FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.activity_purchase_finance
  USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())
  WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
GRANT SELECT,INSERT ON mbox.activity_purchase_finance TO mbox_runtime;

CREATE FUNCTION mbox.activity_purchase_business_date(p_tenant uuid,p_store uuid,p_at timestamptz)
RETURNS date LANGUAGE sql STABLE SET search_path=pg_catalog,mbox AS $$
  SELECT GREATEST(((p_at AT TIME ZONE s.timezone)-s.business_day_cutoff)::date,
    (SELECT max(b.next_business_date) FROM mbox.manual_business_day_ends b
      WHERE b.tenant_id=p_tenant AND b.store_id=p_store AND b.ended_at<=p_at))
  FROM mbox.stores s WHERE s.tenant_id=p_tenant AND s.id=p_store
$$;
REVOKE ALL ON FUNCTION mbox.activity_purchase_business_date(uuid,uuid,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mbox.activity_purchase_business_date(uuid,uuid,timestamptz) TO mbox_runtime;

CREATE FUNCTION mbox.freeze_activity_purchase_finance() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,mbox AS $$
DECLARE item jsonb; product_row record; total bigint := 0; missing integer := 0;
  evidence jsonb := '[]'; purchase_day date;
BEGIN
  IF TG_OP='UPDATE' AND NEW.registration_cycle=OLD.registration_cycle THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' THEN
    -- The row about to be replaced is still reliable purchase-date evidence for
    -- its old cycle. Preserve it before re-registration hides registered_at.
    -- A pre-migration meal has no verified submission cost: never price it from
    -- today's catalog. Existing frozen evidence wins and remains immutable.
    INSERT INTO mbox.activity_purchase_finance(tenant_id,store_id,registration_id,
      registration_cycle,business_date,purchased_at,goods_cost_minor,missing_cost_count,cost_items)
    VALUES(OLD.tenant_id,OLD.store_id,OLD.id,OLD.registration_cycle,
      mbox.activity_purchase_business_date(OLD.tenant_id,OLD.store_id,OLD.registered_at),OLD.registered_at,
      CASE WHEN OLD.activity_package_id IS NULL AND NOT OLD.service_has_meal
        AND jsonb_array_length(OLD.service_items_snapshot)=0 THEN 0 ELSE NULL END,
      CASE WHEN OLD.activity_package_id IS NULL AND NOT OLD.service_has_meal
        AND jsonb_array_length(OLD.service_items_snapshot)=0 THEN 0 ELSE GREATEST(1,jsonb_array_length(OLD.service_items_snapshot)) END,
      jsonb_build_array(jsonb_build_object('source','previous_cycle_purchase_evidence',
        'activityPackageId',OLD.activity_package_id,'serviceItems',OLD.service_items_snapshot,
        'costBasis','no_verified_submission_cost')))
    ON CONFLICT(tenant_id,store_id,registration_id,registration_cycle) DO NOTHING;
  END IF;
  purchase_day:=mbox.activity_purchase_business_date(NEW.tenant_id,NEW.store_id,NEW.registered_at);
  IF NEW.service_version=3 THEN
    FOR item IN SELECT value FROM jsonb_array_elements(NEW.service_items_snapshot)
      ORDER BY value->>'productId' LOOP
      SELECT id,cost_amount_minor,updated_at INTO product_row FROM mbox.products
        WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id
          AND id=(item->>'productId')::uuid FOR SHARE;
      IF NOT FOUND OR product_row.cost_amount_minor IS NULL THEN missing:=missing+1;
      ELSE total:=total+product_row.cost_amount_minor*(item->>'quantity')::bigint; END IF;
      evidence:=evidence||jsonb_build_array(jsonb_build_object(
        'productId',item->>'productId','name',item->>'name','quantity',(item->>'quantity')::integer,
        'unitCostMinor',product_row.cost_amount_minor,'productUpdatedAt',product_row.updated_at,
        'source',CASE WHEN product_row.cost_amount_minor IS NULL THEN 'unavailable' ELSE 'catalog_product' END));
    END LOOP;
    IF NEW.service_has_meal AND jsonb_array_length(NEW.service_items_snapshot)=0 THEN missing:=1; END IF;
  ELSIF NEW.activity_package_id IS NOT NULL THEN
    -- Legacy packages promise inventory components, not frozen retail product costs.
    missing:=1;
  END IF;
  INSERT INTO mbox.activity_purchase_finance(tenant_id,store_id,registration_id,
    registration_cycle,business_date,purchased_at,goods_cost_minor,missing_cost_count,cost_items)
    VALUES(NEW.tenant_id,NEW.store_id,NEW.id,NEW.registration_cycle,purchase_day,
      NEW.registered_at,CASE WHEN missing=0 THEN total ELSE NULL END,missing,evidence);
  RETURN NEW;
END $$;
CREATE TRIGGER freeze_activity_purchase_finance AFTER INSERT OR UPDATE OF registration_cycle
  ON mbox.community_activity_registrations FOR EACH ROW EXECUTE FUNCTION mbox.freeze_activity_purchase_finance();
CREATE FUNCTION mbox.protect_activity_purchase_finance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Activity purchase finance evidence is immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER protect_activity_purchase_finance BEFORE UPDATE OR DELETE ON mbox.activity_purchase_finance
  FOR EACH ROW EXECUTE FUNCTION mbox.protect_activity_purchase_finance();
REVOKE ALL ON FUNCTION mbox.freeze_activity_purchase_finance(),mbox.protect_activity_purchase_finance() FROM PUBLIC;

UPDATE mbox.normalized_schema_metadata SET schema_version='282',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
