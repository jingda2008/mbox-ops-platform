BEGIN;

-- The operating window starts at noon and ends at the store business-day cutoff
-- (06:00 for M-BOX).  The policy is explicit and disabled by default: the
-- worker may never close tables merely because a process happens to restart.
CREATE TABLE mbox.store_automatic_table_turnover_policies (
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  operating_starts_at time NOT NULL DEFAULT TIME '12:00',
  policy_version integer NOT NULL DEFAULT 1 CHECK (policy_version > 0),
  reason text NOT NULL DEFAULT '营业日截止自动收工翻台；财务、退款与晚到支付事实保留待核对'
    CHECK (length(btrim(reason)) BETWEEN 4 AND 500),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, store_id),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  CHECK (operating_starts_at <> TIME '00:00')
);

ALTER TABLE mbox.store_automatic_table_turnover_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.store_automatic_table_turnover_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY automatic_table_turnover_policy_tenant_store_isolation
  ON mbox.store_automatic_table_turnover_policies
  USING (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())
  WITH CHECK (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
REVOKE ALL ON TABLE mbox.store_automatic_table_turnover_policies FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE mbox.store_automatic_table_turnover_policies TO mbox_runtime;

-- Automatic work must be recorded as system work.  Retain the original
-- employee attribution for every existing manual command while permitting a
-- dedicated system-only cutoff procedure to create an equally durable trail.
ALTER TABLE mbox.table_customer_left_turnover_events
  ADD COLUMN actor_type text NOT NULL DEFAULT 'employee'
    CHECK (actor_type IN ('employee','system'));
ALTER TABLE mbox.table_customer_left_turnover_events
  ALTER COLUMN actor_employee_id DROP NOT NULL;
ALTER TABLE mbox.table_customer_left_turnover_events
  ADD CONSTRAINT table_customer_left_turnover_events_actor_identity_check
  CHECK (
    (actor_type='employee' AND actor_employee_id IS NOT NULL)
    OR (actor_type='system' AND actor_employee_id IS NULL)
  );
ALTER TABLE mbox.table_customer_left_turnover_events
  DROP CONSTRAINT IF EXISTS table_customer_left_turnover_events_reason_code_check;
ALTER TABLE mbox.table_customer_left_turnover_events
  ADD CONSTRAINT table_customer_left_turnover_events_reason_code_check
  CHECK (reason_code IN ('customer_left','automatic_cutoff'));

ALTER TABLE mbox.order_cancellation_events
  ADD COLUMN actor_type text NOT NULL DEFAULT 'employee'
    CHECK (actor_type IN ('employee','system'));
ALTER TABLE mbox.order_cancellation_events
  ALTER COLUMN actor_employee_id DROP NOT NULL;
ALTER TABLE mbox.order_cancellation_events
  ADD CONSTRAINT order_cancellation_events_actor_identity_check
  CHECK (
    (actor_type='employee' AND actor_employee_id IS NOT NULL)
    OR (actor_type='system' AND actor_employee_id IS NULL)
  );
ALTER TABLE mbox.order_cancellation_events
  DROP CONSTRAINT IF EXISTS order_cancellation_events_reason_code_check;
ALTER TABLE mbox.order_cancellation_events
  ADD CONSTRAINT order_cancellation_events_reason_code_check
  CHECK (reason_code IN ('duplicate_order','guest_left','test_cleanup','other','automatic_cutoff'));

ALTER TABLE mbox.order_settlement_exception_events
  ADD COLUMN actor_type text NOT NULL DEFAULT 'employee'
    CHECK (actor_type IN ('employee','system'));
ALTER TABLE mbox.order_settlement_exception_events
  ALTER COLUMN actor_employee_id DROP NOT NULL;
ALTER TABLE mbox.order_settlement_exception_events
  ADD CONSTRAINT order_settlement_exception_events_actor_identity_check
  CHECK (
    (actor_type='employee' AND actor_employee_id IS NOT NULL)
    OR (actor_type='system' AND actor_employee_id IS NULL)
  );
ALTER TABLE mbox.order_settlement_exception_events
  DROP CONSTRAINT IF EXISTS order_settlement_exception_events_reason_code_check;
ALTER TABLE mbox.order_settlement_exception_events
  ADD CONSTRAINT order_settlement_exception_events_reason_code_check
  CHECK (reason_code IN (
    'manager_comp','uncollectible','test_cleanup','customer_left','automatic_cutoff'
  ));

-- Build the automatic procedure from the already proven customer-left command
-- (including migration 143's settled/refund-history preservation).  Keeping a
-- separate function is deliberate: a client route cannot obtain automatic
-- authority by omitting an employee id.  The copied command accepts only a
-- NULL actor, only an enabled policy, and only a table from a prior business
-- date.  Its per-session append-only event is the restart/retry boundary.
DO $migration$
DECLARE
  source_sql text;
  automatic_sql text;
  old_validation text := $old$
  IF p_table_session_id IS NULL OR p_actor_employee_id IS NULL
    OR p_action_business_date IS NULL
    OR length(btrim(COALESCE(p_reason_note,''))) NOT BETWEEN 4 AND 500
    OR length(btrim(COALESCE(p_idempotency_key,''))) NOT BETWEEN 8 AND 160
    OR p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{7,159}$'
    OR btrim(p_request_sha256::text) !~ '^[0-9a-f]{64}$'
  THEN
    RAISE EXCEPTION 'customer-left table turnover request is invalid' USING ERRCODE='22023';
  END IF;
$old$;
  automatic_validation text := $new$
  IF p_table_session_id IS NULL OR p_actor_employee_id IS NOT NULL
    OR p_action_business_date IS NULL
    OR length(btrim(COALESCE(p_reason_note,''))) NOT BETWEEN 4 AND 500
    OR length(btrim(COALESCE(p_idempotency_key,''))) NOT BETWEEN 8 AND 160
    OR p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{7,159}$'
    OR btrim(p_request_sha256::text) !~ '^[0-9a-f]{64}$'
  THEN
    RAISE EXCEPTION 'automatic cutoff table turnover request is invalid' USING ERRCODE='22023';
  END IF;
$new$;
  old_permission_check text := $old$
  IF NOT mbox.employee_has_effective_permission(
    tenant_scope,store_scope,p_actor_employee_id,'table.close'
  ) OR NOT mbox.employee_has_effective_permission(
    tenant_scope,store_scope,p_actor_employee_id,'table.turnover_unsettled'
  ) THEN
    RAISE EXCEPTION 'employee lacks customer-left table turnover permission' USING ERRCODE='42501';
  END IF;
$old$;
  automatic_policy_check text := $new$
  IF NOT EXISTS (
    SELECT 1
    FROM mbox.store_automatic_table_turnover_policies policy
    WHERE policy.tenant_id=tenant_scope AND policy.store_id=store_scope
      AND policy.enabled=true
  ) THEN
    RAISE EXCEPTION 'automatic cutoff table turnover is disabled for this store' USING ERRCODE='42501';
  END IF;
$new$;
  date_check text := $old$
  IF authoritative_business_date IS NULL OR p_action_business_date<>authoritative_business_date THEN
    RAISE EXCEPTION 'customer-left table turnover business date is not current' USING ERRCODE='22023';
  END IF;
$old$;
  automatic_date_check text := $new$
  IF authoritative_business_date IS NULL OR p_action_business_date<>authoritative_business_date THEN
    RAISE EXCEPTION 'automatic cutoff table turnover business date is not current' USING ERRCODE='22023';
  END IF;
$new$;
  session_guard text := $old$
  IF session_row.status NOT IN ('open','closing') THEN
    RAISE EXCEPTION 'table session is not available for customer-left turnover'
      USING ERRCODE='55000';
  END IF;
$old$;
  automatic_session_guard text := $new$
  IF session_row.status NOT IN ('open','closing') THEN
    RAISE EXCEPTION 'table session is not available for automatic cutoff turnover'
      USING ERRCODE='55000';
  END IF;
  IF session_row.business_date >= authoritative_business_date THEN
    RAISE EXCEPTION 'automatic cutoff may only close a prior-business-day table session'
      USING ERRCODE='22023';
  END IF;
$new$;
  active_commitment_guard text := $old$
  -- Service calls can be cancelled as part of this operation, but these facts
  -- have their own customer/value commitments. Do not silently carry them into
  -- the next table occupant just because the payment itself is unresolved.
  IF EXISTS (
    SELECT 1
    FROM mbox.pricing_authorizations pricing_auth
    WHERE pricing_auth.tenant_id=tenant_scope AND pricing_auth.store_id=store_scope
      AND pricing_auth.table_session_id=p_table_session_id AND pricing_auth.status='reserved'
  ) OR EXISTS (
    SELECT 1
    FROM mbox.song_requests song
    WHERE song.tenant_id=tenant_scope AND song.store_id=store_scope
      AND song.table_session_id=p_table_session_id
      AND song.status IN ('requested','confirming','accepted','paid')
  ) OR EXISTS (
    SELECT 1
    FROM mbox.benefit_reservations reservation
    WHERE reservation.tenant_id=tenant_scope AND reservation.store_id=store_scope
      AND reservation.table_session_id=p_table_session_id AND reservation.status='reserved'
  ) OR EXISTS (
    SELECT 1
    FROM mbox.customer_experience_plans plan
    WHERE plan.tenant_id=tenant_scope AND plan.store_id=store_scope
      AND plan.table_session_id=p_table_session_id
      AND plan.plan_state IN ('planned','active','paused')
  ) OR EXISTS (
    SELECT 1
    FROM mbox.member_redemptions redemption
    WHERE redemption.tenant_id=tenant_scope AND redemption.store_id=store_scope
      AND redemption.table_session_id=p_table_session_id
      AND redemption.status IN ('authorizing','awaiting_fulfillment')
  ) OR EXISTS (
    SELECT 1
    FROM mbox.checkout_upgrade_offers offer
    WHERE offer.tenant_id=tenant_scope AND offer.store_id=store_scope
      AND offer.table_session_id=p_table_session_id AND offer.status IN ('offered','selected')
  ) THEN
    RAISE EXCEPTION 'an active customer commitment prevents customer-left turnover'
      USING ERRCODE='55000';
  END IF;
$old$;
  automatic_commitment_handling text := $new$
  -- The cutoff releases the physical table, not the financial or experience
  -- commitment. Existing authorization, benefit, song and experience facts
  -- remain tied to the closed session for the morning handover.
$new$;
BEGIN
  SELECT pg_get_functiondef(
    'mbox.close_table_after_customer_left(uuid,uuid,date,text,text,character)'::regprocedure
  ) INTO source_sql;
  IF source_sql IS NULL
    OR position(old_validation IN source_sql)=0
    OR position(old_permission_check IN source_sql)=0
    OR position(date_check IN source_sql)=0
    OR position(session_guard IN source_sql)=0
    OR position(active_commitment_guard IN source_sql)=0
    OR position('mbox.customer_left_turnover_digest(' IN source_sql)=0
    OR position('IF order_row.status=''completed'' AND order_row.payment_status IN (''unpaid'',''pending'') THEN' IN source_sql)=0
  THEN
    RAISE EXCEPTION 'customer-left turnover function does not match automatic-cutoff baseline'
      USING ERRCODE='55000';
  END IF;

  automatic_sql := replace(
    source_sql,
    'CREATE OR REPLACE FUNCTION mbox.close_table_after_customer_left(',
    'CREATE OR REPLACE FUNCTION mbox.close_table_after_automatic_cutoff('
  );
  automatic_sql := replace(automatic_sql, old_validation, automatic_validation);
  automatic_sql := replace(automatic_sql, old_permission_check, automatic_policy_check);
  automatic_sql := replace(automatic_sql, date_check, automatic_date_check);
  automatic_sql := replace(automatic_sql, session_guard, automatic_session_guard);
  automatic_sql := replace(automatic_sql, active_commitment_guard, automatic_commitment_handling);
  automatic_sql := replace(automatic_sql, 'customer-left:', 'automatic-cutoff:');
  automatic_sql := replace(automatic_sql, '''customer_left''', '''automatic_cutoff''');
  automatic_sql := replace(automatic_sql, '''guest_left''', '''automatic_cutoff''');
  automatic_sql := replace(automatic_sql, '''customer_left_turnover''', '''automatic_cutoff_turnover''');
  automatic_sql := replace(automatic_sql, '''customer_left_cancelled''', '''automatic_cutoff_cancelled''');
  automatic_sql := replace(automatic_sql, '''employee'',p_actor_employee_id,btrim(p_reason_note)', '''system'',NULL,btrim(p_reason_note)');
  automatic_sql := replace(
    automatic_sql,
    'tenant_id,store_id,table_session_id,table_code,actor_employee_id,',
    'tenant_id,store_id,table_session_id,table_code,actor_type,actor_employee_id,'
  );
  automatic_sql := replace(
    automatic_sql,
    'tenant_scope,store_scope,p_table_session_id,session_row.code,p_actor_employee_id,',
    'tenant_scope,store_scope,p_table_session_id,session_row.code,''system'',p_actor_employee_id,'
  );
  automatic_sql := replace(
    automatic_sql,
    'tenant_id,store_id,order_id,order_public_id,actor_employee_id,',
    'tenant_id,store_id,order_id,order_public_id,actor_type,actor_employee_id,'
  );
  automatic_sql := replace(
    automatic_sql,
    'tenant_scope,store_scope,order_row.id,order_row.public_id,p_actor_employee_id,',
    'tenant_scope,store_scope,order_row.id,order_row.public_id,''system'',p_actor_employee_id,'
  );
  IF position('table_customer_left_turnover_events (' IN automatic_sql)=0
    OR position('table_code,actor_type,actor_employee_id,' IN automatic_sql)=0
    OR position('order_public_id,actor_type,actor_employee_id,' IN automatic_sql)=0
    OR position('''automatic_cutoff''' IN automatic_sql)=0
  THEN
    RAISE EXCEPTION 'automatic cutoff turnover function transformation was incomplete'
      USING ERRCODE='55000';
  END IF;
  EXECUTE automatic_sql;
END $migration$;

REVOKE ALL ON FUNCTION mbox.close_table_after_automatic_cutoff(uuid,uuid,date,text,text,char) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mbox.close_table_after_automatic_cutoff(uuid,uuid,date,text,text,char) TO mbox_runtime;

COMMENT ON TABLE mbox.store_automatic_table_turnover_policies IS
  'Versioned operating-window policy. Enabled stores automatically release only stale physical table sessions after the business-day cutoff.';
COMMENT ON FUNCTION mbox.close_table_after_automatic_cutoff(uuid,uuid,date,text,text,char) IS
  'System-only, policy-gated cutoff turnover. It retires unfulfilled work but preserves payments, refunds and late-provider evidence for reconciliation.';

UPDATE mbox.normalized_schema_metadata
SET schema_version='149',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
