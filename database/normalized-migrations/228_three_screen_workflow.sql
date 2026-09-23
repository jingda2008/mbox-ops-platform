-- Three-screen workflow: station production, explicit handoff, shared pickup and exact receipt undo.
BEGIN;

-- Implementation fragment for root's migration 228. Do not modify migration 224.
-- Root coordinates ordering after the parallel audit migrations 225-227.

ALTER TABLE mbox.kitchen_production_batches
  ADD COLUMN station_code text NOT NULL DEFAULT 'kitchen';
ALTER TABLE mbox.kitchen_production_batches
  ADD CONSTRAINT kitchen_batch_station_supported CHECK (station_code IN ('kitchen','bar'));

DROP INDEX mbox.kitchen_equipment_one_active_batch;
CREATE UNIQUE INDEX kitchen_equipment_one_active_batch
  ON mbox.kitchen_production_batches(tenant_id,store_id,station_code,equipment_key)
  WHERE equipment_key IS NOT NULL AND released_at IS NULL;
CREATE INDEX kitchen_batches_station_original_order
  ON mbox.kitchen_production_batches(tenant_id,store_id,station_code,anchor_at,created_at,id);

CREATE OR REPLACE FUNCTION mbox.validate_kitchen_unit_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM mbox.order_item_quantity_units unit
    JOIN mbox.kds_tasks task
      ON (task.tenant_id,task.store_id,task.order_item_id)=(unit.tenant_id,unit.store_id,unit.order_item_id)
    JOIN mbox.order_items item
      ON (item.tenant_id,item.store_id,item.id)=(unit.tenant_id,unit.store_id,unit.order_item_id)
    JOIN mbox.kitchen_production_batches batch
      ON (batch.tenant_id,batch.store_id,batch.product_id)=(item.tenant_id,item.store_id,item.product_id)
    WHERE unit.tenant_id=NEW.tenant_id AND unit.store_id=NEW.store_id AND unit.id=NEW.unit_id
      AND task.id=NEW.kds_task_id AND task.station_code=batch.station_code
      AND item.fulfillment_station=batch.station_code AND task.remake_of_task_id IS NULL
      AND batch.id=NEW.batch_id AND unit.production_state IN ('started','ready')
      AND unit.held_by_case_id IS NULL AND NOT unit.operationally_stopped
  ) THEN
    RAISE EXCEPTION 'Production allocation must refer to the original portion and station' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

