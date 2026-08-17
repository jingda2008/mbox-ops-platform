BEGIN;

CREATE TABLE mbox.membership_terms_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  public_id text NOT NULL CHECK (public_id ~ '^MTV[0-9A-F]{32}$'),
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','approved','published')),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 2 AND 120),
  summary text NOT NULL CHECK (length(btrim(summary)) BETWEEN 2 AND 500),
  content text NOT NULL CHECK (length(btrim(content)) BETWEEN 10 AND 12000),
  drafted_by_employee_id uuid NOT NULL,
  draft_reason text NOT NULL CHECK (length(btrim(draft_reason)) BETWEEN 2 AND 500),
  approved_by_employee_id uuid,
  approval_reason text,
  approved_at timestamptz,
  published_by_employee_id uuid,
  publication_reason text,
  published_at timestamptz,
  effective_from timestamptz,
  effective_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
  FOREIGN KEY (tenant_id,store_id,drafted_by_employee_id)
    REFERENCES mbox.employees(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,approved_by_employee_id)
    REFERENCES mbox.employees(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,published_by_employee_id)
    REFERENCES mbox.employees(tenant_id,store_id,id),
  UNIQUE (tenant_id,store_id,public_id),
  UNIQUE (tenant_id,store_id,version),
  UNIQUE (tenant_id,store_id,id),
  UNIQUE (tenant_id,store_id,id,version),
  CHECK (approval_reason IS NULL OR length(btrim(approval_reason)) BETWEEN 2 AND 500),
  CHECK (publication_reason IS NULL OR length(btrim(publication_reason)) BETWEEN 2 AND 500),
  CHECK (effective_until IS NULL OR (effective_from IS NOT NULL AND effective_until>effective_from)),
  CHECK (published_at IS NULL OR (effective_from IS NOT NULL AND effective_from>=published_at)),
  CHECK (
    (status='draft' AND approved_by_employee_id IS NULL AND approval_reason IS NULL
      AND approved_at IS NULL AND published_by_employee_id IS NULL
      AND publication_reason IS NULL AND published_at IS NULL
      AND effective_from IS NULL AND effective_until IS NULL)
    OR
    (status='approved' AND approved_by_employee_id IS NOT NULL
      AND approval_reason IS NOT NULL AND approved_at IS NOT NULL
      AND approved_by_employee_id<>drafted_by_employee_id
      AND published_by_employee_id IS NULL AND publication_reason IS NULL
      AND published_at IS NULL AND effective_from IS NULL AND effective_until IS NULL)
    OR
    (status='published' AND approved_by_employee_id IS NOT NULL
      AND approval_reason IS NOT NULL AND approved_at IS NOT NULL
      AND published_by_employee_id IS NOT NULL AND publication_reason IS NOT NULL
      AND published_at IS NOT NULL AND effective_from IS NOT NULL
      AND approved_by_employee_id<>drafted_by_employee_id
      AND published_by_employee_id<>drafted_by_employee_id
      AND published_by_employee_id<>approved_by_employee_id)
  )
);

ALTER TABLE mbox.membership_terms_versions
  ADD CONSTRAINT membership_terms_versions_no_published_overlap_excl
  EXCLUDE USING gist (
    tenant_id WITH =,store_id WITH =,
    tstzrange(effective_from,effective_until,'[)') WITH &&
  ) WHERE (status='published') DEFERRABLE INITIALLY IMMEDIATE;

CREATE INDEX membership_terms_versions_current_idx
  ON mbox.membership_terms_versions
    (tenant_id,store_id,status,effective_from DESC,version DESC,id)
  WHERE status='published';

CREATE TABLE mbox.membership_terms_acceptances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  public_id text NOT NULL CHECK (public_id ~ '^MTA[0-9A-F]{32}$'),
  customer_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  terms_version_id uuid NOT NULL,
  terms_version integer NOT NULL CHECK (terms_version > 0),
  acknowledgement_source text NOT NULL
    CHECK (acknowledgement_source IN ('mini_menu','mini_profile')),
  accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
  FOREIGN KEY (tenant_id,store_id,customer_id)
    REFERENCES mbox.customers(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,membership_id)
    REFERENCES mbox.customer_memberships(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,terms_version_id,terms_version)
    REFERENCES mbox.membership_terms_versions(tenant_id,store_id,id,version),
  UNIQUE (tenant_id,store_id,public_id),
  UNIQUE (tenant_id,store_id,membership_id,terms_version_id),
  UNIQUE (tenant_id,store_id,id),
  CHECK (created_at>=accepted_at)
);

CREATE INDEX membership_terms_acceptances_customer_idx
  ON mbox.membership_terms_acceptances
    (tenant_id,store_id,customer_id,accepted_at DESC,id);

