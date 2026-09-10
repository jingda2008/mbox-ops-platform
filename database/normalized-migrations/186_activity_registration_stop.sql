BEGIN;
ALTER TABLE mbox.community_activities ADD COLUMN registration_closed_at timestamptz;
CREATE FUNCTION mbox.guard_stopped_activity_registration() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE stopped timestamptz;
BEGIN
 IF TG_OP='INSERT' OR (OLD.status IN ('waitlisted','cancelled','refunded','no_show') AND NEW.status IN ('reserved','payment_pending','confirmed')) THEN
   SELECT registration_closed_at INTO stopped FROM mbox.community_activities
    WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=NEW.activity_id FOR SHARE;
   IF stopped IS NOT NULL THEN RAISE EXCEPTION 'activity registration is stopped' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER stopped_activity_registration_guard BEFORE INSERT OR UPDATE OF status ON mbox.community_activity_registrations
 FOR EACH ROW EXECUTE FUNCTION mbox.guard_stopped_activity_registration();
REVOKE ALL ON FUNCTION mbox.guard_stopped_activity_registration() FROM PUBLIC;
UPDATE mbox.normalized_schema_metadata SET schema_version='186',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
