BEGIN;

-- 140 intentionally keeps its customer-left operation entirely inside one
-- database transaction.  Its original implementation used public.digest,
-- however extension functions do not have a portable schema name: managed
-- PostgreSQL installations commonly install pgcrypto outside public.  095
-- already owns the approved SHA-256 boundary through
-- mbox.personal_contact_sha256, so adapt the stored procedure rather than
-- adding a second extension dependency or exposing a function in public.
CREATE FUNCTION mbox.customer_left_turnover_digest(input_value text, algorithm text)
RETURNS bytea
LANGUAGE plpgsql
IMMUTABLE
STRICT
SECURITY DEFINER
SET search_path=pg_catalog,mbox
AS $$
BEGIN
  IF algorithm <> 'sha256' THEN
    RAISE EXCEPTION 'customer-left turnover only supports sha256' USING ERRCODE='22023';
  END IF;
  RETURN decode(mbox.personal_contact_sha256(input_value)::text,'hex');
END $$;

DO $$
DECLARE close_function_sql text;
BEGIN
  SELECT pg_get_functiondef(
    'mbox.close_table_after_customer_left(uuid,uuid,date,text,text,character)'::regprocedure
  ) INTO close_function_sql;
  IF close_function_sql IS NULL OR position('public.digest(' IN close_function_sql)=0 THEN
    RAISE EXCEPTION 'customer-left turnover function does not contain the expected digest implementation'
      USING ERRCODE='55000';
  END IF;
  close_function_sql:=replace(
    close_function_sql,
    'public.digest(',
    'mbox.customer_left_turnover_digest('
  );
  EXECUTE close_function_sql;
END $$;

REVOKE ALL ON FUNCTION mbox.customer_left_turnover_digest(text,text) FROM PUBLIC;

COMMENT ON FUNCTION mbox.customer_left_turnover_digest(text,text) IS
  'Internal portable SHA-256 bytea adapter for the customer-left turnover procedure.';

UPDATE mbox.normalized_schema_metadata
SET schema_version='141',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
