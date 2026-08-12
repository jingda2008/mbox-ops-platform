BEGIN;

ALTER TABLE mbox.runtime_states
  ADD COLUMN state_checksum_algorithm text NOT NULL DEFAULT 'app-canonical-json-sha256-v1'
  CHECK (state_checksum_algorithm IN ('app-canonical-json-sha256-v1', 'pg-jsonb-text-sha256-v1'));

ALTER TABLE mbox.runtime_state_versions
  ADD COLUMN previous_state_checksum_algorithm text
    CHECK (previous_state_checksum_algorithm IS NULL OR previous_state_checksum_algorithm IN (
      'unknown-legacy-sha256-v0', 'app-canonical-json-sha256-v1', 'pg-jsonb-text-sha256-v1'
    )),
  ADD COLUMN state_checksum_algorithm text NOT NULL DEFAULT 'unknown-legacy-sha256-v0'
    CHECK (state_checksum_algorithm IN (
      'unknown-legacy-sha256-v0', 'app-canonical-json-sha256-v1', 'pg-jsonb-text-sha256-v1'
    ));

ALTER TABLE mbox.operational_projection_checkpoints
  ADD COLUMN state_checksum_algorithm text NOT NULL DEFAULT 'app-canonical-json-sha256-v1'
  CHECK (state_checksum_algorithm IN ('app-canonical-json-sha256-v1', 'pg-jsonb-text-sha256-v1'));

-- Historical journal rows do not retain the state document, so a digest alone
-- cannot prove which algorithm produced it. Keep those rows explicitly
-- unknown instead of manufacturing a false audit classification. Current
-- runtime/checkpoint rows can be classified from the authoritative JSONB value.
DROP TRIGGER runtime_states_journal_version ON mbox.runtime_states;
ALTER TABLE mbox.runtime_states NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mbox.runtime_state_versions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mbox.operational_projection_checkpoints NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mbox.runtime_state_versions DISABLE TRIGGER runtime_state_versions_append_only;

UPDATE mbox.runtime_state_versions
SET previous_state_checksum_algorithm = 'unknown-legacy-sha256-v0'
WHERE previous_state_sha256 IS NOT NULL;

UPDATE mbox.runtime_states
SET state_checksum_algorithm = CASE
  WHEN state_sha256 = encode(sha256(convert_to(state::text, 'UTF8')), 'hex')
    THEN 'pg-jsonb-text-sha256-v1'
  ELSE 'app-canonical-json-sha256-v1'
END;

UPDATE mbox.operational_projection_checkpoints checkpoint
SET state_checksum_algorithm = CASE
  WHEN checkpoint.state_sha256 = encode(sha256(convert_to(runtime.state::text, 'UTF8')), 'hex')
    THEN 'pg-jsonb-text-sha256-v1'
  ELSE 'app-canonical-json-sha256-v1'
END
FROM mbox.runtime_states runtime
WHERE runtime.tenant_id = checkpoint.tenant_id
  AND runtime.store_id = checkpoint.store_id
  AND runtime.revision = checkpoint.runtime_revision;

UPDATE mbox.runtime_state_versions version
SET state_checksum_algorithm = runtime.state_checksum_algorithm
FROM mbox.runtime_states runtime
WHERE runtime.tenant_id = version.tenant_id
  AND runtime.store_id = version.store_id
  AND runtime.revision = version.revision
  AND runtime.state_sha256 = version.state_sha256;

ALTER TABLE mbox.runtime_state_versions ENABLE TRIGGER runtime_state_versions_append_only;
ALTER TABLE mbox.runtime_states FORCE ROW LEVEL SECURITY;
ALTER TABLE mbox.runtime_state_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE mbox.operational_projection_checkpoints FORCE ROW LEVEL SECURITY;

-- Keep one compatibility release window for blue/green activation and
-- rollback. Older application revisions do not write the algorithm columns,
-- so classify from the checksum and authoritative state before journaling.
CREATE OR REPLACE FUNCTION mbox.classify_runtime_state_checksum_algorithm()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.state_checksum_algorithm := CASE
    WHEN NEW.state_sha256 = encode(sha256(convert_to(NEW.state::text, 'UTF8')), 'hex')
      THEN 'pg-jsonb-text-sha256-v1'
    ELSE 'app-canonical-json-sha256-v1'
  END;
  RETURN NEW;
END;
$$;

CREATE TRIGGER runtime_states_classify_checksum_algorithm
BEFORE INSERT OR UPDATE OF state, state_sha256 ON mbox.runtime_states
FOR EACH ROW EXECUTE FUNCTION mbox.classify_runtime_state_checksum_algorithm();

CREATE OR REPLACE FUNCTION mbox.classify_projection_checksum_algorithm()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  runtime_algorithm text;
BEGIN
  SELECT state_checksum_algorithm INTO runtime_algorithm
  FROM mbox.runtime_states
  WHERE tenant_id = NEW.tenant_id
    AND store_id = NEW.store_id
    AND revision = NEW.runtime_revision
    AND state_sha256 = NEW.state_sha256;

  NEW.state_checksum_algorithm := COALESCE(
    runtime_algorithm,
    NEW.state_checksum_algorithm,
    'app-canonical-json-sha256-v1'
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER operational_projection_checkpoints_classify_checksum_algorithm
BEFORE INSERT OR UPDATE OF runtime_revision, state_sha256
ON mbox.operational_projection_checkpoints
FOR EACH ROW EXECUTE FUNCTION mbox.classify_projection_checksum_algorithm();

CREATE OR REPLACE FUNCTION mbox.journal_runtime_state_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO mbox.runtime_state_versions (
    tenant_id, store_id, event_type, previous_revision, revision,
    previous_state_sha256, state_sha256,
    previous_state_checksum_algorithm, state_checksum_algorithm, recorded_at
  ) VALUES (
    NEW.tenant_id,
    NEW.store_id,
    CASE WHEN TG_OP = 'INSERT' THEN 'initialized' ELSE 'updated' END,
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.revision END,
    NEW.revision,
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.state_sha256 END,
    NEW.state_sha256,
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.state_checksum_algorithm END,
    NEW.state_checksum_algorithm,
    clock_timestamp()
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER runtime_states_journal_version
AFTER INSERT OR UPDATE ON mbox.runtime_states
FOR EACH ROW EXECUTE FUNCTION mbox.journal_runtime_state_version();

COMMIT;
