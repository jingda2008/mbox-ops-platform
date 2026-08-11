BEGIN;

CREATE TABLE mbox.public_reservation_policies (
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  hold_minutes integer NOT NULL DEFAULT 20 CHECK (hold_minutes = 20),
  max_advance_days integer NOT NULL DEFAULT 90 CHECK (max_advance_days BETWEEN 1 AND 365),
  default_duration_minutes integer NOT NULL DEFAULT 240
    CHECK (default_duration_minutes BETWEEN 30 AND 720),
  customer_cancel_cutoff_minutes integer NOT NULL DEFAULT 120
    CHECK (customer_cancel_cutoff_minutes BETWEEN 0 AND 10080),
  deposit_mode text NOT NULL DEFAULT 'disabled'
    CHECK (deposit_mode IN ('disabled', 'flat', 'minimum_spend_ratio')),
  deposit_minor bigint CHECK (deposit_minor IS NULL OR deposit_minor >= 0),
  deposit_ratio_bps integer CHECK (deposit_ratio_bps IS NULL OR deposit_ratio_bps BETWEEN 1 AND 10000),
  deposit_rule_text text,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  CHECK (
    (deposit_mode = 'disabled' AND deposit_minor IS NULL AND deposit_ratio_bps IS NULL)
    OR (deposit_mode = 'flat' AND deposit_minor IS NOT NULL AND deposit_ratio_bps IS NULL)
    OR (deposit_mode = 'minimum_spend_ratio' AND deposit_minor IS NULL AND deposit_ratio_bps IS NOT NULL)
  ),
  PRIMARY KEY (tenant_id, store_id)
);

INSERT INTO mbox.public_reservation_policies (tenant_id, store_id)
SELECT tenant_id, id FROM mbox.stores
ON CONFLICT (tenant_id, store_id) DO NOTHING;

CREATE TABLE mbox.reservation_guest_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  token_hash char(64) NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  device_hash char(64) NOT NULL CHECK (device_hash ~ '^[0-9a-f]{64}$'),
  identity_provider text NOT NULL CHECK (identity_provider IN ('anonymous', 'wechat')),
  identity_subject_hash char(64) NOT NULL CHECK (identity_subject_hash ~ '^[0-9a-f]{64}$'),
  scopes text[] NOT NULL DEFAULT ARRAY[
    'guest.reservation.read', 'guest.reservation.update', 'guest.waitlist.manage'
  ]::text[] CHECK (
    cardinality(scopes) BETWEEN 1 AND 6
    AND scopes <@ ARRAY[
      'guest.reservation.read', 'guest.reservation.update', 'guest.waitlist.manage'
    ]::text[]
  ),
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  revoke_reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, customer_id)
    REFERENCES mbox.customers(tenant_id, store_id, id),
  CHECK (expires_at > issued_at AND expires_at <= issued_at + interval '2 hours'),
  CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL)),
  UNIQUE (tenant_id, store_id, token_hash),
  UNIQUE (tenant_id, store_id, id)
);

CREATE UNIQUE INDEX reservation_guest_sessions_live_device_uq
  ON mbox.reservation_guest_sessions (tenant_id, store_id, customer_id, device_hash)
  WHERE revoked_at IS NULL;
CREATE INDEX reservation_guest_sessions_token_idx
  ON mbox.reservation_guest_sessions (tenant_id, store_id, token_hash, expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE mbox.public_reservation_rate_limits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('session', 'availability', 'reservation', 'waitlist')),
  principal_hash char(64) NOT NULL CHECK (principal_hash ~ '^[0-9a-f]{64}$'),
  window_started_at timestamptz NOT NULL,
  attempt_count integer NOT NULL DEFAULT 1 CHECK (attempt_count > 0),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  CHECK (expires_at > window_started_at),
  UNIQUE (tenant_id, store_id, action, principal_hash),
  UNIQUE (tenant_id, store_id, id)
);

CREATE TABLE mbox.reservation_private_contacts (
  reservation_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  contact_hash char(64) NOT NULL CHECK (contact_hash ~ '^[0-9a-f]{64}$'),
  encrypted_contact bytea NOT NULL CHECK (octet_length(encrypted_contact) BETWEEN 16 AND 4096),
  encryption_key_id text NOT NULL CHECK (length(btrim(encryption_key_id)) BETWEEN 2 AND 128),
  masked_contact text NOT NULL CHECK (length(btrim(masked_contact)) BETWEEN 3 AND 64),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id, reservation_id)
    REFERENCES mbox.reservations(tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, contact_hash, reservation_id),
  UNIQUE (tenant_id, store_id, reservation_id)
);

