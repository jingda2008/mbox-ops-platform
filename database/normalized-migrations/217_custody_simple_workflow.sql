BEGIN;
ALTER TABLE mbox.bottle_custody_policies
 ADD COLUMN allow_restorage boolean NOT NULL DEFAULT true,
 ADD COLUMN require_original_order boolean NOT NULL DEFAULT false,
 ADD COLUMN archive_mode text NOT NULL DEFAULT 'automatic' CHECK(archive_mode IN('automatic','manual'));
ALTER TABLE mbox.bottle_custody_orders ADD COLUMN declared_value_minor bigint CHECK(declared_value_minor BETWEEN 0 AND 100000000000);
ALTER TABLE mbox.bottle_custody_collections ADD COLUMN restored_order_id uuid,
 ADD FOREIGN KEY(tenant_id,store_id,restored_order_id) REFERENCES mbox.bottle_custody_orders(tenant_id,store_id,id);
ALTER TABLE mbox.bottle_custody_events DROP CONSTRAINT bottle_custody_events_event_type_check;
ALTER TABLE mbox.bottle_custody_events ADD CHECK(event_type IN('stored','code_requested','code_verified','code_rejected','collected','restored','archived','collection_closed','printed','expiry_changed'));
UPDATE mbox.normalized_schema_metadata SET schema_version='217',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
