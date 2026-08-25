BEGIN;

-- Annual member benefits are not a content banner.  The policy, the dated
-- festival occurrence and the actual benefit grant are separate facts so a
-- future preview cannot be redeemed or reserve stock.
CREATE TABLE mbox.loyalty_annual_benefit_policy_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  policy_code text NOT NULL CHECK (policy_code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','approved','published','paused','retired')),
  timezone text NOT NULL DEFAULT 'Asia/Shanghai'
    CHECK (timezone ~ '^[A-Za-z_]+/[A-Za-z_]+(?:/[A-Za-z_]+)?$'),
  effective_from timestamptz,
  effective_until timestamptz,
  drafted_by_employee_id uuid NOT NULL,
  approved_by_employee_id uuid,
  approved_at timestamptz,
  published_by_employee_id uuid,
  published_at timestamptz,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 2 AND 500),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
  FOREIGN KEY (tenant_id,store_id,drafted_by_employee_id)
    REFERENCES mbox.employees(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,approved_by_employee_id)
    REFERENCES mbox.employees(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,published_by_employee_id)
    REFERENCES mbox.employees(tenant_id,store_id,id),
  UNIQUE (tenant_id,store_id,policy_code,version),
  UNIQUE (tenant_id,store_id,id),
  CHECK (effective_until IS NULL OR effective_from IS NULL OR effective_until>effective_from),
  CHECK (
    (status='draft' AND approved_by_employee_id IS NULL AND approved_at IS NULL
      AND published_by_employee_id IS NULL AND published_at IS NULL
      AND effective_from IS NULL AND effective_until IS NULL)
    OR (status='approved' AND approved_by_employee_id IS NOT NULL AND approved_at IS NOT NULL
      AND approved_by_employee_id<>drafted_by_employee_id
      AND published_by_employee_id IS NULL AND published_at IS NULL
      AND effective_from IS NULL AND effective_until IS NULL)
    OR (status IN ('published','paused','retired') AND effective_from IS NOT NULL
      AND approved_by_employee_id IS NOT NULL AND approved_at IS NOT NULL
      AND published_by_employee_id IS NOT NULL AND published_at IS NOT NULL
      AND approved_by_employee_id<>drafted_by_employee_id
      AND published_by_employee_id<>drafted_by_employee_id
      AND published_by_employee_id<>approved_by_employee_id)
  )
);

ALTER TABLE mbox.loyalty_annual_benefit_policy_versions
  ADD CONSTRAINT loyalty_annual_benefit_policy_no_published_overlap_excl
  EXCLUDE USING gist (tenant_id WITH =,store_id WITH =,policy_code WITH =,
    tstzrange(effective_from,effective_until,'[)') WITH &&)
  WHERE (status='published') DEFERRABLE INITIALLY IMMEDIATE;

CREATE TABLE mbox.loyalty_annual_benefit_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  policy_version_id uuid NOT NULL,
  rule_code text NOT NULL CHECK (rule_code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 2 AND 120),
  rule_kind text NOT NULL CHECK (rule_kind IN (
    'birthday','festival','priority_seating','daily_snack'
  )),
  eligible_tier text NOT NULL CHECK (eligible_tier IN ('member','silver','gold')),
  inherit_to_higher_tiers boolean NOT NULL DEFAULT false,
  benefit_definition_id uuid NOT NULL,
  quantity smallint NOT NULL DEFAULT 1 CHECK (quantity BETWEEN 1 AND 100),
  validity_days smallint NOT NULL CHECK (validity_days BETWEEN 1 AND 366),
  window_before_days smallint NOT NULL DEFAULT 0 CHECK (window_before_days BETWEEN 0 AND 90),
  window_after_days smallint NOT NULL DEFAULT 0 CHECK (window_after_days BETWEEN 0 AND 90),
  requires_birthday_consent boolean NOT NULL DEFAULT false,
  requires_confirmed_occurrence boolean NOT NULL DEFAULT false,
  on_site_only boolean NOT NULL DEFAULT true,
  requires_table_session boolean NOT NULL DEFAULT true,
  member_daily_limit smallint NOT NULL DEFAULT 1 CHECK (member_daily_limit BETWEEN 1 AND 100),
  table_daily_limit smallint NOT NULL DEFAULT 1 CHECK (table_daily_limit BETWEEN 1 AND 100),
  alcohol_handling text NOT NULL DEFAULT 'not_applicable'
    CHECK (alcohol_handling IN ('not_applicable','non_alcoholic_only','staff_compliance_required')),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,store_id,policy_version_id)
    REFERENCES mbox.loyalty_annual_benefit_policy_versions(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,benefit_definition_id)
    REFERENCES mbox.loyalty_benefit_definitions(tenant_id,store_id,id),
  UNIQUE (tenant_id,store_id,policy_version_id,rule_code),
  UNIQUE (tenant_id,store_id,id),
  CHECK ((rule_kind='birthday')=requires_birthday_consent),
  CHECK ((rule_kind='festival')=requires_confirmed_occurrence),
  CHECK ((rule_kind IN ('priority_seating','daily_snack')) OR (on_site_only AND requires_table_session))
);

