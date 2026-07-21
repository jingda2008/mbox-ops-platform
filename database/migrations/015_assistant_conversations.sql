BEGIN;

CREATE TABLE mbox.assistant_conversation_sessions (
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  session_id uuid NOT NULL,
  actor_id text NOT NULL,
  business_date date NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, store_id, session_id),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  CONSTRAINT assistant_session_time_order CHECK (
    updated_at >= created_at AND expires_at > updated_at
  )
);

CREATE INDEX assistant_sessions_actor_time_idx
  ON mbox.assistant_conversation_sessions (tenant_id, store_id, actor_id, updated_at DESC);

CREATE INDEX assistant_sessions_expiry_idx
  ON mbox.assistant_conversation_sessions (tenant_id, store_id, expires_at);

CREATE TABLE mbox.assistant_conversation_turns (
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  session_id uuid NOT NULL,
  request_id uuid NOT NULL,
  actor_id text NOT NULL,
  user_message text NOT NULL CHECK (length(user_message) BETWEEN 1 AND 600),
  output jsonb NOT NULL CHECK (jsonb_typeof(output) = 'object'),
  model text NOT NULL CHECK (length(model) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, store_id, session_id, request_id),
  FOREIGN KEY (tenant_id, store_id, session_id)
    REFERENCES mbox.assistant_conversation_sessions (tenant_id, store_id, session_id)
    ON DELETE CASCADE
);

CREATE INDEX assistant_turns_session_time_idx
  ON mbox.assistant_conversation_turns (tenant_id, store_id, session_id, created_at);

ALTER TABLE mbox.assistant_conversation_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.assistant_conversation_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.assistant_conversation_sessions
  USING (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id())
  WITH CHECK (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id());

ALTER TABLE mbox.assistant_conversation_turns ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.assistant_conversation_turns FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.assistant_conversation_turns
  USING (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id())
  WITH CHECK (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id());

COMMENT ON TABLE mbox.assistant_conversation_sessions IS
  'Short-lived store-scoped employee assistant sessions; records expire after seven days.';
COMMENT ON TABLE mbox.assistant_conversation_turns IS
  'Bounded multi-turn employee requests and structured assistant plans; never stores API keys or audio.';

GRANT SELECT, INSERT, UPDATE, DELETE ON mbox.assistant_conversation_sessions TO mbox_app;
GRANT SELECT, INSERT ON mbox.assistant_conversation_turns TO mbox_app;

COMMIT;
