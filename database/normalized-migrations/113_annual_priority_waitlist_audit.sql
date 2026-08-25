BEGIN;

-- Priority must survive the hand-off from online booking to the physical
-- waitlist.  This snapshot is only a queue-ordering fact; it never converts a
-- full venue into available capacity or promises a fixed table.
ALTER TABLE mbox.waitlist_entries
  ADD COLUMN annual_priority_rule_id uuid,
  ADD COLUMN annual_priority_hold_minutes smallint;

ALTER TABLE mbox.waitlist_entries
  ADD CONSTRAINT waitlist_entries_annual_priority_rule_scope_fk
    FOREIGN KEY (tenant_id,store_id,annual_priority_rule_id)
    REFERENCES mbox.loyalty_annual_benefit_rules(tenant_id,store_id,id),
  ADD CONSTRAINT waitlist_entries_annual_priority_hold_shape_ck CHECK (
    (annual_priority_rule_id IS NULL AND annual_priority_hold_minutes IS NULL)
    OR (annual_priority_rule_id IS NOT NULL AND annual_priority_hold_minutes BETWEEN 5 AND 30)
  );

CREATE OR REPLACE FUNCTION mbox.assert_waitlist_annual_priority_rule()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE configured_hold smallint; configured_kind text;
BEGIN
  IF NEW.annual_priority_rule_id IS NULL THEN
    IF NEW.annual_priority_hold_minutes IS NOT NULL THEN
      RAISE EXCEPTION 'waitlist annual priority hold requires an annual priority rule';
    END IF;
    RETURN NEW;
  END IF;
  SELECT rule.reservation_hold_minutes,rule.rule_kind INTO configured_hold,configured_kind
  FROM mbox.loyalty_annual_benefit_rules rule
  WHERE rule.tenant_id=NEW.tenant_id AND rule.store_id=NEW.store_id AND rule.id=NEW.annual_priority_rule_id;
  IF configured_kind IS DISTINCT FROM 'priority_seating' OR configured_hold IS NULL
    OR configured_hold IS DISTINCT FROM NEW.annual_priority_hold_minutes THEN
    RAISE EXCEPTION 'waitlist annual priority rule is invalid';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER waitlist_entries_annual_priority_rule_check
  BEFORE INSERT OR UPDATE OF annual_priority_rule_id,annual_priority_hold_minutes ON mbox.waitlist_entries
  FOR EACH ROW EXECUTE FUNCTION mbox.assert_waitlist_annual_priority_rule();

CREATE INDEX waitlist_entries_annual_priority_queue_idx
  ON mbox.waitlist_entries(tenant_id,store_id,desired_arrival_at,annual_priority_rule_id,created_at,id)
  WHERE status IN ('waiting','notified','arrived') AND annual_priority_rule_id IS NOT NULL;

COMMENT ON COLUMN mbox.waitlist_entries.annual_priority_rule_id IS
  'Published membership priority verified at waitlist intake. Employee queue overrides remain a separate audited action.';

UPDATE mbox.normalized_schema_metadata
SET schema_version='113',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