-- Lunar and other movable festivals are never calculated by an unreviewed
-- library.  Operations confirms the concrete solar dates for each policy and
-- calendar year before customers can see them.
CREATE TABLE mbox.loyalty_annual_benefit_occurrences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  rule_id uuid NOT NULL,
  cycle_year smallint NOT NULL CHECK (cycle_year BETWEEN 2020 AND 2200),
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  confirmed_by_employee_id uuid NOT NULL,
  confirmation_reference text NOT NULL CHECK (length(btrim(confirmation_reference)) BETWEEN 2 AND 240),
  confirmed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,store_id,rule_id)
    REFERENCES mbox.loyalty_annual_benefit_rules(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,confirmed_by_employee_id)
    REFERENCES mbox.employees(tenant_id,store_id,id),
  UNIQUE (tenant_id,store_id,rule_id,cycle_year),
  UNIQUE (tenant_id,store_id,id),
  CHECK (ends_on>=starts_on),
  CHECK (extract(year FROM starts_on)=cycle_year AND extract(year FROM ends_on)=cycle_year)
);

CREATE TABLE mbox.customer_annual_benefit_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  consent_type text NOT NULL CHECK (consent_type IN ('birthday_month_day')),
  status text NOT NULL CHECK (status IN ('granted','withdrawn')),
  source text NOT NULL CHECK (length(btrim(source)) BETWEEN 2 AND 64),
  consented_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  withdrawn_at timestamptz,
  withdrawal_reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,store_id,customer_id)
    REFERENCES mbox.customers(tenant_id,store_id,id),
  UNIQUE (tenant_id,store_id,id),
  CHECK ((status='granted' AND withdrawn_at IS NULL AND withdrawal_reason IS NULL)
    OR (status='withdrawn' AND withdrawn_at IS NOT NULL
      AND length(btrim(COALESCE(withdrawal_reason,''))) BETWEEN 2 AND 500))
);

CREATE UNIQUE INDEX customer_annual_benefit_consents_one_granted_uq
  ON mbox.customer_annual_benefit_consents(tenant_id,store_id,customer_id,consent_type)
  WHERE status='granted';

-- A grant exists only at the use window.  `projection_key` is intentionally
-- absent here: a calendar preview is deterministic display data, not a
-- redeemable record.
CREATE TABLE mbox.membership_annual_benefit_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  policy_version_id uuid NOT NULL,
  rule_id uuid NOT NULL,
  cycle_key text NOT NULL CHECK (cycle_key ~ '^[0-9]{4}(?:-[0-9]{2}-[0-9]{2})?$'),
  benefit_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','fulfilled','expired','revoked')),
  granted_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,store_id,membership_id)
    REFERENCES mbox.customer_memberships(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,customer_id)
    REFERENCES mbox.customers(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,policy_version_id)
    REFERENCES mbox.loyalty_annual_benefit_policy_versions(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,rule_id)
    REFERENCES mbox.loyalty_annual_benefit_rules(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,benefit_id)
    REFERENCES mbox.benefits(tenant_id,store_id,id),
  UNIQUE (tenant_id,store_id,membership_id,rule_id,cycle_key),
  UNIQUE (tenant_id,store_id,benefit_id),
  UNIQUE (tenant_id,store_id,id),
  CHECK (expires_at>granted_at)
);

CREATE INDEX membership_annual_benefit_grants_customer_idx
  ON mbox.membership_annual_benefit_grants(tenant_id,store_id,customer_id,granted_at DESC,id DESC);
CREATE INDEX loyalty_annual_benefit_occurrences_calendar_idx
  ON mbox.loyalty_annual_benefit_occurrences(tenant_id,store_id,starts_on,ends_on,rule_id);

