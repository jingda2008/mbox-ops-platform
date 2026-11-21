BEGIN;
-- Existing promises keep their original reservation and release semantics.
-- The application explicitly writes on_use for new claims, including old batches.
ALTER TABLE mbox.channel_claims
 ADD COLUMN fulfillment_policy text NOT NULL DEFAULT 'reserved' CHECK(fulfillment_policy IN('reserved','on_use')),
 ADD COLUMN gift_selection jsonb,
 ADD CONSTRAINT channel_on_use_no_commitment CHECK(fulfillment_policy<>'on_use' OR cost_commitment_minor=0),
 ADD CONSTRAINT channel_gift_selection_shape CHECK(gift_selection IS NULL OR
   (fulfillment_policy='on_use' AND jsonb_typeof(gift_selection)='object' AND gift_selection ? 'kind' AND gift_selection->>'kind'='gift'));
CREATE FUNCTION mbox.guard_channel_claim_fulfillment_policy() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.fulfillment_policy IS DISTINCT FROM OLD.fulfillment_policy THEN
  RAISE EXCEPTION 'Claim fulfillment policy is immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER channel_claim_fulfillment_policy_immutable BEFORE UPDATE ON mbox.channel_claims
 FOR EACH ROW EXECUTE FUNCTION mbox.guard_channel_claim_fulfillment_policy();
REVOKE ALL ON FUNCTION mbox.guard_channel_claim_fulfillment_policy() FROM PUBLIC;
UPDATE mbox.normalized_schema_metadata SET schema_version='320',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
