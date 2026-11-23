BEGIN;
ALTER TABLE mbox.table_ticket_corrections
 DROP CONSTRAINT table_ticket_corrections_consumption_resolution_check,
 ADD CHECK (consumption_resolution IN ('unused','merchant_assumes','buyer_use')),
 ADD COLUMN buyer_confirmed_at timestamptz,
 ADD COLUMN buyer_customer_id uuid,
 ADD COLUMN consumption_items jsonb,
 ADD CHECK (consumption_resolution<>'buyer_use' OR (consumption_items IS NOT NULL AND jsonb_typeof(consumption_items)='array')),
 ADD FOREIGN KEY(tenant_id,store_id,buyer_customer_id) REFERENCES mbox.customers(tenant_id,store_id,id),
 ADD CHECK ((buyer_confirmed_at IS NULL)=(buyer_customer_id IS NULL)),
 ADD CHECK (buyer_confirmed_at IS NULL OR consumption_resolution='buyer_use');
GRANT UPDATE(buyer_confirmed_at,buyer_customer_id) ON mbox.table_ticket_corrections TO mbox_runtime;
CREATE UNIQUE INDEX ticket_buyer_used_lot ON mbox.table_ticket_corrections(tenant_id,store_id,original_lot_id)
 WHERE status='approved' AND consumption_resolution='buyer_use';
CREATE FUNCTION mbox.ticket_spending_lots(t uuid,s uuid,current_lot uuid) RETURNS SETOF uuid LANGUAGE sql STABLE AS $$
 SELECT current_lot UNION ALL SELECT original_lot_id FROM mbox.table_ticket_corrections
 WHERE tenant_id=t AND store_id=s AND replacement_lot_id=current_lot AND status='approved' AND consumption_resolution='buyer_use'
$$;
UPDATE mbox.normalized_schema_metadata SET schema_version='351',updated_at=clock_timestamp() WHERE singleton;
COMMIT;
