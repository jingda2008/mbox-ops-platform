BEGIN;

-- Closing a table first locks mbox.table_sessions FOR UPDATE and then reads
-- every closure blocker.  Every write that can change those blocker facts must
-- therefore take a conflicting lock on the same table-session row before it
-- changes the fact.  Without this shared lock a refund/order/task can commit
-- after the closure read and leave a closed table with active work.
CREATE OR REPLACE FUNCTION mbox.lock_table_session_for_closure_fact_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, mbox
AS $$
DECLARE
  new_row jsonb := to_jsonb(NEW);
  old_row jsonb := CASE WHEN TG_OP='UPDATE' THEN to_jsonb(OLD) ELSE '{}'::jsonb END;
  table_session_id_value uuid;
  table_session_status text;
  should_lock boolean := false;
  closed_write_allowed boolean := false;
BEGIN
  CASE TG_TABLE_NAME
    WHEN 'orders' THEN
      IF TG_OP='UPDATE' AND new_row->>'table_session_id' IS DISTINCT FROM old_row->>'table_session_id' THEN
        RAISE EXCEPTION 'order table-session ownership is immutable'
          USING ERRCODE='23514';
      END IF;
      should_lock := TG_OP='INSERT'
        OR new_row->>'status' IS DISTINCT FROM old_row->>'status'
        OR new_row->>'payment_status' IS DISTINCT FROM old_row->>'payment_status'
        OR new_row->>'total_amount_minor' IS DISTINCT FROM old_row->>'total_amount_minor';
      closed_write_allowed := TG_OP='UPDATE'
        AND new_row->>'total_amount_minor' IS NOT DISTINCT FROM old_row->>'total_amount_minor'
        AND new_row->>'status' IS NOT DISTINCT FROM old_row->>'status'
        AND CASE old_row->>'payment_status'
          WHEN 'unpaid' THEN new_row->>'payment_status'='paid'
          WHEN 'pending' THEN new_row->>'payment_status'='paid'
          WHEN 'partially_paid' THEN new_row->>'payment_status'='paid'
          WHEN 'paid' THEN new_row->>'payment_status' IN ('paid','partially_refunded','refunded')
          WHEN 'partially_refunded' THEN new_row->>'payment_status' IN ('partially_refunded','refunded')
          WHEN 'refunded' THEN new_row->>'payment_status'='refunded'
          ELSE false
        END;
      table_session_id_value := (new_row->>'table_session_id')::uuid;

    WHEN 'order_items' THEN
      IF TG_OP='UPDATE' AND new_row->>'order_id' IS DISTINCT FROM old_row->>'order_id' THEN
        RAISE EXCEPTION 'order-item order ownership is immutable'
          USING ERRCODE='23514';
      END IF;
      should_lock := TG_OP='INSERT'
        OR new_row->>'status' IS DISTINCT FROM old_row->>'status'
        OR new_row->>'fulfillment_station' IS DISTINCT FROM old_row->>'fulfillment_station'
        OR new_row->>'total_amount_minor' IS DISTINCT FROM old_row->>'total_amount_minor';
      IF should_lock THEN
        SELECT ordering.table_session_id INTO table_session_id_value
        FROM mbox.orders AS ordering
        WHERE ordering.tenant_id=(new_row->>'tenant_id')::uuid
          AND ordering.store_id=(new_row->>'store_id')::uuid
          AND ordering.id=(new_row->>'order_id')::uuid;
      END IF;

    WHEN 'kds_tasks' THEN
      IF TG_OP='UPDATE' AND new_row->>'order_item_id' IS DISTINCT FROM old_row->>'order_item_id' THEN
        RAISE EXCEPTION 'KDS order-item ownership is immutable'
          USING ERRCODE='23514';
      END IF;
      should_lock := TG_OP='INSERT'
        OR new_row->>'status' IS DISTINCT FROM old_row->>'status';
      IF should_lock THEN
        SELECT ordering.table_session_id INTO table_session_id_value
        FROM mbox.order_items AS item
        JOIN mbox.orders AS ordering
          ON ordering.tenant_id=item.tenant_id AND ordering.store_id=item.store_id
         AND ordering.id=item.order_id
        WHERE item.tenant_id=(new_row->>'tenant_id')::uuid
          AND item.store_id=(new_row->>'store_id')::uuid
          AND item.id=(new_row->>'order_item_id')::uuid;
      END IF;

    WHEN 'payments' THEN
      IF TG_OP='UPDATE' AND (
        new_row->>'payable_kind' IS DISTINCT FROM old_row->>'payable_kind'
        OR new_row->>'order_id' IS DISTINCT FROM old_row->>'order_id'
        OR new_row->>'activity_registration_id' IS DISTINCT FROM old_row->>'activity_registration_id'
        OR new_row->>'public_id' IS DISTINCT FROM old_row->>'public_id'
        OR new_row->>'provider' IS DISTINCT FROM old_row->>'provider'
        OR new_row->>'method' IS DISTINCT FROM old_row->>'method'
        OR new_row->>'amount_minor' IS DISTINCT FROM old_row->>'amount_minor'
        OR new_row->>'currency' IS DISTINCT FROM old_row->>'currency'
      ) THEN
        RAISE EXCEPTION 'payment target and financial identity are immutable'
          USING ERRCODE='23514';
      END IF;
      IF (new_row->>'order_id') IS NULL THEN
        RETURN NEW;
      END IF;
      should_lock := TG_OP='INSERT'
        OR new_row->>'status' IS DISTINCT FROM old_row->>'status';
      closed_write_allowed := TG_OP='UPDATE'
        AND CASE old_row->>'status'
          WHEN 'created' THEN new_row->>'status' IN ('created','succeeded','failed','closed')
          WHEN 'pending' THEN new_row->>'status' IN ('pending','succeeded','failed','closed')
          WHEN 'succeeded' THEN new_row->>'status' IN ('succeeded','partially_refunded','refunded')
          WHEN 'partially_refunded' THEN new_row->>'status' IN ('partially_refunded','refunded')
          WHEN 'refunded' THEN new_row->>'status'='refunded'
          WHEN 'failed' THEN new_row->>'status'='failed'
          WHEN 'closed' THEN new_row->>'status'='closed'
          ELSE false
        END;
      IF should_lock THEN
        SELECT ordering.table_session_id INTO table_session_id_value
        FROM mbox.orders AS ordering
        WHERE ordering.tenant_id=(new_row->>'tenant_id')::uuid
          AND ordering.store_id=(new_row->>'store_id')::uuid
          AND ordering.id=(new_row->>'order_id')::uuid;
      END IF;

    WHEN 'refunds' THEN
      IF TG_OP='UPDATE' AND (
        new_row->>'payment_id' IS DISTINCT FROM old_row->>'payment_id'
        OR new_row->>'amount_minor' IS DISTINCT FROM old_row->>'amount_minor'
        OR new_row->>'currency' IS DISTINCT FROM old_row->>'currency'
      ) THEN
        RAISE EXCEPTION 'refund payment and financial identity are immutable'
          USING ERRCODE='23514';
      END IF;
      should_lock := TG_OP='INSERT'
        OR new_row->>'status' IS DISTINCT FROM old_row->>'status';
      closed_write_allowed := true;
      IF should_lock THEN
        SELECT ordering.table_session_id INTO table_session_id_value
        FROM mbox.payments AS payment
        JOIN mbox.orders AS ordering
          ON ordering.tenant_id=payment.tenant_id AND ordering.store_id=payment.store_id
         AND ordering.id=payment.order_id
        WHERE payment.tenant_id=(new_row->>'tenant_id')::uuid
          AND payment.store_id=(new_row->>'store_id')::uuid
         AND payment.id=(new_row->>'payment_id')::uuid;
        IF table_session_id_value IS NULL THEN
          -- Activity-registration payments are not table-session closure facts.
          RETURN NEW;
        END IF;
      END IF;

    WHEN 'inventory_order_reservations' THEN
      IF TG_OP='UPDATE' AND new_row->>'order_id' IS DISTINCT FROM old_row->>'order_id' THEN
        RAISE EXCEPTION 'inventory reservation order ownership is immutable'
          USING ERRCODE='23514';
      END IF;
      should_lock := TG_OP='INSERT'
        OR new_row->>'status' IS DISTINCT FROM old_row->>'status';
      IF should_lock THEN
        SELECT ordering.table_session_id INTO table_session_id_value
        FROM mbox.orders AS ordering
        WHERE ordering.tenant_id=(new_row->>'tenant_id')::uuid
          AND ordering.store_id=(new_row->>'store_id')::uuid
          AND ordering.id=(new_row->>'order_id')::uuid;
      END IF;

    WHEN 'service_tasks' THEN
      should_lock := TG_OP='INSERT'
        OR new_row->>'status' IS DISTINCT FROM old_row->>'status';
      table_session_id_value := (new_row->>'table_session_id')::uuid;

    WHEN 'pricing_authorizations' THEN
      IF TG_OP='UPDATE' AND new_row->>'table_session_id' IS DISTINCT FROM old_row->>'table_session_id' THEN
        RAISE EXCEPTION 'pricing authorization table-session ownership is immutable'
          USING ERRCODE='23514';
      END IF;
      should_lock := TG_OP='INSERT'
        OR new_row->>'status' IS DISTINCT FROM old_row->>'status';
      table_session_id_value := (new_row->>'table_session_id')::uuid;

    WHEN 'song_requests' THEN
      IF TG_OP='UPDATE' AND new_row->>'table_session_id' IS DISTINCT FROM old_row->>'table_session_id' THEN
        RAISE EXCEPTION 'song request table-session ownership is immutable'
          USING ERRCODE='23514';
      END IF;
      should_lock := TG_OP='INSERT'
        OR new_row->>'status' IS DISTINCT FROM old_row->>'status';
      table_session_id_value := (new_row->>'table_session_id')::uuid;

    WHEN 'benefit_reservations' THEN
      IF TG_OP='UPDATE' AND new_row->>'table_session_id' IS DISTINCT FROM old_row->>'table_session_id' THEN
        RAISE EXCEPTION 'benefit reservation table-session ownership is immutable'
          USING ERRCODE='23514';
      END IF;
      should_lock := TG_OP='INSERT'
        OR new_row->>'status' IS DISTINCT FROM old_row->>'status';
      table_session_id_value := (new_row->>'table_session_id')::uuid;

    WHEN 'customer_experience_plans' THEN
      IF TG_OP='UPDATE' AND new_row->>'table_session_id' IS DISTINCT FROM old_row->>'table_session_id' THEN
        RAISE EXCEPTION 'experience plan table-session ownership is immutable'
          USING ERRCODE='23514';
      END IF;
      should_lock := TG_OP='INSERT'
        OR new_row->>'plan_state' IS DISTINCT FROM old_row->>'plan_state';
      table_session_id_value := (new_row->>'table_session_id')::uuid;

    WHEN 'member_redemptions' THEN
      IF TG_OP='UPDATE' AND new_row->>'table_session_id' IS DISTINCT FROM old_row->>'table_session_id' THEN
        RAISE EXCEPTION 'member redemption table-session ownership is immutable'
          USING ERRCODE='23514';
      END IF;
      should_lock := (new_row->>'table_session_id') IS NOT NULL AND (
        TG_OP='INSERT'
        OR new_row->>'status' IS DISTINCT FROM old_row->>'status'
      );
      table_session_id_value := (new_row->>'table_session_id')::uuid;

    WHEN 'checkout_upgrade_offers' THEN
      IF TG_OP='UPDATE' AND new_row->>'table_session_id' IS DISTINCT FROM old_row->>'table_session_id' THEN
        RAISE EXCEPTION 'checkout offer table-session ownership is immutable'
          USING ERRCODE='23514';
      END IF;
      should_lock := TG_OP='INSERT'
        OR new_row->>'status' IS DISTINCT FROM old_row->>'status';
      table_session_id_value := (new_row->>'table_session_id')::uuid;

    ELSE
      RAISE EXCEPTION 'unsupported closure fact table: %',TG_TABLE_NAME
        USING ERRCODE='55000';
  END CASE;

  IF NOT should_lock THEN
    RETURN NEW;
  END IF;
  IF table_session_id_value IS NULL THEN
    RAISE EXCEPTION 'closure fact write has no authoritative table session: %',TG_TABLE_NAME
      USING ERRCODE='23514';
  END IF;

  SELECT session.status INTO table_session_status
  FROM mbox.table_sessions AS session
  WHERE session.tenant_id=(new_row->>'tenant_id')::uuid
    AND session.store_id=(new_row->>'store_id')::uuid
    AND session.id=table_session_id_value
  FOR SHARE;

  IF table_session_status IS NULL THEN
    RAISE EXCEPTION 'closure fact references an unavailable table session: %',table_session_id_value
      USING ERRCODE='23503';
  END IF;
  IF table_session_status NOT IN ('open','closing') AND NOT closed_write_allowed THEN
    RAISE EXCEPTION 'cannot create or change table work after the table session is closed'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER orders_closure_fact_write_lock
  BEFORE INSERT OR UPDATE ON mbox.orders
  FOR EACH ROW EXECUTE FUNCTION mbox.lock_table_session_for_closure_fact_write();
