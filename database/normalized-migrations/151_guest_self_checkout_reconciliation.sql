BEGIN;

-- A customer leaving an unpaid self-service JSAPI checkout must release the
-- operational order immediately, without deleting the financial attempt.  A
-- later successful provider callback is collected money, so it becomes a refund
-- review obligation rather than reviving kitchen/bar work for a departed
-- table.
CREATE TABLE mbox.guest_immediate_checkout_abandonment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  payment_id uuid NOT NULL,
  order_id uuid NOT NULL,
  order_public_id text NOT NULL CHECK (length(btrim(order_public_id)) BETWEEN 8 AND 128),
  payment_public_id text NOT NULL CHECK (length(btrim(payment_public_id)) BETWEEN 8 AND 128),
  source_business_date date NOT NULL,
  action_business_date date NOT NULL,
  provider_terminal_status text NOT NULL CHECK (provider_terminal_status IN ('closed','failed','unresolved')),
  reason_code text NOT NULL CHECK (reason_code IN (
    'customer_payment_exit',
    'stale_guest_immediate_payment'
  )),
  released_inventory_reservation_count integer NOT NULL CHECK (released_inventory_reservation_count >= 0),
  cancelled_item_count integer NOT NULL CHECK (cancelled_item_count >= 0),
  cancelled_kds_task_count integer NOT NULL CHECK (cancelled_kds_task_count >= 0),
  worker_ref text NOT NULL CHECK (length(btrim(worker_ref)) BETWEEN 3 AND 128),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
  FOREIGN KEY (tenant_id,store_id,payment_id) REFERENCES mbox.payments(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,order_id) REFERENCES mbox.orders(tenant_id,store_id,id),
  UNIQUE (tenant_id,store_id,payment_id),
  UNIQUE (tenant_id,store_id,order_id)
);

CREATE INDEX guest_immediate_checkout_abandonment_events_timeline_idx
  ON mbox.guest_immediate_checkout_abandonment_events(tenant_id,store_id,occurred_at,id);

CREATE TRIGGER guest_immediate_checkout_abandonment_events_append_only
  BEFORE UPDATE OR DELETE ON mbox.guest_immediate_checkout_abandonment_events
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();

-- This is deliberately a review obligation, not an automatic refund.  The
-- existing cashier approval/execution process remains the only money-out
-- path after a late capture.
CREATE TABLE mbox.guest_immediate_checkout_late_capture_refund_followups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  payment_id uuid NOT NULL,
  order_id uuid NOT NULL,
  abandonment_event_id uuid NOT NULL,
  payment_public_id text NOT NULL CHECK (length(btrim(payment_public_id)) BETWEEN 8 AND 128),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  provider_transaction_id text NOT NULL CHECK (length(btrim(provider_transaction_id)) BETWEEN 1 AND 256),
  captured_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'refund_review_required'
    CHECK (status = 'refund_review_required'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
  FOREIGN KEY (tenant_id,store_id,payment_id) REFERENCES mbox.payments(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,order_id) REFERENCES mbox.orders(tenant_id,store_id,id),
  FOREIGN KEY (abandonment_event_id) REFERENCES mbox.guest_immediate_checkout_abandonment_events(id),
  UNIQUE (tenant_id,store_id,payment_id)
);

CREATE INDEX guest_immediate_checkout_late_capture_refund_followups_queue_idx
  ON mbox.guest_immediate_checkout_late_capture_refund_followups(tenant_id,store_id,created_at,id);

CREATE TRIGGER guest_immediate_checkout_late_capture_refund_followups_append_only
  BEFORE UPDATE OR DELETE ON mbox.guest_immediate_checkout_late_capture_refund_followups
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();

-- Provider callbacks and active queries both change mbox.payments through the
-- normal command service.  Put the late-capture safety net at that durable
-- boundary so a worker restart cannot lose the refund-review obligation.
CREATE FUNCTION mbox.record_guest_immediate_checkout_late_capture_followup()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,mbox AS $$
DECLARE
  abandonment mbox.guest_immediate_checkout_abandonment_events%ROWTYPE;
BEGIN
  IF NEW.status<>'succeeded' OR OLD.status='succeeded' THEN RETURN NEW; END IF;
  SELECT * INTO abandonment
  FROM mbox.guest_immediate_checkout_abandonment_events AS event
  WHERE event.tenant_id=NEW.tenant_id AND event.store_id=NEW.store_id AND event.payment_id=NEW.id;
  IF NOT FOUND OR NEW.order_id IS NULL OR NEW.succeeded_at IS NULL
    OR NEW.provider_transaction_id IS NULL THEN RETURN NEW; END IF;
  INSERT INTO mbox.guest_immediate_checkout_late_capture_refund_followups (
    tenant_id,store_id,payment_id,order_id,abandonment_event_id,payment_public_id,
    amount_minor,currency,provider_transaction_id,captured_at
  ) VALUES (
    NEW.tenant_id,NEW.store_id,NEW.id,NEW.order_id,abandonment.id,NEW.public_id,
    NEW.amount_minor,NEW.currency,NEW.provider_transaction_id,NEW.succeeded_at
  ) ON CONFLICT (tenant_id,store_id,payment_id) DO NOTHING;
  RETURN NEW;
END $$;

CREATE TRIGGER payments_guest_immediate_checkout_late_capture_followup
  AFTER UPDATE OF status ON mbox.payments
  FOR EACH ROW EXECUTE FUNCTION mbox.record_guest_immediate_checkout_late_capture_followup();

ALTER TABLE mbox.guest_immediate_checkout_abandonment_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.guest_immediate_checkout_abandonment_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.guest_immediate_checkout_abandonment_events
  USING (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())
  WITH CHECK (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());

ALTER TABLE mbox.guest_immediate_checkout_late_capture_refund_followups ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.guest_immediate_checkout_late_capture_refund_followups FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.guest_immediate_checkout_late_capture_refund_followups
  USING (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())
  WITH CHECK (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());

REVOKE ALL ON TABLE mbox.guest_immediate_checkout_abandonment_events FROM PUBLIC;
REVOKE UPDATE,DELETE ON TABLE mbox.guest_immediate_checkout_abandonment_events FROM mbox_runtime;
GRANT SELECT,INSERT ON TABLE mbox.guest_immediate_checkout_abandonment_events TO mbox_runtime;

REVOKE ALL ON TABLE mbox.guest_immediate_checkout_late_capture_refund_followups FROM PUBLIC;
REVOKE UPDATE,DELETE ON TABLE mbox.guest_immediate_checkout_late_capture_refund_followups FROM mbox_runtime;
GRANT SELECT,INSERT ON TABLE mbox.guest_immediate_checkout_late_capture_refund_followups TO mbox_runtime;

REVOKE ALL ON FUNCTION mbox.record_guest_immediate_checkout_late_capture_followup() FROM PUBLIC;

UPDATE mbox.normalized_schema_metadata
SET schema_version='151',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
