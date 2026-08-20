BEGIN;

-- Business configuration stays in its domain tables and typed child tables.
-- These cross-domain facts contain only workflow identity, revisions and
-- server-calculated impact evidence; no JSON is an executable policy source.
ALTER TABLE mbox.loyalty_policy_versions
  ADD COLUMN draft_revision integer NOT NULL DEFAULT 1 CHECK (draft_revision>0);
ALTER TABLE mbox.loyalty_tier_policy_versions
  ADD COLUMN draft_revision integer NOT NULL DEFAULT 1 CHECK (draft_revision>0);
ALTER TABLE mbox.loyalty_tier_benefit_policy_versions
  ADD COLUMN draft_revision integer NOT NULL DEFAULT 1 CHECK (draft_revision>0);
ALTER TABLE mbox.redemption_catalog_versions
  ADD COLUMN draft_revision integer NOT NULL DEFAULT 1 CHECK (draft_revision>0);
ALTER TABLE mbox.loyalty_promotion_policy_versions
  ADD COLUMN draft_revision integer NOT NULL DEFAULT 1 CHECK (draft_revision>0);
ALTER TABLE mbox.membership_terms_versions
  ADD COLUMN draft_revision integer NOT NULL DEFAULT 1 CHECK (draft_revision>0);
ALTER TABLE mbox.wechat_notification_policies
  DROP CONSTRAINT wechat_notification_policies_status_check,
  DROP CONSTRAINT wechat_notification_policies_check4,
  ADD COLUMN draft_revision integer NOT NULL DEFAULT 1 CHECK (draft_revision>0),
  ADD COLUMN governance_mode text NOT NULL DEFAULT 'legacy_unattributed'
    CHECK (governance_mode IN ('legacy_unattributed','managed')),
  ADD COLUMN drafted_by_employee_id uuid,
  ADD COLUMN approved_by_employee_id uuid,
  ADD COLUMN approved_at timestamptz,
  ADD COLUMN published_by_employee_id uuid,
  ADD COLUMN publication_reason text,
  ADD CONSTRAINT wechat_notification_policies_drafter_fk
    FOREIGN KEY (tenant_id,store_id,drafted_by_employee_id)
    REFERENCES mbox.employees(tenant_id,store_id,id),
  ADD CONSTRAINT wechat_notification_policies_approver_fk
    FOREIGN KEY (tenant_id,store_id,approved_by_employee_id)
    REFERENCES mbox.employees(tenant_id,store_id,id),
  ADD CONSTRAINT wechat_notification_policies_publisher_fk
    FOREIGN KEY (tenant_id,store_id,published_by_employee_id)
    REFERENCES mbox.employees(tenant_id,store_id,id),
  ADD CONSTRAINT wechat_notification_policies_status_check
    CHECK (status IN ('draft','approved','published','retired')),
  ADD CONSTRAINT wechat_notification_policies_release_shape_ck CHECK (
    (status='draft' AND effective_from IS NULL AND published_at IS NULL)
    OR (status='approved' AND effective_from IS NULL AND published_at IS NULL)
    OR (status='published' AND effective_from IS NOT NULL AND published_at IS NOT NULL)
    OR status='retired'
  ),
  ADD CONSTRAINT wechat_notification_policies_governance_ck CHECK (
    (governance_mode='legacy_unattributed' AND drafted_by_employee_id IS NULL
      AND approved_by_employee_id IS NULL AND approved_at IS NULL
      AND published_by_employee_id IS NULL AND publication_reason IS NULL)
    OR
    (governance_mode='managed' AND drafted_by_employee_id IS NOT NULL
      AND ((status='draft' AND approved_by_employee_id IS NULL AND approved_at IS NULL
          AND published_by_employee_id IS NULL AND publication_reason IS NULL)
        OR (status='approved' AND approved_by_employee_id IS NOT NULL AND approved_at IS NOT NULL
          AND published_by_employee_id IS NULL AND publication_reason IS NULL
          AND drafted_by_employee_id<>approved_by_employee_id)
        OR (status='published' AND approved_by_employee_id IS NOT NULL AND approved_at IS NOT NULL
          AND published_by_employee_id IS NOT NULL AND publication_reason IS NOT NULL
          AND drafted_by_employee_id<>approved_by_employee_id
          AND drafted_by_employee_id<>published_by_employee_id
          AND approved_by_employee_id<>published_by_employee_id)
        OR status='retired'))
  );

