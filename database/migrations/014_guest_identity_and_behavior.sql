BEGIN;

CREATE TABLE mbox.guest_profiles (
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  anonymous_id uuid NOT NULL,
  member_id text,
  wechat_principal_id text,
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  visit_count integer NOT NULL DEFAULT 0 CHECK (visit_count >= 0),
  PRIMARY KEY (tenant_id, store_id, anonymous_id),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  CONSTRAINT guest_profiles_seen_order CHECK (last_seen_at >= first_seen_at)
);

CREATE INDEX guest_profiles_member_idx
  ON mbox.guest_profiles (tenant_id, store_id, member_id)
  WHERE member_id IS NOT NULL;

CREATE INDEX guest_profiles_wechat_idx
  ON mbox.guest_profiles (tenant_id, store_id, wechat_principal_id)
  WHERE wechat_principal_id IS NOT NULL;

CREATE TABLE mbox.guest_behavior_events (
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  event_id uuid NOT NULL,
  anonymous_id uuid NOT NULL,
  table_session_id text NOT NULL,
  table_code text NOT NULL,
  business_date date NOT NULL,
  event_type text NOT NULL CHECK (event_type IN (
    'session_started', 'tab_viewed', 'mood_selected', 'service_requested',
    'service_feedback', 'category_viewed', 'product_added', 'product_removed',
    'cart_cleared', 'cart_submitted', 'order_created', 'checkout_started',
    'payment_completed', 'singer_profile_viewed', 'song_requested'
  )),
  source text NOT NULL CHECK (source IN (
    'guest_web', 'miniprogram', 'service_account', 'staff_assisted'
  )),
  occurred_at timestamptz NOT NULL,
  metadata jsonb NOT NULL CHECK (jsonb_typeof(metadata) = 'object'),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  PRIMARY KEY (tenant_id, store_id, event_id),
  UNIQUE (tenant_id, store_id, idempotency_key),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, anonymous_id)
    REFERENCES mbox.guest_profiles (tenant_id, store_id, anonymous_id)
);

CREATE INDEX guest_behavior_events_profile_time_idx
  ON mbox.guest_behavior_events (tenant_id, store_id, anonymous_id, occurred_at DESC);

CREATE INDEX guest_behavior_events_type_time_idx
  ON mbox.guest_behavior_events (tenant_id, store_id, event_type, occurred_at DESC);

CREATE INDEX guest_behavior_events_visit_idx
  ON mbox.guest_behavior_events (tenant_id, store_id, table_session_id, occurred_at);

CREATE TRIGGER guest_behavior_events_append_only
BEFORE UPDATE OR DELETE ON mbox.guest_behavior_events
FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();

ALTER TABLE mbox.guest_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.guest_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.guest_profiles
  USING (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id())
  WITH CHECK (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id());

ALTER TABLE mbox.guest_behavior_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.guest_behavior_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.guest_behavior_events
  USING (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id())
  WITH CHECK (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id());

COMMENT ON TABLE mbox.guest_profiles IS
  'Store-scoped pseudonymous guest identities that may later link to WeChat or membership without rewriting history.';
COMMENT ON TABLE mbox.guest_behavior_events IS
  'Append-only service, mood, menu, order, payment and entertainment behavior evidence for service-quality analysis.';

GRANT SELECT, INSERT, UPDATE ON mbox.guest_profiles TO mbox_app;
GRANT SELECT, INSERT ON mbox.guest_behavior_events TO mbox_app;

COMMIT;
