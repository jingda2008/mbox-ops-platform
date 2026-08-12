BEGIN;

ALTER TABLE mbox.refunds
  ADD COLUMN decision_reason text;

ALTER TABLE mbox.payments
  ADD CONSTRAINT payments_provider_method_ck CHECK (
    (provider = 'cash' AND method = 'cash')
    OR (provider = 'physical_pos' AND method IN ('card', 'manual'))
    OR (provider IN ('wechat', 'postar', 'simulation') AND method IN ('jsapi', 'native_qr', 'auth_code'))
  ),
  ADD CONSTRAINT payments_captured_evidence_ck CHECK (
    status NOT IN ('succeeded', 'partially_refunded', 'refunded')
    OR (
      provider_transaction_id IS NOT NULL
      AND length(btrim(provider_transaction_id)) > 0
      AND succeeded_at IS NOT NULL
    )
  );

ALTER TABLE mbox.reconciliation_entries
  ADD CONSTRAINT reconciliation_financial_identity_ck CHECK (
    (entry_type = 'payment'
      AND payment_id IS NOT NULL
      AND refund_id IS NULL
      AND amount_minor > 0)
    OR (entry_type = 'refund'
      AND payment_id IS NOT NULL
      AND refund_id IS NOT NULL
      AND amount_minor < 0)
    OR (entry_type IN ('fee', 'adjustment') AND amount_minor <> 0)
  );

ALTER TABLE mbox.refunds
  ADD CONSTRAINT refunds_decision_state_ck CHECK (
    (status = 'requested'
      AND approved_by_employee_id IS NULL
      AND decision_reason IS NULL
      AND completed_at IS NULL)
    OR (status IN ('approved', 'processing')
      AND approved_by_employee_id IS NOT NULL
      AND length(btrim(decision_reason)) BETWEEN 2 AND 1000
      AND completed_at IS NULL)
    OR (status = 'rejected'
      AND approved_by_employee_id IS NOT NULL
      AND length(btrim(decision_reason)) BETWEEN 2 AND 1000
      AND completed_at IS NULL)
    OR (status IN ('succeeded', 'failed')
      AND approved_by_employee_id IS NOT NULL
      AND length(btrim(decision_reason)) BETWEEN 2 AND 1000
      AND provider_refund_id IS NOT NULL
      AND length(btrim(provider_refund_id)) > 0
      AND completed_at IS NOT NULL)
    OR status = 'cancelled'
  );

CREATE INDEX payments_callback_lookup_idx
  ON mbox.payments (tenant_id, store_id, provider, public_id, status);

CREATE INDEX refunds_payment_status_idx
  ON mbox.refunds (tenant_id, store_id, payment_id, status, created_at, id);

CREATE INDEX refunds_callback_lookup_idx
  ON mbox.refunds (tenant_id, store_id, public_id, status);

CREATE INDEX reconciliation_filtered_list_idx
  ON mbox.reconciliation_entries (
    tenant_id, store_id, business_date, entry_type, occurred_at DESC, id DESC
  );

COMMENT ON COLUMN mbox.refunds.decision_reason IS
  'Required human approval or rejection rationale; never reuse the customer refund request reason.';

COMMIT;