CREATE TABLE mbox.membership_configuration_draft_contributors (
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  configuration_domain text NOT NULL CHECK (configuration_domain IN (
    'base_points','tier_policy','tier_benefits','redemption_catalog',
    'promotion_points','membership_terms','wechat_notifications'
  )),
  configuration_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  first_revision integer NOT NULL CHECK (first_revision>0),
  last_revision integer NOT NULL CHECK (last_revision>=first_revision),
  contribution_reason text NOT NULL CHECK (length(btrim(contribution_reason)) BETWEEN 2 AND 500),
  first_contributed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_contributed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,store_id,configuration_domain,configuration_id,employee_id),
  FOREIGN KEY (tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
  FOREIGN KEY (tenant_id,store_id,employee_id) REFERENCES mbox.employees(tenant_id,store_id,id),
  CHECK (last_contributed_at>=first_contributed_at)
);

CREATE TABLE mbox.membership_configuration_impact_previews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  public_id text NOT NULL CHECK (public_id~'^MCIP[0-9A-F]{32}$'),
  configuration_domain text NOT NULL CHECK (configuration_domain IN (
    'base_points','tier_policy','tier_benefits','redemption_catalog',
    'promotion_points','membership_terms','wechat_notifications'
  )),
  configuration_id uuid NOT NULL,
  draft_revision integer NOT NULL CHECK (draft_revision>0),
  generated_by_employee_id uuid NOT NULL,
  generated_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  source_version text NOT NULL CHECK (length(btrim(source_version)) BETWEEN 3 AND 160),
  source_measured_at timestamptz NOT NULL,
  active_members integer NOT NULL CHECK (active_members>=0),
  current_member_count integer NOT NULL CHECK (current_member_count>=0),
  current_silver_count integer NOT NULL CHECK (current_silver_count>=0),
  current_gold_count integer NOT NULL CHECK (current_gold_count>=0),
  available_points_liability bigint NOT NULL CHECK (available_points_liability>=0),
  estimated_points_issued bigint NOT NULL CHECK (estimated_points_issued>=0),
  estimated_points_cost_amount_minor bigint NOT NULL CHECK (estimated_points_cost_amount_minor>=0),
  estimated_benefit_cost_amount_minor bigint NOT NULL CHECK (estimated_benefit_cost_amount_minor>=0),
  estimated_redemption_cost_amount_minor bigint NOT NULL CHECK (estimated_redemption_cost_amount_minor>=0),
  projected_member_count integer CHECK (projected_member_count>=0),
  projected_silver_count integer CHECK (projected_silver_count>=0),
  projected_gold_count integer CHECK (projected_gold_count>=0),
  affected_existing_members integer NOT NULL CHECK (affected_existing_members>=0),
  inventory_shortage_warning boolean NOT NULL,
  fulfillment_capacity_warning boolean NOT NULL,
  points_cost_warning boolean NOT NULL,
  benefit_cost_warning boolean NOT NULL,
  redemption_cost_warning boolean NOT NULL,
  terms_reacceptance_not_forced boolean NOT NULL,
  fingerprint char(64) NOT NULL CHECK (fingerprint~'^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
  FOREIGN KEY (tenant_id,store_id,generated_by_employee_id)
    REFERENCES mbox.employees(tenant_id,store_id,id),
  UNIQUE (tenant_id,store_id,public_id),
  UNIQUE (tenant_id,store_id,id),
  CHECK (expires_at>generated_at AND expires_at-generated_at<=interval '15 minutes'),
  CHECK (current_member_count+current_silver_count+current_gold_count=active_members),
  CHECK ((projected_member_count IS NULL AND projected_silver_count IS NULL AND projected_gold_count IS NULL)
    OR (projected_member_count IS NOT NULL AND projected_silver_count IS NOT NULL
      AND projected_gold_count IS NOT NULL
      AND projected_member_count+projected_silver_count+projected_gold_count=active_members))
);

