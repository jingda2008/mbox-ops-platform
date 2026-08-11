BEGIN;

ALTER TABLE mbox.product_bundle_components
  ADD COLUMN note text
    CHECK (note IS NULL OR length(btrim(note)) BETWEEN 1 AND 500);

COMMENT ON COLUMN mbox.product_bundle_components.note IS
  'Optional operational note copied into bundle component configuration; never used as a price source.';

COMMIT;
