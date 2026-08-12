BEGIN;

ALTER TABLE mbox.orders
  ADD COLUMN created_by_customer_id uuid,
  ADD CONSTRAINT orders_created_by_customer_fk
    FOREIGN KEY (tenant_id, store_id, created_by_customer_id)
    REFERENCES mbox.customers(tenant_id, store_id, id),
  ADD CONSTRAINT orders_single_creator_ck
    CHECK (created_by_employee_id IS NULL OR created_by_customer_id IS NULL);

CREATE INDEX orders_guest_owner_timeline_idx
  ON mbox.orders (
    tenant_id, store_id, table_session_id, created_by_customer_id, created_at DESC, id
  )
  WHERE created_by_customer_id IS NOT NULL;

COMMENT ON COLUMN mbox.orders.created_by_customer_id IS
  'Authenticated guest customer that created the order. Used only for pending-order privacy and audit; never exposed to table peers.';

COMMIT;
