BEGIN;

ALTER TABLE mbox.loyalty_order_awards
  ADD CONSTRAINT loyalty_order_awards_refund_application_fk_uq
    UNIQUE (tenant_id, store_id, id, order_id, payment_id);

ALTER TABLE mbox.refunds
  ADD CONSTRAINT refunds_loyalty_application_fk_uq
    UNIQUE (tenant_id, store_id, id, payment_id);

CREATE TABLE mbox.loyalty_award_refund_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  award_id uuid NOT NULL,
  refund_id uuid NOT NULL,
  order_id uuid NOT NULL,
  payment_id uuid NOT NULL,
  eligible_refund_amount_minor bigint NOT NULL CHECK (eligible_refund_amount_minor >= 0),
  reversed_points integer NOT NULL CHECK (reversed_points >= 0),
  reversed_growth integer NOT NULL CHECK (reversed_growth >= 0),
  applied_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, award_id, order_id, payment_id)
    REFERENCES mbox.loyalty_order_awards(tenant_id, store_id, id, order_id, payment_id),
  FOREIGN KEY (tenant_id, store_id, refund_id, payment_id)
    REFERENCES mbox.refunds(tenant_id, store_id, id, payment_id),
  UNIQUE (tenant_id, store_id, refund_id),
  UNIQUE (tenant_id, store_id, id)
);

CREATE INDEX loyalty_award_refund_applications_award_idx
  ON mbox.loyalty_award_refund_applications (
    tenant_id, store_id, award_id, applied_at, refund_id
  );

-- A refund-linked ledger row is only promotable when its typed order, payment,
-- policy, member and customer all identify exactly the same authoritative award.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM mbox.loyalty_point_ledger ledger
    LEFT JOIN mbox.refunds refund
      ON refund.tenant_id=ledger.tenant_id AND refund.store_id=ledger.store_id
     AND refund.id=ledger.refund_id AND refund.payment_id=ledger.payment_id
     AND refund.status='succeeded'
    LEFT JOIN mbox.loyalty_order_awards award
      ON award.tenant_id=ledger.tenant_id AND award.store_id=ledger.store_id
     AND award.membership_id=ledger.membership_id AND award.customer_id=ledger.customer_id
     AND award.order_id=ledger.order_id AND award.payment_id=ledger.payment_id
     AND award.policy_version_id=ledger.policy_version_id
    WHERE ledger.refund_id IS NOT NULL
      AND (ledger.entry_type<>'reverse' OR ledger.source_type<>'refund'
        OR ledger.points_delta>=0 OR refund.id IS NULL OR award.id IS NULL)
  ) THEN
    RAISE EXCEPTION 'migration 082 cannot map refund point ledgers to one authoritative award';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM mbox.loyalty_growth_ledger ledger
    LEFT JOIN mbox.refunds refund
      ON refund.tenant_id=ledger.tenant_id AND refund.store_id=ledger.store_id
     AND refund.id=ledger.refund_id AND refund.payment_id=ledger.payment_id
     AND refund.status='succeeded'
    LEFT JOIN mbox.loyalty_order_awards award
      ON award.tenant_id=ledger.tenant_id AND award.store_id=ledger.store_id
     AND award.membership_id=ledger.membership_id AND award.customer_id=ledger.customer_id
     AND award.order_id=ledger.order_id AND award.payment_id=ledger.payment_id
     AND award.policy_version_id=ledger.policy_version_id
    WHERE ledger.refund_id IS NOT NULL
      AND (ledger.entry_type<>'reverse' OR ledger.growth_delta>=0
        OR refund.id IS NULL OR award.id IS NULL)
  ) THEN
    RAISE EXCEPTION 'migration 082 cannot map refund growth ledgers to one authoritative award';
  END IF;
END $$;

CREATE TEMP TABLE loyalty_refund_application_backfill ON COMMIT DROP AS
WITH eligible_refunds AS (
  SELECT award.tenant_id, award.store_id, award.id AS award_id,
    award.order_id, award.payment_id, refund.id AS refund_id,
    COALESCE(SUM(refund_item.amount_minor) FILTER (
      WHERE item.parent_order_item_id IS NULL
        AND item.loyalty_eligible_at_submission
    ),0)::bigint AS eligible_refund_amount_minor,
    refund.completed_at AS applied_at
  FROM mbox.loyalty_order_awards award
  JOIN mbox.refunds refund
    ON refund.tenant_id=award.tenant_id AND refund.store_id=award.store_id
   AND refund.payment_id=award.payment_id AND refund.status='succeeded'
  LEFT JOIN mbox.refund_items refund_item
    ON refund_item.tenant_id=refund.tenant_id AND refund_item.store_id=refund.store_id
   AND refund_item.refund_id=refund.id
  LEFT JOIN mbox.order_items item
    ON item.tenant_id=refund_item.tenant_id AND item.store_id=refund_item.store_id
   AND item.id=refund_item.order_item_id AND item.order_id=award.order_id
  GROUP BY award.tenant_id, award.store_id, award.id, award.order_id,
    award.payment_id, refund.id, refund.completed_at
), point_reversals AS (
  SELECT ledger.tenant_id, ledger.store_id, ledger.refund_id,
    SUM(-ledger.points_delta)::integer AS reversed_points
  FROM mbox.loyalty_point_ledger ledger
  WHERE ledger.refund_id IS NOT NULL AND ledger.entry_type='reverse'
    AND ledger.source_type='refund' AND ledger.points_delta<0
  GROUP BY ledger.tenant_id, ledger.store_id, ledger.refund_id
), growth_reversals AS (
  SELECT ledger.tenant_id, ledger.store_id, ledger.refund_id,
    SUM(-ledger.growth_delta)::integer AS reversed_growth
  FROM mbox.loyalty_growth_ledger ledger
  WHERE ledger.refund_id IS NOT NULL AND ledger.entry_type='reverse'
    AND ledger.growth_delta<0
  GROUP BY ledger.tenant_id, ledger.store_id, ledger.refund_id
)
SELECT eligible.tenant_id, eligible.store_id, eligible.award_id,
  eligible.refund_id, eligible.order_id, eligible.payment_id,
  eligible.eligible_refund_amount_minor,
  COALESCE(points.reversed_points,0)::integer AS reversed_points,
  COALESCE(growth.reversed_growth,0)::integer AS reversed_growth,
  eligible.applied_at
