BEGIN;
CREATE TABLE mbox.table_ticket_assistance(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,employee_id uuid NOT NULL,
  offer_id uuid NOT NULL,quantity integer NOT NULL CHECK(quantity>0),phone_hashes text[] NOT NULL CHECK(cardinality(phone_hashes)>0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '30 minutes',
  registration_id uuid,UNIQUE(tenant_id,store_id,registration_id),
  FOREIGN KEY(tenant_id,store_id,employee_id) REFERENCES mbox.employees(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,offer_id) REFERENCES mbox.table_ticket_offers(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,registration_id) REFERENCES mbox.table_ticket_purchases(tenant_id,store_id,registration_id)
);
ALTER TABLE mbox.table_ticket_assistance ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.table_ticket_assistance FORCE ROW LEVEL SECURITY;
CREATE POLICY scoped ON mbox.table_ticket_assistance USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())
 WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
GRANT SELECT,INSERT,UPDATE(registration_id) ON mbox.table_ticket_assistance TO mbox_runtime;
UPDATE mbox.normalized_schema_metadata SET schema_version='337',updated_at=clock_timestamp() WHERE singleton;
COMMIT;