CREATE TABLE mbox.waitlist_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  public_id text NOT NULL CHECK (length(public_id) BETWEEN 8 AND 128),
  customer_id uuid,
  customer_name text NOT NULL CHECK (length(btrim(customer_name)) BETWEEN 1 AND 128),
  contact_hash char(64) NOT NULL CHECK (contact_hash ~ '^[0-9a-f]{64}$'),
  encrypted_contact bytea NOT NULL CHECK (octet_length(encrypted_contact) BETWEEN 16 AND 4096),
  encryption_key_id text NOT NULL CHECK (length(btrim(encryption_key_id)) BETWEEN 2 AND 128),
  masked_contact text NOT NULL CHECK (length(btrim(masked_contact)) BETWEEN 3 AND 64),
  guest_count integer NOT NULL CHECK (guest_count BETWEEN 1 AND 200),
  desired_arrival_at timestamptz NOT NULL,
  source text NOT NULL CHECK (source IN ('wechat', 'phone', 'walk_in', 'employee')),
  status text NOT NULL DEFAULT 'waiting'
    CHECK (status IN ('waiting', 'notified', 'arrived', 'seated', 'cancelled', 'expired')),
  owner_employee_id uuid,
  note text,
  aggregate_version bigint NOT NULL DEFAULT 1 CHECK (aggregate_version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, customer_id)
    REFERENCES mbox.customers(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, owner_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, public_id),
  UNIQUE (tenant_id, store_id, id)
);

CREATE INDEX waitlist_entries_queue_idx
  ON mbox.waitlist_entries (tenant_id, store_id, status, desired_arrival_at, created_at, id);

CREATE UNIQUE INDEX waitlist_entries_active_contact_uq
  ON mbox.waitlist_entries (tenant_id, store_id, contact_hash)
  WHERE status IN ('waiting', 'notified', 'arrived');

CREATE TABLE mbox.waitlist_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  waitlist_entry_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type ~ '^waitlist\.[a-z0-9_.-]{2,96}$'),
  from_status text,
  to_status text NOT NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('guest', 'employee', 'system')),
  actor_ref_hash char(64) CHECK (actor_ref_hash IS NULL OR actor_ref_hash ~ '^[0-9a-f]{64}$'),
  reason text,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id, waitlist_entry_id)
    REFERENCES mbox.waitlist_entries(tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, id)
);

CREATE TRIGGER public_reservation_policies_touch_updated_at
  BEFORE UPDATE ON mbox.public_reservation_policies
  FOR EACH ROW EXECUTE FUNCTION mbox.touch_updated_at();
CREATE TRIGGER reservation_guest_sessions_touch_updated_at
  BEFORE UPDATE ON mbox.reservation_guest_sessions
  FOR EACH ROW EXECUTE FUNCTION mbox.touch_updated_at();
CREATE TRIGGER public_reservation_rate_limits_touch_updated_at
  BEFORE UPDATE ON mbox.public_reservation_rate_limits
  FOR EACH ROW EXECUTE FUNCTION mbox.touch_updated_at();
CREATE TRIGGER reservation_private_contacts_touch_updated_at
  BEFORE UPDATE ON mbox.reservation_private_contacts
  FOR EACH ROW EXECUTE FUNCTION mbox.touch_updated_at();
CREATE TRIGGER waitlist_entries_touch_updated_at
  BEFORE UPDATE ON mbox.waitlist_entries
  FOR EACH ROW EXECUTE FUNCTION mbox.touch_updated_at();
CREATE TRIGGER waitlist_events_append_only
  BEFORE UPDATE OR DELETE ON mbox.waitlist_events
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'public_reservation_policies', 'reservation_guest_sessions',
    'public_reservation_rate_limits', 'reservation_private_contacts',
    'waitlist_entries', 'waitlist_events'
  ] LOOP
    EXECUTE format('ALTER TABLE mbox.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE mbox.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_store_isolation ON mbox.%I '
      'USING (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id()) '
      'WITH CHECK (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id())',
      table_name
    );
    EXECUTE format('REVOKE ALL ON TABLE mbox.%I FROM PUBLIC', table_name);
  END LOOP;
END $$;

GRANT SELECT ON TABLE mbox.public_reservation_policies TO mbox_runtime;
GRANT SELECT, INSERT, UPDATE ON TABLE mbox.reservation_guest_sessions TO mbox_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE mbox.public_reservation_rate_limits TO mbox_runtime;
GRANT SELECT, INSERT, UPDATE ON TABLE mbox.reservation_private_contacts TO mbox_runtime;
GRANT SELECT, INSERT, UPDATE ON TABLE mbox.waitlist_entries TO mbox_runtime;
GRANT SELECT, INSERT ON TABLE mbox.waitlist_events TO mbox_runtime;

COMMENT ON TABLE mbox.reservation_guest_sessions IS
  'Short-lived public reservation identity sessions. Raw bearer and identity assertions are never stored.';
COMMENT ON TABLE mbox.reservation_private_contacts IS
  'Restricted reservation contacts encrypted by the application; public APIs expose only masked_contact.';
COMMENT ON TABLE mbox.waitlist_entries IS
  'Waitlist intake is distinct from reservations and walk-in table sessions.';

COMMIT;
