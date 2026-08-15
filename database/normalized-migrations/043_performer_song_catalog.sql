BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE mbox.performer_song_import_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  performer_id uuid NOT NULL,
  public_id text NOT NULL CHECK (length(btrim(public_id)) BETWEEN 8 AND 128),
  source_name text NOT NULL CHECK (length(btrim(source_name)) BETWEEN 1 AND 256),
  source_sha256 char(64) NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  import_mode text NOT NULL CHECK (import_mode IN ('upsert', 'replace')),
  status text NOT NULL CHECK (status IN ('processing', 'completed', 'failed')),
  row_count integer NOT NULL DEFAULT 0 CHECK (row_count >= 0),
  imported_count integer NOT NULL DEFAULT 0 CHECK (imported_count >= 0),
  rejected_count integer NOT NULL DEFAULT 0 CHECK (rejected_count >= 0),
  created_by_employee_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, performer_id) REFERENCES mbox.performers(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, created_by_employee_id) REFERENCES mbox.employees(tenant_id, store_id, id),
  CHECK ((status = 'completed') = (completed_at IS NOT NULL)),
  UNIQUE (tenant_id, store_id, public_id),
  UNIQUE (tenant_id, store_id, performer_id, id),
  UNIQUE (tenant_id, store_id, id)
);

CREATE TABLE mbox.performer_songs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  performer_id uuid NOT NULL,
  import_batch_id uuid,
  code text,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 240),
  normalized_title text GENERATED ALWAYS AS (lower(btrim(title))) STORED,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, performer_id) REFERENCES mbox.performers(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, performer_id, import_batch_id)
    REFERENCES mbox.performer_song_import_batches(tenant_id, store_id, performer_id, id),
  CHECK (code IS NULL OR length(btrim(code)) BETWEEN 1 AND 64),
  UNIQUE (tenant_id, store_id, performer_id, normalized_title),
  UNIQUE (tenant_id, store_id, performer_id, id),
  UNIQUE (tenant_id, store_id, id)
);

CREATE TABLE mbox.performer_song_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  performer_id uuid NOT NULL,
  song_id uuid NOT NULL,
  alias text NOT NULL CHECK (length(btrim(alias)) BETWEEN 1 AND 240),
  normalized_alias text GENERATED ALWAYS AS (lower(btrim(alias))) STORED,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, performer_id) REFERENCES mbox.performers(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, performer_id, song_id)
    REFERENCES mbox.performer_songs(tenant_id, store_id, performer_id, id) ON DELETE CASCADE,
  UNIQUE (tenant_id, store_id, performer_id, normalized_alias),
  UNIQUE (tenant_id, store_id, song_id, normalized_alias),
  UNIQUE (tenant_id, store_id, id)
);

CREATE INDEX performer_songs_title_trgm_idx ON mbox.performer_songs USING gin (normalized_title gin_trgm_ops);
CREATE INDEX performer_song_aliases_alias_trgm_idx ON mbox.performer_song_aliases USING gin (normalized_alias gin_trgm_ops);
CREATE INDEX performer_songs_active_idx ON mbox.performer_songs (tenant_id, store_id, performer_id, status, title);
CREATE UNIQUE INDEX performer_songs_active_code_uq
  ON mbox.performer_songs (tenant_id, store_id, performer_id, lower(btrim(code)))
  WHERE code IS NOT NULL AND status='active';

INSERT INTO mbox.performer_song_import_batches (
  tenant_id, store_id, performer_id, public_id, source_name, source_sha256,
  import_mode, status, row_count, imported_count, rejected_count, completed_at
)
SELECT performer.tenant_id, performer.store_id, performer.id,
  'legacy-song-catalog-' || performer.id::text, 'legacy performers.song_catalog',
  encode(digest(performer.song_catalog::text, 'sha256'), 'hex'), 'replace', 'completed',
  jsonb_array_length(performer.song_catalog), jsonb_array_length(performer.song_catalog), 0,
  clock_timestamp()
FROM mbox.performers performer
WHERE jsonb_array_length(performer.song_catalog) > 0;

WITH expanded AS (
  SELECT performer.tenant_id, performer.store_id, performer.id AS performer_id,
    batch.id AS import_batch_id, item.value AS song, item.ordinality
  FROM mbox.performers performer
  JOIN mbox.performer_song_import_batches batch
    ON batch.tenant_id=performer.tenant_id AND batch.store_id=performer.store_id
    AND batch.performer_id=performer.id AND batch.source_name='legacy performers.song_catalog'
  CROSS JOIN LATERAL jsonb_array_elements(performer.song_catalog) WITH ORDINALITY item(value, ordinality)
  WHERE jsonb_typeof(item.value)='object'
    AND length(btrim(COALESCE(item.value->>'title', ''))) BETWEEN 1 AND 240
), unique_rows AS (
  SELECT *, row_number() OVER (
    PARTITION BY tenant_id, store_id, performer_id, lower(btrim(song->>'title'))
    ORDER BY ordinality
  ) AS duplicate_rank
  FROM expanded
)
INSERT INTO mbox.performer_songs (
  tenant_id, store_id, performer_id, import_batch_id, code, title, metadata, status
)
SELECT tenant_id, store_id, performer_id, import_batch_id,
  NULLIF(btrim(song->>'code'), ''), btrim(song->>'title'),
  song - 'code' - 'title' - 'aliases', 'active'
FROM unique_rows
WHERE duplicate_rank=1
ON CONFLICT (tenant_id, store_id, performer_id, normalized_title) DO NOTHING;

