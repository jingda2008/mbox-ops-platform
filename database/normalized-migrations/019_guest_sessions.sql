BEGIN;

CREATE TABLE mbox.table_qr_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  table_id uuid NOT NULL,
  qr_version integer NOT NULL CHECK (qr_version > 0),
  credential_hash char(64) NOT NULL CHECK (credential_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'rotated', 'revoked')),
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, table_id) REFERENCES mbox.tables(tenant_id, store_id, id),
  CHECK ((status = 'active') = (retired_at IS NULL)),
  UNIQUE (tenant_id, store_id, credential_hash),
  UNIQUE (tenant_id, store_id, id)
);

CREATE UNIQUE INDEX table_qr_credentials_one_active_table_uq
  ON mbox.table_qr_credentials (tenant_id, store_id, table_id)
  WHERE status = 'active';

CREATE TABLE mbox.guest_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  session_kind text NOT NULL CHECK (session_kind IN ('table', 'reservation', 'member')),
  customer_id uuid NOT NULL,
  table_session_id uuid,
  reservation_id uuid,
  token_hash char(64) NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  device_hash char(64) NOT NULL CHECK (device_hash ~ '^[0-9a-f]{64}$'),
  scopes text[] NOT NULL CHECK (
    cardinality(scopes) BETWEEN 1 AND 12
    AND scopes <@ ARRAY[
      'guest.session.read', 'guest.menu.read', 'guest.order.create',
      'guest.service.create', 'guest.song.request', 'guest.reservation.read',
      'guest.reservation.update', 'guest.member.read', 'guest.benefit.read'
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
  FOREIGN KEY (tenant_id, store_id, customer_id) REFERENCES mbox.customers(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, table_session_id)
    REFERENCES mbox.table_sessions(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, reservation_id)
    REFERENCES mbox.reservations(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, table_session_id, customer_id)
    REFERENCES mbox.table_session_customers(tenant_id, store_id, table_session_id, customer_id),
  CHECK (expires_at > issued_at AND expires_at <= issued_at + interval '2 hours'),
  CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL)),
  CHECK (
    (session_kind = 'table'
      AND table_session_id IS NOT NULL
      AND reservation_id IS NULL
      AND scopes <@ ARRAY[
        'guest.session.read', 'guest.menu.read', 'guest.order.create',
        'guest.service.create', 'guest.song.request'
      ]::text[])
    OR
    (session_kind = 'reservation'
      AND table_session_id IS NULL
      AND reservation_id IS NOT NULL
      AND scopes <@ ARRAY[
        'guest.session.read', 'guest.reservation.read', 'guest.reservation.update'
      ]::text[])
    OR
    (session_kind = 'member'
      AND table_session_id IS NULL
      AND reservation_id IS NULL
      AND scopes <@ ARRAY[
        'guest.session.read', 'guest.member.read', 'guest.benefit.read'
      ]::text[])
  ),
  UNIQUE (tenant_id, store_id, token_hash),
  UNIQUE (tenant_id, store_id, id)
);

CREATE UNIQUE INDEX guest_sessions_one_live_table_device_uq
  ON mbox.guest_sessions (tenant_id, store_id, table_session_id, device_hash)
  WHERE session_kind = 'table' AND revoked_at IS NULL;
CREATE INDEX guest_sessions_token_lookup_idx
  ON mbox.guest_sessions (tenant_id, store_id, token_hash, expires_at)
  WHERE revoked_at IS NULL;
CREATE INDEX guest_sessions_table_revoke_idx
  ON mbox.guest_sessions (tenant_id, store_id, table_session_id, id)
  WHERE session_kind = 'table' AND revoked_at IS NULL;

CREATE TABLE mbox.guest_session_rate_limits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  attempt_kind text NOT NULL CHECK (attempt_kind IN ('table_scan', 'invalid_token')),
  principal_hash char(64) NOT NULL CHECK (principal_hash ~ '^[0-9a-f]{64}$'),
  window_started_at timestamptz NOT NULL,
  attempt_count integer NOT NULL DEFAULT 1 CHECK (attempt_count > 0),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  CHECK (expires_at > window_started_at),
  UNIQUE (tenant_id, store_id, attempt_kind, principal_hash),
  UNIQUE (tenant_id, store_id, id)
);