CREATE INDEX membership_configuration_impact_previews_lookup_idx
  ON mbox.membership_configuration_impact_previews(
    tenant_id,store_id,configuration_domain,configuration_id,draft_revision,generated_at DESC,id
  );

CREATE TABLE mbox.membership_configuration_impact_fulfillment_facts (
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  preview_id uuid NOT NULL,
  fact_kind text NOT NULL CHECK (fact_kind IN ('tier_benefit','redemption')),
  reference_code text NOT NULL CHECK (length(btrim(reference_code)) BETWEEN 2 AND 128),
  expected_demand integer NOT NULL CHECK (expected_demand>=0),
  available_after_reservations integer CHECK (available_after_reservations>=0),
  shortage integer NOT NULL CHECK (shortage>=0),
  open_fulfillment_tasks integer NOT NULL CHECK (open_fulfillment_tasks>=0),
  PRIMARY KEY (tenant_id,store_id,preview_id,fact_kind,reference_code),
  FOREIGN KEY (tenant_id,store_id,preview_id)
    REFERENCES mbox.membership_configuration_impact_previews(tenant_id,store_id,id)
);

CREATE TABLE mbox.membership_configuration_approval_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  configuration_domain text NOT NULL CHECK (configuration_domain IN (
    'base_points','tier_policy','tier_benefits','redemption_catalog',
    'promotion_points','membership_terms','wechat_notifications'
  )),
  configuration_id uuid NOT NULL,
  draft_revision integer NOT NULL CHECK (draft_revision>0),
  impact_preview_id uuid NOT NULL,
  impact_fingerprint char(64) NOT NULL CHECK (impact_fingerprint~'^[0-9a-f]{64}$'),
  approved_by_employee_id uuid NOT NULL,
  approval_reason text NOT NULL CHECK (length(btrim(approval_reason)) BETWEEN 2 AND 500),
  approved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
  FOREIGN KEY (tenant_id,store_id,impact_preview_id)
    REFERENCES mbox.membership_configuration_impact_previews(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,approved_by_employee_id)
    REFERENCES mbox.employees(tenant_id,store_id,id),
  UNIQUE (tenant_id,store_id,configuration_domain,configuration_id),
  UNIQUE (tenant_id,store_id,impact_preview_id),
  UNIQUE (tenant_id,store_id,id)
);

INSERT INTO mbox.membership_configuration_draft_contributors(
  tenant_id,store_id,configuration_domain,configuration_id,employee_id,
  first_revision,last_revision,contribution_reason
)
SELECT tenant_id,store_id,domain,id,drafter,1,1,'094迁移保留原起草人'
FROM (
  SELECT tenant_id,store_id,'base_points'::text domain,id,drafted_by_employee_id drafter FROM mbox.loyalty_policy_versions
  UNION ALL SELECT tenant_id,store_id,'tier_policy',id,drafted_by_employee_id FROM mbox.loyalty_tier_policy_versions
  UNION ALL SELECT tenant_id,store_id,'tier_benefits',id,drafted_by_employee_id FROM mbox.loyalty_tier_benefit_policy_versions
  UNION ALL SELECT tenant_id,store_id,'redemption_catalog',id,drafted_by_employee_id FROM mbox.redemption_catalog_versions
  UNION ALL SELECT tenant_id,store_id,'promotion_points',id,drafted_by_employee_id FROM mbox.loyalty_promotion_policy_versions
  UNION ALL SELECT tenant_id,store_id,'membership_terms',id,drafted_by_employee_id FROM mbox.membership_terms_versions
) source
ON CONFLICT DO NOTHING;

