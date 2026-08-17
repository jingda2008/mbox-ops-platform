BEGIN;

-- Hold writers until the expand schema, backfill and compatibility triggers
-- become visible together.  Pending old instances resume after COMMIT and are
-- mirrored into the strong tables, so no registration can fall into a gap.
LOCK TABLE mbox.community_activity_registrations IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE mbox.customer_verified_contacts IN SHARE ROW EXCLUSIVE MODE;

-- pgcrypto may have been installed into public or mbox depending on the
-- operator's pre-migration search_path.  Resolve that trusted extension schema
-- once and create a fixed mbox wrapper; SECURITY DEFINER functions never add a
-- writable schema to their search_path and never guess the extension location.
DO $$
DECLARE extension_schema text;
DECLARE function_body text;
BEGIN
  SELECT namespace.nspname INTO extension_schema
  FROM pg_extension extension
  JOIN pg_namespace namespace ON namespace.oid=extension.extnamespace
  WHERE extension.extname='pgcrypto';
  IF extension_schema IS NULL THEN
    RAISE EXCEPTION 'pgcrypto extension is unavailable';
  END IF;
  function_body:=format('SELECT encode(%I.digest(input_value,%L),%L)',
    extension_schema,'sha256','hex');
  EXECUTE format(
    'CREATE FUNCTION mbox.personal_contact_sha256(input_value text) RETURNS char(64) LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog AS %L',
    function_body
  );