INSERT INTO mbox.performer_song_aliases (tenant_id, store_id, performer_id, song_id, alias)
SELECT song.tenant_id, song.store_id, song.performer_id, song.id, btrim(alias.value)
FROM mbox.performers performer
JOIN mbox.performer_songs song
  ON song.tenant_id=performer.tenant_id AND song.store_id=performer.store_id
  AND song.performer_id=performer.id
CROSS JOIN LATERAL jsonb_array_elements(performer.song_catalog) item(value)
CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(item.value->'aliases', '[]'::jsonb)) alias(value)
WHERE lower(btrim(item.value->>'title'))=song.normalized_title AND length(btrim(alias.value)) BETWEEN 1 AND 240
ON CONFLICT DO NOTHING;

UPDATE mbox.performer_song_import_batches batch
SET imported_count = imported.count,
    rejected_count = GREATEST(0, batch.row_count - imported.count)
FROM (
  SELECT song.tenant_id, song.store_id, song.import_batch_id, count(*)::integer AS count
  FROM mbox.performer_songs song
  WHERE song.import_batch_id IS NOT NULL
  GROUP BY song.tenant_id, song.store_id, song.import_batch_id
) imported
WHERE batch.tenant_id=imported.tenant_id AND batch.store_id=imported.store_id
  AND batch.id=imported.import_batch_id
  AND batch.source_name='legacy performers.song_catalog';

DELETE FROM mbox.performer_song_aliases alias
USING mbox.performer_songs song
WHERE alias.tenant_id=song.tenant_id AND alias.store_id=song.store_id
  AND alias.performer_id=song.performer_id
  AND alias.normalized_alias=song.normalized_title;

CREATE OR REPLACE FUNCTION mbox.enforce_performer_song_name_boundaries()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='performer_song_aliases' THEN
    IF EXISTS (
      SELECT 1 FROM mbox.performer_songs song
      WHERE song.tenant_id=NEW.tenant_id AND song.store_id=NEW.store_id
        AND song.performer_id=NEW.performer_id AND song.status='active'
        AND song.normalized_title=lower(btrim(NEW.alias))
    ) THEN
      RAISE EXCEPTION 'song alias conflicts with an active song title' USING ERRCODE='23505';
    END IF;
  ELSIF NEW.status='active' THEN
    IF EXISTS (
      SELECT 1 FROM mbox.performer_song_aliases alias
      JOIN mbox.performer_songs owner
        ON owner.tenant_id=alias.tenant_id AND owner.store_id=alias.store_id
        AND owner.id=alias.song_id AND owner.status='active'
      WHERE alias.tenant_id=NEW.tenant_id AND alias.store_id=NEW.store_id
        AND alias.performer_id=NEW.performer_id
        AND alias.normalized_alias=lower(btrim(NEW.title))
        AND alias.song_id<>NEW.id
    ) THEN
      RAISE EXCEPTION 'song title conflicts with an active song alias' USING ERRCODE='23505';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER performer_song_alias_name_boundary
  BEFORE INSERT OR UPDATE OF alias ON mbox.performer_song_aliases
  FOR EACH ROW EXECUTE FUNCTION mbox.enforce_performer_song_name_boundaries();
CREATE TRIGGER performer_song_title_name_boundary
  BEFORE INSERT OR UPDATE OF title, status ON mbox.performer_songs
  FOR EACH ROW EXECUTE FUNCTION mbox.enforce_performer_song_name_boundaries();

ALTER TABLE mbox.song_requests
  ADD COLUMN song_id uuid,
  ADD CONSTRAINT song_requests_catalog_song_shape
    CHECK (song_id IS NULL OR (request_type='catalog' AND performer_id IS NOT NULL));

UPDATE mbox.song_requests request
SET song_id = song.id
FROM mbox.performer_songs song
WHERE request.tenant_id=song.tenant_id AND request.store_id=song.store_id
  AND request.performer_id=song.performer_id
  AND request.request_type='catalog'
  AND lower(btrim(request.song_title))=song.normalized_title;

ALTER TABLE mbox.song_requests
  ADD CONSTRAINT song_requests_catalog_song_fk
    FOREIGN KEY (tenant_id, store_id, performer_id, song_id)
    REFERENCES mbox.performer_songs(tenant_id, store_id, performer_id, id);

CREATE INDEX song_requests_catalog_song_stats_idx
  ON mbox.song_requests (tenant_id, store_id, song_id, status, created_at, id)
  WHERE song_id IS NOT NULL;

COMMENT ON COLUMN mbox.performers.song_catalog IS
  'Deprecated rollback-only compatibility column. Normalized runtime must not read or write it; remove only after the previous release rollback window closes.';

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['performer_song_import_batches','performer_songs','performer_song_aliases']
  LOOP
    EXECUTE format('ALTER TABLE mbox.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE mbox.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_store_isolation ON mbox.%I '
      'USING (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id()) '
      'WITH CHECK (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id())',
      table_name
    );
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON TABLE mbox.performer_song_import_batches TO mbox_runtime;
GRANT SELECT, INSERT, UPDATE ON TABLE mbox.performer_songs TO mbox_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE mbox.performer_song_aliases TO mbox_runtime;

UPDATE mbox.normalized_schema_metadata
SET schema_version = '043', updated_at = clock_timestamp()
WHERE singleton = true AND schema_flavor = 'normalized-core-v1';

COMMIT;