CREATE FUNCTION mbox.protect_membership_configuration_evidence()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'membership configuration evidence is immutable'; END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER membership_configuration_impact_previews_immutable
  BEFORE UPDATE OR DELETE ON mbox.membership_configuration_impact_previews
  FOR EACH ROW EXECUTE FUNCTION mbox.protect_membership_configuration_evidence();
CREATE TRIGGER membership_configuration_impact_fulfillment_facts_immutable
  BEFORE UPDATE OR DELETE ON mbox.membership_configuration_impact_fulfillment_facts
  FOR EACH ROW EXECUTE FUNCTION mbox.protect_membership_configuration_evidence();
CREATE TRIGGER membership_configuration_approval_facts_immutable
  BEFORE UPDATE OR DELETE ON mbox.membership_configuration_approval_facts
  FOR EACH ROW EXECUTE FUNCTION mbox.protect_membership_configuration_evidence();

CREATE FUNCTION mbox.protect_membership_configuration_contributor()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'membership configuration contributor facts cannot be deleted'; END IF;
  IF NEW.tenant_id<>OLD.tenant_id OR NEW.store_id<>OLD.store_id
    OR NEW.configuration_domain<>OLD.configuration_domain
    OR NEW.configuration_id<>OLD.configuration_id OR NEW.employee_id<>OLD.employee_id
    OR NEW.first_revision<>OLD.first_revision OR NEW.first_contributed_at<>OLD.first_contributed_at
    OR NEW.last_revision<OLD.last_revision OR NEW.last_contributed_at<OLD.last_contributed_at THEN
    RAISE EXCEPTION 'membership configuration contributor identity and history are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER membership_configuration_draft_contributors_protected
  BEFORE UPDATE OR DELETE ON mbox.membership_configuration_draft_contributors
  FOR EACH ROW EXECUTE FUNCTION mbox.protect_membership_configuration_contributor();

CREATE FUNCTION mbox.validate_membership_configuration_approval_fact()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE preview_row record;
BEGIN
  SELECT * INTO preview_row FROM mbox.membership_configuration_impact_previews preview
  WHERE preview.tenant_id=NEW.tenant_id AND preview.store_id=NEW.store_id
    AND preview.id=NEW.impact_preview_id FOR SHARE;
  IF preview_row.id IS NULL OR preview_row.configuration_domain<>NEW.configuration_domain
    OR preview_row.configuration_id<>NEW.configuration_id
    OR preview_row.draft_revision<>NEW.draft_revision
    OR preview_row.fingerprint<>NEW.impact_fingerprint
    OR preview_row.expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'approval requires a current server impact preview for the exact draft revision';
  END IF;
  IF EXISTS (SELECT 1 FROM mbox.membership_configuration_draft_contributors contributor
    WHERE contributor.tenant_id=NEW.tenant_id AND contributor.store_id=NEW.store_id
      AND contributor.configuration_domain=NEW.configuration_domain
      AND contributor.configuration_id=NEW.configuration_id
      AND contributor.employee_id=NEW.approved_by_employee_id) THEN
    RAISE EXCEPTION 'a membership configuration contributor cannot approve the same draft';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER membership_configuration_approval_facts_validate
  BEFORE INSERT ON mbox.membership_configuration_approval_facts
  FOR EACH ROW EXECUTE FUNCTION mbox.validate_membership_configuration_approval_fact();