CREATE OR REPLACE FUNCTION mbox.protect_loyalty_annual_benefit_policy()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' AND OLD.status<>'draft' THEN
    RAISE EXCEPTION 'released annual benefit policies are immutable';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  IF TG_OP='UPDATE' AND OLD.status='draft' AND NEW.status='approved' THEN
    IF ROW(NEW.policy_code,NEW.version,NEW.timezone,NEW.drafted_by_employee_id,NEW.created_at)
      IS DISTINCT FROM ROW(OLD.policy_code,OLD.version,OLD.timezone,OLD.drafted_by_employee_id,OLD.created_at) THEN
      RAISE EXCEPTION 'approval cannot change annual benefit policy facts';
    END IF;
  ELSIF TG_OP='UPDATE' AND OLD.status='approved' AND NEW.status='published' THEN
    IF ROW(NEW.policy_code,NEW.version,NEW.timezone,NEW.drafted_by_employee_id,
      NEW.approved_by_employee_id,NEW.approved_at,NEW.created_at)
      IS DISTINCT FROM ROW(OLD.policy_code,OLD.version,OLD.timezone,OLD.drafted_by_employee_id,
      OLD.approved_by_employee_id,OLD.approved_at,OLD.created_at) THEN
      RAISE EXCEPTION 'publication cannot change approved annual benefit policy facts';
    END IF;
  ELSIF TG_OP='UPDATE' AND OLD.status='published' AND NEW.status='published' THEN
    IF ROW(NEW.policy_code,NEW.version,NEW.timezone,NEW.effective_from,
      NEW.drafted_by_employee_id,NEW.approved_by_employee_id,NEW.approved_at,
      NEW.published_by_employee_id,NEW.published_at,NEW.created_at)
      IS DISTINCT FROM ROW(OLD.policy_code,OLD.version,OLD.timezone,OLD.effective_from,
      OLD.drafted_by_employee_id,OLD.approved_by_employee_id,OLD.approved_at,
      OLD.published_by_employee_id,OLD.published_at,OLD.created_at)
      OR NEW.effective_until IS NULL
      OR (OLD.effective_until IS NOT NULL AND NEW.effective_until>OLD.effective_until)
      OR NOT EXISTS (
        SELECT 1 FROM mbox.loyalty_annual_benefit_policy_versions replacement
        WHERE replacement.tenant_id=NEW.tenant_id AND replacement.store_id=NEW.store_id
          AND replacement.policy_code=NEW.policy_code AND replacement.status='published'
          AND replacement.id<>NEW.id AND replacement.effective_from=NEW.effective_until
      ) THEN RAISE EXCEPTION 'published annual benefit policies only allow an exact scheduled cut-over';
    END IF;
  ELSIF TG_OP='UPDATE' AND OLD.status IN ('approved','published','paused','retired') THEN
    IF NOT (OLD.status='published' AND NEW.status IN ('paused','retired')) THEN
      RAISE EXCEPTION 'released annual benefit policies are immutable';
    END IF;
  ELSIF TG_OP='UPDATE' AND OLD.status='draft' AND NEW.status<>'draft' THEN
    RAISE EXCEPTION 'invalid annual benefit policy transition';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION mbox.protect_loyalty_annual_benefit_rule()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_status text;
BEGIN
  SELECT status INTO parent_status FROM mbox.loyalty_annual_benefit_policy_versions
  WHERE tenant_id=COALESCE(NEW.tenant_id,OLD.tenant_id)
    AND store_id=COALESCE(NEW.store_id,OLD.store_id)
    AND id=COALESCE(NEW.policy_version_id,OLD.policy_version_id);
  IF parent_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'annual benefit rules are mutable only while their policy is draft';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;

CREATE OR REPLACE FUNCTION mbox.protect_annual_benefit_occurrence()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE rule_kind text; policy_status text;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'annual benefit occurrences are append-only'; END IF;
  SELECT rule.rule_kind,policy.status INTO rule_kind,policy_status
  FROM mbox.loyalty_annual_benefit_rules rule
  JOIN mbox.loyalty_annual_benefit_policy_versions policy
    ON policy.tenant_id=rule.tenant_id AND policy.store_id=rule.store_id
   AND policy.id=rule.policy_version_id
  WHERE rule.tenant_id=NEW.tenant_id AND rule.store_id=NEW.store_id AND rule.id=NEW.rule_id;
  IF rule_kind IS DISTINCT FROM 'festival' OR policy_status NOT IN ('approved','published') THEN
    RAISE EXCEPTION 'only approved or published festival rules accept confirmed occurrences';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION mbox.protect_customer_annual_benefit_consent()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND OLD.status='granted' AND NEW.status='withdrawn'
    AND ROW(NEW.tenant_id,NEW.store_id,NEW.customer_id,NEW.consent_type,NEW.source,NEW.consented_at,NEW.created_at)
      IS NOT DISTINCT FROM ROW(OLD.tenant_id,OLD.store_id,OLD.customer_id,OLD.consent_type,OLD.source,OLD.consented_at,OLD.created_at) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'annual benefit consent can only be withdrawn';
