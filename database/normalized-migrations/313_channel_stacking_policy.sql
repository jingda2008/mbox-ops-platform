BEGIN;
ALTER TABLE mbox.channel_visits
 ADD COLUMN stacking_allowed boolean,
 ADD COLUMN discount_cap_minor bigint CHECK(discount_cap_minor>0 AND discount_cap_minor<=1000000000);
-- Preserve already-bound legacy promises, without rewriting immutable batch rules.
UPDATE mbox.channel_visits v SET stacking_allowed=(
 SELECT count(*)>1 FROM mbox.channel_activations a
 WHERE (a.tenant_id,a.store_id,a.visit_id)=(v.tenant_id,v.store_id,v.id) AND a.status IN('active','fulfilled')
) WHERE v.source_batch_id IS NOT NULL;
CREATE FUNCTION mbox.freeze_channel_visit_discount_ceiling() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.stacking_allowed IS NOT NULL AND (NEW.stacking_allowed IS NULL OR (NOT OLD.stacking_allowed AND NEW.stacking_allowed))
 THEN RAISE EXCEPTION 'Channel stacking policy cannot be relaxed' USING ERRCODE='23514';END IF;
 IF OLD.discount_cap_minor IS NOT NULL AND (NEW.discount_cap_minor IS NULL OR NEW.discount_cap_minor>OLD.discount_cap_minor)
 THEN RAISE EXCEPTION 'Channel visit discount cap cannot be raised' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER channel_visit_discount_ceiling BEFORE UPDATE ON mbox.channel_visits FOR EACH ROW EXECUTE FUNCTION mbox.freeze_channel_visit_discount_ceiling();
REVOKE ALL ON FUNCTION mbox.freeze_channel_visit_discount_ceiling() FROM PUBLIC;
UPDATE mbox.normalized_schema_metadata SET schema_version='313',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
