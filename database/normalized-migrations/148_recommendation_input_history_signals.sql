BEGIN;

-- The customer questionnaire is held in the already append-only,
-- versioned recommendation_policy_versions.display_configuration JSON.  No
-- second policy table is introduced: a new policy version is the only way to
-- change question copy/order or bounded history strategy.

-- Historical member signals only inspect completed payment truth.  This index
-- keeps that per-product ranking lookup scoped to one merged customer family.
CREATE INDEX orders_paid_customer_history_idx
  ON mbox.orders(tenant_id,store_id,created_by_customer_id,created_at DESC,id)
  WHERE created_by_customer_id IS NOT NULL
    AND status<>'cancelled' AND payment_status='paid';

-- A shake excludes prior exposure for this guest at this table session before
-- applying the existing ranked candidate rotation.
CREATE INDEX recommendation_sessions_table_customer_timeline_idx
  ON mbox.recommendation_sessions(
    tenant_id,store_id,table_session_id,customer_id,created_at DESC,id
  );

CREATE INDEX recommendation_behavior_events_table_customer_type_idx
  ON mbox.recommendation_behavior_events(
    tenant_id,store_id,table_session_id,customer_id,event_type,occurred_at DESC,id
  ) WHERE event_type='rejected';

COMMENT ON INDEX mbox.orders_paid_customer_history_idx IS
  'Recommendation history only: paid, non-cancelled orders created by the member identity family.';
COMMENT ON INDEX mbox.recommendation_sessions_table_customer_timeline_idx IS
  'Current-table recommendation exposure exclusion for shake requests.';

COMMIT;
