BEGIN;
ALTER TABLE mbox.community_activity_packages ADD COLUMN choice_groups jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(choice_groups)='array' AND jsonb_array_length(choice_groups)<=5);
CREATE FUNCTION mbox.guard_activity_package_choices() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.status<>'draft' AND NEW.choice_groups IS DISTINCT FROM OLD.choice_groups THEN RAISE EXCEPTION 'published activity choices are immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER activity_package_choices_immutable BEFORE UPDATE OF choice_groups ON mbox.community_activity_packages FOR EACH ROW EXECUTE FUNCTION mbox.guard_activity_package_choices();
CREATE OR REPLACE FUNCTION mbox.guard_stopped_activity_registration() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE stopped timestamptz; addon_allowed boolean;
BEGIN
 IF TG_OP='INSERT' OR (OLD.status IN('waitlisted','cancelled','refunded','no_show') AND NEW.status IN('reserved','payment_pending','confirmed')) THEN
  SELECT registration_closed_at, status IN('published','full') AND clock_timestamp()<LEAST(COALESCE(addon_ends_at,ends_at),COALESCE(meal_service_ends_at,ends_at)) INTO stopped,addon_allowed
  FROM mbox.community_activities WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=NEW.activity_id FOR SHARE;
  IF stopped IS NOT NULL AND NOT (NEW.service_version=3 AND NOT NEW.includes_admission AND NEW.reserved_seats=0 AND NEW.parent_registration_id IS NOT NULL AND NEW.purchase_kind IN('meal_package','single_dish') AND addon_allowed) THEN RAISE EXCEPTION 'activity registration is stopped' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION mbox.guard_activity_package_choices() FROM PUBLIC;
UPDATE mbox.normalized_schema_metadata SET schema_version='280',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
