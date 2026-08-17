BEGIN;

-- Phone numbers are matching evidence, never display/search JSON.  The digest
-- is keyed by the application secret in runtime code; ciphertext is AES-GCM.
CREATE TABLE mbox.customer_verified_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  contact_type text NOT NULL CHECK (contact_type = 'phone'),
  contact_hash char(64) NOT NULL CHECK (contact_hash ~ '^[0-9a-f]{64}$'),
  encrypted_value bytea NOT NULL CHECK (octet_length(encrypted_value) >= 29),
  encryption_key_version integer NOT NULL CHECK (encryption_key_version > 0),
  masked_value text NOT NULL CHECK (length(masked_value) BETWEEN 7 AND 32),
  verification_source text NOT NULL
    CHECK (verification_source IN ('wechat_phone_authorization', 'staff_controlled')),
  provider_reference_sha256 char(64)
    CHECK (provider_reference_sha256 IS NULL OR provider_reference_sha256 ~ '^[0-9a-f]{64}$'),
  verified_by_customer_id uuid,
  verified_by_employee_id uuid,
  verified_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, customer_id)
    REFERENCES mbox.customers(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, verified_by_customer_id)
    REFERENCES mbox.customers(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, verified_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, customer_id, contact_type, contact_hash),
  UNIQUE (tenant_id, store_id, id),
  CHECK (
    (verification_source='wechat_phone_authorization'
      AND verified_by_customer_id=customer_id AND verified_by_employee_id IS NULL
      AND provider_reference_sha256 IS NOT NULL)
    OR
    (verification_source='staff_controlled'
      AND verified_by_customer_id IS NULL AND verified_by_employee_id IS NOT NULL)
  ),
  CHECK (revoked_at IS NULL OR revoked_at >= verified_at)
);

CREATE INDEX customer_verified_contacts_phone_lookup_idx
  ON mbox.customer_verified_contacts (tenant_id, store_id, contact_hash, verified_at DESC, id)
  WHERE contact_type='phone' AND revoked_at IS NULL;

CREATE TABLE mbox.membership_recovery_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  public_id text NOT NULL CHECK (public_id ~ '^MRC[0-9A-F]{32}$'),
  requester_customer_id uuid NOT NULL,
  verification_method text NOT NULL CHECK (verification_method='wechat_phone'),
  status text NOT NULL DEFAULT 'awaiting_verification' CHECK (status IN (
    'awaiting_verification','no_match','pending_review','manual_review',
    'completed','rejected','expired','cancelled'
  )),
  verified_contact_id uuid,
  candidate_count integer NOT NULL DEFAULT 0 CHECK (candidate_count >= 0),
  start_idempotency_key text NOT NULL CHECK (length(start_idempotency_key) BETWEEN 8 AND 128),
  verify_idempotency_key text CHECK (verify_idempotency_key IS NULL OR length(verify_idempotency_key) BETWEEN 8 AND 128),
  expires_at timestamptz NOT NULL,
  verified_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, requester_customer_id)
    REFERENCES mbox.customers(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, verified_contact_id)
    REFERENCES mbox.customer_verified_contacts(tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, public_id),
  UNIQUE (tenant_id, store_id, requester_customer_id, start_idempotency_key),
  UNIQUE (tenant_id, store_id, id),
  CHECK (expires_at > created_at),
  CHECK (
    (verified_contact_id IS NULL AND verified_at IS NULL AND candidate_count=0
      AND status IN ('awaiting_verification','expired','cancelled'))
    OR
    (verified_contact_id IS NOT NULL AND verified_at IS NOT NULL
      AND status<>'awaiting_verification')
  ),
  CHECK (completed_at IS NULL OR status IN ('completed','rejected','expired','cancelled'))
);

CREATE INDEX membership_recovery_challenges_requester_idx
  ON mbox.membership_recovery_challenges
    (tenant_id, store_id, requester_customer_id, created_at DESC, id);
CREATE INDEX membership_recovery_challenges_review_idx
  ON mbox.membership_recovery_challenges
    (tenant_id, store_id, status, created_at, id)
  WHERE status IN ('pending_review','manual_review');

CREATE TABLE mbox.membership_recovery_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  challenge_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  verification_method text NOT NULL CHECK (verification_method='wechat_phone'),
  provider_reference_sha256 char(64) NOT NULL CHECK (provider_reference_sha256 ~ '^[0-9a-f]{64}$'),
  verified_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id, challenge_id)
    REFERENCES mbox.membership_recovery_challenges(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, contact_id)
    REFERENCES mbox.customer_verified_contacts(tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, challenge_id),
  UNIQUE (tenant_id, store_id, provider_reference_sha256),
  UNIQUE (tenant_id, store_id, id)
);

