BEGIN;

-- An order reference must prove that it belongs to the same table session as the
-- redemption. The existing order primary business key does not include session.
ALTER TABLE mbox.orders
  ADD CONSTRAINT orders_session_reference_uq
  UNIQUE (tenant_id, store_id, id, table_session_id);

CREATE TABLE mbox.benefit_redemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  member_benefit_id uuid NOT NULL,
  member_id uuid NOT NULL,
  table_session_id uuid NOT NULL,
  order_id uuid,
  quantity integer NOT NULL CHECK (quantity > 0),
  status text NOT NULL DEFAULT 'locked'
    CHECK (status IN ('locked', 'redeemed', 'released', 'expired')),
  currency char(3) NOT NULL DEFAULT 'CNY' CHECK (currency ~ '^[A-Z]{3}$'),
  value_amount_minor_snapshot bigint NOT NULL CHECK (value_amount_minor_snapshot >= 0),
  cost_amount_minor_snapshot bigint NOT NULL CHECK (cost_amount_minor_snapshot >= 0),
  locked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lock_expires_at timestamptz NOT NULL,
  lock_actor_type text NOT NULL CHECK (lock_actor_type IN ('guest', 'employee', 'system', 'integration')),
  lock_actor_employee_id uuid,
  lock_actor_ref text,
  resolved_at timestamptz,
  resolution_actor_type text CHECK (resolution_actor_type IN ('guest', 'employee', 'system', 'integration')),
  resolution_actor_employee_id uuid,
  resolution_actor_ref text,
  resolution_reason text,
  lock_idempotency_key text NOT NULL CHECK (length(lock_idempotency_key) BETWEEN 8 AND 256),
  resolution_idempotency_key text CHECK (length(resolution_idempotency_key) BETWEEN 8 AND 256),
  last_remaining_before integer NOT NULL CHECK (last_remaining_before >= 0),
  last_remaining_after integer NOT NULL CHECK (last_remaining_after >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, member_benefit_id)
    REFERENCES mbox.member_benefits(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, member_id)
    REFERENCES mbox.customer_members(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, table_session_id)
    REFERENCES mbox.table_sessions(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, order_id, table_session_id)
    REFERENCES mbox.orders(tenant_id, store_id, id, table_session_id),
  FOREIGN KEY (tenant_id, store_id, lock_actor_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, resolution_actor_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  CONSTRAINT benefit_redemptions_lock_window CHECK (lock_expires_at > locked_at),
  CONSTRAINT benefit_redemptions_lock_actor_shape CHECK (
    (lock_actor_type = 'employee' AND lock_actor_employee_id IS NOT NULL) OR
    (lock_actor_type <> 'employee' AND lock_actor_employee_id IS NULL)
  ),
  CONSTRAINT benefit_redemptions_resolution_shape CHECK (
    (status = 'locked' AND resolved_at IS NULL AND resolution_actor_type IS NULL
      AND resolution_actor_employee_id IS NULL AND resolution_actor_ref IS NULL
      AND resolution_reason IS NULL AND resolution_idempotency_key IS NULL) OR
    (status <> 'locked' AND resolved_at IS NOT NULL AND resolution_actor_type IS NOT NULL
      AND resolution_idempotency_key IS NOT NULL
      AND ((resolution_actor_type = 'employee' AND resolution_actor_employee_id IS NOT NULL)
        OR (resolution_actor_type <> 'employee' AND resolution_actor_employee_id IS NULL)))
  ),
  CONSTRAINT benefit_redemptions_release_reason CHECK (
    status NOT IN ('released', 'expired') OR length(btrim(resolution_reason)) > 0
  ),
  CONSTRAINT benefit_redemptions_resolution_idempotency_distinct CHECK (
    resolution_idempotency_key IS NULL OR resolution_idempotency_key <> lock_idempotency_key
  ),
  CONSTRAINT benefit_redemptions_lock_idempotency_uq
    UNIQUE (tenant_id, store_id, lock_idempotency_key),
  CONSTRAINT benefit_redemptions_tenant_store_id_uq UNIQUE (tenant_id, store_id, id)
);

CREATE INDEX benefit_redemptions_member_timeline_idx ON mbox.benefit_redemptions
  (tenant_id, store_id, member_id, locked_at DESC, id);
