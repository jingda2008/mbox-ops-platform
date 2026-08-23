BEGIN;

CREATE TABLE mbox.print_bridges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  public_id text NOT NULL CHECK (public_id ~ '^print-bridge-[A-Za-z0-9_-]{16,96}$'),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  secret_hash char(64) NOT NULL CHECK (secret_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  hostname text NOT NULL CHECK (length(btrim(hostname)) BETWEEN 1 AND 160),
  platform text NOT NULL DEFAULT 'windows' CHECK (platform='windows'),
  software_version text NOT NULL CHECK (length(btrim(software_version)) BETWEEN 1 AND 64),
  queue_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(queue_snapshot)='array'),
  last_seen_at timestamptz,
  installed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
  CHECK ((status='revoked')=(revoked_at IS NOT NULL)),
  UNIQUE (tenant_id,store_id,public_id),
  UNIQUE (tenant_id,store_id,id)
);

CREATE TABLE mbox.print_bridge_pairing_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  code_hash char(64) NOT NULL CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  created_by_employee_id uuid NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 1000),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  consumed_by_bridge_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
  FOREIGN KEY (tenant_id,store_id,created_by_employee_id)
    REFERENCES mbox.employees(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,consumed_by_bridge_id)
    REFERENCES mbox.print_bridges(tenant_id,store_id,id),
  CHECK (expires_at>created_at),
  CHECK ((consumed_at IS NULL)=(consumed_by_bridge_id IS NULL)),
  UNIQUE (tenant_id,store_id,code_hash),
  UNIQUE (tenant_id,store_id,id)
);

ALTER TABLE mbox.devices
  ADD COLUMN print_bridge_id uuid,
  ADD COLUMN windows_queue_name text,
  ADD COLUMN print_profile text CHECK (print_profile IS NULL OR print_profile IN ('escpos_58','escpos_80','windows_text')),
  ADD CONSTRAINT devices_print_bridge_fk FOREIGN KEY (tenant_id,store_id,print_bridge_id)
    REFERENCES mbox.print_bridges(tenant_id,store_id,id),
  ADD CONSTRAINT devices_windows_queue_check CHECK (
    (print_bridge_id IS NULL AND windows_queue_name IS NULL AND print_profile IS NULL)
    OR (device_type='printer' AND print_bridge_id IS NOT NULL
      AND windows_queue_name IS NOT NULL
      AND length(btrim(windows_queue_name)) BETWEEN 1 AND 180 AND print_profile IS NOT NULL)
  );

ALTER TABLE mbox.print_jobs
  ADD COLUMN delivery_mode text NOT NULL DEFAULT 'cloud_adapter'
    CHECK (delivery_mode IN ('cloud_adapter','bridge_pull')),
  ADD COLUMN print_bridge_id uuid,
  ADD CONSTRAINT print_jobs_bridge_fk FOREIGN KEY (tenant_id,store_id,print_bridge_id)
    REFERENCES mbox.print_bridges(tenant_id,store_id,id),
  ADD CONSTRAINT print_jobs_delivery_check CHECK (
    (delivery_mode='cloud_adapter' AND print_bridge_id IS NULL)
    OR (delivery_mode='bridge_pull' AND print_bridge_id IS NOT NULL)
  );

CREATE INDEX print_bridge_heartbeat_idx
  ON mbox.print_bridges (tenant_id,store_id,status,last_seen_at DESC,id);
CREATE INDEX print_bridge_pairing_expiry_idx
  ON mbox.print_bridge_pairing_codes (tenant_id,store_id,expires_at,id)
  WHERE consumed_at IS NULL;
CREATE INDEX print_jobs_bridge_claim_idx
  ON mbox.print_jobs (tenant_id,store_id,print_bridge_id,available_at,created_at,id)
  WHERE delivery_mode='bridge_pull' AND status IN ('pending','failed','printing');

CREATE TRIGGER print_bridges_touch_updated_at BEFORE UPDATE ON mbox.print_bridges
  FOR EACH ROW EXECUTE FUNCTION mbox.touch_updated_at();

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['print_bridges','print_bridge_pairing_codes']
  LOOP
    EXECUTE format('ALTER TABLE mbox.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE mbox.%I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format(
      'CREATE POLICY tenant_store_isolation ON mbox.%I '
      'USING (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) '
      'WITH CHECK (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())',
      table_name
    );
    EXECUTE format('REVOKE ALL ON TABLE mbox.%I FROM PUBLIC',table_name);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE ON TABLE mbox.%I TO mbox_runtime',table_name);
  END LOOP;
END $$;

UPDATE mbox.normalized_schema_metadata
SET schema_version='105',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMENT ON TABLE mbox.print_bridges IS
  'Store Windows print services authenticated by revocable device credentials; employee accounts and browser sessions are prohibited.';
COMMENT ON COLUMN mbox.devices.windows_queue_name IS
  'Exact Windows printer queue selected by the store print bridge; never an executable command.';
COMMENT ON COLUMN mbox.print_jobs.delivery_mode IS
  'Cloud adapters may claim cloud_adapter only; store bridges actively pull bridge_pull jobs over HTTPS.';

COMMIT;
