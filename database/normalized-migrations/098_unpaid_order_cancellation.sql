BEGIN;

CREATE TABLE mbox.order_cancellation_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  order_id uuid NOT NULL,
  order_public_id text NOT NULL CHECK (length(order_public_id) BETWEEN 8 AND 128),
  actor_employee_id uuid NOT NULL,
  source_business_date date NOT NULL,
  action_business_date date NOT NULL,
  reason_code text NOT NULL CHECK (reason_code IN ('duplicate_order','guest_left','test_cleanup','other')),
  reason_note text NOT NULL CHECK (length(btrim(reason_note)) BETWEEN 4 AND 500),
  delivered_item_count integer NOT NULL CHECK (delivered_item_count >= 0),
  cancelled_item_count integer NOT NULL CHECK (cancelled_item_count >= 0),
  cancelled_kds_task_count integer NOT NULL CHECK (cancelled_kds_task_count >= 0),
  released_inventory_reservation_count integer NOT NULL CHECK (released_inventory_reservation_count >= 0),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$'),
  request_sha256 char(64) NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
  FOREIGN KEY (tenant_id,store_id,order_id) REFERENCES mbox.orders(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,actor_employee_id) REFERENCES mbox.employees(tenant_id,store_id,id),
  UNIQUE (tenant_id,store_id,id),
  UNIQUE (tenant_id,store_id,idempotency_key)
);

CREATE INDEX order_cancellation_events_order_timeline_idx
  ON mbox.order_cancellation_events(tenant_id,store_id,order_id,occurred_at,id);

CREATE TRIGGER order_cancellation_events_append_only
  BEFORE UPDATE OR DELETE ON mbox.order_cancellation_events
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();