CREATE INDEX benefit_redemptions_session_timeline_idx ON mbox.benefit_redemptions
  (tenant_id, store_id, table_session_id, locked_at DESC, id);
CREATE INDEX benefit_redemptions_expiry_due_idx ON mbox.benefit_redemptions
  (tenant_id, store_id, lock_expires_at, id) WHERE status = 'locked';
CREATE UNIQUE INDEX benefit_redemptions_resolution_idempotency_uq
  ON mbox.benefit_redemptions (tenant_id, store_id, resolution_idempotency_key)
  WHERE resolution_idempotency_key IS NOT NULL;

CREATE OR REPLACE FUNCTION mbox.apply_benefit_redemption()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  benefit_member_id uuid;
  benefit_status text;
  benefit_valid_from timestamptz;
  benefit_valid_until timestamptz;
  benefit_remaining integer;
  benefit_quantity integer;
  template_value bigint;
  template_cost bigint;
  remaining_after integer;
  has_other_lock boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'locked' THEN
      RAISE EXCEPTION 'a benefit redemption must be created in locked status';
    END IF;

    SELECT mb.member_id, mb.status, mb.valid_from, mb.valid_until,
           mb.remaining_quantity, mb.quantity,
           bt.value_amount_minor, bt.cost_amount_minor
      INTO benefit_member_id, benefit_status, benefit_valid_from, benefit_valid_until,
           benefit_remaining, benefit_quantity, template_value, template_cost
      FROM mbox.member_benefits mb
      JOIN mbox.benefit_templates bt
        ON bt.tenant_id = mb.tenant_id
       AND bt.store_id = mb.store_id
       AND bt.id = mb.benefit_template_id
     WHERE mb.tenant_id = NEW.tenant_id
       AND mb.store_id = NEW.store_id
       AND mb.id = NEW.member_benefit_id
     FOR UPDATE OF mb;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'member benefit not found in tenant/store context';
    END IF;
    IF benefit_member_id <> NEW.member_id THEN
      RAISE EXCEPTION 'member benefit does not belong to redemption member';
    END IF;
    IF benefit_status <> 'available'
       OR benefit_valid_from > NEW.locked_at
       OR benefit_valid_until <= NEW.locked_at
       OR benefit_remaining < NEW.quantity THEN
      RAISE EXCEPTION 'member benefit is not available for requested quantity';
    END IF;

    NEW.value_amount_minor_snapshot := template_value;
    NEW.cost_amount_minor_snapshot := template_cost;
    NEW.last_remaining_before := benefit_remaining;
    remaining_after := benefit_remaining - NEW.quantity;
    NEW.last_remaining_after := remaining_after;

    UPDATE mbox.member_benefits
       SET remaining_quantity = remaining_after,
           status = CASE WHEN remaining_after = 0 THEN 'locked' ELSE 'available' END
     WHERE tenant_id = NEW.tenant_id
       AND store_id = NEW.store_id
       AND id = NEW.member_benefit_id;

    RETURN NEW;
  END IF;

  IF OLD.status <> 'locked' OR NEW.status NOT IN ('redeemed', 'released', 'expired') THEN
    RAISE EXCEPTION 'invalid benefit redemption transition: % -> %', OLD.status, NEW.status;
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.store_id IS DISTINCT FROM OLD.store_id
     OR NEW.member_benefit_id IS DISTINCT FROM OLD.member_benefit_id
     OR NEW.member_id IS DISTINCT FROM OLD.member_id
     OR NEW.table_session_id IS DISTINCT FROM OLD.table_session_id
     OR NEW.order_id IS DISTINCT FROM OLD.order_id
     OR NEW.quantity IS DISTINCT FROM OLD.quantity
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.value_amount_minor_snapshot IS DISTINCT FROM OLD.value_amount_minor_snapshot
     OR NEW.cost_amount_minor_snapshot IS DISTINCT FROM OLD.cost_amount_minor_snapshot
     OR NEW.locked_at IS DISTINCT FROM OLD.locked_at
     OR NEW.lock_expires_at IS DISTINCT FROM OLD.lock_expires_at
     OR NEW.lock_actor_type IS DISTINCT FROM OLD.lock_actor_type
     OR NEW.lock_actor_employee_id IS DISTINCT FROM OLD.lock_actor_employee_id
     OR NEW.lock_actor_ref IS DISTINCT FROM OLD.lock_actor_ref
     OR NEW.lock_idempotency_key IS DISTINCT FROM OLD.lock_idempotency_key
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'benefit redemption identity and lock evidence are immutable';
  END IF;

  SELECT remaining_quantity, quantity, valid_until
    INTO benefit_remaining, benefit_quantity, benefit_valid_until
    FROM mbox.member_benefits
   WHERE tenant_id = NEW.tenant_id
     AND store_id = NEW.store_id
     AND id = NEW.member_benefit_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'member benefit not found in tenant/store context';
  END IF;

  NEW.last_remaining_before := benefit_remaining;
  IF NEW.status IN ('released', 'expired') THEN
    remaining_after := benefit_remaining + NEW.quantity;
    IF remaining_after > benefit_quantity THEN
      RAISE EXCEPTION 'benefit release would exceed issued quantity';
    END IF;
    UPDATE mbox.member_benefits
       SET remaining_quantity = remaining_after,
           status = CASE WHEN valid_until <= NEW.resolved_at THEN 'expired' ELSE 'available' END
     WHERE tenant_id = NEW.tenant_id
       AND store_id = NEW.store_id
       AND id = NEW.member_benefit_id;
  ELSE
    remaining_after := benefit_remaining;
    SELECT EXISTS (
      SELECT 1 FROM mbox.benefit_redemptions other
       WHERE other.tenant_id = NEW.tenant_id
         AND other.store_id = NEW.store_id
         AND other.member_benefit_id = NEW.member_benefit_id
         AND other.id <> NEW.id
         AND other.status = 'locked'
    ) INTO has_other_lock;
    UPDATE mbox.member_benefits
       SET status = CASE
         WHEN remaining_quantity > 0 THEN 'available'
         WHEN has_other_lock THEN 'locked'
         ELSE 'redeemed'
       END
     WHERE tenant_id = NEW.tenant_id
       AND store_id = NEW.store_id
       AND id = NEW.member_benefit_id;
  END IF;
  NEW.last_remaining_after := remaining_after;
  RETURN NEW;
