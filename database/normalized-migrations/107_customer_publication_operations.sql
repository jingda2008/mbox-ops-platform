BEGIN;

-- Publishing a name or a privacy policy is an operating command, never a
-- direct database-editing convention.  Draft ownership gives the service a
-- concrete independence check while the approval reference binds the command
-- to the external HR or legal material kept outside the source repository.
ALTER TABLE mbox.employee_customer_public_profiles
  ADD COLUMN drafted_by_employee_id uuid,
  ADD COLUMN approval_reference text;

ALTER TABLE mbox.employee_customer_public_profiles
  DROP CONSTRAINT employee_customer_public_prof_tenant_id_store_id_employee_i_key;

CREATE UNIQUE INDEX employee_customer_public_profiles_one_draft_uq
  ON mbox.employee_customer_public_profiles(tenant_id,store_id,employee_id)
  WHERE status='draft';

CREATE UNIQUE INDEX employee_customer_public_profiles_one_published_uq
  ON mbox.employee_customer_public_profiles(tenant_id,store_id,employee_id)
  WHERE status='published';

ALTER TABLE mbox.employee_customer_public_profiles
  ADD CONSTRAINT employee_customer_public_profiles_drafter_fk
    FOREIGN KEY (tenant_id,store_id,drafted_by_employee_id)
    REFERENCES mbox.employees(tenant_id,store_id,id),
  ADD CONSTRAINT employee_customer_public_profiles_independent_approval_ck
    CHECK (
      status <> 'published' OR (
        drafted_by_employee_id IS NOT NULL
        AND approved_by_employee_id IS NOT NULL
        AND approved_by_employee_id <> employee_id
        AND approved_by_employee_id <> drafted_by_employee_id
        AND length(btrim(COALESCE(approval_reference,''))) BETWEEN 8 AND 240
      )
    );

ALTER TABLE mbox.privacy_policy_releases
  ADD COLUMN drafted_by_employee_id uuid,
  ADD COLUMN approval_reference text;

ALTER TABLE mbox.privacy_policy_releases
  ADD CONSTRAINT privacy_policy_releases_drafter_fk
    FOREIGN KEY (tenant_id,store_id,drafted_by_employee_id)
    REFERENCES mbox.employees(tenant_id,store_id,id),
  ADD CONSTRAINT privacy_policy_releases_drafted_publication_ck
    CHECK (
      status <> 'published' OR (
        drafted_by_employee_id IS NOT NULL
        AND length(btrim(COALESCE(approval_reference,''))) BETWEEN 8 AND 240
      )
    );

-- A released customer-visible fact may only be withdrawn.  A corrected name
-- or policy must start a new draft, preserving the old approval and audit
-- chain instead of silently changing what customers were shown.
CREATE OR REPLACE FUNCTION mbox.reject_published_customer_publication_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.status='published' THEN
    IF NEW.status<>'withdrawn'
      OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
      OR NEW.store_id IS DISTINCT FROM OLD.store_id
      OR NEW.employee_id IS DISTINCT FROM OLD.employee_id
      OR NEW.public_display_name IS DISTINCT FROM OLD.public_display_name
      OR NEW.drafted_by_employee_id IS DISTINCT FROM OLD.drafted_by_employee_id
      OR NEW.approved_by_employee_id IS DISTINCT FROM OLD.approved_by_employee_id
      OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
      OR NEW.effective_at IS DISTINCT FROM OLD.effective_at
      OR NEW.approval_reference IS DISTINCT FROM OLD.approval_reference
    THEN RAISE EXCEPTION 'published employee customer profile is immutable until withdrawn'; END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER employee_customer_public_profiles_published_immutable
  BEFORE UPDATE ON mbox.employee_customer_public_profiles
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_published_customer_publication_change();