CREATE TRIGGER order_items_closure_fact_write_lock
  BEFORE INSERT OR UPDATE ON mbox.order_items
  FOR EACH ROW EXECUTE FUNCTION mbox.lock_table_session_for_closure_fact_write();
CREATE TRIGGER kds_tasks_closure_fact_write_lock
  BEFORE INSERT OR UPDATE ON mbox.kds_tasks
  FOR EACH ROW EXECUTE FUNCTION mbox.lock_table_session_for_closure_fact_write();
CREATE TRIGGER payments_closure_fact_write_lock
  BEFORE INSERT OR UPDATE ON mbox.payments
  FOR EACH ROW EXECUTE FUNCTION mbox.lock_table_session_for_closure_fact_write();
CREATE TRIGGER refunds_closure_fact_write_lock
  BEFORE INSERT OR UPDATE ON mbox.refunds
  FOR EACH ROW EXECUTE FUNCTION mbox.lock_table_session_for_closure_fact_write();
CREATE TRIGGER inventory_order_reservations_closure_fact_write_lock
  BEFORE INSERT OR UPDATE ON mbox.inventory_order_reservations
  FOR EACH ROW EXECUTE FUNCTION mbox.lock_table_session_for_closure_fact_write();
CREATE TRIGGER service_tasks_closure_fact_write_lock
  BEFORE INSERT OR UPDATE ON mbox.service_tasks
  FOR EACH ROW EXECUTE FUNCTION mbox.lock_table_session_for_closure_fact_write();
