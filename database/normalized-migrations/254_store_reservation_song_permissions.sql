BEGIN;

-- Migration 017 seeded existing stores, but the later new-store trigger did not
-- include these four definitions. Add definitions only; never grant a role or
-- reactivate an administrator-disabled definition.
CREATE FUNCTION mbox.seed_store_reservation_song_permissions()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO mbox.staff_permission_definitions (tenant_id,store_id,code,name,category,description,status)
  SELECT NEW.tenant_id,NEW.id,p.code,p.name,p.category,p.description,'active'
  FROM (VALUES
    ('reservation.view.all','查看全部预约','reservation','忽略负责人和区域数据范围查看全店预约'),
    ('reservation.contact.view','查看预约联系方式','reservation','查看未脱敏预约联系方式'),
    ('reservation.cancel.override','例外取消预约','reservation','绕过客户取消截止或已付定金限制'),
    ('song.payment.record','登记点歌收款','payment','依据支付与对账凭证登记点歌已付款')
  ) AS p(code,name,category,description)
  ON CONFLICT (tenant_id,store_id,code) DO NOTHING;
  RETURN NEW;
END;
$$;
CREATE TRIGGER stores_seed_reservation_song_permissions
AFTER INSERT ON mbox.stores FOR EACH ROW EXECUTE FUNCTION mbox.seed_store_reservation_song_permissions();

INSERT INTO mbox.staff_permission_definitions (tenant_id,store_id,code,name,category,description,status)
SELECT s.tenant_id,s.id,p.code,p.name,p.category,p.description,'active'
FROM mbox.stores s CROSS JOIN (VALUES
  ('reservation.view.all','查看全部预约','reservation','忽略负责人和区域数据范围查看全店预约'),
  ('reservation.contact.view','查看预约联系方式','reservation','查看未脱敏预约联系方式'),
  ('reservation.cancel.override','例外取消预约','reservation','绕过客户取消截止或已付定金限制'),
  ('song.payment.record','登记点歌收款','payment','依据支付与对账凭证登记点歌已付款')
) AS p(code,name,category,description)
ON CONFLICT (tenant_id,store_id,code) DO NOTHING;

UPDATE mbox.normalized_schema_metadata SET schema_version='254',updated_at=clock_timestamp() WHERE singleton=true AND schema_flavor='normalized-core-v1';
COMMIT;
