BEGIN;

CREATE TABLE mbox.customer_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  identity_kind text NOT NULL CHECK (identity_kind IN ('anonymous', 'wechat', 'member', 'manual')),
  identity_hash char(64) NOT NULL CHECK (identity_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  linked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, customer_id) REFERENCES mbox.customers(tenant_id, store_id, id),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  UNIQUE (tenant_id, store_id, identity_kind, identity_hash),
  UNIQUE (tenant_id, store_id, id)
);

INSERT INTO mbox.customer_identities (
  tenant_id, store_id, customer_id, identity_kind, identity_hash
)
SELECT tenant_id, store_id, id, identity_kind, identity_hash
FROM mbox.customers
WHERE identity_hash IS NOT NULL
ON CONFLICT (tenant_id, store_id, identity_kind, identity_hash) DO NOTHING;

CREATE INDEX customer_identities_customer_idx
  ON mbox.customer_identities (tenant_id, store_id, customer_id, status, identity_kind);

CREATE TABLE mbox.customer_tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  tag text NOT NULL CHECK (length(btrim(tag)) BETWEEN 1 AND 64),
  visibility text NOT NULL DEFAULT 'staff' CHECK (visibility IN ('public', 'staff')),
  source text NOT NULL DEFAULT 'profile' CHECK (length(btrim(source)) BETWEEN 1 AND 64),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, customer_id) REFERENCES mbox.customers(tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, customer_id, tag),
  UNIQUE (tenant_id, store_id, id)
);

INSERT INTO mbox.customer_tags (tenant_id, store_id, customer_id, tag)
SELECT profile.tenant_id, profile.store_id, profile.customer_id, btrim(tag)
FROM mbox.customer_profiles AS profile
CROSS JOIN LATERAL unnest(profile.tags) AS tag
WHERE length(btrim(tag)) > 0
ON CONFLICT (tenant_id, store_id, customer_id, tag) DO NOTHING;

CREATE TABLE mbox.customer_preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  preference_key text NOT NULL CHECK (preference_key ~ '^[A-Za-z][A-Za-z0-9_.-]{0,63}$'),
  preference_value jsonb NOT NULL,
  visibility text NOT NULL DEFAULT 'staff' CHECK (visibility IN ('public', 'staff')),
  source text NOT NULL DEFAULT 'profile' CHECK (length(btrim(source)) BETWEEN 1 AND 64),
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, customer_id) REFERENCES mbox.customers(tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, customer_id, preference_key),
  UNIQUE (tenant_id, store_id, id)
);

INSERT INTO mbox.customer_preferences (
  tenant_id, store_id, customer_id, preference_key, preference_value
)
SELECT profile.tenant_id, profile.store_id, profile.customer_id, preference.key, preference.value
FROM mbox.customer_profiles AS profile
CROSS JOIN LATERAL jsonb_each(profile.preferences) AS preference
ON CONFLICT (tenant_id, store_id, customer_id, preference_key) DO NOTHING;

DROP INDEX mbox.customers_identity_hash_uq;
ALTER TABLE mbox.customers
  DROP COLUMN identity_kind,
  DROP COLUMN identity_hash;
ALTER TABLE mbox.customer_profiles
  DROP COLUMN tags,
  DROP COLUMN preferences;

CREATE TABLE mbox.customer_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9_.-]{2,127}$'),
  table_session_id uuid,
  event_data jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(event_data) = 'object'),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, customer_id) REFERENCES mbox.customers(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, table_session_id) REFERENCES mbox.table_sessions(tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, id)
);

CREATE INDEX customer_events_timeline_idx
  ON mbox.customer_events (tenant_id, store_id, customer_id, occurred_at DESC, id DESC);