-- Current responsibility is the latest append-only handoff, falling back to created_by_employee_id.
-- Existing batch/portion history stays immutable; no UPDATE grant or old release guard relaxation.
CREATE TABLE mbox.kitchen_production_handoffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  ownership_version bigint NOT NULL CHECK (ownership_version > 0),
  from_employee_id uuid NOT NULL,
  to_employee_id uuid NOT NULL,
  actor_employee_id uuid NOT NULL,
  operation_key text NOT NULL CHECK (length(operation_key) BETWEEN 1 AND 160),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 2 AND 1000),
  physical_checked boolean NOT NULL CHECK (physical_checked),
  affected_task_ids uuid[] NOT NULL CHECK (cardinality(affected_task_ids) > 0),
  affected_batch_ids uuid[] NOT NULL CHECK (cardinality(affected_batch_ids) > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(tenant_id,store_id,batch_id,ownership_version),
  UNIQUE(tenant_id,store_id,batch_id,operation_key),
  FOREIGN KEY(tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
  FOREIGN KEY(tenant_id,store_id,batch_id) REFERENCES mbox.kitchen_production_batches(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,from_employee_id) REFERENCES mbox.employees(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,to_employee_id) REFERENCES mbox.employees(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,actor_employee_id) REFERENCES mbox.employees(tenant_id,store_id,id),
  CHECK (from_employee_id <> to_employee_id),
  CHECK (to_employee_id = actor_employee_id)
);
CREATE FUNCTION mbox.validate_kitchen_production_handoff() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected_owner uuid; expected_version bigint;
BEGIN
  SELECT created_by_employee_id,0 INTO expected_owner,expected_version FROM mbox.kitchen_production_batches
    WHERE (tenant_id,store_id,id)=(NEW.tenant_id,NEW.store_id,NEW.batch_id) FOR UPDATE;
  IF expected_owner IS NULL THEN RAISE EXCEPTION 'Production batch unavailable' USING ERRCODE='23514'; END IF;
  SELECT change.to_employee_id,change.ownership_version INTO expected_owner,expected_version
    FROM mbox.kitchen_production_handoffs change
    WHERE (change.tenant_id,change.store_id,change.batch_id)=(NEW.tenant_id,NEW.store_id,NEW.batch_id)
    ORDER BY change.ownership_version DESC LIMIT 1;
  IF NOT FOUND THEN
    SELECT created_by_employee_id,0 INTO expected_owner,expected_version FROM mbox.kitchen_production_batches
      WHERE (tenant_id,store_id,id)=(NEW.tenant_id,NEW.store_id,NEW.batch_id);
  END IF;
  IF NEW.from_employee_id<>expected_owner OR NEW.ownership_version<>expected_version+1
    OR NOT NEW.batch_id=ANY(NEW.affected_batch_ids)
    OR EXISTS(SELECT 1 FROM unnest(NEW.affected_batch_ids) AS requested(id) WHERE NOT EXISTS(SELECT 1 FROM mbox.kitchen_production_batches batch WHERE (batch.tenant_id,batch.store_id,batch.id)=(NEW.tenant_id,NEW.store_id,requested.id)))
    OR EXISTS(SELECT 1 FROM unnest(NEW.affected_task_ids) AS requested(id) WHERE NOT EXISTS(SELECT 1 FROM mbox.kds_tasks task WHERE (task.tenant_id,task.store_id,task.id)=(NEW.tenant_id,NEW.store_id,requested.id)))
  THEN RAISE EXCEPTION 'Production handoff version or scoped facts changed' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER kitchen_handoff_binding BEFORE INSERT ON mbox.kitchen_production_handoffs
  FOR EACH ROW EXECUTE FUNCTION mbox.validate_kitchen_production_handoff();
CREATE TRIGGER kitchen_handoffs_immutable BEFORE UPDATE OR DELETE ON mbox.kitchen_production_handoffs
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();
ALTER TABLE mbox.kitchen_production_handoffs ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.kitchen_production_handoffs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.kitchen_production_handoffs
  USING (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())
  WITH CHECK (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
REVOKE ALL ON mbox.kitchen_production_handoffs FROM PUBLIC;
GRANT SELECT,INSERT ON mbox.kitchen_production_handoffs TO mbox_runtime;

-- Handoff writes use the existing durable kitchen_production_receipts table in the same transaction.
-- SQL does not assert a physical release, complete a portion, or change an inventory balance.
-- Root adds the migration's BEGIN/COMMIT and schema metadata update once 228 contents are frozen.


-- Pickup fragment for migration 228. Parent supplies BEGIN/metadata/COMMIT.
CREATE TABLE mbox.pickup_devices (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, store_id uuid NOT NULL,
 device_key_hash text NOT NULL, label text NOT NULL CHECK(length(btrim(label)) BETWEEN 1 AND 40),
 enabled boolean NOT NULL DEFAULT true, configured_by_employee_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,store_id,id), UNIQUE(tenant_id,store_id,device_key_hash),
 FOREIGN KEY(tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
 FOREIGN KEY(tenant_id,store_id,configured_by_employee_id) REFERENCES mbox.employees(tenant_id,store_id,id)
);
CREATE TABLE mbox.pickup_receipts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,
 table_session_id uuid NOT NULL,table_id uuid NOT NULL,location_version bigint NOT NULL,
 device_id uuid NOT NULL,authorized_employee_id uuid NOT NULL,staff_session_id uuid NOT NULL,device_access_lease_id uuid NOT NULL,
 business_date date NOT NULL,taken_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'),
 UNIQUE(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,table_session_id) REFERENCES mbox.table_sessions(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,table_id) REFERENCES mbox.tables(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,device_id) REFERENCES mbox.pickup_devices(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,authorized_employee_id) REFERENCES mbox.employees(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,staff_session_id) REFERENCES mbox.staff_sessions(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,device_access_lease_id) REFERENCES mbox.store_device_access_leases(tenant_id,store_id,id)
);
CREATE INDEX pickup_receipts_history ON mbox.pickup_receipts(tenant_id,store_id,taken_at DESC,id);
CREATE TABLE mbox.pickup_receipt_parts (
 tenant_id uuid NOT NULL,store_id uuid NOT NULL,receipt_id uuid NOT NULL,
 unit_id uuid,remake_unit_id uuid,original_unit_id uuid NOT NULL,kds_task_id uuid NOT NULL,
 expected_version bigint NOT NULL CHECK(expected_version>=0),
 part_key text GENERATED ALWAYS AS (CASE WHEN unit_id IS NOT NULL THEN 'original:'||unit_id::text ELSE 'remake:'||remake_unit_id::text END) STORED,
 PRIMARY KEY(tenant_id,store_id,receipt_id,part_key),CHECK((unit_id IS NULL)<>(remake_unit_id IS NULL)),
 FOREIGN KEY(tenant_id,store_id,receipt_id) REFERENCES mbox.pickup_receipts(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,unit_id) REFERENCES mbox.order_item_quantity_units(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,original_unit_id) REFERENCES mbox.order_item_quantity_units(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,remake_unit_id) REFERENCES mbox.quantity_remake_units(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,kds_task_id) REFERENCES mbox.kds_tasks(tenant_id,store_id,id)
);
CREATE TABLE mbox.pickup_undos (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,receipt_id uuid NOT NULL,
 device_id uuid NOT NULL,authorized_employee_id uuid NOT NULL,staff_session_id uuid NOT NULL,device_access_lease_id uuid NOT NULL,
 undone_at timestamptz NOT NULL DEFAULT clock_timestamp(),physical_still_at_pickup_point boolean NOT NULL CHECK(physical_still_at_pickup_point),
 UNIQUE(tenant_id,store_id,id),UNIQUE(tenant_id,store_id,receipt_id),
 FOREIGN KEY(tenant_id,store_id,receipt_id) REFERENCES mbox.pickup_receipts(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,device_id) REFERENCES mbox.pickup_devices(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,authorized_employee_id) REFERENCES mbox.employees(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,staff_session_id) REFERENCES mbox.staff_sessions(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,device_access_lease_id) REFERENCES mbox.store_device_access_leases(tenant_id,store_id,id)
);
CREATE TABLE mbox.pickup_command_receipts (
 tenant_id uuid NOT NULL,store_id uuid NOT NULL,command_scope text NOT NULL,operation_key text NOT NULL,
 request_body jsonb NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,store_id,command_scope,operation_key),
 FOREIGN KEY(tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id)
);
ALTER TABLE mbox.order_item_quantity_units ADD COLUMN current_pickup_receipt_id uuid,
 ADD COLUMN fulfillment_revision bigint NOT NULL DEFAULT 0 CHECK(fulfillment_revision>=0),
 ADD FOREIGN KEY(tenant_id,store_id,current_pickup_receipt_id) REFERENCES mbox.pickup_receipts(tenant_id,store_id,id);
