BEGIN;

CREATE UNIQUE INDEX payments_one_active_intent_per_order_uq
  ON mbox.payments (tenant_id, store_id, order_id)
  WHERE status IN ('created', 'pending');

COMMIT;
