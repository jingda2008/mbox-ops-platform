BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
CREATE TABLE mbox.print_diagnostic_events(
 tenant_id uuid NOT NULL,store_id uuid NOT NULL,bridge_id uuid NOT NULL,event_id uuid NOT NULL,
 occurred_at timestamptz NOT NULL,received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 kind text NOT NULL,job_id uuid,duration_ms integer,failure_code text,gap_count integer,clock_skew boolean NOT NULL DEFAULT false,
 PRIMARY KEY(tenant_id,store_id,bridge_id,event_id),
 FOREIGN KEY(tenant_id,store_id,bridge_id) REFERENCES mbox.print_bridges(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,job_id) REFERENCES mbox.print_jobs(tenant_id,store_id,id),
 CHECK(duration_ms IS NULL OR duration_ms BETWEEN 0 AND 86400000)
);
CREATE INDEX print_diagnostic_events_retention ON mbox.print_diagnostic_events(tenant_id,store_id,received_at);
CREATE TABLE mbox.print_incidents(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,bridge_id uuid NOT NULL,
 incident_key text NOT NULL,job_id uuid,kind text NOT NULL,failure_code text,
 status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','claimed','resolved')),
 first_seen_at timestamptz NOT NULL,last_seen_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),episode_started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 occurrences integer NOT NULL DEFAULT 1,claimed_by uuid,resolution text,resolved_at timestamptz,
 UNIQUE(tenant_id,store_id,bridge_id,incident_key),
 FOREIGN KEY(tenant_id,store_id,bridge_id) REFERENCES mbox.print_bridges(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,job_id) REFERENCES mbox.print_jobs(tenant_id,store_id,id),
 CHECK(resolution IS NULL OR resolution IN ('paper_confirmed','not_printed','device_restored')),
 CHECK((status='resolved')=(resolved_at IS NOT NULL)),
 CHECK((status='open')=(claimed_by IS NULL))
);
CREATE INDEX print_incidents_open ON mbox.print_incidents(tenant_id,store_id,status,created_at);
DO $$ DECLARE n text; BEGIN
 FOREACH n IN ARRAY ARRAY['print_diagnostic_events','print_incidents'] LOOP
 EXECUTE format('ALTER TABLE mbox.%I ENABLE ROW LEVEL SECURITY',n);
 EXECUTE format('ALTER TABLE mbox.%I FORCE ROW LEVEL SECURITY',n);
 EXECUTE format('CREATE POLICY scoped ON mbox.%I USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())',n);
 EXECUTE format('GRANT SELECT,INSERT ON mbox.%I TO mbox_runtime',n);
 END LOOP;
END $$;
GRANT DELETE ON mbox.print_diagnostic_events TO mbox_runtime;
GRANT UPDATE(episode_started_at,status,first_seen_at,last_seen_at,occurrences,claimed_by,resolution,resolved_at) ON mbox.print_incidents TO mbox_runtime;
UPDATE mbox.normalized_schema_metadata SET schema_version='315',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