ALTER TABLE mbox.quantity_remake_units ADD COLUMN current_pickup_receipt_id uuid,
 ADD COLUMN fulfillment_revision bigint NOT NULL DEFAULT 0 CHECK(fulfillment_revision>=0),
 ADD FOREIGN KEY(tenant_id,store_id,current_pickup_receipt_id) REFERENCES mbox.pickup_receipts(tenant_id,store_id,id);

-- Eligibility is shared by DB guards and the application's exact selection.
CREATE FUNCTION mbox.pickup_physical_available(p_tenant uuid,p_store uuid,p_kind text,p_unit uuid)
RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE root_id_value uuid;item_id_value uuid;order_id_value uuid;visit_id_value uuid;batch_id_value uuid;task_id_value uuid;generation_value integer;
BEGIN
 -- Each lookup is anchored by a concrete scoped primary key. Forced-RLS generic
 -- plans must never turn a one-portion check into a cross join of the whole store.
 IF p_kind='original' THEN
  root_id_value:=p_unit;
  IF EXISTS(SELECT 1 FROM mbox.quantity_remake_units WHERE tenant_id=p_tenant AND store_id=p_store AND unit_id=root_id_value) THEN RETURN false;END IF;
 ELSIF p_kind='remake' THEN
  SELECT unit_id,batch_id,generation INTO root_id_value,batch_id_value,generation_value FROM mbox.quantity_remake_units
   WHERE tenant_id=p_tenant AND store_id=p_store AND id=p_unit AND cancelled_at IS NULL;
  IF NOT FOUND THEN RETURN false;END IF;
  IF EXISTS(SELECT 1 FROM mbox.quantity_remake_units WHERE tenant_id=p_tenant AND store_id=p_store AND unit_id=root_id_value AND generation>generation_value) THEN RETURN false;END IF;
  SELECT kds_task_id INTO task_id_value FROM mbox.quantity_remake_batches WHERE tenant_id=p_tenant AND store_id=p_store AND id=batch_id_value;
  IF NOT FOUND THEN RETURN false;END IF;
  IF NOT EXISTS(SELECT 1 FROM mbox.kds_tasks WHERE tenant_id=p_tenant AND store_id=p_store AND id=task_id_value AND station_code IN ('bar','kitchen') AND status NOT IN ('cancelled','failed')) THEN RETURN false;END IF;
 ELSE RETURN false;
 END IF;
 SELECT order_item_id INTO item_id_value FROM mbox.order_item_quantity_units
  WHERE tenant_id=p_tenant AND store_id=p_store AND id=root_id_value AND held_by_case_id IS NULL AND NOT operationally_stopped
   AND closed_by_order_event_id IS NULL AND closed_by_turnover_event_id IS NULL;
 IF NOT FOUND THEN RETURN false;END IF;
 IF EXISTS(SELECT 1 FROM mbox.quantity_redelivery_units WHERE tenant_id=p_tenant AND store_id=p_store AND unit_id=root_id_value AND outcome IS NULL) THEN RETURN false;END IF;
 IF p_kind='original' AND NOT EXISTS(SELECT 1 FROM mbox.kds_tasks WHERE tenant_id=p_tenant AND store_id=p_store AND order_item_id=item_id_value
  AND remake_of_task_id IS NULL AND station_code IN ('bar','kitchen') AND status NOT IN ('cancelled','failed')) THEN RETURN false;END IF;
 SELECT order_id INTO order_id_value FROM mbox.order_items WHERE tenant_id=p_tenant AND store_id=p_store AND id=item_id_value AND status<>'cancelled';
 IF NOT FOUND THEN RETURN false;END IF;
 SELECT table_session_id INTO visit_id_value FROM mbox.orders WHERE tenant_id=p_tenant AND store_id=p_store AND id=order_id_value AND status<>'cancelled';
 IF NOT FOUND THEN RETURN false;END IF;
 RETURN EXISTS(SELECT 1 FROM mbox.table_sessions WHERE tenant_id=p_tenant AND store_id=p_store AND id=visit_id_value AND status IN ('open','closing'));
