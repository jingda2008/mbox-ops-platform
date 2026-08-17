BEGIN;

-- Recommendation policy publication used to be an immediate two-step update.
-- Preserve that legacy provenance explicitly, but require every new release to
-- use three different employees and an exact, non-overlapping effective window.
ALTER TABLE mbox.recommendation_policy_versions
  ADD COLUMN effective_from timestamptz,
  ADD COLUMN effective_until timestamptz,
  ADD COLUMN draft_reason text NOT NULL DEFAULT '092迁移前创建的推荐规则',
  ADD COLUMN approval_reason text,
  ADD COLUMN publication_reason text,
  ADD COLUMN publication_mode text NOT NULL DEFAULT 'separated'
    CHECK (publication_mode IN ('legacy_unverified','separated'));

UPDATE mbox.recommendation_policy_versions
SET publication_mode='legacy_unverified',
  effective_from=COALESCE(published_at,created_at),
  publication_reason='092迁移前已发布；保留原始人员字段，不补造三人发布证据'
WHERE status IN ('published','retired');

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM mbox.recommendation_policy_versions
    WHERE status='draft' AND created_by_employee_id IS NULL
  ) THEN
    RAISE EXCEPTION 'recommendation draft without creator cannot enter managed release workflow';
  END IF;
  -- The old schema never stored an approval reason.  Do not silently promote a
  -- pending approval into the managed workflow with invented provenance.
  IF EXISTS (
    SELECT 1 FROM mbox.recommendation_policy_versions WHERE status='approved'
  ) THEN
    RAISE EXCEPTION 'pre-092 approved recommendation policy cannot be migrated without approval rationale; clone it as a new managed draft';
  END IF;
  IF EXISTS (
    SELECT 1 FROM mbox.recommendation_policy_versions
    WHERE status='approved' AND (
      created_by_employee_id IS NULL OR approved_by_employee_id IS NULL
      OR approved_by_employee_id=created_by_employee_id OR approved_at IS NULL
    )
  ) THEN
    RAISE EXCEPTION 'approved recommendation policy lacks independent approval evidence';
  END IF;
END $$;

ALTER TABLE mbox.recommendation_policy_versions
  DROP CONSTRAINT IF EXISTS recommendation_policy_versions_status_check,
  DROP CONSTRAINT IF EXISTS recommendation_policy_versions_check,
  DROP CONSTRAINT IF EXISTS recommendation_policy_versions_check1,
  DROP CONSTRAINT IF EXISTS recommendation_policy_versions_check2,
  ADD CONSTRAINT recommendation_policy_versions_status_check
    CHECK (status IN ('draft','approved','published','retired')),
  ADD CONSTRAINT recommendation_policy_versions_effective_window_ck
    CHECK (effective_until IS NULL OR (effective_from IS NOT NULL AND effective_until>effective_from)),
  ADD CONSTRAINT recommendation_policy_versions_release_shape_ck CHECK (
    (status='draft' AND publication_mode='separated'
      AND created_by_employee_id IS NOT NULL
      AND approved_by_employee_id IS NULL AND approved_at IS NULL
      AND published_by_employee_id IS NULL AND published_at IS NULL
      AND effective_from IS NULL AND effective_until IS NULL
      AND length(btrim(draft_reason)) BETWEEN 2 AND 500)
    OR (status='approved' AND publication_mode='separated'
      AND created_by_employee_id IS NOT NULL
      AND approved_by_employee_id IS NOT NULL AND approved_at IS NOT NULL
      AND approved_by_employee_id<>created_by_employee_id
      AND published_by_employee_id IS NULL AND published_at IS NULL
      AND effective_from IS NULL AND effective_until IS NULL
      AND length(btrim(draft_reason)) BETWEEN 2 AND 500
      AND length(btrim(approval_reason)) BETWEEN 2 AND 500)
    OR (status IN ('published','retired') AND publication_mode='legacy_unverified'
      AND published_at IS NOT NULL AND effective_from IS NOT NULL
      AND length(btrim(publication_reason)) BETWEEN 2 AND 500)
    OR (status IN ('published','retired') AND publication_mode='separated'
      AND created_by_employee_id IS NOT NULL
      AND approved_by_employee_id IS NOT NULL AND approved_at IS NOT NULL
      AND published_by_employee_id IS NOT NULL AND published_at IS NOT NULL
      AND approved_by_employee_id<>created_by_employee_id
      AND published_by_employee_id<>created_by_employee_id
      AND published_by_employee_id<>approved_by_employee_id
      AND effective_from IS NOT NULL
      AND length(btrim(draft_reason)) BETWEEN 2 AND 500
      AND length(btrim(approval_reason)) BETWEEN 2 AND 500
      AND length(btrim(publication_reason)) BETWEEN 2 AND 500)
  );