END $$;

CREATE TRIGGER loyalty_annual_benefit_policy_protect
  BEFORE UPDATE OR DELETE ON mbox.loyalty_annual_benefit_policy_versions
  FOR EACH ROW EXECUTE FUNCTION mbox.protect_loyalty_annual_benefit_policy();
CREATE TRIGGER loyalty_annual_benefit_policy_touch
  BEFORE UPDATE ON mbox.loyalty_annual_benefit_policy_versions
  FOR EACH ROW EXECUTE FUNCTION mbox.touch_updated_at();
CREATE TRIGGER loyalty_annual_benefit_rules_draft_only
  BEFORE INSERT OR UPDATE OR DELETE ON mbox.loyalty_annual_benefit_rules
  FOR EACH ROW EXECUTE FUNCTION mbox.protect_loyalty_annual_benefit_rule();
CREATE TRIGGER loyalty_annual_benefit_rules_touch
  BEFORE UPDATE ON mbox.loyalty_annual_benefit_rules
  FOR EACH ROW EXECUTE FUNCTION mbox.touch_updated_at();
CREATE TRIGGER loyalty_annual_benefit_occurrences_append_only
  BEFORE INSERT OR UPDATE OR DELETE ON mbox.loyalty_annual_benefit_occurrences
  FOR EACH ROW EXECUTE FUNCTION mbox.protect_annual_benefit_occurrence();
CREATE TRIGGER customer_annual_benefit_consents_protect
  BEFORE INSERT OR UPDATE OR DELETE ON mbox.customer_annual_benefit_consents
  FOR EACH ROW EXECUTE FUNCTION mbox.protect_customer_annual_benefit_consent();
CREATE TRIGGER customer_annual_benefit_consents_touch
  BEFORE UPDATE ON mbox.customer_annual_benefit_consents
  FOR EACH ROW EXECUTE FUNCTION mbox.touch_updated_at();
CREATE TRIGGER membership_annual_benefit_grants_touch
  BEFORE UPDATE ON mbox.membership_annual_benefit_grants
  FOR EACH ROW EXECUTE FUNCTION mbox.touch_updated_at();

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'loyalty_annual_benefit_policy_versions','loyalty_annual_benefit_rules',
    'loyalty_annual_benefit_occurrences','customer_annual_benefit_consents',
    'membership_annual_benefit_grants'
  ] LOOP
    EXECUTE format('ALTER TABLE mbox.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE mbox.%I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('CREATE POLICY tenant_store_isolation ON mbox.%I USING (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())',table_name);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE ON TABLE mbox.%I TO mbox_runtime',table_name);
  END LOOP;
END $$;

REVOKE DELETE ON TABLE mbox.loyalty_annual_benefit_policy_versions,
  mbox.loyalty_annual_benefit_rules,mbox.loyalty_annual_benefit_occurrences,
  mbox.customer_annual_benefit_consents,mbox.membership_annual_benefit_grants FROM mbox_runtime;

CREATE FUNCTION mbox.seed_store_loyalty_annual_benefit_permissions()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name,category,description,status)
  VALUES
    (NEW.tenant_id,NEW.id,'loyalty.annual-benefit.view','查看年度会员礼遇','loyalty','查看年度礼遇规则、节日确认与发放结果','active'),
    (NEW.tenant_id,NEW.id,'loyalty.annual-benefit.manage','起草年度会员礼遇','loyalty','起草生日、节日、优先订座和每日点心规则','active'),
    (NEW.tenant_id,NEW.id,'loyalty.annual-benefit.approve','审批年度会员礼遇','loyalty','独立审批年度礼遇政策','active'),
    (NEW.tenant_id,NEW.id,'loyalty.annual-benefit.publish','发布年度会员礼遇','loyalty','由第三名授权人员发布未来生效的年度礼遇','active'),
    (NEW.tenant_id,NEW.id,'loyalty.annual-benefit.occurrence.confirm','确认节日礼遇日期','loyalty','确认当年节日的实际日期和门店执行窗口','active')
  ON CONFLICT (tenant_id,store_id,code) DO UPDATE SET name=EXCLUDED.name,category=EXCLUDED.category,description=EXCLUDED.description,status='active';
  RETURN NEW;
