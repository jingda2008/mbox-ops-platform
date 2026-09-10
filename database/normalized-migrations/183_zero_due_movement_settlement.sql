BEGIN;
-- No payment or income is fabricated for a complimentary order. Production,
-- inventory, service and pending-channel guards remain independently enforced.
DO $migration$
DECLARE definition text; needle text; replacement text;
BEGIN
 SELECT pg_get_functiondef(p.oid) INTO definition FROM pg_proc p
 JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='mbox' AND p.proname='execute_table_customer_movement' AND p.pronargs=15;
 needle := $old$(order_row.status<>'cancelled'
            AND order_row.payment_status IN ('paid','partially_refunded','refunded'))$old$;
 replacement := $new$(order_row.status NOT IN ('draft','cancelled') AND order_row.total_amount_minor=0)
          OR (order_row.status<>'cancelled'
            AND order_row.payment_status IN ('paid','partially_refunded','refunded'))$new$;
 IF definition IS NULL OR (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 THEN
   RAISE EXCEPTION 'unexpected zero-due movement predecessor';
 END IF;
 EXECUTE replace(definition,needle,replacement);
END $migration$;
UPDATE mbox.normalized_schema_metadata SET schema_version='183',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