DROP INDEX IF EXISTS mbox.recommendation_policy_versions_published_uq;
ALTER TABLE mbox.recommendation_policy_versions
  ADD CONSTRAINT recommendation_policy_versions_no_published_overlap_excl
  EXCLUDE USING gist (
    tenant_id WITH =,store_id WITH =,policy_code WITH =,
    tstzrange(effective_from,effective_until,'[)') WITH &&
  ) WHERE (status='published') DEFERRABLE INITIALLY IMMEDIATE;

CREATE FUNCTION mbox.guard_recommendation_policy_release()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.publication_mode='legacy_unverified' THEN
      RAISE EXCEPTION 'legacy recommendation publication mode is migration-only';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'recommendation policy versions are append-only';
  END IF;

  IF OLD.status='draft' AND NEW.status='approved' THEN
    IF ROW(NEW.tenant_id,NEW.store_id,NEW.public_id,NEW.policy_code,NEW.version,
      NEW.preference_weight,NEW.scene_weight,NEW.margin_weight,NEW.priority_weight,
      NEW.performance_weight,NEW.inventory_weight,NEW.capacity_weight,
      NEW.minimum_gross_margin_basis_points,NEW.preference_half_life_days,
      NEW.preference_max_age_days,NEW.preference_min_effective_score,
      NEW.preference_min_confidence_basis_points,NEW.explanation_template,
      NEW.display_configuration,NEW.created_by_employee_id,NEW.draft_reason,
      NEW.publication_mode,NEW.created_at) IS DISTINCT FROM
      ROW(OLD.tenant_id,OLD.store_id,OLD.public_id,OLD.policy_code,OLD.version,
      OLD.preference_weight,OLD.scene_weight,OLD.margin_weight,OLD.priority_weight,
      OLD.performance_weight,OLD.inventory_weight,OLD.capacity_weight,
      OLD.minimum_gross_margin_basis_points,OLD.preference_half_life_days,
      OLD.preference_max_age_days,OLD.preference_min_effective_score,
      OLD.preference_min_confidence_basis_points,OLD.explanation_template,
      OLD.display_configuration,OLD.created_by_employee_id,OLD.draft_reason,
      OLD.publication_mode,OLD.created_at) THEN
      RAISE EXCEPTION 'approval cannot change recommendation policy facts';
    END IF;
  ELSIF OLD.status='approved' AND NEW.status='published' THEN
    IF ROW(NEW.tenant_id,NEW.store_id,NEW.public_id,NEW.policy_code,NEW.version,
      NEW.preference_weight,NEW.scene_weight,NEW.margin_weight,NEW.priority_weight,
      NEW.performance_weight,NEW.inventory_weight,NEW.capacity_weight,
      NEW.minimum_gross_margin_basis_points,NEW.preference_half_life_days,
      NEW.preference_max_age_days,NEW.preference_min_effective_score,
      NEW.preference_min_confidence_basis_points,NEW.explanation_template,
      NEW.display_configuration,NEW.created_by_employee_id,NEW.draft_reason,
      NEW.approved_by_employee_id,NEW.approved_at,NEW.approval_reason,
      NEW.publication_mode,NEW.created_at) IS DISTINCT FROM
      ROW(OLD.tenant_id,OLD.store_id,OLD.public_id,OLD.policy_code,OLD.version,
      OLD.preference_weight,OLD.scene_weight,OLD.margin_weight,OLD.priority_weight,
      OLD.performance_weight,OLD.inventory_weight,OLD.capacity_weight,
      OLD.minimum_gross_margin_basis_points,OLD.preference_half_life_days,
      OLD.preference_max_age_days,OLD.preference_min_effective_score,
      OLD.preference_min_confidence_basis_points,OLD.explanation_template,
      OLD.display_configuration,OLD.created_by_employee_id,OLD.draft_reason,
      OLD.approved_by_employee_id,OLD.approved_at,OLD.approval_reason,
      OLD.publication_mode,OLD.created_at) THEN
      RAISE EXCEPTION 'publication cannot change approved recommendation policy facts';
    END IF;
    IF EXISTS (
      SELECT 1 FROM mbox.recommendation_policy_versions prior
      WHERE prior.tenant_id=NEW.tenant_id AND prior.store_id=NEW.store_id
        AND prior.policy_code=NEW.policy_code AND prior.status='published'
    ) AND NOT EXISTS (
      SELECT 1 FROM mbox.recommendation_policy_versions prior
      WHERE prior.tenant_id=NEW.tenant_id AND prior.store_id=NEW.store_id
        AND prior.policy_code=NEW.policy_code AND prior.status='published'
        AND prior.effective_from<NEW.effective_from
        AND (prior.effective_until IS NULL OR prior.effective_until>=NEW.effective_from)
    ) THEN
      RAISE EXCEPTION 'recommendation policy publication would create an effective-time gap';
    END IF;
  ELSIF OLD.status='published' AND NEW.status='published' THEN
    IF ROW(NEW.tenant_id,NEW.store_id,NEW.public_id,NEW.policy_code,NEW.version,
      NEW.preference_weight,NEW.scene_weight,NEW.margin_weight,NEW.priority_weight,
      NEW.performance_weight,NEW.inventory_weight,NEW.capacity_weight,
      NEW.minimum_gross_margin_basis_points,NEW.preference_half_life_days,
      NEW.preference_max_age_days,NEW.preference_min_effective_score,
      NEW.preference_min_confidence_basis_points,NEW.explanation_template,
      NEW.display_configuration,NEW.created_by_employee_id,NEW.draft_reason,
      NEW.approved_by_employee_id,NEW.approved_at,NEW.approval_reason,
      NEW.published_by_employee_id,NEW.published_at,NEW.publication_reason,
      NEW.publication_mode,NEW.effective_from,NEW.created_at) IS DISTINCT FROM
      ROW(OLD.tenant_id,OLD.store_id,OLD.public_id,OLD.policy_code,OLD.version,
      OLD.preference_weight,OLD.scene_weight,OLD.margin_weight,OLD.priority_weight,
      OLD.performance_weight,OLD.inventory_weight,OLD.capacity_weight,
      OLD.minimum_gross_margin_basis_points,OLD.preference_half_life_days,
      OLD.preference_max_age_days,OLD.preference_min_effective_score,
      OLD.preference_min_confidence_basis_points,OLD.explanation_template,
      OLD.display_configuration,OLD.created_by_employee_id,OLD.draft_reason,
      OLD.approved_by_employee_id,OLD.approved_at,OLD.approval_reason,
      OLD.published_by_employee_id,OLD.published_at,OLD.publication_reason,
      OLD.publication_mode,OLD.effective_from,OLD.created_at)
      OR NEW.effective_until IS NULL
      OR (OLD.effective_until IS NOT NULL AND NEW.effective_until>OLD.effective_until)
      OR NOT EXISTS (
        SELECT 1 FROM mbox.recommendation_policy_versions replacement
        WHERE replacement.tenant_id=NEW.tenant_id AND replacement.store_id=NEW.store_id
          AND replacement.policy_code=NEW.policy_code AND replacement.status='published'
          AND replacement.id<>NEW.id AND replacement.effective_from=NEW.effective_until
      ) THEN
      RAISE EXCEPTION 'published recommendation policy is immutable outside an exact scheduled cut-over';
    END IF;
  ELSIF OLD.status IN ('approved','retired') AND NEW.status=OLD.status THEN
    RAISE EXCEPTION 'approved or historical recommendation policy facts are immutable';
  ELSE
    RAISE EXCEPTION 'invalid recommendation policy release transition';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER recommendation_policy_versions_release_guard
  BEFORE INSERT OR UPDATE OR DELETE ON mbox.recommendation_policy_versions
  FOR EACH ROW EXECUTE FUNCTION mbox.guard_recommendation_policy_release();

