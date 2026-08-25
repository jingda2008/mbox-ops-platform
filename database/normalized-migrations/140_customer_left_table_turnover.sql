BEGIN;

-- Migration 139 deliberately allows a staff-released, still-unresolved online
-- attempt to coexist with its replacement. Rebuild the active-intent boundary
-- with the release marker in its predicate: an employee must explicitly
-- release the old attempt before a replacement can exist, while a late
-- verified provider success remains auditable on that old row.
DROP INDEX IF EXISTS mbox.payments_one_active_intent_per_order_uq;
CREATE UNIQUE INDEX payments_one_active_intent_per_order_uq
  ON mbox.payments (tenant_id, store_id, order_id)
  WHERE status IN ('created','pending') AND retry_released_at IS NULL;

-- A customer leaving without an authoritative successful payment must not trap
-- the table. This is a distinct, permissioned operation: it never fabricates a
-- payment and keeps any late provider outcome visible for cashier handover.
CREATE TABLE mbox.table_customer_left_turnover_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  table_session_id uuid NOT NULL,
  table_code text NOT NULL CHECK (length(btrim(table_code)) BETWEEN 1 AND 64),
  actor_employee_id uuid NOT NULL,
  source_business_date date NOT NULL,
  action_business_date date NOT NULL,
  reason_code text NOT NULL CHECK (reason_code = 'customer_left'),
  reason_note text NOT NULL CHECK (length(btrim(reason_note)) BETWEEN 4 AND 500),
  cancelled_order_count integer NOT NULL CHECK (cancelled_order_count >= 0),
  pending_payment_count integer NOT NULL CHECK (pending_payment_count >= 0),
  delivered_unpaid_amount_minor bigint NOT NULL CHECK (delivered_unpaid_amount_minor >= 0),
  cancelled_service_task_count integer NOT NULL CHECK (cancelled_service_task_count >= 0),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 160),
  request_sha256 char(64) NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, table_session_id) REFERENCES mbox.table_sessions(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, actor_employee_id) REFERENCES mbox.employees(tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, table_session_id),
  UNIQUE (tenant_id, store_id, idempotency_key)
);

CREATE INDEX table_customer_left_turnover_timeline_idx
  ON mbox.table_customer_left_turnover_events(tenant_id, store_id, occurred_at, id);

CREATE TRIGGER table_customer_left_turnover_events_append_only
  BEFORE UPDATE OR DELETE ON mbox.table_customer_left_turnover_events
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();

-- 101 deliberately accepted only manager-approved reasons. Customer-left is
-- still an exception fact, but is created atomically by the table-turnover
-- command and therefore needs a distinct reason in the same read model.
ALTER TABLE mbox.order_settlement_exception_events
  DROP CONSTRAINT IF EXISTS order_settlement_exception_events_reason_code_check;
ALTER TABLE mbox.order_settlement_exception_events
  ADD CONSTRAINT order_settlement_exception_events_reason_code_check
  CHECK (reason_code IN ('manager_comp','uncollectible','test_cleanup','customer_left'));