CREATE TRIGGER pricing_authorizations_closure_fact_write_lock
  BEFORE INSERT OR UPDATE ON mbox.pricing_authorizations
  FOR EACH ROW EXECUTE FUNCTION mbox.lock_table_session_for_closure_fact_write();
CREATE TRIGGER song_requests_closure_fact_write_lock
  BEFORE INSERT OR UPDATE ON mbox.song_requests
  FOR EACH ROW EXECUTE FUNCTION mbox.lock_table_session_for_closure_fact_write();
CREATE TRIGGER benefit_reservations_closure_fact_write_lock
  BEFORE INSERT OR UPDATE ON mbox.benefit_reservations
  FOR EACH ROW EXECUTE FUNCTION mbox.lock_table_session_for_closure_fact_write();
CREATE TRIGGER customer_experience_plans_closure_fact_write_lock
  BEFORE INSERT OR UPDATE ON mbox.customer_experience_plans
  FOR EACH ROW EXECUTE FUNCTION mbox.lock_table_session_for_closure_fact_write();
CREATE TRIGGER member_redemptions_closure_fact_write_lock
  BEFORE INSERT OR UPDATE ON mbox.member_redemptions
  FOR EACH ROW EXECUTE FUNCTION mbox.lock_table_session_for_closure_fact_write();
CREATE TRIGGER checkout_upgrade_offers_closure_fact_write_lock
  BEFORE INSERT OR UPDATE ON mbox.checkout_upgrade_offers
  FOR EACH ROW EXECUTE FUNCTION mbox.lock_table_session_for_closure_fact_write();

COMMENT ON FUNCTION mbox.lock_table_session_for_closure_fact_write() IS
  'Serializes every closure-blocker fact transition with direct and business-day table closure.';

COMMIT;