END $$;
CREATE FUNCTION mbox.pickup_undo_transition(old_part jsonb,new_part jsonb,part_kind text)
RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE tenant_value uuid:=(old_part->>'tenant_id')::uuid;store_value uuid:=(old_part->>'store_id')::uuid;
 root_id_value uuid;item_id_value uuid;order_id_value uuid;visit_id_value uuid;receipt_value record;visit_value record;
BEGIN
 IF old_part->>'production_state' IS DISTINCT FROM 'delivered' OR new_part->>'production_state' IS DISTINCT FROM 'ready'
  OR old_part->>'current_pickup_receipt_id' IS NULL OR new_part->>'current_pickup_receipt_id' IS NOT NULL
  OR (new_part->>'fulfillment_revision')::bigint IS DISTINCT FROM (old_part->>'fulfillment_revision')::bigint+1
 THEN RETURN false;END IF;
 IF NOT mbox.pickup_physical_available(tenant_value,store_value,part_kind,(old_part->>'id')::uuid) THEN RETURN false;END IF;
 SELECT original_unit_id INTO root_id_value FROM mbox.pickup_receipt_parts
  WHERE tenant_id=tenant_value AND store_id=store_value AND receipt_id=(old_part->>'current_pickup_receipt_id')::uuid
   AND part_key=part_kind||':'||(old_part->>'id') AND expected_version+1=(old_part->>'fulfillment_revision')::bigint;
 IF NOT FOUND THEN RETURN false;END IF;
 IF NOT EXISTS(SELECT 1 FROM mbox.pickup_undos WHERE tenant_id=tenant_value AND store_id=store_value AND receipt_id=(old_part->>'current_pickup_receipt_id')::uuid) THEN RETURN false;END IF;
 SELECT table_session_id,table_id,location_version INTO receipt_value FROM mbox.pickup_receipts WHERE tenant_id=tenant_value AND store_id=store_value AND id=(old_part->>'current_pickup_receipt_id')::uuid;
 IF NOT FOUND THEN RETURN false;END IF;
 SELECT order_item_id INTO item_id_value FROM mbox.order_item_quantity_units WHERE tenant_id=tenant_value AND store_id=store_value AND id=root_id_value;
 IF NOT FOUND THEN RETURN false;END IF;
 SELECT order_id INTO order_id_value FROM mbox.order_items WHERE tenant_id=tenant_value AND store_id=store_value AND id=item_id_value;
 IF NOT FOUND THEN RETURN false;END IF;
 SELECT table_session_id INTO visit_id_value FROM mbox.orders WHERE tenant_id=tenant_value AND store_id=store_value AND id=order_id_value;
 IF NOT FOUND THEN RETURN false;END IF;
 SELECT id,table_id,location_version INTO visit_value FROM mbox.table_sessions WHERE tenant_id=tenant_value AND store_id=store_value AND id=visit_id_value;
 IF NOT FOUND THEN RETURN false;END IF;
 RETURN (receipt_value.table_session_id,receipt_value.table_id,receipt_value.location_version)=(visit_value.id,visit_value.table_id,visit_value.location_version);
