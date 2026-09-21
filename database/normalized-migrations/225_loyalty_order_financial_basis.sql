BEGIN;

-- A sale's award is anchored to the receipt which completed it. Its refunds may
-- return any other receipt allocated to that same order. Keep both identities
-- strongly scoped without rewriting historical money or award facts.
ALTER TABLE mbox.loyalty_order_awards ADD CONSTRAINT loyalty_award_order_identity_uq
  UNIQUE (tenant_id,store_id,id,order_id);
DO $$ DECLARE constraint_name text; BEGIN
  SELECT conname INTO STRICT constraint_name FROM pg_constraint
  WHERE conrelid='mbox.loyalty_award_refund_applications'::regclass
    AND confrelid='mbox.loyalty_order_awards'::regclass AND contype='f';
  EXECUTE format('ALTER TABLE mbox.loyalty_award_refund_applications DROP CONSTRAINT %I',constraint_name);
END $$;
ALTER TABLE mbox.loyalty_award_refund_applications
  ADD CONSTRAINT loyalty_application_award_order_fk FOREIGN KEY (tenant_id,store_id,award_id,order_id)
    REFERENCES mbox.loyalty_order_awards(tenant_id,store_id,id,order_id);
CREATE FUNCTION mbox.validate_loyalty_refund_order() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM mbox.refunds refund JOIN mbox.payments payment
    ON payment.tenant_id=refund.tenant_id AND payment.store_id=refund.store_id AND payment.id=refund.payment_id
  WHERE refund.tenant_id=NEW.tenant_id AND refund.store_id=NEW.store_id AND refund.id=NEW.refund_id
    AND refund.payment_id=NEW.payment_id AND refund.status='succeeded' AND COALESCE(refund.order_id,payment.order_id)=NEW.order_id
 ) THEN RAISE EXCEPTION 'loyalty refund does not belong to original order' USING ERRCODE='23503'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION mbox.validate_loyalty_refund_order() FROM PUBLIC;
CREATE TRIGGER loyalty_application_refund_order BEFORE INSERT ON mbox.loyalty_award_refund_applications
 FOR EACH ROW EXECUTE FUNCTION mbox.validate_loyalty_refund_order();

-- Gross eligible sale basis: unpaid reductions never earned rewards. Paid
-- returns are intentionally preserved here and reversed only on actual refund
-- success. Whole returned lines retain their original eligibility as well.
CREATE VIEW mbox.loyalty_order_item_basis WITH (security_invoker=true) AS
SELECT item.tenant_id,item.store_id,item.order_id,item.id AS order_item_id,
  GREATEST(0,item.total_amount_minor-COALESCE((
    SELECT SUM(adjustment.amount_minor)
    FROM mbox.item_receivable_adjustment_facts adjustment
    JOIN mbox.item_after_sales_cases target ON target.tenant_id=adjustment.tenant_id
      AND target.store_id=adjustment.store_id AND target.id=adjustment.case_id
    WHERE adjustment.tenant_id=item.tenant_id AND adjustment.store_id=item.store_id
      AND adjustment.order_item_id=item.id
      AND COALESCE(target.resolved_kind,target.kind)='unpaid_stop'
  ),0))::bigint AS amount_minor,
  item.loyalty_eligible_at_submission AND NOT EXISTS (
    SELECT 1 FROM mbox.pricing_authorizations authz
    WHERE authz.tenant_id=item.tenant_id AND authz.store_id=item.store_id
      AND authz.order_id=item.order_id AND authz.status='consumed' AND authz.kind='gift'
  ) AS loyalty_eligible
FROM mbox.order_items item
WHERE item.parent_order_item_id IS NULL AND item.total_amount_minor>0
  AND (item.status<>'cancelled' OR EXISTS (
    SELECT 1 FROM mbox.refund_items allocation JOIN mbox.refunds refund
      ON refund.tenant_id=allocation.tenant_id AND refund.store_id=allocation.store_id AND refund.id=allocation.refund_id
    WHERE allocation.tenant_id=item.tenant_id AND allocation.store_id=item.store_id
      AND allocation.order_item_id=item.id AND refund.status='succeeded'
  ));
GRANT SELECT ON mbox.loyalty_order_item_basis TO mbox_runtime;

-- A mixed-eligibility refund crossing a genuine excess receipt has no approved
-- allocation policy. Preserve money settlement, expose a durable review fact,
-- and do not manufacture a reward allocation or mark it applied.
CREATE TABLE mbox.loyalty_refund_reviews (
  tenant_id uuid NOT NULL,store_id uuid NOT NULL,order_id uuid NOT NULL,
  refund_id uuid NOT NULL,payment_id uuid NOT NULL,
  reason text NOT NULL CHECK(reason IN ('mixed_eligibility_overcollection','prior_refund_review')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,store_id,refund_id),
  FOREIGN KEY(tenant_id,store_id,order_id) REFERENCES mbox.orders(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,refund_id,payment_id)
    REFERENCES mbox.refunds(tenant_id,store_id,id,payment_id)
);
CREATE TRIGGER loyalty_review_refund_order BEFORE INSERT ON mbox.loyalty_refund_reviews
 FOR EACH ROW EXECUTE FUNCTION mbox.validate_loyalty_refund_order();
CREATE INDEX loyalty_refund_reviews_order_idx ON mbox.loyalty_refund_reviews(tenant_id,store_id,order_id);
ALTER TABLE mbox.loyalty_refund_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.loyalty_refund_reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY loyalty_refund_review_scope ON mbox.loyalty_refund_reviews
 USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())
 WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
CREATE TRIGGER loyalty_refund_reviews_append_only BEFORE UPDATE OR DELETE ON mbox.loyalty_refund_reviews
 FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();
GRANT SELECT,INSERT ON mbox.loyalty_refund_reviews TO mbox_runtime;

UPDATE mbox.normalized_schema_metadata SET schema_version='225',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';
COMMIT;