CREATE FUNCTION mbox.enforce_membership_configuration_revision_governance()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.draft_revision<>1 THEN RAISE EXCEPTION 'new membership configuration draft must start at revision one'; END IF;
    INSERT INTO mbox.membership_configuration_draft_contributors(
      tenant_id,store_id,configuration_domain,configuration_id,employee_id,
      first_revision,last_revision,contribution_reason
    ) VALUES(
      NEW.tenant_id,NEW.store_id,TG_ARGV[0],NEW.id,NEW.drafted_by_employee_id,
      1,1,'配置草稿首次起草'
    ) ON CONFLICT DO NOTHING;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  IF OLD.status='draft' AND NEW.status='draft' THEN
    IF NEW.draft_revision<>OLD.draft_revision+1 THEN
      RAISE EXCEPTION 'draft edit must advance the strong revision exactly once';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM mbox.membership_configuration_draft_contributors contributor
      WHERE contributor.tenant_id=NEW.tenant_id AND contributor.store_id=NEW.store_id
        AND contributor.configuration_domain=TG_ARGV[0]
        AND contributor.configuration_id=NEW.id
        AND contributor.last_revision>=NEW.draft_revision) THEN
      RAISE EXCEPTION 'draft edit requires a strong contributor fact for the new revision';
    END IF;
  ELSIF OLD.status='draft' AND NEW.status='approved' THEN
    IF NEW.draft_revision<>OLD.draft_revision THEN
      RAISE EXCEPTION 'approval cannot alter the draft revision';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM mbox.membership_configuration_approval_facts approval
      WHERE approval.tenant_id=NEW.tenant_id AND approval.store_id=NEW.store_id
        AND approval.configuration_domain=TG_ARGV[0]
        AND approval.configuration_id=NEW.id
        AND approval.draft_revision=NEW.draft_revision
        AND approval.approved_by_employee_id=NEW.approved_by_employee_id) THEN
      RAISE EXCEPTION 'approval requires its immutable server impact approval fact';
    END IF;
  ELSE
    IF NEW.draft_revision<>OLD.draft_revision THEN
      RAISE EXCEPTION 'approved or published membership configuration revision is immutable';
    END IF;
    IF OLD.status='approved' AND NEW.status='published' AND (
      NEW.published_by_employee_id=NEW.approved_by_employee_id
      OR EXISTS (SELECT 1 FROM mbox.membership_configuration_draft_contributors contributor
        WHERE contributor.tenant_id=NEW.tenant_id AND contributor.store_id=NEW.store_id
          AND contributor.configuration_domain=TG_ARGV[0]
          AND contributor.configuration_id=NEW.id
          AND contributor.employee_id=NEW.published_by_employee_id)
    ) THEN RAISE EXCEPTION 'publisher must differ from every contributor and approver'; END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER aa_loyalty_policy_configuration_governance
  BEFORE INSERT OR UPDATE OR DELETE ON mbox.loyalty_policy_versions
  FOR EACH ROW EXECUTE FUNCTION mbox.enforce_membership_configuration_revision_governance('base_points');
CREATE TRIGGER aa_loyalty_tier_policy_configuration_governance
  BEFORE INSERT OR UPDATE OR DELETE ON mbox.loyalty_tier_policy_versions
  FOR EACH ROW EXECUTE FUNCTION mbox.enforce_membership_configuration_revision_governance('tier_policy');
CREATE TRIGGER aa_loyalty_tier_benefit_configuration_governance
  BEFORE INSERT OR UPDATE OR DELETE ON mbox.loyalty_tier_benefit_policy_versions
  FOR EACH ROW EXECUTE FUNCTION mbox.enforce_membership_configuration_revision_governance('tier_benefits');
CREATE TRIGGER aa_redemption_catalog_configuration_governance
  BEFORE INSERT OR UPDATE OR DELETE ON mbox.redemption_catalog_versions
  FOR EACH ROW EXECUTE FUNCTION mbox.enforce_membership_configuration_revision_governance('redemption_catalog');
CREATE TRIGGER aa_loyalty_promotion_configuration_governance
  BEFORE INSERT OR UPDATE OR DELETE ON mbox.loyalty_promotion_policy_versions
  FOR EACH ROW EXECUTE FUNCTION mbox.enforce_membership_configuration_revision_governance('promotion_points');