END $$;
CREATE FUNCTION mbox.guard_pickup_actor_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE credential_id_value uuid;device_hash_value text;
BEGIN
 PERFORM 1 FROM mbox.staff_sessions WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=NEW.staff_session_id
  AND employee_id=NEW.authorized_employee_id AND device_access_lease_id=NEW.device_access_lease_id AND revoked_at IS NULL
  AND expires_at>clock_timestamp() AND online_lease_until>clock_timestamp() FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'pickup source session invalid' USING ERRCODE='23514';END IF;
 PERFORM 1 FROM mbox.employees WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=NEW.authorized_employee_id AND status='active' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'pickup source employee invalid' USING ERRCODE='23514';END IF;
 SELECT daily_credential_id,device_key_hash INTO credential_id_value,device_hash_value FROM mbox.store_device_access_leases
  WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=NEW.device_access_lease_id AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'pickup source lease invalid' USING ERRCODE='23514';END IF;
 PERFORM 1 FROM mbox.store_daily_credentials WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=credential_id_value
  AND revoked_at IS NULL AND valid_from<=clock_timestamp() AND valid_until>clock_timestamp() FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'pickup source daily credential invalid' USING ERRCODE='23514';END IF;
 PERFORM 1 FROM mbox.pickup_devices WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=NEW.device_id AND device_key_hash=device_hash_value AND enabled FOR SHARE;
 IF NOT FOUND OR NOT mbox.employee_has_effective_permission(NEW.tenant_id,NEW.store_id,NEW.authorized_employee_id,'kds.deliver') THEN
  RAISE EXCEPTION 'pickup source must be a current authorized shared device session' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pickup_receipt_actor BEFORE INSERT ON mbox.pickup_receipts FOR EACH ROW EXECUTE FUNCTION mbox.guard_pickup_actor_source();
CREATE TRIGGER pickup_undo_actor BEFORE INSERT ON mbox.pickup_undos FOR EACH ROW EXECUTE FUNCTION mbox.guard_pickup_actor_source();

-- Preserve every old trigger check; permit only the new exact-receipt reversal.
DO $$ DECLARE source text;changed text;needle text;BEGIN
 source:=pg_get_functiondef('mbox.protect_quantity_unit_identity()'::regprocedure);
 needle:='< array_position(ARRAY[''unmade'',''started'',''ready'',''delivered''],OLD.production_state) THEN';
 changed:=replace(source,needle,'< array_position(ARRAY[''unmade'',''started'',''ready'',''delivered''],OLD.production_state) AND NOT mbox.pickup_undo_transition(to_jsonb(OLD),to_jsonb(NEW),''original'') THEN');
 IF changed=source THEN RAISE EXCEPTION 'original quantity monotonic guard signature changed';END IF;EXECUTE changed;
 source:=pg_get_functiondef('mbox.guard_quantity_remake_unit()'::regprocedure);
 needle:='OR array_position(ARRAY[''unmade'',''started'',''ready'',''delivered''],NEW.production_state)<array_position(ARRAY[''unmade'',''started'',''ready'',''delivered''],OLD.production_state)';
 changed:=replace(source,needle,'OR (array_position(ARRAY[''unmade'',''started'',''ready'',''delivered''],NEW.production_state)<array_position(ARRAY[''unmade'',''started'',''ready'',''delivered''],OLD.production_state) AND NOT mbox.pickup_undo_transition(to_jsonb(OLD),to_jsonb(NEW),''remake''))');
 IF changed=source THEN RAISE EXCEPTION 'remake monotonic guard signature changed';END IF;EXECUTE changed;
