BEGIN;

-- A reprint is a new, auditable task that points to an already printed job.
-- It cannot mutate or requeue the original physical-print record.
ALTER TABLE mbox.print_jobs
  ADD COLUMN reprint_of_job_id uuid,
  ADD COLUMN reprint_reason text,
  ADD CONSTRAINT print_jobs_reprint_origin_fk
    FOREIGN KEY (tenant_id,store_id,reprint_of_job_id)
    REFERENCES mbox.print_jobs(tenant_id,store_id,id),
  ADD CONSTRAINT print_jobs_reprint_shape_check CHECK (
    (reprint_of_job_id IS NULL AND reprint_reason IS NULL)
    OR (reprint_of_job_id IS NOT NULL AND length(btrim(reprint_reason)) BETWEEN 3 AND 1000)
  );

CREATE INDEX print_jobs_reprint_origin_idx
  ON mbox.print_jobs(tenant_id,store_id,reprint_of_job_id,created_at DESC,id)
  WHERE reprint_of_job_id IS NOT NULL;

CREATE OR REPLACE FUNCTION mbox.seed_store_print_reprint_permission()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO mbox.staff_permission_definitions(
    tenant_id,store_id,code,name,category,description,status
  ) VALUES (
    NEW.tenant_id,NEW.id,'print.reprint','补打已完成小票','hardware',
    '补打已完成的收银、吧台或后厨小票；原始小票不会被改写', 'active'
  ) ON CONFLICT(tenant_id,store_id,code) DO UPDATE SET
    name=EXCLUDED.name,category=EXCLUDED.category,description=EXCLUDED.description,status='active';
  RETURN NEW;
END $$;
CREATE TRIGGER stores_seed_print_reprint_permission
  AFTER INSERT ON mbox.stores
  FOR EACH ROW EXECUTE FUNCTION mbox.seed_store_print_reprint_permission();

INSERT INTO mbox.staff_permission_definitions(
  tenant_id,store_id,code,name,category,description,status
)
SELECT store.tenant_id,store.id,'print.reprint','补打已完成小票','hardware',
  '补打已完成的收银、吧台或后厨小票；原始小票不会被改写', 'active'
FROM mbox.stores store
ON CONFLICT(tenant_id,store_id,code) DO UPDATE SET
  name=EXCLUDED.name,category=EXCLUDED.category,description=EXCLUDED.description,status='active';

-- Cashier/day-close roles receive the narrow reprint authority, without
-- inheriting printer routing, bridge pairing, or hardware management.
INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id)
SELECT role.tenant_id,role.store_id,role.id,reprint.id
FROM mbox.roles role
JOIN mbox.staff_permission_definitions source
  ON source.tenant_id=role.tenant_id AND source.store_id=role.store_id
 AND source.status='active'
 AND source.code IN ('payment.settlement.view','business_day.close','print.retry')
JOIN mbox.role_permission_assignments source_assignment
  ON source_assignment.tenant_id=role.tenant_id AND source_assignment.store_id=role.store_id
 AND source_assignment.role_id=role.id AND source_assignment.permission_id=source.id
JOIN mbox.staff_permission_definitions reprint
  ON reprint.tenant_id=role.tenant_id AND reprint.store_id=role.store_id
 AND reprint.code='print.reprint' AND reprint.status='active'
WHERE role.status='active'
ON CONFLICT(tenant_id,store_id,role_id,permission_id) DO NOTHING;

CREATE OR REPLACE FUNCTION mbox.seed_print_reprint_role_permission()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM mbox.staff_permission_definitions source
    WHERE source.tenant_id=NEW.tenant_id AND source.store_id=NEW.store_id
      AND source.id=NEW.permission_id AND source.status='active'
      AND source.code IN ('payment.settlement.view','business_day.close','print.retry')
  ) THEN
    INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id)
    SELECT NEW.tenant_id,NEW.store_id,NEW.role_id,reprint.id
    FROM mbox.staff_permission_definitions reprint
    WHERE reprint.tenant_id=NEW.tenant_id AND reprint.store_id=NEW.store_id
      AND reprint.code='print.reprint' AND reprint.status='active'
    ON CONFLICT(tenant_id,store_id,role_id,permission_id) DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER role_permissions_seed_print_reprint
  AFTER INSERT ON mbox.role_permission_assignments
  FOR EACH ROW EXECUTE FUNCTION mbox.seed_print_reprint_role_permission();

UPDATE mbox.normalized_schema_metadata
SET schema_version='134',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
