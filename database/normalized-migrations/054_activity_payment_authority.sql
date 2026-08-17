BEGIN;

-- A payment is one financial truth, whether it settles an order or an activity
-- registration.  Activity payments must never be represented by a synthetic
-- order because that would leak into inventory, KDS and order settlement.
ALTER TABLE mbox.payments
  ALTER COLUMN order_id DROP NOT NULL,
  ADD COLUMN payable_kind text NOT NULL DEFAULT 'order'
    CHECK (payable_kind IN ('order', 'activity_registration')),
  ADD COLUMN activity_registration_id uuid;

ALTER TABLE mbox.payments
  ADD CONSTRAINT payments_activity_registration_fk
    FOREIGN KEY (tenant_id, store_id, activity_registration_id)
    REFERENCES mbox.community_activity_registrations(tenant_id, store_id, id),
  ADD CONSTRAINT payments_exactly_one_payable_ck CHECK (
    (payable_kind = 'order' AND order_id IS NOT NULL AND activity_registration_id IS NULL)
    OR
    (payable_kind = 'activity_registration' AND order_id IS NULL AND activity_registration_id IS NOT NULL)
  );

ALTER TABLE mbox.payment_provider_actions
  ADD COLUMN request_idempotency_key text,
  ADD COLUMN request_fingerprint char(64),
  ADD CONSTRAINT payment_provider_actions_idempotency_key_ck CHECK (
    request_idempotency_key IS NULL OR length(request_idempotency_key) BETWEEN 8 AND 128
  ),
  ADD CONSTRAINT payment_provider_actions_request_fingerprint_ck CHECK (
    request_fingerprint IS NULL OR request_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  ADD CONSTRAINT payment_provider_actions_idempotency_pair_ck CHECK (
    (request_idempotency_key IS NULL) = (request_fingerprint IS NULL)
  );

CREATE INDEX payments_activity_registration_idx
  ON mbox.payments (tenant_id, store_id, activity_registration_id, created_at, id)
  WHERE activity_registration_id IS NOT NULL;

CREATE UNIQUE INDEX payments_one_active_activity_payment_uq
  ON mbox.payments (tenant_id, store_id, activity_registration_id)
  WHERE payable_kind = 'activity_registration'
    AND status IN ('created', 'pending', 'succeeded', 'partially_refunded');

-- The store must explicitly opt in after the normal online-payment switch and
-- runtime provider configuration are both healthy.  New and existing stores
-- are disabled by default.
INSERT INTO mbox.customer_experience_features (
  tenant_id, store_id, feature_code, rollout_state, configuration, reason
)
SELECT tenant_id, id, 'community.activity.payment', 'disabled', '{}'::jsonb,
  '收费活动支付默认关闭，须在本地完成支付与退款验收后由授权人员开启'
FROM mbox.stores
ON CONFLICT (tenant_id, store_id, feature_code) DO NOTHING;

CREATE OR REPLACE FUNCTION mbox.seed_store_activity_payment_feature()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO mbox.customer_experience_features (
    tenant_id, store_id, feature_code, rollout_state, configuration, reason
  ) VALUES (
    NEW.tenant_id, NEW.id, 'community.activity.payment', 'disabled', '{}'::jsonb,
    '收费活动支付默认关闭，须在本地完成支付与退款验收后由授权人员开启'
  ) ON CONFLICT (tenant_id, store_id, feature_code) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER zzz_stores_seed_activity_payment_feature
  AFTER INSERT ON mbox.stores
  FOR EACH ROW EXECUTE FUNCTION mbox.seed_store_activity_payment_feature();

COMMENT ON COLUMN mbox.payments.payable_kind IS
  'Strongly typed financial target. Activity registrations reuse the authoritative payment, callback, query, refund and reconciliation ledgers.';
COMMENT ON COLUMN mbox.payments.activity_registration_id IS
  'Activity registration target; mutually exclusive with order_id and never a synthetic order.';

UPDATE mbox.normalized_schema_metadata
SET schema_version = '054', updated_at = clock_timestamp()
WHERE singleton = true AND schema_flavor = 'normalized-core-v1';

COMMIT;
