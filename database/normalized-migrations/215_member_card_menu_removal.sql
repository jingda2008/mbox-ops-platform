BEGIN;
-- Removing configuration is audited by the command journal; historical orders
-- retain their product and price snapshots independently.
GRANT DELETE ON mbox.member_card_menu_items TO mbox_runtime;
UPDATE mbox.normalized_schema_metadata SET schema_version='215',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