END $$;
REVOKE ALL ON FUNCTION mbox.personal_contact_sha256(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mbox.personal_contact_sha256(text) TO mbox_runtime;

CREATE FUNCTION mbox.employee_has_effective_permission(
  tenant_id_value uuid,
  store_id_value uuid,
  employee_id_value uuid,
  permission_code_value text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog,mbox
AS $$
  SELECT EXISTS (
    SELECT 1 FROM mbox.employees employee
    JOIN mbox.staff_permission_definitions permission
      ON permission.tenant_id=employee.tenant_id AND permission.store_id=employee.store_id
     AND permission.code=permission_code_value AND permission.status='active'
    WHERE tenant_id_value=NULLIF(current_setting('app.tenant_id',true),'')::uuid
      AND store_id_value=NULLIF(current_setting('app.store_id',true),'')::uuid
      AND employee.tenant_id=tenant_id_value AND employee.store_id=store_id_value
      AND employee.id=employee_id_value AND employee.status='active'
      AND NOT EXISTS (
        SELECT 1 FROM mbox.employee_permission_overrides denied
        WHERE denied.tenant_id=tenant_id_value AND denied.store_id=store_id_value
          AND denied.employee_id=employee_id_value AND denied.permission_id=permission.id
          AND denied.effect='deny' AND denied.starts_at<=clock_timestamp()
          AND (denied.ends_at IS NULL OR denied.ends_at>clock_timestamp())
      ) AND (
        EXISTS (
          SELECT 1 FROM mbox.employee_permission_overrides granted
          WHERE granted.tenant_id=tenant_id_value AND granted.store_id=store_id_value
            AND granted.employee_id=employee_id_value AND granted.permission_id=permission.id
            AND granted.effect='grant' AND granted.starts_at<=clock_timestamp()
            AND (granted.ends_at IS NULL OR granted.ends_at>clock_timestamp())
        ) OR EXISTS (
          SELECT 1 FROM mbox.employee_roles employee_role
          JOIN mbox.roles role ON role.tenant_id=employee_role.tenant_id
            AND role.store_id=employee_role.store_id AND role.id=employee_role.role_id
            AND role.status='active'
          JOIN mbox.role_permission_assignments assignment
            ON assignment.tenant_id=employee_role.tenant_id
           AND assignment.store_id=employee_role.store_id
           AND assignment.role_id=employee_role.role_id
           AND assignment.permission_id=permission.id
          WHERE employee_role.tenant_id=tenant_id_value
            AND employee_role.store_id=store_id_value
            AND employee_role.employee_id=employee_id_value
            AND employee_role.starts_at<=clock_timestamp()
            AND (employee_role.ends_at IS NULL OR employee_role.ends_at>clock_timestamp())
        )
      )
  )
$$;

REVOKE ALL ON FUNCTION mbox.employee_has_effective_permission(uuid,uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mbox.employee_has_effective_permission(uuid,uuid,uuid,text) TO mbox_runtime;

-- Retention periods are approved store policy, never an application constant or
-- an inference from a JSON snapshot.  No policy is seeded: disposal therefore
-- fails closed until three different authorized employees publish one.
CREATE TABLE mbox.personal_contact_retention_policy_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  public_id text NOT NULL CHECK (public_id ~ '^PCR[0-9A-F]{32}$'),
  resource_kind text NOT NULL CHECK (resource_kind IN (
    'activity_registration_contact','verified_membership_phone'
  )),
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL CHECK (status IN ('draft','approved','published','retired')),
  retention_days_after_purpose_end integer NOT NULL
    CHECK (retention_days_after_purpose_end BETWEEN 0 AND 36500),
  legal_basis_reference text NOT NULL CHECK (length(btrim(legal_basis_reference)) BETWEEN 3 AND 240),
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
  FOREIGN KEY (tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
  FOREIGN KEY (tenant_id,store_id,drafted_by_employee_id)
    REFERENCES mbox.employees(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,approved_by_employee_id)
    REFERENCES mbox.employees(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,published_by_employee_id)
    REFERENCES mbox.employees(tenant_id,store_id,id),
  UNIQUE (tenant_id,store_id,public_id),
  UNIQUE (tenant_id,store_id,resource_kind,version),
  UNIQUE (tenant_id,store_id,id),
  CHECK (effective_until IS NULL OR effective_until > effective_from),
  CHECK (
    (status='draft' AND approved_by_employee_id IS NULL AND approval_reason IS NULL
      AND approved_at IS NULL AND published_by_employee_id IS NULL
      AND publication_reason IS NULL AND published_at IS NULL
      AND effective_from IS NULL AND effective_until IS NULL)
    OR
    (status='approved' AND approved_by_employee_id IS NOT NULL
      AND approved_by_employee_id<>drafted_by_employee_id
      AND length(btrim(approval_reason)) BETWEEN 2 AND 500 AND approved_at IS NOT NULL
      AND published_by_employee_id IS NULL AND publication_reason IS NULL
      AND published_at IS NULL AND effective_from IS NULL AND effective_until IS NULL)
    OR
    (status IN ('published','retired') AND approved_by_employee_id IS NOT NULL
      AND approved_by_employee_id<>drafted_by_employee_id
      AND length(btrim(approval_reason)) BETWEEN 2 AND 500 AND approved_at IS NOT NULL
      AND published_by_employee_id IS NOT NULL
      AND published_by_employee_id<>drafted_by_employee_id
      AND published_by_employee_id<>approved_by_employee_id
      AND length(btrim(publication_reason)) BETWEEN 2 AND 500
      AND published_at IS NOT NULL AND effective_from IS NOT NULL)
  )
);

ALTER TABLE mbox.personal_contact_retention_policy_versions
  ADD CONSTRAINT personal_contact_retention_policy_no_published_overlap_excl
  EXCLUDE USING gist (
    tenant_id WITH =,
    store_id WITH =,
    resource_kind WITH =,
    tstzrange(effective_from,COALESCE(effective_until,'infinity'::timestamptz),'[)') WITH &&
  ) WHERE (status='published');

-- 055 only constrained the shape.  Decode safety and the legacy v1 envelope
-- are checked before any column is written; bad history aborts the migration.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM mbox.community_activity_registrations registration
    WHERE jsonb_typeof(registration.contact_snapshot)<>'object'
      OR NOT registration.contact_snapshot ?& ARRAY[
        'contactType','contactHash','encryptedContact',
        'encryptionKeyId','maskedContact','source'
      ]
      OR registration.contact_snapshot - ARRAY[
        'contactType','contactHash','encryptedContact',
        'encryptionKeyId','maskedContact','source'
      ] <> '{}'::jsonb
      OR EXISTS (
        SELECT 1 FROM jsonb_each(registration.contact_snapshot) entry
        WHERE jsonb_typeof(entry.value)<>'string' OR length(btrim(entry.value#>>'{}'))=0
      )
      OR registration.contact_snapshot->>'contactType' NOT IN ('phone','wechat','other')
      OR registration.contact_snapshot->>'contactHash' !~ '^[0-9a-f]{64}$'
      OR registration.contact_snapshot->>'encryptionKeyId' <> 'normalized-contact-v1'
      OR length(btrim(registration.contact_snapshot->>'maskedContact')) NOT BETWEEN 3 AND 64
      OR position('*' IN registration.contact_snapshot->>'maskedContact')=0
      OR registration.contact_snapshot->>'source' <> 'mini_program'
      OR length(registration.contact_snapshot->>'encryptedContact') % 4 <> 0
      OR registration.contact_snapshot->>'encryptedContact'
        !~ '^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$'
  ) THEN
    RAISE EXCEPTION 'pre-095 activity contact JSON is malformed; reconcile before migration';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM mbox.community_activity_registrations registration
    WHERE octet_length(decode(registration.contact_snapshot->>'encryptedContact','base64')) < 32
      OR octet_length(decode(registration.contact_snapshot->>'encryptedContact','base64')) > 3072
      OR get_byte(decode(registration.contact_snapshot->>'encryptedContact','base64'),0) <> 1
  ) THEN
    RAISE EXCEPTION 'pre-095 activity contact ciphertext is not a supported v1 envelope; reconcile before migration';
  END IF;
END $$;

CREATE TABLE mbox.community_activity_registration_contact_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  public_id text NOT NULL CHECK (public_id ~ '^ACV[0-9A-F]{32}$'),
  registration_id uuid NOT NULL,
  registration_cycle integer NOT NULL CHECK (registration_cycle > 0),
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL CHECK (status IN ('active','inactive','disposed')),
  supersedes_contact_version_id uuid,
  contact_type text CHECK (contact_type IN ('phone','wechat','other')),
  contact_hash char(64) CHECK (contact_hash IS NULL OR contact_hash ~ '^[0-9a-f]{64}$'),
  encrypted_contact bytea,
  encryption_key_id text,
  masked_contact text,
  contact_source text CHECK (contact_source IS NULL OR contact_source='mini_program'),
  created_by_customer_id uuid,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  request_sha256 char(64) NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  inactivated_at timestamptz,
  disposed_at timestamptz,
  disposition_policy_version_id uuid,
  FOREIGN KEY (tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
  FOREIGN KEY (tenant_id,store_id,registration_id)
    REFERENCES mbox.community_activity_registrations(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,created_by_customer_id)
    REFERENCES mbox.customers(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,supersedes_contact_version_id)
    REFERENCES mbox.community_activity_registration_contact_versions(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,disposition_policy_version_id)
    REFERENCES mbox.personal_contact_retention_policy_versions(tenant_id,store_id,id),
  UNIQUE (tenant_id,store_id,public_id),
  UNIQUE (tenant_id,store_id,registration_id,registration_cycle,version),
  UNIQUE (tenant_id,store_id,registration_id,registration_cycle,idempotency_key),
  UNIQUE (tenant_id,store_id,id),
  CHECK (supersedes_contact_version_id IS NULL OR supersedes_contact_version_id<>id),
  CHECK (
    (status IN ('active','inactive') AND contact_type IS NOT NULL AND contact_hash IS NOT NULL
      AND encrypted_contact IS NOT NULL AND octet_length(encrypted_contact) BETWEEN 32 AND 3072
      AND get_byte(encrypted_contact,0)=1
      AND encryption_key_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{2,127}$'
      AND length(btrim(masked_contact)) BETWEEN 3 AND 64
      AND position('*' IN masked_contact)>0 AND contact_source IS NOT NULL
      AND disposed_at IS NULL AND disposition_policy_version_id IS NULL)
    OR
    (status='disposed' AND contact_type IS NULL AND contact_hash IS NULL
      AND encrypted_contact IS NULL AND encryption_key_id IS NULL
      AND masked_contact IS NULL AND contact_source IS NULL
      AND disposed_at IS NOT NULL AND disposition_policy_version_id IS NOT NULL)
  ),
  CHECK ((status='active' AND inactivated_at IS NULL)
    OR (status IN ('inactive','disposed') AND inactivated_at IS NOT NULL)),
  CHECK (contact_type<>'phone' OR masked_contact ~ '^1[0-9]{2}\*{4}[0-9]{4}$'),
  CHECK (inactivated_at IS NULL OR inactivated_at >= captured_at),
  CHECK (disposed_at IS NULL OR disposed_at >= inactivated_at)
);

CREATE UNIQUE INDEX community_activity_registration_contact_active_idx
  ON mbox.community_activity_registration_contact_versions(
    tenant_id,store_id,registration_id,registration_cycle
  ) WHERE status='active';
CREATE UNIQUE INDEX community_activity_registration_one_active_contact_idx
  ON mbox.community_activity_registration_contact_versions(tenant_id,store_id,registration_id)
  WHERE status='active';
CREATE UNIQUE INDEX community_activity_registration_contact_no_fork_idx
  ON mbox.community_activity_registration_contact_versions(tenant_id,store_id,supersedes_contact_version_id)
  WHERE supersedes_contact_version_id IS NOT NULL;

INSERT INTO mbox.community_activity_registration_contact_versions(
  tenant_id,store_id,public_id,registration_id,registration_cycle,version,status,
  contact_type,contact_hash,encrypted_contact,encryption_key_id,masked_contact,
  contact_source,created_by_customer_id,idempotency_key,request_sha256,captured_at,
  inactivated_at
)
SELECT registration.tenant_id,registration.store_id,
  'ACV'||upper(replace(gen_random_uuid()::text,'-','')),
  registration.id,registration.registration_cycle,1,
  CASE WHEN registration.status IN ('cancelled','no_show','refunded')
      OR registration.payment_status='expired'
      OR activity.status IN ('cancelled','completed') OR activity.ends_at<=clock_timestamp()
    THEN 'inactive' ELSE 'active' END,
  registration.contact_snapshot->>'contactType',registration.contact_snapshot->>'contactHash',
  decode(registration.contact_snapshot->>'encryptedContact','base64'),
  registration.contact_snapshot->>'encryptionKeyId',registration.contact_snapshot->>'maskedContact',
  registration.contact_snapshot->>'source',registration.customer_id,registration.idempotency_key,
  mbox.personal_contact_sha256(concat_ws('|',registration.contact_snapshot->>'contactType',
    registration.contact_snapshot->>'contactHash',registration.contact_snapshot->>'source')),
  registration.registered_at,
  CASE
    WHEN registration.status IN ('cancelled','refunded')
      THEN GREATEST(registration.registered_at,COALESCE(registration.cancelled_at,registration.updated_at))
    WHEN registration.status='no_show'
      THEN GREATEST(registration.registered_at,activity.ends_at)
    WHEN registration.payment_status='expired'
      THEN GREATEST(registration.registered_at,
        COALESCE(registration.seat_hold_expires_at,registration.payment_due_at,registration.updated_at))
    WHEN activity.status='cancelled'
      THEN GREATEST(registration.registered_at,activity.updated_at)
    WHEN activity.status='completed' OR activity.ends_at<=clock_timestamp()
      THEN GREATEST(registration.registered_at,activity.ends_at)
    ELSE NULL
  END
FROM mbox.community_activity_registrations registration
JOIN mbox.community_activities activity
  ON activity.tenant_id=registration.tenant_id AND activity.store_id=registration.store_id
 AND activity.id=registration.activity_id;

ALTER TABLE mbox.community_activity_registrations
  DROP CONSTRAINT community_activity_registrations_contact_protected_ck,
  ALTER COLUMN contact_snapshot DROP NOT NULL;

COMMENT ON COLUMN mbox.community_activity_registrations.contact_snapshot IS
  '095 expand-only rolling compatibility. New runtime projects the fixed six-key envelope for old readers but never uses it as runtime authority; contract removal waits for old instances and rollback windows to exit.';

DO $$
BEGIN
  IF EXISTS (
    WITH RECURSIVE active_contact_lineage AS (
      SELECT contact.tenant_id,contact.store_id,contact.id AS contact_id,
        contact.contact_type,customer.id AS customer_id,customer.merged_into_customer_id
      FROM mbox.customer_verified_contacts contact
      JOIN mbox.customers customer
        ON customer.tenant_id=contact.tenant_id AND customer.store_id=contact.store_id
       AND customer.id=contact.customer_id
      WHERE contact.revoked_at IS NULL
      UNION ALL
      SELECT lineage.tenant_id,lineage.store_id,lineage.contact_id,lineage.contact_type,
        parent.id,parent.merged_into_customer_id
      FROM active_contact_lineage lineage
      JOIN mbox.customers parent
        ON parent.tenant_id=lineage.tenant_id AND parent.store_id=lineage.store_id
       AND parent.id=lineage.merged_into_customer_id
    )
    SELECT 1 FROM active_contact_lineage
    WHERE merged_into_customer_id IS NULL
    GROUP BY tenant_id,store_id,customer_id,contact_type
    HAVING count(DISTINCT contact_id)>1
  ) THEN
    RAISE EXCEPTION 'pre-095 canonical customer family has multiple active verified contacts; reconcile before migration';
  END IF;
END $$;

ALTER TABLE mbox.customer_verified_contacts
  ADD COLUMN public_id text,
  ADD COLUMN processing_status text,
  ADD COLUMN supersedes_contact_id uuid,
  ADD COLUMN revoked_by_customer_id uuid,
  ADD COLUMN revoked_by_employee_id uuid,
  ADD COLUMN revocation_reason_code text,
  ADD COLUMN contact_encryption_key_id text,
  ADD COLUMN disposed_at timestamptz,
  ADD COLUMN disposition_policy_version_id uuid;

UPDATE mbox.customer_verified_contacts
SET public_id='CVC'||upper(replace(id::text,'-','')),
  processing_status=CASE WHEN revoked_at IS NULL THEN 'active' ELSE 'revoked' END,
  contact_encryption_key_id='normalized-phone-v1',
  revocation_reason_code=CASE WHEN revoked_at IS NULL THEN NULL ELSE 'legacy_revoked' END;

ALTER TABLE mbox.customer_verified_contacts
  ALTER COLUMN public_id SET DEFAULT ('CVC'||upper(replace(gen_random_uuid()::text,'-',''))),
  ALTER COLUMN public_id SET NOT NULL,
  ALTER COLUMN processing_status SET DEFAULT 'active',
  ALTER COLUMN processing_status SET NOT NULL,
  ALTER COLUMN contact_encryption_key_id SET DEFAULT 'normalized-phone-v1',
  ALTER COLUMN contact_hash DROP NOT NULL,
  ALTER COLUMN encrypted_value DROP NOT NULL,
  ALTER COLUMN encryption_key_version DROP NOT NULL,
  ALTER COLUMN masked_value DROP NOT NULL,
  ADD CONSTRAINT customer_verified_contacts_public_id_ck
    CHECK (public_id ~ '^CVC[0-9A-F]{32}$'),
  ADD CONSTRAINT customer_verified_contacts_processing_status_ck
    CHECK (processing_status IN ('active','revoked','disposed')),
  ADD CONSTRAINT customer_verified_contacts_supersedes_fk
    FOREIGN KEY (tenant_id,store_id,supersedes_contact_id)
    REFERENCES mbox.customer_verified_contacts(tenant_id,store_id,id),
  ADD CONSTRAINT customer_verified_contacts_revoked_by_customer_fk
    FOREIGN KEY (tenant_id,store_id,revoked_by_customer_id)
    REFERENCES mbox.customers(tenant_id,store_id,id),
  ADD CONSTRAINT customer_verified_contacts_revoked_by_employee_fk
    FOREIGN KEY (tenant_id,store_id,revoked_by_employee_id)
    REFERENCES mbox.employees(tenant_id,store_id,id),
  ADD CONSTRAINT customer_verified_contacts_disposition_policy_fk
    FOREIGN KEY (tenant_id,store_id,disposition_policy_version_id)
    REFERENCES mbox.personal_contact_retention_policy_versions(tenant_id,store_id,id),
  ADD CONSTRAINT customer_verified_contacts_lifecycle_ck CHECK (
    (processing_status='active' AND revoked_at IS NULL AND revocation_reason_code IS NULL
      AND disposed_at IS NULL AND disposition_policy_version_id IS NULL
      AND contact_hash IS NOT NULL AND encrypted_value IS NOT NULL
      AND encryption_key_version IS NOT NULL AND contact_encryption_key_id IS NOT NULL
      AND masked_value IS NOT NULL)
    OR
    (processing_status='revoked' AND revoked_at IS NOT NULL
      AND length(btrim(revocation_reason_code)) BETWEEN 2 AND 64
      AND disposed_at IS NULL AND disposition_policy_version_id IS NULL
      AND contact_hash IS NOT NULL AND encrypted_value IS NOT NULL
      AND encryption_key_version IS NOT NULL AND contact_encryption_key_id IS NOT NULL
      AND masked_value IS NOT NULL)
    OR
    (processing_status='disposed' AND revoked_at IS NOT NULL
      AND length(btrim(revocation_reason_code)) BETWEEN 2 AND 64
      AND disposed_at IS NOT NULL AND disposition_policy_version_id IS NOT NULL
      AND contact_hash IS NULL AND encrypted_value IS NULL
      AND encryption_key_version IS NULL AND contact_encryption_key_id IS NULL
      AND masked_value IS NULL)
  ),
  ADD CONSTRAINT customer_verified_contacts_revocation_actor_ck CHECK (
    (revoked_at IS NULL AND revoked_by_customer_id IS NULL AND revoked_by_employee_id IS NULL)
    OR
    (revoked_at IS NOT NULL AND NOT (
      revoked_by_customer_id IS NOT NULL AND revoked_by_employee_id IS NOT NULL
    ))
  ),
  ADD CONSTRAINT customer_verified_contacts_disposed_time_ck
    CHECK (disposed_at IS NULL OR disposed_at>=revoked_at),
  ADD CONSTRAINT customer_verified_contacts_public_unique
    UNIQUE (tenant_id,store_id,public_id);

CREATE UNIQUE INDEX customer_verified_contacts_one_active_idx
  ON mbox.customer_verified_contacts(tenant_id,store_id,customer_id,contact_type)
  WHERE processing_status='active';
CREATE UNIQUE INDEX customer_verified_contacts_no_fork_idx
  ON mbox.customer_verified_contacts(tenant_id,store_id,supersedes_contact_id)
  WHERE supersedes_contact_id IS NOT NULL;

-- The 079 index is intentionally retained for rolling compatibility, but a
-- raw customer id is not the business identity after an account merge.  Lock
-- the canonical root and reject a second active phone anywhere in its family.
CREATE FUNCTION mbox.protect_verified_contact_family_active()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE canonical_customer_id uuid;
DECLARE conflicting_contact_id uuid;
DECLARE conflicting_customer_id uuid;
DECLARE conflicting_contact_hash char(64);
BEGIN
  IF NEW.processing_status<>'active' THEN RETURN NEW; END IF;
  WITH RECURSIVE ancestry AS (
    SELECT customer.id,customer.merged_into_customer_id
    FROM mbox.customers customer
    WHERE customer.tenant_id=NEW.tenant_id AND customer.store_id=NEW.store_id
      AND customer.id=NEW.customer_id
    UNION ALL
    SELECT parent.id,parent.merged_into_customer_id
    FROM mbox.customers parent JOIN ancestry child
      ON parent.id=child.merged_into_customer_id
    WHERE parent.tenant_id=NEW.tenant_id AND parent.store_id=NEW.store_id
  )
  SELECT id INTO canonical_customer_id FROM ancestry
  WHERE merged_into_customer_id IS NULL LIMIT 1;
  IF canonical_customer_id IS NULL THEN
    RAISE EXCEPTION 'verified contact canonical customer is unavailable' USING ERRCODE='23514';
  END IF;
  PERFORM 1 FROM mbox.customers customer
  WHERE customer.tenant_id=NEW.tenant_id AND customer.store_id=NEW.store_id
    AND customer.id=canonical_customer_id FOR UPDATE;
  WITH RECURSIVE family AS (
    SELECT canonical_customer_id AS id
    UNION ALL
    SELECT child.id FROM mbox.customers child JOIN family parent
      ON child.merged_into_customer_id=parent.id
    WHERE child.tenant_id=NEW.tenant_id AND child.store_id=NEW.store_id
  )
  SELECT contact.id,contact.customer_id,contact.contact_hash
    INTO conflicting_contact_id,conflicting_customer_id,conflicting_contact_hash
  FROM mbox.customer_verified_contacts contact
  WHERE contact.tenant_id=NEW.tenant_id AND contact.store_id=NEW.store_id
    AND contact.customer_id IN (SELECT id FROM family)
    AND contact.contact_type=NEW.contact_type AND contact.processing_status='active'
    AND contact.id<>NEW.id
  ORDER BY contact.id LIMIT 1 FOR UPDATE;
  IF conflicting_contact_id IS NOT NULL AND NOT (
    -- A 079 rolling instance may replay the exact same value through its old
    -- ON CONFLICT statement.  The retained raw-value unique constraint turns
    -- this into an update of the same row, so it cannot create a second active
    -- version.  A sibling/merged customer never receives this exception.
    conflicting_customer_id=NEW.customer_id
    AND conflicting_contact_hash=NEW.contact_hash
  ) THEN
    RAISE EXCEPTION 'canonical customer family already has an active verified contact' USING ERRCODE='23505';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER y_customer_verified_contacts_family_active
  BEFORE INSERT OR UPDATE OF processing_status ON mbox.customer_verified_contacts
  FOR EACH ROW EXECUTE FUNCTION mbox.protect_verified_contact_family_active();

-- A generic customer merge must not silently create two active phones.  The
-- membership recovery approval path reconciles contacts first in the same
-- transaction; every other merge fails closed here.
CREATE FUNCTION mbox.protect_customer_merge_verified_contact_family()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE active_count integer;
BEGIN
  IF NEW.merged_into_customer_id IS NULL
    OR NEW.merged_into_customer_id IS NOT DISTINCT FROM OLD.merged_into_customer_id THEN
    RETURN NEW;
  END IF;
  PERFORM 1 FROM mbox.customers target
  WHERE target.tenant_id=NEW.tenant_id AND target.store_id=NEW.store_id
    AND target.id=NEW.merged_into_customer_id FOR UPDATE;
  WITH RECURSIVE source_family AS (
    SELECT NEW.id AS id
    UNION ALL
    SELECT child.id FROM mbox.customers child JOIN source_family parent
      ON child.merged_into_customer_id=parent.id
    WHERE child.tenant_id=NEW.tenant_id AND child.store_id=NEW.store_id
  ), target_ancestry AS (
    SELECT target.id,target.merged_into_customer_id FROM mbox.customers target
    WHERE target.tenant_id=NEW.tenant_id AND target.store_id=NEW.store_id
      AND target.id=NEW.merged_into_customer_id
    UNION ALL
    SELECT parent.id,parent.merged_into_customer_id
    FROM mbox.customers parent JOIN target_ancestry child
      ON parent.id=child.merged_into_customer_id
    WHERE parent.tenant_id=NEW.tenant_id AND parent.store_id=NEW.store_id
  ), target_root AS (
    SELECT id FROM target_ancestry WHERE merged_into_customer_id IS NULL LIMIT 1
  ), target_family AS (
    SELECT id FROM target_root
    UNION ALL
    SELECT child.id FROM mbox.customers child JOIN target_family parent
      ON child.merged_into_customer_id=parent.id
    WHERE child.tenant_id=NEW.tenant_id AND child.store_id=NEW.store_id
  )
  SELECT count(*) INTO active_count
  FROM mbox.customer_verified_contacts contact
  WHERE contact.tenant_id=NEW.tenant_id AND contact.store_id=NEW.store_id
    AND contact.contact_type='phone' AND contact.processing_status='active'
    AND contact.customer_id IN (
      SELECT id FROM source_family UNION SELECT id FROM target_family
    );
  IF active_count>1 THEN
    RAISE EXCEPTION 'customer merge would create multiple active verified phones in one family' USING ERRCODE='23505';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER customers_verified_contact_family_guard
  BEFORE UPDATE OF merged_into_customer_id ON mbox.customers
  FOR EACH ROW EXECUTE FUNCTION mbox.protect_customer_merge_verified_contact_family();

CREATE TABLE mbox.customer_verified_contact_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('verified','superseded','revoked','disposed')),
  actor_type text NOT NULL CHECK (actor_type IN ('customer','employee','system')),
  actor_customer_id uuid,
  actor_employee_id uuid,
  reason_code text NOT NULL CHECK (length(btrim(reason_code)) BETWEEN 2 AND 64),
  reason_detail text CHECK (reason_detail IS NULL OR length(btrim(reason_detail)) BETWEEN 2 AND 500),
  authorization_source text CHECK (authorization_source IS NULL OR authorization_source IN (
    'wechat_phone_authorization','staff_controlled'
  )),
  authorization_reference_sha256 char(64)
    CHECK (authorization_reference_sha256 IS NULL OR authorization_reference_sha256 ~ '^[0-9a-f]{64}$'),
  authorized_at timestamptz,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  request_sha256 char(64) NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,store_id,contact_id)
    REFERENCES mbox.customer_verified_contacts(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,actor_customer_id)
    REFERENCES mbox.customers(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,actor_employee_id)
    REFERENCES mbox.employees(tenant_id,store_id,id),
  UNIQUE (tenant_id,store_id,contact_id,action,idempotency_key),
  UNIQUE (tenant_id,store_id,id),
  CHECK (
    (actor_type='customer' AND actor_customer_id IS NOT NULL AND actor_employee_id IS NULL)
    OR (actor_type='employee' AND actor_customer_id IS NULL AND actor_employee_id IS NOT NULL)
    OR (actor_type='system' AND actor_customer_id IS NULL AND actor_employee_id IS NULL)
  ),
  CHECK (
    (action='verified' AND authorization_source IS NOT NULL
      AND authorization_reference_sha256 IS NOT NULL AND authorized_at IS NOT NULL)
    OR (action<>'verified' AND authorization_source IS NULL
      AND authorization_reference_sha256 IS NULL AND authorized_at IS NULL)
  )
);

CREATE UNIQUE INDEX customer_verified_contact_actions_authorization_reference_uq
  ON mbox.customer_verified_contact_actions(tenant_id,store_id,authorization_reference_sha256)
  WHERE authorization_reference_sha256 IS NOT NULL;

