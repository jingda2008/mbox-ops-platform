BEGIN;

ALTER TABLE mbox.payment_provider_actions
  ADD COLUMN client_network_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE mbox.payment_provider_actions
  ADD CONSTRAINT payment_provider_actions_client_network_snapshot_object_ck
  CHECK (jsonb_typeof(client_network_snapshot)='object');

-- Automatic provider queries are financial follow-up, not table state.  Keep
-- their cadence durable so a process restart or a second worker cannot reset
-- the backoff and hammer the acquiring channel.
CREATE TABLE mbox.payment_reconciliation_states (
  payment_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  phase text NOT NULL DEFAULT 'interactive'
    CHECK (phase IN ('interactive','released','finance_review','stopped')),
  last_queried_at timestamptz,
  next_query_at timestamptz,
  consecutive_processing_count integer NOT NULL DEFAULT 0
    CHECK (consecutive_processing_count >= 0),
  consecutive_error_count integer NOT NULL DEFAULT 0
    CHECK (consecutive_error_count >= 0),
  released_query_count integer NOT NULL DEFAULT 0
    CHECK (released_query_count >= 0),
  total_query_count integer NOT NULL DEFAULT 0
    CHECK (total_query_count >= 0),
  last_observed_status text,
  released_at timestamptz,
  automatic_query_stopped_at timestamptz,
  stop_reason text,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,store_id,payment_id)
    REFERENCES mbox.payments(tenant_id,store_id,id),
  CHECK ((phase='stopped')=(automatic_query_stopped_at IS NOT NULL)),
  CHECK (stop_reason IS NULL OR length(btrim(stop_reason)) BETWEEN 2 AND 128)
);

CREATE INDEX payment_reconciliation_states_due_idx
  ON mbox.payment_reconciliation_states(tenant_id,store_id,next_query_at,payment_id)
  WHERE phase<>'stopped';

CREATE INDEX payment_reconciliation_states_attention_idx
  ON mbox.payment_reconciliation_states(tenant_id,store_id,phase,updated_at,payment_id);

-- A callback or a manual query can settle a payment while the background
-- worker is sleeping.  Stop the automatic schedule at the authoritative
-- payment boundary; callbacks remain fully independent of this table.
CREATE FUNCTION mbox.stop_terminal_payment_reconciliation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,mbox AS $$
BEGIN
  IF NEW.status IN ('succeeded','failed','closed','refunded','partially_refunded')
    AND NEW.status IS DISTINCT FROM OLD.status THEN
    UPDATE mbox.payment_reconciliation_states
    SET phase='stopped',next_query_at=NULL,lease_until=NULL,
      last_observed_status=NEW.status,
      automatic_query_stopped_at=COALESCE(automatic_query_stopped_at,clock_timestamp()),
      stop_reason=CASE WHEN NEW.status='succeeded' THEN 'confirmed_receipt'
        ELSE 'provider_terminal_result' END,
      updated_at=clock_timestamp()
    WHERE payment_id=NEW.id;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER payments_stop_terminal_reconciliation
  AFTER UPDATE OF status ON mbox.payments
  FOR EACH ROW EXECUTE FUNCTION mbox.stop_terminal_payment_reconciliation();

ALTER TABLE mbox.payment_reconciliation_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.payment_reconciliation_states FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.payment_reconciliation_states
  USING (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())
  WITH CHECK (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());

REVOKE ALL ON TABLE mbox.payment_reconciliation_states FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON TABLE mbox.payment_reconciliation_states TO mbox_runtime;
REVOKE ALL ON FUNCTION mbox.stop_terminal_payment_reconciliation() FROM PUBLIC;

