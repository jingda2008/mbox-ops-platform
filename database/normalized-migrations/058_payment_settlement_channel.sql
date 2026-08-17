BEGIN;

-- The settlement rail controls the provider refund tag and therefore belongs
-- to the payment authority, not to display/evidence JSON. Historical values
-- are deliberately left NULL: old snapshot keys are not trusted as facts.
ALTER TABLE mbox.payments
  ADD COLUMN settlement_channel text
    CHECK (settlement_channel IN ('wechat', 'alipay', 'unionpay'));

COMMENT ON COLUMN mbox.payments.settlement_channel IS
  'Authoritative settlement rail observed from a verified provider callback or bound active query. NULL fails automated provider refunds closed.';

UPDATE mbox.normalized_schema_metadata
SET schema_version='058', updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