-- Publishing a policy never opens customer exposure.  A separate owner action
-- must move this feature from disabled/shadow into pilot or enabled, and only a
-- currently effective managed three-person policy can cross that boundary.
CREATE FUNCTION mbox.guard_recommendation_feature_rollout()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.feature_code='recommendation.engine'
    AND NEW.rollout_state IN ('pilot','enabled')
    AND NOT EXISTS (
      SELECT 1 FROM mbox.recommendation_policy_versions policy
      WHERE policy.tenant_id=NEW.tenant_id AND policy.store_id=NEW.store_id
        AND policy.policy_code='DEFAULT' AND policy.status='published'
        AND policy.publication_mode='separated'
        AND policy.effective_from<=clock_timestamp()
        AND (policy.effective_until IS NULL OR policy.effective_until>clock_timestamp())
    ) THEN
    RAISE EXCEPTION 'recommendation pilot requires a current managed three-person policy';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER customer_experience_recommendation_rollout_guard
  BEFORE INSERT OR UPDATE ON mbox.customer_experience_features
  FOR EACH ROW EXECUTE FUNCTION mbox.guard_recommendation_feature_rollout();

INSERT INTO mbox.customer_experience_features(
  tenant_id,store_id,feature_code,rollout_state,configuration,reason,effective_from
)
SELECT store.tenant_id,store.id,'recommendation.engine','disabled','{}'::jsonb,
  '推荐规则尚待门店经营参数、岗位和影子样本确认，发布新规则不会自动开放',clock_timestamp()
