BEGIN;

-- CREATE OR REPLACE in 236/239/240 retains the pre-upgrade definer owner.
-- Its new private predicates and admission table belong to the maintainer.
-- Hand off only this existing trigger to that exact common owner; keep the
-- function body, fixed search path, closure rules and helper ACLs unchanged.
DO $owner$
DECLARE owner_id oid; owner_name name;
BEGIN
 SELECT min(proowner::bigint)::oid INTO owner_id FROM pg_proc
 WHERE oid IN ('mbox.allow_closed_debt_manual_payment(jsonb,uuid)'::regprocedure,
               'mbox.allow_closed_order_verified_payment_projection(jsonb,jsonb,uuid)'::regprocedure,
               'mbox.allow_closed_order_manual_debt_projection(jsonb,jsonb,uuid)'::regprocedure)
 HAVING count(*)=3 AND count(DISTINCT proowner)=1;
 SELECT rolname INTO owner_name FROM pg_roles WHERE oid=owner_id AND (rolsuper OR rolbypassrls);
 IF owner_name IS NULL OR owner_id IS DISTINCT FROM
    (SELECT relowner FROM pg_class WHERE oid='mbox.closed_debt_manual_payment_admissions'::regclass) THEN
   RAISE EXCEPTION 'closure guard requires one verified maintenance owner' USING ERRCODE='55000';
 END IF;
 EXECUTE format('ALTER FUNCTION mbox.lock_table_session_for_closure_fact_write() OWNER TO %I',owner_name);
END $owner$;
REVOKE ALL ON FUNCTION mbox.lock_table_session_for_closure_fact_write() FROM PUBLIC,mbox_runtime;

UPDATE mbox.normalized_schema_metadata SET schema_version='242',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';
COMMIT;