-- Preserve the production history instead of treating every legacy payment as
-- a brand-new polling attempt after this migration.  A released payment that
-- is already outside the conservative tracking window moves straight to
-- finance review; recent ones inherit the backoff implied by their immutable
-- active-query observations.  No provider evidence is deleted or rewritten.
WITH query_history AS (
  SELECT observation.payment_id,
    count(*) FILTER (
      WHERE observation.verification_kind='active_query_binding'
    )::integer AS query_count,
    count(*) FILTER (
      WHERE observation.verification_kind='active_query_binding'
        AND observation.observed_status='payment_pending'
    )::integer AS processing_count,
    max(observation.recorded_at) FILTER (
      WHERE observation.verification_kind='active_query_binding'
    ) AS last_queried_at
  FROM mbox.verified_provider_observations observation
  WHERE observation.subject_kind='payment' AND observation.payment_id IS NOT NULL
  GROUP BY observation.payment_id
), candidates AS (
  SELECT payment.id AS payment_id,payment.tenant_id,payment.store_id,payment.created_at,
    (payment.retry_released_at IS NOT NULL
      OR COALESCE(ordering.status='cancelled',false)
      OR COALESCE(action.expires_at<=clock_timestamp(),true)
      OR abandonment.payment_id IS NOT NULL) AS operationally_released,
    COALESCE(payment.retry_released_at,abandonment.occurred_at,
      ordering.cancelled_at,action.expires_at,payment.created_at) AS released_at,
    COALESCE(history.query_count,0) AS query_count,
    COALESCE(history.processing_count,0) AS processing_count,
    history.last_queried_at
  FROM mbox.payments payment
  LEFT JOIN mbox.orders ordering
    ON ordering.tenant_id=payment.tenant_id AND ordering.store_id=payment.store_id
   AND ordering.id=payment.order_id
  LEFT JOIN mbox.payment_provider_actions action
    ON action.tenant_id=payment.tenant_id AND action.store_id=payment.store_id
   AND action.payment_id=payment.id
  LEFT JOIN mbox.guest_immediate_checkout_abandonment_events abandonment
    ON abandonment.tenant_id=payment.tenant_id AND abandonment.store_id=payment.store_id
   AND abandonment.payment_id=payment.id
  LEFT JOIN query_history history ON history.payment_id=payment.id
  WHERE payment.provider='postar' AND payment.status IN ('created','pending')
)
INSERT INTO mbox.payment_reconciliation_states(
  payment_id,tenant_id,store_id,phase,last_queried_at,next_query_at,
  consecutive_processing_count,released_query_count,total_query_count,
  last_observed_status,released_at,automatic_query_stopped_at,stop_reason
)
SELECT candidate.payment_id,candidate.tenant_id,candidate.store_id,
  CASE
    WHEN candidate.operationally_released
      AND candidate.created_at<=clock_timestamp()-interval '7 days' THEN 'stopped'
    WHEN candidate.operationally_released THEN 'released'
    ELSE 'interactive'
  END,
  candidate.last_queried_at,
  CASE
    WHEN candidate.operationally_released
      AND candidate.created_at<=clock_timestamp()-interval '7 days' THEN NULL
    WHEN NOT candidate.operationally_released THEN clock_timestamp()
    WHEN candidate.query_count=0 THEN clock_timestamp()
    WHEN candidate.query_count=1 THEN greatest(clock_timestamp(),candidate.last_queried_at+interval '5 minutes')
    WHEN candidate.query_count=2 THEN greatest(clock_timestamp(),candidate.last_queried_at+interval '15 minutes')
    WHEN candidate.query_count=3 THEN greatest(clock_timestamp(),candidate.last_queried_at+interval '1 hour')
    WHEN candidate.query_count<=5 THEN greatest(clock_timestamp(),candidate.last_queried_at+interval '6 hours')
    ELSE greatest(clock_timestamp(),candidate.last_queried_at+interval '24 hours')
  END,
  candidate.processing_count,
  CASE WHEN candidate.operationally_released THEN candidate.query_count ELSE 0 END,
  candidate.query_count,
  CASE WHEN candidate.query_count>0 THEN 'payment_pending' ELSE NULL END,
  CASE WHEN candidate.operationally_released THEN candidate.released_at ELSE NULL END,
  CASE WHEN candidate.operationally_released
    AND candidate.created_at<=clock_timestamp()-interval '7 days'
    THEN clock_timestamp() ELSE NULL END,
  CASE WHEN candidate.operationally_released
    AND candidate.created_at<=clock_timestamp()-interval '7 days'
    THEN 'finance_review_required' ELSE NULL END
FROM candidates candidate
ON CONFLICT (payment_id) DO NOTHING;

-- Refund submission is also asynchronous. Persist its query cadence so a
-- restart cannot turn a long provider delay into a 30-second polling loop.
CREATE TABLE mbox.refund_reconciliation_states (
  refund_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  phase text NOT NULL DEFAULT 'active'
    CHECK (phase IN ('active','finance_review','stopped')),
  last_queried_at timestamptz,
  next_query_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  consecutive_processing_count integer NOT NULL DEFAULT 0
    CHECK (consecutive_processing_count >= 0),
  consecutive_error_count integer NOT NULL DEFAULT 0
    CHECK (consecutive_error_count >= 0),
  total_query_count integer NOT NULL DEFAULT 0
    CHECK (total_query_count >= 0),
  last_observed_status text,
  lease_until timestamptz,
  automatic_query_stopped_at timestamptz,
  stop_reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,store_id,refund_id)
    REFERENCES mbox.refunds(tenant_id,store_id,id),
  CHECK ((phase='stopped')=(automatic_query_stopped_at IS NOT NULL)),
  CHECK (stop_reason IS NULL OR length(btrim(stop_reason)) BETWEEN 2 AND 128)
);