END $$;
CREATE FUNCTION mbox.guard_pickup_unit_pointer() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE kind text;root_id_value uuid;item_id_value uuid;order_id_value uuid;visit_id_value uuid;receipt_value record;visit_value record;
BEGIN
 kind:=CASE WHEN TG_TABLE_NAME='quantity_remake_units' THEN 'remake' ELSE 'original' END;
 IF TG_OP='INSERT' THEN
  IF NEW.current_pickup_receipt_id IS NOT NULL OR NEW.fulfillment_revision<>0 THEN RAISE EXCEPTION 'new quantity starts without pickup history' USING ERRCODE='23514';END IF;
 ELSIF (NEW.current_pickup_receipt_id,NEW.fulfillment_revision) IS DISTINCT FROM (OLD.current_pickup_receipt_id,OLD.fulfillment_revision) THEN
  IF mbox.pickup_undo_transition(to_jsonb(OLD),to_jsonb(NEW),kind) THEN RETURN NEW;END IF;
  IF OLD.production_state<>'ready' OR NEW.production_state<>'delivered' OR OLD.current_pickup_receipt_id IS NOT NULL
   OR NEW.current_pickup_receipt_id IS NULL OR NEW.fulfillment_revision<>OLD.fulfillment_revision+1
   OR NOT mbox.pickup_physical_available(NEW.tenant_id,NEW.store_id,kind,NEW.id)
  THEN RAISE EXCEPTION 'pickup pointer must bind an exact current receipt transition' USING ERRCODE='23514';END IF;
  SELECT original_unit_id INTO root_id_value FROM mbox.pickup_receipt_parts WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id
   AND receipt_id=NEW.current_pickup_receipt_id AND part_key=kind||':'||NEW.id::text AND expected_version=OLD.fulfillment_revision;
  IF NOT FOUND THEN RAISE EXCEPTION 'pickup pointer has no exact frozen portion' USING ERRCODE='23514';END IF;
  IF EXISTS(SELECT 1 FROM mbox.pickup_undos WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND receipt_id=NEW.current_pickup_receipt_id) THEN RAISE EXCEPTION 'pickup receipt already undone' USING ERRCODE='23514';END IF;
  SELECT table_session_id,table_id,location_version INTO receipt_value FROM mbox.pickup_receipts WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=NEW.current_pickup_receipt_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'pickup receipt missing' USING ERRCODE='23514';END IF;
  SELECT order_item_id INTO item_id_value FROM mbox.order_item_quantity_units WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=root_id_value;
  IF NOT FOUND THEN RAISE EXCEPTION 'pickup root missing' USING ERRCODE='23514';END IF;
  SELECT order_id INTO order_id_value FROM mbox.order_items WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=item_id_value;
  IF NOT FOUND THEN RAISE EXCEPTION 'pickup item missing' USING ERRCODE='23514';END IF;
  SELECT table_session_id INTO visit_id_value FROM mbox.orders WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=order_id_value;
  IF NOT FOUND THEN RAISE EXCEPTION 'pickup order missing' USING ERRCODE='23514';END IF;
  SELECT id,table_id,location_version INTO visit_value FROM mbox.table_sessions WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=visit_id_value;
  IF NOT FOUND OR (receipt_value.table_session_id,receipt_value.table_id,receipt_value.location_version) IS DISTINCT FROM (visit_value.id,visit_value.table_id,visit_value.location_version)
  THEN RAISE EXCEPTION 'pickup original table location changed' USING ERRCODE='23514';END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER quantity_pickup_pointer BEFORE INSERT OR UPDATE ON mbox.order_item_quantity_units FOR EACH ROW EXECUTE FUNCTION mbox.guard_pickup_unit_pointer();
CREATE TRIGGER remake_pickup_pointer BEFORE INSERT OR UPDATE ON mbox.quantity_remake_units FOR EACH ROW EXECUTE FUNCTION mbox.guard_pickup_unit_pointer();