CREATE FUNCTION mbox.append_customer_verified_contact_action(
  contact_id_value uuid,
  action_value text,
  actor_customer_id_value uuid,
  actor_employee_id_value uuid,
  reason_code_value text,
  reason_detail_value text,
  authorization_source_value text,
  authorization_reference_sha256_value char(64),
  authorized_at_value timestamptz,
  idempotency_key_value text,
  request_sha256_value char(64)
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,mbox
AS $$
DECLARE tenant_value uuid;
DECLARE store_value uuid;
DECLARE contact_customer_id uuid;
DECLARE contact_status text;
DECLARE contact_verification_source text;
DECLARE contact_provider_reference_sha256 char(64);
DECLARE contact_verified_at timestamptz;
DECLARE contact_verified_by_customer_id uuid;
DECLARE contact_verified_by_employee_id uuid;
DECLARE existing_request_sha256 char(64);
DECLARE actor_type_value text;
BEGIN
  tenant_value:=NULLIF(current_setting('app.tenant_id',true),'')::uuid;
  store_value:=NULLIF(current_setting('app.store_id',true),'')::uuid;
  actor_type_value:=CASE WHEN actor_customer_id_value IS NOT NULL THEN 'customer'
    WHEN actor_employee_id_value IS NOT NULL THEN 'employee' ELSE 'system' END;
  IF tenant_value IS NULL OR store_value IS NULL
    OR action_value NOT IN ('verified','superseded','revoked')
    OR ((actor_customer_id_value IS NULL)=(actor_employee_id_value IS NULL))
    OR length(btrim(reason_code_value)) NOT BETWEEN 2 AND 64
    OR (reason_detail_value IS NOT NULL AND length(btrim(reason_detail_value)) NOT BETWEEN 2 AND 500)
    OR length(idempotency_key_value) NOT BETWEEN 8 AND 128
    OR request_sha256_value !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'verified contact action request is invalid' USING ERRCODE='22023';
  END IF;
  SELECT contact.customer_id,contact.processing_status,contact.verification_source,
    contact.provider_reference_sha256,contact.verified_at,
    contact.verified_by_customer_id,contact.verified_by_employee_id
    INTO contact_customer_id,contact_status,contact_verification_source,
      contact_provider_reference_sha256,contact_verified_at,
      contact_verified_by_customer_id,contact_verified_by_employee_id
  FROM mbox.customer_verified_contacts contact
  WHERE contact.tenant_id=tenant_value AND contact.store_id=store_value
    AND contact.id=contact_id_value AND contact.contact_type='phone'
  FOR UPDATE;
  IF contact_customer_id IS NULL OR contact_status='disposed'
    OR (action_value='verified' AND contact_status<>'active')
    OR (action_value IN ('superseded','revoked') AND contact_status<>'revoked') THEN
    RAISE EXCEPTION 'verified contact action does not match the strong contact state' USING ERRCODE='23514';
  END IF;
  IF actor_customer_id_value IS NOT NULL AND NOT EXISTS (
    WITH RECURSIVE contact_ancestry AS (
      SELECT id,merged_into_customer_id FROM mbox.customers
      WHERE tenant_id=tenant_value AND store_id=store_value AND id=contact_customer_id
      UNION ALL SELECT parent.id,parent.merged_into_customer_id FROM mbox.customers parent
        JOIN contact_ancestry child ON child.merged_into_customer_id=parent.id
      WHERE parent.tenant_id=tenant_value AND parent.store_id=store_value
    ), actor_ancestry AS (
      SELECT id,merged_into_customer_id FROM mbox.customers
      WHERE tenant_id=tenant_value AND store_id=store_value AND id=actor_customer_id_value
      UNION ALL SELECT parent.id,parent.merged_into_customer_id FROM mbox.customers parent
        JOIN actor_ancestry child ON child.merged_into_customer_id=parent.id
      WHERE parent.tenant_id=tenant_value AND parent.store_id=store_value
    ) SELECT 1 FROM contact_ancestry contact_root CROSS JOIN actor_ancestry actor_root
      WHERE contact_root.merged_into_customer_id IS NULL
        AND actor_root.merged_into_customer_id IS NULL AND contact_root.id=actor_root.id
  ) THEN
    RAISE EXCEPTION 'customer cannot append an action to another customer family' USING ERRCODE='42501';
  END IF;
  IF actor_employee_id_value IS NOT NULL AND NOT mbox.employee_has_effective_permission(
    tenant_value,store_value,actor_employee_id_value,'customer.membership.recovery.verify'
  ) THEN
    RAISE EXCEPTION 'employee cannot append verified contact actions' USING ERRCODE='42501';
  END IF;
  IF (action_value='verified') IS DISTINCT FROM (
    authorization_source_value IN ('wechat_phone_authorization','staff_controlled')
    AND authorization_reference_sha256_value ~ '^[0-9a-f]{64}$'
    AND authorized_at_value IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'verified contact authorization evidence is invalid' USING ERRCODE='23514';
  END IF;
  IF action_value='verified' AND (
    authorization_source_value IS DISTINCT FROM contact_verification_source
    OR authorization_reference_sha256_value IS DISTINCT FROM contact_provider_reference_sha256
    OR authorized_at_value IS DISTINCT FROM contact_verified_at
    OR (contact_verification_source='wechat_phone_authorization' AND (
      actor_customer_id_value IS DISTINCT FROM contact_verified_by_customer_id
      OR actor_employee_id_value IS NOT NULL
    ))
    OR (contact_verification_source='staff_controlled' AND (
      actor_employee_id_value IS DISTINCT FROM contact_verified_by_employee_id
      OR actor_customer_id_value IS NOT NULL
    ))
  ) THEN
    RAISE EXCEPTION 'verified action must match the immutable verification evidence' USING ERRCODE='23514';
  END IF;
  SELECT action.request_sha256 INTO existing_request_sha256
  FROM mbox.customer_verified_contact_actions action
  WHERE action.tenant_id=tenant_value AND action.store_id=store_value
    AND action.contact_id=contact_id_value AND action.action=action_value
    AND action.idempotency_key=idempotency_key_value
  FOR UPDATE;
  IF FOUND THEN
    IF existing_request_sha256<>request_sha256_value THEN
      RAISE EXCEPTION 'verified contact action idempotency conflict' USING ERRCODE='23505';
    END IF;
    RETURN false;
  END IF;
  INSERT INTO mbox.customer_verified_contact_actions(
    tenant_id,store_id,contact_id,action,actor_type,actor_customer_id,
    actor_employee_id,reason_code,reason_detail,authorization_source,
    authorization_reference_sha256,authorized_at,idempotency_key,request_sha256
  ) VALUES (tenant_value,store_value,contact_id_value,action_value,actor_type_value,
    actor_customer_id_value,actor_employee_id_value,reason_code_value,reason_detail_value,
    authorization_source_value,authorization_reference_sha256_value,authorized_at_value,
    idempotency_key_value,request_sha256_value);
  RETURN true;
END $$;

REVOKE ALL ON FUNCTION mbox.append_customer_verified_contact_action(
  uuid,text,uuid,uuid,text,text,text,char,timestamptz,text,char
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mbox.append_customer_verified_contact_action(
  uuid,text,uuid,uuid,text,text,text,char,timestamptz,text,char
) TO mbox_runtime;

-- Every initial verified contact receives its authoritative action from the
-- database row itself.  Both a new 095 writer and a rolling 079 writer take
-- this path, so application SQL cannot forge or omit the initial evidence.
INSERT INTO mbox.customer_verified_contact_actions(
  tenant_id,store_id,contact_id,action,actor_type,actor_customer_id,actor_employee_id,
  reason_code,authorization_source,authorization_reference_sha256,authorized_at,
  idempotency_key,request_sha256,occurred_at
)
SELECT contact.tenant_id,contact.store_id,contact.id,'verified',
  CASE WHEN contact.verification_source='wechat_phone_authorization' THEN 'customer' ELSE 'employee' END,
  contact.verified_by_customer_id,contact.verified_by_employee_id,'migration_095_verified',
  contact.verification_source,contact.provider_reference_sha256,contact.verified_at,
  'migration-095:'||replace(contact.id::text,'-',''),
  mbox.personal_contact_sha256(concat_ws('|',contact.id::text,contact.verification_source,
    contact.provider_reference_sha256,contact.verified_at::text)),contact.verified_at
FROM mbox.customer_verified_contacts contact;

CREATE FUNCTION mbox.record_initial_verified_contact_action()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mbox AS $$
DECLARE action_key text;
BEGIN
  action_key:='contact-initial:'||replace(NEW.id::text,'-','');
  INSERT INTO mbox.customer_verified_contact_actions(
    tenant_id,store_id,contact_id,action,actor_type,actor_customer_id,actor_employee_id,
    reason_code,authorization_source,authorization_reference_sha256,authorized_at,
    idempotency_key,request_sha256,occurred_at
  ) VALUES (NEW.tenant_id,NEW.store_id,NEW.id,'verified',
    CASE WHEN NEW.verification_source='wechat_phone_authorization' THEN 'customer' ELSE 'employee' END,
    NEW.verified_by_customer_id,NEW.verified_by_employee_id,'initial_verified_contact',
    NEW.verification_source,NEW.provider_reference_sha256,NEW.verified_at,action_key,
    mbox.personal_contact_sha256(concat_ws('|',NEW.id::text,NEW.verification_source,
      NEW.provider_reference_sha256,NEW.verified_at::text)),NEW.verified_at);
  RETURN NEW;
END $$;

CREATE TRIGGER customer_verified_contacts_record_initial_action
  AFTER INSERT ON mbox.customer_verified_contacts
  FOR EACH ROW EXECUTE FUNCTION mbox.record_initial_verified_contact_action();

CREATE TABLE mbox.personal_contact_legal_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  public_id text NOT NULL CHECK (public_id ~ '^PCH[0-9A-F]{32}$'),
  resource_kind text NOT NULL CHECK (resource_kind IN (
    'activity_registration_contact','verified_membership_phone'
  )),
  activity_contact_version_id uuid,
  verified_contact_id uuid,
  status text NOT NULL CHECK (status IN ('active','released')),
  legal_basis_reference text NOT NULL CHECK (length(btrim(legal_basis_reference)) BETWEEN 3 AND 240),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 2 AND 500),
  created_by_employee_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  hold_until timestamptz,
  released_by_employee_id uuid,
  release_reason text,
  released_at timestamptz,
  FOREIGN KEY (tenant_id,store_id,activity_contact_version_id)
    REFERENCES mbox.community_activity_registration_contact_versions(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,verified_contact_id)
    REFERENCES mbox.customer_verified_contacts(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,created_by_employee_id)
    REFERENCES mbox.employees(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,released_by_employee_id)
    REFERENCES mbox.employees(tenant_id,store_id,id),
  UNIQUE (tenant_id,store_id,public_id),
  UNIQUE (tenant_id,store_id,id),
  CHECK (
    (resource_kind='activity_registration_contact' AND activity_contact_version_id IS NOT NULL
      AND verified_contact_id IS NULL)
    OR
    (resource_kind='verified_membership_phone' AND activity_contact_version_id IS NULL
      AND verified_contact_id IS NOT NULL)
  ),
  CHECK (hold_until IS NULL OR hold_until>created_at),
  CHECK (
    (status='active' AND released_by_employee_id IS NULL
      AND release_reason IS NULL AND released_at IS NULL)
    OR
    (status='released' AND released_by_employee_id IS NOT NULL
      AND length(btrim(release_reason)) BETWEEN 2 AND 500 AND released_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX personal_contact_legal_holds_activity_active_idx
  ON mbox.personal_contact_legal_holds(tenant_id,store_id,activity_contact_version_id)
  WHERE status='active' AND activity_contact_version_id IS NOT NULL;
CREATE UNIQUE INDEX personal_contact_legal_holds_verified_active_idx
  ON mbox.personal_contact_legal_holds(tenant_id,store_id,verified_contact_id)
  WHERE status='active' AND verified_contact_id IS NOT NULL;

CREATE TABLE mbox.personal_contact_disposition_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  resource_kind text NOT NULL CHECK (resource_kind IN (
    'activity_registration_contact','verified_membership_phone'
  )),
  activity_contact_version_id uuid,
  verified_contact_id uuid,
  policy_version_id uuid NOT NULL,
  disposition_method text NOT NULL CHECK (disposition_method='cryptographic_erasure'),
  purpose_ended_at timestamptz NOT NULL,
  disposed_at timestamptz NOT NULL,
  worker_id text NOT NULL CHECK (length(worker_id) BETWEEN 8 AND 128),
  FOREIGN KEY (tenant_id,store_id,activity_contact_version_id)
    REFERENCES mbox.community_activity_registration_contact_versions(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,verified_contact_id)
    REFERENCES mbox.customer_verified_contacts(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,policy_version_id)
    REFERENCES mbox.personal_contact_retention_policy_versions(tenant_id,store_id,id),
  UNIQUE NULLS NOT DISTINCT (tenant_id,store_id,activity_contact_version_id,verified_contact_id),
  UNIQUE (tenant_id,store_id,id),
  CHECK (
    (resource_kind='activity_registration_contact' AND activity_contact_version_id IS NOT NULL
      AND verified_contact_id IS NULL)
    OR
    (resource_kind='verified_membership_phone' AND activity_contact_version_id IS NULL
      AND verified_contact_id IS NOT NULL)
  ),
  CHECK (disposed_at>=purpose_ended_at)
);

CREATE TABLE mbox.activity_contact_access_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  contact_version_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  access_purpose text NOT NULL CHECK (access_purpose IN (
    'attendance_coordination','waitlist_coordination','payment_followup',
    'activity_change','safety_coordination'
  )),
  outcome text NOT NULL CHECK (outcome IN ('claimed','revealed','denied','decrypt_failed')),
  denial_code text,
  claim_token uuid NOT NULL DEFAULT gen_random_uuid(),
  context_kind text NOT NULL CHECK (context_kind IN ('activity_registration','payment')),
  context_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  request_sha256 char(64) NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  display_expires_at timestamptz,
  FOREIGN KEY (tenant_id,store_id,contact_version_id)
    REFERENCES mbox.community_activity_registration_contact_versions(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,employee_id)
    REFERENCES mbox.employees(tenant_id,store_id,id),
  UNIQUE (tenant_id,store_id,employee_id,idempotency_key),
  UNIQUE (tenant_id,store_id,id),
  CHECK (
    (outcome IN ('claimed','revealed') AND denial_code IS NULL AND display_expires_at>requested_at)
    OR (outcome IN ('denied','decrypt_failed') AND length(btrim(denial_code)) BETWEEN 2 AND 64
      AND display_expires_at IS NULL)
  ),
  CHECK (display_expires_at IS NULL OR display_expires_at<=requested_at+interval '60 seconds')
);

CREATE FUNCTION mbox.protect_contact_governance_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'personal contact governance evidence is append-only' USING ERRCODE='23514';
END $$;

CREATE FUNCTION mbox.activity_contact_access_context_is_valid(
  tenant_id_value uuid,store_id_value uuid,contact_version_id_value uuid,
  employee_id_value uuid,purpose_value text,context_kind_value text,context_id_value uuid
)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,mbox AS $$
  SELECT tenant_id_value=NULLIF(current_setting('app.tenant_id',true),'')::uuid
    AND store_id_value=NULLIF(current_setting('app.store_id',true),'')::uuid
    AND mbox.employee_has_effective_permission(
      tenant_id_value,store_id_value,employee_id_value,'community.activity.contact.reveal'
    ) AND EXISTS (
      SELECT 1
      FROM mbox.community_activity_registration_contact_versions contact
      JOIN mbox.community_activity_registrations registration
        ON registration.tenant_id=contact.tenant_id AND registration.store_id=contact.store_id
       AND registration.id=contact.registration_id
      JOIN mbox.community_activities activity
        ON activity.tenant_id=registration.tenant_id AND activity.store_id=registration.store_id
       AND activity.id=registration.activity_id
      LEFT JOIN mbox.payments payment
        ON payment.tenant_id=registration.tenant_id AND payment.store_id=registration.store_id
       AND payment.id=registration.payment_id
      WHERE contact.tenant_id=tenant_id_value AND contact.store_id=store_id_value
        AND contact.id=contact_version_id_value AND contact.status='active'
        AND contact.registration_cycle=registration.registration_cycle
        AND activity.status IN ('published','full') AND activity.ends_at>clock_timestamp()
        AND (
          (purpose_value='waitlist_coordination' AND context_kind_value='activity_registration'
            AND context_id_value=registration.id AND registration.status='waitlisted')
          OR (purpose_value='attendance_coordination' AND context_kind_value='activity_registration'
            AND context_id_value=registration.id AND registration.status IN ('confirmed','checked_in')
            AND clock_timestamp()>=activity.starts_at-interval '24 hours')
          OR (purpose_value='payment_followup' AND context_kind_value='payment'
            AND context_id_value=payment.id AND registration.status='payment_pending'
            AND registration.payment_status='pending' AND payment.status IN ('created','pending'))
        )
    )
$$;

REVOKE ALL ON FUNCTION mbox.activity_contact_access_context_is_valid(uuid,uuid,uuid,uuid,text,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mbox.activity_contact_access_context_is_valid(uuid,uuid,uuid,uuid,text,text,uuid) TO mbox_runtime;

CREATE FUNCTION mbox.validate_activity_contact_access_claim()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.outcome<>'claimed' OR NOT mbox.activity_contact_access_context_is_valid(
    NEW.tenant_id,NEW.store_id,NEW.contact_version_id,NEW.employee_id,
    NEW.access_purpose,NEW.context_kind,NEW.context_id
  ) THEN
    RAISE EXCEPTION 'activity contact access lacks an authoritative purpose context' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER activity_contact_access_events_validate_claim
  BEFORE INSERT ON mbox.activity_contact_access_events
  FOR EACH ROW EXECUTE FUNCTION mbox.validate_activity_contact_access_claim();

CREATE FUNCTION mbox.protect_contact_retention_policy_version()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'draft' THEN
      RAISE EXCEPTION 'a contact retention policy must be inserted as draft' USING ERRCODE='23514';
    END IF;
    IF NOT mbox.employee_has_effective_permission(
      NEW.tenant_id,NEW.store_id,NEW.drafted_by_employee_id,'privacy.contact.retention.draft'
    ) THEN
      RAISE EXCEPTION 'contact retention drafter lacks permission' USING ERRCODE='42501';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.tenant_id<>NEW.tenant_id OR OLD.store_id<>NEW.store_id
    OR OLD.public_id<>NEW.public_id OR OLD.resource_kind<>NEW.resource_kind
    OR OLD.version<>NEW.version OR OLD.retention_days_after_purpose_end<>NEW.retention_days_after_purpose_end
    OR OLD.legal_basis_reference<>NEW.legal_basis_reference
    OR OLD.drafted_by_employee_id<>NEW.drafted_by_employee_id
    OR OLD.draft_reason<>NEW.draft_reason OR OLD.created_at<>NEW.created_at THEN
    RAISE EXCEPTION 'contact retention policy content and draft evidence are immutable' USING ERRCODE='23514';
  END IF;
  IF NOT (
    (OLD.status='draft' AND NEW.status='approved')
    OR (OLD.status='approved' AND NEW.status='published')
    OR (OLD.status='published' AND NEW.status='retired')
    OR (OLD.status='published' AND NEW.status='published'
      AND current_setting('app.contact_retention_window_close',true)=OLD.id::text
      AND OLD.effective_until IS DISTINCT FROM NEW.effective_until
      AND NEW.effective_until IS NOT NULL
      AND NEW.effective_until>clock_timestamp()
      AND (OLD.effective_until IS NULL OR NEW.effective_until<OLD.effective_until))
  ) THEN
    RAISE EXCEPTION 'contact retention policy transition is invalid' USING ERRCODE='23514';
  END IF;
  IF OLD.status='draft' AND NEW.status='approved' AND NOT mbox.employee_has_effective_permission(
    NEW.tenant_id,NEW.store_id,NEW.approved_by_employee_id,'privacy.contact.retention.approve'
  ) THEN
    RAISE EXCEPTION 'contact retention approver lacks permission' USING ERRCODE='42501';
  END IF;
  IF OLD.status='approved' AND (
    OLD.approved_by_employee_id IS DISTINCT FROM NEW.approved_by_employee_id
    OR OLD.approval_reason IS DISTINCT FROM NEW.approval_reason
    OR OLD.approved_at IS DISTINCT FROM NEW.approved_at
  ) THEN
    RAISE EXCEPTION 'contact retention approval evidence is immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.status='published' AND (
    OLD.approved_by_employee_id IS DISTINCT FROM NEW.approved_by_employee_id
    OR OLD.approval_reason IS DISTINCT FROM NEW.approval_reason
    OR OLD.approved_at IS DISTINCT FROM NEW.approved_at
    OR OLD.published_by_employee_id IS DISTINCT FROM NEW.published_by_employee_id
    OR OLD.publication_reason IS DISTINCT FROM NEW.publication_reason
    OR OLD.published_at IS DISTINCT FROM NEW.published_at
    OR OLD.effective_from IS DISTINCT FROM NEW.effective_from
  ) THEN
    RAISE EXCEPTION 'contact retention publication evidence is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER personal_contact_retention_policy_versions_protect
  BEFORE INSERT OR UPDATE OR DELETE ON mbox.personal_contact_retention_policy_versions
  FOR EACH ROW EXECUTE FUNCTION mbox.protect_contact_retention_policy_version();

CREATE FUNCTION mbox.draft_personal_contact_retention_policy(
  public_id_value text,
  resource_kind_value text,
  retention_days_value integer,
  legal_basis_reference_value text,
  drafter_employee_id_value uuid,
  draft_reason_value text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,mbox
AS $$
DECLARE tenant_value uuid;
DECLARE store_value uuid;
DECLARE result_public_id text;
BEGIN
  tenant_value:=NULLIF(current_setting('app.tenant_id',true),'')::uuid;
  store_value:=NULLIF(current_setting('app.store_id',true),'')::uuid;
  IF tenant_value IS NULL OR store_value IS NULL
    OR public_id_value !~ '^PCR[0-9A-F]{32}$'
    OR resource_kind_value NOT IN ('activity_registration_contact','verified_membership_phone')
    OR retention_days_value NOT BETWEEN 0 AND 36500
    OR length(btrim(legal_basis_reference_value)) NOT BETWEEN 3 AND 500
    OR length(btrim(draft_reason_value)) NOT BETWEEN 2 AND 500
    OR NOT mbox.employee_has_effective_permission(
      tenant_value,store_value,drafter_employee_id_value,'privacy.contact.retention.draft'
    ) THEN
    RAISE EXCEPTION 'contact retention draft request is invalid or unauthorized' USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    tenant_value::text||':'||store_value::text||':contact-retention:'||resource_kind_value,0
  ));
  INSERT INTO mbox.personal_contact_retention_policy_versions(
    tenant_id,store_id,public_id,resource_kind,version,status,
    retention_days_after_purpose_end,legal_basis_reference,
    drafted_by_employee_id,draft_reason
  ) SELECT tenant_value,store_value,public_id_value,resource_kind_value,
    COALESCE(max(version),0)+1,'draft',retention_days_value,
    btrim(legal_basis_reference_value),drafter_employee_id_value,btrim(draft_reason_value)
  FROM mbox.personal_contact_retention_policy_versions
  WHERE tenant_id=tenant_value AND store_id=store_value AND resource_kind=resource_kind_value
  RETURNING public_id INTO result_public_id;
  RETURN result_public_id;
END $$;

REVOKE ALL ON FUNCTION mbox.draft_personal_contact_retention_policy(
  text,text,integer,text,uuid,text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mbox.draft_personal_contact_retention_policy(
  text,text,integer,text,uuid,text
) TO mbox_runtime;

CREATE FUNCTION mbox.approve_personal_contact_retention_policy(
  policy_id_value uuid,
  approver_employee_id_value uuid,
  approval_reason_value text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,mbox
AS $$
DECLARE tenant_value uuid;
DECLARE store_value uuid;
DECLARE result_public_id text;
BEGIN
  tenant_value:=NULLIF(current_setting('app.tenant_id',true),'')::uuid;
  store_value:=NULLIF(current_setting('app.store_id',true),'')::uuid;
  IF tenant_value IS NULL OR store_value IS NULL
    OR length(btrim(approval_reason_value)) NOT BETWEEN 2 AND 500
    OR NOT mbox.employee_has_effective_permission(
      tenant_value,store_value,approver_employee_id_value,'privacy.contact.retention.approve'
    ) THEN
    RAISE EXCEPTION 'contact retention approval request is invalid or unauthorized' USING ERRCODE='42501';
  END IF;
  UPDATE mbox.personal_contact_retention_policy_versions
  SET status='approved',approved_by_employee_id=approver_employee_id_value,
    approval_reason=approval_reason_value,approved_at=clock_timestamp()
  WHERE tenant_id=tenant_value AND store_id=store_value AND id=policy_id_value
    AND status='draft' AND drafted_by_employee_id<>approver_employee_id_value
  RETURNING public_id INTO result_public_id;
  IF result_public_id IS NULL THEN
    RAISE EXCEPTION 'contact retention approval requires a different authorized employee' USING ERRCODE='23514';
  END IF;
  RETURN result_public_id;
END $$;

REVOKE ALL ON FUNCTION mbox.approve_personal_contact_retention_policy(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mbox.approve_personal_contact_retention_policy(uuid,uuid,text) TO mbox_runtime;

CREATE FUNCTION mbox.publish_personal_contact_retention_policy(
  policy_id_value uuid,
  publisher_employee_id_value uuid,
  publication_reason_value text,
  effective_from_value timestamptz
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,mbox
AS $$
DECLARE tenant_value uuid;
DECLARE store_value uuid;
DECLARE policy_row mbox.personal_contact_retention_policy_versions%ROWTYPE;
DECLARE existing_row record;
BEGIN
  tenant_value:=NULLIF(current_setting('app.tenant_id',true),'')::uuid;
  store_value:=NULLIF(current_setting('app.store_id',true),'')::uuid;
  IF tenant_value IS NULL OR store_value IS NULL
    OR effective_from_value<clock_timestamp()-interval '1 minute'
    OR length(btrim(publication_reason_value)) NOT BETWEEN 2 AND 500 THEN
    RAISE EXCEPTION 'contact retention publication request is invalid' USING ERRCODE='22023';
  END IF;
  SELECT * INTO policy_row FROM mbox.personal_contact_retention_policy_versions policy
  WHERE policy.tenant_id=tenant_value AND policy.store_id=store_value
    AND policy.id=policy_id_value AND policy.status='approved'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'approved contact retention policy not found' USING ERRCODE='23514';
  END IF;
  IF publisher_employee_id_value IN (policy_row.drafted_by_employee_id,policy_row.approved_by_employee_id)
    OR NOT mbox.employee_has_effective_permission(
      tenant_value,store_value,publisher_employee_id_value,'privacy.contact.retention.publish'
    ) THEN
    RAISE EXCEPTION 'contact retention publication requires a third active employee' USING ERRCODE='23514';
  END IF;
  FOR existing_row IN
    SELECT policy.id FROM mbox.personal_contact_retention_policy_versions policy
    WHERE policy.tenant_id=tenant_value AND policy.store_id=store_value
      AND policy.resource_kind=policy_row.resource_kind AND policy.status='published'
      AND policy.effective_from<effective_from_value
      AND (policy.effective_until IS NULL OR policy.effective_until>effective_from_value)
      AND policy.id<>policy_row.id
    FOR UPDATE
  LOOP
    PERFORM set_config('app.contact_retention_window_close',existing_row.id::text,true);
    UPDATE mbox.personal_contact_retention_policy_versions
    SET effective_until=effective_from_value
    WHERE tenant_id=tenant_value AND store_id=store_value AND id=existing_row.id;
  END LOOP;
  UPDATE mbox.personal_contact_retention_policy_versions
  SET status='published',published_by_employee_id=publisher_employee_id_value,
    publication_reason=publication_reason_value,published_at=clock_timestamp(),
    effective_from=effective_from_value
  WHERE tenant_id=tenant_value AND store_id=store_value AND id=policy_row.id;
  PERFORM set_config('app.contact_retention_window_close','',true);
  RETURN policy_row.public_id;
END $$;

REVOKE ALL ON FUNCTION mbox.publish_personal_contact_retention_policy(uuid,uuid,text,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mbox.publish_personal_contact_retention_policy(uuid,uuid,text,timestamptz) TO mbox_runtime;

CREATE TRIGGER customer_verified_contact_actions_append_only
  BEFORE UPDATE OR DELETE ON mbox.customer_verified_contact_actions
  FOR EACH ROW EXECUTE FUNCTION mbox.protect_contact_governance_append_only();
CREATE TRIGGER personal_contact_disposition_events_append_only
  BEFORE UPDATE OR DELETE ON mbox.personal_contact_disposition_events
  FOR EACH ROW EXECUTE FUNCTION mbox.protect_contact_governance_append_only();
CREATE FUNCTION mbox.protect_activity_contact_access_event()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'activity contact access evidence cannot be deleted' USING ERRCODE='55000';
  END IF;
  IF OLD.outcome<>'claimed' OR NEW.outcome NOT IN ('revealed','denied','decrypt_failed')
    OR OLD.tenant_id<>NEW.tenant_id OR OLD.store_id<>NEW.store_id OR OLD.id<>NEW.id
    OR OLD.contact_version_id<>NEW.contact_version_id OR OLD.employee_id<>NEW.employee_id
    OR OLD.access_purpose<>NEW.access_purpose OR OLD.idempotency_key<>NEW.idempotency_key
    OR OLD.request_sha256<>NEW.request_sha256 OR OLD.requested_at<>NEW.requested_at
    OR OLD.claim_token<>NEW.claim_token
    OR OLD.context_kind<>NEW.context_kind OR OLD.context_id<>NEW.context_id
    OR (NEW.outcome='revealed' AND OLD.display_expires_at IS DISTINCT FROM NEW.display_expires_at)
    OR (NEW.outcome<>'revealed' AND NEW.display_expires_at IS NOT NULL) THEN
    RAISE EXCEPTION 'activity contact access evidence transition is invalid' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER activity_contact_access_events_protect
  BEFORE UPDATE OR DELETE ON mbox.activity_contact_access_events
  FOR EACH ROW EXECUTE FUNCTION mbox.protect_activity_contact_access_event();

CREATE FUNCTION mbox.protect_activity_contact_version()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.tenant_id<>NEW.tenant_id OR OLD.store_id<>NEW.store_id OR OLD.registration_id<>NEW.registration_id
    OR OLD.registration_cycle<>NEW.registration_cycle OR OLD.version<>NEW.version
    OR OLD.public_id<>NEW.public_id OR OLD.supersedes_contact_version_id IS DISTINCT FROM NEW.supersedes_contact_version_id
    OR OLD.created_by_customer_id IS DISTINCT FROM NEW.created_by_customer_id
    OR OLD.idempotency_key<>NEW.idempotency_key OR OLD.request_sha256<>NEW.request_sha256
    OR OLD.captured_at<>NEW.captured_at THEN
    RAISE EXCEPTION 'activity contact version identity is immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.status='disposed' OR (OLD.status='inactive' AND NEW.status<>'disposed')
    OR (OLD.status='active' AND NEW.status<>'inactive') THEN
    RAISE EXCEPTION 'activity contact version lifecycle is invalid' USING ERRCODE='23514';
  END IF;
  IF NEW.status='disposed' AND current_setting('app.personal_contact_disposition',true)
      IS DISTINCT FROM OLD.id::text THEN
    RAISE EXCEPTION 'activity contact disposal must use the governed database function' USING ERRCODE='42501';
  END IF;
  IF NEW.status<>'disposed' AND (
    OLD.contact_type IS DISTINCT FROM NEW.contact_type OR OLD.contact_hash IS DISTINCT FROM NEW.contact_hash
    OR OLD.encrypted_contact IS DISTINCT FROM NEW.encrypted_contact
    OR OLD.encryption_key_id IS DISTINCT FROM NEW.encryption_key_id
    OR OLD.masked_contact IS DISTINCT FROM NEW.masked_contact
    OR OLD.contact_source IS DISTINCT FROM NEW.contact_source
  ) THEN
    RAISE EXCEPTION 'activity contact evidence cannot be overwritten' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER community_activity_registration_contact_versions_protect
  BEFORE UPDATE ON mbox.community_activity_registration_contact_versions
  FOR EACH ROW EXECUTE FUNCTION mbox.protect_activity_contact_version();

CREATE FUNCTION mbox.validate_activity_contact_version_chain()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous_registration_id uuid;
DECLARE previous_cycle integer;
DECLARE previous_version integer;
BEGIN
  IF NEW.supersedes_contact_version_id IS NULL THEN RETURN NEW; END IF;
  SELECT registration_id,registration_cycle,version
  INTO previous_registration_id,previous_cycle,previous_version
  FROM mbox.community_activity_registration_contact_versions
  WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id
    AND id=NEW.supersedes_contact_version_id FOR UPDATE;
  IF previous_registration_id IS DISTINCT FROM NEW.registration_id
    OR previous_cycle>NEW.registration_cycle
    OR (previous_cycle=NEW.registration_cycle AND previous_version>=NEW.version) THEN
    RAISE EXCEPTION 'activity contact supersedes must follow the same registration chain' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER community_activity_registration_contact_versions_chain
  BEFORE INSERT ON mbox.community_activity_registration_contact_versions
  FOR EACH ROW EXECUTE FUNCTION mbox.validate_activity_contact_version_chain();

CREATE FUNCTION mbox.mirror_legacy_activity_registration_contact()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE request_hash char(64);
DECLARE existing_hash char(64);
DECLARE previous_id uuid;
DECLARE next_version integer;
BEGIN
  -- A new runtime writes the strong version first, then a SECURITY DEFINER
  -- projection updates the compatibility column.  The nested update must not
  -- be mirrored back into another strong version.
  IF pg_trigger_depth()>1 THEN RETURN NEW; END IF;
  IF NEW.contact_snapshot IS NULL THEN RETURN NEW; END IF;
  IF jsonb_typeof(NEW.contact_snapshot)<>'object'
    OR NOT NEW.contact_snapshot ?& ARRAY['contactType','contactHash','encryptedContact','encryptionKeyId','maskedContact','source']
    OR NEW.contact_snapshot-ARRAY['contactType','contactHash','encryptedContact','encryptionKeyId','maskedContact','source']<>'{}'::jsonb
    OR NEW.contact_snapshot->>'contactType' NOT IN ('phone','wechat','other')
    OR NEW.contact_snapshot->>'contactHash' !~ '^[0-9a-f]{64}$'
    OR NEW.contact_snapshot->>'encryptionKeyId'<>'normalized-contact-v1'
    OR NEW.contact_snapshot->>'source'<>'mini_program'
    OR length(btrim(NEW.contact_snapshot->>'maskedContact')) NOT BETWEEN 3 AND 64
    OR position('*' IN NEW.contact_snapshot->>'maskedContact')=0
    OR length(NEW.contact_snapshot->>'encryptedContact')%4<>0
    OR NEW.contact_snapshot->>'encryptedContact' !~ '^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$'
    OR octet_length(decode(NEW.contact_snapshot->>'encryptedContact','base64')) NOT BETWEEN 32 AND 3072
    OR get_byte(decode(NEW.contact_snapshot->>'encryptedContact','base64'),0)<>1 THEN
    RAISE EXCEPTION 'legacy activity contact payload is not a supported protected six-key value' USING ERRCODE='23514';
  END IF;
  request_hash:=mbox.personal_contact_sha256(concat_ws('|',NEW.contact_snapshot->>'contactType',
    NEW.contact_snapshot->>'contactHash',NEW.contact_snapshot->>'source'));
  SELECT contact.request_sha256 INTO existing_hash
  FROM mbox.community_activity_registration_contact_versions contact
  WHERE contact.tenant_id=NEW.tenant_id AND contact.store_id=NEW.store_id
    AND contact.registration_id=NEW.id AND contact.registration_cycle=NEW.registration_cycle
    AND contact.idempotency_key=NEW.idempotency_key
  FOR UPDATE;
  IF FOUND THEN
    IF existing_hash<>request_hash THEN
      RAISE EXCEPTION 'legacy activity contact idempotency key conflicts with another protected contact' USING ERRCODE='23505';
    END IF;
    RETURN NEW;
  END IF;
  SELECT contact.id INTO previous_id
  FROM mbox.community_activity_registration_contact_versions contact
  WHERE contact.tenant_id=NEW.tenant_id AND contact.store_id=NEW.store_id
    AND contact.registration_id=NEW.id AND contact.status='active'
  FOR UPDATE;
  IF previous_id IS NOT NULL THEN
    UPDATE mbox.community_activity_registration_contact_versions
    SET status='inactive',inactivated_at=clock_timestamp()
    WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=previous_id;
  END IF;
  SELECT COALESCE(max(contact.version),0)+1 INTO next_version
  FROM mbox.community_activity_registration_contact_versions contact
  WHERE contact.tenant_id=NEW.tenant_id AND contact.store_id=NEW.store_id
    AND contact.registration_id=NEW.id AND contact.registration_cycle=NEW.registration_cycle;
  INSERT INTO mbox.community_activity_registration_contact_versions(
    tenant_id,store_id,public_id,registration_id,registration_cycle,version,status,
    supersedes_contact_version_id,contact_type,contact_hash,encrypted_contact,
    encryption_key_id,masked_contact,contact_source,created_by_customer_id,
    idempotency_key,request_sha256,captured_at
  ) VALUES (NEW.tenant_id,NEW.store_id,'ACV'||upper(replace(gen_random_uuid()::text,'-','')),
    NEW.id,NEW.registration_cycle,next_version,'active',previous_id,
    NEW.contact_snapshot->>'contactType',NEW.contact_snapshot->>'contactHash',
    decode(NEW.contact_snapshot->>'encryptedContact','base64'),
    NEW.contact_snapshot->>'encryptionKeyId',NEW.contact_snapshot->>'maskedContact',
    NEW.contact_snapshot->>'source',NEW.customer_id,NEW.idempotency_key,request_hash,NEW.registered_at);
  RETURN NEW;
END $$;

CREATE TRIGGER community_activity_registrations_legacy_contact_mirror
  AFTER INSERT OR UPDATE OF contact_snapshot ON mbox.community_activity_registrations
  FOR EACH ROW EXECUTE FUNCTION mbox.mirror_legacy_activity_registration_contact();

CREATE FUNCTION mbox.project_activity_contact_legacy_snapshot()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,mbox
AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM NULLIF(current_setting('app.tenant_id',true),'')::uuid
    OR NEW.store_id IS DISTINCT FROM NULLIF(current_setting('app.store_id',true),'')::uuid
    OR NEW.status<>'active' THEN RETURN NEW; END IF;
  UPDATE mbox.community_activity_registrations registration
  SET contact_snapshot=jsonb_build_object(
    'contactType',NEW.contact_type,
    'contactHash',NEW.contact_hash,
    'encryptedContact',encode(NEW.encrypted_contact,'base64'),
    'encryptionKeyId',NEW.encryption_key_id,
    'maskedContact',NEW.masked_contact,
    'source',NEW.contact_source
  )
  WHERE registration.tenant_id=NEW.tenant_id AND registration.store_id=NEW.store_id
    AND registration.id=NEW.registration_id
    AND registration.registration_cycle=NEW.registration_cycle;
  RETURN NEW;
END $$;

CREATE TRIGGER community_activity_contact_legacy_projection
  AFTER INSERT ON mbox.community_activity_registration_contact_versions
  FOR EACH ROW EXECUTE FUNCTION mbox.project_activity_contact_legacy_snapshot();

CREATE FUNCTION mbox.close_activity_registration_contact_purpose()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('cancelled','no_show','refunded') OR NEW.payment_status='expired' THEN
    UPDATE mbox.community_activity_registration_contact_versions
    SET status='inactive',inactivated_at=GREATEST(captured_at,
      COALESCE(NEW.cancelled_at,clock_timestamp()))
    WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id
      AND registration_id=NEW.id AND registration_cycle=NEW.registration_cycle
      AND status='active';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER community_activity_registrations_close_contact_purpose
  AFTER UPDATE OF status,payment_status,cancelled_at ON mbox.community_activity_registrations
  FOR EACH ROW EXECUTE FUNCTION mbox.close_activity_registration_contact_purpose();

CREATE FUNCTION mbox.close_activity_contacts_for_activity_state()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('cancelled','completed') THEN
    UPDATE mbox.community_activity_registration_contact_versions contact
    SET status='inactive',inactivated_at=GREATEST(contact.captured_at,clock_timestamp())
    FROM mbox.community_activity_registrations registration
    WHERE registration.tenant_id=NEW.tenant_id AND registration.store_id=NEW.store_id
      AND registration.activity_id=NEW.id AND contact.tenant_id=registration.tenant_id
      AND contact.store_id=registration.store_id AND contact.registration_id=registration.id
      AND contact.registration_cycle=registration.registration_cycle AND contact.status='active';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER community_activities_close_contact_purpose
  AFTER UPDATE OF status ON mbox.community_activities
  FOR EACH ROW EXECUTE FUNCTION mbox.close_activity_contacts_for_activity_state();

CREATE FUNCTION mbox.protect_customer_verified_contact_version()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.verified_contact_legacy_replay',true)=OLD.id::text THEN
    RETURN OLD;
  END IF;
  IF current_setting('app.verified_contact_merge_reconciliation',true)=OLD.id::text
    AND OLD.supersedes_contact_id IS NULL AND NEW.supersedes_contact_id IS NOT NULL
    AND ROW(OLD.tenant_id,OLD.store_id,OLD.customer_id,OLD.contact_type,OLD.public_id,
      OLD.contact_hash,OLD.encrypted_value,OLD.encryption_key_version,OLD.masked_value,
      OLD.verification_source,OLD.provider_reference_sha256,OLD.verified_by_customer_id,
      OLD.verified_by_employee_id,OLD.verified_at,OLD.revoked_at,OLD.created_at,
      OLD.processing_status,OLD.revoked_by_customer_id,OLD.revoked_by_employee_id,
      OLD.revocation_reason_code,OLD.contact_encryption_key_id,OLD.disposed_at,
      OLD.disposition_policy_version_id)
      IS NOT DISTINCT FROM
      ROW(NEW.tenant_id,NEW.store_id,NEW.customer_id,NEW.contact_type,NEW.public_id,
      NEW.contact_hash,NEW.encrypted_value,NEW.encryption_key_version,NEW.masked_value,
      NEW.verification_source,NEW.provider_reference_sha256,NEW.verified_by_customer_id,
      NEW.verified_by_employee_id,NEW.verified_at,NEW.revoked_at,NEW.created_at,
      NEW.processing_status,NEW.revoked_by_customer_id,NEW.revoked_by_employee_id,
      NEW.revocation_reason_code,NEW.contact_encryption_key_id,NEW.disposed_at,
      NEW.disposition_policy_version_id) THEN
    RETURN NEW;
  END IF;
  IF OLD.tenant_id<>NEW.tenant_id OR OLD.store_id<>NEW.store_id
    OR OLD.customer_id<>NEW.customer_id OR OLD.contact_type<>NEW.contact_type
    OR OLD.public_id<>NEW.public_id OR OLD.supersedes_contact_id IS DISTINCT FROM NEW.supersedes_contact_id
    OR OLD.verification_source<>NEW.verification_source
    OR OLD.provider_reference_sha256 IS DISTINCT FROM NEW.provider_reference_sha256
    OR OLD.verified_by_customer_id IS DISTINCT FROM NEW.verified_by_customer_id
    OR OLD.verified_by_employee_id IS DISTINCT FROM NEW.verified_by_employee_id
    OR OLD.verified_at<>NEW.verified_at OR OLD.created_at<>NEW.created_at THEN
    RAISE EXCEPTION 'verified contact identity and verification evidence are immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.processing_status='revoked' AND NEW.processing_status='active'
    AND current_setting('app.verified_contact_reauthorization',true)=OLD.id::text THEN
    RETURN NEW;
  END IF;
  IF OLD.processing_status='disposed'
    OR (OLD.processing_status='active' AND NEW.processing_status<>'revoked')
    OR (OLD.processing_status='revoked' AND NEW.processing_status<>'disposed') THEN
    RAISE EXCEPTION 'verified contact lifecycle is invalid' USING ERRCODE='23514';
  END IF;
  IF NEW.processing_status='disposed' AND current_setting('app.personal_contact_disposition',true)
      IS DISTINCT FROM OLD.id::text THEN
    RAISE EXCEPTION 'verified contact disposal must use the governed database function' USING ERRCODE='42501';
  END IF;
  IF NEW.processing_status<>'disposed' AND (
    OLD.contact_hash IS DISTINCT FROM NEW.contact_hash
    OR OLD.encrypted_value IS DISTINCT FROM NEW.encrypted_value
    OR OLD.encryption_key_version IS DISTINCT FROM NEW.encryption_key_version
    OR OLD.contact_encryption_key_id IS DISTINCT FROM NEW.contact_encryption_key_id
    OR OLD.masked_value IS DISTINCT FROM NEW.masked_value
  ) THEN
    RAISE EXCEPTION 'verified contact value cannot be overwritten or reactivated' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION mbox.prepare_legacy_verified_contact_write()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mbox AS $$
DECLARE active_id uuid;
DECLARE active_hash char(64);
DECLARE exact_id uuid;
DECLARE exact_status text;
DECLARE legacy_key text;
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM NULLIF(current_setting('app.tenant_id',true),'')::uuid
    OR NEW.store_id IS DISTINCT FROM NULLIF(current_setting('app.store_id',true),'')::uuid THEN
    RAISE EXCEPTION 'legacy verified contact write is outside the active store scope' USING ERRCODE='42501';
  END IF;
  IF NEW.verification_source='staff_controlled' AND (
    NEW.verified_by_customer_id IS NOT NULL OR NEW.verified_by_employee_id IS NULL
    OR NOT mbox.employee_has_effective_permission(
      NEW.tenant_id,NEW.store_id,NEW.verified_by_employee_id,'customer.membership.recovery.verify'
    )
  ) THEN
    RAISE EXCEPTION 'legacy staff verified contact writer lacks permission' USING ERRCODE='42501';
  END IF;
  IF NEW.verification_source='wechat_phone_authorization' AND (
    NEW.verified_by_customer_id IS DISTINCT FROM NEW.customer_id
    OR NEW.verified_by_employee_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'legacy customer verified contact actor is invalid' USING ERRCODE='42501';
  END IF;
  SELECT contact.id,contact.contact_hash INTO active_id,active_hash
  FROM mbox.customer_verified_contacts contact
  WHERE contact.tenant_id=NEW.tenant_id AND contact.store_id=NEW.store_id
    AND contact.customer_id=NEW.customer_id AND contact.contact_type=NEW.contact_type
    AND contact.processing_status='active'
  FOR UPDATE;
  IF active_id IS NOT NULL AND active_hash<>NEW.contact_hash THEN
    UPDATE mbox.customer_verified_contacts
    SET processing_status='revoked',revoked_at=clock_timestamp(),
      revoked_by_customer_id=NEW.verified_by_customer_id,
      revoked_by_employee_id=NEW.verified_by_employee_id,
      revocation_reason_code='legacy_rolling_replacement'
    WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=active_id;
    legacy_key:='legacy:'||substr(COALESCE(NEW.provider_reference_sha256,NEW.contact_hash),1,64);
    INSERT INTO mbox.customer_verified_contact_actions(
      tenant_id,store_id,contact_id,action,actor_type,actor_customer_id,
      actor_employee_id,reason_code,idempotency_key,request_sha256
    ) VALUES (NEW.tenant_id,NEW.store_id,active_id,'superseded',
      CASE WHEN NEW.verified_by_customer_id IS NOT NULL THEN 'customer' ELSE 'employee' END,
      NEW.verified_by_customer_id,NEW.verified_by_employee_id,'legacy_rolling_replacement',legacy_key,
      mbox.personal_contact_sha256(concat_ws('|',active_id::text,NEW.contact_hash::text)))
    ON CONFLICT DO NOTHING;
    NEW.supersedes_contact_id:=active_id;
  END IF;
  SELECT contact.id,contact.processing_status INTO exact_id,exact_status
  FROM mbox.customer_verified_contacts contact
  WHERE contact.tenant_id=NEW.tenant_id AND contact.store_id=NEW.store_id
    AND contact.customer_id=NEW.customer_id AND contact.contact_type=NEW.contact_type
    AND contact.contact_hash=NEW.contact_hash
  FOR UPDATE;
  IF exact_id IS NOT NULL THEN
    IF exact_status<>'active' THEN
      RAISE EXCEPTION 'a retired verified contact cannot be reactivated by a legacy instance; retry after rollout' USING ERRCODE='55000';
    END IF;
    PERFORM set_config('app.verified_contact_legacy_replay',exact_id::text,true);
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER customer_verified_contacts_prepare_legacy_write
  BEFORE INSERT ON mbox.customer_verified_contacts
  FOR EACH ROW EXECUTE FUNCTION mbox.prepare_legacy_verified_contact_write();

CREATE FUNCTION mbox.validate_verified_contact_version_chain()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous_customer_id uuid;
DECLARE same_family boolean;
BEGIN
  IF NEW.supersedes_contact_id IS NULL THEN RETURN NEW; END IF;
  SELECT customer_id INTO previous_customer_id
  FROM mbox.customer_verified_contacts
  WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id
    AND id=NEW.supersedes_contact_id FOR UPDATE;
  IF previous_customer_id IS NULL THEN
    RAISE EXCEPTION 'verified contact supersedes target is missing' USING ERRCODE='23514';
  END IF;
  WITH RECURSIVE previous_ancestry AS (
    SELECT id,merged_into_customer_id FROM mbox.customers
    WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=previous_customer_id
    UNION ALL SELECT parent.id,parent.merged_into_customer_id FROM mbox.customers parent
      JOIN previous_ancestry child ON child.merged_into_customer_id=parent.id
      WHERE parent.tenant_id=NEW.tenant_id AND parent.store_id=NEW.store_id
  ), next_ancestry AS (
    SELECT id,merged_into_customer_id FROM mbox.customers
    WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=NEW.customer_id
    UNION ALL SELECT parent.id,parent.merged_into_customer_id FROM mbox.customers parent
      JOIN next_ancestry child ON child.merged_into_customer_id=parent.id
      WHERE parent.tenant_id=NEW.tenant_id AND parent.store_id=NEW.store_id
  ) SELECT EXISTS (
    SELECT 1 FROM previous_ancestry previous_root CROSS JOIN next_ancestry next_root
    WHERE previous_root.merged_into_customer_id IS NULL
      AND next_root.merged_into_customer_id IS NULL AND previous_root.id=next_root.id
  ) INTO same_family;
  IF NOT same_family THEN
    RAISE EXCEPTION 'verified contact supersedes must stay in the canonical customer family' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER z_customer_verified_contacts_validate_chain
  BEFORE INSERT ON mbox.customer_verified_contacts
  FOR EACH ROW EXECUTE FUNCTION mbox.validate_verified_contact_version_chain();

CREATE FUNCTION mbox.normalize_legacy_verified_contact_conflict_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.verified_contact_legacy_replay',true)=OLD.id::text THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER a_customer_verified_contacts_normalize_legacy_conflict
  BEFORE UPDATE ON mbox.customer_verified_contacts
  FOR EACH ROW EXECUTE FUNCTION mbox.normalize_legacy_verified_contact_conflict_update();

CREATE TRIGGER customer_verified_contacts_protect_version
  BEFORE UPDATE ON mbox.customer_verified_contacts
  FOR EACH ROW EXECUTE FUNCTION mbox.protect_customer_verified_contact_version();

CREATE FUNCTION mbox.reauthorize_verified_membership_phone(
  contact_id_value uuid,
  actor_customer_id_value uuid,
  actor_employee_id_value uuid,
  authorization_source_value text,
  authorization_reference_sha256_value char(64),
  authorized_at_value timestamptz,
  idempotency_key_value text,
  request_sha256_value char(64)
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,mbox
AS $$
DECLARE tenant_value uuid;
DECLARE store_value uuid;
DECLARE contact_row mbox.customer_verified_contacts%ROWTYPE;
DECLARE existing_request_sha256 char(64);
BEGIN
  tenant_value:=NULLIF(current_setting('app.tenant_id',true),'')::uuid;
  store_value:=NULLIF(current_setting('app.store_id',true),'')::uuid;
  IF tenant_value IS NULL OR store_value IS NULL
    OR authorization_reference_sha256_value !~ '^[0-9a-f]{64}$'
    OR request_sha256_value !~ '^[0-9a-f]{64}$'
    OR length(idempotency_key_value) NOT BETWEEN 8 AND 128
    OR NOT (
      (authorization_source_value='wechat_phone_authorization'
        AND actor_customer_id_value IS NOT NULL AND actor_employee_id_value IS NULL)
      OR (authorization_source_value='staff_controlled'
        AND actor_customer_id_value IS NULL AND actor_employee_id_value IS NOT NULL)
    ) THEN
    RAISE EXCEPTION 'verified phone reauthorization request is invalid' USING ERRCODE='22023';
  END IF;
  SELECT * INTO contact_row FROM mbox.customer_verified_contacts contact
  WHERE contact.tenant_id=tenant_value AND contact.store_id=store_value
    AND contact.id=contact_id_value AND contact.contact_type='phone'
    AND contact.processing_status IN ('active','revoked')
    AND (
      (actor_customer_id_value IS NOT NULL AND EXISTS (
      WITH RECURSIVE contact_ancestry AS (
        SELECT id,merged_into_customer_id FROM mbox.customers
        WHERE tenant_id=tenant_value AND store_id=store_value AND id=contact.customer_id
        UNION ALL
        SELECT parent.id,parent.merged_into_customer_id FROM mbox.customers parent
        JOIN contact_ancestry child ON child.merged_into_customer_id=parent.id
        WHERE parent.tenant_id=tenant_value AND parent.store_id=store_value
      ), actor_ancestry AS (
        SELECT id,merged_into_customer_id FROM mbox.customers
        WHERE tenant_id=tenant_value AND store_id=store_value AND id=actor_customer_id_value
        UNION ALL
        SELECT parent.id,parent.merged_into_customer_id FROM mbox.customers parent
        JOIN actor_ancestry child ON child.merged_into_customer_id=parent.id
        WHERE parent.tenant_id=tenant_value AND parent.store_id=store_value
      )
      SELECT 1 FROM contact_ancestry contact_root CROSS JOIN actor_ancestry actor_root
      WHERE contact_root.merged_into_customer_id IS NULL
        AND actor_root.merged_into_customer_id IS NULL AND contact_root.id=actor_root.id
      )) OR (actor_employee_id_value IS NOT NULL AND mbox.employee_has_effective_permission(
        tenant_value,store_value,actor_employee_id_value,'customer.membership.recovery.verify'
      ))
    )
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'verified phone does not belong to the customer family or is disposed' USING ERRCODE='42501';
  END IF;
  SELECT action.request_sha256 INTO existing_request_sha256
  FROM mbox.customer_verified_contact_actions action
  WHERE action.tenant_id=tenant_value AND action.store_id=store_value
    AND action.contact_id=contact_row.id AND action.action='verified'
    AND action.idempotency_key=idempotency_key_value
  FOR UPDATE;
  IF FOUND THEN
    IF existing_request_sha256<>request_sha256_value THEN
      RAISE EXCEPTION 'verified phone reauthorization idempotency conflict' USING ERRCODE='23505';
    END IF;
    RETURN contact_row.public_id;
  END IF;
  IF contact_row.processing_status='revoked' THEN
    IF EXISTS (
      SELECT 1 FROM mbox.customer_verified_contacts active_contact
      WHERE active_contact.tenant_id=tenant_value AND active_contact.store_id=store_value
        AND active_contact.customer_id=contact_row.customer_id
        AND active_contact.contact_type='phone' AND active_contact.processing_status='active'
        AND active_contact.id<>contact_row.id
    ) THEN
      RAISE EXCEPTION 'another verified phone must be superseded before reauthorization' USING ERRCODE='23505';
    END IF;
    PERFORM set_config('app.verified_contact_reauthorization',contact_row.id::text,true);
    UPDATE mbox.customer_verified_contacts
    SET processing_status='active',revoked_at=NULL,revoked_by_customer_id=NULL,
      revoked_by_employee_id=NULL,revocation_reason_code=NULL
    WHERE tenant_id=tenant_value AND store_id=store_value AND id=contact_row.id
      AND processing_status='revoked';
  END IF;
  INSERT INTO mbox.customer_verified_contact_actions(
    tenant_id,store_id,contact_id,action,actor_type,actor_customer_id,actor_employee_id,reason_code,
    authorization_source,authorization_reference_sha256,authorized_at,
    idempotency_key,request_sha256
  ) VALUES (tenant_value,store_value,contact_row.id,'verified',
    CASE WHEN actor_customer_id_value IS NOT NULL THEN 'customer' ELSE 'employee' END,
    actor_customer_id_value,actor_employee_id_value,
    CASE WHEN actor_customer_id_value IS NOT NULL THEN 'customer_reauthorized_same_phone'
      ELSE 'staff_reverified_same_phone' END,authorization_source_value,
    authorization_reference_sha256_value,authorized_at_value,idempotency_key_value,request_sha256_value);
  PERFORM set_config('app.verified_contact_reauthorization','',true);
  RETURN contact_row.public_id;
END $$;

REVOKE ALL ON FUNCTION mbox.reauthorize_verified_membership_phone(uuid,uuid,uuid,text,char,timestamptz,text,char) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mbox.reauthorize_verified_membership_phone(uuid,uuid,uuid,text,char,timestamptz,text,char) TO mbox_runtime;

CREATE FUNCTION mbox.revoke_verified_membership_phone(
  contact_id_value uuid,
  actor_customer_id_value uuid,
  actor_employee_id_value uuid,
  reason_code_value text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,mbox
AS $$
DECLARE tenant_value uuid;
DECLARE store_value uuid;
DECLARE contact_customer_id uuid;
BEGIN
  tenant_value:=NULLIF(current_setting('app.tenant_id',true),'')::uuid;
  store_value:=NULLIF(current_setting('app.store_id',true),'')::uuid;
  IF tenant_value IS NULL OR store_value IS NULL
    OR length(reason_code_value) NOT BETWEEN 2 AND 64
    OR ((actor_customer_id_value IS NULL)=(actor_employee_id_value IS NULL)) THEN
    RAISE EXCEPTION 'verified phone revoke request is invalid' USING ERRCODE='22023';
  END IF;
  SELECT customer_id INTO contact_customer_id
  FROM mbox.customer_verified_contacts contact
  WHERE contact.tenant_id=tenant_value AND contact.store_id=store_value
    AND contact.id=contact_id_value AND contact.contact_type='phone'
    AND contact.processing_status='active'
    AND (
      (actor_customer_id_value IS NOT NULL AND EXISTS (
        WITH RECURSIVE contact_ancestry AS (
          SELECT id,merged_into_customer_id FROM mbox.customers
          WHERE tenant_id=tenant_value AND store_id=store_value AND id=contact.customer_id
          UNION ALL SELECT parent.id,parent.merged_into_customer_id FROM mbox.customers parent
            JOIN contact_ancestry child ON child.merged_into_customer_id=parent.id
          WHERE parent.tenant_id=tenant_value AND parent.store_id=store_value
        ), actor_ancestry AS (
          SELECT id,merged_into_customer_id FROM mbox.customers
          WHERE tenant_id=tenant_value AND store_id=store_value AND id=actor_customer_id_value
          UNION ALL SELECT parent.id,parent.merged_into_customer_id FROM mbox.customers parent
            JOIN actor_ancestry child ON child.merged_into_customer_id=parent.id
          WHERE parent.tenant_id=tenant_value AND parent.store_id=store_value
        ) SELECT 1 FROM contact_ancestry contact_root CROSS JOIN actor_ancestry actor_root
        WHERE contact_root.merged_into_customer_id IS NULL
          AND actor_root.merged_into_customer_id IS NULL AND contact_root.id=actor_root.id
      )) OR (actor_employee_id_value IS NOT NULL AND mbox.employee_has_effective_permission(
        tenant_value,store_value,actor_employee_id_value,'customer.membership.recovery.verify'
      ))
    )
  FOR UPDATE;
  IF contact_customer_id IS NULL THEN RETURN false; END IF;
  UPDATE mbox.customer_verified_contacts
  SET processing_status='revoked',revoked_at=clock_timestamp(),
    revoked_by_customer_id=actor_customer_id_value,
    revoked_by_employee_id=actor_employee_id_value,
    revocation_reason_code=reason_code_value
  WHERE tenant_id=tenant_value AND store_id=store_value AND id=contact_id_value
    AND processing_status='active';
  RETURN FOUND;
END $$;

REVOKE ALL ON FUNCTION mbox.revoke_verified_membership_phone(uuid,uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mbox.revoke_verified_membership_phone(uuid,uuid,uuid,text) TO mbox_runtime;

-- The selected recovery candidate is the strong same-phone binding created by
-- the current WeChat verification.  Reconcile those two active family facts
-- before the customer merge so the target proof remains canonical and the
-- historical source fact becomes an immutable superseded version.
CREATE FUNCTION mbox.reconcile_verified_contacts_for_membership_merge(
  merge_case_id_value uuid,
  actor_employee_id_value uuid,
  idempotency_key_value text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,mbox
AS $$
DECLARE tenant_value uuid;
DECLARE store_value uuid;
DECLARE source_customer_id_value uuid;
DECLARE target_customer_id_value uuid;
DECLARE keeper_contact_id_value uuid;
DECLARE source_contact_id_value uuid;
DECLARE keeper_supersedes_id uuid;
DECLARE request_sha256_value char(64);
BEGIN
  tenant_value:=NULLIF(current_setting('app.tenant_id',true),'')::uuid;
  store_value:=NULLIF(current_setting('app.store_id',true),'')::uuid;
  IF tenant_value IS NULL OR store_value IS NULL
    OR length(idempotency_key_value) NOT BETWEEN 8 AND 128
    OR NOT mbox.employee_has_effective_permission(
      tenant_value,store_value,actor_employee_id_value,'customer.membership.merge.approve'
    ) THEN
    RAISE EXCEPTION 'membership merge contact reconciliation is unauthorized' USING ERRCODE='42501';
  END IF;
  SELECT merge_case.source_customer_id,merge_case.target_customer_id,
    challenge.verified_contact_id,candidate.matched_contact_id
    INTO source_customer_id_value,target_customer_id_value,
      keeper_contact_id_value,source_contact_id_value
  FROM mbox.membership_merge_cases merge_case
  JOIN mbox.membership_recovery_challenges challenge
    ON challenge.tenant_id=merge_case.tenant_id AND challenge.store_id=merge_case.store_id
   AND challenge.id=merge_case.challenge_id
  JOIN mbox.membership_recovery_candidates candidate
    ON candidate.tenant_id=merge_case.tenant_id AND candidate.store_id=merge_case.store_id
   AND candidate.id=merge_case.selected_candidate_id
   AND candidate.challenge_id=challenge.id
   AND candidate.candidate_customer_id=merge_case.source_customer_id
  WHERE merge_case.tenant_id=tenant_value AND merge_case.store_id=store_value
    AND merge_case.id=merge_case_id_value AND merge_case.status='approved'
    AND merge_case.approved_by_employee_id=actor_employee_id_value
  FOR UPDATE OF merge_case,challenge,candidate;
  IF source_customer_id_value IS NULL OR target_customer_id_value IS NULL
    OR keeper_contact_id_value IS NULL OR source_contact_id_value IS NULL
    OR keeper_contact_id_value=source_contact_id_value THEN
    RAISE EXCEPTION 'membership merge contact evidence is incomplete' USING ERRCODE='23514';
  END IF;
  -- Serialize both roots in deterministic order before changing either family.
  PERFORM customer.id FROM mbox.customers customer
  WHERE customer.tenant_id=tenant_value AND customer.store_id=store_value
    AND customer.id IN (source_customer_id_value,target_customer_id_value)
  ORDER BY customer.id FOR UPDATE;
  IF NOT EXISTS (
    SELECT 1 FROM mbox.customer_verified_contacts keeper
    WHERE keeper.tenant_id=tenant_value AND keeper.store_id=store_value
      AND keeper.id=keeper_contact_id_value AND keeper.customer_id=target_customer_id_value
      AND keeper.contact_type='phone' AND keeper.processing_status='active'
  ) OR NOT EXISTS (
    SELECT 1 FROM mbox.customer_verified_contacts source_contact
    WHERE source_contact.tenant_id=tenant_value AND source_contact.store_id=store_value
      AND source_contact.id=source_contact_id_value AND source_contact.customer_id=source_customer_id_value
      AND source_contact.contact_type='phone' AND source_contact.processing_status='active'
  ) THEN
    RAISE EXCEPTION 'membership merge verified contact state changed; review again' USING ERRCODE='40001';
  END IF;
  UPDATE mbox.customer_verified_contacts
  SET processing_status='revoked',revoked_at=clock_timestamp(),
    revoked_by_employee_id=actor_employee_id_value,
    revocation_reason_code='membership_merge_superseded'
  WHERE tenant_id=tenant_value AND store_id=store_value AND id=source_contact_id_value
    AND processing_status='active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'membership merge source contact changed concurrently' USING ERRCODE='40001';
  END IF;
  request_sha256_value:=mbox.personal_contact_sha256(concat_ws('|',merge_case_id_value::text,
    keeper_contact_id_value::text,source_contact_id_value::text,actor_employee_id_value::text));
  INSERT INTO mbox.customer_verified_contact_actions(
    tenant_id,store_id,contact_id,action,actor_type,actor_employee_id,
    reason_code,reason_detail,idempotency_key,request_sha256
  ) VALUES (tenant_value,store_value,source_contact_id_value,'superseded','employee',
    actor_employee_id_value,'membership_merge_superseded',
    '本次微信验证的目标联系方式保留为规范化有效版本',
    left(idempotency_key_value,87)||':merge-source',request_sha256_value)
  ON CONFLICT (tenant_id,store_id,contact_id,action,idempotency_key) DO NOTHING;
  SELECT supersedes_contact_id INTO keeper_supersedes_id
  FROM mbox.customer_verified_contacts
  WHERE tenant_id=tenant_value AND store_id=store_value AND id=keeper_contact_id_value
  FOR UPDATE;
  IF keeper_supersedes_id IS NULL AND NOT EXISTS (
    SELECT 1 FROM mbox.customer_verified_contacts successor
    WHERE successor.tenant_id=tenant_value AND successor.store_id=store_value
      AND successor.supersedes_contact_id=source_contact_id_value
  ) THEN
    PERFORM set_config('app.verified_contact_merge_reconciliation',keeper_contact_id_value::text,true);
    UPDATE mbox.customer_verified_contacts
    SET supersedes_contact_id=source_contact_id_value
    WHERE tenant_id=tenant_value AND store_id=store_value AND id=keeper_contact_id_value
      AND supersedes_contact_id IS NULL;
    PERFORM set_config('app.verified_contact_merge_reconciliation','',true);
  END IF;
  RETURN keeper_contact_id_value;
END $$;

REVOKE ALL ON FUNCTION mbox.reconcile_verified_contacts_for_membership_merge(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mbox.reconcile_verified_contacts_for_membership_merge(uuid,uuid,text) TO mbox_runtime;

CREATE FUNCTION mbox.protect_personal_contact_legal_hold()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_status text;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'active' THEN
      RAISE EXCEPTION 'a legal hold must be inserted as active' USING ERRCODE='23514';
    END IF;
    IF NEW.resource_kind='activity_registration_contact' THEN
      SELECT status INTO target_status
      FROM mbox.community_activity_registration_contact_versions
      WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id
        AND id=NEW.activity_contact_version_id FOR UPDATE;
    ELSE
      SELECT processing_status INTO target_status
      FROM mbox.customer_verified_contacts
      WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id
        AND id=NEW.verified_contact_id FOR UPDATE;
    END IF;
    IF target_status IS NULL OR target_status='disposed' THEN
      RAISE EXCEPTION 'a legal hold cannot be attached to a missing or disposed contact version' USING ERRCODE='23514';
    END IF;
    IF NOT mbox.employee_has_effective_permission(
      NEW.tenant_id,NEW.store_id,NEW.created_by_employee_id,'privacy.contact.legal_hold'
    ) THEN
      RAISE EXCEPTION 'legal hold creator lacks permission' USING ERRCODE='42501';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'personal contact legal holds cannot be deleted' USING ERRCODE='23514';
  END IF;
  IF OLD.status<>'active' OR NEW.status<>'released'
    OR OLD.tenant_id<>NEW.tenant_id OR OLD.store_id<>NEW.store_id
    OR OLD.public_id<>NEW.public_id OR OLD.resource_kind<>NEW.resource_kind
    OR OLD.activity_contact_version_id IS DISTINCT FROM NEW.activity_contact_version_id
    OR OLD.verified_contact_id IS DISTINCT FROM NEW.verified_contact_id
    OR OLD.legal_basis_reference<>NEW.legal_basis_reference OR OLD.reason<>NEW.reason
    OR OLD.created_by_employee_id<>NEW.created_by_employee_id
    OR OLD.created_at<>NEW.created_at OR OLD.hold_until IS DISTINCT FROM NEW.hold_until THEN
    RAISE EXCEPTION 'personal contact legal hold can only be released append-only' USING ERRCODE='23514';
  END IF;
  IF NOT mbox.employee_has_effective_permission(
    NEW.tenant_id,NEW.store_id,NEW.released_by_employee_id,'privacy.contact.legal_hold'
  ) THEN
    RAISE EXCEPTION 'legal hold releaser lacks permission' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER personal_contact_legal_holds_protect
  BEFORE INSERT OR UPDATE OR DELETE ON mbox.personal_contact_legal_holds
  FOR EACH ROW EXECUTE FUNCTION mbox.protect_personal_contact_legal_hold();

CREATE FUNCTION mbox.create_personal_contact_legal_hold(
  public_id_value text,
  resource_kind_value text,
  resource_public_id_value text,
  legal_basis_reference_value text,
  reason_value text,
  creator_employee_id_value uuid,
  hold_until_value timestamptz
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,mbox
AS $$
DECLARE tenant_value uuid;
DECLARE store_value uuid;
DECLARE activity_contact_id_value uuid;
DECLARE verified_contact_id_value uuid;
DECLARE result_public_id text;
BEGIN
  tenant_value:=NULLIF(current_setting('app.tenant_id',true),'')::uuid;
  store_value:=NULLIF(current_setting('app.store_id',true),'')::uuid;
  IF tenant_value IS NULL OR store_value IS NULL
    OR public_id_value !~ '^PCH[0-9A-F]{32}$'
    OR resource_kind_value NOT IN ('activity_registration_contact','verified_membership_phone')
    OR length(btrim(legal_basis_reference_value)) NOT BETWEEN 3 AND 500
    OR length(btrim(reason_value)) NOT BETWEEN 2 AND 500
    OR (hold_until_value IS NOT NULL AND hold_until_value<=clock_timestamp())
    OR NOT mbox.employee_has_effective_permission(
      tenant_value,store_value,creator_employee_id_value,'privacy.contact.legal_hold'
    ) THEN
    RAISE EXCEPTION 'personal contact legal hold request is invalid or unauthorized' USING ERRCODE='42501';
  END IF;
  IF resource_kind_value='activity_registration_contact' THEN
    SELECT id INTO activity_contact_id_value
    FROM mbox.community_activity_registration_contact_versions
    WHERE tenant_id=tenant_value AND store_id=store_value AND public_id=resource_public_id_value
    FOR UPDATE;
  ELSE
    SELECT id INTO verified_contact_id_value
    FROM mbox.customer_verified_contacts
    WHERE tenant_id=tenant_value AND store_id=store_value AND public_id=resource_public_id_value
    FOR UPDATE;
  END IF;
  IF activity_contact_id_value IS NULL AND verified_contact_id_value IS NULL THEN
    RAISE EXCEPTION 'personal contact resource not found' USING ERRCODE='P0002';
  END IF;
  INSERT INTO mbox.personal_contact_legal_holds(
    tenant_id,store_id,public_id,resource_kind,activity_contact_version_id,
    verified_contact_id,status,legal_basis_reference,reason,created_by_employee_id,hold_until
  ) VALUES (
    tenant_value,store_value,public_id_value,resource_kind_value,activity_contact_id_value,
    verified_contact_id_value,'active',btrim(legal_basis_reference_value),btrim(reason_value),
    creator_employee_id_value,hold_until_value
  ) RETURNING public_id INTO result_public_id;
  RETURN result_public_id;
END $$;

REVOKE ALL ON FUNCTION mbox.create_personal_contact_legal_hold(
  text,text,text,text,text,uuid,timestamptz
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mbox.create_personal_contact_legal_hold(
  text,text,text,text,text,uuid,timestamptz
) TO mbox_runtime;

CREATE FUNCTION mbox.release_personal_contact_legal_hold(
  hold_public_id_value text,
  releaser_employee_id_value uuid,
  release_reason_value text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,mbox
AS $$
DECLARE tenant_value uuid;
DECLARE store_value uuid;
DECLARE result_public_id text;
BEGIN
  tenant_value:=NULLIF(current_setting('app.tenant_id',true),'')::uuid;
  store_value:=NULLIF(current_setting('app.store_id',true),'')::uuid;
  IF tenant_value IS NULL OR store_value IS NULL
    OR length(btrim(release_reason_value)) NOT BETWEEN 2 AND 500
    OR NOT mbox.employee_has_effective_permission(
      tenant_value,store_value,releaser_employee_id_value,'privacy.contact.legal_hold'
    ) THEN
    RAISE EXCEPTION 'legal hold release is invalid or unauthorized' USING ERRCODE='42501';
  END IF;
  UPDATE mbox.personal_contact_legal_holds
  SET status='released',released_by_employee_id=releaser_employee_id_value,
    release_reason=release_reason_value,released_at=clock_timestamp()
  WHERE tenant_id=tenant_value AND store_id=store_value
    AND public_id=hold_public_id_value AND status='active'
  RETURNING public_id INTO result_public_id;
  IF result_public_id IS NULL THEN
    RAISE EXCEPTION 'active legal hold not found' USING ERRCODE='P0002';
  END IF;
  RETURN result_public_id;
END $$;

REVOKE ALL ON FUNCTION mbox.release_personal_contact_legal_hold(text,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mbox.release_personal_contact_legal_hold(text,uuid,text) TO mbox_runtime;

CREATE FUNCTION mbox.dispose_personal_contact(
  resource_kind_value text,
  resource_id_value uuid,
  policy_version_id_value uuid,
  worker_id_value text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,mbox
AS $$
DECLARE tenant_value uuid;
DECLARE store_value uuid;
DECLARE policy_row mbox.personal_contact_retention_policy_versions%ROWTYPE;
DECLARE purpose_ended_value timestamptz;
DECLARE customer_id_value uuid;
DECLARE action_key text;
DECLARE activity_contact_status text;
BEGIN
  tenant_value:=NULLIF(current_setting('app.tenant_id',true),'')::uuid;
  store_value:=NULLIF(current_setting('app.store_id',true),'')::uuid;
  IF tenant_value IS NULL OR store_value IS NULL THEN
    RAISE EXCEPTION 'personal contact disposal requires tenant/store scope' USING ERRCODE='42501';
  END IF;
  IF resource_kind_value NOT IN ('activity_registration_contact','verified_membership_phone')
    OR worker_id_value !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,96}:personal-contact-disposition$'
    OR length(worker_id_value)>128 THEN
    RAISE EXCEPTION 'personal contact disposal request is invalid' USING ERRCODE='22023';
  END IF;
  SELECT * INTO policy_row
  FROM mbox.personal_contact_retention_policy_versions policy
  WHERE policy.tenant_id=tenant_value AND policy.store_id=store_value
    AND policy.id=policy_version_id_value AND policy.resource_kind=resource_kind_value
    AND policy.status='published' AND policy.effective_from<=clock_timestamp()
    AND (policy.effective_until IS NULL OR policy.effective_until>clock_timestamp())
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'a current published retention policy for this resource is required' USING ERRCODE='23514';
  END IF;

  IF resource_kind_value='activity_registration_contact' THEN
    SELECT contact.status,CASE
      WHEN contact.status='inactive' THEN contact.inactivated_at
      WHEN registration.status IN ('cancelled','no_show','refunded')
        OR registration.payment_status='expired'
        THEN GREATEST(contact.captured_at,COALESCE(registration.cancelled_at,clock_timestamp()))
      WHEN activity.status IN ('cancelled','completed') OR activity.ends_at<=clock_timestamp()
        THEN GREATEST(contact.captured_at,LEAST(activity.ends_at,clock_timestamp()))
      ELSE NULL END
    INTO activity_contact_status,purpose_ended_value
    FROM mbox.community_activity_registration_contact_versions contact
    JOIN mbox.community_activity_registrations registration
      ON registration.tenant_id=contact.tenant_id AND registration.store_id=contact.store_id
     AND registration.id=contact.registration_id
    JOIN mbox.community_activities activity
      ON activity.tenant_id=registration.tenant_id AND activity.store_id=registration.store_id
     AND activity.id=registration.activity_id
    WHERE contact.tenant_id=tenant_value AND contact.store_id=store_value
      AND contact.id=resource_id_value AND contact.status IN ('active','inactive')
    FOR UPDATE OF contact;
    IF NOT FOUND THEN
      RETURN false;
    END IF;
    IF purpose_ended_value IS NULL THEN RETURN false; END IF;
    IF activity_contact_status='active' THEN
      UPDATE mbox.community_activity_registration_contact_versions
      SET status='inactive',inactivated_at=purpose_ended_value
      WHERE tenant_id=tenant_value AND store_id=store_value AND id=resource_id_value
        AND status='active';
    END IF;
    IF EXISTS (
      SELECT 1 FROM mbox.personal_contact_legal_holds hold
      WHERE hold.tenant_id=tenant_value AND hold.store_id=store_value
        AND hold.resource_kind=resource_kind_value
        AND hold.activity_contact_version_id=resource_id_value
        AND hold.status='active'
        AND (hold.hold_until IS NULL OR hold.hold_until>clock_timestamp())
    ) THEN RETURN false; END IF;
    IF purpose_ended_value+make_interval(days=>policy_row.retention_days_after_purpose_end)>clock_timestamp()
    THEN RETURN false; END IF;
    IF EXISTS (
      SELECT 1
      FROM mbox.community_activity_registration_contact_versions contact
      JOIN mbox.community_activity_registrations registration
        ON registration.tenant_id=contact.tenant_id AND registration.store_id=contact.store_id
       AND registration.id=contact.registration_id
      LEFT JOIN mbox.payments payment
        ON payment.tenant_id=registration.tenant_id AND payment.store_id=registration.store_id
       AND payment.id=registration.payment_id
      LEFT JOIN mbox.payment_provider_actions provider_action
        ON provider_action.tenant_id=payment.tenant_id AND provider_action.store_id=payment.store_id
       AND provider_action.payment_id=payment.id
      LEFT JOIN mbox.refunds refund
        ON refund.tenant_id=payment.tenant_id AND refund.store_id=payment.store_id
       AND refund.payment_id=payment.id
      WHERE contact.tenant_id=tenant_value AND contact.store_id=store_value
        AND contact.id=resource_id_value AND (
          payment.status IN ('created','pending') OR provider_action.state IN ('creating','unknown')
          OR refund.status IN ('requested','approved','processing')
          OR refund.provider_submission_state IN ('submitting','manual_review')
        )
    ) THEN RETURN false; END IF;
    PERFORM set_config('app.personal_contact_disposition',resource_id_value::text,true);
    UPDATE mbox.community_activity_registration_contact_versions
    SET status='disposed',contact_type=NULL,contact_hash=NULL,encrypted_contact=NULL,
      encryption_key_id=NULL,masked_contact=NULL,contact_source=NULL,
      disposed_at=clock_timestamp(),disposition_policy_version_id=policy_row.id
    WHERE tenant_id=tenant_value AND store_id=store_value AND id=resource_id_value
      AND status='inactive';
    INSERT INTO mbox.personal_contact_disposition_events(
      tenant_id,store_id,resource_kind,activity_contact_version_id,policy_version_id,
      disposition_method,purpose_ended_at,disposed_at,worker_id
    ) VALUES (tenant_value,store_value,resource_kind_value,resource_id_value,policy_row.id,
      'cryptographic_erasure',purpose_ended_value,clock_timestamp(),worker_id_value);
  ELSE
    SELECT contact.revoked_at,contact.customer_id INTO purpose_ended_value,customer_id_value
    FROM mbox.customer_verified_contacts contact
    WHERE contact.tenant_id=tenant_value AND contact.store_id=store_value
      AND contact.id=resource_id_value AND contact.processing_status='revoked'
    FOR UPDATE;
    IF NOT FOUND THEN RETURN false; END IF;
    IF EXISTS (
      SELECT 1 FROM mbox.membership_recovery_challenges challenge
      WHERE challenge.tenant_id=tenant_value AND challenge.store_id=store_value
        AND challenge.verified_contact_id=resource_id_value
        AND challenge.status IN ('awaiting_verification','manual_review','pending_review')
    ) THEN RETURN false; END IF;
    IF EXISTS (
      SELECT 1 FROM mbox.personal_contact_legal_holds hold
      WHERE hold.tenant_id=tenant_value AND hold.store_id=store_value
        AND hold.resource_kind=resource_kind_value AND hold.verified_contact_id=resource_id_value
        AND hold.status='active'
        AND (hold.hold_until IS NULL OR hold.hold_until>clock_timestamp())
    ) THEN RETURN false; END IF;
    IF purpose_ended_value+make_interval(days=>policy_row.retention_days_after_purpose_end)>clock_timestamp()
    THEN RETURN false; END IF;
    PERFORM set_config('app.personal_contact_disposition',resource_id_value::text,true);
    UPDATE mbox.customer_verified_contacts
    SET processing_status='disposed',contact_hash=NULL,encrypted_value=NULL,
      encryption_key_version=NULL,contact_encryption_key_id=NULL,masked_value=NULL,
      disposed_at=clock_timestamp(),
      disposition_policy_version_id=policy_row.id
    WHERE tenant_id=tenant_value AND store_id=store_value AND id=resource_id_value
      AND processing_status='revoked';
    INSERT INTO mbox.personal_contact_disposition_events(
      tenant_id,store_id,resource_kind,verified_contact_id,policy_version_id,
      disposition_method,purpose_ended_at,disposed_at,worker_id
    ) VALUES (tenant_value,store_value,resource_kind_value,resource_id_value,policy_row.id,
      'cryptographic_erasure',purpose_ended_value,clock_timestamp(),worker_id_value);
    action_key:='dispose:'||replace(resource_id_value::text,'-','');
    INSERT INTO mbox.customer_verified_contact_actions(
      tenant_id,store_id,contact_id,action,actor_type,reason_code,idempotency_key,request_sha256
    ) VALUES (tenant_value,store_value,resource_id_value,'disposed','system',
      'published_retention_elapsed',action_key,
      mbox.personal_contact_sha256(concat_ws('|',resource_id_value::text,policy_row.id::text,customer_id_value::text)));
  END IF;
  PERFORM set_config('app.personal_contact_disposition','',true);
  RETURN true;
END $$;

REVOKE ALL ON FUNCTION mbox.dispose_personal_contact(text,uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mbox.dispose_personal_contact(text,uuid,uuid,text) TO mbox_runtime;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'personal_contact_retention_policy_versions',
    'community_activity_registration_contact_versions',
    'customer_verified_contact_actions','personal_contact_legal_holds',
    'personal_contact_disposition_events','activity_contact_access_events'
  ] LOOP
    EXECUTE format('ALTER TABLE mbox.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE mbox.%I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format(
      'CREATE POLICY tenant_store_isolation ON mbox.%I USING (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())',
      table_name
    );
    EXECUTE format('REVOKE ALL ON TABLE mbox.%I FROM PUBLIC',table_name);
  END LOOP;
END $$;

GRANT SELECT ON TABLE mbox.personal_contact_retention_policy_versions TO mbox_runtime;
GRANT SELECT,INSERT ON TABLE mbox.community_activity_registration_contact_versions TO mbox_runtime;
GRANT UPDATE(status,inactivated_at) ON TABLE mbox.community_activity_registration_contact_versions TO mbox_runtime;
GRANT SELECT ON TABLE mbox.customer_verified_contact_actions TO mbox_runtime;
GRANT SELECT ON TABLE mbox.personal_contact_legal_holds TO mbox_runtime;
GRANT SELECT ON TABLE mbox.personal_contact_disposition_events TO mbox_runtime;
GRANT SELECT,INSERT ON TABLE mbox.activity_contact_access_events TO mbox_runtime;
GRANT UPDATE(outcome,denial_code,display_expires_at)
  ON TABLE mbox.activity_contact_access_events TO mbox_runtime;
REVOKE UPDATE ON TABLE mbox.customer_verified_contacts FROM mbox_runtime;
-- Expand-only compatibility for an already-running 079 binary.  Its exact
-- ON CONFLICT statement references only these columns.  The immutable trigger
-- converts an exact same-value replay to a no-op; all direct mutations remain
-- rejected.  A later contract migration removes this temporary column grant.
GRANT UPDATE(encrypted_value,encryption_key_version,masked_value,verification_source,
  provider_reference_sha256,verified_by_customer_id,verified_by_employee_id,
  verified_at,revoked_at) ON TABLE mbox.customer_verified_contacts TO mbox_runtime;

INSERT INTO mbox.staff_permission_definitions(
  tenant_id,store_id,code,name,category,description,status
)
SELECT store.tenant_id,store.id,permission.code,permission.name,'privacy',permission.description,'active'
FROM mbox.stores store CROSS JOIN (VALUES
  ('community.activity.contact.reveal','查看活动报名联系方式','privacy','按活动运营目的限时查看当前报名周期的联系方式'),
  ('privacy.contact.retention.view','查看联系方式治理','privacy','查看保留策略、法定保留和非敏感处置证据'),
  ('privacy.contact.retention.draft','起草联系方式保留策略','privacy','起草活动与会员手机号的保留期限和依据'),
  ('privacy.contact.retention.approve','审批联系方式保留策略','privacy','由非起草人复核保留期限和依据'),
  ('privacy.contact.retention.publish','发布联系方式保留策略','privacy','由第三名授权人员发布联系方式保留策略'),
  ('privacy.contact.legal_hold','管理联系方式法定保留','privacy','建立或释放具体联系方式版本的法定保留')
) permission(code,name,category,description)
ON CONFLICT (tenant_id,store_id,code) DO UPDATE SET
  name=EXCLUDED.name,category=EXCLUDED.category,
  description=EXCLUDED.description,status='active';

INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id)
SELECT role.tenant_id,role.store_id,role.id,permission.id
FROM mbox.roles role JOIN mbox.staff_permission_definitions permission
  ON permission.tenant_id=role.tenant_id AND permission.store_id=role.store_id
WHERE role.status='active' AND (
  (permission.code='community.activity.contact.reveal'
    AND role.code IN ('OWNER','OPS_LEAD','MANAGER','DEPUT_MANAGER'))
  OR (permission.code='privacy.contact.retention.view'
    AND role.code IN ('OWNER','OPS_LEAD','MANAGER','DEPUT_MANAGER'))
  OR (permission.code='privacy.contact.retention.draft' AND role.code='MANAGER')
  OR (permission.code='privacy.contact.retention.approve' AND role.code='OPS_LEAD')
  OR (permission.code IN ('privacy.contact.retention.publish','privacy.contact.legal_hold')
    AND role.code='OWNER')
)
ON CONFLICT DO NOTHING;

CREATE FUNCTION mbox.seed_store_personal_contact_permissions()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO mbox.staff_permission_definitions(
    tenant_id,store_id,code,name,category,description,status
  ) SELECT NEW.tenant_id,NEW.id,permission.code,permission.name,'privacy',permission.description,'active'
  FROM (VALUES
    ('community.activity.contact.reveal','查看活动报名联系方式','按活动运营目的限时查看当前报名周期的联系方式'),
    ('privacy.contact.retention.view','查看联系方式治理','查看保留策略、法定保留和非敏感处置证据'),
    ('privacy.contact.retention.draft','起草联系方式保留策略','起草活动与会员手机号的保留期限和依据'),
    ('privacy.contact.retention.approve','审批联系方式保留策略','由非起草人复核保留期限和依据'),
    ('privacy.contact.retention.publish','发布联系方式保留策略','由第三名授权人员发布联系方式保留策略'),
    ('privacy.contact.legal_hold','管理联系方式法定保留','建立或释放具体联系方式版本的法定保留')
  ) permission(code,name,description)
  ON CONFLICT (tenant_id,store_id,code) DO UPDATE SET
    name=EXCLUDED.name,category=EXCLUDED.category,
    description=EXCLUDED.description,status='active';
  RETURN NEW;
END $$;

CREATE TRIGGER stores_seed_personal_contact_permissions
  AFTER INSERT ON mbox.stores FOR EACH ROW
  EXECUTE FUNCTION mbox.seed_store_personal_contact_permissions();

CREATE FUNCTION mbox.seed_role_personal_contact_permissions()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id)
  SELECT NEW.tenant_id,NEW.store_id,NEW.id,permission.id
  FROM mbox.staff_permission_definitions permission
  WHERE permission.tenant_id=NEW.tenant_id AND permission.store_id=NEW.store_id AND (
    (permission.code='community.activity.contact.reveal'
      AND NEW.code IN ('OWNER','OPS_LEAD','MANAGER','DEPUT_MANAGER'))
    OR (permission.code='privacy.contact.retention.view'
      AND NEW.code IN ('OWNER','OPS_LEAD','MANAGER','DEPUT_MANAGER'))
    OR (permission.code='privacy.contact.retention.draft' AND NEW.code='MANAGER')
    OR (permission.code='privacy.contact.retention.approve' AND NEW.code='OPS_LEAD')
    OR (permission.code IN ('privacy.contact.retention.publish','privacy.contact.legal_hold')
      AND NEW.code='OWNER')
  ) ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;

CREATE TRIGGER roles_seed_personal_contact_permissions
  AFTER INSERT ON mbox.roles FOR EACH ROW
  EXECUTE FUNCTION mbox.seed_role_personal_contact_permissions();

COMMENT ON TABLE mbox.community_activity_registration_contact_versions IS
  'Strong activity-contact versions. A hold retains only its old version and never blocks a new registration cycle or correction.';
COMMENT ON TABLE mbox.personal_contact_legal_holds IS
  'A hold prevents cryptographic disposition only; it never restores matching, reveal or other business processing.';
COMMENT ON TABLE mbox.personal_contact_retention_policy_versions IS
  'Store-approved retention periods. No statutory duration is inferred or seeded by the application.';

UPDATE mbox.normalized_schema_metadata
SET schema_version='095',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