END;
$$;

CREATE TRIGGER benefit_redemptions_10_apply
BEFORE INSERT OR UPDATE ON mbox.benefit_redemptions
FOR EACH ROW EXECUTE FUNCTION mbox.apply_benefit_redemption();

CREATE TRIGGER benefit_redemptions_touch_version
BEFORE UPDATE ON mbox.benefit_redemptions
FOR EACH ROW EXECUTE FUNCTION mbox.touch_versioned_row();

CREATE TRIGGER benefit_redemptions_reject_delete
BEFORE DELETE ON mbox.benefit_redemptions
FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();

CREATE TABLE mbox.benefit_redemption_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  redemption_id uuid NOT NULL,
  member_benefit_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('locked', 'redeemed', 'released', 'expired')),
  quantity integer NOT NULL CHECK (quantity > 0),
  remaining_before integer NOT NULL CHECK (remaining_before >= 0),
  remaining_after integer NOT NULL CHECK (remaining_after >= 0),
  actor_type text NOT NULL CHECK (actor_type IN ('guest', 'employee', 'system', 'integration')),
  actor_employee_id uuid,
  actor_ref text,
  reason text,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 256),
  occurred_at timestamptz NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, redemption_id)
    REFERENCES mbox.benefit_redemptions(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, member_benefit_id)
    REFERENCES mbox.member_benefits(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, actor_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  CONSTRAINT benefit_redemption_events_actor_shape CHECK (
    (actor_type = 'employee' AND actor_employee_id IS NOT NULL) OR
    (actor_type <> 'employee' AND actor_employee_id IS NULL)
  ),
  CONSTRAINT benefit_redemption_events_idempotency_uq
    UNIQUE (tenant_id, store_id, idempotency_key),
  CONSTRAINT benefit_redemption_events_tenant_store_id_uq UNIQUE (tenant_id, store_id, id)
);

CREATE INDEX benefit_redemption_events_timeline_idx ON mbox.benefit_redemption_events
  (tenant_id, store_id, redemption_id, occurred_at, id);

