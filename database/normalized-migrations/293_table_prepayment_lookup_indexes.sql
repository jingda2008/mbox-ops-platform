BEGIN;
CREATE INDEX table_prepayment_order_idx ON mbox.table_prepayment_allocations(tenant_id,store_id,order_id,payment_id);
CREATE INDEX table_minimum_waiver_session_idx ON mbox.table_minimum_spend_waivers(tenant_id,store_id,table_session_id);
UPDATE mbox.normalized_schema_metadata SET schema_version='293',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
