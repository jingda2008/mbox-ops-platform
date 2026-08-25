BEGIN;

CREATE TABLE mbox.complimentary_fulfillment_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  order_id uuid NOT NULL,
  benefit_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','retry','dispatched','failed')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 100),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_error_code text,
  last_error_at timestamptz,
  dispatched_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,store_id,order_id) REFERENCES mbox.orders(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,benefit_id) REFERENCES mbox.benefits(tenant_id,store_id,id),
  UNIQUE (tenant_id,store_id,order_id),
  UNIQUE (tenant_id,store_id,id),
  CHECK (
    (status IN ('pending','retry') AND dispatched_at IS NULL)
    OR (status='dispatched' AND dispatched_at IS NOT NULL)
    OR status='failed'
  )
);

CREATE INDEX complimentary_fulfillment_intents_due_idx
  ON mbox.complimentary_fulfillment_intents(tenant_id,store_id,next_attempt_at,created_at,id)
  WHERE status IN ('pending','retry');

CREATE TRIGGER complimentary_fulfillment_intents_touch
  BEFORE UPDATE ON mbox.complimentary_fulfillment_intents
  FOR EACH ROW EXECUTE FUNCTION mbox.touch_updated_at();

ALTER TABLE mbox.complimentary_fulfillment_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.complimentary_fulfillment_intents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.complimentary_fulfillment_intents
  USING (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())
  WITH CHECK (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
GRANT SELECT,INSERT,UPDATE ON TABLE mbox.complimentary_fulfillment_intents TO mbox_runtime;
REVOKE DELETE ON TABLE mbox.complimentary_fulfillment_intents FROM mbox_runtime;

COMMENT ON TABLE mbox.complimentary_fulfillment_intents IS
  'Durable post-commit instruction to create KDS and print-visible work for a zero-value benefit order. Redemption does not depend on synchronous KDS creation.';

UPDATE mbox.normalized_schema_metadata
SET schema_version='124',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
