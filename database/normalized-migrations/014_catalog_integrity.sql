BEGIN;

ALTER TABLE mbox.product_prices
  ADD CONSTRAINT product_prices_no_overlapping_validity
  EXCLUDE USING gist (
    tenant_id WITH =,
    store_id WITH =,
    product_id WITH =,
    price_type WITH =,
    currency WITH =,
    tstzrange(valid_from, valid_until, '[)') WITH &&
  );

COMMENT ON CONSTRAINT product_prices_no_overlapping_validity ON mbox.product_prices IS
  'Prevents overlapping half-open price validity ranges; a NULL valid_until is an unbounded upper range.';

COMMIT;
