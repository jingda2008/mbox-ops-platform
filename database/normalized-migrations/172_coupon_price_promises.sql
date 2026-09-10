BEGIN;
-- A low-price promise is not a gift and not a cash-value deduction. Existing
-- campaigns remain free gifts; no existing benefit is reclassified.
ALTER TABLE mbox.member_gift_campaign_versions
  ADD COLUMN pricing_kind text NOT NULL DEFAULT 'free' CHECK(pricing_kind IN('free','fixed_price')),
  ADD COLUMN fixed_price_minor bigint,
  ADD COLUMN stacking_version_id uuid,
  ADD CONSTRAINT gift_campaign_fixed_price CHECK(
    (pricing_kind='free' AND fixed_price_minor IS NULL AND stacking_version_id IS NULL)
    OR(pricing_kind='fixed_price' AND fixed_price_minor BETWEEN 1 AND 9007199254740991 AND stacking_version_id IS NOT NULL)
  ),
  ADD CONSTRAINT gift_campaign_stacking_version FOREIGN KEY(tenant_id,store_id,stacking_version_id) REFERENCES mbox.stacking_pricing_drafts(tenant_id,store_id,id);
CREATE TABLE mbox.benefit_coupon_price_promises(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,
  benefit_id uuid NOT NULL,campaign_version_id uuid NOT NULL,stacking_version_id uuid NOT NULL,
  fixed_price_minor bigint NOT NULL CHECK(fixed_price_minor BETWEEN 1 AND 9007199254740991),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(tenant_id,store_id,benefit_id),UNIQUE(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,benefit_id) REFERENCES mbox.benefits(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,campaign_version_id) REFERENCES mbox.member_gift_campaign_versions(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,stacking_version_id) REFERENCES mbox.stacking_pricing_drafts(tenant_id,store_id,id)
);
CREATE FUNCTION mbox.validate_coupon_price_promise() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE campaign mbox.member_gift_campaign_versions;
BEGIN
  SELECT * INTO campaign FROM mbox.member_gift_campaign_versions WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=NEW.campaign_version_id FOR SHARE;
  IF campaign.id IS NULL OR campaign.status<>'published' OR campaign.pricing_kind<>'fixed_price' OR NEW.fixed_price_minor IS DISTINCT FROM campaign.fixed_price_minor OR NEW.stacking_version_id IS DISTINCT FROM campaign.stacking_version_id THEN RAISE EXCEPTION 'Coupon promise requires exact published campaign price'; END IF;
  PERFORM 1 FROM mbox.stacking_pricing_drafts WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=NEW.stacking_version_id FOR SHARE;
  IF NOT EXISTS(SELECT 1 FROM mbox.stacking_pricing_decisions WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND version_id=NEW.stacking_version_id AND action='publish') OR EXISTS(SELECT 1 FROM mbox.stacking_pricing_decisions WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND version_id=NEW.stacking_version_id AND action='stop_issuing') THEN RAISE EXCEPTION 'Coupon stacking rule is not available for new issuance'; END IF;
  IF NOT EXISTS(SELECT 1 FROM mbox.benefits WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=NEW.benefit_id AND benefit_type='discount' AND currency='CNY' AND quantity_redeemed=0 AND quantity_reserved=0) THEN RAISE EXCEPTION 'Low price coupon must be an unused discount benefit'; END IF;
  IF NOT EXISTS(SELECT 1 FROM mbox.member_gift_campaign_products WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND campaign_version_id=NEW.campaign_version_id) OR EXISTS(SELECT 1 FROM mbox.member_gift_campaign_products WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND campaign_version_id=NEW.campaign_version_id AND unit_price_minor<=NEW.fixed_price_minor) THEN RAISE EXCEPTION 'Low price pool must contain positive price savings'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER validate_coupon_price_promise BEFORE INSERT ON mbox.benefit_coupon_price_promises FOR EACH ROW EXECUTE FUNCTION mbox.validate_coupon_price_promise();
