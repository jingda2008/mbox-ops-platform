BEGIN;

-- A membership priority fact sets the default same-time ordering.  Staff may
-- only alter that ordering through an append-only, reasoned decision.  It
-- cannot allocate capacity, create a table lock or turn a full venue into an
-- available one.
CREATE TABLE mbox.reservation_priority_queue_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  target_kind text NOT NULL CHECK (target_kind IN ('reservation','waitlist')),
  reservation_id uuid,
  waitlist_entry_id uuid,
  mode text NOT NULL CHECK (mode IN ('promote','demote','clear')),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 2 AND 500),
  overridden_by_employee_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
  FOREIGN KEY (tenant_id,store_id,reservation_id)
    REFERENCES mbox.reservations(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,waitlist_entry_id)
    REFERENCES mbox.waitlist_entries(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,overridden_by_employee_id)
    REFERENCES mbox.employees(tenant_id,store_id,id),
  CHECK (
    (target_kind='reservation' AND reservation_id IS NOT NULL AND waitlist_entry_id IS NULL)
    OR (target_kind='waitlist' AND reservation_id IS NULL AND waitlist_entry_id IS NOT NULL)
  ),
  UNIQUE (tenant_id,store_id,id)
);

CREATE INDEX reservation_priority_queue_overrides_reservation_idx
  ON mbox.reservation_priority_queue_overrides(tenant_id,store_id,reservation_id,created_at DESC,id DESC)
  WHERE reservation_id IS NOT NULL;
CREATE INDEX reservation_priority_queue_overrides_waitlist_idx
  ON mbox.reservation_priority_queue_overrides(tenant_id,store_id,waitlist_entry_id,created_at DESC,id DESC)
  WHERE waitlist_entry_id IS NOT NULL;

CREATE OR REPLACE FUNCTION mbox.protect_reservation_priority_queue_override()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'reservation priority queue overrides are append-only';
END $$;

CREATE TRIGGER reservation_priority_queue_overrides_append_only
  BEFORE UPDATE OR DELETE ON mbox.reservation_priority_queue_overrides
  FOR EACH ROW EXECUTE FUNCTION mbox.protect_reservation_priority_queue_override();

ALTER TABLE mbox.reservation_priority_queue_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.reservation_priority_queue_overrides FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.reservation_priority_queue_overrides
  USING (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())
  WITH CHECK (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
GRANT SELECT,INSERT ON TABLE mbox.reservation_priority_queue_overrides TO mbox_runtime;
REVOKE UPDATE,DELETE ON TABLE mbox.reservation_priority_queue_overrides FROM mbox_runtime;

COMMENT ON TABLE mbox.reservation_priority_queue_overrides IS
  'Latest decision controls same-time intake ordering: promote, demote or clear. It never bypasses capacity, table-lock or confirmation rules.';

UPDATE mbox.normalized_schema_metadata
SET schema_version='114',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