CREATE OR REPLACE FUNCTION mbox.close_table_after_customer_left(
  p_table_session_id uuid,
  p_actor_employee_id uuid,
  p_action_business_date date,
  p_reason_note text,
  p_idempotency_key text,
  p_request_sha256 char(64)
)
RETURNS TABLE (
  event_id uuid,
  table_session_id uuid,
  table_code text,
  source_business_date date,
  action_business_date date,
  cancelled_order_count integer,
  pending_payment_count integer,
  delivered_unpaid_amount_minor bigint,
  cancelled_service_task_count integer,
  occurred_at timestamptz,
  replayed boolean
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,mbox AS $$
DECLARE
  tenant_scope uuid := mbox.current_tenant_id();
  store_scope uuid := mbox.current_store_id();
  session_row record;
  existing_event mbox.table_customer_left_turnover_events%ROWTYPE;
  new_event mbox.table_customer_left_turnover_events%ROWTYPE;
  order_row record;
  task_row record;
  delivered_count integer;
  cancelled_items integer;
  cancelled_tasks integer;
  released_reservations integer;
  delivered_amount bigint;
  cancelled_orders integer := 0;
  pending_payments integer := 0;
  delivered_unpaid_total bigint := 0;
  cancelled_service_tasks integer := 0;
  reservation_demand record;
  authoritative_business_date date;
  order_cancel_key text;
  order_cancel_hash char(64);
  settlement_key text;
  settlement_hash char(64);
  task_event_key text;
BEGIN
  IF p_table_session_id IS NULL OR p_actor_employee_id IS NULL
    OR p_action_business_date IS NULL
    OR length(btrim(COALESCE(p_reason_note,''))) NOT BETWEEN 4 AND 500
    OR length(btrim(COALESCE(p_idempotency_key,''))) NOT BETWEEN 8 AND 160
    OR p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{7,159}$'
    OR btrim(p_request_sha256::text) !~ '^[0-9a-f]{64}$'
  THEN
    RAISE EXCEPTION 'customer-left table turnover request is invalid' USING ERRCODE='22023';
  END IF;

  SELECT ((clock_timestamp() AT TIME ZONE store.timezone)-store.business_day_cutoff)::date
  INTO authoritative_business_date
  FROM mbox.stores store
  WHERE store.tenant_id=tenant_scope AND store.id=store_scope AND store.status='active';
  IF authoritative_business_date IS NULL OR p_action_business_date<>authoritative_business_date THEN
    RAISE EXCEPTION 'customer-left table turnover business date is not current' USING ERRCODE='22023';
  END IF;
  IF NOT mbox.employee_has_effective_permission(
    tenant_scope,store_scope,p_actor_employee_id,'table.close'
  ) OR NOT mbox.employee_has_effective_permission(
    tenant_scope,store_scope,p_actor_employee_id,'table.turnover_unsettled'
  ) THEN
    RAISE EXCEPTION 'employee lacks customer-left table turnover permission' USING ERRCODE='42501';
  END IF;

  -- One permanent event per table session is the durable replay boundary. The
  -- application command executor supplies a second idempotency boundary, but
  -- this one survives command-record expiry and protects the closed table.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    tenant_scope::text || ':' || store_scope::text || ':table.customer_left:' || p_table_session_id::text,
    0
  ));
  SELECT * INTO existing_event
  FROM mbox.table_customer_left_turnover_events event
  WHERE event.tenant_id=tenant_scope AND event.store_id=store_scope
    AND event.table_session_id=p_table_session_id;
  IF FOUND THEN
    IF existing_event.request_sha256<>btrim(p_request_sha256::text)::char(64)
      OR existing_event.idempotency_key<>p_idempotency_key THEN
      RAISE EXCEPTION 'customer-left table turnover already completed with another request'
        USING ERRCODE='23505';
    END IF;
    RETURN QUERY SELECT existing_event.id,existing_event.table_session_id,
      existing_event.table_code,existing_event.source_business_date,
      existing_event.action_business_date,existing_event.cancelled_order_count,
      existing_event.pending_payment_count,existing_event.delivered_unpaid_amount_minor,
      existing_event.cancelled_service_task_count,existing_event.occurred_at,true;
    RETURN;
  END IF;

  SELECT session.id,session.business_date,session.status,venue_table.code
  INTO session_row
  FROM mbox.table_sessions session
  JOIN mbox.tables venue_table
    ON venue_table.tenant_id=session.tenant_id AND venue_table.store_id=session.store_id
   AND venue_table.id=session.table_id
  WHERE session.tenant_id=tenant_scope AND session.store_id=store_scope
    AND session.id=p_table_session_id
  FOR UPDATE OF session;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'table session not found' USING ERRCODE='P0002';
  END IF;
  IF session_row.status NOT IN ('open','closing') THEN
    RAISE EXCEPTION 'table session is not available for customer-left turnover'
      USING ERRCODE='55000';
  END IF;

  -- Do the safety scan before mutating anything. A confirmed/partially paid
  -- outcome is never reclassified as a customer-left unpaid handover.
  IF EXISTS (
    SELECT 1
    FROM mbox.orders ordering
    WHERE ordering.tenant_id=tenant_scope AND ordering.store_id=store_scope
      AND ordering.table_session_id=p_table_session_id
      AND ordering.status<>'cancelled'
      AND ordering.payment_status NOT IN ('unpaid','pending')
    FOR UPDATE
  ) THEN
    RAISE EXCEPTION 'a confirmed or partially paid order prevents customer-left turnover'
      USING ERRCODE='55000';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM mbox.payments payment
    JOIN mbox.orders ordering
      ON ordering.tenant_id=payment.tenant_id AND ordering.store_id=payment.store_id
     AND ordering.id=payment.order_id
    WHERE payment.tenant_id=tenant_scope AND payment.store_id=store_scope
      AND ordering.table_session_id=p_table_session_id
      AND payment.status IN ('succeeded','partially_refunded','refunded')
    FOR UPDATE OF payment,ordering
  ) THEN
    RAISE EXCEPTION 'a successful payment prevents customer-left turnover'
      USING ERRCODE='55000';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM mbox.refunds refund
    JOIN mbox.payments payment
      ON payment.tenant_id=refund.tenant_id AND payment.store_id=refund.store_id
     AND payment.id=refund.payment_id
    JOIN mbox.orders ordering
      ON ordering.tenant_id=payment.tenant_id AND ordering.store_id=payment.store_id
     AND ordering.id=payment.order_id
    WHERE refund.tenant_id=tenant_scope AND refund.store_id=store_scope
      AND ordering.table_session_id=p_table_session_id
      AND refund.status IN ('requested','approved','processing','succeeded')
    FOR UPDATE OF refund,payment,ordering
  ) THEN
    RAISE EXCEPTION 'an active refund prevents customer-left turnover' USING ERRCODE='55000';
  END IF;

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

  FOR order_row IN
    SELECT ordering.*
    FROM mbox.orders ordering
    WHERE ordering.tenant_id=tenant_scope AND ordering.store_id=store_scope
      AND ordering.table_session_id=p_table_session_id
      AND ordering.status<>'cancelled'
    ORDER BY ordering.created_at,ordering.id
    FOR UPDATE
  LOOP
    IF order_row.status='cancelled' THEN
      CONTINUE;
    END IF;
    IF order_row.payment_status NOT IN ('unpaid','pending') THEN
      RAISE EXCEPTION 'order payment state changed during customer-left turnover'
        USING ERRCODE='40001';
    END IF;

    SELECT count(*)::integer INTO delivered_count
    FROM mbox.order_items item
    WHERE item.tenant_id=tenant_scope AND item.store_id=store_scope
      AND item.order_id=order_row.id AND item.status='delivered';

    -- A fully delivered order can already be marked completed. Preserve that
    -- order and its delivered facts; only record the unpaid handover below.
    IF order_row.status='completed' THEN
      SELECT COALESCE(sum(item.total_amount_minor),0)::bigint INTO delivered_amount
      FROM mbox.order_items item
      WHERE item.tenant_id=tenant_scope AND item.store_id=store_scope
        AND item.order_id=order_row.id AND item.status='delivered';
      IF delivered_amount > 0 THEN
        settlement_key := 'customer-left:settle:' || encode(public.digest(
          p_idempotency_key || ':' || order_row.id::text,'sha256'),'hex');
        settlement_hash := encode(public.digest(
          btrim(p_request_sha256::text) || ':settle:' || order_row.id::text,'sha256'),'hex');
        INSERT INTO mbox.order_settlement_exception_events (
          tenant_id,store_id,order_id,order_public_id,actor_employee_id,
          source_business_date,action_business_date,reason_code,reason_note,
          settled_amount_minor,idempotency_key,request_sha256
        ) VALUES (
          tenant_scope,store_scope,order_row.id,order_row.public_id,p_actor_employee_id,
          session_row.business_date,p_action_business_date,'customer_left',btrim(p_reason_note),
          delivered_amount,settlement_key,settlement_hash
        );
        delivered_unpaid_total := delivered_unpaid_total + delivered_amount;
      END IF;
      CONTINUE;
    END IF;

    WITH cancelled AS (
      UPDATE mbox.kds_tasks task SET status='cancelled',cancelled_at=clock_timestamp(),
        updated_at=clock_timestamp()
      FROM mbox.order_items item
      WHERE item.tenant_id=task.tenant_id AND item.store_id=task.store_id
        AND item.id=task.order_item_id AND item.order_id=order_row.id
        AND item.status NOT IN ('delivered','cancelled')
        AND task.tenant_id=tenant_scope AND task.store_id=store_scope
        AND task.status NOT IN ('cancelled','failed')
      RETURNING task.id
    ) SELECT count(*)::integer INTO cancelled_tasks FROM cancelled;

    WITH cancelled AS (
      UPDATE mbox.order_items SET status='cancelled',updated_at=clock_timestamp()
      WHERE tenant_id=tenant_scope AND store_id=store_scope AND order_id=order_row.id
        AND status NOT IN ('delivered','cancelled')
      RETURNING id
    ) SELECT count(*)::integer INTO cancelled_items FROM cancelled;

    IF EXISTS (
      SELECT 1
      FROM mbox.inventory_order_reservations reservation
      JOIN mbox.order_items item
        ON item.tenant_id=reservation.tenant_id AND item.store_id=reservation.store_id
       AND item.order_id=reservation.order_id AND item.id=reservation.order_item_id
      WHERE reservation.tenant_id=tenant_scope AND reservation.store_id=store_scope
        AND reservation.order_id=order_row.id AND reservation.status='reserved'
        AND item.status='delivered'
      FOR UPDATE OF reservation,item
    ) THEN
      RAISE EXCEPTION 'delivered item still has reserved inventory' USING ERRCODE='55000';
    END IF;

    PERFORM 1
    FROM mbox.inventory_order_reservations reservation
    JOIN mbox.order_items item
      ON item.tenant_id=reservation.tenant_id AND item.store_id=reservation.store_id
     AND item.order_id=reservation.order_id AND item.id=reservation.order_item_id
    WHERE reservation.tenant_id=tenant_scope AND reservation.store_id=store_scope
      AND reservation.order_id=order_row.id AND reservation.status='reserved'
      AND item.status='cancelled'
    ORDER BY reservation.inventory_item_id,reservation.id FOR UPDATE;
    FOR reservation_demand IN
      SELECT reservation.inventory_item_id,sum(reservation.quantity) AS quantity
      FROM mbox.inventory_order_reservations reservation
      JOIN mbox.order_items item
        ON item.tenant_id=reservation.tenant_id AND item.store_id=reservation.store_id
       AND item.order_id=reservation.order_id AND item.id=reservation.order_item_id
      WHERE reservation.tenant_id=tenant_scope AND reservation.store_id=store_scope
        AND reservation.order_id=order_row.id AND reservation.status='reserved'
        AND item.status='cancelled'
      GROUP BY reservation.inventory_item_id ORDER BY reservation.inventory_item_id
    LOOP
      UPDATE mbox.inventory_balances balance
      SET reserved_quantity=balance.reserved_quantity-reservation_demand.quantity,
        updated_at=clock_timestamp()
      WHERE balance.tenant_id=tenant_scope AND balance.store_id=store_scope
        AND balance.inventory_item_id=reservation_demand.inventory_item_id
        AND balance.reserved_quantity>=reservation_demand.quantity;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'reserved inventory balance is inconsistent' USING ERRCODE='55000';
      END IF;
    END LOOP;

    WITH released AS (
      UPDATE mbox.inventory_order_reservations reservation
      SET status='released',expires_at=NULL,released_at=clock_timestamp(),
        release_reason='customer_left_turnover',updated_at=clock_timestamp()
      FROM mbox.order_items item
      WHERE item.tenant_id=reservation.tenant_id AND item.store_id=reservation.store_id
        AND item.order_id=reservation.order_id AND item.id=reservation.order_item_id
        AND reservation.tenant_id=tenant_scope AND reservation.store_id=store_scope
        AND reservation.order_id=order_row.id AND reservation.status='reserved'
        AND item.status='cancelled'
      RETURNING reservation.id
    ) SELECT count(*)::integer INTO released_reservations FROM released;

    UPDATE mbox.orders SET status='cancelled',cancelled_at=clock_timestamp(),completed_at=NULL,
      fulfillment_state='cancelled',fulfillment_expires_at=NULL,fulfillment_activated_at=NULL,
      fulfillment_released_at=clock_timestamp(),updated_at=clock_timestamp()
    WHERE tenant_id=tenant_scope AND store_id=store_scope AND id=order_row.id;

    order_cancel_key := 'customer-left:cancel:' || encode(public.digest(
      p_idempotency_key || ':' || order_row.id::text,'sha256'),'hex');
    order_cancel_hash := encode(public.digest(
      btrim(p_request_sha256::text) || ':' || order_row.id::text,'sha256'),'hex');
    INSERT INTO mbox.order_cancellation_events (
      tenant_id,store_id,order_id,order_public_id,actor_employee_id,
      source_business_date,action_business_date,reason_code,reason_note,
      delivered_item_count,cancelled_item_count,cancelled_kds_task_count,
      released_inventory_reservation_count,idempotency_key,request_sha256
    ) VALUES (
      tenant_scope,store_scope,order_row.id,order_row.public_id,p_actor_employee_id,
      session_row.business_date,p_action_business_date,'guest_left',btrim(p_reason_note),
      delivered_count,cancelled_items,cancelled_tasks,released_reservations,
      order_cancel_key,order_cancel_hash
    );
    cancelled_orders := cancelled_orders + 1;

    SELECT COALESCE(sum(item.total_amount_minor),0)::bigint INTO delivered_amount
    FROM mbox.order_items item
    WHERE item.tenant_id=tenant_scope AND item.store_id=store_scope
      AND item.order_id=order_row.id AND item.status='delivered';
    IF delivered_amount > 0 THEN
      settlement_key := 'customer-left:settle:' || encode(public.digest(
        p_idempotency_key || ':' || order_row.id::text,'sha256'),'hex');
      settlement_hash := encode(public.digest(
        btrim(p_request_sha256::text) || ':settle:' || order_row.id::text,'sha256'),'hex');
      INSERT INTO mbox.order_settlement_exception_events (
        tenant_id,store_id,order_id,order_public_id,actor_employee_id,
        source_business_date,action_business_date,reason_code,reason_note,
        settled_amount_minor,idempotency_key,request_sha256
      ) VALUES (
        tenant_scope,store_scope,order_row.id,order_row.public_id,p_actor_employee_id,
        session_row.business_date,p_action_business_date,'customer_left',btrim(p_reason_note),
        delivered_amount,settlement_key,settlement_hash
      );
      delivered_unpaid_total := delivered_unpaid_total + delivered_amount;
    END IF;
  END LOOP;

  SELECT count(*)::integer INTO pending_payments
  FROM mbox.payments payment
  JOIN mbox.orders ordering
    ON ordering.tenant_id=payment.tenant_id AND ordering.store_id=payment.store_id
   AND ordering.id=payment.order_id
  WHERE payment.tenant_id=tenant_scope AND payment.store_id=store_scope
    AND ordering.table_session_id=p_table_session_id AND payment.status IN ('created','pending');

  FOR task_row IN
    SELECT task.id,task.status
    FROM mbox.service_tasks task
    WHERE task.tenant_id=tenant_scope AND task.store_id=store_scope
      AND task.table_session_id=p_table_session_id
      AND task.status IN ('pending','acknowledged','in_progress')
    ORDER BY task.id
    FOR UPDATE
  LOOP
    UPDATE mbox.service_tasks task
    SET status='cancelled',cancelled_at=clock_timestamp(),updated_at=clock_timestamp()
    WHERE task.tenant_id=tenant_scope AND task.store_id=store_scope
      AND task.id=task_row.id AND task.status=task_row.status;
    IF NOT FOUND THEN
      CONTINUE;
    END IF;
    task_event_key := 'customer-left:task:' || encode(public.digest(
      p_idempotency_key || ':' || task_row.id::text,'sha256'),'hex');
    INSERT INTO mbox.service_task_events (
      tenant_id,store_id,service_task_id,event_type,from_status,to_status,
      actor_type,actor_employee_id,note,idempotency_key
    ) VALUES (
      tenant_scope,store_scope,task_row.id,'customer_left_cancelled',task_row.status,'cancelled',
      'employee',p_actor_employee_id,btrim(p_reason_note),task_event_key
    );
    cancelled_service_tasks := cancelled_service_tasks + 1;
  END LOOP;

  UPDATE mbox.table_sessions
  SET status='closed',closed_by_employee_id=p_actor_employee_id,closed_at=clock_timestamp()
  WHERE tenant_id=tenant_scope AND store_id=store_scope
    AND id=p_table_session_id AND status IN ('open','closing');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'table session changed before customer-left turnover completed'
      USING ERRCODE='40001';
  END IF;

  INSERT INTO mbox.table_customer_left_turnover_events (
    tenant_id,store_id,table_session_id,table_code,actor_employee_id,
    source_business_date,action_business_date,reason_code,reason_note,
    cancelled_order_count,pending_payment_count,delivered_unpaid_amount_minor,
    cancelled_service_task_count,idempotency_key,request_sha256
  ) VALUES (
    tenant_scope,store_scope,p_table_session_id,session_row.code,p_actor_employee_id,
    session_row.business_date,p_action_business_date,'customer_left',btrim(p_reason_note),
    cancelled_orders,pending_payments,delivered_unpaid_total,cancelled_service_tasks,
    p_idempotency_key,btrim(p_request_sha256::text)
  ) RETURNING * INTO new_event;

  RETURN QUERY SELECT new_event.id,new_event.table_session_id,new_event.table_code,
    new_event.source_business_date,new_event.action_business_date,
    new_event.cancelled_order_count,new_event.pending_payment_count,
    new_event.delivered_unpaid_amount_minor,new_event.cancelled_service_task_count,
    new_event.occurred_at,false;
