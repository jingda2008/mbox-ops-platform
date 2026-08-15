BEGIN;

CREATE TABLE mbox.customer_notification_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  channel text NOT NULL CHECK (channel IN ('wechat', 'sms')),
  purpose text NOT NULL CHECK (purpose IN ('transactional_service')),
  decision text NOT NULL CHECK (decision IN ('granted', 'revoked')),
  consent_version integer NOT NULL CHECK (consent_version > 0),
  policy_version text NOT NULL CHECK (length(btrim(policy_version)) BETWEEN 1 AND 64),
  source text NOT NULL CHECK (source IN (
    'legacy_migration', 'customer_self_service', 'wechat_authorization',
    'reservation', 'member_portal', 'staff_record', 'import'
  )),
  source_reference text,
  actor_type text NOT NULL CHECK (actor_type IN ('customer', 'employee', 'integration', 'system')),
  actor_ref text,
  evidence_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(evidence_snapshot) = 'object'),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, customer_id) REFERENCES mbox.customers(tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, customer_id, channel, purpose, consent_version),
  UNIQUE (tenant_id, store_id, id)
);

CREATE INDEX customer_notification_consents_latest_idx
  ON mbox.customer_notification_consents (
    tenant_id, store_id, customer_id, channel, purpose, consent_version DESC, id DESC
  );

INSERT INTO mbox.customer_notification_consents (
  tenant_id, store_id, customer_id, channel, purpose, decision, consent_version,
  policy_version, source, source_reference, actor_type, actor_ref, evidence_snapshot,
  occurred_at
)
SELECT profile.tenant_id, profile.store_id, profile.customer_id, legacy.channel,
  'transactional_service', 'granted', 1, 'legacy-v1', 'legacy_migration', profile.id::text,
  'system', 'migration-048', '{}'::jsonb, profile.updated_at
FROM mbox.customer_profiles AS profile
CROSS JOIN LATERAL (VALUES
  ('wechat'::text, profile.consent_snapshot->>'wechatNotifications'),
  ('sms'::text, profile.consent_snapshot->>'smsNotifications')
) AS legacy(channel, granted)
WHERE legacy.granted = 'true'
ON CONFLICT (tenant_id, store_id, customer_id, channel, purpose, consent_version) DO NOTHING;

CREATE TRIGGER customer_notification_consents_append_only
  BEFORE UPDATE OR DELETE ON mbox.customer_notification_consents
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();

ALTER TABLE mbox.customer_notification_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.customer_notification_consents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.customer_notification_consents
  USING (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id())
  WITH CHECK (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id());

GRANT SELECT, INSERT ON TABLE mbox.customer_notification_consents TO mbox_runtime;

COMMENT ON TABLE mbox.customer_notification_consents IS
  'Append-only, versioned customer notification consent. Runtime authorization must use the latest typed decision, never customer_profiles.consent_snapshot.';

COMMIT;
