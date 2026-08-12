BEGIN;

ALTER TABLE mbox.reservations
  ADD COLUMN aggregate_version bigint NOT NULL DEFAULT 1 CHECK (aggregate_version > 0),
  ADD COLUMN customer_cancel_until timestamptz,
  ADD COLUMN cancellation_policy_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(cancellation_policy_snapshot) = 'object');

CREATE TABLE mbox.reservation_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  reservation_id uuid NOT NULL,
  payment_id uuid NOT NULL,
  purpose text NOT NULL DEFAULT 'deposit' CHECK (purpose IN ('deposit')),
  linked_by_employee_id uuid,
  linked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, reservation_id)
    REFERENCES mbox.reservations(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, payment_id)
    REFERENCES mbox.payments(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, linked_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, reservation_id, payment_id),
  UNIQUE (tenant_id, store_id, payment_id),
  UNIQUE (tenant_id, store_id, id)
);

CREATE INDEX reservation_payments_reservation_idx
  ON mbox.reservation_payments (tenant_id, store_id, reservation_id, linked_at, id);

CREATE OR REPLACE FUNCTION mbox.ensure_reservation_payment_linkable()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE reservation_status text;
BEGIN
  SELECT status INTO reservation_status
  FROM mbox.reservations
  WHERE tenant_id = NEW.tenant_id
    AND store_id = NEW.store_id
    AND id = NEW.reservation_id
  FOR KEY SHARE;
  IF reservation_status IS NULL THEN
    RAISE EXCEPTION 'reservation payment target does not exist' USING ERRCODE = '23503';
  END IF;
  IF reservation_status NOT IN ('pending', 'confirmed') THEN
    RAISE EXCEPTION 'reservation payment target is no longer payable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER reservation_payments_linkable
  BEFORE INSERT ON mbox.reservation_payments
  FOR EACH ROW EXECUTE FUNCTION mbox.ensure_reservation_payment_linkable();

CREATE TABLE mbox.song_request_payment_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  song_request_id uuid NOT NULL,
  payment_id uuid NOT NULL,
  reconciliation_entry_id uuid NOT NULL,
  recorded_by_employee_id uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, song_request_id)
    REFERENCES mbox.song_requests(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, payment_id)
    REFERENCES mbox.payments(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, reconciliation_entry_id)
    REFERENCES mbox.reconciliation_entries(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, recorded_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, song_request_id),
  UNIQUE (tenant_id, store_id, reconciliation_entry_id),
  UNIQUE (tenant_id, store_id, id)
);

ALTER TABLE mbox.reconciliation_entries
  ADD CONSTRAINT reconciliation_entries_payment_identity_uq
    UNIQUE (tenant_id, store_id, id, payment_id);

ALTER TABLE mbox.song_request_payment_evidence
  ADD CONSTRAINT song_request_payment_evidence_reconciliation_payment_fk
  FOREIGN KEY (tenant_id, store_id, reconciliation_entry_id, payment_id)
  REFERENCES mbox.reconciliation_entries(tenant_id, store_id, id, payment_id);

CREATE TRIGGER reservation_payments_append_only
  BEFORE UPDATE OR DELETE ON mbox.reservation_payments
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();

CREATE TRIGGER song_request_payment_evidence_append_only
  BEFORE UPDATE OR DELETE ON mbox.song_request_payment_evidence
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();

INSERT INTO mbox.staff_permission_definitions (
  tenant_id, store_id, code, name, category, description, status
)
SELECT store.tenant_id, store.id, permission.code, permission.name,
  permission.category, permission.description, 'active'
FROM mbox.stores AS store
CROSS JOIN (VALUES
  ('reservation.view.all', '查看全部预约', 'reservation', '忽略负责人和区域数据范围查看全店预约'),
  ('reservation.contact.view', '查看预约联系方式', 'reservation', '查看未脱敏预约联系方式'),
  ('reservation.cancel.override', '例外取消预约', 'reservation', '绕过客户取消截止或已付定金限制'),
  ('song.payment.record', '登记点歌收款', 'payment', '依据支付与对账凭证登记点歌已付款')
) AS permission(code, name, category, description)
ON CONFLICT (tenant_id, store_id, code) DO UPDATE
SET name = EXCLUDED.name,
    category = EXCLUDED.category,
    description = EXCLUDED.description,
    status = 'active';

ALTER TABLE mbox.reservation_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.reservation_payments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.reservation_payments
  USING (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id())
  WITH CHECK (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id());

ALTER TABLE mbox.song_request_payment_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.song_request_payment_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.song_request_payment_evidence
  USING (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id())
  WITH CHECK (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id());

REVOKE ALL ON TABLE mbox.reservation_payments FROM PUBLIC;
REVOKE ALL ON TABLE mbox.song_request_payment_evidence FROM PUBLIC;
GRANT SELECT, INSERT ON TABLE mbox.reservation_payments TO mbox_runtime;
GRANT SELECT, INSERT ON TABLE mbox.song_request_payment_evidence TO mbox_runtime;

COMMENT ON COLUMN mbox.reservations.aggregate_version IS
  'Monotonic aggregate version incremented in the same row lock transaction as every state transition.';
COMMENT ON COLUMN mbox.reservations.customer_cancel_until IS
  'Server-calculated customer self-service cancellation deadline.';
COMMENT ON TABLE mbox.reservation_payments IS
  'Normalized reservation deposit evidence. Customer cancellation policy checks succeeded linked payments.';
COMMENT ON TABLE mbox.song_request_payment_evidence IS
  'Immutable proof that a paid song request is backed by a succeeded payment and matching reconciliation entry.';

COMMIT;
