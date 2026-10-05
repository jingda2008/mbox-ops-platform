BEGIN;

ALTER TABLE mbox.staff_sessions ADD CONSTRAINT staff_sessions_push_binding_uq
  UNIQUE(tenant_id,store_id,id,employee_id,device_access_lease_id);
ALTER TABLE mbox.staff_sessions ADD CONSTRAINT staff_sessions_push_actor_uq UNIQUE(tenant_id,store_id,id,employee_id);
ALTER TABLE mbox.service_tasks ADD CONSTRAINT service_tasks_push_session_uq UNIQUE(tenant_id,store_id,id,table_session_id);
ALTER TABLE mbox.service_task_events ADD CONSTRAINT service_task_events_push_source_uq
  UNIQUE(tenant_id,store_id,id,service_task_id);

CREATE TABLE mbox.native_push_installations (
  tenant_id uuid NOT NULL, store_id uuid NOT NULL, id uuid NOT NULL,
  employee_id uuid NOT NULL, staff_session_id uuid NOT NULL, device_access_lease_id uuid NOT NULL,
  device_key_hash char(64) NOT NULL CHECK(device_key_hash ~ '^[a-f0-9]{64}$'),
  revision bigint NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
  platform text NOT NULL CHECK(platform='ios'), provider text NOT NULL CHECK(provider='apns'),
  environment text NOT NULL CHECK(environment IN('sandbox','production')), topic text NOT NULL CHECK(length(topic) BETWEEN 3 AND 200),
  token_ciphertext bytea NOT NULL, token_key_id text NOT NULL, token_hash char(64) NOT NULL CHECK(token_hash ~ '^[a-f0-9]{64}$'),
  revocation_hash char(64) NOT NULL CHECK(revocation_hash ~ '^[a-f0-9]{64}$'),
  event_ttl_seconds integer NOT NULL DEFAULT 300 CHECK(event_ttl_seconds BETWEEN 1 AND 900),
  permission text NOT NULL CHECK(permission IN('authorized','provisional')),
  app_version text NOT NULL CHECK(length(app_version) BETWEEN 1 AND 64),
  status text NOT NULL CHECK(status IN('active','revoked','invalid_token')),
  registered_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL,
  last_request_key text NOT NULL, updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
  FOREIGN KEY(tenant_id,store_id,staff_session_id,employee_id,device_access_lease_id)
    REFERENCES mbox.staff_sessions(tenant_id,store_id,id,employee_id,device_access_lease_id),
  CHECK(expires_at>registered_at)
);
CREATE UNIQUE INDEX native_push_active_token_uq ON mbox.native_push_installations(tenant_id,store_id,provider,environment,topic,token_hash) WHERE status='active';
CREATE INDEX native_push_active_scope_idx ON mbox.native_push_installations(tenant_id,store_id,expires_at) WHERE status='active';

-- Deliberately independent of installations: a revoke may arrive before its PUT.
-- Never expire these tombstones while the matching original command can replay.
CREATE TABLE mbox.native_push_revocation_tombstones (
  tenant_id uuid NOT NULL,store_id uuid NOT NULL,installation_id uuid NOT NULL,
  revision bigint NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
  secret_hash char(64) NOT NULL CHECK(secret_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,store_id,installation_id,revision,secret_hash),
  FOREIGN KEY(tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id)
);
CREATE TRIGGER native_push_revocation_append_only BEFORE UPDATE OR DELETE ON mbox.native_push_revocation_tombstones
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();

CREATE TABLE mbox.native_push_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,
  source_event_id uuid NOT NULL, task_id uuid NOT NULL,table_session_id uuid NOT NULL,
  event_type text NOT NULL CHECK(event_type IN('task.created','task.assign','task.priority','task.backup_assigned','task.escalated','task.reminded')),
  occurred_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,projected_at timestamptz,
  UNIQUE(tenant_id,store_id,id),UNIQUE(tenant_id,store_id,source_event_id),
  FOREIGN KEY(tenant_id,store_id,source_event_id,task_id) REFERENCES mbox.service_task_events(tenant_id,store_id,id,service_task_id),
  FOREIGN KEY(tenant_id,store_id,task_id,table_session_id) REFERENCES mbox.service_tasks(tenant_id,store_id,id,table_session_id),
  CHECK(expires_at>occurred_at AND expires_at<=occurred_at+interval '15 minutes')
);
CREATE INDEX native_push_events_pending_idx ON mbox.native_push_events(tenant_id,store_id,occurred_at,id) WHERE projected_at IS NULL;

