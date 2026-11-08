BEGIN;
-- Preserve the opening contract and every historical waiver. A move starts a
-- new minimum snapshot; only subsequent waivers reduce that new requirement.
ALTER TABLE mbox.table_sessions
 ADD COLUMN transfer_minimum_minor bigint CHECK(transfer_minimum_minor BETWEEN 0 AND 9007199254740991),
 ADD COLUMN transfer_waiver_baseline_minor bigint NOT NULL DEFAULT 0 CHECK(transfer_waiver_baseline_minor>=0),
 ADD COLUMN credit_collection_enabled boolean NOT NULL DEFAULT false,
 ADD COLUMN effective_minimum_spend_minor bigint GENERATED ALWAYS AS
 (GREATEST(0,COALESCE(transfer_minimum_minor,minimum_spend_minor)-GREATEST(0,minimum_spend_waiver_minor-transfer_waiver_baseline_minor))) STORED;
DO $$ DECLARE c record;BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='mbox.table_sessions'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%minimum_spend_waiver_minor <= minimum_spend_minor%' LOOP
 EXECUTE format('ALTER TABLE mbox.table_sessions DROP CONSTRAINT %I',c.conname);END LOOP;
END $$;
ALTER TABLE mbox.table_sessions ADD CHECK(minimum_spend_waiver_minor>=transfer_waiver_baseline_minor AND minimum_spend_waiver_minor-transfer_waiver_baseline_minor<=COALESCE(transfer_minimum_minor,minimum_spend_minor));
CREATE TABLE mbox.table_transfer_minimum_snapshots (
 tenant_id uuid NOT NULL,store_id uuid NOT NULL,table_session_id uuid NOT NULL,location_version bigint NOT NULL,
 source_table_id uuid NOT NULL,target_table_id uuid NOT NULL,previous_minimum_minor bigint NOT NULL,new_minimum_minor bigint NOT NULL,
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,store_id,table_session_id,location_version),
 FOREIGN KEY(tenant_id,store_id,table_session_id) REFERENCES mbox.table_sessions(tenant_id,store_id,id)
);
ALTER TABLE mbox.table_transfer_minimum_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.table_transfer_minimum_snapshots FORCE ROW LEVEL SECURITY;
CREATE POLICY transfer_minimum_scope ON mbox.table_transfer_minimum_snapshots USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
GRANT SELECT ON mbox.table_transfer_minimum_snapshots TO mbox_runtime;
CREATE TRIGGER immutable_transfer_minimum BEFORE UPDATE OR DELETE ON mbox.table_transfer_minimum_snapshots FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();
CREATE FUNCTION mbox.snapshot_transfer_minimum() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mbox AS $$
DECLARE new_minimum bigint;
BEGIN
 IF NEW.table_id IS NOT DISTINCT FROM OLD.table_id THEN RETURN NEW;END IF;
 SELECT COALESCE(minimum_spend_minor,0) INTO STRICT new_minimum FROM mbox.tables WHERE(tenant_id,store_id,id)=(NEW.tenant_id,NEW.store_id,NEW.table_id) FOR SHARE;
 NEW.transfer_minimum_minor:=new_minimum;NEW.transfer_waiver_baseline_minor:=OLD.minimum_spend_waiver_minor;
 IF new_minimum>0 OR OLD.minimum_spend_mode='prepaid' THEN NEW.minimum_spend_mode:='prepaid';NEW.credit_collection_enabled:=true;END IF;
 INSERT INTO mbox.table_transfer_minimum_snapshots(tenant_id,store_id,table_session_id,location_version,source_table_id,target_table_id,previous_minimum_minor,new_minimum_minor)
 VALUES(NEW.tenant_id,NEW.store_id,NEW.id,OLD.location_version+1,OLD.table_id,NEW.table_id,OLD.effective_minimum_spend_minor,new_minimum);
 RETURN NEW;
END $$;
-- Runs before the existing minimum/closure guards, which see the new contract.
CREATE TRIGGER a_snapshot_transfer_minimum BEFORE UPDATE OF table_id ON mbox.table_sessions FOR EACH ROW EXECUTE FUNCTION mbox.snapshot_transfer_minimum();
REVOKE ALL ON FUNCTION mbox.snapshot_transfer_minimum() FROM PUBLIC;
DO $$ DECLARE d text;BEGIN
 d:=pg_get_functiondef('mbox.snapshot_minimum_waiver()'::regprocedure);
 EXECUTE replace(d,'minimum_spend_minor-minimum_spend_waiver_minor','effective_minimum_spend_minor');
 d:=pg_get_functiondef('mbox.table_prepayment_unsettled(uuid,uuid,uuid)'::regprocedure);
 EXECUTE replace(d,'session.minimum_spend_minor-session.minimum_spend_waiver_minor','session.effective_minimum_spend_minor');
END $$;
UPDATE mbox.normalized_schema_metadata SET schema_version='302',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
