BEGIN;

CREATE TABLE mbox.staff_presence_leases (
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  session_id text NOT NULL CHECK (length(session_id) BETWEEN 1 AND 128),
  actor_id text NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 128),
  venue_store_code text NOT NULL CHECK (length(venue_store_code) BETWEEN 1 AND 128),
  business_date date NOT NULL,
  established_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  session_expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, store_id, session_id),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  CONSTRAINT staff_presence_lease_time_order CHECK (
    established_at <= last_seen_at
    AND last_seen_at <= expires_at
    AND expires_at <= session_expires_at
  )
);

CREATE INDEX staff_presence_leases_active_idx
  ON mbox.staff_presence_leases (tenant_id, store_id, business_date, expires_at);

ALTER TABLE mbox.staff_presence_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.staff_presence_leases FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.staff_presence_leases
  USING (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id())
  WITH CHECK (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id());

GRANT USAGE ON SCHEMA mbox TO mbox_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON mbox.staff_presence_leases TO mbox_app;

COMMENT ON TABLE mbox.staff_presence_leases IS
  'Lightweight staff session leases and durable revocations. Heartbeats update this table without rewriting the venue aggregate.';

COMMIT;