FROM mbox.stores store
ON CONFLICT (tenant_id,store_id,feature_code) DO UPDATE SET
  rollout_state='disabled',configuration='{}'::jsonb,
  reason='092升级后需由最高管理权限重新确认推荐试点，规则发布不会自动开放',
  approved_by_employee_id=NULL,effective_from=clock_timestamp(),effective_until=NULL,
  updated_at=clock_timestamp();

CREATE FUNCTION mbox.seed_store_recommendation_feature()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO mbox.customer_experience_features(
    tenant_id,store_id,feature_code,rollout_state,configuration,reason,effective_from
  ) VALUES (
    NEW.tenant_id,NEW.id,'recommendation.engine','disabled','{}'::jsonb,
    '推荐规则默认关闭；需完成三人发布和门店试点确认后由最高管理权限开放',clock_timestamp()
  ) ON CONFLICT (tenant_id,store_id,feature_code) DO NOTHING;
  RETURN NEW;
END $$;

CREATE TRIGGER stores_seed_recommendation_feature
  AFTER INSERT ON mbox.stores FOR EACH ROW
  EXECUTE FUNCTION mbox.seed_store_recommendation_feature();

-- Add a distinct read permission and replace the former over-broad defaults.
CREATE OR REPLACE FUNCTION mbox.seed_store_recommendation_observation_permissions()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO mbox.staff_permission_definitions (
    tenant_id, store_id, code, name, category, description, status
  ) SELECT NEW.tenant_id, NEW.id, permission.code, permission.name,
    permission.category, permission.description, 'active'
  FROM (VALUES
    ('observation.record', '记录桌台情况', 'customer_experience', '记录本人负责桌台的原始观察并保留原文'),
    ('observation.record.all', '记录全店桌台情况', 'customer_experience', '跨当前主责、候补或临时分配记录任意桌台观察'),
    ('observation.confirm', '确认观察解析', 'customer_experience', '确认系统候选和结构化观察结果'),
    ('observation.correct', '修正已确认观察', 'customer_experience', '追加修正已确认观察并保留前后版本'),
    ('observation.view.raw', '查看观察原文', 'customer_experience', '按数据范围查看员工观察原文和解析证据'),
    ('recommendation.rule.view', '查看推荐规则', 'customer_experience', '查看推荐规则版本、发布证据和试点状态'),
    ('recommendation.rule.draft', '起草推荐规则', 'customer_experience', '新建或从历史版本复制推荐策略草稿，不直接影响顾客'),
    ('recommendation.rule.approve', '审批推荐规则', 'customer_experience', '由非起草人审批推荐策略版本'),
    ('recommendation.rule.publish', '发布与试点推荐规则', 'customer_experience', '由第三名授权人员未来排期发布，并独立控制试点开关'),
    ('recommendation.analytics.view', '查看推荐分析', 'customer_experience', '查看推荐曝光、选择、成交和退款结果'),
    ('product.observation.analytics.view', '查看商品观察分析', 'customer_experience', '查看商品观察、纠错率、样本和置信度')
  ) AS permission(code,name,category,description)
  ON CONFLICT (tenant_id,store_id,code) DO UPDATE SET
    name=EXCLUDED.name, category=EXCLUDED.category,
    description=EXCLUDED.description, status='active';
  RETURN NEW;
