BEGIN;

-- A manual boundary is an immutable business fact, not a rewrite of historical
-- order dates or proof that unresolved channel payments have succeeded.
CREATE TABLE mbox.manual_business_day_ends (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL, store_id uuid NOT NULL,
 business_date date NOT NULL, next_business_date date NOT NULL,
 calendar_business_date date NOT NULL,
 employee_id uuid NOT NULL, reason text NOT NULL CHECK(length(reason) BETWEEN 2 AND 500),
 ended_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 ledger_snapshot jsonb NOT NULL CHECK(jsonb_typeof(ledger_snapshot)='array'),
 UNIQUE(tenant_id,store_id,business_date),
 UNIQUE(tenant_id,store_id,calendar_business_date),
 CHECK(next_business_date=business_date+1),
 CHECK(business_date=calendar_business_date),
 FOREIGN KEY(tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
 FOREIGN KEY(tenant_id,store_id,employee_id) REFERENCES mbox.employees(tenant_id,store_id,id)
);
ALTER TABLE mbox.manual_business_day_ends ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.manual_business_day_ends FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.manual_business_day_ends
 USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())
 WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
REVOKE ALL ON mbox.manual_business_day_ends FROM PUBLIC;
GRANT SELECT,INSERT ON mbox.manual_business_day_ends TO mbox_runtime;
CREATE FUNCTION mbox.prevent_manual_business_day_end_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'manual business day end records are immutable'; END $$;
CREATE TRIGGER manual_business_day_end_immutable BEFORE UPDATE OR DELETE ON mbox.manual_business_day_ends
 FOR EACH ROW EXECUTE FUNCTION mbox.prevent_manual_business_day_end_mutation();
REVOKE ALL ON FUNCTION mbox.prevent_manual_business_day_end_mutation() FROM PUBLIC;

-- Explicit helper: calendar-bound appointments must continue to use calendar
-- time. Only operational-date consumers should adopt this boundary.
CREATE FUNCTION mbox.current_operating_business_date(p_tenant uuid,p_store uuid)
 RETURNS date LANGUAGE sql STABLE AS $$
 SELECT GREATEST(((statement_timestamp() AT TIME ZONE store.timezone)-store.business_day_cutoff)::date,
   (SELECT max(boundary.next_business_date) FROM mbox.manual_business_day_ends boundary
    WHERE boundary.tenant_id=store.tenant_id AND boundary.store_id=store.id))
 FROM mbox.stores store WHERE store.tenant_id=p_tenant AND store.id=p_store
   AND store.tenant_id=mbox.current_tenant_id() AND store.id=mbox.current_store_id()
$$;
REVOKE ALL ON FUNCTION mbox.current_operating_business_date(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mbox.current_operating_business_date(uuid,uuid) TO mbox_runtime;
UPDATE mbox.normalized_schema_metadata SET schema_version='184',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