ALTER TABLE mbox.benefits
  ADD COLUMN quantity_total integer NOT NULL DEFAULT 1 CHECK (quantity_total > 0),
  ADD COLUMN quantity_reserved integer NOT NULL DEFAULT 0 CHECK (quantity_reserved >= 0),
  ADD COLUMN quantity_redeemed integer NOT NULL DEFAULT 0 CHECK (quantity_redeemed >= 0),
  ADD COLUMN issuance_idempotency_key text,
  ADD COLUMN issuance_fingerprint text,
  ADD COLUMN authorization_source jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(authorization_source) = 'object'),
  ADD COLUMN issuance_reason text,
  ADD COLUMN authorization_limit_id uuid,
  ADD COLUMN aggregate_version bigint NOT NULL DEFAULT 1 CHECK (aggregate_version > 0),
  ADD CONSTRAINT benefits_quantity_balance_ck
    CHECK (quantity_reserved + quantity_redeemed <= quantity_total),
  ADD CONSTRAINT benefits_issuance_idempotency_pair_ck
    CHECK ((issuance_idempotency_key IS NULL) = (issuance_fingerprint IS NULL)),
  ADD CONSTRAINT benefits_manual_reason_ck
    CHECK (issued_by_employee_id IS NULL OR length(btrim(issuance_reason)) > 0),
  ADD CONSTRAINT benefits_manual_authorization_ck
    CHECK (
      (issued_by_employee_id IS NULL AND authorization_limit_id IS NULL)
      OR (
        issued_by_employee_id IS NOT NULL
        AND authorization_limit_id IS NOT NULL
        AND authorization_source <> '{}'::jsonb
      )
    ),
  ADD CONSTRAINT benefits_authorization_limit_fk
    FOREIGN KEY (tenant_id, store_id, authorization_limit_id)
    REFERENCES mbox.role_approval_limits(tenant_id, store_id, id);

UPDATE mbox.benefits
SET issuance_idempotency_key = benefit_snapshot->>'issuanceIdempotencyKey',
    issuance_fingerprint = benefit_snapshot->>'issuanceFingerprint',
    authorization_source = COALESCE(benefit_snapshot->'authorizationSource', '{}'::jsonb),
    issuance_reason = CASE
      WHEN issued_by_employee_id IS NULL THEN NULL
      ELSE COALESCE(NULLIF(benefit_snapshot->>'reason', ''), 'legacy import')
    END
WHERE benefit_snapshot ? 'issuanceIdempotencyKey';

CREATE UNIQUE INDEX benefits_issuance_idempotency_uq
  ON mbox.benefits (tenant_id, store_id, issuance_idempotency_key)
  WHERE issuance_idempotency_key IS NOT NULL;

CREATE TABLE mbox.benefit_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  benefit_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  table_session_id uuid NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  status text NOT NULL DEFAULT 'reserved'
    CHECK (status IN ('reserved', 'redeemed', 'cancelled', 'expired')),
  reservation_idempotency_key text NOT NULL CHECK (length(reservation_idempotency_key) BETWEEN 8 AND 128),
  reservation_fingerprint text NOT NULL CHECK (length(reservation_fingerprint) > 0),
  reserved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  cancel_reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, benefit_id) REFERENCES mbox.benefits(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, customer_id) REFERENCES mbox.customers(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, table_session_id) REFERENCES mbox.table_sessions(tenant_id, store_id, id),
  CHECK (expires_at > reserved_at),
  CHECK (expires_at <= reserved_at + interval '30 minutes'),
  CHECK (
    (status = 'reserved' AND completed_at IS NULL AND cancel_reason IS NULL)
    OR (status = 'redeemed' AND completed_at IS NOT NULL AND cancel_reason IS NULL)
    OR (status IN ('cancelled', 'expired') AND completed_at IS NOT NULL AND length(btrim(cancel_reason)) > 0)
  ),
  UNIQUE (tenant_id, store_id, reservation_idempotency_key),
  UNIQUE (tenant_id, store_id, id)
);

CREATE INDEX benefit_reservations_active_idx
  ON mbox.benefit_reservations (tenant_id, store_id, customer_id, table_session_id, expires_at, id)
  WHERE status = 'reserved';

CREATE TABLE mbox.benefit_redemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  benefit_id uuid NOT NULL,
  benefit_reservation_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  table_session_id uuid NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  redemption_idempotency_key text NOT NULL CHECK (length(redemption_idempotency_key) BETWEEN 8 AND 128),
  redemption_fingerprint text NOT NULL CHECK (length(redemption_fingerprint) > 0),
  redeemed_by_employee_id uuid,
  gift_order_reference text,
  redeemed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, benefit_id) REFERENCES mbox.benefits(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, benefit_reservation_id)
    REFERENCES mbox.benefit_reservations(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, customer_id) REFERENCES mbox.customers(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, table_session_id) REFERENCES mbox.table_sessions(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, redeemed_by_employee_id) REFERENCES mbox.employees(tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, benefit_reservation_id),
  UNIQUE (tenant_id, store_id, redemption_idempotency_key),
  UNIQUE (tenant_id, store_id, id)
);

