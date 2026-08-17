BEGIN;

ALTER TABLE mbox.order_items
  ADD COLUMN loyalty_eligible_at_submission boolean,
  ADD COLUMN loyalty_eligibility_source text
    CHECK (loyalty_eligibility_source IN ('catalog_product', 'included_in_parent', 'legacy_current_catalog'));

UPDATE mbox.order_items AS item
SET loyalty_eligible_at_submission = CASE
      WHEN item.parent_order_item_id IS NOT NULL OR item.total_amount_minor = 0 THEN false
      ELSE product.loyalty_eligible
    END,
    loyalty_eligibility_source = CASE
      WHEN item.parent_order_item_id IS NOT NULL OR item.total_amount_minor = 0 THEN 'included_in_parent'
      ELSE 'legacy_current_catalog'
    END
FROM mbox.products AS product
WHERE product.tenant_id=item.tenant_id AND product.store_id=item.store_id
  AND product.id=item.product_id;

ALTER TABLE mbox.order_items
  ALTER COLUMN loyalty_eligible_at_submission SET DEFAULT false,
  ALTER COLUMN loyalty_eligible_at_submission SET NOT NULL,
  ALTER COLUMN loyalty_eligibility_source SET DEFAULT 'legacy_current_catalog',
  ALTER COLUMN loyalty_eligibility_source SET NOT NULL,
  ADD CONSTRAINT order_items_loyalty_eligibility_consistency CHECK (
    (parent_order_item_id IS NULL AND loyalty_eligibility_source IN ('catalog_product', 'legacy_current_catalog'))
    OR (parent_order_item_id IS NOT NULL AND loyalty_eligibility_source IN ('included_in_parent', 'legacy_current_catalog')
      AND loyalty_eligible_at_submission=false)
  );

CREATE TABLE mbox.loyalty_point_lots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  source_ledger_entry_id uuid,
  source_type text NOT NULL CHECK (source_type IN ('order', 'supplement', 'adjust', 'restore', 'legacy_balance')),
  source_id text NOT NULL CHECK (length(btrim(source_id)) BETWEEN 1 AND 128),
  original_points integer NOT NULL CHECK (original_points > 0),
  remaining_points integer NOT NULL CHECK (remaining_points BETWEEN 0 AND original_points),
  available_at timestamptz NOT NULL,
  expires_at timestamptz,
  status text NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'consumed', 'expired', 'reversed')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, membership_id)
    REFERENCES mbox.customer_memberships(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, customer_id)
    REFERENCES mbox.customers(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, source_ledger_entry_id)
    REFERENCES mbox.loyalty_point_ledger(tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, source_ledger_entry_id),
  UNIQUE (tenant_id, store_id, id),
  CHECK (expires_at IS NULL OR expires_at > available_at),
  CHECK (
    (status='available' AND remaining_points > 0)
    OR (status IN ('consumed', 'expired', 'reversed') AND remaining_points=0)
  )
);

CREATE TABLE mbox.loyalty_point_lot_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  lot_id uuid NOT NULL,
  movement_type text NOT NULL CHECK (movement_type IN ('grant', 'redeem', 'expire', 'reverse', 'restore', 'recovery_debt')),
  points_delta integer NOT NULL CHECK (points_delta <> 0),
  balance_after integer NOT NULL CHECK (balance_after >= 0),
  source_type text NOT NULL CHECK (source_type IN ('order', 'refund', 'redemption', 'supplement', 'manual', 'system', 'legacy_balance')),
  source_id text NOT NULL CHECK (length(btrim(source_id)) BETWEEN 1 AND 128),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 160),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, lot_id)
    REFERENCES mbox.loyalty_point_lots(tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, idempotency_key),
  UNIQUE (tenant_id, store_id, id)
);

INSERT INTO mbox.loyalty_point_lots (
  tenant_id, store_id, membership_id, customer_id, source_type, source_id,
  original_points, remaining_points, available_at, expires_at, status
)
SELECT account.tenant_id, account.store_id, account.membership_id, account.customer_id,
  'legacy_balance', 'migration-073-opening-balance', account.available_points,
  account.available_points, clock_timestamp(), NULL, 'available'
FROM mbox.loyalty_accounts AS account
WHERE account.available_points > 0;

INSERT INTO mbox.loyalty_point_lot_movements (
  tenant_id, store_id, lot_id, movement_type, points_delta, balance_after,
  source_type, source_id, idempotency_key, occurred_at
)
SELECT lot.tenant_id, lot.store_id, lot.id, 'grant', lot.original_points,
  lot.remaining_points, 'legacy_balance', lot.source_id,
  'lot-opening:' || lot.id::text, lot.created_at
FROM mbox.loyalty_point_lots AS lot
WHERE lot.source_type='legacy_balance';

CREATE INDEX loyalty_point_lots_fifo_idx
  ON mbox.loyalty_point_lots (
    tenant_id, store_id, membership_id, expires_at NULLS LAST, available_at, id
  ) WHERE status='available' AND remaining_points > 0;
CREATE INDEX loyalty_point_lots_expiry_idx
  ON mbox.loyalty_point_lots (tenant_id, store_id, expires_at, id)
  WHERE status='available' AND remaining_points > 0 AND expires_at IS NOT NULL;
CREATE INDEX loyalty_point_lot_movements_timeline_idx
  ON mbox.loyalty_point_lot_movements (tenant_id, store_id, lot_id, occurred_at, id);

CREATE TRIGGER loyalty_point_lots_touch_updated_at
  BEFORE UPDATE ON mbox.loyalty_point_lots
  FOR EACH ROW EXECUTE FUNCTION mbox.touch_updated_at();
CREATE TRIGGER loyalty_point_lot_movements_append_only
  BEFORE UPDATE OR DELETE ON mbox.loyalty_point_lot_movements
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();

ALTER TABLE mbox.loyalty_point_lots ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.loyalty_point_lots FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.loyalty_point_lots
  USING (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())
  WITH CHECK (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
ALTER TABLE mbox.loyalty_point_lot_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.loyalty_point_lot_movements FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.loyalty_point_lot_movements
  USING (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())
  WITH CHECK (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());

GRANT SELECT, INSERT, UPDATE ON TABLE mbox.loyalty_point_lots TO mbox_runtime;
GRANT SELECT, INSERT ON TABLE mbox.loyalty_point_lot_movements TO mbox_runtime;
REVOKE DELETE ON TABLE mbox.loyalty_point_lots FROM mbox_runtime;
REVOKE UPDATE, DELETE ON TABLE mbox.loyalty_point_lot_movements FROM mbox_runtime;

COMMENT ON COLUMN mbox.order_items.loyalty_eligible_at_submission IS
  'Frozen loyalty eligibility used for accrual and refund reversal; runtime must not re-read the current product flag.';
COMMENT ON TABLE mbox.loyalty_point_lots IS
  'Authoritative expiring point lots. Redemption consumes earliest expiry first; current balance is the sum of remaining lots.';

COMMIT;