CREATE TABLE mbox.membership_recovery_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  public_id text NOT NULL CHECK (public_id ~ '^MRD[0-9A-F]{32}$'),
  challenge_id uuid NOT NULL,
  candidate_customer_id uuid NOT NULL,
  candidate_membership_id uuid NOT NULL,
  matched_contact_id uuid NOT NULL,
  match_kind text NOT NULL CHECK (match_kind='verified_phone'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id, challenge_id)
    REFERENCES mbox.membership_recovery_challenges(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, candidate_customer_id)
    REFERENCES mbox.customers(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, candidate_membership_id)
    REFERENCES mbox.customer_memberships(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, matched_contact_id)
    REFERENCES mbox.customer_verified_contacts(tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, public_id),
  UNIQUE (tenant_id, store_id, challenge_id, candidate_membership_id),
  UNIQUE (tenant_id, store_id, id)
);

CREATE TABLE mbox.membership_merge_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  public_id text NOT NULL CHECK (public_id ~ '^MMC[0-9A-F]{32}$'),
  challenge_id uuid NOT NULL,
  target_customer_id uuid NOT NULL,
  selected_candidate_id uuid,
  source_customer_id uuid,
  source_membership_id uuid,
  status text NOT NULL CHECK (status IN ('manual_review','pending_review','approved','rejected','executed')),
  requested_by_customer_id uuid NOT NULL,
  selected_by_employee_id uuid,
  selected_reason text,
  approved_by_employee_id uuid,
  approval_reason text,
  approved_at timestamptz,
  executed_at timestamptz,
  rejected_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, challenge_id)
    REFERENCES mbox.membership_recovery_challenges(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, target_customer_id)
    REFERENCES mbox.customers(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, selected_candidate_id)
    REFERENCES mbox.membership_recovery_candidates(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, source_customer_id)
    REFERENCES mbox.customers(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, source_membership_id)
    REFERENCES mbox.customer_memberships(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, requested_by_customer_id)
    REFERENCES mbox.customers(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, selected_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, approved_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, public_id),
  UNIQUE (tenant_id, store_id, challenge_id),
  UNIQUE (tenant_id, store_id, id),
  CHECK (
    (selected_candidate_id IS NULL AND source_customer_id IS NULL AND source_membership_id IS NULL
      AND status='manual_review')
    OR
    (selected_candidate_id IS NOT NULL AND source_customer_id IS NOT NULL AND source_membership_id IS NOT NULL)
  ),
  CHECK (selected_reason IS NULL OR length(btrim(selected_reason)) BETWEEN 2 AND 500),
  CHECK (approval_reason IS NULL OR length(btrim(approval_reason)) BETWEEN 2 AND 500),
  CHECK (
    (approved_by_employee_id IS NULL AND approved_at IS NULL AND status IN ('manual_review','pending_review','rejected'))
    OR
    (approved_by_employee_id IS NOT NULL AND approved_at IS NOT NULL
      AND status IN ('approved','executed'))
  ),
  CHECK (selected_by_employee_id IS NULL OR selected_by_employee_id<>approved_by_employee_id),
  CHECK ((status='executed')=(executed_at IS NOT NULL)),
  CHECK ((status='rejected')=(rejected_at IS NOT NULL))
);

CREATE INDEX membership_merge_cases_review_idx
  ON mbox.membership_merge_cases (tenant_id, store_id, status, created_at, id)
  WHERE status IN ('manual_review','pending_review');

CREATE TABLE mbox.membership_merge_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  merge_case_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('requested','candidate_selected','approved','rejected','executed')),
  actor_type text NOT NULL CHECK (actor_type IN ('customer','employee','system')),
  actor_customer_id uuid,
  actor_employee_id uuid,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 2 AND 500),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id, merge_case_id)
    REFERENCES mbox.membership_merge_cases(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, actor_customer_id)
    REFERENCES mbox.customers(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, actor_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, merge_case_id, action, idempotency_key),
  UNIQUE (tenant_id, store_id, id),
  CHECK (
    (actor_type='customer' AND actor_customer_id IS NOT NULL AND actor_employee_id IS NULL)
    OR (actor_type='employee' AND actor_customer_id IS NULL AND actor_employee_id IS NOT NULL)
    OR (actor_type='system' AND actor_customer_id IS NULL AND actor_employee_id IS NULL)
  )
);

CREATE TRIGGER membership_recovery_verifications_append_only
  BEFORE UPDATE OR DELETE ON mbox.membership_recovery_verifications
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();
CREATE TRIGGER membership_recovery_candidates_append_only
  BEFORE UPDATE OR DELETE ON mbox.membership_recovery_candidates
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();
CREATE TRIGGER membership_merge_actions_append_only
  BEFORE UPDATE OR DELETE ON mbox.membership_merge_actions
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'customer_verified_contacts','membership_recovery_challenges',
    'membership_recovery_verifications','membership_recovery_candidates',
    'membership_merge_cases','membership_merge_actions'
  ] LOOP
    EXECUTE format('ALTER TABLE mbox.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE mbox.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_store_isolation ON mbox.%I USING (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())',
      table_name
    );
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON TABLE mbox.%I TO mbox_runtime', table_name);
  END LOOP;
