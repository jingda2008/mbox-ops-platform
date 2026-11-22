BEGIN;
ALTER TABLE mbox.menu_categories ADD COLUMN visible_from timestamptz, ADD COLUMN visible_until timestamptz,
  ADD CHECK(visible_until IS NULL OR visible_from IS NULL OR visible_until>visible_from);
ALTER TABLE mbox.table_ticket_offers ADD COLUMN category_code text,
  ADD FOREIGN KEY(tenant_id,store_id,category_code) REFERENCES mbox.menu_categories(tenant_id,store_id,code);
CREATE FUNCTION mbox.menu_category_visible_at(t uuid,s uuid,category text,at_time timestamptz) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT NOT EXISTS(SELECT 1 FROM mbox.menu_categories c LEFT JOIN mbox.menu_categories p
   ON (p.tenant_id,p.store_id,p.code)=(c.tenant_id,c.store_id,c.parent_code)
   WHERE c.tenant_id=t AND c.store_id=s AND c.code=category
   AND (NOT c.guest_visible OR c.visible_from>at_time OR c.visible_until<=at_time
        OR NOT p.guest_visible OR p.visible_from>at_time OR p.visible_until<=at_time))
$$;
UPDATE mbox.normalized_schema_metadata SET schema_version='333',updated_at=clock_timestamp() WHERE singleton;
COMMIT;