CREATE FUNCTION mbox.protect_membership_terms_version()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'draft' THEN RAISE EXCEPTION 'membership terms must start as draft'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'membership terms versions are immutable'; END IF;
  IF OLD.status='draft' AND NEW.status='approved' THEN
    IF ROW(NEW.public_id,NEW.version,NEW.title,NEW.summary,NEW.content,
      NEW.drafted_by_employee_id,NEW.draft_reason,NEW.created_at) IS DISTINCT FROM
      ROW(OLD.public_id,OLD.version,OLD.title,OLD.summary,OLD.content,
      OLD.drafted_by_employee_id,OLD.draft_reason,OLD.created_at) THEN
      RAISE EXCEPTION 'approval cannot change membership terms facts';
    END IF;
  ELSIF OLD.status='approved' AND NEW.status='published' THEN
    IF ROW(NEW.public_id,NEW.version,NEW.title,NEW.summary,NEW.content,
      NEW.drafted_by_employee_id,NEW.draft_reason,NEW.approved_by_employee_id,
      NEW.approval_reason,NEW.approved_at,NEW.created_at) IS DISTINCT FROM
      ROW(OLD.public_id,OLD.version,OLD.title,OLD.summary,OLD.content,
      OLD.drafted_by_employee_id,OLD.draft_reason,OLD.approved_by_employee_id,
      OLD.approval_reason,OLD.approved_at,OLD.created_at) THEN
      RAISE EXCEPTION 'publication cannot change approved membership terms facts';
    END IF;
  ELSIF OLD.status='published' AND NEW.status='published' THEN
    IF ROW(NEW.public_id,NEW.version,NEW.title,NEW.summary,NEW.content,
      NEW.drafted_by_employee_id,NEW.draft_reason,NEW.approved_by_employee_id,
      NEW.approval_reason,NEW.approved_at,NEW.published_by_employee_id,
      NEW.publication_reason,NEW.published_at,NEW.effective_from,NEW.created_at)
      IS DISTINCT FROM
      ROW(OLD.public_id,OLD.version,OLD.title,OLD.summary,OLD.content,
      OLD.drafted_by_employee_id,OLD.draft_reason,OLD.approved_by_employee_id,
      OLD.approval_reason,OLD.approved_at,OLD.published_by_employee_id,
      OLD.publication_reason,OLD.published_at,OLD.effective_from,OLD.created_at)
      OR NEW.effective_until IS NULL
      OR (OLD.effective_until IS NOT NULL AND NEW.effective_until>OLD.effective_until)
      OR NOT EXISTS (
        SELECT 1 FROM mbox.membership_terms_versions replacement
        WHERE replacement.tenant_id=NEW.tenant_id AND replacement.store_id=NEW.store_id
          AND replacement.status='published' AND replacement.id<>NEW.id
          AND replacement.effective_from=NEW.effective_until
      ) THEN
      RAISE EXCEPTION 'published membership terms are immutable outside an exact scheduled cut-over';
    END IF;
  ELSE
    RAISE EXCEPTION 'invalid membership terms transition';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER membership_terms_versions_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON mbox.membership_terms_versions
  FOR EACH ROW EXECUTE FUNCTION mbox.protect_membership_terms_version();

CREATE FUNCTION mbox.validate_membership_terms_acceptance()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE membership_customer_id uuid;
DECLARE terms_status text;
DECLARE terms_from timestamptz;
DECLARE terms_until timestamptz;
BEGIN
  SELECT membership.customer_id INTO membership_customer_id
  FROM mbox.customer_memberships membership
  WHERE membership.tenant_id=NEW.tenant_id AND membership.store_id=NEW.store_id
    AND membership.id=NEW.membership_id AND membership.status='active';
  IF membership_customer_id IS DISTINCT FROM NEW.customer_id THEN
    RAISE EXCEPTION 'membership terms acceptance customer does not own membership';
  END IF;
  SELECT terms.status,terms.effective_from,terms.effective_until
  INTO terms_status,terms_from,terms_until
  FROM mbox.membership_terms_versions terms
  WHERE terms.tenant_id=NEW.tenant_id AND terms.store_id=NEW.store_id
    AND terms.id=NEW.terms_version_id AND terms.version=NEW.terms_version;
  IF terms_status IS DISTINCT FROM 'published'
    OR terms_from>NEW.accepted_at OR (terms_until IS NOT NULL AND terms_until<=NEW.accepted_at) THEN
    RAISE EXCEPTION 'membership terms acceptance requires the current published version';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER membership_terms_acceptances_validate
  BEFORE INSERT ON mbox.membership_terms_acceptances
  FOR EACH ROW EXECUTE FUNCTION mbox.validate_membership_terms_acceptance();
CREATE TRIGGER membership_terms_acceptances_append_only
  BEFORE UPDATE OR DELETE ON mbox.membership_terms_acceptances
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();