CREATE TRIGGER coupon_price_promise_append_only BEFORE UPDATE OR DELETE ON mbox.benefit_coupon_price_promises FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();
ALTER TABLE mbox.benefit_coupon_price_promises ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.benefit_coupon_price_promises FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.benefit_coupon_price_promises USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
REVOKE ALL ON mbox.benefit_coupon_price_promises FROM PUBLIC,mbox_runtime;
GRANT SELECT,INSERT ON mbox.benefit_coupon_price_promises TO mbox_runtime;
REVOKE ALL ON FUNCTION mbox.validate_coupon_price_promise() FROM PUBLIC;
CREATE OR REPLACE FUNCTION mbox.protect_member_gift_job() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE campaign mbox.member_gift_campaign_versions; benefit mbox.benefits;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'pending' OR NEW.attempts<>0 THEN RAISE EXCEPTION 'Gift delivery must begin pending'; END IF;
    SELECT * INTO campaign FROM mbox.member_gift_campaign_versions WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=NEW.campaign_version_id;
    IF campaign.status NOT IN('published','stopped') OR NEW.quantity<>campaign.quantity_per_customer THEN RAISE EXCEPTION 'Gift delivery requires published campaign quantity'; END IF;
    IF campaign.trigger_kind='card_entry' THEN
      IF NEW.cycle_key<>'entry' OR NOT EXISTS(SELECT 1 FROM mbox.member_card_applications a WHERE a.tenant_id=NEW.tenant_id AND a.store_id=NEW.store_id AND a.id=NEW.source_application_id AND a.project_id=campaign.card_project_id AND a.status='approved' AND a.resolved_at>=campaign.published_at AND a.resolved_at>=campaign.available_from AND a.resolved_at<campaign.available_until AND (campaign.stopped_at IS NULL OR a.resolved_at<campaign.stopped_at) AND mbox.canonical_customer_id(a.tenant_id,a.store_id,a.customer_id)=mbox.canonical_customer_id(NEW.tenant_id,NEW.store_id,NEW.customer_id)) THEN RAISE EXCEPTION 'Gift entry requires approved same-family application'; END IF;
    ELSIF NEW.source_application_id IS NOT NULL OR campaign.status<>'published' THEN RAISE EXCEPTION 'Targeted gift requires open campaign and cannot impersonate card entry'; END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id,NEW.tenant_id,NEW.store_id,NEW.campaign_version_id,NEW.campaign_code,NEW.cycle_key,NEW.customer_id,NEW.source_application_id,NEW.quantity,NEW.created_at)
    IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.store_id,OLD.campaign_version_id,OLD.campaign_code,OLD.cycle_key,OLD.customer_id,OLD.source_application_id,OLD.quantity,OLD.created_at) THEN RAISE EXCEPTION 'Gift delivery identity is immutable'; END IF;
  IF OLD.status IN('issued','cancelled','duplicate') AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Completed gift delivery is immutable'; END IF;
  IF NEW.attempts<OLD.attempts THEN RAISE EXCEPTION 'Gift delivery attempts cannot decrease'; END IF;
  IF NEW.status='issued' THEN
    SELECT * INTO campaign FROM mbox.member_gift_campaign_versions WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=NEW.campaign_version_id;
    SELECT * INTO benefit FROM mbox.benefits WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=NEW.benefit_id;
    IF benefit.id IS NULL OR benefit.quantity_total<>NEW.quantity OR benefit.issuance_idempotency_key<>('member-gift:'||NEW.id::text) OR mbox.canonical_customer_id(benefit.tenant_id,benefit.store_id,benefit.customer_id)<>mbox.canonical_customer_id(NEW.tenant_id,NEW.store_id,NEW.customer_id) THEN RAISE EXCEPTION 'Gift delivery benefit mismatch'; END IF;
    IF campaign.pricing_kind='free' AND benefit.benefit_type<>'gift_product' THEN RAISE EXCEPTION 'Free gift requires product benefit'; END IF;
    IF campaign.pricing_kind='fixed_price' AND (benefit.benefit_type<>'discount' OR NOT EXISTS(SELECT 1 FROM mbox.benefit_coupon_price_promises p WHERE p.tenant_id=NEW.tenant_id AND p.store_id=NEW.store_id AND p.benefit_id=benefit.id AND p.campaign_version_id=campaign.id AND p.fixed_price_minor=campaign.fixed_price_minor AND p.stacking_version_id=campaign.stacking_version_id)) THEN RAISE EXCEPTION 'Fixed price delivery requires exact coupon promise'; END IF;
  END IF;
  RETURN NEW;
END $$;
UPDATE mbox.normalized_schema_metadata SET schema_version='172',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