CREATE OR REPLACE FUNCTION mbox.reject_published_privacy_policy_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.status='published' THEN
    IF NEW.status<>'withdrawn'
      OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
      OR NEW.store_id IS DISTINCT FROM OLD.store_id
      OR NEW.policy_version IS DISTINCT FROM OLD.policy_version
      OR NEW.content_markdown IS DISTINCT FROM OLD.content_markdown
      OR NEW.content_sha256 IS DISTINCT FROM OLD.content_sha256
      OR NEW.operator_name IS DISTINCT FROM OLD.operator_name
      OR NEW.contact IS DISTINCT FROM OLD.contact
      OR NEW.data_retention_policy_version IS DISTINCT FROM OLD.data_retention_policy_version
      OR NEW.third_party_register_version IS DISTINCT FROM OLD.third_party_register_version
      OR NEW.drafted_by_employee_id IS DISTINCT FROM OLD.drafted_by_employee_id
      OR NEW.approved_by IS DISTINCT FROM OLD.approved_by
      OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
      OR NEW.effective_at IS DISTINCT FROM OLD.effective_at
      OR NEW.approval_reference IS DISTINCT FROM OLD.approval_reference
    THEN RAISE EXCEPTION 'published privacy policy is immutable until withdrawn'; END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER privacy_policy_releases_published_immutable
  BEFORE UPDATE ON mbox.privacy_policy_releases
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_published_privacy_policy_change();

CREATE OR REPLACE FUNCTION mbox.seed_customer_publication_permissions(
  target_tenant_id uuid,target_store_id uuid
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO mbox.staff_permission_definitions (
    tenant_id,store_id,code,name,category,description,status
  ) VALUES
    (target_tenant_id,target_store_id,'customer.public-profile.manage','编辑顾客公开服务名草稿','customer_publication','为员工建立或撤回顾客可见服务名草稿；不能自行发布','active'),
    (target_tenant_id,target_store_id,'customer.public-profile.publish','发布顾客公开服务名','customer_publication','独立复核人依据门店或人事确认发布顾客可见服务名','active'),
    (target_tenant_id,target_store_id,'privacy.policy.view','查看隐私政策版本','customer_publication','查看顾客隐私政策草稿、已发布版本和撤下记录','active'),
    (target_tenant_id,target_store_id,'privacy.policy.manage','编辑隐私政策草稿','customer_publication','建立和修改正式隐私政策草稿；不能自行发布','active'),
    (target_tenant_id,target_store_id,'privacy.policy.publish','发布隐私政策','customer_publication','独立复核正式政策内容、批准材料和生效时间后发布','active')
  ON CONFLICT (tenant_id,store_id,code) DO UPDATE
  SET name=EXCLUDED.name,category=EXCLUDED.category,
      description=EXCLUDED.description,status='active';
END;
$$;

CREATE OR REPLACE FUNCTION mbox.seed_store_customer_publication_permissions()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM mbox.seed_customer_publication_permissions(NEW.tenant_id,NEW.id);
  RETURN NEW;
END;
$$;

CREATE TRIGGER stores_seed_customer_publication_permissions
  AFTER INSERT ON mbox.stores
  FOR EACH ROW EXECUTE FUNCTION mbox.seed_store_customer_publication_permissions();

-- The configuration catalogue is created by an earlier same-event trigger.
-- Keep this trigger last so a role which is given only a publication
-- permission still receives the settings entry; navigation is presentation,
-- not authority, and the API checks the action permission again.
CREATE OR REPLACE FUNCTION mbox.seed_customer_publication_navigation(
  target_tenant_id uuid,target_store_id uuid
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM mbox.seed_customer_publication_permissions(target_tenant_id,target_store_id);
  UPDATE mbox.staff_access_configuration_definitions
  SET required_permission_codes = (
        SELECT ARRAY(SELECT DISTINCT code FROM unnest(
          required_permission_codes || ARRAY[
            'customer.public-profile.manage','customer.public-profile.publish',
            'privacy.policy.view','privacy.policy.manage','privacy.policy.publish'
          ]::text[]
        ) AS code ORDER BY code)
      ),
      description = '权限、商品、支付、设备、AI与顾客公开内容配置',
      updated_at = clock_timestamp()
  WHERE tenant_id=target_tenant_id AND store_id=target_store_id
    AND definition_kind='navigation' AND code='settings';
END;
$$;

CREATE OR REPLACE FUNCTION mbox.seed_store_customer_publication_navigation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM mbox.seed_customer_publication_navigation(NEW.tenant_id,NEW.id);
  RETURN NEW;
END;
$$;

CREATE TRIGGER zz_stores_seed_customer_publication_navigation
  AFTER INSERT ON mbox.stores
  FOR EACH ROW EXECUTE FUNCTION mbox.seed_store_customer_publication_navigation();

SELECT mbox.seed_customer_publication_permissions(store.tenant_id,store.id)
FROM mbox.stores store;

SELECT mbox.seed_customer_publication_navigation(store.tenant_id,store.id)
FROM mbox.stores store;

UPDATE mbox.normalized_schema_metadata
SET schema_version='107',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
