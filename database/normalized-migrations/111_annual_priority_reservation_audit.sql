BEGIN;

-- Reservation priority is a first-class, immutable eligibility record. It is
-- intentionally not inferred later from a JSON snapshot or the member's
-- current tier, because either fact can change after the reservation is made.
ALTER TABLE mbox.reservations
  ADD COLUMN annual_priority_rule_id uuid,
  ADD COLUMN annual_priority_hold_minutes smallint;

ALTER TABLE mbox.reservations
  ADD CONSTRAINT reservations_annual_priority_rule_scope_fk
    FOREIGN KEY (tenant_id,store_id,annual_priority_rule_id)
    REFERENCES mbox.loyalty_annual_benefit_rules(tenant_id,store_id,id),
  ADD CONSTRAINT reservations_annual_priority_hold_shape_ck CHECK (
    (annual_priority_rule_id IS NULL AND annual_priority_hold_minutes IS NULL)
    OR (annual_priority_rule_id IS NOT NULL AND annual_priority_hold_minutes BETWEEN 5 AND 30)
  );

CREATE OR REPLACE FUNCTION mbox.assert_reservation_annual_priority_rule()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE configured_hold smallint; configured_kind text;
BEGIN
  IF NEW.annual_priority_rule_id IS NULL THEN
    IF NEW.annual_priority_hold_minutes IS NOT NULL THEN
      RAISE EXCEPTION 'annual priority hold requires an annual priority rule';
    END IF;
    RETURN NEW;
  END IF;
  SELECT rule.reservation_hold_minutes,rule.rule_kind
    INTO configured_hold,configured_kind
  FROM mbox.loyalty_annual_benefit_rules rule
  WHERE rule.tenant_id=NEW.tenant_id AND rule.store_id=NEW.store_id
    AND rule.id=NEW.annual_priority_rule_id;
  IF configured_kind IS DISTINCT FROM 'priority_seating'
    OR configured_hold IS NULL
    OR configured_hold IS DISTINCT FROM NEW.annual_priority_hold_minutes THEN
    RAISE EXCEPTION 'reservation annual priority rule is invalid';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER reservations_annual_priority_rule_check
  BEFORE INSERT OR UPDATE OF annual_priority_rule_id,annual_priority_hold_minutes
  ON mbox.reservations
  FOR EACH ROW EXECUTE FUNCTION mbox.assert_reservation_annual_priority_rule();

CREATE INDEX reservations_annual_priority_intake_idx
  ON mbox.reservations(tenant_id,store_id,arrival_at,annual_priority_rule_id,id)
  WHERE annual_priority_rule_id IS NOT NULL
    AND status IN ('pending','confirmed');

UPDATE mbox.normalized_schema_metadata
SET schema_version='111',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
