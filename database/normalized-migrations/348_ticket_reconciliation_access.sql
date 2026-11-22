BEGIN;
-- The older definer of price estimation now reads the extra receivable through order_receivable_amount.
-- Give that same owner only the columns needed to evaluate the scoped supplement.
DO $$ DECLARE owner_name text; BEGIN
 SELECT pg_get_userbyid(proowner) INTO STRICT owner_name FROM pg_proc WHERE oid='mbox.prepare_after_sales_price(uuid)'::regprocedure;
 EXECUTE format('GRANT SELECT (tenant_id,store_id,case_id,order_id,consented_at,amount_minor,payment_id) ON mbox.ticket_dining_collections TO %I',owner_name);
 EXECUTE format('GRANT SELECT (tenant_id,store_id,id,status,close_intent) ON mbox.table_ticket_refund_requests TO %I',owner_name);
END $$;
UPDATE mbox.normalized_schema_metadata SET schema_version='348',updated_at=clock_timestamp() WHERE singleton;
COMMIT;
