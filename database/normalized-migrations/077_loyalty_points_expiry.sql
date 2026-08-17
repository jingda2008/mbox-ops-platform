BEGIN;

ALTER TABLE mbox.loyalty_point_ledger
  DROP CONSTRAINT loyalty_point_ledger_source_type_check,
  ADD CONSTRAINT loyalty_point_ledger_source_type_check
    CHECK (source_type IN (
      'order','refund','redemption','activity','benefit','campaign',
      'service_recovery','manual','expiration'
    ));

COMMENT ON CONSTRAINT loyalty_point_ledger_source_type_check ON mbox.loyalty_point_ledger IS
  'Point expiration is a first-class typed source; workers must not disguise expiry as a manual adjustment or infer it from JSON.';

COMMIT;
