BEGIN;
SET LOCAL lock_timeout='3s';

-- One series per performance and physical area. Published and draft revisions
-- are append-only so a pending purchase can refer to its exact revision.
CREATE TABLE mbox.table_ticket_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  activity_id uuid NOT NULL,
  area_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  price_minor integer NOT NULL CHECK (price_minor > 0),
  gift_points integer CHECK (gift_points >= 0),
  status text NOT NULL CHECK (status IN ('draft','published','withdrawn')),
  visible_from timestamptz,
  visible_until timestamptz,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (visible_until IS NULL OR visible_from IS NULL OR visible_until > visible_from),
  CHECK (status <> 'published' OR gift_points IS NOT NULL),
  UNIQUE(tenant_id,store_id,id),
  UNIQUE(tenant_id,store_id,activity_id,area_id,version),
  FOREIGN KEY(tenant_id,store_id,activity_id) REFERENCES mbox.community_activities(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,area_id) REFERENCES mbox.areas(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,created_by) REFERENCES mbox.employees(tenant_id,store_id,id)
);
CREATE TRIGGER table_ticket_offer_history BEFORE UPDATE OR DELETE ON mbox.table_ticket_offers
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();
ALTER TABLE mbox.table_ticket_offers ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.table_ticket_offers FORCE ROW LEVEL SECURITY;
CREATE POLICY scoped ON mbox.table_ticket_offers USING
  (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())
  WITH CHECK (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
GRANT SELECT,INSERT ON mbox.table_ticket_offers TO mbox_runtime;
UPDATE mbox.normalized_schema_metadata SET schema_version='323',updated_at=clock_timestamp() WHERE singleton;
COMMIT;
