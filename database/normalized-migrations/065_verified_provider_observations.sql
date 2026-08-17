BEGIN;

-- Provider receipt JSON remains audit evidence only.  A financial terminal
-- transition must consume one strongly typed observation that was produced by
-- either a verified callback or a server-bound active query.
CREATE TABLE mbox.verified_provider_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('wechat', 'postar')),
  subject_kind text NOT NULL CHECK (subject_kind IN ('payment', 'refund')),
  payment_id uuid,
  refund_id uuid,
  verification_kind text NOT NULL
    CHECK (verification_kind IN ('callback_signature', 'active_query_binding')),
  provider_event_id text NOT NULL CHECK (length(btrim(provider_event_id)) BETWEEN 8 AND 256),
  integration_ref text NOT NULL CHECK (length(btrim(integration_ref)) BETWEEN 3 AND 256),
  observed_status text NOT NULL CHECK (observed_status IN (
    'payment_succeeded', 'payment_pending', 'payment_failed', 'payment_closed',
    'refund_succeeded', 'refund_processing', 'refund_failed'
  )),
  provider_transaction_id text NOT NULL
    CHECK (length(btrim(provider_transaction_id)) BETWEEN 1 AND 256),
  original_provider_transaction_id text,
  reported_amount_minor bigint NOT NULL CHECK (reported_amount_minor > 0),
  reported_currency char(3) NOT NULL CHECK (reported_currency ~ '^[A-Z]{3}$'),
  settlement_channel text CHECK (settlement_channel IN ('wechat', 'alipay', 'unionpay')),
  evidence_sha256 char(64) NOT NULL CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  consumed_at timestamptz,
  consumed_operation text CHECK (consumed_operation IN (
    'payment.callback', 'payment.provider-query', 'refund.result'
  )),
  consumed_idempotency_key text,
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, payment_id)
    REFERENCES mbox.payments(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, refund_id)
    REFERENCES mbox.refunds(tenant_id, store_id, id),
  CHECK (
    (subject_kind='payment' AND payment_id IS NOT NULL AND refund_id IS NULL
      AND observed_status LIKE 'payment\_%' ESCAPE '\'
      AND original_provider_transaction_id IS NULL)
    OR
    (subject_kind='refund' AND refund_id IS NOT NULL AND payment_id IS NULL
      AND observed_status LIKE 'refund\_%' ESCAPE '\'
      AND length(btrim(original_provider_transaction_id)) BETWEEN 1 AND 256
      AND settlement_channel IS NULL)
  ),
  CHECK (
    (consumed_at IS NULL AND consumed_operation IS NULL AND consumed_idempotency_key IS NULL)
    OR
    (consumed_at IS NOT NULL AND consumed_operation IS NOT NULL
      AND length(btrim(consumed_idempotency_key)) BETWEEN 8 AND 128)
  ),
  UNIQUE (tenant_id, store_id, provider, provider_event_id),
  UNIQUE (tenant_id, store_id, id)
);

CREATE INDEX verified_provider_observations_payment_idx
  ON mbox.verified_provider_observations
    (tenant_id, store_id, payment_id, recorded_at DESC, id)
  WHERE payment_id IS NOT NULL;
CREATE INDEX verified_provider_observations_refund_idx
  ON mbox.verified_provider_observations
    (tenant_id, store_id, refund_id, recorded_at DESC, id)
  WHERE refund_id IS NOT NULL;
CREATE INDEX verified_provider_observations_unconsumed_idx
  ON mbox.verified_provider_observations
    (tenant_id, store_id, recorded_at, id)
  WHERE consumed_at IS NULL;

CREATE FUNCTION mbox.protect_verified_provider_observation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id<>OLD.id OR NEW.tenant_id<>OLD.tenant_id OR NEW.store_id<>OLD.store_id
    OR NEW.provider<>OLD.provider OR NEW.subject_kind<>OLD.subject_kind
    OR NEW.payment_id IS DISTINCT FROM OLD.payment_id OR NEW.refund_id IS DISTINCT FROM OLD.refund_id
    OR NEW.verification_kind<>OLD.verification_kind
    OR NEW.provider_event_id<>OLD.provider_event_id OR NEW.integration_ref<>OLD.integration_ref
    OR NEW.observed_status<>OLD.observed_status
    OR NEW.provider_transaction_id<>OLD.provider_transaction_id
    OR NEW.original_provider_transaction_id IS DISTINCT FROM OLD.original_provider_transaction_id
    OR NEW.reported_amount_minor<>OLD.reported_amount_minor
    OR NEW.reported_currency<>OLD.reported_currency
    OR NEW.settlement_channel IS DISTINCT FROM OLD.settlement_channel
    OR NEW.evidence_sha256<>OLD.evidence_sha256 OR NEW.occurred_at<>OLD.occurred_at
    OR NEW.recorded_at<>OLD.recorded_at THEN
    RAISE EXCEPTION 'verified provider observation facts are immutable' USING ERRCODE='23514';
  END IF;

  IF OLD.consumed_at IS NOT NULL AND (
    NEW.consumed_at IS DISTINCT FROM OLD.consumed_at
    OR NEW.consumed_operation IS DISTINCT FROM OLD.consumed_operation
    OR NEW.consumed_idempotency_key IS DISTINCT FROM OLD.consumed_idempotency_key
  ) THEN
    RAISE EXCEPTION 'verified provider observation consumption is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER verified_provider_observations_protect
  BEFORE UPDATE ON mbox.verified_provider_observations
  FOR EACH ROW EXECUTE FUNCTION mbox.protect_verified_provider_observation();

ALTER TABLE mbox.verified_provider_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.verified_provider_observations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.verified_provider_observations
  USING (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())
  WITH CHECK (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());

GRANT SELECT, INSERT, UPDATE ON TABLE mbox.verified_provider_observations TO mbox_runtime;

COMMENT ON TABLE mbox.verified_provider_observations IS
  'Single-use, strongly typed provider observations. JSON signatureVerified and verificationAlgorithm keys are never financial authority.';
COMMENT ON COLUMN mbox.verified_provider_observations.verification_kind IS
  'callback_signature means cryptographically verified provider callback; active_query_binding means a server-originated query response bound to the exact local subject.';
COMMENT ON COLUMN mbox.verified_provider_observations.evidence_sha256 IS
  'Digest of the sanitized external receipt for conflict and audit comparison; the receipt itself remains in provider_snapshot only.';

UPDATE mbox.normalized_schema_metadata
SET schema_version='065', updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