END $$;

CREATE TRIGGER stores_seed_loyalty_annual_benefit_permissions
  AFTER INSERT ON mbox.stores FOR EACH ROW EXECUTE FUNCTION mbox.seed_store_loyalty_annual_benefit_permissions();

INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name,category,description,status)
SELECT store.tenant_id,store.id,permission.code,permission.name,'loyalty',permission.description,'active'
FROM mbox.stores store CROSS JOIN (VALUES
  ('loyalty.annual-benefit.view','查看年度会员礼遇','查看年度礼遇规则、节日确认与发放结果'),
  ('loyalty.annual-benefit.manage','起草年度会员礼遇','起草生日、节日、优先订座和每日点心规则'),
  ('loyalty.annual-benefit.approve','审批年度会员礼遇','独立审批年度礼遇政策'),
  ('loyalty.annual-benefit.publish','发布年度会员礼遇','由第三名授权人员发布未来生效的年度礼遇'),
  ('loyalty.annual-benefit.occurrence.confirm','确认节日礼遇日期','确认当年节日的实际日期和门店执行窗口')
) permission(code,name,description)
ON CONFLICT (tenant_id,store_id,code) DO UPDATE SET name=EXCLUDED.name,category=EXCLUDED.category,description=EXCLUDED.description,status='active';

INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id)
SELECT role.tenant_id,role.store_id,role.id,permission.id
FROM mbox.roles role JOIN mbox.staff_permission_definitions permission
  ON permission.tenant_id=role.tenant_id AND permission.store_id=role.store_id
WHERE role.status='active' AND (
  (role.code='MANAGER' AND permission.code IN ('loyalty.annual-benefit.view','loyalty.annual-benefit.manage','loyalty.annual-benefit.occurrence.confirm'))
  OR (role.code='OPS_LEAD' AND permission.code IN ('loyalty.annual-benefit.view','loyalty.annual-benefit.approve'))
  OR (role.code='OWNER' AND permission.code IN ('loyalty.annual-benefit.view','loyalty.annual-benefit.publish'))
) ON CONFLICT (tenant_id,store_id,role_id,permission_id) DO NOTHING;

CREATE FUNCTION mbox.seed_role_loyalty_annual_benefit_permissions()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id)
  SELECT NEW.tenant_id,NEW.store_id,NEW.id,permission.id
  FROM mbox.staff_permission_definitions permission
  WHERE permission.tenant_id=NEW.tenant_id AND permission.store_id=NEW.store_id AND (
    (NEW.code='MANAGER' AND permission.code IN ('loyalty.annual-benefit.view','loyalty.annual-benefit.manage','loyalty.annual-benefit.occurrence.confirm'))
    OR (NEW.code='OPS_LEAD' AND permission.code IN ('loyalty.annual-benefit.view','loyalty.annual-benefit.approve'))
    OR (NEW.code='OWNER' AND permission.code IN ('loyalty.annual-benefit.view','loyalty.annual-benefit.publish'))
  ) ON CONFLICT (tenant_id,store_id,role_id,permission_id) DO NOTHING;
  RETURN NEW;
END $$;

CREATE TRIGGER roles_seed_loyalty_annual_benefit_permissions
  AFTER INSERT ON mbox.roles FOR EACH ROW EXECUTE FUNCTION mbox.seed_role_loyalty_annual_benefit_permissions();

COMMENT ON TABLE mbox.loyalty_annual_benefit_policy_versions IS
  'Future-effective maker-checker policy for annual member benefits. A future calendar item is not a grant.';
COMMENT ON TABLE mbox.loyalty_annual_benefit_occurrences IS
  'Confirmed solar-date windows for festival rules; movable/lunar festivals are never silently calculated.';
COMMENT ON TABLE mbox.membership_annual_benefit_grants IS
  'Idempotent actual annual benefit grant after its use window opens; previews never create rows here.';

UPDATE mbox.normalized_schema_metadata
SET schema_version='109',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
