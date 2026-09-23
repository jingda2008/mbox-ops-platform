BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';

-- Keep invoker rights and existing RLS. Immutable evidence needs no row UPDATE
-- privilege; decision/issuance ordering uses the existing scoped advisory key.

CREATE OR REPLACE FUNCTION mbox.validate_membership_configuration_approval_fact()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE preview_row record;
BEGIN
  SELECT * INTO preview_row FROM mbox.membership_configuration_impact_previews preview
  WHERE preview.tenant_id=NEW.tenant_id AND preview.store_id=NEW.store_id
    AND preview.id=NEW.impact_preview_id;
  IF preview_row.id IS NULL OR preview_row.configuration_domain<>NEW.configuration_domain
    OR preview_row.configuration_id<>NEW.configuration_id
    OR preview_row.draft_revision<>NEW.draft_revision
    OR preview_row.fingerprint<>NEW.impact_fingerprint
    OR preview_row.expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'approval requires a current server impact preview for the exact draft revision';
  END IF;
  IF EXISTS (SELECT 1 FROM mbox.membership_configuration_draft_contributors contributor
    WHERE contributor.tenant_id=NEW.tenant_id AND contributor.store_id=NEW.store_id
      AND contributor.configuration_domain=NEW.configuration_domain
      AND contributor.configuration_id=NEW.configuration_id
      AND contributor.employee_id=NEW.approved_by_employee_id) THEN
    RAISE EXCEPTION 'a membership configuration contributor cannot approve the same draft';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION mbox.validate_stacking_pricing_decision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE author uuid;approver uuid;
BEGIN
  -- Share the repository issuance/decision lock; drafts and decisions stay append-only.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'stacking-release:'||NEW.tenant_id::text||':'||NEW.store_id::text||':'||NEW.version_id::text,0));
  SELECT created_by_employee_id INTO author FROM mbox.stacking_pricing_drafts WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=NEW.version_id;
  IF author IS NULL THEN RAISE EXCEPTION 'Unknown stacking policy'; END IF;
  IF EXISTS(SELECT 1 FROM mbox.stacking_pricing_decisions WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND version_id=NEW.version_id AND action='stop_issuing') THEN RAISE EXCEPTION 'Stacking policy issuance is stopped'; END IF;
  IF NEW.action IN('approve','publish') AND NEW.employee_id=author THEN RAISE EXCEPTION 'Stacking author cannot approve or publish'; END IF;
  SELECT employee_id INTO approver FROM mbox.stacking_pricing_decisions WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND version_id=NEW.version_id AND action='approve';
  IF NEW.action='publish' AND (approver IS NULL OR approver=NEW.employee_id) THEN RAISE EXCEPTION 'Stacking policy requires three distinct actors'; END IF;
  IF NEW.action='stop_issuing' AND NOT EXISTS(SELECT 1 FROM mbox.stacking_pricing_decisions WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND version_id=NEW.version_id AND action='publish') THEN RAISE EXCEPTION 'Only published stacking policy can stop issuance'; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION mbox.validate_coupon_price_promise() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE campaign mbox.member_gift_campaign_versions;
BEGIN
  SELECT * INTO campaign FROM mbox.member_gift_campaign_versions WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=NEW.campaign_version_id FOR SHARE;
  IF campaign.id IS NULL OR campaign.status<>'published' OR campaign.pricing_kind<>'fixed_price' OR NEW.fixed_price_minor IS DISTINCT FROM campaign.fixed_price_minor OR NEW.stacking_version_id IS DISTINCT FROM campaign.stacking_version_id THEN RAISE EXCEPTION 'Coupon promise requires exact published campaign price'; END IF;
  -- Share the repository issuance/decision lock; drafts and decisions stay append-only.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'stacking-release:'||NEW.tenant_id::text||':'||NEW.store_id::text||':'||NEW.stacking_version_id::text,0));
  PERFORM 1 FROM mbox.stacking_pricing_drafts WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=NEW.stacking_version_id;
  IF NOT EXISTS(SELECT 1 FROM mbox.stacking_pricing_decisions WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND version_id=NEW.stacking_version_id AND action='publish') OR EXISTS(SELECT 1 FROM mbox.stacking_pricing_decisions WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND version_id=NEW.stacking_version_id AND action='stop_issuing') THEN RAISE EXCEPTION 'Coupon stacking rule is not available for new issuance'; END IF;
  IF NOT EXISTS(SELECT 1 FROM mbox.benefits WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=NEW.benefit_id AND benefit_type='discount' AND currency='CNY' AND quantity_redeemed=0 AND quantity_reserved=0) THEN RAISE EXCEPTION 'Low price coupon must be an unused discount benefit'; END IF;
  IF NOT EXISTS(SELECT 1 FROM mbox.member_gift_campaign_products WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND campaign_version_id=NEW.campaign_version_id) OR EXISTS(SELECT 1 FROM mbox.member_gift_campaign_products WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND campaign_version_id=NEW.campaign_version_id AND unit_price_minor<=NEW.fixed_price_minor) THEN RAISE EXCEPTION 'Low price pool must contain positive price savings'; END IF;
  RETURN NEW;
END $$;

-- Administrative provisioning and public commands share this scope lock.
-- The runtime role retains SELECT-only access to reservation policies.
CREATE FUNCTION mbox.lock_reservation_policy_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE scope_key text; scope_keys text[];
BEGIN
  IF TG_OP='INSERT' THEN
    scope_keys:=ARRAY['reservation-policy:'||NEW.tenant_id::text||':'||NEW.store_id::text];
  ELSIF TG_OP='DELETE' THEN
    scope_keys:=ARRAY['reservation-policy:'||OLD.tenant_id::text||':'||OLD.store_id::text];
  ELSE
    scope_keys:=ARRAY['reservation-policy:'||OLD.tenant_id::text||':'||OLD.store_id::text,
                     'reservation-policy:'||NEW.tenant_id::text||':'||NEW.store_id::text];
  END IF;
  FOR scope_key IN SELECT DISTINCT key FROM unnest(scope_keys) AS keys(key) ORDER BY key LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(scope_key,0));
  END LOOP;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$$;
REVOKE ALL ON FUNCTION mbox.lock_reservation_policy_mutation() FROM PUBLIC,mbox_runtime;
CREATE TRIGGER public_reservation_policy_scope_lock
BEFORE INSERT OR UPDATE OR DELETE ON mbox.public_reservation_policies
FOR EACH ROW EXECUTE FUNCTION mbox.lock_reservation_policy_mutation();

UPDATE mbox.normalized_schema_metadata SET schema_version='244',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';
COMMIT;