FROM eligible_refunds eligible
LEFT JOIN point_reversals points
  ON points.tenant_id=eligible.tenant_id AND points.store_id=eligible.store_id
 AND points.refund_id=eligible.refund_id
LEFT JOIN growth_reversals growth
  ON growth.tenant_id=eligible.tenant_id AND growth.store_id=eligible.store_id
 AND growth.refund_id=eligible.refund_id;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM loyalty_refund_application_backfill backfill
    JOIN mbox.loyalty_order_awards award
      ON award.tenant_id=backfill.tenant_id AND award.store_id=backfill.store_id
     AND award.id=backfill.award_id
    GROUP BY award.tenant_id, award.store_id, award.id, award.eligible_amount_minor,
      award.awarded_points, award.awarded_growth, award.reversed_amount_minor,
      award.reversed_points, award.reversed_growth
    HAVING award.reversed_amount_minor > SUM(backfill.eligible_refund_amount_minor)
      OR SUM(backfill.eligible_refund_amount_minor) > award.eligible_amount_minor
      OR SUM(backfill.reversed_points) <> award.reversed_points
      OR SUM(backfill.reversed_growth) <> award.reversed_growth
      OR SUM(backfill.reversed_points) < 0
      OR SUM(backfill.reversed_growth) < 0
      OR SUM(backfill.reversed_points) > award.awarded_points
      OR SUM(backfill.reversed_growth) > award.awarded_growth
      OR SUM(backfill.reversed_points) <>
        CASE WHEN award.eligible_amount_minor=0 THEN 0
          WHEN SUM(backfill.eligible_refund_amount_minor)>=award.eligible_amount_minor
            THEN award.awarded_points
          ELSE ((award.awarded_points::bigint * SUM(backfill.eligible_refund_amount_minor))
            / award.eligible_amount_minor)::integer END
      OR SUM(backfill.reversed_growth) <>
        CASE WHEN award.eligible_amount_minor=0 THEN 0
          WHEN SUM(backfill.eligible_refund_amount_minor)>=award.eligible_amount_minor
            THEN award.awarded_growth
          ELSE ((award.awarded_growth::bigint * SUM(backfill.eligible_refund_amount_minor))
            / award.eligible_amount_minor)::integer END
      OR award.reversed_points <>
        CASE WHEN award.eligible_amount_minor=0 THEN 0
          WHEN award.reversed_amount_minor>=award.eligible_amount_minor THEN award.awarded_points
          ELSE ((award.awarded_points::bigint * award.reversed_amount_minor)
            / award.eligible_amount_minor)::integer END
      OR award.reversed_growth <>
        CASE WHEN award.eligible_amount_minor=0 THEN 0
          WHEN award.reversed_amount_minor>=award.eligible_amount_minor THEN award.awarded_growth
          ELSE ((award.awarded_growth::bigint * award.reversed_amount_minor)
            / award.eligible_amount_minor)::integer END
  ) THEN
    RAISE EXCEPTION 'migration 082 refund facts do not reconcile with loyalty award aggregates';
  END IF;
END $$;

-- The amount accumulator may be behind only when an old tiny refund rounded to
-- zero. The strong refund items and already-reconciled ledgers make this repair exact.
UPDATE mbox.loyalty_order_awards award
SET reversed_amount_minor=backfill.total_eligible_refund_amount_minor
FROM (
  SELECT tenant_id, store_id, award_id,
    SUM(eligible_refund_amount_minor)::bigint AS total_eligible_refund_amount_minor
  FROM loyalty_refund_application_backfill
  GROUP BY tenant_id, store_id, award_id
) backfill
WHERE award.tenant_id=backfill.tenant_id AND award.store_id=backfill.store_id
  AND award.id=backfill.award_id
  AND award.reversed_amount_minor<>backfill.total_eligible_refund_amount_minor;

INSERT INTO mbox.loyalty_award_refund_applications (
  tenant_id, store_id, award_id, refund_id, order_id, payment_id,
  eligible_refund_amount_minor, reversed_points, reversed_growth, applied_at
)
SELECT tenant_id, store_id, award_id, refund_id, order_id, payment_id,
  eligible_refund_amount_minor, reversed_points, reversed_growth, applied_at
FROM loyalty_refund_application_backfill;

CREATE TRIGGER loyalty_award_refund_applications_append_only
  BEFORE UPDATE OR DELETE ON mbox.loyalty_award_refund_applications
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();

ALTER TABLE mbox.loyalty_award_refund_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.loyalty_award_refund_applications FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.loyalty_award_refund_applications
  USING (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())
  WITH CHECK (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());

GRANT SELECT, INSERT ON TABLE mbox.loyalty_award_refund_applications TO mbox_runtime;

COMMENT ON TABLE mbox.loyalty_award_refund_applications IS
  'Append-only one-refund application facts. Amount, points and growth are typed and never inferred from JSON evidence.';

UPDATE mbox.normalized_schema_metadata
SET schema_version='082',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
