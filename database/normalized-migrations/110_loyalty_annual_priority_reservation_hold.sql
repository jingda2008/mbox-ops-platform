BEGIN;

-- Priority booking is an auditable eligibility fact, not permission to
-- overbook the venue.  Its short request hold is deliberately constrained to
-- the 5--30 minute operating window.
ALTER TABLE mbox.loyalty_annual_benefit_rules
  ADD COLUMN reservation_hold_minutes smallint;

ALTER TABLE mbox.loyalty_annual_benefit_rules
  ADD CONSTRAINT loyalty_annual_benefit_priority_hold_shape_ck CHECK (
    (rule_kind='priority_seating' AND reservation_hold_minutes BETWEEN 5 AND 30)
    OR (rule_kind<>'priority_seating' AND reservation_hold_minutes IS NULL)
  );

COMMENT ON COLUMN mbox.loyalty_annual_benefit_rules.reservation_hold_minutes IS
  'Priority reservation request hold. It records eligibility but never bypasses capacity or table-lock conflict checks.';

UPDATE mbox.normalized_schema_metadata
SET schema_version='110',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