CREATE OR REPLACE FUNCTION mbox.record_benefit_redemption_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  INSERT INTO mbox.benefit_redemption_events (
    tenant_id, store_id, redemption_id, member_benefit_id, event_type,
    quantity, remaining_before, remaining_after, actor_type, actor_employee_id,
    actor_ref, reason, idempotency_key, occurred_at
  ) VALUES (
    NEW.tenant_id, NEW.store_id, NEW.id, NEW.member_benefit_id, NEW.status,
    NEW.quantity, NEW.last_remaining_before, NEW.last_remaining_after,
    CASE WHEN NEW.status = 'locked' THEN NEW.lock_actor_type ELSE NEW.resolution_actor_type END,
    CASE WHEN NEW.status = 'locked' THEN NEW.lock_actor_employee_id ELSE NEW.resolution_actor_employee_id END,
    CASE WHEN NEW.status = 'locked' THEN NEW.lock_actor_ref ELSE NEW.resolution_actor_ref END,
    CASE WHEN NEW.status = 'locked' THEN NULL ELSE NEW.resolution_reason END,
    CASE WHEN NEW.status = 'locked' THEN NEW.lock_idempotency_key ELSE NEW.resolution_idempotency_key END,
    CASE WHEN NEW.status = 'locked' THEN NEW.locked_at ELSE NEW.resolved_at END
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER benefit_redemptions_record_event
AFTER INSERT OR UPDATE ON mbox.benefit_redemptions
FOR EACH ROW EXECUTE FUNCTION mbox.record_benefit_redemption_event();

CREATE TRIGGER benefit_redemption_events_append_only
BEFORE UPDATE OR DELETE ON mbox.benefit_redemption_events
FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();

ALTER TABLE mbox.customer_notifications
  DROP CONSTRAINT customer_notifications_status_check;
ALTER TABLE mbox.customer_notifications
  ADD CONSTRAINT customer_notifications_status_check
  CHECK (status IN ('queued', 'sent', 'failed', 'skipped', 'dead_letter'));

ALTER TABLE mbox.customer_notifications
  ADD COLUMN max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
  ADD COLUMN last_attempt_at timestamptz,
  ADD COLUMN last_error_code text,
  ADD COLUMN lease_owner text,
  ADD COLUMN lease_expires_at timestamptz,
  ADD COLUMN dead_lettered_at timestamptz;

UPDATE mbox.customer_notifications
   SET max_attempts = GREATEST(max_attempts, LEAST(attempt_count, 20));

UPDATE mbox.customer_notifications
   SET next_attempt_at = COALESCE(next_attempt_at, queued_at)
 WHERE status IN ('queued', 'failed');

ALTER TABLE mbox.customer_notifications
  ADD CONSTRAINT customer_notifications_attempt_limit_check
    CHECK (attempt_count <= max_attempts),
  ADD CONSTRAINT customer_notifications_delivery_channel_uq
    UNIQUE (tenant_id, store_id, id, channel),
  ADD CONSTRAINT customer_notifications_lease_shape CHECK (
    (lease_owner IS NULL AND lease_expires_at IS NULL) OR
    (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL
      AND status IN ('queued', 'failed'))
  ),
  ADD CONSTRAINT customer_notifications_delivery_shape CHECK (
    (status IN ('queued', 'failed') AND next_attempt_at IS NOT NULL
      AND sent_at IS NULL AND dead_lettered_at IS NULL) OR
    (status = 'sent' AND sent_at IS NOT NULL AND next_attempt_at IS NULL
      AND dead_lettered_at IS NULL AND lease_owner IS NULL AND lease_expires_at IS NULL) OR
    (status = 'skipped' AND sent_at IS NULL AND next_attempt_at IS NULL
      AND dead_lettered_at IS NULL AND lease_owner IS NULL AND lease_expires_at IS NULL) OR
    (status = 'dead_letter' AND sent_at IS NULL AND next_attempt_at IS NULL
      AND dead_lettered_at IS NOT NULL AND lease_owner IS NULL AND lease_expires_at IS NULL)
  );

DROP INDEX mbox.customer_notifications_due_idx;
CREATE INDEX customer_notifications_due_idx ON mbox.customer_notifications
  (tenant_id, store_id, next_attempt_at, queued_at, id)
  WHERE status IN ('queued', 'failed');
CREATE INDEX customer_notifications_lease_recovery_idx ON mbox.customer_notifications
  (tenant_id, store_id, lease_expires_at, id)
  WHERE lease_expires_at IS NOT NULL;
CREATE INDEX customer_notifications_dead_letter_idx ON mbox.customer_notifications
  (tenant_id, store_id, dead_lettered_at DESC, id)
  WHERE status = 'dead_letter';

CREATE TABLE mbox.notification_delivery_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  notification_id uuid NOT NULL,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  channel text NOT NULL CHECK (channel IN ('service_account', 'wecom')),
  outcome text NOT NULL
    CHECK (outcome IN ('succeeded', 'retryable_failed', 'permanent_failed', 'lease_expired')),
  provider_request_id text,
  provider_message_id text,
  http_status integer CHECK (http_status BETWEEN 100 AND 599),
  error_code text,
  error_message text,
  request_fingerprint_sha256 char(64)
    CHECK (request_fingerprint_sha256 IS NULL OR request_fingerprint_sha256 ~ '^[0-9a-f]{64}$'),
  started_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL,
  next_attempt_at timestamptz,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 256),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, notification_id)
    REFERENCES mbox.customer_notifications(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, notification_id, channel)
    REFERENCES mbox.customer_notifications(tenant_id, store_id, id, channel),
  CONSTRAINT notification_delivery_attempts_time_order CHECK (completed_at >= started_at),
  CONSTRAINT notification_delivery_attempts_outcome_shape CHECK (
    (outcome = 'succeeded' AND error_code IS NULL AND error_message IS NULL
      AND next_attempt_at IS NULL) OR
    (outcome = 'retryable_failed' AND COALESCE(error_code, error_message) IS NOT NULL
      AND next_attempt_at IS NOT NULL) OR
    (outcome IN ('permanent_failed', 'lease_expired')
      AND COALESCE(error_code, error_message) IS NOT NULL AND next_attempt_at IS NULL)
  ),
  CONSTRAINT notification_delivery_attempts_number_uq
    UNIQUE (tenant_id, store_id, notification_id, attempt_number),
  CONSTRAINT notification_delivery_attempts_idempotency_uq
    UNIQUE (tenant_id, store_id, idempotency_key),
  CONSTRAINT notification_delivery_attempts_tenant_store_id_uq
    UNIQUE (tenant_id, store_id, id)
);