CREATE TRIGGER aa_membership_terms_configuration_governance
  BEFORE INSERT OR UPDATE OR DELETE ON mbox.membership_terms_versions
  FOR EACH ROW EXECUTE FUNCTION mbox.enforce_membership_configuration_revision_governance('membership_terms');
CREATE TRIGGER aa_wechat_notification_configuration_governance
  BEFORE INSERT OR UPDATE ON mbox.wechat_notification_policies
  FOR EACH ROW WHEN (NEW.governance_mode='managed')
  EXECUTE FUNCTION mbox.enforce_membership_configuration_revision_governance('wechat_notifications');

-- The original append-only guards rejected every draft-to-draft update. Keep
-- their complete release protection, but let the 094 revision/contributor
-- trigger exclusively govern saved draft edits.
DROP TRIGGER membership_terms_versions_immutable ON mbox.membership_terms_versions;
CREATE TRIGGER membership_terms_versions_insert_delete_guard
  BEFORE INSERT OR DELETE ON mbox.membership_terms_versions
  FOR EACH ROW EXECUTE FUNCTION mbox.protect_membership_terms_version();
CREATE TRIGGER membership_terms_versions_release_guard
  BEFORE UPDATE ON mbox.membership_terms_versions
  FOR EACH ROW WHEN (OLD.status<>'draft' OR NEW.status<>'draft')
  EXECUTE FUNCTION mbox.protect_membership_terms_version();

DROP TRIGGER loyalty_promotion_policy_versions_guard ON mbox.loyalty_promotion_policy_versions;
CREATE TRIGGER loyalty_promotion_policy_versions_insert_delete_guard
  BEFORE INSERT OR DELETE ON mbox.loyalty_promotion_policy_versions
  FOR EACH ROW EXECUTE FUNCTION mbox.protect_loyalty_promotion_policy_version();
CREATE TRIGGER loyalty_promotion_policy_versions_release_guard
  BEFORE UPDATE ON mbox.loyalty_promotion_policy_versions
  FOR EACH ROW WHEN (OLD.status<>'draft' OR NEW.status<>'draft')
  EXECUTE FUNCTION mbox.protect_loyalty_promotion_policy_version();

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'membership_configuration_draft_contributors',
    'membership_configuration_impact_previews',
    'membership_configuration_impact_fulfillment_facts',
    'membership_configuration_approval_facts'
  ] LOOP
    EXECUTE format('ALTER TABLE mbox.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE mbox.%I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format(
      'CREATE POLICY tenant_store_isolation ON mbox.%I USING (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())',
      table_name
    );
    EXECUTE format('GRANT SELECT,INSERT,UPDATE ON TABLE mbox.%I TO mbox_runtime',table_name);
  END LOOP;
END $$;
REVOKE DELETE ON mbox.membership_configuration_draft_contributors,
  mbox.membership_configuration_impact_previews,
  mbox.membership_configuration_impact_fulfillment_facts,
  mbox.membership_configuration_approval_facts FROM mbox_runtime;
REVOKE UPDATE ON mbox.membership_configuration_impact_previews,
  mbox.membership_configuration_impact_fulfillment_facts,
  mbox.membership_configuration_approval_facts FROM mbox_runtime;

CREATE FUNCTION mbox.seed_store_membership_configuration_permissions()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO mbox.staff_permission_definitions(
    tenant_id,store_id,code,name,category,description,status
  ) VALUES
    (NEW.tenant_id,NEW.id,'loyalty.configuration.view','查看会员经营配置','loyalty','查看强类型配置草稿和服务端影响预览','active'),
    (NEW.tenant_id,NEW.id,'loyalty.configuration.edit','编辑会员配置草稿','loyalty','仅编辑未审批草稿并保留全部编辑者事实','active'),
    (NEW.tenant_id,NEW.id,'loyalty.configuration.preview','生成配置影响预览','loyalty','基于当前会员、成本、库存和履约事实生成限时预览','active'),
    (NEW.tenant_id,NEW.id,'loyalty.configuration.approve','审批会员经营配置','loyalty','凭服务端持久化影响预览独立审批','active')
  ON CONFLICT (tenant_id,store_id,code) DO UPDATE SET
    name=EXCLUDED.name,category=EXCLUDED.category,description=EXCLUDED.description,status='active';
  RETURN NEW;
