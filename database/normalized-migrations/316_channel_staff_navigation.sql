BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';

-- Repair definitions and names only. Existing grants, explicit denials and
-- disabled capabilities remain untouched; a menu never grants authority.
CREATE FUNCTION mbox.seed_channel_staff_definitions(target_tenant_id uuid, target_store_id uuid)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name,category,description)
 SELECT target_tenant_id,target_store_id,v.code,v.name,'channel',v.description FROM (VALUES
 ('channel.view','查看周边店合作','进入周边店合作，查看合作方、推广批次及报表；不能修改、核验或结算。'),
 ('channel.manage','管理周边店合作','管理合作店、推荐人、活动、推广图及独立审批；后台操作还需“查看周边店合作”。'),
 ('channel.activate','核验周边店合作优惠券','在现场已授权桌台核验顾客并绑定优惠；仍受原有桌台访问权限限制。'),
 ('channel.correct','更正周边店合作来源与权益','按证据处理来源和权益异常；后台操作还需“查看周边店合作”。'),
 ('channel.settle','审核周边店合作结算','核对佣金与结算；后台操作还需“查看周边店合作”，不代替其他付款和审批权限。')) AS v(code,name,description)
 ON CONFLICT(tenant_id,store_id,code) DO UPDATE SET name=EXCLUDED.name,category=EXCLUDED.category,description=EXCLUDED.description,updated_at=clock_timestamp();
 INSERT INTO mbox.staff_access_configuration_definitions(tenant_id,store_id,definition_kind,code,label,description,required_permission_codes,sort_order,config)
 VALUES(target_tenant_id,target_store_id,'navigation','channel-partners','周边店合作','合作店、推广优惠与佣金结算；操作按各项权限分别控制。',ARRAY['channel.view']::text[],284,'{"route":"/staff/channel-partners"}'::jsonb)
 ON CONFLICT(tenant_id,store_id,definition_kind,code) DO UPDATE SET label=EXCLUDED.label,description=EXCLUDED.description,required_permission_codes=EXCLUDED.required_permission_codes,config=EXCLUDED.config,updated_at=clock_timestamp();
END $$;
REVOKE ALL ON FUNCTION mbox.seed_channel_staff_definitions(uuid,uuid) FROM PUBLIC,mbox_runtime;
CREATE OR REPLACE FUNCTION mbox.seed_channel_permissions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM mbox.seed_channel_staff_definitions(NEW.tenant_id,NEW.id);
 RETURN NEW;
END $$;
DO $$ DECLARE s record; BEGIN
 FOR s IN SELECT tenant_id,id FROM mbox.stores LOOP
  PERFORM mbox.seed_channel_staff_definitions(s.tenant_id,s.id);
 END LOOP;
END $$;
UPDATE mbox.normalized_schema_metadata SET schema_version='316',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