CREATE FUNCTION mbox.guard_pickup_part_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item_id_value uuid;task_value record;remake_value record;batch_task_value uuid;snapshot_value jsonb;
BEGIN
 SELECT order_item_id INTO item_id_value FROM mbox.order_item_quantity_units WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=NEW.original_unit_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'pickup original portion missing' USING ERRCODE='23514';END IF;
 SELECT order_item_id,remake_of_task_id INTO task_value FROM mbox.kds_tasks WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=NEW.kds_task_id;
 IF NOT FOUND OR task_value.order_item_id IS DISTINCT FROM item_id_value THEN RAISE EXCEPTION 'pickup task does not bind original item' USING ERRCODE='23514';END IF;
 IF NEW.unit_id IS NOT NULL THEN
  IF NEW.unit_id<>NEW.original_unit_id OR task_value.remake_of_task_id IS NOT NULL THEN RAISE EXCEPTION 'pickup original task mismatch' USING ERRCODE='23514';END IF;
 ELSE
  SELECT unit_id,batch_id INTO remake_value FROM mbox.quantity_remake_units WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=NEW.remake_unit_id;
  IF NOT FOUND OR remake_value.unit_id IS DISTINCT FROM NEW.original_unit_id THEN RAISE EXCEPTION 'pickup remake root mismatch' USING ERRCODE='23514';END IF;
  SELECT kds_task_id INTO batch_task_value FROM mbox.quantity_remake_batches WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=remake_value.batch_id;
  IF NOT FOUND OR batch_task_value IS DISTINCT FROM NEW.kds_task_id THEN RAISE EXCEPTION 'pickup remake task mismatch' USING ERRCODE='23514';END IF;
 END IF;
 SELECT snapshot INTO snapshot_value FROM mbox.pickup_receipts WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=NEW.receipt_id;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(snapshot_value->'units') AS snap(value)
  WHERE snap.value->>'unitId'=COALESCE(NEW.unit_id,NEW.remake_unit_id)::text
   AND snap.value->>'kind'=CASE WHEN NEW.unit_id IS NULL THEN 'remake' ELSE 'original' END
   AND snap.value->>'originalUnitId'=NEW.original_unit_id::text AND snap.value->>'taskId'=NEW.kds_task_id::text AND (snap.value->>'version')::bigint=NEW.expected_version)
 THEN RAISE EXCEPTION 'pickup part must match its frozen receipt' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pickup_part_binding BEFORE INSERT ON mbox.pickup_receipt_parts FOR EACH ROW EXECUTE FUNCTION mbox.guard_pickup_part_binding();

CREATE FUNCTION mbox.check_pickup_receipt_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE receipt_id_value uuid;is_undo boolean;expected_count bigint;actual_count bigint;part_value record;unit_value record;
BEGIN
 is_undo:=TG_TABLE_NAME='pickup_undos';receipt_id_value:=(to_jsonb(NEW)->>CASE WHEN TG_TABLE_NAME='pickup_receipts' THEN 'id' ELSE 'receipt_id' END)::uuid;
 SELECT jsonb_array_length(snapshot->'units') INTO expected_count FROM mbox.pickup_receipts WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=receipt_id_value;
 SELECT count(*) INTO actual_count FROM mbox.pickup_receipt_parts WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND receipt_id=receipt_id_value;
 IF actual_count=0 OR actual_count IS DISTINCT FROM expected_count THEN RAISE EXCEPTION 'pickup receipt must include every frozen portion' USING ERRCODE='23514';END IF;
 FOR part_value IN SELECT unit_id,remake_unit_id,expected_version FROM mbox.pickup_receipt_parts WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND receipt_id=receipt_id_value LOOP
  IF part_value.unit_id IS NOT NULL THEN
   SELECT production_state,current_pickup_receipt_id,fulfillment_revision INTO unit_value FROM mbox.order_item_quantity_units WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=part_value.unit_id;
  ELSE
   SELECT production_state,current_pickup_receipt_id,fulfillment_revision INTO unit_value FROM mbox.quantity_remake_units WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=part_value.remake_unit_id;
  END IF;
  IF NOT FOUND OR (CASE WHEN is_undo THEN unit_value.production_state<>'ready' OR unit_value.current_pickup_receipt_id IS NOT NULL OR unit_value.fulfillment_revision<>part_value.expected_version+2
   ELSE unit_value.production_state<>'delivered' OR unit_value.current_pickup_receipt_id IS DISTINCT FROM receipt_id_value OR unit_value.fulfillment_revision<>part_value.expected_version+1 END)
  THEN RAISE EXCEPTION 'pickup receipt and physical portions must commit together' USING ERRCODE='23514';END IF;
 END LOOP;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER pickup_receipt_complete AFTER INSERT ON mbox.pickup_receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION mbox.check_pickup_receipt_complete();
