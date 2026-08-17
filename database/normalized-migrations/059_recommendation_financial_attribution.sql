BEGIN;

ALTER TABLE mbox.recommendation_behavior_events
  ADD COLUMN payment_id uuid,
  ADD COLUMN refund_id uuid,
  ADD COLUMN order_item_id uuid,
  ADD COLUMN attributed_amount_minor bigint,
  ADD COLUMN attributed_currency char(3);

-- Bind the three financial references to the same order/payment rather than
-- accepting individually valid IDs from another order or store.
CREATE UNIQUE INDEX payments_store_order_id_uq
  ON mbox.payments (tenant_id, store_id, order_id, id);
CREATE UNIQUE INDEX refunds_store_payment_id_uq
  ON mbox.refunds (tenant_id, store_id, payment_id, id);
CREATE UNIQUE INDEX order_items_store_order_id_uq
  ON mbox.order_items (tenant_id, store_id, order_id, id);

ALTER TABLE mbox.recommendation_behavior_events
  ADD CONSTRAINT recommendation_behavior_events_payment_order_fk
    FOREIGN KEY (tenant_id, store_id, order_id, payment_id)
    REFERENCES mbox.payments(tenant_id, store_id, order_id, id),
  ADD CONSTRAINT recommendation_behavior_events_refund_payment_fk
    FOREIGN KEY (tenant_id, store_id, payment_id, refund_id)
    REFERENCES mbox.refunds(tenant_id, store_id, payment_id, id),
  ADD CONSTRAINT recommendation_behavior_events_item_order_fk
    FOREIGN KEY (tenant_id, store_id, order_id, order_item_id)
    REFERENCES mbox.order_items(tenant_id, store_id, order_id, id),
  ADD CONSTRAINT recommendation_behavior_events_refund_item_fk
    FOREIGN KEY (tenant_id, store_id, refund_id, order_item_id)
    REFERENCES mbox.refund_items(tenant_id, store_id, refund_id, order_item_id);

-- Migration 051 made the event ledger append-only. Temporarily suspend only
-- that protection while backfilling the exact order item for legacy ordered
-- events; the enclosing migration transaction restores it atomically.
ALTER TABLE mbox.recommendation_behavior_events
  DISABLE TRIGGER recommendation_behavior_events_append_only;

UPDATE mbox.recommendation_behavior_events AS event
SET order_item_id = (
  SELECT item.id
  FROM mbox.recommendation_options AS option
  JOIN mbox.order_items AS item
    ON item.tenant_id=option.tenant_id AND item.store_id=option.store_id
   AND item.order_id=event.order_id AND item.product_id=option.product_id
   AND item.parent_order_item_id IS NULL AND item.quantity > 0
   AND item.status <> 'cancelled'
  WHERE option.tenant_id=event.tenant_id AND option.store_id=event.store_id
    AND option.id=event.recommendation_option_id
  ORDER BY item.created_at, item.id
  LIMIT 1
)
WHERE event.event_type='ordered' AND event.order_item_id IS NULL;

ALTER TABLE mbox.recommendation_behavior_events
  ENABLE TRIGGER recommendation_behavior_events_append_only;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM mbox.recommendation_behavior_events
    WHERE event_type='ordered' AND order_item_id IS NULL
  ) THEN
    RAISE EXCEPTION 'ordered recommendation events require an attributable order item before migration 059';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM mbox.recommendation_behavior_events
    WHERE event_type IN ('paid','refunded')
  ) THEN
    RAISE EXCEPTION 'pre-059 recommendation paid/refunded events are not authoritative and require manual review';
  END IF;
END $$;

ALTER TABLE mbox.recommendation_behavior_events
  ADD CONSTRAINT recommendation_behavior_events_financial_links_ck CHECK (
    CASE
      WHEN event_type='ordered' THEN
        recommendation_option_id IS NOT NULL
        AND order_id IS NOT NULL AND order_item_id IS NOT NULL
        AND payment_id IS NULL AND refund_id IS NULL
        AND attributed_amount_minor IS NULL AND attributed_currency IS NULL
      WHEN event_type='paid' THEN
        recommendation_option_id IS NOT NULL
        AND order_id IS NOT NULL AND order_item_id IS NOT NULL
        AND payment_id IS NOT NULL AND refund_id IS NULL
        AND attributed_amount_minor > 0
        AND attributed_currency ~ '^[A-Z]{3}$'
      WHEN event_type='refunded' THEN
        recommendation_option_id IS NOT NULL
        AND order_id IS NOT NULL AND order_item_id IS NOT NULL
        AND payment_id IS NOT NULL AND refund_id IS NOT NULL
        AND attributed_amount_minor > 0
        AND attributed_currency ~ '^[A-Z]{3}$'
      ELSE
        order_id IS NULL AND order_item_id IS NULL
        AND payment_id IS NULL AND refund_id IS NULL
        AND attributed_amount_minor IS NULL AND attributed_currency IS NULL
    END
  );

CREATE UNIQUE INDEX recommendation_behavior_events_ordered_uq
  ON mbox.recommendation_behavior_events (
    tenant_id, store_id, recommendation_session_id, recommendation_option_id, order_id
  ) WHERE event_type='ordered';

CREATE UNIQUE INDEX recommendation_behavior_events_paid_uq
  ON mbox.recommendation_behavior_events (
    tenant_id, store_id, recommendation_session_id, recommendation_option_id, order_id
  ) WHERE event_type='paid';

CREATE UNIQUE INDEX recommendation_behavior_events_refunded_uq
  ON mbox.recommendation_behavior_events (
    tenant_id, store_id, recommendation_session_id, recommendation_option_id, refund_id
  ) WHERE event_type='refunded';

COMMENT ON COLUMN mbox.recommendation_behavior_events.payment_id IS
  'Strong payment authority for a paid/refunded recommendation event; never accepted from a client.';
COMMENT ON COLUMN mbox.recommendation_behavior_events.refund_id IS
  'Strong successful refund authority for a refunded recommendation event.';
COMMENT ON COLUMN mbox.recommendation_behavior_events.order_item_id IS
  'Exact recommended top-level order item used for payment and refund attribution.';
COMMENT ON COLUMN mbox.recommendation_behavior_events.attributed_amount_minor IS
  'Authoritative item paid/refunded amount in minor units; never parsed from evidence JSON.';
COMMENT ON COLUMN mbox.recommendation_behavior_events.attributed_currency IS
  'Authoritative ISO currency paired with attributed_amount_minor.';

UPDATE mbox.normalized_schema_metadata
SET schema_version='059', updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