END $$;

INSERT INTO mbox.staff_permission_definitions(
  tenant_id,store_id,code,name,category,description,status
)
SELECT store.tenant_id,store.id,'recommendation.rule.view','查看推荐规则',
  'customer_experience','查看推荐规则版本、发布证据和试点状态','active'
FROM mbox.stores store
ON CONFLICT (tenant_id,store_id,code) DO UPDATE SET
  name=EXCLUDED.name,category=EXCLUDED.category,
  description=EXCLUDED.description,status='active';

DELETE FROM mbox.role_permission_assignments assignment
USING mbox.roles role,mbox.staff_permission_definitions permission
WHERE assignment.tenant_id=role.tenant_id AND assignment.store_id=role.store_id
  AND assignment.role_id=role.id
  AND assignment.tenant_id=permission.tenant_id AND assignment.store_id=permission.store_id
  AND assignment.permission_id=permission.id
  AND role.code IN ('OWNER','OPS_LEAD','ADMIN','MANAGER','DEPUT_MANAGER','MARKETING')
  AND permission.code IN (
    'recommendation.rule.view','recommendation.rule.draft',
    'recommendation.rule.approve','recommendation.rule.publish'
  );

INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id)
SELECT role.tenant_id,role.store_id,role.id,permission.id
FROM mbox.roles role
JOIN mbox.staff_permission_definitions permission
  ON permission.tenant_id=role.tenant_id AND permission.store_id=role.store_id
WHERE role.status='active' AND (
  (role.code='MANAGER' AND permission.code IN ('recommendation.rule.view','recommendation.rule.draft'))
  OR (role.code='OPS_LEAD' AND permission.code IN ('recommendation.rule.view','recommendation.rule.approve'))
  OR (role.code='OWNER' AND permission.code IN ('recommendation.rule.view','recommendation.rule.publish'))
  OR (role.code IN ('ADMIN','DEPUT_MANAGER','MARKETING') AND permission.code='recommendation.rule.view')
)
ON CONFLICT (tenant_id,store_id,role_id,permission_id) DO NOTHING;

CREATE FUNCTION mbox.seed_role_recommendation_release_permissions()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id)
  SELECT NEW.tenant_id,NEW.store_id,NEW.id,permission.id
  FROM mbox.staff_permission_definitions permission
  WHERE permission.tenant_id=NEW.tenant_id AND permission.store_id=NEW.store_id
    AND (
      (NEW.code='MANAGER' AND permission.code IN ('recommendation.rule.view','recommendation.rule.draft'))
      OR (NEW.code='OPS_LEAD' AND permission.code IN ('recommendation.rule.view','recommendation.rule.approve'))
      OR (NEW.code='OWNER' AND permission.code IN ('recommendation.rule.view','recommendation.rule.publish'))
      OR (NEW.code IN ('ADMIN','DEPUT_MANAGER','MARKETING') AND permission.code='recommendation.rule.view')
    )
  ON CONFLICT (tenant_id,store_id,role_id,permission_id) DO NOTHING;
  RETURN NEW;
END $$;

CREATE TRIGGER roles_seed_recommendation_release_permissions
  AFTER INSERT ON mbox.roles FOR EACH ROW
  EXECUTE FUNCTION mbox.seed_role_recommendation_release_permissions();

COMMENT ON TABLE mbox.recommendation_policy_versions IS
  'Append-only recommendation rules. New releases require distinct drafter, approver and publisher plus exact effective windows; legacy releases remain explicitly unverified.';

UPDATE mbox.normalized_schema_metadata
SET schema_version='092',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
