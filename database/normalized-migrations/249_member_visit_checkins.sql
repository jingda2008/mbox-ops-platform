BEGIN;
-- Store attendance is separate from activity registrations, payments and rewards.
CREATE TABLE mbox.member_visit_checkins (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL, store_id uuid NOT NULL, customer_id uuid NOT NULL,
 business_date date NOT NULL,
 checked_in_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 checked_in_by_employee_id uuid NOT NULL,
 cancelled_at timestamptz, cancelled_by_employee_id uuid, cancel_reason text,
 UNIQUE(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,customer_id) REFERENCES mbox.customers(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,checked_in_by_employee_id) REFERENCES mbox.employees(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,cancelled_by_employee_id) REFERENCES mbox.employees(tenant_id,store_id,id),
 CHECK ((cancelled_at IS NULL AND cancelled_by_employee_id IS NULL AND cancel_reason IS NULL)
   OR (cancelled_at IS NOT NULL AND cancelled_by_employee_id IS NOT NULL AND cancel_reason IS NOT NULL AND length(trim(cancel_reason)) BETWEEN 2 AND 300))
);
CREATE UNIQUE INDEX member_visit_once_per_business_day ON mbox.member_visit_checkins(tenant_id,store_id,customer_id,business_date) WHERE cancelled_at IS NULL;
ALTER TABLE mbox.member_visit_checkins ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.member_visit_checkins FORCE ROW LEVEL SECURITY;
CREATE POLICY member_visit_scope ON mbox.member_visit_checkins
 USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())
 WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
REVOKE ALL ON mbox.member_visit_checkins FROM PUBLIC;
GRANT SELECT,INSERT ON mbox.member_visit_checkins TO mbox_runtime;
GRANT UPDATE(cancelled_at,cancelled_by_employee_id,cancel_reason) ON mbox.member_visit_checkins TO mbox_runtime;
CREATE FUNCTION mbox.guard_member_visit_cancellation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.cancelled_at IS NOT NULL OR NEW.cancelled_at IS NULL THEN
  RAISE EXCEPTION 'Only an active attendance may be cancelled once' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER member_visit_cancel_once BEFORE UPDATE ON mbox.member_visit_checkins
 FOR EACH ROW EXECUTE FUNCTION mbox.guard_member_visit_cancellation();
COMMENT ON TABLE mbox.member_visit_checkins IS 'Staff-confirmed store attendance only. Does not reserve activity capacity, grant benefits or accrue points. Cancellation preserves the original record.';
COMMIT;