CREATE INDEX refund_reconciliation_states_due_idx
  ON mbox.refund_reconciliation_states(tenant_id,store_id,next_query_at,refund_id)
  WHERE phase<>'stopped';

CREATE FUNCTION mbox.stop_terminal_refund_reconciliation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,mbox AS $$
BEGIN
  IF NEW.status IN ('succeeded','failed','rejected','cancelled')
    AND NEW.status IS DISTINCT FROM OLD.status THEN
    UPDATE mbox.refund_reconciliation_states
    SET phase='stopped',lease_until=NULL,last_observed_status=NEW.status,
      automatic_query_stopped_at=COALESCE(automatic_query_stopped_at,clock_timestamp()),
      stop_reason='provider_terminal_result',updated_at=clock_timestamp()
    WHERE refund_id=NEW.id;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER refunds_stop_terminal_reconciliation
  AFTER UPDATE OF status ON mbox.refunds
  FOR EACH ROW EXECUTE FUNCTION mbox.stop_terminal_refund_reconciliation();

ALTER TABLE mbox.refund_reconciliation_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.refund_reconciliation_states FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.refund_reconciliation_states
  USING (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())
  WITH CHECK (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());

REVOKE ALL ON TABLE mbox.refund_reconciliation_states FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON TABLE mbox.refund_reconciliation_states TO mbox_runtime;
REVOKE ALL ON FUNCTION mbox.stop_terminal_refund_reconciliation() FROM PUBLIC;

-- Refunds retain the same restart-safe property.  Historic processing
-- observations seed the durable cadence, while old/high-volume cases remain
-- visible as finance-review work rather than silently disappearing.
WITH query_history AS (
  SELECT observation.refund_id,
    count(*) FILTER (
      WHERE observation.verification_kind='active_query_binding'
    )::integer AS query_count,
    count(*) FILTER (
      WHERE observation.verification_kind='active_query_binding'
        AND observation.observed_status='refund_processing'
    )::integer AS processing_count,
    max(observation.recorded_at) FILTER (
      WHERE observation.verification_kind='active_query_binding'
    ) AS last_queried_at
  FROM mbox.verified_provider_observations observation
  WHERE observation.subject_kind='refund' AND observation.refund_id IS NOT NULL
  GROUP BY observation.refund_id
), candidates AS (
  SELECT refund.id AS refund_id,refund.tenant_id,refund.store_id,
    COALESCE(history.query_count,0) AS query_count,
    COALESCE(history.processing_count,0) AS processing_count,
    history.last_queried_at
  FROM mbox.refunds refund
  JOIN mbox.payments payment
    ON payment.tenant_id=refund.tenant_id AND payment.store_id=refund.store_id
   AND payment.id=refund.payment_id
  LEFT JOIN query_history history ON history.refund_id=refund.id
  WHERE refund.status='processing'
    AND refund.provider_submission_state IN ('submitting','submitted')
    AND refund.merchant_refund_id IS NOT NULL
    AND payment.provider='postar'
)
INSERT INTO mbox.refund_reconciliation_states(
  refund_id,tenant_id,store_id,phase,last_queried_at,next_query_at,
  consecutive_processing_count,total_query_count,last_observed_status
)
SELECT candidate.refund_id,candidate.tenant_id,candidate.store_id,
  CASE WHEN candidate.query_count>=12 THEN 'finance_review' ELSE 'active' END,
  candidate.last_queried_at,
  CASE
    WHEN candidate.query_count=0 THEN clock_timestamp()
    WHEN candidate.query_count=1 THEN greatest(clock_timestamp(),candidate.last_queried_at+interval '1 minute')
    WHEN candidate.query_count=2 THEN greatest(clock_timestamp(),candidate.last_queried_at+interval '5 minutes')
    WHEN candidate.query_count=3 THEN greatest(clock_timestamp(),candidate.last_queried_at+interval '15 minutes')
    WHEN candidate.query_count<=5 THEN greatest(clock_timestamp(),candidate.last_queried_at+interval '1 hour')
    ELSE greatest(clock_timestamp(),candidate.last_queried_at+interval '6 hours')
  END,
  candidate.processing_count,candidate.query_count,
  CASE WHEN candidate.query_count>0 THEN 'refund_processing' ELSE NULL END