CREATE TABLE mbox.native_push_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,
  event_id uuid NOT NULL,installation_id uuid NOT NULL,binding_revision bigint NOT NULL CHECK(binding_revision>0),
  employee_id uuid NOT NULL,staff_session_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','sending','retry','provider_accepted','unknown','rejected','cancelled','expired')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 10),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),locked_by text,locked_at timestamptz,
  provider_request_id uuid NOT NULL DEFAULT gen_random_uuid(),provider_accepted_at timestamptz,
  client_reported_received_at timestamptz,client_reported_opened_at timestamptz,
  failure_code text CHECK(failure_code IS NULL OR failure_code ~ '^[A-Z0-9_]{1,64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(tenant_id,store_id,id),UNIQUE(tenant_id,store_id,event_id,installation_id,binding_revision),
  FOREIGN KEY(tenant_id,store_id,event_id) REFERENCES mbox.native_push_events(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,installation_id) REFERENCES mbox.native_push_installations(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,employee_id) REFERENCES mbox.employees(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,staff_session_id,employee_id) REFERENCES mbox.staff_sessions(tenant_id,store_id,id,employee_id),
  CHECK((status='sending')=(locked_by IS NOT NULL AND locked_at IS NOT NULL)),
  CHECK((provider_accepted_at IS NOT NULL)=(status='provider_accepted'))
);
CREATE INDEX native_push_delivery_claim_idx ON mbox.native_push_deliveries(tenant_id,store_id,available_at,id) WHERE status IN('pending','retry','sending');

-- State and identity guards protect all runtime writers, including future workers.
CREATE FUNCTION mbox.guard_native_push_installation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.tenant_id,NEW.store_id,NEW.id,NEW.device_key_hash) IS DISTINCT FROM (OLD.tenant_id,OLD.store_id,OLD.id,OLD.device_key_hash)
 OR NEW.revision NOT IN(OLD.revision,OLD.revision+1) THEN RAISE EXCEPTION 'native push binding identity is immutable'; END IF;
 IF NEW.revision=OLD.revision AND (
  (NEW.employee_id,NEW.staff_session_id,NEW.device_access_lease_id,NEW.platform,NEW.provider,NEW.environment,NEW.topic,NEW.token_ciphertext,NEW.token_key_id,NEW.token_hash,NEW.revocation_hash,NEW.permission,NEW.app_version,NEW.registered_at,NEW.expires_at,NEW.event_ttl_seconds)
  IS DISTINCT FROM (OLD.employee_id,OLD.staff_session_id,OLD.device_access_lease_id,OLD.platform,OLD.provider,OLD.environment,OLD.topic,OLD.token_ciphertext,OLD.token_key_id,OLD.token_hash,OLD.revocation_hash,OLD.permission,OLD.app_version,OLD.registered_at,OLD.expires_at,OLD.event_ttl_seconds)
  OR (OLD.status<>'active' AND NEW.status NOT IN(OLD.status,'revoked'))
 ) THEN RAISE EXCEPTION 'native push binding changes require a new revision'; END IF;
 IF NEW.revision=OLD.revision+1 AND (NEW.status<>'active' OR NEW.revocation_hash=OLD.revocation_hash) THEN RAISE EXCEPTION 'native push rebinding requires new capability'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER native_push_installation_guard BEFORE UPDATE ON mbox.native_push_installations FOR EACH ROW EXECUTE FUNCTION mbox.guard_native_push_installation();
CREATE FUNCTION mbox.guard_native_push_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(NEW)-'projected_at') IS DISTINCT FROM (to_jsonb(OLD)-'projected_at')
 OR (OLD.projected_at IS NOT NULL AND NEW.projected_at IS DISTINCT FROM OLD.projected_at)
 THEN RAISE EXCEPTION 'native push source event is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER native_push_event_guard BEFORE UPDATE ON mbox.native_push_events FOR EACH ROW EXECUTE FUNCTION mbox.guard_native_push_event();
