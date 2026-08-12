BEGIN;

CREATE TABLE mbox.customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  public_id text NOT NULL CHECK (length(public_id) BETWEEN 8 AND 128),
  identity_kind text NOT NULL CHECK (identity_kind IN ('anonymous', 'wechat', 'member', 'manual')),
  identity_hash char(64) CHECK (identity_hash IS NULL OR identity_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'merged', 'blocked', 'deleted')),
  merged_into_customer_id uuid,
  first_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, merged_into_customer_id) REFERENCES mbox.customers(tenant_id, store_id, id),
  CHECK ((status = 'merged') = (merged_into_customer_id IS NOT NULL)),
  UNIQUE (tenant_id, store_id, public_id),
  UNIQUE (tenant_id, store_id, id)
);
CREATE UNIQUE INDEX customers_identity_hash_uq
  ON mbox.customers (tenant_id, store_id, identity_kind, identity_hash)
  WHERE identity_hash IS NOT NULL;

ALTER TABLE mbox.reservations
  ADD CONSTRAINT reservations_customer_fk
  FOREIGN KEY (tenant_id, store_id, customer_id)
  REFERENCES mbox.customers(tenant_id, store_id, id);
CREATE INDEX reservations_customer_idx
  ON mbox.reservations (tenant_id, store_id, customer_id, arrival_at DESC, id)
  WHERE customer_id IS NOT NULL;

CREATE TABLE mbox.customer_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  display_name text,
  preferences jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(preferences) = 'object'),
  tags text[] NOT NULL DEFAULT ARRAY[]::text[],
  consent_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(consent_snapshot) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, customer_id) REFERENCES mbox.customers(tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, customer_id),
  UNIQUE (tenant_id, store_id, id)
);

CREATE TABLE mbox.benefits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  benefit_code text NOT NULL CHECK (benefit_code ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{1,63}$'),
  benefit_type text NOT NULL CHECK (benefit_type IN ('gift_product', 'discount', 'credit', 'access', 'other')),
  status text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'reserved', 'redeemed', 'expired', 'revoked')),
  value_amount_minor bigint CHECK (value_amount_minor IS NULL OR value_amount_minor >= 0),
  currency char(3) CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  benefit_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(benefit_snapshot) = 'object'),
  valid_from timestamptz NOT NULL DEFAULT clock_timestamp(),
  valid_until timestamptz,
  issued_by_employee_id uuid,
  redeemed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, customer_id) REFERENCES mbox.customers(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, issued_by_employee_id) REFERENCES mbox.employees(tenant_id, store_id, id),
  CHECK (valid_until IS NULL OR valid_until > valid_from),
  CHECK ((value_amount_minor IS NULL) = (currency IS NULL)),
  UNIQUE (tenant_id, store_id, id)
);
CREATE INDEX benefits_customer_active_idx
  ON mbox.benefits (tenant_id, store_id, customer_id, valid_until, id)
  WHERE status IN ('issued', 'reserved');

CREATE TABLE mbox.performers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  code text NOT NULL CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$'),
  stage_name text NOT NULL CHECK (length(btrim(stage_name)) > 0),
  profile_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(profile_snapshot) = 'object'),
  song_catalog jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(song_catalog) = 'array'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  UNIQUE (tenant_id, store_id, code),
  UNIQUE (tenant_id, store_id, id)
);

CREATE TABLE mbox.schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  performer_id uuid NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'performing', 'completed', 'cancelled')),
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, performer_id) REFERENCES mbox.performers(tenant_id, store_id, id),
  CHECK (ends_at > starts_at),
  UNIQUE (tenant_id, store_id, performer_id, starts_at),
  UNIQUE (tenant_id, store_id, id)
);
CREATE INDEX schedules_store_timeline_idx
  ON mbox.schedules (tenant_id, store_id, starts_at, ends_at, status, id);

CREATE TABLE mbox.song_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  table_session_id uuid NOT NULL,
  performer_id uuid,
  schedule_id uuid,
  customer_id uuid,
  song_title text NOT NULL CHECK (length(btrim(song_title)) > 0),
  request_type text NOT NULL DEFAULT 'catalog' CHECK (request_type IN ('catalog', 'custom')),
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'confirming', 'accepted', 'rejected', 'paid', 'performed', 'cancelled')),
  quoted_amount_minor bigint CHECK (quoted_amount_minor IS NULL OR quoted_amount_minor >= 0),
  currency char(3) CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  note text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, table_session_id) REFERENCES mbox.table_sessions(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, performer_id) REFERENCES mbox.performers(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, schedule_id) REFERENCES mbox.schedules(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, customer_id) REFERENCES mbox.customers(tenant_id, store_id, id),
  CHECK ((quoted_amount_minor IS NULL) = (currency IS NULL)),
  UNIQUE (tenant_id, store_id, id)
);
CREATE INDEX song_requests_queue_idx
  ON mbox.song_requests (tenant_id, store_id, status, created_at, id)
  WHERE status IN ('requested', 'confirming', 'accepted', 'paid');

CREATE TABLE mbox.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  channel text NOT NULL CHECK (channel IN ('in_app', 'wechat', 'wecom', 'headset', 'printer', 'sms')),
  recipient_type text NOT NULL CHECK (recipient_type IN ('employee', 'customer', 'role', 'table', 'integration')),
  recipient_id text NOT NULL CHECK (length(btrim(recipient_id)) > 0),
  template_code text NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'delivered', 'failed', 'cancelled')),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  delivered_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  locked_by text,
  locked_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  UNIQUE (tenant_id, store_id, id)
);
CREATE INDEX notifications_delivery_claim_idx
  ON mbox.notifications (available_at, created_at, id)
  WHERE status IN ('pending', 'failed');
CREATE INDEX notifications_store_delivery_claim_idx
  ON mbox.notifications (tenant_id, store_id, available_at, created_at, id)
  WHERE status IN ('pending', 'failed');

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['customers','customer_profiles','benefits','performers','schedules','song_requests','notifications']
  LOOP
    EXECUTE format('CREATE TRIGGER %I_touch_updated_at BEFORE UPDATE ON mbox.%I FOR EACH ROW EXECUTE FUNCTION mbox.touch_updated_at()', table_name, table_name);
  END LOOP;
END $$;

COMMIT;
