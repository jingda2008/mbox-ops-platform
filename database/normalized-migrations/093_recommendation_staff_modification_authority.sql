BEGIN;

-- A staff modification previously had only a generic event enum, actor_ref and
-- free evidence JSON. No runtime writer existed. Refuse to guess authority for
-- any historical row instead of promoting free text or JSON into strong facts.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM mbox.recommendation_behavior_events
    WHERE event_type='staff_modified'
  ) THEN
    RAISE EXCEPTION 'pre-093 staff_modified recommendation events require manual authority review';
  END IF;
END $$;

ALTER TABLE mbox.recommendation_behavior_events
  ADD COLUMN source_recommendation_option_id uuid,
  ADD COLUMN actor_employee_id uuid,
  ADD COLUMN staff_modification_reason_code text,
  ADD COLUMN staff_modification_idempotency_key text,
  ADD COLUMN staff_modification_request_sha256 char(64);

CREATE UNIQUE INDEX recommendation_options_session_identity_uq
  ON mbox.recommendation_options(tenant_id,store_id,recommendation_session_id,id);

ALTER TABLE mbox.recommendation_behavior_events
  ADD CONSTRAINT recommendation_behavior_events_target_session_fk
    FOREIGN KEY (tenant_id,store_id,recommendation_session_id,recommendation_option_id)
    REFERENCES mbox.recommendation_options(tenant_id,store_id,recommendation_session_id,id),
  ADD CONSTRAINT recommendation_behavior_events_source_session_fk
    FOREIGN KEY (tenant_id,store_id,recommendation_session_id,source_recommendation_option_id)
    REFERENCES mbox.recommendation_options(tenant_id,store_id,recommendation_session_id,id),
  ADD CONSTRAINT recommendation_behavior_events_actor_employee_fk
    FOREIGN KEY (tenant_id,store_id,actor_employee_id)
    REFERENCES mbox.employees(tenant_id,store_id,id),
  ADD CONSTRAINT recommendation_behavior_events_staff_modification_ck CHECK (
    CASE WHEN event_type='staff_modified' THEN
      actor_type='employee'
      AND actor_employee_id IS NOT NULL
      AND table_session_id IS NOT NULL
      AND recommendation_option_id IS NOT NULL
      AND source_recommendation_option_id IS NOT NULL
      AND source_recommendation_option_id<>recommendation_option_id
      AND staff_modification_reason_code IN (
        'customer_request','availability_substitution','service_recovery','staff_judgement'
      )
      AND reason_code=staff_modification_reason_code
      AND length(staff_modification_idempotency_key) BETWEEN 8 AND 128
      AND staff_modification_idempotency_key~'^[A-Za-z0-9:_-]+$'
      AND staff_modification_request_sha256~'^[0-9a-f]{64}$'
    ELSE
      source_recommendation_option_id IS NULL
      AND actor_employee_id IS NULL
      AND staff_modification_reason_code IS NULL
      AND staff_modification_idempotency_key IS NULL
      AND staff_modification_request_sha256 IS NULL
    END
  );

CREATE UNIQUE INDEX recommendation_behavior_events_staff_modification_idempotency_uq
  ON mbox.recommendation_behavior_events(
    tenant_id,store_id,staff_modification_idempotency_key
  ) WHERE event_type='staff_modified';

COMMENT ON COLUMN mbox.recommendation_behavior_events.source_recommendation_option_id IS
  'Strong source option for an authorized staff-assisted recommendation change; the existing recommendation_option_id is the target option.';
COMMENT ON COLUMN mbox.recommendation_behavior_events.actor_employee_id IS
  'Strong employee authority for staff_modified; actor_ref and evidence_snapshot are never authorization facts.';
COMMENT ON COLUMN mbox.recommendation_behavior_events.staff_modification_reason_code IS
  'Typed operating reason for staff-assisted selection; free JSON cannot introduce new runtime reasons.';
COMMENT ON COLUMN mbox.recommendation_behavior_events.staff_modification_idempotency_key IS
  'Store-scoped idempotency identity paired with the command journal.';

