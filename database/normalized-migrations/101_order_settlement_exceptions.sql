BEGIN;

CREATE TABLE mbox.order_settlement_exception_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  order_id uuid NOT NULL,
  order_public_id text NOT NULL CHECK (length(order_public_id) BETWEEN 8 AND 128),
  actor_employee_id uuid NOT NULL,
  source_business_date date NOT NULL,
  action_business_date date NOT NULL,
  reason_code text NOT NULL CHECK (reason_code IN ('manager_comp','uncollectible','test_cleanup')),
  reason_note text NOT NULL CHECK (length(btrim(reason_note)) BETWEEN 4 AND 500),
  settled_amount_minor bigint NOT NULL CHECK (settled_amount_minor > 0),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$'),
  request_sha256 char(64) NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
  FOREIGN KEY (tenant_id,store_id,order_id) REFERENCES mbox.orders(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,actor_employee_id) REFERENCES mbox.employees(tenant_id,store_id,id),
  UNIQUE (tenant_id,store_id,order_id),
  UNIQUE (tenant_id,store_id,idempotency_key)
);

CREATE TRIGGER order_settlement_exception_events_append_only
  BEFORE UPDATE OR DELETE ON mbox.order_settlement_exception_events
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();

CREATE OR REPLACE FUNCTION mbox.settle_cancelled_unpaid_order_exception(
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
  settled_amount_minor bigint,
  occurred_at timestamptz,
  replayed boolean
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,mbox AS $$
DECLARE
  tenant_scope uuid := mbox.current_tenant_id();
  store_scope uuid := mbox.current_store_id();
  order_row record;
  existing_event mbox.order_settlement_exception_events%ROWTYPE;
  new_event mbox.order_settlement_exception_events%ROWTYPE;
  authoritative_business_date date;
  delivered_amount bigint;
BEGIN
  IF p_order_id IS NULL OR p_actor_employee_id IS NULL OR p_action_business_date IS NULL
    OR p_reason_code NOT IN ('manager_comp','uncollectible','test_cleanup')
    OR length(btrim(COALESCE(p_reason_note,''))) NOT BETWEEN 4 AND 500
    OR p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$'
    OR p_request_sha256 !~ '^[0-9a-f]{64}$'
  THEN
    RAISE EXCEPTION 'order settlement exception request is invalid' USING ERRCODE='22023';
  END IF;

  SELECT ((clock_timestamp() AT TIME ZONE store.timezone)-store.business_day_cutoff)::date
  INTO authoritative_business_date
  FROM mbox.stores store
  WHERE store.tenant_id=tenant_scope AND store.id=store_scope AND store.status='active';
  IF authoritative_business_date IS NULL OR p_action_business_date<>authoritative_business_date THEN
    RAISE EXCEPTION 'order settlement exception business date is not current' USING ERRCODE='22023';
  END IF;
  IF NOT mbox.employee_has_effective_permission(
    tenant_scope,store_scope,p_actor_employee_id,'order.settle_exception'
  ) THEN
    RAISE EXCEPTION 'employee lacks order settlement exception permission' USING ERRCODE='42501';
  END IF;
  IF p_reason_code='test_cleanup' AND NOT EXISTS (
    SELECT 1
    FROM mbox.employee_roles employee_role
    JOIN mbox.roles role
      ON role.tenant_id=employee_role.tenant_id AND role.store_id=employee_role.store_id
     AND role.id=employee_role.role_id
    WHERE employee_role.tenant_id=tenant_scope AND employee_role.store_id=store_scope
      AND employee_role.employee_id=p_actor_employee_id AND role.code='OWNER'
  ) THEN
    RAISE EXCEPTION 'only an owner may use test cleanup settlement' USING ERRCODE='42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    tenant_scope::text || ':' || store_scope::text || ':order.settle_exception:' || p_idempotency_key,
    0
  ));
  SELECT * INTO existing_event
  FROM mbox.order_settlement_exception_events event
  WHERE event.tenant_id=tenant_scope AND event.store_id=store_scope
    AND event.idempotency_key=p_idempotency_key;
  IF FOUND THEN
    IF existing_event.request_sha256<>p_request_sha256 THEN
      RAISE EXCEPTION 'order settlement exception idempotency conflict' USING ERRCODE='23505';
    END IF;
    RETURN QUERY SELECT existing_event.id,existing_event.order_public_id,
      existing_event.source_business_date,existing_event.action_business_date,
      existing_event.settled_amount_minor,existing_event.occurred_at,true;
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
  IF order_row.status<>'cancelled' OR order_row.payment_status<>'unpaid' THEN
    RAISE EXCEPTION 'only a cancelled unpaid order may use settlement exception' USING ERRCODE='55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM mbox.payments payment
    WHERE payment.tenant_id=tenant_scope AND payment.store_id=store_scope
      AND payment.order_id=p_order_id AND payment.status NOT IN ('failed','closed')
    FOR UPDATE
  ) OR EXISTS (
    SELECT 1 FROM mbox.refunds refund
    JOIN mbox.payments payment
      ON payment.tenant_id=refund.tenant_id AND payment.store_id=refund.store_id
     AND payment.id=refund.payment_id
    WHERE payment.tenant_id=tenant_scope AND payment.store_id=store_scope
      AND payment.order_id=p_order_id
    FOR UPDATE OF refund,payment
  ) THEN
    RAISE EXCEPTION 'payment or refund evidence prevents settlement exception' USING ERRCODE='55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM mbox.order_items item
    WHERE item.tenant_id=tenant_scope AND item.store_id=store_scope AND item.order_id=p_order_id
      AND item.status NOT IN ('delivered','cancelled')
    FOR UPDATE
  ) THEN
    RAISE EXCEPTION 'unfinished order item prevents settlement exception' USING ERRCODE='55000';
  END IF;

  SELECT COALESCE(sum(item.total_amount_minor),0)::bigint INTO delivered_amount
  FROM mbox.order_items item
  WHERE item.tenant_id=tenant_scope AND item.store_id=store_scope
    AND item.order_id=p_order_id AND item.status='delivered';
  IF delivered_amount<=0 THEN
    RAISE EXCEPTION 'no delivered amount requires settlement exception' USING ERRCODE='55000';
  END IF;

  INSERT INTO mbox.order_settlement_exception_events (
    tenant_id,store_id,order_id,order_public_id,actor_employee_id,
    source_business_date,action_business_date,reason_code,reason_note,
    settled_amount_minor,idempotency_key,request_sha256
  ) VALUES (
    tenant_scope,store_scope,p_order_id,order_row.public_id,p_actor_employee_id,
    order_row.business_date,p_action_business_date,p_reason_code,btrim(p_reason_note),
    delivered_amount,p_idempotency_key,p_request_sha256
  ) RETURNING * INTO new_event;

  RETURN QUERY SELECT new_event.id,new_event.order_public_id,new_event.source_business_date,
    new_event.action_business_date,new_event.settled_amount_minor,new_event.occurred_at,false;