FROM candidates candidate
ON CONFLICT (refund_id) DO NOTHING;

CREATE VIEW mbox.payment_financial_monitoring_signals
WITH (security_invoker=true) AS
SELECT state.tenant_id,state.store_id,state.payment_id AS subject_id,
  'payment_processing_over_5m'::text AS signal,state.last_queried_at AS observed_at
FROM mbox.payment_reconciliation_states state
JOIN mbox.payments payment ON payment.id=state.payment_id
WHERE payment.status IN ('created','pending')
  AND payment.created_at<=clock_timestamp()-interval '5 minutes'
UNION ALL
SELECT state.tenant_id,state.store_id,state.payment_id,
  'automatic_query_count_excessive',state.last_queried_at
FROM mbox.payment_reconciliation_states state
WHERE state.total_query_count>=20
UNION ALL
SELECT state.tenant_id,state.store_id,state.payment_id,
  'finance_review_required',state.automatic_query_stopped_at
FROM mbox.payment_reconciliation_states state
WHERE state.phase='stopped' AND state.stop_reason='finance_review_required'
UNION ALL
SELECT state.tenant_id,state.store_id,state.refund_id,
  'refund_processing_over_5m',state.last_queried_at
FROM mbox.refund_reconciliation_states state
JOIN mbox.refunds refund ON refund.id=state.refund_id
WHERE refund.status='processing'
  AND refund.created_at<=clock_timestamp()-interval '5 minutes'
UNION ALL
SELECT state.tenant_id,state.store_id,state.refund_id,
  'refund_automatic_query_count_excessive',state.last_queried_at
FROM mbox.refund_reconciliation_states state
WHERE state.total_query_count>=20
UNION ALL
SELECT payment.tenant_id,payment.store_id,payment.id,
  'succeeded_payment_missing_reconciliation',payment.succeeded_at
FROM mbox.payments payment
WHERE payment.status IN ('succeeded','partially_refunded','refunded')
  AND NOT EXISTS (SELECT 1 FROM mbox.reconciliation_entries entry
    WHERE entry.tenant_id=payment.tenant_id AND entry.store_id=payment.store_id
      AND entry.payment_id=payment.id AND entry.entry_type='payment')
UNION ALL
SELECT ordering.tenant_id,ordering.store_id,ordering.id,
  'order_overcollected',max(payment.succeeded_at)
FROM mbox.orders ordering
JOIN mbox.payments payment
  ON payment.tenant_id=ordering.tenant_id AND payment.store_id=ordering.store_id
 AND payment.order_id=ordering.id
WHERE payment.status IN ('succeeded','partially_refunded','refunded')
GROUP BY ordering.tenant_id,ordering.store_id,ordering.id,ordering.total_amount_minor
HAVING sum(payment.amount_minor-COALESCE((SELECT sum(refund.amount_minor)
  FROM mbox.refunds refund WHERE refund.tenant_id=payment.tenant_id
    AND refund.store_id=payment.store_id AND refund.payment_id=payment.id
    AND refund.status='succeeded'),0))>ordering.total_amount_minor
UNION ALL
SELECT action.tenant_id,action.store_id,action.payment_id,
  'postar_ip_risk_rejected',action.updated_at
FROM mbox.payment_provider_actions action
WHERE action.last_error_code LIKE 'POSTAR\_%\_IP\_RISK\_REJECTED\_%' ESCAPE '\'
  AND action.updated_at>=clock_timestamp()-interval '1 hour'
UNION ALL
SELECT followup.tenant_id,followup.store_id,followup.payment_id,
  'late_capture_refund_followup_open',followup.created_at
FROM mbox.guest_immediate_checkout_late_capture_refund_followups followup
WHERE followup.amount_minor>COALESCE((SELECT sum(refund.amount_minor)
  FROM mbox.refunds refund WHERE refund.tenant_id=followup.tenant_id
    AND refund.store_id=followup.store_id AND refund.payment_id=followup.payment_id
    AND refund.status='succeeded'),0);

REVOKE ALL ON mbox.payment_financial_monitoring_signals FROM PUBLIC;
GRANT SELECT ON mbox.payment_financial_monitoring_signals TO mbox_runtime;

UPDATE mbox.normalized_schema_metadata
SET schema_version='161',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