CREATE UNIQUE INDEX notification_delivery_attempts_provider_request_uq
  ON mbox.notification_delivery_attempts (tenant_id, store_id, channel, provider_request_id)
  WHERE provider_request_id IS NOT NULL;
CREATE INDEX notification_delivery_attempts_notification_timeline_idx
  ON mbox.notification_delivery_attempts
  (tenant_id, store_id, notification_id, attempt_number DESC);
CREATE INDEX notification_delivery_attempts_failure_timeline_idx
  ON mbox.notification_delivery_attempts
  (tenant_id, store_id, outcome, completed_at DESC, id)
  WHERE outcome <> 'succeeded';

CREATE TRIGGER notification_delivery_attempts_append_only
BEFORE UPDATE OR DELETE ON mbox.notification_delivery_attempts
FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();

ALTER TABLE mbox.benefit_redemptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.benefit_redemptions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.benefit_redemptions
  USING (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id())
  WITH CHECK (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id());

ALTER TABLE mbox.benefit_redemption_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.benefit_redemption_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.benefit_redemption_events
  USING (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id())
  WITH CHECK (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id());

ALTER TABLE mbox.notification_delivery_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.notification_delivery_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.notification_delivery_attempts
  USING (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id())
  WITH CHECK (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id());

COMMENT ON TABLE mbox.benefit_redemptions IS
  'Versioned entitlement-consumption aggregate. Locks reserve quantity atomically and terminal transitions redeem or release it.';
COMMENT ON TABLE mbox.benefit_redemption_events IS
  'Append-only benefit lock, redemption and release ledger used for audit and reconciliation.';
COMMENT ON TABLE mbox.notification_delivery_attempts IS
  'Append-only evidence for each completed customer-notification delivery attempt; payload secrets must not be stored here.';
COMMENT ON COLUMN mbox.customer_notifications.lease_expires_at IS
  'Short worker claim expiry. An expired lease is recoverable; it is not proof that the provider did or did not accept the message.';

COMMIT;
