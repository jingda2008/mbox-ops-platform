BEGIN;
SET LOCAL lock_timeout='3s';

-- Staff confirm specific desks for draft preparation, independently of a
-- store's enrollment in restricted inventory and its frozen sale commitments.
CREATE TABLE mbox.ticket_draft_roster_entries (
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  area_id uuid NOT NULL,
  table_id uuid NOT NULL,
  PRIMARY KEY (tenant_id,store_id,area_id,table_id),
  FOREIGN KEY (tenant_id,store_id,area_id) REFERENCES mbox.areas(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,table_id) REFERENCES mbox.tables(tenant_id,store_id,id)
);
ALTER TABLE mbox.ticket_draft_roster_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.ticket_draft_roster_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY scoped ON mbox.ticket_draft_roster_entries USING
  (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())
  WITH CHECK (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
GRANT SELECT, INSERT, DELETE ON mbox.ticket_draft_roster_entries TO mbox_runtime;

CREATE VIEW mbox.ticket_draft_roster WITH (security_invoker=true) AS
  SELECT t.tenant_id,t.store_id,t.area_id,t.id AS table_id
  FROM mbox.ticket_table_roster r JOIN mbox.tables t ON
    (t.tenant_id,t.store_id,t.id)=(r.tenant_id,r.store_id,r.table_id)
  UNION
  SELECT tenant_id,store_id,area_id,table_id FROM mbox.ticket_draft_roster_entries;
GRANT SELECT ON mbox.ticket_draft_roster TO mbox_runtime;
UPDATE mbox.normalized_schema_metadata SET schema_version='373',updated_at=clock_timestamp() WHERE singleton;
COMMIT;
