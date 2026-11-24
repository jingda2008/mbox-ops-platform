BEGIN;
SET LOCAL lock_timeout='3s';

-- Populated only from a separately confirmed store roster. No automatic seeding.
CREATE TABLE mbox.ticket_table_roster (
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  table_id uuid NOT NULL,
  PRIMARY KEY (tenant_id,store_id,table_id),
  FOREIGN KEY (tenant_id,store_id,table_id) REFERENCES mbox.tables(tenant_id,store_id,id)
);
ALTER TABLE mbox.ticket_table_roster ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.ticket_table_roster FORCE ROW LEVEL SECURITY;
CREATE POLICY scoped ON mbox.ticket_table_roster USING
 (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())
 WITH CHECK (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
GRANT SELECT ON mbox.ticket_table_roster TO mbox_runtime;

-- Selection is deliberately draft-only until all shared inventory writers honor it.
-- Null is preserved for historic rows and does not imply that a draft selected every table.
ALTER TABLE mbox.table_ticket_offers ADD COLUMN draft_table_ids uuid[];
ALTER TABLE mbox.table_ticket_offers ADD CONSTRAINT ticket_draft_table_ids_only CHECK (
  draft_table_ids IS NULL OR (status='draft' AND cardinality(draft_table_ids) BETWEEN 1 AND 200
    AND array_position(draft_table_ids, NULL) IS NULL)
);
UPDATE mbox.normalized_schema_metadata SET schema_version='368',updated_at=clock_timestamp() WHERE singleton;
COMMIT;
