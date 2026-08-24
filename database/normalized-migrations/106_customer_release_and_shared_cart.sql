BEGIN;

-- The employee record is an internal identity.  Customer-facing service names
-- are explicit records with their own approval lifecycle and never fall back
-- to employees.display_name.
CREATE TABLE mbox.employee_customer_public_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  public_display_name text NOT NULL CHECK (length(btrim(public_display_name)) BETWEEN 1 AND 80),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','withdrawn')),
  approved_by_employee_id uuid,
  approved_at timestamptz,
  effective_at timestamptz,
  withdrawn_at timestamptz,
  withdrawal_reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
  FOREIGN KEY (tenant_id,store_id,employee_id)
    REFERENCES mbox.employees(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,approved_by_employee_id)
    REFERENCES mbox.employees(tenant_id,store_id,id),
  CHECK (
    (status='draft' AND approved_by_employee_id IS NULL AND approved_at IS NULL
      AND effective_at IS NULL AND withdrawn_at IS NULL AND withdrawal_reason IS NULL)
    OR (status='published' AND approved_by_employee_id IS NOT NULL AND approved_at IS NOT NULL
      AND effective_at IS NOT NULL AND withdrawn_at IS NULL AND withdrawal_reason IS NULL)
    OR (status='withdrawn' AND approved_by_employee_id IS NOT NULL AND approved_at IS NOT NULL
      AND effective_at IS NOT NULL AND withdrawn_at IS NOT NULL
      AND length(btrim(COALESCE(withdrawal_reason,''))) BETWEEN 2 AND 500)
  ),
  UNIQUE (tenant_id,store_id,employee_id),
  UNIQUE (tenant_id,store_id,id)
);

CREATE INDEX employee_customer_public_profiles_active_idx
  ON mbox.employee_customer_public_profiles(tenant_id,store_id,employee_id,effective_at)
  WHERE status='published';

CREATE TRIGGER employee_customer_public_profiles_touch_updated_at
BEFORE UPDATE ON mbox.employee_customer_public_profiles
FOR EACH ROW EXECUTE FUNCTION mbox.touch_updated_at();

-- A policy release stores only facts approved for customer disclosure.  No
-- migration seeds a placeholder: a production candidate is intentionally
-- blocked until Operations and Legal provide approved content and evidence.
CREATE TABLE mbox.privacy_policy_releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  policy_version text NOT NULL CHECK (policy_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$'),
  content_markdown text NOT NULL CHECK (length(btrim(content_markdown)) BETWEEN 80 AND 50000),
  content_sha256 char(64) NOT NULL CHECK (
    content_sha256 ~ '^[0-9a-f]{64}$'
    AND content_sha256 = encode(digest(content_markdown, 'sha256'), 'hex')
  ),
  operator_name text NOT NULL CHECK (length(btrim(operator_name)) BETWEEN 2 AND 200),
  contact text NOT NULL CHECK (length(btrim(contact)) BETWEEN 2 AND 500),
  data_retention_policy_version text NOT NULL CHECK (length(btrim(data_retention_policy_version)) BETWEEN 2 AND 80),
  third_party_register_version text NOT NULL CHECK (length(btrim(third_party_register_version)) BETWEEN 2 AND 80),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','withdrawn')),
  approved_by text,
  approved_at timestamptz,
  effective_at timestamptz,
  withdrawn_at timestamptz,
  withdrawal_reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
  CHECK (
    (status='draft' AND approved_by IS NULL AND approved_at IS NULL
      AND effective_at IS NULL AND withdrawn_at IS NULL AND withdrawal_reason IS NULL)
    OR (status='published' AND length(btrim(COALESCE(approved_by,''))) BETWEEN 2 AND 200
      AND approved_at IS NOT NULL AND effective_at IS NOT NULL
      AND withdrawn_at IS NULL AND withdrawal_reason IS NULL)
    OR (status='withdrawn' AND length(btrim(COALESCE(approved_by,''))) BETWEEN 2 AND 200
      AND approved_at IS NOT NULL AND effective_at IS NOT NULL AND withdrawn_at IS NOT NULL
      AND length(btrim(COALESCE(withdrawal_reason,''))) BETWEEN 2 AND 500)
  ),
  UNIQUE (tenant_id,store_id,policy_version),
  UNIQUE (tenant_id,store_id,id)
);

CREATE UNIQUE INDEX privacy_policy_releases_one_current_uq
  ON mbox.privacy_policy_releases(tenant_id,store_id)
  WHERE status='published' AND withdrawn_at IS NULL;

CREATE TRIGGER privacy_policy_releases_touch_updated_at
BEFORE UPDATE ON mbox.privacy_policy_releases
FOR EACH ROW EXECUTE FUNCTION mbox.touch_updated_at();

-- Existing in-service tables keep the legacy path until they close.  New table
-- sessions default to V2 so an old local cart can never silently mix with a
-- shared server cart on the same table session.
ALTER TABLE mbox.table_sessions
  ADD COLUMN guest_cart_protocol_version smallint;

UPDATE mbox.table_sessions
SET guest_cart_protocol_version = CASE
  WHEN status IN ('open','closing') THEN 1
  ELSE 2
END
WHERE guest_cart_protocol_version IS NULL;

ALTER TABLE mbox.table_sessions
  ALTER COLUMN guest_cart_protocol_version SET DEFAULT 2,
  ALTER COLUMN guest_cart_protocol_version SET NOT NULL,
  ADD CONSTRAINT table_sessions_guest_cart_protocol_version_ck
    CHECK (guest_cart_protocol_version IN (1,2));

