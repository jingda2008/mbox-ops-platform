BEGIN;

ALTER TABLE mbox.notifications
  ADD COLUMN business_key text,
  ADD COLUMN source_outbox_message_id uuid,
  ADD COLUMN max_attempts integer NOT NULL DEFAULT 5,
  ADD COLUMN dead_at timestamptz,
  ADD COLUMN cancelled_at timestamptz;

UPDATE mbox.notifications
SET business_key = 'legacy:' || id::text
WHERE business_key IS NULL;

ALTER TABLE mbox.notifications
  ALTER COLUMN business_key SET NOT NULL,
  DROP CONSTRAINT notifications_status_check,
  ADD CONSTRAINT notifications_status_check
    CHECK (status IN ('pending', 'sending', 'delivered', 'failed', 'dead', 'cancelled')),
  ADD CONSTRAINT notifications_business_key_ck
    CHECK (length(business_key) BETWEEN 8 AND 160),
  ADD CONSTRAINT notifications_attempt_limit_ck
    CHECK (max_attempts BETWEEN 1 AND 20 AND attempts BETWEEN 0 AND max_attempts),
  ADD CONSTRAINT notifications_lock_pair_ck
    CHECK ((locked_by IS NULL) = (locked_at IS NULL)),
  ADD CONSTRAINT notifications_terminal_timestamps_ck
    CHECK (
      (status = 'delivered') = (delivered_at IS NOT NULL)
      AND (status = 'dead') = (dead_at IS NOT NULL)
      AND (status = 'cancelled') = (cancelled_at IS NOT NULL)
    ),
  ADD CONSTRAINT notifications_failure_code_ck
    CHECK (
      last_error IS NULL
      OR (
        length(last_error) BETWEEN 3 AND 96
        AND last_error ~ '^[a-z][a-z0-9_.:-]{2,95}$'
      )
    ),
  ADD CONSTRAINT notifications_source_outbox_fk
    FOREIGN KEY (tenant_id, store_id, source_outbox_message_id)
    REFERENCES mbox.outbox_messages(tenant_id, store_id, id);

CREATE UNIQUE INDEX notifications_business_key_uq
  ON mbox.notifications (tenant_id, store_id, business_key);
CREATE INDEX notifications_source_outbox_idx
  ON mbox.notifications (tenant_id, store_id, source_outbox_message_id)
  WHERE source_outbox_message_id IS NOT NULL;

DROP INDEX mbox.notifications_delivery_claim_idx;
DROP INDEX mbox.notifications_store_delivery_claim_idx;
CREATE INDEX notifications_delivery_claim_idx
  ON mbox.notifications (available_at, created_at, id)
  WHERE status IN ('pending', 'failed', 'sending');
CREATE INDEX notifications_store_delivery_claim_idx
  ON mbox.notifications (tenant_id, store_id, available_at, created_at, id)
  WHERE status IN ('pending', 'failed', 'sending');

CREATE OR REPLACE FUNCTION mbox.protect_notification_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR
     NEW.id IS DISTINCT FROM OLD.id OR
     NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR
     NEW.store_id IS DISTINCT FROM OLD.store_id OR
     NEW.business_key IS DISTINCT FROM OLD.business_key OR
     NEW.source_outbox_message_id IS DISTINCT FROM OLD.source_outbox_message_id OR
     NEW.channel IS DISTINCT FROM OLD.channel OR
     NEW.recipient_type IS DISTINCT FROM OLD.recipient_type OR
     NEW.recipient_id IS DISTINCT FROM OLD.recipient_id OR
     NEW.template_code IS DISTINCT FROM OLD.template_code OR
     NEW.payload IS DISTINCT FROM OLD.payload OR
     NEW.max_attempts IS DISTINCT FROM OLD.max_attempts OR
     NEW.created_at IS DISTINCT FROM OLD.created_at OR
     NEW.attempts < OLD.attempts OR
     (OLD.status IN ('delivered', 'dead', 'cancelled') AND NEW.status IS DISTINCT FROM OLD.status) THEN
    RAISE EXCEPTION 'notification identity, content and terminal state are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'pending' AND NEW.status IN ('sending', 'cancelled')) OR
    (OLD.status = 'failed' AND NEW.status IN ('sending', 'cancelled')) OR
    (OLD.status = 'sending' AND NEW.status IN ('sending', 'delivered', 'failed', 'dead'))
  ) THEN
    RAISE EXCEPTION 'invalid notification status transition: % -> %', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER notifications_protect_identity
  BEFORE UPDATE OR DELETE ON mbox.notifications
  FOR EACH ROW EXECUTE FUNCTION mbox.protect_notification_identity();

COMMIT;
