BEGIN;
-- Partner website authentication is independent of customer memberships and staff sessions.
CREATE TABLE mbox.channel_web_accounts(
 tenant_id uuid NOT NULL, store_id uuid NOT NULL, promoter_id uuid NOT NULL,
 username text NOT NULL CHECK(username ~ '^[a-z0-9][a-z0-9_-]{3,39}$'), password_hash text NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,store_id,promoter_id), UNIQUE(tenant_id,store_id,username),
 FOREIGN KEY(tenant_id,store_id,promoter_id) REFERENCES mbox.channel_promoters(tenant_id,store_id,id)
);
CREATE TABLE mbox.channel_web_invitations(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,promoter_id uuid NOT NULL,
 token_hash text NOT NULL CHECK(length(token_hash)=64), expires_at timestamptz NOT NULL, accepted_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(tenant_id,store_id,token_hash),
 FOREIGN KEY(tenant_id,store_id,promoter_id) REFERENCES mbox.channel_promoters(tenant_id,store_id,id)
);
CREATE TABLE mbox.channel_web_sessions(
 tenant_id uuid NOT NULL,store_id uuid NOT NULL,token_hash text NOT NULL CHECK(length(token_hash)=64),promoter_id uuid NOT NULL,
 expires_at timestamptz NOT NULL,revoked_at timestamptz,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,store_id,token_hash),
 FOREIGN KEY(tenant_id,store_id,promoter_id) REFERENCES mbox.channel_web_accounts(tenant_id,store_id,promoter_id)
);
CREATE INDEX channel_web_sessions_promoter ON mbox.channel_web_sessions(tenant_id,store_id,promoter_id);
ALTER TABLE mbox.channel_statements ADD COLUMN confirmed_by_promoter_id uuid,
 ADD FOREIGN KEY(tenant_id,store_id,confirmed_by_promoter_id) REFERENCES mbox.channel_promoters(tenant_id,store_id,id),
 ADD CHECK(confirmed_by IS NULL OR confirmed_by_promoter_id IS NULL),
 ADD CHECK(confirmed_by_promoter_id IS NULL OR confirmed_by_promoter_id=promoter_id);
DO $$ DECLARE n text; BEGIN
 FOREACH n IN ARRAY ARRAY['channel_web_accounts','channel_web_invitations','channel_web_sessions'] LOOP
 EXECUTE format('ALTER TABLE mbox.%I ENABLE ROW LEVEL SECURITY',n);
 EXECUTE format('ALTER TABLE mbox.%I FORCE ROW LEVEL SECURITY',n);
 EXECUTE format('CREATE POLICY scoped ON mbox.%I USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())',n);
 EXECUTE format('GRANT SELECT,INSERT ON mbox.%I TO mbox_runtime',n);
 END LOOP;
END $$;
GRANT UPDATE(username,password_hash,updated_at) ON mbox.channel_web_accounts TO mbox_runtime;
GRANT UPDATE(expires_at,accepted_at) ON mbox.channel_web_invitations TO mbox_runtime;
GRANT UPDATE(revoked_at) ON mbox.channel_web_sessions TO mbox_runtime;
CREATE FUNCTION mbox.guard_channel_web_credentials() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_TABLE_NAME='channel_web_sessions' THEN
  IF OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL THEN RAISE EXCEPTION 'Session revocation is final'; END IF;
 ELSIF TG_TABLE_NAME='channel_web_invitations' THEN
  IF OLD.accepted_at IS NOT NULL OR NEW.expires_at>OLD.expires_at THEN RAISE EXCEPTION 'Invitation consumption is final'; END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION mbox.guard_channel_web_credentials() FROM PUBLIC;
CREATE TRIGGER guarded_update BEFORE UPDATE ON mbox.channel_web_sessions FOR EACH ROW EXECUTE FUNCTION mbox.guard_channel_web_credentials();
CREATE TRIGGER guarded_update BEFORE UPDATE ON mbox.channel_web_invitations FOR EACH ROW EXECUTE FUNCTION mbox.guard_channel_web_credentials();
CREATE OR REPLACE FUNCTION mbox.guard_channel_finance_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_TABLE_NAME='channel_statement_lines' THEN
  IF (to_jsonb(NEW)-'released_at') IS DISTINCT FROM (to_jsonb(OLD)-'released_at') OR OLD.released_at IS NOT NULL OR NEW.released_at IS NULL THEN RAISE EXCEPTION 'Statement line immutable';END IF;
 ELSIF TG_TABLE_NAME='channel_statements' THEN
  IF (to_jsonb(NEW)-ARRAY['status','confirmed_by','confirmed_by_promoter_id','approved_by','approved_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','confirmed_by','confirmed_by_promoter_id','approved_by','approved_at'])
  OR NOT ((OLD.status='pending' AND NEW.status IN('confirmed','disputed','cancelled')) OR (OLD.status='confirmed' AND NEW.status IN('approved','disputed','cancelled')) OR (OLD.status='disputed' AND NEW.status='cancelled') OR (OLD.status='approved' AND NEW.status='cancelled')) THEN RAISE EXCEPTION 'Invalid statement transition';END IF;
 ELSIF TG_TABLE_NAME='channel_payouts' THEN
  IF OLD.status<>'unknown' OR NEW.status='unknown' OR (to_jsonb(NEW)-ARRAY['status','receipt_reference','confirmed_by','confirmed_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','receipt_reference','confirmed_by','confirmed_at']) THEN RAISE EXCEPTION 'Payout facts immutable';END IF;
 ELSIF TG_TABLE_NAME='channel_settlement_accounts' THEN
  IF (to_jsonb(NEW)-ARRAY['verified_by','verified_at','revoked_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['verified_by','verified_at','revoked_at']) OR OLD.revoked_at IS NOT NULL OR (OLD.verified_at IS NOT NULL AND (NEW.verified_at,NEW.verified_by) IS DISTINCT FROM (OLD.verified_at,OLD.verified_by)) THEN RAISE EXCEPTION 'Account version immutable';END IF;
 END IF;RETURN NEW;END $$;
UPDATE mbox.normalized_schema_metadata SET schema_version='314',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