-- Server-owned carts are scoped to a single, currently valid table session.
-- A generation closes at checkout; a new generation prevents a late command
-- from editing a later cart.
CREATE TABLE mbox.guest_shared_carts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  table_session_id uuid NOT NULL,
  public_id text NOT NULL CHECK (public_id ~ '^GSC[0-9A-F]{32}$'),
  generation integer NOT NULL CHECK (generation > 0),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','submitting','submitted','expired')),
  submitted_order_id uuid,
  submitted_at timestamptz,
  expired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
  FOREIGN KEY (tenant_id,store_id,table_session_id)
    REFERENCES mbox.table_sessions(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,submitted_order_id)
    REFERENCES mbox.orders(tenant_id,store_id,id),
  CHECK (
    (status='open' AND submitted_order_id IS NULL AND submitted_at IS NULL AND expired_at IS NULL)
    OR (status='submitting' AND submitted_order_id IS NULL AND submitted_at IS NULL AND expired_at IS NULL)
    OR (status='submitted' AND submitted_order_id IS NOT NULL AND submitted_at IS NOT NULL AND expired_at IS NULL)
    OR (status='expired' AND submitted_order_id IS NULL AND submitted_at IS NULL AND expired_at IS NOT NULL)
  ),
  UNIQUE (tenant_id,store_id,public_id),
  UNIQUE (tenant_id,store_id,table_session_id,generation),
  UNIQUE (tenant_id,store_id,id)
);

CREATE UNIQUE INDEX guest_shared_carts_one_open_generation_uq
  ON mbox.guest_shared_carts(tenant_id,store_id,table_session_id)
  WHERE status='open';
CREATE INDEX guest_shared_carts_session_timeline_idx
  ON mbox.guest_shared_carts(tenant_id,store_id,table_session_id,generation DESC);

CREATE TRIGGER guest_shared_carts_touch_updated_at
BEFORE UPDATE ON mbox.guest_shared_carts
FOR EACH ROW EXECUTE FUNCTION mbox.touch_updated_at();

CREATE TABLE mbox.guest_shared_cart_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  cart_id uuid NOT NULL,
  product_id uuid NOT NULL,
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 99),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
  FOREIGN KEY (tenant_id,store_id,cart_id)
    REFERENCES mbox.guest_shared_carts(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,product_id)
    REFERENCES mbox.products(tenant_id,store_id,id),
  UNIQUE (tenant_id,store_id,cart_id,product_id),
  UNIQUE (tenant_id,store_id,id)
);

CREATE INDEX guest_shared_cart_lines_cart_idx
  ON mbox.guest_shared_cart_lines(tenant_id,store_id,cart_id,created_at,id);

CREATE TRIGGER guest_shared_cart_lines_touch_updated_at
BEFORE UPDATE ON mbox.guest_shared_cart_lines
FOR EACH ROW EXECUTE FUNCTION mbox.touch_updated_at();

-- This append-only operation log is an internal audit trail.  It deliberately
-- records no customer profile or payment credential and is never returned in
-- the shared customer DTO.
CREATE TABLE mbox.guest_shared_cart_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  cart_id uuid NOT NULL,
  generation integer NOT NULL CHECK (generation > 0),
  operation_id text NOT NULL CHECK (operation_id ~ '^[A-Za-z0-9_-]{8,128}$'),
  actor_session_ref text NOT NULL CHECK (length(btrim(actor_session_ref)) BETWEEN 8 AND 180),
  command text NOT NULL CHECK (command IN ('adjust','remove','clear','submit','expire')),
  expected_version bigint,
  resulting_version bigint NOT NULL CHECK (resulting_version >= 0),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload)='object'),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
  FOREIGN KEY (tenant_id,store_id,cart_id)
    REFERENCES mbox.guest_shared_carts(tenant_id,store_id,id),
  UNIQUE (tenant_id,store_id,cart_id,operation_id),
  UNIQUE (tenant_id,store_id,id)
);

CREATE INDEX guest_shared_cart_operations_timeline_idx
  ON mbox.guest_shared_cart_operations(tenant_id,store_id,cart_id,occurred_at,id);

CREATE TRIGGER guest_shared_cart_operations_append_only
BEFORE UPDATE OR DELETE ON mbox.guest_shared_cart_operations
FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();

-- Losing the active table session invalidates every unsubmitted cart at once.
-- This protects against a device retaining a stale local snapshot after a
-- transfer, cancellation, or table closing transition.
CREATE FUNCTION mbox.expire_guest_shared_carts_on_table_session_end()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status='open' AND NEW.status<>'open' THEN
    UPDATE mbox.guest_shared_carts
    SET status='expired',expired_at=clock_timestamp(),updated_at=clock_timestamp()
    WHERE tenant_id=NEW.tenant_id
      AND store_id=NEW.store_id
      AND table_session_id=NEW.id
      AND status='open';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER table_sessions_expire_guest_shared_carts
AFTER UPDATE OF status ON mbox.table_sessions
FOR EACH ROW EXECUTE FUNCTION mbox.expire_guest_shared_carts_on_table_session_end();

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'employee_customer_public_profiles',
    'privacy_policy_releases',
    'guest_shared_carts',
    'guest_shared_cart_lines',
    'guest_shared_cart_operations'
  ]
  LOOP
    EXECUTE format('ALTER TABLE mbox.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE mbox.%I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format(
      'CREATE POLICY tenant_store_isolation ON mbox.%I '
      'USING (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) '
      'WITH CHECK (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())',
      table_name
    );
    EXECUTE format('REVOKE ALL ON TABLE mbox.%I FROM PUBLIC',table_name);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE ON TABLE mbox.%I TO mbox_runtime',table_name);
  END LOOP;
END $$;

REVOKE UPDATE,DELETE ON mbox.guest_shared_cart_operations FROM mbox_runtime;

UPDATE mbox.normalized_schema_metadata
SET schema_version='106',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