END $$;

REVOKE UPDATE ON TABLE mbox.membership_recovery_verifications,
  mbox.membership_recovery_candidates, mbox.membership_merge_actions FROM mbox_runtime;
REVOKE DELETE ON TABLE mbox.customer_verified_contacts,
  mbox.membership_recovery_challenges, mbox.membership_recovery_verifications,
  mbox.membership_recovery_candidates, mbox.membership_merge_cases,
  mbox.membership_merge_actions FROM mbox_runtime;

INSERT INTO mbox.staff_permission_definitions (
  tenant_id, store_id, code, name, category, description, status
)
SELECT store.tenant_id, store.id, permission.code, permission.name,
  'customer_experience', permission.description, 'active'
FROM mbox.stores store
CROSS JOIN (VALUES
  ('customer.membership.recovery.verify','核验会员找回','人工核验历史会员联系方式并选择多候选账户'),
  ('customer.membership.merge.approve','复核会员合并','独立复核并执行会员账户合并')
) permission(code,name,description)
ON CONFLICT (tenant_id, store_id, code) DO UPDATE
SET name=EXCLUDED.name, category=EXCLUDED.category,
  description=EXCLUDED.description, status='active';

CREATE FUNCTION mbox.seed_store_membership_recovery_permissions()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO mbox.staff_permission_definitions (
    tenant_id, store_id, code, name, category, description, status
  ) VALUES
    (NEW.tenant_id,NEW.id,'customer.membership.recovery.verify','核验会员找回',
      'customer_experience','人工核验历史会员联系方式并选择多候选账户','active'),
    (NEW.tenant_id,NEW.id,'customer.membership.merge.approve','复核会员合并',
      'customer_experience','独立复核并执行会员账户合并','active')
  ON CONFLICT (tenant_id, store_id, code) DO UPDATE
  SET name=EXCLUDED.name, category=EXCLUDED.category,
    description=EXCLUDED.description, status='active';
  RETURN NEW;
END $$;

CREATE TRIGGER stores_seed_membership_recovery_permissions
  AFTER INSERT ON mbox.stores
  FOR EACH ROW EXECUTE FUNCTION mbox.seed_store_membership_recovery_permissions();

-- Safe defaults remain editable through the existing access configuration UI.
-- Verification and approval are separate permissions; the service also rejects
-- the same employee acting as verifier/selector and approver for one case.
INSERT INTO mbox.role_permission_assignments (
  tenant_id,store_id,role_id,permission_id
)
SELECT role.tenant_id,role.store_id,role.id,permission.id
FROM mbox.roles role
JOIN mbox.staff_permission_definitions permission
  ON permission.tenant_id=role.tenant_id AND permission.store_id=role.store_id
WHERE role.status='active' AND (
  (role.code IN ('OWNER','MANAGER')
    AND permission.code IN ('customer.membership.recovery.verify','customer.membership.merge.approve'))
  OR (role.code='DEPUT_MANAGER' AND permission.code='customer.membership.recovery.verify')
)
ON CONFLICT (tenant_id,store_id,role_id,permission_id) DO NOTHING;

CREATE FUNCTION mbox.seed_role_membership_recovery_permissions()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO mbox.role_permission_assignments (
    tenant_id,store_id,role_id,permission_id
  )
  SELECT NEW.tenant_id,NEW.store_id,NEW.id,permission.id
  FROM mbox.staff_permission_definitions permission
  WHERE permission.tenant_id=NEW.tenant_id AND permission.store_id=NEW.store_id
    AND (
      (NEW.code IN ('OWNER','MANAGER')
        AND permission.code IN ('customer.membership.recovery.verify','customer.membership.merge.approve'))
      OR (NEW.code='DEPUT_MANAGER' AND permission.code='customer.membership.recovery.verify')
    )
  ON CONFLICT (tenant_id,store_id,role_id,permission_id) DO NOTHING;
  RETURN NEW;
END $$;

CREATE TRIGGER roles_seed_membership_recovery_permissions
  AFTER INSERT ON mbox.roles
  FOR EACH ROW EXECUTE FUNCTION mbox.seed_role_membership_recovery_permissions();

COMMENT ON TABLE mbox.membership_recovery_challenges IS
  'Customer-bound recovery challenges. Public responses expose only workflow state, never candidate account facts.';
COMMENT ON TABLE mbox.membership_merge_cases IS
  'Maker-checker membership merge facts. Source customers remain as merged records so orders, lots, ledgers, benefits and history remain attributable.';
COMMENT ON COLUMN mbox.customer_verified_contacts.contact_hash IS
  'Keyed deterministic digest used only for exact candidate matching; never a plain SHA-256 of a phone number.';

UPDATE mbox.normalized_schema_metadata
SET schema_version='079', updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
