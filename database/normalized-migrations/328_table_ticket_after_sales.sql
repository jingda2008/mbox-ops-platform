BEGIN;
SET LOCAL lock_timeout='3s';
ALTER TABLE mbox.table_tickets ADD COLUMN refunded_at timestamptz;
CREATE TABLE mbox.table_ticket_refund_requests (
  tenant_id uuid NOT NULL,store_id uuid NOT NULL,id uuid NOT NULL DEFAULT gen_random_uuid(),ticket_id uuid NOT NULL,
  customer_id uuid NOT NULL,reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 2 AND 500),
  status text NOT NULL CHECK(status IN('review','requested','refunded','rejected','cancelled')),
  refund_id uuid, frozen_points integer NOT NULL CHECK(frozen_points>=0),
  consumed_minor bigint NOT NULL CHECK(consumed_minor>=0),
  source_review_required boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,store_id,id),
  UNIQUE(tenant_id,store_id,refund_id),
  FOREIGN KEY(tenant_id,store_id,ticket_id) REFERENCES mbox.table_tickets(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,refund_id) REFERENCES mbox.refunds(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,customer_id) REFERENCES mbox.customers(tenant_id,store_id,id)
);
CREATE UNIQUE INDEX table_ticket_refund_active ON mbox.table_ticket_refund_requests(tenant_id,store_id,ticket_id)
  WHERE status NOT IN('rejected','cancelled');
ALTER TABLE mbox.table_ticket_refund_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.table_ticket_refund_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY scoped ON mbox.table_ticket_refund_requests USING
 (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK
 (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
GRANT SELECT,INSERT,UPDATE(status,refund_id) ON mbox.table_ticket_refund_requests TO mbox_runtime;
GRANT UPDATE(refunded_at) ON mbox.table_tickets TO mbox_runtime;
UPDATE mbox.normalized_schema_metadata SET schema_version='328',updated_at=clock_timestamp() WHERE singleton;
COMMIT;