CREATE FUNCTION mbox.seed_store_recommendation_staff_modification_permissions()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO mbox.staff_permission_definitions(
    tenant_id,store_id,code,name,category,description,status
  ) VALUES
    (NEW.tenant_id,NEW.id,'recommendation.staff.modify','调整责任桌推荐','customer_experience',
      '在当前主责、候补或临时分配桌台内，从同一推荐会话的已有方案中记录员工协助调整','active'),
    (NEW.tenant_id,NEW.id,'recommendation.staff.modify.all','跨桌调整推荐','customer_experience',
      '跨当前责任桌记录员工协助调整；仍须具备recommendation.staff.modify','active')
  ON CONFLICT (tenant_id,store_id,code) DO UPDATE SET
    name=EXCLUDED.name,category=EXCLUDED.category,
    description=EXCLUDED.description,status='active';
  RETURN NEW;
END $$;

CREATE TRIGGER stores_seed_recommendation_staff_modification_permissions
  AFTER INSERT ON mbox.stores FOR EACH ROW
  EXECUTE FUNCTION mbox.seed_store_recommendation_staff_modification_permissions();

INSERT INTO mbox.staff_permission_definitions(
  tenant_id,store_id,code,name,category,description,status
)
SELECT store.tenant_id,store.id,permission.code,permission.name,
  'customer_experience',permission.description,'active'
FROM mbox.stores store CROSS JOIN (VALUES
  ('recommendation.staff.modify','调整责任桌推荐',
    '在当前主责、候补或临时分配桌台内，从同一推荐会话的已有方案中记录员工协助调整'),
  ('recommendation.staff.modify.all','跨桌调整推荐',
    '跨当前责任桌记录员工协助调整；仍须具备recommendation.staff.modify')
) AS permission(code,name,description)
ON CONFLICT (tenant_id,store_id,code) DO UPDATE SET
  name=EXCLUDED.name,category=EXCLUDED.category,
  description=EXCLUDED.description,status='active';

INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id)
SELECT role.tenant_id,role.store_id,role.id,permission.id
FROM mbox.roles role
JOIN mbox.staff_permission_definitions permission
  ON permission.tenant_id=role.tenant_id AND permission.store_id=role.store_id
WHERE (
  role.code IN ('OWNER','OPS_LEAD','MANAGER')
  AND permission.code IN ('recommendation.staff.modify','recommendation.staff.modify.all')
) OR (
  role.code IN ('DEPUT_MANAGER','SERVER')
  AND permission.code='recommendation.staff.modify'
)
ON CONFLICT (tenant_id,store_id,role_id,permission_id) DO NOTHING;

CREATE FUNCTION mbox.seed_role_recommendation_staff_modification_permissions()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id)
  SELECT NEW.tenant_id,NEW.store_id,NEW.id,permission.id
  FROM mbox.staff_permission_definitions permission
  WHERE permission.tenant_id=NEW.tenant_id AND permission.store_id=NEW.store_id
    AND (
      (NEW.code IN ('OWNER','OPS_LEAD','MANAGER')
        AND permission.code IN ('recommendation.staff.modify','recommendation.staff.modify.all'))
      OR (NEW.code IN ('DEPUT_MANAGER','SERVER')
        AND permission.code='recommendation.staff.modify')
    )
  ON CONFLICT (tenant_id,store_id,role_id,permission_id) DO NOTHING;
  RETURN NEW;
END $$;

CREATE TRIGGER roles_seed_recommendation_staff_modification_permissions
  AFTER INSERT ON mbox.roles FOR EACH ROW
  EXECUTE FUNCTION mbox.seed_role_recommendation_staff_modification_permissions();

GRANT EXECUTE ON FUNCTION mbox.seed_store_recommendation_staff_modification_permissions() TO mbox_runtime;
GRANT EXECUTE ON FUNCTION mbox.seed_role_recommendation_staff_modification_permissions() TO mbox_runtime;

UPDATE mbox.normalized_schema_metadata
SET schema_version='093',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