END $$;
CREATE TRIGGER stores_seed_membership_configuration_permissions
  AFTER INSERT ON mbox.stores FOR EACH ROW
  EXECUTE FUNCTION mbox.seed_store_membership_configuration_permissions();

INSERT INTO mbox.staff_permission_definitions(
  tenant_id,store_id,code,name,category,description,status
)
SELECT store.tenant_id,store.id,permission.code,permission.name,'loyalty',permission.description,'active'
FROM mbox.stores store CROSS JOIN (VALUES
  ('loyalty.configuration.view','查看会员经营配置','查看强类型配置草稿和服务端影响预览'),
  ('loyalty.configuration.edit','编辑会员配置草稿','仅编辑未审批草稿并保留全部编辑者事实'),
  ('loyalty.configuration.preview','生成配置影响预览','基于当前会员、成本、库存和履约事实生成限时预览'),
  ('loyalty.configuration.approve','审批会员经营配置','凭服务端持久化影响预览独立审批')
) permission(code,name,description)
ON CONFLICT (tenant_id,store_id,code) DO UPDATE SET
  name=EXCLUDED.name,category=EXCLUDED.category,description=EXCLUDED.description,status='active';

INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id)
SELECT role.tenant_id,role.store_id,role.id,permission.id
FROM mbox.roles role
JOIN mbox.staff_permission_definitions permission
  ON permission.tenant_id=role.tenant_id AND permission.store_id=role.store_id
WHERE (role.code IN ('OWNER','OPS_LEAD','MANAGER') AND permission.code IN (
  'loyalty.configuration.view','loyalty.configuration.preview'
)) OR (role.code='MANAGER' AND permission.code='loyalty.configuration.edit')
  OR (role.code='OPS_LEAD' AND permission.code='loyalty.configuration.approve')
ON CONFLICT DO NOTHING;

CREATE FUNCTION mbox.seed_role_membership_configuration_permissions()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id)
  SELECT NEW.tenant_id,NEW.store_id,NEW.id,permission.id
  FROM mbox.staff_permission_definitions permission
  WHERE permission.tenant_id=NEW.tenant_id AND permission.store_id=NEW.store_id
    AND ((NEW.code IN ('OWNER','OPS_LEAD','MANAGER') AND permission.code IN (
      'loyalty.configuration.view','loyalty.configuration.preview'
    )) OR (NEW.code='MANAGER' AND permission.code='loyalty.configuration.edit')
      OR (NEW.code='OPS_LEAD' AND permission.code='loyalty.configuration.approve'))
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER roles_seed_membership_configuration_permissions
  AFTER INSERT ON mbox.roles FOR EACH ROW
  EXECUTE FUNCTION mbox.seed_role_membership_configuration_permissions();

GRANT EXECUTE ON FUNCTION mbox.protect_membership_configuration_evidence() TO mbox_runtime;
GRANT EXECUTE ON FUNCTION mbox.protect_membership_configuration_contributor() TO mbox_runtime;
GRANT EXECUTE ON FUNCTION mbox.validate_membership_configuration_approval_fact() TO mbox_runtime;
GRANT EXECUTE ON FUNCTION mbox.enforce_membership_configuration_revision_governance() TO mbox_runtime;
GRANT EXECUTE ON FUNCTION mbox.seed_store_membership_configuration_permissions() TO mbox_runtime;
GRANT EXECUTE ON FUNCTION mbox.seed_role_membership_configuration_permissions() TO mbox_runtime;

UPDATE mbox.normalized_schema_metadata
SET schema_version='094',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