CREATE FUNCTION mbox.guard_native_push_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.status<>'pending' OR NEW.attempts<>0 OR NEW.client_reported_received_at IS NOT NULL OR NEW.client_reported_opened_at IS NOT NULL
  OR NOT EXISTS(SELECT 1 FROM mbox.native_push_installations i WHERE (i.tenant_id,i.store_id,i.id,i.revision,i.employee_id,i.staff_session_id)=(NEW.tenant_id,NEW.store_id,NEW.installation_id,NEW.binding_revision,NEW.employee_id,NEW.staff_session_id) AND i.status='active')
  THEN RAISE EXCEPTION 'native push delivery requires a current binding'; END IF;
  RETURN NEW;
 END IF;
 IF (NEW.id,NEW.tenant_id,NEW.store_id,NEW.event_id,NEW.installation_id,NEW.binding_revision,NEW.employee_id,NEW.staff_session_id,NEW.provider_request_id,NEW.created_at)
 IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.store_id,OLD.event_id,OLD.installation_id,OLD.binding_revision,OLD.employee_id,OLD.staff_session_id,OLD.provider_request_id,OLD.created_at)
 THEN RAISE EXCEPTION 'native push delivery target is immutable'; END IF;
 IF NOT (NEW.status=OLD.status OR (OLD.status IN('pending','retry') AND NEW.status IN('sending','cancelled','expired'))
 OR (OLD.status='sending' AND NEW.status IN('provider_accepted','unknown','rejected','retry','cancelled','expired')))
 THEN RAISE EXCEPTION 'native push delivery transition is invalid'; END IF;
 IF NEW.attempts<>(OLD.attempts+(CASE WHEN OLD.status IN('pending','retry') AND NEW.status='sending' THEN 1 ELSE 0 END))
 THEN RAISE EXCEPTION 'native push delivery attempt is invalid'; END IF;
 IF (OLD.provider_accepted_at IS NOT NULL AND NEW.provider_accepted_at IS DISTINCT FROM OLD.provider_accepted_at)
 OR (OLD.client_reported_received_at IS NOT NULL AND NEW.client_reported_received_at IS DISTINCT FROM OLD.client_reported_received_at)
 OR (OLD.client_reported_opened_at IS NOT NULL AND NEW.client_reported_opened_at IS DISTINCT FROM OLD.client_reported_opened_at)
 OR ((NEW.client_reported_received_at IS DISTINCT FROM OLD.client_reported_received_at OR NEW.client_reported_opened_at IS DISTINCT FROM OLD.client_reported_opened_at) AND OLD.status NOT IN('sending','provider_accepted','unknown'))
 THEN RAISE EXCEPTION 'native push observation is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER native_push_delivery_guard BEFORE INSERT OR UPDATE ON mbox.native_push_deliveries FOR EACH ROW EXECUTE FUNCTION mbox.guard_native_push_delivery();
REVOKE ALL ON FUNCTION mbox.guard_native_push_installation(),mbox.guard_native_push_event(),mbox.guard_native_push_delivery() FROM PUBLIC;

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['native_push_installations','native_push_revocation_tombstones','native_push_events','native_push_deliveries'] LOOP
  EXECUTE format('ALTER TABLE mbox.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE mbox.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_store_isolation ON mbox.%I USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())',t);
  EXECUTE format('REVOKE ALL ON mbox.%I FROM PUBLIC',t);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON mbox.%I TO mbox_runtime',t);
 END LOOP;
END $$;
REVOKE UPDATE ON mbox.native_push_revocation_tombstones FROM mbox_runtime;

CREATE FUNCTION mbox.capture_native_push_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.event_type IN('task.created','task.assign','task.priority','task.backup_assigned','task.escalated','task.reminded')
 AND EXISTS(SELECT 1 FROM mbox.native_push_installations i WHERE i.tenant_id=NEW.tenant_id AND i.store_id=NEW.store_id AND i.status='active' AND i.expires_at>clock_timestamp()) THEN
  INSERT INTO mbox.native_push_events(tenant_id,store_id,source_event_id,task_id,table_session_id,event_type,occurred_at,expires_at)
  SELECT NEW.tenant_id,NEW.store_id,NEW.id,NEW.service_task_id,t.table_session_id,NEW.event_type,NEW.occurred_at,NEW.occurred_at+make_interval(secs => (SELECT max(i.event_ttl_seconds) FROM mbox.native_push_installations i WHERE i.tenant_id=NEW.tenant_id AND i.store_id=NEW.store_id AND i.status='active' AND i.expires_at>clock_timestamp()))
  FROM mbox.service_tasks t WHERE t.tenant_id=NEW.tenant_id AND t.store_id=NEW.store_id AND t.id=NEW.service_task_id;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER native_push_capture_event AFTER INSERT ON mbox.service_task_events FOR EACH ROW EXECUTE FUNCTION mbox.capture_native_push_event();
REVOKE ALL ON FUNCTION mbox.capture_native_push_event() FROM PUBLIC;

-- Reuse the existing scoped, bounded, automatically cleaned authentication limiter.
ALTER TABLE mbox.staff_login_rate_limits DROP CONSTRAINT staff_login_rate_limits_attempt_kind_check;
ALTER TABLE mbox.staff_login_rate_limits ADD CONSTRAINT staff_login_rate_limits_attempt_kind_check
 CHECK(attempt_kind IN('daily_store_credential','employee_pin','native_push_revoke'));
COMMIT;
