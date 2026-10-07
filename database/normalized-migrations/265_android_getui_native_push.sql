BEGIN;
-- Add one explicit provider pair. Keep the existing APNs binding and RLS guards.
ALTER TABLE mbox.native_push_installations DROP CONSTRAINT native_push_installations_platform_check;
ALTER TABLE mbox.native_push_installations DROP CONSTRAINT native_push_installations_provider_check;
ALTER TABLE mbox.native_push_installations ADD CONSTRAINT native_push_installations_provider_pair_check
 CHECK ((platform='ios' AND provider='apns') OR
        (platform='android' AND provider='getui' AND environment='production' AND permission='authorized'));
-- An installation UUID belongs permanently to one platform/provider, even when
-- revision changes. Account rotation and revocation cannot turn it into another app.
CREATE FUNCTION mbox.guard_native_push_provider() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.platform,NEW.provider) IS DISTINCT FROM (OLD.platform,OLD.provider)
 THEN RAISE EXCEPTION 'native push provider identity is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER native_push_provider_guard BEFORE UPDATE ON mbox.native_push_installations
 FOR EACH ROW EXECUTE FUNCTION mbox.guard_native_push_provider();
REVOKE ALL ON FUNCTION mbox.guard_native_push_provider() FROM PUBLIC;
COMMIT;