CREATE CONSTRAINT TRIGGER pickup_undo_complete AFTER INSERT ON mbox.pickup_undos DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION mbox.check_pickup_receipt_complete();
-- A receipt checks its whole frozen set once. Parts are immutable, unique by
-- physical key and must be snapshot members, so a committed full set cannot grow.
DO $$ DECLARE relation text;signature text;BEGIN
 FOREACH relation IN ARRAY ARRAY['pickup_devices','pickup_receipts','pickup_receipt_parts','pickup_undos','pickup_command_receipts'] LOOP
  EXECUTE format('ALTER TABLE mbox.%I ENABLE ROW LEVEL SECURITY',relation);EXECUTE format('ALTER TABLE mbox.%I FORCE ROW LEVEL SECURITY',relation);
  EXECUTE format('CREATE POLICY store_scope ON mbox.%I USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())',relation);
  EXECUTE format('GRANT SELECT,INSERT ON mbox.%I TO mbox_runtime',relation);
  IF relation<>'pickup_devices' THEN EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON mbox.%I FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change()',relation);END IF;
 END LOOP;
 FOREACH signature IN ARRAY ARRAY['mbox.pickup_physical_available(uuid,uuid,text,uuid)','mbox.pickup_undo_transition(jsonb,jsonb,text)','mbox.guard_pickup_unit_pointer()','mbox.check_pickup_receipt_complete()','mbox.guard_pickup_part_binding()','mbox.guard_pickup_actor_source()'] LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||signature||' FROM PUBLIC';END LOOP;
END $$;
GRANT UPDATE(enabled,label,configured_by_employee_id,updated_at) ON mbox.pickup_devices TO mbox_runtime;
GRANT EXECUTE ON FUNCTION mbox.pickup_physical_available(uuid,uuid,text,uuid),mbox.pickup_undo_transition(jsonb,jsonb,text) TO mbox_runtime;

-- Current physical fulfillment is separate from the immutable, already consumed benefit grant.
CREATE FUNCTION mbox.pickup_order_current_fulfillment(p_tenant uuid,p_store uuid,p_order uuid)
RETURNS text LANGUAGE sql STABLE AS $$
 WITH current_parts AS (
  SELECT COALESCE(latest.production_state,unit.production_state) AS state
  FROM mbox.order_items item JOIN mbox.order_item_quantity_units unit
    ON (unit.tenant_id,unit.store_id,unit.order_item_id)=(item.tenant_id,item.store_id,item.id)
  LEFT JOIN LATERAL (SELECT remake.production_state,remake.cancelled_at FROM mbox.quantity_remake_units remake
    WHERE (remake.tenant_id,remake.store_id,remake.unit_id)=(unit.tenant_id,unit.store_id,unit.id) ORDER BY remake.generation DESC LIMIT 1) latest ON true
  WHERE item.tenant_id=p_tenant AND item.store_id=p_store AND item.order_id=p_order AND item.status<>'cancelled'
    AND NOT unit.operationally_stopped AND latest.cancelled_at IS NULL
 ), fallback AS (
  SELECT CASE WHEN item.status='delivered' THEN 'delivered' WHEN task.status='ready' THEN 'ready' ELSE 'unmade' END AS state
  FROM mbox.order_items item LEFT JOIN mbox.kds_tasks task
    ON (task.tenant_id,task.store_id,task.order_item_id)=(item.tenant_id,item.store_id,item.id) AND task.remake_of_task_id IS NULL
  WHERE item.tenant_id=p_tenant AND item.store_id=p_store AND item.order_id=p_order AND item.fulfillment_station IN ('bar','kitchen') AND item.status<>'cancelled'
   AND NOT EXISTS(SELECT 1 FROM mbox.order_item_quantity_units unit WHERE (unit.tenant_id,unit.store_id,unit.order_item_id)=(item.tenant_id,item.store_id,item.id))
 ), all_parts AS (SELECT state FROM current_parts UNION ALL SELECT state FROM fallback)
 SELECT CASE WHEN p_order IS NULL THEN NULL WHEN NOT EXISTS(SELECT 1 FROM all_parts) THEN 'cancelled'
   WHEN EXISTS(SELECT 1 FROM all_parts WHERE state IN ('unmade','started')) THEN 'pending'
   WHEN EXISTS(SELECT 1 FROM all_parts WHERE state='ready') THEN 'ready' ELSE 'delivered' END
$$;
REVOKE ALL ON FUNCTION mbox.pickup_order_current_fulfillment(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mbox.pickup_order_current_fulfillment(uuid,uuid,uuid) TO mbox_runtime;

UPDATE mbox.normalized_schema_metadata SET schema_version='228',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';
COMMIT;