CREATE OR REPLACE FUNCTION mbox.prevent_customer_merge_cycle()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.merged_into_customer_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.merged_into_customer_id = NEW.id THEN
    RAISE EXCEPTION 'customer cannot merge into itself' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    WITH RECURSIVE ancestors(id, merged_into_customer_id) AS (
      SELECT customer.id, customer.merged_into_customer_id
      FROM mbox.customers AS customer
      WHERE customer.tenant_id = NEW.tenant_id
        AND customer.store_id = NEW.store_id
        AND customer.id = NEW.merged_into_customer_id
      UNION ALL
      SELECT customer.id, customer.merged_into_customer_id
      FROM mbox.customers AS customer
      JOIN ancestors ON customer.id = ancestors.merged_into_customer_id
      WHERE customer.tenant_id = NEW.tenant_id AND customer.store_id = NEW.store_id
    )
    SELECT 1 FROM ancestors WHERE id = NEW.id
  ) THEN
    RAISE EXCEPTION 'customer merge cycle is not allowed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER customers_prevent_merge_cycle
  BEFORE INSERT OR UPDATE OF merged_into_customer_id ON mbox.customers
  FOR EACH ROW EXECUTE FUNCTION mbox.prevent_customer_merge_cycle();

CREATE TRIGGER customer_events_append_only
  BEFORE UPDATE OR DELETE ON mbox.customer_events
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();
CREATE TRIGGER benefit_redemptions_append_only
  BEFORE UPDATE OR DELETE ON mbox.benefit_redemptions
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'customer_identities', 'customer_preferences', 'benefit_reservations'
  ]
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I_touch_updated_at BEFORE UPDATE ON mbox.%I '
      'FOR EACH ROW EXECUTE FUNCTION mbox.touch_updated_at()',
      table_name, table_name
    );
  END LOOP;
END $$;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'customer_identities', 'customer_tags', 'customer_preferences',
    'customer_events', 'benefit_reservations', 'benefit_redemptions'
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

GRANT SELECT, INSERT, UPDATE ON TABLE mbox.customer_identities TO mbox_runtime;
GRANT SELECT, INSERT, DELETE ON TABLE mbox.customer_tags TO mbox_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE mbox.customer_preferences TO mbox_runtime;
GRANT SELECT, INSERT ON TABLE mbox.customer_events TO mbox_runtime;
GRANT SELECT, INSERT, UPDATE ON TABLE mbox.benefit_reservations TO mbox_runtime;
GRANT SELECT, INSERT ON TABLE mbox.benefit_redemptions TO mbox_runtime;

INSERT INTO mbox.staff_permission_definitions (
  tenant_id, store_id, code, name, category, description, status
)
SELECT store.tenant_id, store.id, permission.code, permission.name,
  'customer_benefit', permission.description, 'active'
FROM mbox.stores AS store
CROSS JOIN (VALUES
  ('customer.view', '查看客户资料', '查看客户画像、标签和服务历史'),
  ('customer.manage', '管理客户资料', '更新画像、绑定身份和合并客户'),
  ('benefit.view', '查看客户权益', '查看客户权益和使用记录'),
  ('benefit.issue', '发放客户权益', '按审批额度人工发放客户权益'),
  ('benefit.redeem', '核销客户权益', '为当前桌次客户核销已预约权益'),
  ('benefit.cancel', '取消权益预约', '取消未核销的权益预约')
) AS permission(code, name, description)
ON CONFLICT (tenant_id, store_id, code) DO UPDATE
SET name = EXCLUDED.name, category = EXCLUDED.category,
    description = EXCLUDED.description, status = 'active';

GRANT EXECUTE ON FUNCTION mbox.prevent_customer_merge_cycle() TO mbox_runtime;

COMMENT ON TABLE mbox.customer_identities IS
  'Hashed anonymous, WeChat and membership identities. Raw identifiers are never stored.';
COMMENT ON TABLE mbox.customer_events IS
  'Append-oriented customer history for normalized operational analytics.';
COMMENT ON TABLE mbox.benefit_reservations IS
  'Table-session-bound reservation of benefit quantity before redemption.';
COMMENT ON TABLE mbox.benefit_redemptions IS
  'One immutable redemption fact per benefit reservation.';

COMMIT;
