BEGIN;

ALTER TABLE mbox.member_content_cards
  ADD COLUMN display_mode text NOT NULL DEFAULT 'rotation'
    CHECK (display_mode IN ('pinned', 'rotation'));

COMMENT ON COLUMN mbox.member_content_cards.display_mode IS
  'Homepage placement: pinned remains available until paused; rotation participates in the six-hour customer-card rotation.';

UPDATE mbox.normalized_schema_metadata
SET schema_version='102',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