CREATE OR REPLACE FUNCTION mbox.cancel_unpaid_order(
  p_order_id uuid,
  p_actor_employee_id uuid,
  p_action_business_date date,
  p_reason_code text,
  p_reason_note text,
  p_idempotency_key text,
  p_request_sha256 char(64)
)
RETURNS TABLE (
  event_id uuid,
  order_public_id text,
  source_business_date date,
  action_business_date date,
  delivered_item_count integer,
  cancelled_item_count integer,
  cancelled_kds_task_count integer,
  released_inventory_reservation_count integer,
  occurred_at timestamptz,
  replayed boolean
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,mbox AS $$
DECLARE
  tenant_scope uuid := mbox.current_tenant_id();
  store_scope uuid := mbox.current_store_id();
  order_row record;
  existing_event mbox.order_cancellation_events%ROWTYPE;
  new_event mbox.order_cancellation_events%ROWTYPE;
  delivered_count integer;
  cancelled_items integer;
  cancelled_tasks integer;
  released_reservations integer;
  reservation_demand record;
  authoritative_business_date date;
BEGIN
  IF p_actor_employee_id IS NULL OR p_order_id IS NULL OR p_action_business_date IS NULL
    OR p_reason_code NOT IN ('duplicate_order','guest_left','test_cleanup','other')
    OR length(btrim(COALESCE(p_reason_note,''))) NOT BETWEEN 4 AND 500
    OR p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$'
    OR p_request_sha256 !~ '^[0-9a-f]{64}$'
  THEN
    RAISE EXCEPTION 'unpaid order cancellation request is invalid' USING ERRCODE='22023';
  END IF;
  SELECT ((clock_timestamp() AT TIME ZONE store.timezone)-store.business_day_cutoff)::date
  INTO authoritative_business_date
  FROM mbox.stores store
  WHERE store.tenant_id=tenant_scope AND store.id=store_scope AND store.status='active';
  IF authoritative_business_date IS NULL OR p_action_business_date<>authoritative_business_date THEN
    RAISE EXCEPTION 'unpaid order cancellation business date is not current' USING ERRCODE='22023';
  END IF;
  IF NOT mbox.employee_has_effective_permission(
    tenant_scope,store_scope,p_actor_employee_id,'order.cancel_unpaid'
  ) THEN
    RAISE EXCEPTION 'employee lacks unpaid order cancellation permission' USING ERRCODE='42501';
  END IF;

  -- Serialize the permanent command key before reading its append-only result so
  -- two concurrent retries return the same fact instead of racing into order state.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    tenant_scope::text || ':' || store_scope::text || ':order.cancel_unpaid:' || p_idempotency_key,
    0
  ));

  SELECT * INTO existing_event
  FROM mbox.order_cancellation_events event
  WHERE event.tenant_id=tenant_scope AND event.store_id=store_scope
    AND event.idempotency_key=p_idempotency_key;
  IF FOUND THEN
    IF existing_event.request_sha256<>p_request_sha256 THEN
      RAISE EXCEPTION 'unpaid order cancellation idempotency conflict' USING ERRCODE='23505';
    END IF;
    RETURN QUERY SELECT existing_event.id,existing_event.order_public_id,
      existing_event.source_business_date,existing_event.action_business_date,
      existing_event.delivered_item_count,existing_event.cancelled_item_count,
      existing_event.cancelled_kds_task_count,
      existing_event.released_inventory_reservation_count,
      existing_event.occurred_at,true;
    RETURN;
  END IF;

  SELECT ordering.*,session.business_date INTO order_row
  FROM mbox.orders ordering
  JOIN mbox.table_sessions session
    ON session.tenant_id=ordering.tenant_id AND session.store_id=ordering.store_id
   AND session.id=ordering.table_session_id
  WHERE ordering.tenant_id=tenant_scope AND ordering.store_id=store_scope
    AND ordering.id=p_order_id
  FOR UPDATE OF ordering,session;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order not found' USING ERRCODE='P0002';
  END IF;
  IF order_row.status='cancelled' OR order_row.payment_status<>'unpaid' THEN
    RAISE EXCEPTION 'only an unpaid non-cancelled order may be cancelled' USING ERRCODE='55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM mbox.payments payment
    WHERE payment.tenant_id=tenant_scope AND payment.store_id=store_scope
      AND payment.order_id=p_order_id AND payment.status NOT IN ('failed','closed')
    FOR UPDATE
  ) THEN
    RAISE EXCEPTION 'payment must be closed or failed before order cancellation' USING ERRCODE='55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM mbox.refunds refund
    JOIN mbox.payments payment
      ON payment.tenant_id=refund.tenant_id AND payment.store_id=refund.store_id
     AND payment.id=refund.payment_id
    WHERE payment.tenant_id=tenant_scope AND payment.store_id=store_scope
      AND payment.order_id=p_order_id
    FOR UPDATE OF refund,payment
  ) THEN
    RAISE EXCEPTION 'order with refund evidence cannot use unpaid cancellation' USING ERRCODE='55000';
  END IF;

  SELECT count(*)::integer INTO delivered_count
  FROM mbox.order_items item
  WHERE item.tenant_id=tenant_scope AND item.store_id=store_scope
    AND item.order_id=p_order_id AND item.status='delivered';

  WITH cancelled AS (
    UPDATE mbox.kds_tasks task SET status='cancelled',cancelled_at=clock_timestamp(),
      updated_at=clock_timestamp()
    FROM mbox.order_items item
    WHERE item.tenant_id=task.tenant_id AND item.store_id=task.store_id
      AND item.id=task.order_item_id AND item.order_id=p_order_id
      AND item.status NOT IN ('delivered','cancelled')
      AND task.tenant_id=tenant_scope AND task.store_id=store_scope
      AND task.status NOT IN ('cancelled','failed')
    RETURNING task.id
  ) SELECT count(*)::integer INTO cancelled_tasks FROM cancelled;

  WITH cancelled AS (
    UPDATE mbox.order_items SET status='cancelled',updated_at=clock_timestamp()
    WHERE tenant_id=tenant_scope AND store_id=store_scope AND order_id=p_order_id
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
      AND reservation.order_id=p_order_id AND reservation.status='reserved'
      AND item.status='delivered'
    FOR UPDATE OF reservation,item
  ) THEN
    RAISE EXCEPTION 'delivered item still has reserved inventory' USING ERRCODE='55000';
  END IF;

  PERFORM 1 FROM mbox.inventory_order_reservations reservation
  JOIN mbox.order_items item
    ON item.tenant_id=reservation.tenant_id AND item.store_id=reservation.store_id
   AND item.order_id=reservation.order_id AND item.id=reservation.order_item_id
  WHERE reservation.tenant_id=tenant_scope AND reservation.store_id=store_scope
    AND reservation.order_id=p_order_id AND reservation.status='reserved'
    AND item.status='cancelled'
  ORDER BY reservation.inventory_item_id,reservation.id FOR UPDATE;
  FOR reservation_demand IN
    SELECT reservation.inventory_item_id,sum(reservation.quantity) AS quantity
    FROM mbox.inventory_order_reservations reservation
    JOIN mbox.order_items item
      ON item.tenant_id=reservation.tenant_id AND item.store_id=reservation.store_id
     AND item.order_id=reservation.order_id AND item.id=reservation.order_item_id
    WHERE reservation.tenant_id=tenant_scope AND reservation.store_id=store_scope
      AND reservation.order_id=p_order_id AND reservation.status='reserved'
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
      release_reason='unpaid_order_cancelled',updated_at=clock_timestamp()
    FROM mbox.order_items item
    WHERE item.tenant_id=reservation.tenant_id AND item.store_id=reservation.store_id
      AND item.order_id=reservation.order_id AND item.id=reservation.order_item_id
      AND reservation.tenant_id=tenant_scope AND reservation.store_id=store_scope
      AND reservation.order_id=p_order_id AND reservation.status='reserved'
      AND item.status='cancelled'
    RETURNING reservation.id
  ) SELECT count(*)::integer INTO released_reservations FROM released;

  UPDATE mbox.orders SET status='cancelled',cancelled_at=clock_timestamp(),completed_at=NULL,
    fulfillment_state='cancelled',fulfillment_expires_at=NULL,fulfillment_activated_at=NULL,
    fulfillment_released_at=clock_timestamp(),updated_at=clock_timestamp()
  WHERE tenant_id=tenant_scope AND store_id=store_scope AND id=p_order_id;

  INSERT INTO mbox.order_cancellation_events (
    tenant_id,store_id,order_id,order_public_id,actor_employee_id,
    source_business_date,action_business_date,reason_code,reason_note,
    delivered_item_count,cancelled_item_count,cancelled_kds_task_count,
    released_inventory_reservation_count,idempotency_key,request_sha256
  ) VALUES (
    tenant_scope,store_scope,p_order_id,order_row.public_id,p_actor_employee_id,
    order_row.business_date,p_action_business_date,p_reason_code,btrim(p_reason_note),
    delivered_count,cancelled_items,cancelled_tasks,released_reservations,
    p_idempotency_key,p_request_sha256
  ) RETURNING * INTO new_event;

  RETURN QUERY SELECT new_event.id,new_event.order_public_id,new_event.source_business_date,
    new_event.action_business_date,new_event.delivered_item_count,new_event.cancelled_item_count,
    new_event.cancelled_kds_task_count,new_event.released_inventory_reservation_count,
    new_event.occurred_at,false;
