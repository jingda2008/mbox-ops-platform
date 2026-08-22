BEGIN;

INSERT INTO mbox.staff_permission_definitions (
  tenant_id,store_id,code,name,category,description,status
)
SELECT store.tenant_id,store.id,'printer.manage','配置与维护打印机','hardware_printing',
  '仅限打印机设备、打印路由、测试打印及失败任务重试；不授权摄像头、耳机、钱箱或其他硬件控制。','active'
FROM mbox.stores store
ON CONFLICT (tenant_id,store_id,code) DO UPDATE SET
  name=EXCLUDED.name,category=EXCLUDED.category,description=EXCLUDED.description,status='active';

UPDATE mbox.normalized_schema_metadata
SET schema_version='102',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