END $$;

ALTER TABLE mbox.order_settlement_exception_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.order_settlement_exception_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.order_settlement_exception_events
  USING (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())
  WITH CHECK (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());

REVOKE ALL ON TABLE mbox.order_settlement_exception_events FROM PUBLIC;
REVOKE INSERT,UPDATE,DELETE ON TABLE mbox.order_settlement_exception_events FROM mbox_runtime;
GRANT SELECT ON TABLE mbox.order_settlement_exception_events TO mbox_runtime;
REVOKE ALL ON FUNCTION mbox.settle_cancelled_unpaid_order_exception(uuid,uuid,date,text,text,text,char) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mbox.settle_cancelled_unpaid_order_exception(uuid,uuid,date,text,text,text,char) TO mbox_runtime;

INSERT INTO mbox.staff_permission_definitions (
  tenant_id,store_id,code,name,category,description,status
)
SELECT store.tenant_id,store.id,'order.settle_exception','异常结清已送达未付款订单','order',
  '仅用于已取消且已送达的未付款订单；免单、无法收回或老板测试清理均保留不可变审计事实','active'
FROM mbox.stores store
ON CONFLICT (tenant_id,store_id,code) DO UPDATE SET
  name=EXCLUDED.name,category=EXCLUDED.category,description=EXCLUDED.description,status='active';

INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id)
SELECT role.tenant_id,role.store_id,role.id,permission.id
FROM mbox.roles role
JOIN mbox.staff_permission_definitions permission
  ON permission.tenant_id=role.tenant_id AND permission.store_id=role.store_id
 AND permission.code='order.settle_exception'
WHERE role.code IN ('OWNER','OPS_LEAD','MANAGER','DEPUT_MANAGER')
ON CONFLICT (tenant_id,store_id,role_id,permission_id) DO NOTHING;

COMMENT ON TABLE mbox.order_settlement_exception_events IS
  'Append-only manager settlement exceptions for delivered unpaid orders. This is never a payment and never deletes order, inventory or source-business-day facts.';
COMMENT ON FUNCTION mbox.settle_cancelled_unpaid_order_exception(uuid,uuid,date,text,text,text,char) IS
  'The only runtime command that closes a delivered unpaid receivable without fabricating payment evidence. Test cleanup is owner-only.';

UPDATE mbox.normalized_schema_metadata
SET schema_version='101',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
