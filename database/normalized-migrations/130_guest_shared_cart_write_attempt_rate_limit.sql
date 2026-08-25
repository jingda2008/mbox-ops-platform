BEGIN;

-- Successful cart operations alone are not a rate limiter: a stolen guest
-- session could otherwise send unlimited stale-version or invalid-product
-- writes because the surrounding business transaction rolls back.  Record the
-- authenticated HTTP write attempt in its own committed transaction before
-- executing the cart command.  Store only the already-hashed session reference.
CREATE TABLE mbox.guest_shared_cart_write_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  table_session_id uuid NOT NULL,
  actor_session_ref text NOT NULL CHECK (actor_session_ref ~ '^sha256:[0-9a-f]{64}$'),
  operation_id text NOT NULL CHECK (operation_id ~ '^[A-Za-z0-9_-]{8,128}$'),
  action text NOT NULL CHECK (action IN ('adjust','remove','clear','checkout')),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
  FOREIGN KEY (tenant_id,store_id,table_session_id)
    REFERENCES mbox.table_sessions(tenant_id,store_id,id),
  UNIQUE (tenant_id,store_id,id)
);

CREATE INDEX guest_shared_cart_write_attempts_window_idx
  ON mbox.guest_shared_cart_write_attempts(
    tenant_id,store_id,table_session_id,actor_session_ref,occurred_at DESC
  );

ALTER TABLE mbox.guest_shared_cart_write_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.guest_shared_cart_write_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.guest_shared_cart_write_attempts
  USING (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())
  WITH CHECK (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
REVOKE ALL ON TABLE mbox.guest_shared_cart_write_attempts FROM PUBLIC;
GRANT SELECT,INSERT,DELETE ON TABLE mbox.guest_shared_cart_write_attempts TO mbox_runtime;
REVOKE UPDATE ON TABLE mbox.guest_shared_cart_write_attempts FROM mbox_runtime;

COMMENT ON TABLE mbox.guest_shared_cart_write_attempts IS
  'Short-retention security counter for every authenticated cart mutation attempt, including requests whose business transaction fails.';

UPDATE mbox.normalized_schema_metadata
SET schema_version='130',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