END $$;

ALTER TABLE mbox.order_cancellation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.order_cancellation_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.order_cancellation_events
  USING (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())
  WITH CHECK (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());

REVOKE ALL ON TABLE mbox.order_cancellation_events FROM PUBLIC;
REVOKE INSERT,UPDATE,DELETE ON TABLE mbox.order_cancellation_events FROM mbox_runtime;
GRANT SELECT ON TABLE mbox.order_cancellation_events TO mbox_runtime;
REVOKE ALL ON FUNCTION mbox.cancel_unpaid_order(uuid,uuid,date,text,text,text,char) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mbox.cancel_unpaid_order(uuid,uuid,date,text,text,text,char) TO mbox_runtime;

INSERT INTO mbox.staff_permission_definitions (
  tenant_id,store_id,code,name,category,description,status
)
SELECT store.tenant_id,store.id,'order.cancel_unpaid','取消未付款订单','order',
  '取消未付款应收、未履约出品与未消耗库存预留并保留强审计事实','active'
FROM mbox.stores store
ON CONFLICT (tenant_id,store_id,code) DO UPDATE SET
  name=EXCLUDED.name,category=EXCLUDED.category,description=EXCLUDED.description,status='active';

INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id)
SELECT role.tenant_id,role.store_id,role.id,permission.id
FROM mbox.roles role
JOIN mbox.staff_permission_definitions permission
  ON permission.tenant_id=role.tenant_id AND permission.store_id=role.store_id
 AND permission.code='order.cancel_unpaid'
WHERE role.code IN ('OWNER','OPS_LEAD','MANAGER','DEPUT_MANAGER','CASHIER')
ON CONFLICT (tenant_id,store_id,role_id,permission_id) DO NOTHING;

COMMENT ON TABLE mbox.order_cancellation_events IS
  'Append-only cancellation facts for unpaid receivables. Delivered items and consumed inventory remain historical facts.';
COMMENT ON FUNCTION mbox.cancel_unpaid_order(uuid,uuid,date,text,text,text,char) IS
  'The only supported cashier/manager command for cancelling an unpaid order; payment ambiguity fails closed.';

COMMIT;
