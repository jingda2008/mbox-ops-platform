BEGIN;

COMMENT ON TABLE mbox.runtime_states IS
  'Commercial V1 authoritative store aggregate. Normalized domain tables are target projections and must not be reported as written until a projector is enabled.';

CREATE TABLE mbox.runtime_state_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('initialized', 'updated')),
  previous_revision bigint,
  revision bigint NOT NULL CHECK (revision > 0),
  previous_state_sha256 char(64) CHECK (
    previous_state_sha256 IS NULL OR previous_state_sha256 ~ '^[0-9a-f]{64}$'
  ),
  state_sha256 char(64) NOT NULL CHECK (state_sha256 ~ '^[0-9a-f]{64}$'),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  CONSTRAINT runtime_state_versions_revision_uq UNIQUE (tenant_id, store_id, revision),
  CONSTRAINT runtime_state_versions_transition CHECK (
    (
      event_type = 'initialized'
      AND previous_revision IS NULL
      AND previous_state_sha256 IS NULL
    ) OR (
      event_type = 'updated'
      AND previous_revision IS NOT NULL
      AND previous_revision < revision
      AND previous_state_sha256 IS NOT NULL
    )
  )
);

INSERT INTO mbox.runtime_state_versions (
  tenant_id, store_id, event_type, previous_revision, revision,
  previous_state_sha256, state_sha256, recorded_at
)
SELECT tenant_id, store_id, 'initialized', NULL, revision, NULL, state_sha256, created_at
FROM mbox.runtime_states
ON CONFLICT (tenant_id, store_id, revision) DO NOTHING;

CREATE OR REPLACE FUNCTION mbox.journal_runtime_state_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO mbox.runtime_state_versions (
    tenant_id, store_id, event_type, previous_revision, revision,
    previous_state_sha256, state_sha256, recorded_at
  ) VALUES (
    NEW.tenant_id,
    NEW.store_id,
    CASE WHEN TG_OP = 'INSERT' THEN 'initialized' ELSE 'updated' END,
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.revision END,
    NEW.revision,
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.state_sha256 END,
    NEW.state_sha256,
    clock_timestamp()
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER runtime_states_journal_version
AFTER INSERT OR UPDATE ON mbox.runtime_states
FOR EACH ROW EXECUTE FUNCTION mbox.journal_runtime_state_version();

CREATE TRIGGER runtime_state_versions_append_only
BEFORE UPDATE OR DELETE ON mbox.runtime_state_versions
FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();

ALTER TABLE mbox.runtime_state_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.runtime_state_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.runtime_state_versions
  USING (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id())
  WITH CHECK (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id());

COMMIT;
