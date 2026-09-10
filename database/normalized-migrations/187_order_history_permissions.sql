BEGIN;
INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name)
SELECT s.tenant_id,s.id,p.code,p.name FROM mbox.stores s CROSS JOIN (VALUES
 ('order.history.view','订单中心查询（近三个营业日及未结事项）'),
 ('order.history.all','订单中心全部历史查询'),
 ('order.bill.print','订单账单手动打印'),
 ('print.production.reprint','制作单补打')
) p(code,name) ON CONFLICT(tenant_id,store_id,code) DO NOTHING;

-- Read authority only. This does not grant refund, repricing or print authority.
INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id)
SELECT r.tenant_id,r.store_id,r.id,p.id FROM mbox.roles r
JOIN mbox.staff_permission_definitions p ON p.tenant_id=r.tenant_id AND p.store_id=r.store_id
WHERE r.status='active' AND (p.code='order.history.view'
 OR (p.code='order.history.all' AND r.code IN ('OWNER','ADMIN','MANAGER','DEPUT_MANAGER','OPS_LEAD')))
ON CONFLICT(tenant_id,store_id,role_id,permission_id) DO NOTHING;

CREATE FUNCTION mbox.seed_order_history_permissions() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mbox AS $$
BEGIN
 INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name) VALUES
 (NEW.tenant_id,NEW.id,'order.history.view','订单中心查询（近三个营业日及未结事项）'),
 (NEW.tenant_id,NEW.id,'order.history.all','订单中心全部历史查询'),
 (NEW.tenant_id,NEW.id,'order.bill.print','订单账单手动打印'),
 (NEW.tenant_id,NEW.id,'print.production.reprint','制作单补打')
 ON CONFLICT(tenant_id,store_id,code) DO NOTHING;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION mbox.seed_order_history_permissions() FROM PUBLIC;
CREATE TRIGGER order_history_store_permissions AFTER INSERT ON mbox.stores FOR EACH ROW EXECUTE FUNCTION mbox.seed_order_history_permissions();
UPDATE mbox.normalized_schema_metadata SET schema_version='187',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