END $$;

ALTER TABLE mbox.table_customer_left_turnover_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.table_customer_left_turnover_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.table_customer_left_turnover_events
  USING (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())
  WITH CHECK (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());

REVOKE ALL ON TABLE mbox.table_customer_left_turnover_events FROM PUBLIC;
REVOKE INSERT,UPDATE,DELETE ON TABLE mbox.table_customer_left_turnover_events FROM mbox_runtime;
GRANT SELECT ON TABLE mbox.table_customer_left_turnover_events TO mbox_runtime;
REVOKE ALL ON FUNCTION mbox.close_table_after_customer_left(uuid,uuid,date,text,text,char) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mbox.close_table_after_customer_left(uuid,uuid,date,text,text,char) TO mbox_runtime;

INSERT INTO mbox.staff_permission_definitions (
  tenant_id,store_id,code,name,category,description,status
)
SELECT store.tenant_id,store.id,'table.turnover_unsettled','顾客离店异常翻台','table',
  '未收到明确成功收款时，取消未履约部分、保留晚到支付事实并允许本桌翻台','active'
FROM mbox.stores store
ON CONFLICT (tenant_id,store_id,code) DO UPDATE SET
  name=EXCLUDED.name,category=EXCLUDED.category,description=EXCLUDED.description,status='active';

INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id)
SELECT role.tenant_id,role.store_id,role.id,permission.id
FROM mbox.roles role
JOIN mbox.staff_permission_definitions permission
  ON permission.tenant_id=role.tenant_id AND permission.store_id=role.store_id
 AND permission.code='table.turnover_unsettled'
WHERE role.code IN ('OWNER','OPS_LEAD','MANAGER','DEPUT_MANAGER','SERVER')
ON CONFLICT (tenant_id,store_id,role_id,permission_id) DO NOTHING;

COMMENT ON TABLE mbox.table_customer_left_turnover_events IS
  'Append-only customer-left turnover facts. A pending/unknown payment remains visible for cashier follow-up and is never treated as paid.';
COMMENT ON FUNCTION mbox.close_table_after_customer_left(uuid,uuid,date,text,text,char) IS
  'Atomically cancels unfulfilled work, preserves delivered facts, records any delivered unpaid amount, and closes a table after a customer leaves without confirmed payment.';

UPDATE mbox.normalized_schema_metadata
SET schema_version='140',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