CREATE INDEX guest_session_rate_limits_expiry_idx
  ON mbox.guest_session_rate_limits (expires_at, id);

CREATE TABLE mbox.guest_session_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  guest_session_id uuid,
  table_id uuid,
  table_session_id uuid,
  event_type text NOT NULL CHECK (event_type ~ '^guest_session\.[a-z0-9_.-]{2,96}$'),
  outcome text NOT NULL CHECK (outcome IN ('succeeded', 'denied', 'rate_limited', 'revoked')),
  reason_code text CHECK (reason_code IS NULL OR reason_code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, guest_session_id)
    REFERENCES mbox.guest_sessions(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, table_id)
    REFERENCES mbox.tables(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, table_session_id)
    REFERENCES mbox.table_sessions(tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, id)
);

CREATE INDEX guest_session_events_timeline_idx
  ON mbox.guest_session_events (tenant_id, store_id, occurred_at DESC, id);
CREATE INDEX guest_session_events_session_idx
  ON mbox.guest_session_events (tenant_id, store_id, guest_session_id, occurred_at DESC, id)
  WHERE guest_session_id IS NOT NULL;

CREATE OR REPLACE FUNCTION mbox.revoke_guest_sessions_when_table_session_ends()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'open' AND NEW.status <> 'open' THEN
    WITH revoked AS (
      UPDATE mbox.guest_sessions
      SET revoked_at = clock_timestamp(),
          revoke_reason = 'table_session_ended'
      WHERE tenant_id = NEW.tenant_id
        AND store_id = NEW.store_id
        AND table_session_id = NEW.id
        AND revoked_at IS NULL
      RETURNING id, customer_id
    )
    INSERT INTO mbox.guest_session_events (
      tenant_id, store_id, guest_session_id, table_id, table_session_id,
      event_type, outcome, reason_code, metadata
    )
    SELECT NEW.tenant_id, NEW.store_id, revoked.id, NEW.table_id, NEW.id,
      'guest_session.revoked', 'revoked', 'TABLE_SESSION_ENDED',
      jsonb_build_object('newStatus', NEW.status)
    FROM revoked;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER table_sessions_revoke_guest_sessions
  AFTER UPDATE OF status ON mbox.table_sessions
  FOR EACH ROW EXECUTE FUNCTION mbox.revoke_guest_sessions_when_table_session_ends();

CREATE TRIGGER guest_sessions_touch_updated_at
  BEFORE UPDATE ON mbox.guest_sessions
  FOR EACH ROW EXECUTE FUNCTION mbox.touch_updated_at();
CREATE TRIGGER guest_session_rate_limits_touch_updated_at
  BEFORE UPDATE ON mbox.guest_session_rate_limits
  FOR EACH ROW EXECUTE FUNCTION mbox.touch_updated_at();
CREATE TRIGGER guest_session_events_append_only
  BEFORE UPDATE OR DELETE ON mbox.guest_session_events
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'table_qr_credentials', 'guest_sessions',
    'guest_session_rate_limits', 'guest_session_events'
  ]
  LOOP
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

GRANT SELECT ON TABLE mbox.table_qr_credentials TO mbox_runtime;
GRANT SELECT, INSERT, UPDATE ON TABLE mbox.guest_sessions TO mbox_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE mbox.guest_session_rate_limits TO mbox_runtime;
GRANT SELECT, INSERT ON TABLE mbox.guest_session_events TO mbox_runtime;
GRANT EXECUTE ON FUNCTION mbox.revoke_guest_sessions_when_table_session_ends() TO mbox_runtime;

COMMENT ON TABLE mbox.table_qr_credentials IS
  'Fixed physical table QR credentials. Only HMAC digests are stored.';
COMMENT ON TABLE mbox.guest_sessions IS
  'Short-lived least-privilege guest sessions. Raw bearer tokens and device identifiers are never stored.';
COMMENT ON TABLE mbox.guest_session_events IS
  'Append-only authentication and revocation evidence without raw credentials or customer PII.';

COMMIT;
