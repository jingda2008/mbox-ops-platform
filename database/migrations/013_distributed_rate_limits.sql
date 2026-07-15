BEGIN;

CREATE TABLE mbox.rate_limit_windows (
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  scope varchar(64) NOT NULL CHECK (scope ~ '^[a-z][a-z0-9_.:-]{2,63}$'),
  key_hash char(64) NOT NULL CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  window_started_at timestamptz NOT NULL,
  hit_count bigint NOT NULL CHECK (hit_count > 0),
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, store_id, scope, key_hash),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  CONSTRAINT rate_limit_windows_expiry_order CHECK (expires_at > window_started_at)
);

CREATE INDEX rate_limit_windows_expiry_idx
  ON mbox.rate_limit_windows (tenant_id, store_id, expires_at, scope, key_hash);

ALTER TABLE mbox.rate_limit_windows ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.rate_limit_windows FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.rate_limit_windows
  USING (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id())
  WITH CHECK (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id());

CREATE OR REPLACE FUNCTION mbox.cleanup_expired_rate_limits(p_batch_size integer DEFAULT 1000)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, mbox
AS $$
DECLARE
  deleted_count integer;
BEGIN
  IF p_batch_size < 1 OR p_batch_size > 10000 THEN
    RAISE EXCEPTION 'rate limit cleanup batch size must be between 1 and 10000'
      USING ERRCODE = '22023';
  END IF;

  DELETE FROM mbox.rate_limit_windows
  WHERE ctid IN (
    SELECT ctid
    FROM mbox.rate_limit_windows
    WHERE tenant_id = mbox.current_tenant_id()
      AND store_id = mbox.current_store_id()
      AND expires_at <= clock_timestamp()
    ORDER BY expires_at, scope, key_hash
    LIMIT p_batch_size
    FOR UPDATE SKIP LOCKED
  );

  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

COMMENT ON TABLE mbox.rate_limit_windows IS
  'Tenant/store-scoped fixed-window counters. Only HMAC-SHA256 request-key digests are persisted; raw IP addresses and credentials are forbidden.';
COMMENT ON FUNCTION mbox.cleanup_expired_rate_limits(integer) IS
  'Deletes one bounded batch of expired rate-limit rows visible under the caller transaction RLS context.';

COMMIT;