ALTER TABLE mbox.membership_terms_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.membership_terms_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.membership_terms_versions
  USING (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())
  WITH CHECK (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
GRANT SELECT,INSERT,UPDATE ON TABLE mbox.membership_terms_versions TO mbox_runtime;
REVOKE DELETE ON TABLE mbox.membership_terms_versions FROM mbox_runtime;

ALTER TABLE mbox.membership_terms_acceptances ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.membership_terms_acceptances FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.membership_terms_acceptances
  USING (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())
  WITH CHECK (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
GRANT SELECT,INSERT ON TABLE mbox.membership_terms_acceptances TO mbox_runtime;
REVOKE UPDATE,DELETE ON TABLE mbox.membership_terms_acceptances FROM mbox_runtime;

CREATE FUNCTION mbox.seed_store_membership_terms_permissions()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO mbox.staff_permission_definitions(
    tenant_id,store_id,code,name,category,description,status
  ) VALUES
    (NEW.tenant_id,NEW.id,'membership.terms.view','查看入会条款','loyalty','查看入会条款草稿、审批与发布历史','active'),
    (NEW.tenant_id,NEW.id,'membership.terms.manage','起草入会条款','loyalty','创建新的强类型入会条款版本；不能自行审批或发布','active'),
    (NEW.tenant_id,NEW.id,'membership.terms.approve','审批入会条款','loyalty','由非起草人审批入会条款；不能自行发布','active'),
    (NEW.tenant_id,NEW.id,'membership.terms.publish','发布入会条款','loyalty','由第三名最高授权人员排期发布已审批条款','active')
  ON CONFLICT (tenant_id,store_id,code) DO UPDATE SET
    name=EXCLUDED.name,category=EXCLUDED.category,
    description=EXCLUDED.description,status='active';
  RETURN NEW;
END $$;

CREATE TRIGGER stores_seed_membership_terms_permissions
  AFTER INSERT ON mbox.stores
  FOR EACH ROW EXECUTE FUNCTION mbox.seed_store_membership_terms_permissions();

INSERT INTO mbox.staff_permission_definitions(
  tenant_id,store_id,code,name,category,description,status
)
SELECT store.tenant_id,store.id,permission.code,permission.name,
  'loyalty',permission.description,'active'
FROM mbox.stores store CROSS JOIN (VALUES
  ('membership.terms.view','查看入会条款','查看入会条款草稿、审批与发布历史'),
  ('membership.terms.manage','起草入会条款','创建新的强类型入会条款版本；不能自行审批或发布'),
  ('membership.terms.approve','审批入会条款','由非起草人审批入会条款；不能自行发布'),
  ('membership.terms.publish','发布入会条款','由第三名最高授权人员排期发布已审批条款')
) permission(code,name,description)
ON CONFLICT (tenant_id,store_id,code) DO UPDATE SET
  name=EXCLUDED.name,category=EXCLUDED.category,
  description=EXCLUDED.description,status='active';

INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id)
SELECT role.tenant_id,role.store_id,role.id,permission.id
FROM mbox.roles role
JOIN mbox.staff_permission_definitions permission
  ON permission.tenant_id=role.tenant_id AND permission.store_id=role.store_id
WHERE role.status='active' AND (
  (role.code='MANAGER' AND permission.code IN ('membership.terms.view','membership.terms.manage'))
  OR (role.code='OPS_LEAD' AND permission.code IN ('membership.terms.view','membership.terms.approve'))
  OR (role.code='OWNER' AND permission.code IN ('membership.terms.view','membership.terms.publish'))
)
ON CONFLICT (tenant_id,store_id,role_id,permission_id) DO NOTHING;

CREATE FUNCTION mbox.seed_role_membership_terms_permissions()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id)
  SELECT NEW.tenant_id,NEW.store_id,NEW.id,permission.id
  FROM mbox.staff_permission_definitions permission
  WHERE permission.tenant_id=NEW.tenant_id AND permission.store_id=NEW.store_id
    AND (
      (NEW.code='MANAGER' AND permission.code IN ('membership.terms.view','membership.terms.manage'))
      OR (NEW.code='OPS_LEAD' AND permission.code IN ('membership.terms.view','membership.terms.approve'))
      OR (NEW.code='OWNER' AND permission.code IN ('membership.terms.view','membership.terms.publish'))
    )
  ON CONFLICT (tenant_id,store_id,role_id,permission_id) DO NOTHING;
  RETURN NEW;
END $$;

CREATE TRIGGER roles_seed_membership_terms_permissions
  AFTER INSERT ON mbox.roles
  FOR EACH ROW EXECUTE FUNCTION mbox.seed_role_membership_terms_permissions();

COMMENT ON TABLE mbox.membership_terms_versions IS
  'Versioned typed membership terms with independent drafter, approver and publisher and effective-time publication.';
COMMENT ON TABLE mbox.membership_terms_acceptances IS
  'Append-only customer and membership bound acceptance facts; never inferred from UI or JSON evidence.';

UPDATE mbox.normalized_schema_metadata
SET schema_version='081',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
