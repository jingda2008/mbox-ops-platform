BEGIN;

-- This is an additive foundation. Existing items keep their original quantity,
-- prices and production path until an explicit quantity case is introduced.
CREATE TABLE mbox.item_after_sales_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL, store_id uuid NOT NULL, order_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('unpaid_stop','paid_return','payment_review')),
  closed_by_order_event_id uuid,
  FOREIGN KEY(tenant_id,store_id,closed_by_order_event_id) REFERENCES mbox.order_cancellation_events(tenant_id,store_id,id),
  resolved_kind text CHECK(resolved_kind IS NULL OR resolved_kind='unpaid_stop' AND kind='payment_review'),
  status text NOT NULL DEFAULT 'requested' CHECK(status IN ('requested','approved','rejected','withdrawn','completed')),
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 1000),
  requested_by_employee_id uuid NOT NULL,
  decided_by_employee_id uuid,
  decision_reason text,
  amount_minor bigint CHECK(amount_minor>=0),
  business_date date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  decided_at timestamptz,
  completed_at timestamptz,
  UNIQUE(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,order_id) REFERENCES mbox.orders(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,requested_by_employee_id) REFERENCES mbox.employees(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,decided_by_employee_id) REFERENCES mbox.employees(tenant_id,store_id,id),
  CHECK(decided_by_employee_id IS NULL OR decided_by_employee_id<>requested_by_employee_id OR kind='unpaid_stop')
);
CREATE INDEX item_after_sales_cases_order_idx ON mbox.item_after_sales_cases(tenant_id,store_id,order_id,created_at,id);
CREATE INDEX item_after_sales_cases_work_idx ON mbox.item_after_sales_cases(tenant_id,store_id,status,created_at,id) WHERE status<>'completed';

ALTER TABLE mbox.table_customer_left_turnover_events ADD UNIQUE(tenant_id,store_id,id);

CREATE TABLE mbox.order_item_quantity_units (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL, store_id uuid NOT NULL, order_item_id uuid NOT NULL,
  unit_index integer NOT NULL CHECK(unit_index>=0 AND unit_index<999),
  original_amount_minor bigint CHECK(original_amount_minor>=0),
  inventory_evidence_state text NOT NULL DEFAULT 'unresolved' CHECK(inventory_evidence_state IN ('unresolved','untracked','allocated')),
  production_state text NOT NULL CHECK(production_state IN ('unmade','started','ready','delivered')),
  held_by_case_id uuid,
  stopped_by_case_id uuid,
  closed_by_order_event_id uuid,
  closed_by_turnover_event_id uuid,
  operationally_stopped boolean GENERATED ALWAYS AS
    (stopped_by_case_id IS NOT NULL OR closed_by_order_event_id IS NOT NULL OR closed_by_turnover_event_id IS NOT NULL) STORED,
  CHECK(closed_by_order_event_id IS NULL OR closed_by_turnover_event_id IS NULL),
  CHECK((closed_by_order_event_id IS NULL AND closed_by_turnover_event_id IS NULL) OR production_state<>'delivered'),
  FOREIGN KEY(tenant_id,store_id,closed_by_order_event_id) REFERENCES mbox.order_cancellation_events(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,closed_by_turnover_event_id) REFERENCES mbox.table_customer_left_turnover_events(tenant_id,store_id,id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(tenant_id,store_id,id),
  UNIQUE(tenant_id,store_id,order_item_id,unit_index),
  FOREIGN KEY(tenant_id,store_id,order_item_id) REFERENCES mbox.order_items(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,held_by_case_id) REFERENCES mbox.item_after_sales_cases(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,stopped_by_case_id) REFERENCES mbox.item_after_sales_cases(tenant_id,store_id,id),
  CHECK(held_by_case_id IS NULL OR stopped_by_case_id IS NULL)
);
CREATE INDEX order_item_quantity_units_hold_idx ON mbox.order_item_quantity_units(tenant_id,store_id,held_by_case_id) WHERE held_by_case_id IS NOT NULL;

CREATE TABLE mbox.item_after_sales_case_units (
  tenant_id uuid NOT NULL,store_id uuid NOT NULL,case_id uuid NOT NULL,unit_id uuid NOT NULL,
  production_state_at_request text NOT NULL CHECK(production_state_at_request IN ('unmade','started','ready','delivered')),
  amount_minor bigint CHECK(amount_minor>=0),
  PRIMARY KEY(tenant_id,store_id,case_id,unit_id),
  FOREIGN KEY(tenant_id,store_id,case_id) REFERENCES mbox.item_after_sales_cases(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,unit_id) REFERENCES mbox.order_item_quantity_units(tenant_id,store_id,id)
);
CREATE TABLE mbox.item_after_sales_case_refunds (
  tenant_id uuid NOT NULL,store_id uuid NOT NULL,case_id uuid NOT NULL,refund_id uuid NOT NULL,
  PRIMARY KEY(tenant_id,store_id,case_id,refund_id),
  UNIQUE(tenant_id,store_id,refund_id),
  FOREIGN KEY(tenant_id,store_id,case_id) REFERENCES mbox.item_after_sales_cases(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,refund_id) REFERENCES mbox.refunds(tenant_id,store_id,id)
);
CREATE TABLE mbox.item_after_sales_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,
  case_id uuid NOT NULL,employee_id uuid NOT NULL,event_type text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(metadata)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(tenant_id,store_id,case_id) REFERENCES mbox.item_after_sales_cases(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,employee_id) REFERENCES mbox.employees(tenant_id,store_id,id)
);
CREATE TABLE mbox.item_after_sales_case_revisions (
  tenant_id uuid NOT NULL,store_id uuid NOT NULL,
  previous_case_id uuid NOT NULL,replacement_case_id uuid NOT NULL,
  employee_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,store_id,previous_case_id),
  UNIQUE(tenant_id,store_id,replacement_case_id),
  CHECK(previous_case_id<>replacement_case_id),
  FOREIGN KEY(tenant_id,store_id,previous_case_id) REFERENCES mbox.item_after_sales_cases(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,replacement_case_id) REFERENCES mbox.item_after_sales_cases(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,employee_id) REFERENCES mbox.employees(tenant_id,store_id,id)
);
CREATE FUNCTION mbox.guard_quantity_case_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM mbox.item_after_sales_cases original JOIN mbox.item_after_sales_cases replacement
    ON replacement.tenant_id=original.tenant_id AND replacement.store_id=original.store_id AND replacement.order_id=original.order_id
    WHERE original.tenant_id=NEW.tenant_id AND original.store_id=NEW.store_id AND original.id=NEW.previous_case_id AND replacement.id=NEW.replacement_case_id
      AND original.status='withdrawn' AND replacement.status='requested' AND original.requested_by_employee_id=NEW.employee_id AND replacement.requested_by_employee_id=NEW.employee_id
      AND replacement.created_at>=original.created_at
      AND NOT EXISTS(SELECT 1 FROM mbox.item_receivable_adjustments WHERE tenant_id=original.tenant_id AND store_id=original.store_id AND case_id=original.id)
      AND NOT EXISTS(SELECT 1 FROM mbox.item_after_sales_case_refunds link JOIN mbox.refunds refund ON refund.tenant_id=link.tenant_id AND refund.store_id=link.store_id AND refund.id=link.refund_id
        WHERE link.tenant_id=original.tenant_id AND link.store_id=original.store_id AND link.case_id=original.id AND refund.status<>'cancelled')
      AND (SELECT count(DISTINCT unit.order_item_id) FROM mbox.item_after_sales_case_units selected JOIN mbox.order_item_quantity_units unit
        ON unit.tenant_id=selected.tenant_id AND unit.store_id=selected.store_id AND unit.id=selected.unit_id
        WHERE selected.tenant_id=original.tenant_id AND selected.store_id=original.store_id AND selected.case_id IN (original.id,replacement.id))=1
  ) THEN RAISE EXCEPTION 'case revision requires the same original item and requester with no executed refund' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER quantity_case_revision_source BEFORE INSERT ON mbox.item_after_sales_case_revisions FOR EACH ROW EXECUTE FUNCTION mbox.guard_quantity_case_revision();
REVOKE ALL ON FUNCTION mbox.guard_quantity_case_revision() FROM PUBLIC;
-- INSERTing an order assigns its immutable business day under the same store
-- lock as manual close. A row lock requires UPDATE privilege, which runtime
-- intentionally lacks on store configuration. Keep that privilege in this
-- narrow trigger rather than granting store updates to the application.
CREATE OR REPLACE FUNCTION mbox.assign_order_business_date() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mbox AS $$
DECLARE session_date date;
BEGIN
  IF (mbox.current_tenant_id() IS NOT NULL AND NEW.tenant_id IS DISTINCT FROM mbox.current_tenant_id())
    OR (mbox.current_store_id() IS NOT NULL AND NEW.store_id IS DISTINCT FROM mbox.current_store_id()) THEN
    RAISE EXCEPTION 'order business date scope mismatch' USING ERRCODE='42501';
  END IF;
  IF TG_OP='UPDATE' THEN
    IF NEW.business_date IS DISTINCT FROM OLD.business_date THEN RAISE EXCEPTION 'order business date is immutable'; END IF;
    RETURN NEW;
  END IF;
  PERFORM 1 FROM mbox.stores WHERE tenant_id=NEW.tenant_id AND id=NEW.store_id FOR SHARE;
  SELECT business_date INTO STRICT session_date FROM mbox.table_sessions
    WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=NEW.table_session_id;
  IF EXISTS(SELECT 1 FROM mbox.manual_business_day_ends WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id) THEN
    SELECT GREATEST(((statement_timestamp() AT TIME ZONE timezone)-business_day_cutoff)::date,
      (SELECT max(next_business_date) FROM mbox.manual_business_day_ends WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id))
      INTO NEW.business_date FROM mbox.stores WHERE tenant_id=NEW.tenant_id AND id=NEW.store_id;
  ELSE NEW.business_date:=session_date;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION mbox.assign_order_business_date() FROM PUBLIC;

CREATE FUNCTION mbox.item_after_sales_root_case_id(p_tenant uuid,p_store uuid,p_case uuid) RETURNS uuid LANGUAGE sql STABLE AS $$
  WITH RECURSIVE ancestors(id) AS (
    SELECT id FROM mbox.item_after_sales_cases WHERE tenant_id=p_tenant AND store_id=p_store AND id=p_case
    UNION
    SELECT revision.previous_case_id FROM ancestors JOIN mbox.item_after_sales_case_revisions revision
      ON revision.tenant_id=p_tenant AND revision.store_id=p_store AND revision.replacement_case_id=ancestors.id
  ) SELECT id FROM ancestors WHERE NOT EXISTS(SELECT 1 FROM mbox.item_after_sales_case_revisions revision
      WHERE revision.tenant_id=p_tenant AND revision.store_id=p_store AND revision.replacement_case_id=ancestors.id)
$$;
REVOKE ALL ON FUNCTION mbox.item_after_sales_root_case_id(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mbox.item_after_sales_root_case_id(uuid,uuid,uuid) TO mbox_runtime;
CREATE TABLE mbox.item_after_sales_replacement_orders (
  tenant_id uuid NOT NULL,store_id uuid NOT NULL,root_case_id uuid NOT NULL,case_id uuid NOT NULL,order_id uuid NOT NULL,previous_order_id uuid,employee_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,store_id,order_id),UNIQUE(tenant_id,store_id,previous_order_id),
  CHECK(previous_order_id IS NULL OR previous_order_id<>order_id),
  FOREIGN KEY(tenant_id,store_id,previous_order_id) REFERENCES mbox.item_after_sales_replacement_orders(tenant_id,store_id,order_id),
  FOREIGN KEY(tenant_id,store_id,root_case_id) REFERENCES mbox.item_after_sales_cases(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,case_id) REFERENCES mbox.item_after_sales_cases(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,order_id) REFERENCES mbox.orders(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,employee_id) REFERENCES mbox.employees(tenant_id,store_id,id)
);
CREATE UNIQUE INDEX first_item_replacement_once ON mbox.item_after_sales_replacement_orders(tenant_id,store_id,root_case_id) WHERE previous_order_id IS NULL;
CREATE INDEX item_replacement_family ON mbox.item_after_sales_replacement_orders(tenant_id,store_id,root_case_id);
CREATE FUNCTION mbox.guard_item_replacement_order() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.previous_order_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM mbox.item_after_sales_replacement_orders previous
    JOIN mbox.orders cancelled ON cancelled.tenant_id=previous.tenant_id AND cancelled.store_id=previous.store_id AND cancelled.id=previous.order_id
    WHERE previous.tenant_id=NEW.tenant_id AND previous.store_id=NEW.store_id AND previous.root_case_id=NEW.root_case_id
      AND previous.order_id=NEW.previous_order_id AND cancelled.status='cancelled') THEN
    RAISE EXCEPTION 'a replacement successor requires the cancelled original replacement' USING ERRCODE='23514';
  END IF;
  IF NEW.root_case_id IS DISTINCT FROM mbox.item_after_sales_root_case_id(NEW.tenant_id,NEW.store_id,NEW.case_id) OR NOT EXISTS(
    SELECT 1 FROM mbox.item_after_sales_cases source JOIN mbox.orders original ON original.tenant_id=source.tenant_id AND original.store_id=source.store_id AND original.id=source.order_id
      JOIN mbox.orders replacement ON replacement.tenant_id=original.tenant_id AND replacement.store_id=original.store_id AND replacement.table_session_id=original.table_session_id
      JOIN mbox.table_sessions visit ON visit.tenant_id=original.tenant_id AND visit.store_id=original.store_id AND visit.id=original.table_session_id
    WHERE source.tenant_id=NEW.tenant_id AND source.store_id=NEW.store_id AND source.id=NEW.case_id AND replacement.id=NEW.order_id
      AND replacement.id<>original.id AND replacement.channel='staff_assisted' AND replacement.created_by_employee_id=NEW.employee_id
      AND replacement.created_at>=source.created_at AND replacement.status<>'cancelled' AND visit.status='open'
      AND source.status IN ('requested','approved','completed')
      AND NOT EXISTS(SELECT 1 FROM mbox.item_after_sales_case_revisions revision WHERE revision.tenant_id=source.tenant_id AND revision.store_id=source.store_id AND revision.previous_case_id=source.id)
      AND EXISTS(SELECT 1 FROM mbox.order_item_quantity_units unit WHERE unit.tenant_id=source.tenant_id AND unit.store_id=source.store_id AND (unit.held_by_case_id=source.id OR unit.stopped_by_case_id=source.id))
  ) THEN RAISE EXCEPTION 'replacement requires a current original case and new order in the same open visit' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER item_replacement_order_source BEFORE INSERT ON mbox.item_after_sales_replacement_orders FOR EACH ROW EXECUTE FUNCTION mbox.guard_item_replacement_order();
REVOKE ALL ON FUNCTION mbox.guard_item_replacement_order() FROM PUBLIC;
CREATE UNIQUE INDEX item_after_sales_operating_event_once ON mbox.item_after_sales_events(tenant_id,store_id,case_id,event_type) WHERE event_type IN ('operating.request','operating.approved','operating.rejected','operating.withdrawn','operating.resume','operating.payment_resolved');
CREATE INDEX item_after_sales_events_case_idx ON mbox.item_after_sales_events(tenant_id,store_id,case_id,created_at,id);

-- Original invoice amounts remain immutable; effective receivables are separate facts.
CREATE TABLE mbox.item_receivable_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,
  case_id uuid NOT NULL,order_id uuid NOT NULL,order_item_id uuid NOT NULL,
  amount_minor bigint NOT NULL CHECK(amount_minor>=0),quantity integer NOT NULL CHECK(quantity>0),
  business_date date NOT NULL,created_by_employee_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(tenant_id,store_id,case_id),
  FOREIGN KEY(tenant_id,store_id,case_id) REFERENCES mbox.item_after_sales_cases(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,order_id) REFERENCES mbox.orders(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,order_item_id) REFERENCES mbox.order_items(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,created_by_employee_id) REFERENCES mbox.employees(tenant_id,store_id,id)
);
CREATE INDEX item_receivable_adjustments_order_idx ON mbox.item_receivable_adjustments(tenant_id,store_id,order_id);

-- Every inventory share retains the original reservation or original sale lot.
-- A made unit can be stopped without rewriting it as unmade or inventing raw material.
CREATE TABLE mbox.order_item_unit_inventory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,
  unit_id uuid NOT NULL,inventory_item_id uuid NOT NULL,
  reservation_id uuid,original_movement_id uuid,
  quantity numeric(18,6) NOT NULL CHECK(quantity>0),
  status text NOT NULL CHECK(status IN ('reserved','consumed','released','returned','used_loss')),
  consumption_movement_id uuid,return_movement_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,unit_id) REFERENCES mbox.order_item_quantity_units(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,inventory_item_id) REFERENCES mbox.inventory_items(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,reservation_id) REFERENCES mbox.inventory_order_reservations(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,original_movement_id) REFERENCES mbox.inventory_movements(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,consumption_movement_id) REFERENCES mbox.inventory_movements(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,return_movement_id) REFERENCES mbox.inventory_movements(tenant_id,store_id,id),
  CHECK(reservation_id IS NOT NULL OR original_movement_id IS NOT NULL)
);
CREATE INDEX order_item_unit_inventory_units_idx ON mbox.order_item_unit_inventory(tenant_id,store_id,unit_id,inventory_item_id,id);
CREATE INDEX order_item_unit_inventory_reservation_idx ON mbox.order_item_unit_inventory(tenant_id,store_id,reservation_id);
CREATE UNIQUE INDEX order_item_unit_inventory_reservation_unit_uq ON mbox.order_item_unit_inventory(tenant_id,store_id,unit_id,reservation_id) WHERE reservation_id IS NOT NULL;
CREATE UNIQUE INDEX order_item_unit_inventory_sale_unit_uq ON mbox.order_item_unit_inventory(tenant_id,store_id,unit_id,original_movement_id) WHERE reservation_id IS NULL;

-- Preserve the old one-sale-per-line rule; quantity sales have a separate exact unit identity.
ALTER TABLE mbox.inventory_movements ADD COLUMN quantity_unit_id uuid;
ALTER TABLE mbox.inventory_movements ADD FOREIGN KEY(tenant_id,store_id,quantity_unit_id)
  REFERENCES mbox.order_item_quantity_units(tenant_id,store_id,id);
DROP INDEX mbox.inventory_movements_sale_once_uq;
CREATE UNIQUE INDEX inventory_movements_sale_once_uq ON mbox.inventory_movements
  (tenant_id,store_id,order_item_id,inventory_item_id,COALESCE(quantity_unit_id,order_item_id))
  WHERE movement_type='sale' AND order_item_id IS NOT NULL;
CREATE UNIQUE INDEX inventory_movements_quantity_return_once_uq ON mbox.inventory_movements
  (tenant_id,store_id,quantity_unit_id,inventory_item_id)
  WHERE movement_type='return' AND quantity_unit_id IS NOT NULL;
ALTER TABLE mbox.order_item_unit_inventory ADD CHECK(status NOT IN ('consumed','returned','used_loss') OR consumption_movement_id IS NOT NULL);
ALTER TABLE mbox.order_item_unit_inventory ADD CHECK(status<>'returned' OR return_movement_id IS NOT NULL);

CREATE FUNCTION mbox.guard_quantity_case_order() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item_order uuid; case_order uuid; case_key uuid; unit_key uuid;
BEGIN
  IF TG_TABLE_NAME='order_item_quantity_units' THEN
    SELECT order_id INTO item_order FROM mbox.order_items WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=NEW.order_item_id;
    case_key:=COALESCE(NEW.held_by_case_id,NEW.stopped_by_case_id);
  ELSE
    unit_key:=NEW.unit_id; case_key:=NEW.case_id;
    SELECT item.order_id INTO item_order FROM mbox.order_item_quantity_units unit JOIN mbox.order_items item
      ON item.tenant_id=unit.tenant_id AND item.store_id=unit.store_id AND item.id=unit.order_item_id
      WHERE unit.tenant_id=NEW.tenant_id AND unit.store_id=NEW.store_id AND unit.id=unit_key;
  END IF;
  IF case_key IS NOT NULL THEN
    SELECT order_id INTO case_order FROM mbox.item_after_sales_cases WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=case_key;
    IF item_order IS DISTINCT FROM case_order OR case_order IS NULL THEN
      RAISE EXCEPTION 'quantity case must belong to original order' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER quantity_unit_case_order BEFORE INSERT OR UPDATE ON mbox.order_item_quantity_units FOR EACH ROW EXECUTE FUNCTION mbox.guard_quantity_case_order();
CREATE TRIGGER quantity_case_unit_order BEFORE INSERT ON mbox.item_after_sales_case_units FOR EACH ROW EXECUTE FUNCTION mbox.guard_quantity_case_order();

-- A failed attempt remains immutable. Only its one exact replacement becomes
-- active, retaining the original case approval, payment and allocation.
CREATE TABLE mbox.item_after_sales_refund_retries (
  tenant_id uuid NOT NULL,store_id uuid NOT NULL,case_id uuid NOT NULL,
  previous_refund_id uuid NOT NULL,replacement_refund_id uuid NOT NULL,
  employee_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,store_id,previous_refund_id),
  UNIQUE(tenant_id,store_id,replacement_refund_id),
  CHECK(previous_refund_id<>replacement_refund_id),
  FOREIGN KEY(tenant_id,store_id,case_id,previous_refund_id) REFERENCES mbox.item_after_sales_case_refunds(tenant_id,store_id,case_id,refund_id),
  FOREIGN KEY(tenant_id,store_id,replacement_refund_id) REFERENCES mbox.refunds(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,case_id,replacement_refund_id) REFERENCES mbox.item_after_sales_case_refunds(tenant_id,store_id,case_id,refund_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(tenant_id,store_id,employee_id) REFERENCES mbox.employees(tenant_id,store_id,id)
);
CREATE FUNCTION mbox.quantity_refund_retry_eligible(p_tenant uuid,p_store uuid,p_refund uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS(SELECT 1 FROM mbox.refunds refund JOIN mbox.payments payment
    ON payment.tenant_id=refund.tenant_id AND payment.store_id=refund.store_id AND payment.id=refund.payment_id
    WHERE refund.tenant_id=p_tenant AND refund.store_id=p_store AND refund.id=p_refund
      AND refund.status='failed' AND refund.completed_at IS NOT NULL AND refund.provider_refund_id IS NOT NULL
      AND refund.provider_submission_state<>'manual_review'
      AND NOT EXISTS(SELECT 1 FROM mbox.item_after_sales_refund_retries retry WHERE retry.tenant_id=p_tenant AND retry.store_id=p_store AND retry.previous_refund_id=p_refund)
      AND NOT EXISTS(SELECT 1 FROM mbox.reconciliation_entries entry WHERE entry.tenant_id=p_tenant AND entry.store_id=p_store AND entry.refund_id=p_refund AND entry.entry_type='refund')
      AND NOT EXISTS(SELECT 1 FROM mbox.verified_provider_observations evidence WHERE evidence.tenant_id=p_tenant AND evidence.store_id=p_store AND evidence.refund_id=p_refund AND evidence.observed_status='refund_succeeded')
      AND ((payment.provider IN ('cash','pos','external') AND EXISTS(SELECT 1 FROM mbox.audit_events evidence
        WHERE evidence.tenant_id=p_tenant AND evidence.store_id=p_store AND evidence.object_id=p_refund::text
          AND evidence.object_type='refund' AND evidence.action='refund.manual_failed' AND evidence.actor_type='employee'))
        OR (payment.provider='postar' AND EXISTS(SELECT 1 FROM mbox.verified_provider_observations evidence
          WHERE evidence.tenant_id=p_tenant AND evidence.store_id=p_store AND evidence.refund_id=p_refund
            AND evidence.provider=payment.provider AND evidence.observed_status='refund_failed'
            AND evidence.consumed_at IS NOT NULL AND evidence.consumed_operation='refund.result'
            AND evidence.reported_amount_minor=refund.amount_minor AND evidence.reported_currency=refund.currency
            AND evidence.provider_transaction_id=refund.provider_refund_id
            AND evidence.original_provider_transaction_id=payment.provider_transaction_id)))
  )
$$;
REVOKE ALL ON FUNCTION mbox.quantity_refund_retry_eligible(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mbox.quantity_refund_retry_eligible(uuid,uuid,uuid) TO mbox_runtime;
CREATE FUNCTION mbox.guard_quantity_refund_retry() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT mbox.quantity_refund_retry_eligible(NEW.tenant_id,NEW.store_id,NEW.previous_refund_id)
    OR NOT EXISTS(SELECT 1 FROM mbox.item_after_sales_cases target
      JOIN mbox.refunds previous ON previous.tenant_id=target.tenant_id AND previous.store_id=target.store_id AND previous.id=NEW.previous_refund_id
      JOIN mbox.refunds replacement ON replacement.tenant_id=target.tenant_id AND replacement.store_id=target.store_id AND replacement.id=NEW.replacement_refund_id
      WHERE target.tenant_id=NEW.tenant_id AND target.store_id=NEW.store_id AND target.id=NEW.case_id
        AND target.status='approved' AND target.decided_by_employee_id=previous.approved_by_employee_id
        AND replacement.status='requested' AND replacement.payment_id=previous.payment_id
        AND replacement.order_id IS NOT DISTINCT FROM previous.order_id
        AND replacement.amount_minor=previous.amount_minor AND replacement.currency=previous.currency
        AND replacement.requested_by_employee_id=previous.requested_by_employee_id AND replacement.purpose=previous.purpose
        AND replacement.purpose='return_goods'
        AND (SELECT jsonb_agg(jsonb_build_array(order_item_id,amount_minor,currency) ORDER BY order_item_id) FROM mbox.refund_items WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND refund_id=NEW.previous_refund_id)
          IS NOT DISTINCT FROM (SELECT jsonb_agg(jsonb_build_array(order_item_id,amount_minor,currency) ORDER BY order_item_id) FROM mbox.refund_items WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND refund_id=NEW.replacement_refund_id)
    ) THEN RAISE EXCEPTION 'quantity retry requires confirmed failure and unchanged original approval and funding' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER quantity_refund_retry_guard BEFORE INSERT ON mbox.item_after_sales_refund_retries FOR EACH ROW EXECUTE FUNCTION mbox.guard_quantity_refund_retry();
REVOKE ALL ON FUNCTION mbox.guard_quantity_refund_retry() FROM PUBLIC;

CREATE FUNCTION mbox.guard_quantity_refund_order() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM mbox.item_after_sales_cases target JOIN mbox.refunds refund
    ON refund.tenant_id=target.tenant_id AND refund.store_id=target.store_id JOIN mbox.payments payment
    ON payment.tenant_id=refund.tenant_id AND payment.store_id=refund.store_id AND payment.id=refund.payment_id
    WHERE target.tenant_id=NEW.tenant_id AND target.store_id=NEW.store_id AND target.id=NEW.case_id AND refund.id=NEW.refund_id
      AND COALESCE(refund.order_id,payment.order_id)=target.order_id AND refund.purpose='return_goods'
      AND refund.requested_by_employee_id=target.requested_by_employee_id
      AND refund.status='requested' AND (target.status='requested' OR target.status='approved' AND EXISTS(SELECT 1 FROM mbox.item_after_sales_refund_retries retry WHERE retry.tenant_id=NEW.tenant_id AND retry.store_id=NEW.store_id AND retry.case_id=NEW.case_id AND retry.replacement_refund_id=NEW.refund_id)) AND target.amount_minor IS NOT NULL AND COALESCE(target.resolved_kind,target.kind)<>'unpaid_stop'
      AND refund.amount_minor+COALESCE((SELECT sum(previous.amount_minor) FROM mbox.item_after_sales_case_refunds link JOIN mbox.refunds previous
        ON previous.tenant_id=link.tenant_id AND previous.store_id=link.store_id AND previous.id=link.refund_id
        WHERE link.tenant_id=target.tenant_id AND link.store_id=target.store_id AND link.case_id=target.id AND NOT EXISTS(SELECT 1 FROM mbox.item_after_sales_refund_retries retry WHERE retry.tenant_id=link.tenant_id AND retry.store_id=link.store_id AND retry.previous_refund_id=link.refund_id)),0)<=target.amount_minor
      AND NOT EXISTS(SELECT 1 FROM mbox.refund_items allocation WHERE allocation.tenant_id=refund.tenant_id AND allocation.store_id=refund.store_id AND allocation.refund_id=refund.id
        AND NOT EXISTS(SELECT 1 FROM mbox.item_after_sales_case_units selected JOIN mbox.order_item_quantity_units unit ON unit.tenant_id=selected.tenant_id AND unit.store_id=selected.store_id AND unit.id=selected.unit_id
          WHERE selected.tenant_id=target.tenant_id AND selected.store_id=target.store_id AND selected.case_id=target.id AND unit.order_item_id=allocation.order_item_id))
  ) THEN RAISE EXCEPTION 'quantity refund must retain original order, purpose and requester' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER quantity_refund_case_order BEFORE INSERT ON mbox.item_after_sales_case_refunds FOR EACH ROW EXECUTE FUNCTION mbox.guard_quantity_refund_order();

CREATE FUNCTION mbox.guard_quantity_refund_decision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target mbox.item_after_sales_cases;
BEGIN
  SELECT candidate.* INTO target FROM mbox.item_after_sales_case_refunds link JOIN mbox.item_after_sales_cases candidate
    ON candidate.tenant_id=link.tenant_id AND candidate.store_id=link.store_id AND candidate.id=link.case_id
    WHERE link.tenant_id=NEW.tenant_id AND link.store_id=NEW.store_id AND link.refund_id=NEW.id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF NEW.status IN ('approved','processing','succeeded') AND (target.status NOT IN ('approved','completed') OR NEW.approved_by_employee_id IS DISTINCT FROM target.decided_by_employee_id) THEN
    RAISE EXCEPTION 'quantity refund requires the same single case approval' USING ERRCODE='23514';
  END IF;
  IF NEW.status='rejected' AND (target.status<>'rejected' OR NEW.approved_by_employee_id IS DISTINCT FROM target.decided_by_employee_id) THEN
    RAISE EXCEPTION 'quantity refund rejection must follow the original case' USING ERRCODE='23514';
  END IF;
  IF NEW.status='cancelled' AND target.status<>'withdrawn' THEN
    RAISE EXCEPTION 'quantity refund withdrawal must follow the original case' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER quantity_refund_single_decision BEFORE UPDATE OF status,approved_by_employee_id ON mbox.refunds FOR EACH ROW EXECUTE FUNCTION mbox.guard_quantity_refund_decision();

CREATE FUNCTION mbox.guard_quantity_inventory_movement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE unit_item uuid;
BEGIN
  IF NEW.quantity_unit_id IS NOT NULL THEN
    SELECT order_item_id INTO unit_item FROM mbox.order_item_quantity_units WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=NEW.quantity_unit_id;
    IF unit_item IS DISTINCT FROM NEW.order_item_id OR unit_item IS NULL OR NEW.movement_type NOT IN ('sale','return') THEN
      RAISE EXCEPTION 'quantity movement must retain original order item' USING ERRCODE='23514';
    END IF;
    IF NOT EXISTS(SELECT 1 FROM mbox.order_item_unit_inventory stock WHERE stock.tenant_id=NEW.tenant_id AND stock.store_id=NEW.store_id
      AND stock.unit_id=NEW.quantity_unit_id AND stock.inventory_item_id=NEW.inventory_item_id AND stock.quantity=abs(NEW.quantity_delta)
      AND ((NEW.movement_type='sale' AND stock.status='reserved' AND NEW.quantity_delta<0) OR
           (NEW.movement_type='return' AND stock.status='consumed' AND NEW.quantity_delta>0))) THEN
      RAISE EXCEPTION 'quantity movement must match the original available inventory share' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.movement_type IN ('sale','return') AND EXISTS(
    SELECT 1 FROM mbox.order_item_quantity_units unit WHERE unit.tenant_id=NEW.tenant_id AND unit.store_id=NEW.store_id
      AND unit.order_item_id=NEW.order_item_id AND unit.inventory_evidence_state='allocated'
  ) THEN
    RAISE EXCEPTION 'quantity inventory requires exact units; whole line movement refused' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER quantity_movement_identity BEFORE INSERT ON mbox.inventory_movements FOR EACH ROW EXECUTE FUNCTION mbox.guard_quantity_inventory_movement();

DO $$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['item_after_sales_cases','order_item_quantity_units','item_after_sales_case_units','item_after_sales_case_refunds','item_after_sales_refund_retries','item_after_sales_case_revisions','item_after_sales_replacement_orders','item_after_sales_events','order_item_unit_inventory','item_receivable_adjustments'] LOOP
    EXECUTE format('ALTER TABLE mbox.%I ENABLE ROW LEVEL SECURITY',relation);
    EXECUTE format('ALTER TABLE mbox.%I FORCE ROW LEVEL SECURITY',relation);
    EXECUTE format('CREATE POLICY scope_guard ON mbox.%I USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())',relation);
    EXECUTE format('GRANT SELECT,INSERT ON mbox.%I TO mbox_runtime',relation);
  END LOOP;
  FOREACH relation IN ARRAY ARRAY['item_after_sales_case_units','item_after_sales_case_refunds','item_after_sales_refund_retries','item_after_sales_case_revisions','item_after_sales_replacement_orders','item_after_sales_events','item_receivable_adjustments'] LOOP
    EXECUTE format('CREATE TRIGGER immutable_records BEFORE UPDATE OR DELETE ON mbox.%I FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change()',relation);
  END LOOP;
END $$;
GRANT UPDATE ON mbox.item_after_sales_cases,mbox.order_item_quantity_units,mbox.order_item_unit_inventory TO mbox_runtime;

CREATE FUNCTION mbox.guard_quantity_receivable_adjustment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original_item mbox.order_items; target_case mbox.item_after_sales_cases; previous_amount bigint; selected_count integer;
BEGIN
  PERFORM 1 FROM mbox.orders WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=NEW.order_id FOR UPDATE;
  SELECT * INTO STRICT original_item FROM mbox.order_items WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=NEW.order_item_id;
  SELECT * INTO STRICT target_case FROM mbox.item_after_sales_cases WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=NEW.case_id;
  IF original_item.order_id<>NEW.order_id OR target_case.order_id<>NEW.order_id OR COALESCE(target_case.resolved_kind,target_case.kind)<>'unpaid_stop' OR target_case.status NOT IN ('requested','approved')
    OR target_case.amount_minor IS NULL OR NEW.amount_minor<>target_case.amount_minor THEN
    RAISE EXCEPTION 'receivable adjustment must use the original unpaid case amount' USING ERRCODE='23514';
  END IF;
  IF EXISTS(SELECT 1 FROM mbox.order_payment_facts WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND order_id=NEW.order_id AND status NOT IN ('failed','closed')) THEN
    RAISE EXCEPTION 'receivable adjustment cannot erase paid or unresolved money' USING ERRCODE='23514';
  END IF;
  -- The authorised unpaid made-goods decision can settle money before the
  -- actual return/loss. It cannot discard held quantities or fabricate a refund.
  IF target_case.status='approved' AND (
    target_case.decided_by_employee_id IS DISTINCT FROM NEW.created_by_employee_id
    OR NOT EXISTS(SELECT 1 FROM mbox.item_after_sales_case_units selected JOIN mbox.order_item_quantity_units unit
      ON unit.tenant_id=selected.tenant_id AND unit.store_id=selected.store_id AND unit.id=selected.unit_id
      WHERE selected.tenant_id=NEW.tenant_id AND selected.store_id=NEW.store_id AND selected.case_id=NEW.case_id AND unit.production_state<>'unmade')
    OR NOT mbox.employee_has_effective_permission(NEW.tenant_id,NEW.store_id,NEW.created_by_employee_id,
      CASE WHEN EXISTS(SELECT 1 FROM mbox.item_after_sales_case_units selected
        WHERE selected.tenant_id=NEW.tenant_id AND selected.store_id=NEW.store_id AND selected.case_id=NEW.case_id
          AND mbox.quantity_unit_has_delivery(selected.tenant_id,selected.store_id,selected.unit_id))
      THEN 'order.settle_exception' ELSE 'order.cancel_unpaid' END)
  ) THEN RAISE EXCEPTION 'made unpaid reduction requires the original authorised operating decision' USING ERRCODE='23514'; END IF;
  SELECT count(*) INTO selected_count FROM mbox.item_after_sales_case_units selected JOIN mbox.order_item_quantity_units unit
    ON unit.tenant_id=selected.tenant_id AND unit.store_id=selected.store_id AND unit.id=selected.unit_id
    WHERE selected.tenant_id=NEW.tenant_id AND selected.store_id=NEW.store_id AND selected.case_id=NEW.case_id
      AND unit.order_item_id=NEW.order_item_id AND (unit.stopped_by_case_id=NEW.case_id AND (unit.production_state='unmade' OR target_case.status='approved')
        OR target_case.status='approved' AND unit.production_state<>'unmade' AND unit.held_by_case_id=NEW.case_id);
  IF selected_count<>NEW.quantity OR selected_count<>(SELECT count(*) FROM mbox.item_after_sales_case_units WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND case_id=NEW.case_id) THEN
    RAISE EXCEPTION 'receivable adjustment requires exact stopped or authorised held made quantities' USING ERRCODE='23514';
  END IF;
  IF (SELECT count(original_amount_minor) FROM mbox.order_item_quantity_units WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id IN (SELECT unit_id FROM mbox.item_after_sales_case_units WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND case_id=NEW.case_id))=NEW.quantity THEN
    IF NEW.amount_minor<>(SELECT sum(original_amount_minor) FROM mbox.order_item_quantity_units WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id IN (SELECT unit_id FROM mbox.item_after_sales_case_units WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND case_id=NEW.case_id)) THEN
      RAISE EXCEPTION 'receivable adjustment differs from the original unit allocation' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.quantity<>original_item.quantity OR NEW.amount_minor<>original_item.total_amount_minor THEN
    RAISE EXCEPTION 'partial discounted receivable requires an original unit allocation' USING ERRCODE='23514';
  END IF;
  SELECT COALESCE(sum(amount_minor),0) INTO previous_amount FROM mbox.item_receivable_adjustments
    WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND order_item_id=NEW.order_item_id;
  IF previous_amount+NEW.amount_minor>original_item.total_amount_minor THEN
    RAISE EXCEPTION 'receivable reductions exceed the original line amount' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER quantity_receivable_source BEFORE INSERT ON mbox.item_receivable_adjustments FOR EACH ROW EXECUTE FUNCTION mbox.guard_quantity_receivable_adjustment();
CREATE FUNCTION mbox.order_receivable_amount(p_tenant uuid,p_store uuid,p_order uuid) RETURNS bigint LANGUAGE sql STABLE AS $$
  SELECT original.total_amount_minor-COALESCE((SELECT sum(adjustment.amount_minor) FROM mbox.item_receivable_adjustments adjustment
    WHERE adjustment.tenant_id=original.tenant_id AND adjustment.store_id=original.store_id AND adjustment.order_id=original.id),0)::bigint
  FROM mbox.orders original WHERE original.tenant_id=p_tenant AND original.store_id=p_store AND original.id=p_order
    AND original.tenant_id=mbox.current_tenant_id() AND original.store_id=mbox.current_store_id()
$$;
REVOKE ALL ON FUNCTION mbox.order_receivable_amount(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mbox.order_receivable_amount(uuid,uuid,uuid) TO mbox_runtime;

CREATE FUNCTION mbox.protect_quantity_case_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.resolved_kind IS NOT NULL OR NEW.closed_by_order_event_id IS NOT NULL THEN RAISE EXCEPTION 'original case starts without a payment resolution' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.closed_by_order_event_id IS DISTINCT FROM OLD.closed_by_order_event_id THEN
    IF OLD.closed_by_order_event_id IS NOT NULL OR OLD.status NOT IN ('requested','withdrawn','rejected')
      OR OLD.kind NOT IN ('unpaid_stop','payment_review')
      OR NOT EXISTS(SELECT 1 FROM mbox.order_cancellation_events event JOIN mbox.orders original
        ON original.tenant_id=event.tenant_id AND original.store_id=event.store_id AND original.id=event.order_id
        WHERE event.tenant_id=NEW.tenant_id AND event.store_id=NEW.store_id AND event.id=NEW.closed_by_order_event_id
          AND event.order_id=NEW.order_id AND original.status='cancelled')
      OR EXISTS(SELECT 1 FROM mbox.order_payment_facts WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND order_id=NEW.order_id AND status NOT IN ('failed','closed'))
      OR EXISTS(SELECT 1 FROM mbox.item_after_sales_case_refunds WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND case_id=NEW.id)
      OR NOT EXISTS(SELECT 1 FROM mbox.item_after_sales_case_units WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND case_id=NEW.id)
      OR EXISTS(SELECT 1 FROM mbox.item_after_sales_case_units selected JOIN mbox.order_item_quantity_units unit
        ON unit.tenant_id=selected.tenant_id AND unit.store_id=selected.store_id AND unit.id=selected.unit_id
        WHERE selected.tenant_id=NEW.tenant_id AND selected.store_id=NEW.store_id AND selected.case_id=NEW.id
          AND (unit.stopped_by_case_id IS DISTINCT FROM NEW.id OR unit.production_state<>'unmade' OR unit.inventory_evidence_state='unresolved'
            OR EXISTS(SELECT 1 FROM mbox.order_item_unit_inventory stock WHERE stock.tenant_id=unit.tenant_id AND stock.store_id=unit.store_id AND stock.unit_id=unit.id AND stock.status NOT IN ('released','returned')))) THEN
      RAISE EXCEPTION 'whole cancellation case completion requires original no-money and physical evidence' USING ERRCODE='23514';
    END IF;
  END IF;
  IF NEW.resolved_kind IS DISTINCT FROM OLD.resolved_kind THEN
    IF OLD.resolved_kind IS NOT NULL OR OLD.kind<>'payment_review' OR OLD.status<>'requested' OR NEW.resolved_kind IS DISTINCT FROM 'unpaid_stop'
      OR EXISTS(SELECT 1 FROM mbox.order_payment_facts WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND order_id=NEW.order_id AND status NOT IN ('failed','closed'))
      OR EXISTS(SELECT 1 FROM mbox.item_after_sales_case_refunds WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND case_id=NEW.id) THEN
      RAISE EXCEPTION 'unpaid resolution requires definitive original payment facts and cannot be rewritten' USING ERRCODE='23514';
    END IF;
  END IF;
  IF (NEW.id,NEW.tenant_id,NEW.store_id,NEW.order_id,NEW.kind,NEW.reason,NEW.requested_by_employee_id,NEW.business_date,NEW.created_at)
    IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.store_id,OLD.order_id,OLD.kind,OLD.reason,OLD.requested_by_employee_id,OLD.business_date,OLD.created_at) THEN
    RAISE EXCEPTION 'quantity case original facts are immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.status<>OLD.status AND NOT (
    OLD.status='requested' AND NEW.status IN ('approved','rejected','withdrawn') OR
    OLD.status='requested' AND NEW.status='completed' AND COALESCE(NEW.resolved_kind,OLD.kind)='unpaid_stop' OR
    OLD.status='approved' AND NEW.status='completed'
  ) THEN RAISE EXCEPTION 'quantity case decision cannot be rewritten' USING ERRCODE='23514'; END IF;
  IF OLD.status<>'requested' AND (NEW.decided_by_employee_id,NEW.decision_reason,NEW.decided_at,NEW.amount_minor)
    IS DISTINCT FROM (OLD.decided_by_employee_id,OLD.decision_reason,OLD.decided_at,OLD.amount_minor) THEN
    RAISE EXCEPTION 'quantity case decided facts are immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.status='approved' AND (NEW.decided_by_employee_id IS NULL OR NEW.decided_at IS NULL OR NEW.amount_minor IS NULL) THEN
    RAISE EXCEPTION 'quantity approval requires one reviewer and confirmed amount' USING ERRCODE='23514';
  END IF;
  IF NEW.status='completed' THEN
    IF COALESCE(NEW.resolved_kind,NEW.kind)='unpaid_stop' AND NEW.closed_by_order_event_id IS NULL AND NOT EXISTS(SELECT 1 FROM mbox.item_receivable_adjustments WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND case_id=NEW.id) THEN
      RAISE EXCEPTION 'quantity case cannot complete before receivable disposition' USING ERRCODE='23514';
    END IF;
    IF NEW.completed_at IS NULL OR (NEW.amount_minor IS NULL AND NEW.closed_by_order_event_id IS NULL) OR NOT EXISTS(
      SELECT 1 FROM mbox.item_after_sales_case_units WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND case_id=NEW.id
    ) OR EXISTS(
      SELECT 1 FROM mbox.item_after_sales_case_units selected JOIN mbox.order_item_quantity_units unit
        ON unit.tenant_id=selected.tenant_id AND unit.store_id=selected.store_id AND unit.id=selected.unit_id
        WHERE selected.tenant_id=NEW.tenant_id AND selected.store_id=NEW.store_id AND selected.case_id=NEW.id
        AND unit.stopped_by_case_id IS DISTINCT FROM NEW.id
    ) THEN RAISE EXCEPTION 'quantity case cannot complete before physical disposition' USING ERRCODE='23514'; END IF;
    IF COALESCE(NEW.resolved_kind,NEW.kind)<>'unpaid_stop' AND NEW.amount_minor>0 AND (
      NOT EXISTS(SELECT 1 FROM mbox.item_after_sales_case_refunds WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND case_id=NEW.id)
      OR EXISTS(SELECT 1 FROM mbox.item_after_sales_case_refunds link JOIN mbox.refunds r ON r.tenant_id=link.tenant_id AND r.store_id=link.store_id AND r.id=link.refund_id WHERE link.tenant_id=NEW.tenant_id AND link.store_id=NEW.store_id AND link.case_id=NEW.id AND r.status<>'succeeded' AND NOT EXISTS(SELECT 1 FROM mbox.item_after_sales_refund_retries retry WHERE retry.tenant_id=link.tenant_id AND retry.store_id=link.store_id AND retry.previous_refund_id=link.refund_id))
      OR (SELECT COALESCE(sum(r.amount_minor) FILTER(WHERE r.status='succeeded'),0) FROM mbox.item_after_sales_case_refunds link JOIN mbox.refunds r
        ON r.tenant_id=link.tenant_id AND r.store_id=link.store_id AND r.id=link.refund_id
        WHERE link.tenant_id=NEW.tenant_id AND link.store_id=NEW.store_id AND link.case_id=NEW.id)<>NEW.amount_minor
    ) THEN RAISE EXCEPTION 'quantity case cannot complete before original refunds succeed' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER quantity_case_identity BEFORE INSERT OR UPDATE ON mbox.item_after_sales_cases FOR EACH ROW EXECUTE FUNCTION mbox.protect_quantity_case_identity();

CREATE FUNCTION mbox.protect_quantity_unit_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id,NEW.tenant_id,NEW.store_id,NEW.order_item_id,NEW.unit_index,NEW.original_amount_minor,NEW.created_at)
    IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.store_id,OLD.order_item_id,OLD.unit_index,OLD.original_amount_minor,OLD.created_at) THEN
    RAISE EXCEPTION 'quantity unit original facts are immutable' USING ERRCODE='23514';
  END IF;
  IF array_position(ARRAY['unmade','started','ready','delivered'],NEW.production_state)
    < array_position(ARRAY['unmade','started','ready','delivered'],OLD.production_state) THEN
    RAISE EXCEPTION 'production facts cannot be rewound by after-sales' USING ERRCODE='23514';
  END IF;
  IF (OLD.closed_by_order_event_id IS NOT NULL OR OLD.closed_by_turnover_event_id IS NOT NULL)
    AND (NEW.closed_by_order_event_id,NEW.closed_by_turnover_event_id,NEW.production_state)
      IS DISTINCT FROM (OLD.closed_by_order_event_id,OLD.closed_by_turnover_event_id,OLD.production_state) THEN
    RAISE EXCEPTION 'order closure cannot reopen or rewind original quantity production' USING ERRCODE='23514';
  END IF;
  IF NEW.closed_by_order_event_id IS DISTINCT FROM OLD.closed_by_order_event_id OR NEW.closed_by_turnover_event_id IS DISTINCT FROM OLD.closed_by_turnover_event_id THEN
    IF NOT EXISTS(SELECT 1 FROM mbox.order_items item JOIN mbox.orders original
      ON original.tenant_id=item.tenant_id AND original.store_id=item.store_id AND original.id=item.order_id
      WHERE item.tenant_id=NEW.tenant_id AND item.store_id=NEW.store_id AND item.id=NEW.order_item_id AND item.status='cancelled'
        AND (EXISTS(SELECT 1 FROM mbox.order_cancellation_events event WHERE event.tenant_id=item.tenant_id AND event.store_id=item.store_id AND event.id=NEW.closed_by_order_event_id AND event.order_id=original.id)
          OR EXISTS(SELECT 1 FROM mbox.table_customer_left_turnover_events event WHERE event.tenant_id=item.tenant_id AND event.store_id=item.store_id AND event.id=NEW.closed_by_turnover_event_id AND event.table_session_id=original.table_session_id))) THEN
      RAISE EXCEPTION 'quantity closure must use original order or table event' USING ERRCODE='23514';
    END IF;
  END IF;
  IF OLD.stopped_by_case_id IS NOT NULL AND NEW.stopped_by_case_id IS DISTINCT FROM OLD.stopped_by_case_id THEN
    RAISE EXCEPTION 'stopped quantity cannot be silently reopened' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER quantity_unit_identity BEFORE UPDATE ON mbox.order_item_quantity_units FOR EACH ROW EXECUTE FUNCTION mbox.protect_quantity_unit_identity();

CREATE FUNCTION mbox.protect_quantity_inventory_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id,NEW.tenant_id,NEW.store_id,NEW.unit_id,NEW.inventory_item_id,NEW.reservation_id,NEW.original_movement_id,NEW.quantity,NEW.created_at)
    IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.store_id,OLD.unit_id,OLD.inventory_item_id,OLD.reservation_id,OLD.original_movement_id,OLD.quantity,OLD.created_at) THEN
    RAISE EXCEPTION 'quantity inventory original facts are immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.status<>OLD.status AND NOT (
    (OLD.status='reserved' AND NEW.status IN ('consumed','released')) OR
    (OLD.status='consumed' AND NEW.status IN ('returned','used_loss'))
  ) THEN RAISE EXCEPTION 'quantity inventory terminal state cannot be reopened' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER quantity_inventory_identity BEFORE UPDATE ON mbox.order_item_unit_inventory FOR EACH ROW EXECUTE FUNCTION mbox.protect_quantity_inventory_identity();

-- A notification is a new committed source, not a replay of the original production order.
ALTER TABLE mbox.print_source_jobs DROP CONSTRAINT print_source_jobs_ticket_kind_check;
ALTER TABLE mbox.print_source_jobs ADD CHECK(ticket_kind IN ('production','settlement','payment','activity_payment','refund','activity_refund','order_summary','delivery','table_settlement','daily_settlement','delivery_batch','production_notice'));
ALTER TABLE mbox.print_ticket_policies DROP CONSTRAINT print_ticket_policies_ticket_kind_check;
ALTER TABLE mbox.print_ticket_policies ADD CHECK(ticket_kind IN ('cashier_settlement','cashier_payment','cashier_refund','bar_production','kitchen_production','order_summary','delivery','table_settlement','daily_settlement','production_notice'));

UPDATE mbox.normalized_schema_metadata SET schema_version='201',updated_at=clock_timestamp() WHERE singleton=true AND schema_flavor='normalized-core-v1';
-- Operating summaries use effective receivables while preserving original order
-- amounts and actual payment/refund ledgers. Historical saved summaries remain unchanged.
CREATE OR REPLACE FUNCTION mbox.operating_day_summary(p_tenant uuid,p_store uuid,p_date date)
RETURNS jsonb LANGUAGE sql STABLE AS $summary$
 WITH day_orders AS (
   SELECT o.*,mbox.order_receivable_amount(o.tenant_id,o.store_id,o.id) AS effective_minor
   FROM mbox.orders o WHERE o.tenant_id=p_tenant AND o.store_id=p_store AND o.business_date=p_date
     AND o.status NOT IN ('draft','cancelled')
 ), amounts AS (
   SELECT o.id,o.total_amount_minor,o.effective_minor,
     CASE WHEN EXISTS(SELECT 1 FROM mbox.order_settlement_exception_events e WHERE e.tenant_id=p_tenant AND e.store_id=p_store AND e.order_id=o.id) THEN 0 ELSE
       GREATEST(0,o.effective_minor-COALESCE((SELECT sum(p.amount_minor) FROM mbox.order_payment_facts p
         WHERE p.tenant_id=p_tenant AND p.store_id=p_store AND p.order_id=o.id
           AND p.status IN ('succeeded','partially_refunded','refunded')),0)
         + CASE WHEN EXISTS(SELECT 1 FROM mbox.order_recollection_authorizations a WHERE a.tenant_id=p_tenant AND a.store_id=p_store AND a.order_id=o.id AND a.status='active' AND a.expires_at>statement_timestamp())
           THEN COALESCE((SELECT sum(r.amount_minor) FROM mbox.order_refund_facts r
             WHERE r.tenant_id=p_tenant AND r.store_id=p_store AND r.order_id=o.id AND r.status='succeeded'),0) ELSE 0 END) END AS outstanding
   FROM day_orders o
 ) SELECT jsonb_build_object(
   'orderCount',(SELECT count(*) FROM amounts),
   'originalOrderAmountMinor',(SELECT COALESCE(sum(total_amount_minor),0)::text FROM amounts),
   'stoppedAmountMinor',(SELECT COALESCE(sum(total_amount_minor-effective_minor),0)::text FROM amounts),
   'orderAmountMinor',(SELECT COALESCE(sum(effective_minor),0)::text FROM amounts),
   'unsettledCount',(SELECT count(*) FROM amounts WHERE outstanding>0),
   'outstandingMinor',(SELECT COALESCE(sum(outstanding),0)::text FROM amounts),
   'pendingPaymentCount',0,
   'pendingRefundCount',(SELECT count(*) FROM mbox.refunds r
     WHERE r.tenant_id=p_tenant AND r.store_id=p_store AND r.status IN ('requested','approved','processing','failed')
       AND NOT EXISTS(SELECT 1 FROM mbox.item_after_sales_refund_retries superseded WHERE superseded.tenant_id=r.tenant_id AND superseded.store_id=r.store_id AND superseded.previous_refund_id=r.id)
       AND EXISTS(SELECT 1 FROM mbox.order_payment_facts p JOIN mbox.orders o ON o.tenant_id=p.tenant_id AND o.store_id=p.store_id AND o.id=p.order_id
         WHERE p.tenant_id=r.tenant_id AND p.store_id=r.store_id AND p.id=r.payment_id AND (r.order_id IS NULL OR r.order_id=p.order_id) AND o.business_date=p_date)))
$summary$;


-- A delivery batch binds actual original units, not just a count that can later
-- accidentally include held goods. Old batch records retain their original form.
CREATE TABLE mbox.delivery_batch_quantity_units (
  tenant_id uuid NOT NULL,store_id uuid NOT NULL,batch_id uuid NOT NULL,kds_task_id uuid NOT NULL,unit_id uuid NOT NULL,
  PRIMARY KEY(tenant_id,store_id,unit_id),
  FOREIGN KEY(tenant_id,store_id,batch_id,kds_task_id) REFERENCES mbox.delivery_batch_items(tenant_id,store_id,batch_id,kds_task_id),
  FOREIGN KEY(tenant_id,store_id,unit_id) REFERENCES mbox.order_item_quantity_units(tenant_id,store_id,id)
);
CREATE FUNCTION mbox.validate_delivery_quantity_unit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM mbox.order_item_quantity_units unit JOIN mbox.kds_tasks task
    ON task.tenant_id=unit.tenant_id AND task.store_id=unit.store_id AND task.order_item_id=unit.order_item_id
    WHERE unit.tenant_id=NEW.tenant_id AND unit.store_id=NEW.store_id AND unit.id=NEW.unit_id AND task.id=NEW.kds_task_id
      AND unit.production_state='ready' AND unit.held_by_case_id IS NULL AND NOT unit.operationally_stopped
      AND NOT EXISTS(SELECT 1 FROM mbox.quantity_remake_units part WHERE part.tenant_id=unit.tenant_id AND part.store_id=unit.store_id AND part.unit_id=unit.id)) THEN
    RAISE EXCEPTION 'delivery batch requires original ready unheld quantity units' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER delivery_batch_quantity_validate BEFORE INSERT ON mbox.delivery_batch_quantity_units FOR EACH ROW EXECUTE FUNCTION mbox.validate_delivery_quantity_unit();
CREATE TRIGGER delivery_batch_quantity_immutable BEFORE UPDATE OR DELETE ON mbox.delivery_batch_quantity_units FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();
ALTER TABLE mbox.delivery_batch_quantity_units ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.delivery_batch_quantity_units FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.delivery_batch_quantity_units USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
GRANT SELECT,INSERT ON mbox.delivery_batch_quantity_units TO mbox_runtime;
REVOKE ALL ON FUNCTION mbox.validate_delivery_quantity_unit() FROM PUBLIC;

-- A queued/printed notice is not evidence that the operating station saw it.
-- Link each immutable notice to its case; acknowledgement never changes money or stock.
CREATE TABLE mbox.item_after_sales_notices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,
  case_id uuid NOT NULL,source_outbox_message_id uuid NOT NULL,
  station_code text NOT NULL CHECK(station_code IN ('bar','kitchen')),
  instruction text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  acknowledged_by_employee_id uuid,acknowledged_at timestamptz,
  UNIQUE(tenant_id,store_id,id),UNIQUE(tenant_id,store_id,source_outbox_message_id),
  FOREIGN KEY(tenant_id,store_id,case_id) REFERENCES mbox.item_after_sales_cases(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,source_outbox_message_id) REFERENCES mbox.outbox_messages(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,acknowledged_by_employee_id) REFERENCES mbox.employees(tenant_id,store_id,id),
  CHECK((acknowledged_at IS NULL)=(acknowledged_by_employee_id IS NULL))
);
CREATE INDEX item_after_sales_notices_case_idx ON mbox.item_after_sales_notices(tenant_id,store_id,case_id,created_at,id);
CREATE INDEX item_after_sales_notices_pending_idx ON mbox.item_after_sales_notices(tenant_id,store_id,case_id) WHERE acknowledged_at IS NULL;
CREATE FUNCTION mbox.protect_item_notice_acknowledgement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id,NEW.tenant_id,NEW.store_id,NEW.case_id,NEW.source_outbox_message_id,NEW.station_code,NEW.instruction,NEW.created_at)
    IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.store_id,OLD.case_id,OLD.source_outbox_message_id,OLD.station_code,OLD.instruction,OLD.created_at)
    OR OLD.acknowledged_at IS NOT NULL AND (NEW.acknowledged_at,NEW.acknowledged_by_employee_id)
      IS DISTINCT FROM (OLD.acknowledged_at,OLD.acknowledged_by_employee_id) THEN
    RAISE EXCEPTION 'original station notice and acknowledgement are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER item_notice_identity BEFORE UPDATE ON mbox.item_after_sales_notices FOR EACH ROW EXECUTE FUNCTION mbox.protect_item_notice_acknowledgement();
ALTER TABLE mbox.item_after_sales_notices ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.item_after_sales_notices FORCE ROW LEVEL SECURITY;
CREATE POLICY scope_guard ON mbox.item_after_sales_notices USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
GRANT SELECT,INSERT,UPDATE ON mbox.item_after_sales_notices TO mbox_runtime;
REVOKE ALL ON FUNCTION mbox.protect_item_notice_acknowledgement() FROM PUBLIC;

-- Old whole-reservation writers must not consume/release the original full lot
-- after exact units have disposed part of it. Their entire transaction rolls back.
CREATE FUNCTION mbox.guard_quantity_original_reservation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.status,NEW.quantity,NEW.order_item_id,NEW.inventory_item_id,NEW.movement_id,NEW.return_movement_id)
    IS DISTINCT FROM (OLD.status,OLD.quantity,OLD.order_item_id,OLD.inventory_item_id,OLD.movement_id,OLD.return_movement_id)
    AND EXISTS(SELECT 1 FROM mbox.order_item_unit_inventory stock WHERE stock.tenant_id=OLD.tenant_id AND stock.store_id=OLD.store_id AND stock.reservation_id=OLD.id) THEN
    RAISE EXCEPTION 'quantity inventory requires exact units; whole reservation transition refused' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER quantity_original_reservation_guard BEFORE UPDATE ON mbox.inventory_order_reservations FOR EACH ROW EXECUTE FUNCTION mbox.guard_quantity_original_reservation();
REVOKE ALL ON FUNCTION mbox.guard_quantity_original_reservation() FROM PUBLIC;

-- Closure reads the remaining exact shares, not the frozen original lot.
-- Incomplete allocation evidence keeps the original reserved amount visible.
CREATE FUNCTION mbox.inventory_reservation_remaining_quantity(p_tenant uuid,p_store uuid,p_reservation uuid)
RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN shares.records>0 AND shares.total=reservation.quantity
    THEN shares.remaining ELSE CASE WHEN reservation.status='reserved' THEN reservation.quantity ELSE 0::numeric END END
  FROM mbox.inventory_order_reservations reservation CROSS JOIN LATERAL(
    SELECT count(*) AS records,COALESCE(sum(stock.quantity),0) AS total,
      COALESCE(sum(stock.quantity) FILTER(WHERE stock.status='reserved'),0) AS remaining
    FROM mbox.order_item_unit_inventory stock WHERE stock.tenant_id=reservation.tenant_id
      AND stock.store_id=reservation.store_id AND stock.reservation_id=reservation.id
  ) shares WHERE reservation.tenant_id=p_tenant AND reservation.store_id=p_store AND reservation.id=p_reservation
$$;
REVOKE ALL ON FUNCTION mbox.inventory_reservation_remaining_quantity(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mbox.inventory_reservation_remaining_quantity(uuid,uuid,uuid) TO mbox_runtime;

-- The movement command has an embedded closure check. Match its existing
-- protections to explicit quantity receivable adjustments and exact inventory.
DO $quantity_closure$ DECLARE definition text;needle text;replacement text; BEGIN
  SELECT pg_get_functiondef(p.oid) INTO definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='mbox' AND p.proname='execute_table_customer_movement' AND p.pronargs=15;
  needle:=$old$(order_row.status NOT IN ('draft','cancelled') AND order_row.total_amount_minor=0)$old$;
  replacement:=$new$(order_row.status NOT IN ('draft','cancelled') AND (order_row.total_amount_minor=0 OR (
    EXISTS(SELECT 1 FROM mbox.item_receivable_adjustments adjustment WHERE adjustment.tenant_id=order_row.tenant_id
      AND adjustment.store_id=order_row.store_id AND adjustment.order_id=order_row.id)
    AND mbox.order_receivable_amount(order_row.tenant_id,order_row.store_id,order_row.id)<=COALESCE((
      SELECT sum(payment.amount_minor) FROM mbox.order_payment_facts payment WHERE payment.tenant_id=order_row.tenant_id
        AND payment.store_id=order_row.store_id AND payment.order_id=order_row.id AND payment.status IN ('succeeded','partially_refunded','refunded')),0)
  )))$new$;
  IF definition IS NULL OR (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 THEN
    RAISE EXCEPTION 'unexpected quantity movement receivable predecessor'; END IF;
  definition:=replace(definition,needle,replacement);
  needle:=$old$AND order_row.table_session_id=source_session.id
          AND reservation.status='reserved'
          AND (closes_source_session OR order_row.created_by_customer_id IS NULL$old$;
  IF (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 THEN
    RAISE EXCEPTION 'unexpected quantity movement reservation predecessor'; END IF;
  EXECUTE replace(definition,needle,replace(needle,$old$reservation.status='reserved'$old$,'mbox.inventory_reservation_remaining_quantity(reservation.tenant_id,reservation.store_id,reservation.id)>0'));
END $quantity_closure$;

-- Original capacity facts stay immutable. Completed/stopped quantity units free
-- only their original share; paused unfinished units retain capacity for resume.
CREATE FUNCTION mbox.item_remaining_capacity_units(p_tenant uuid,p_store uuid,p_item uuid,p_original integer)
RETURNS integer LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN quantities.total=item.quantity AND mod(p_original,item.quantity)=0
    THEN (p_original/item.quantity)*quantities.remaining ELSE p_original END
  FROM mbox.order_items item CROSS JOIN LATERAL(
    SELECT count(*)::integer AS total,count(*) FILTER(WHERE NOT unit.operationally_stopped AND unit.production_state IN ('unmade','started'))::integer AS remaining
    FROM mbox.order_item_quantity_units unit WHERE unit.tenant_id=item.tenant_id AND unit.store_id=item.store_id AND unit.order_item_id=item.id
  ) quantities WHERE item.tenant_id=p_tenant AND item.store_id=p_store AND item.id=p_item
$$;
REVOKE ALL ON FUNCTION mbox.item_remaining_capacity_units(uuid,uuid,uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mbox.item_remaining_capacity_units(uuid,uuid,uuid,integer) TO mbox_runtime;
DO $capacity$ DECLARE signature text;definition text; BEGIN
  FOREACH signature IN ARRAY ARRAY['mbox.validate_fulfillment_capacity_reservation()','mbox.reserve_order_fulfillment_capacity(uuid,uuid,uuid)'] LOOP
    definition:=pg_get_functiondef(signature::regprocedure);
    IF position('sum(reservation.capacity_units)' IN definition)=0 THEN RAISE EXCEPTION 'quantity capacity source definition changed: %',signature; END IF;
    definition:=replace(definition,'sum(reservation.capacity_units)','sum(mbox.item_remaining_capacity_units(reservation.tenant_id,reservation.store_id,reservation.order_item_id,reservation.capacity_units))');
    EXECUTE definition;
  END LOOP;
END $capacity$;

-- Existing closure events own operational retirement. Refund approval and
-- physical return remain separate, and delivered/consumed evidence is retained.
CREATE FUNCTION mbox.complete_quantity_case_from_order_cancellation(p_case uuid) RETURNS boolean LANGUAGE plpgsql AS $case_close$
DECLARE target mbox.item_after_sales_cases; original_event uuid; target_order uuid;
BEGIN
  SELECT order_id INTO target_order FROM mbox.item_after_sales_cases WHERE tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id() AND id=p_case;
  PERFORM 1 FROM mbox.orders WHERE tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id() AND id=target_order FOR UPDATE;
  SELECT * INTO target FROM mbox.item_after_sales_cases WHERE tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id() AND id=p_case FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF target.closed_by_order_event_id IS NOT NULL THEN RETURN true; END IF;
  IF target.kind NOT IN ('unpaid_stop','payment_review') OR target.status NOT IN ('requested','rejected','withdrawn') THEN RETURN false; END IF;
  SELECT event.id INTO original_event FROM mbox.order_cancellation_events event JOIN mbox.orders original
    ON original.tenant_id=event.tenant_id AND original.store_id=event.store_id AND original.id=event.order_id
    WHERE event.tenant_id=target.tenant_id AND event.store_id=target.store_id AND event.order_id=target.order_id AND original.status='cancelled'
    ORDER BY event.occurred_at,event.id LIMIT 1;
  IF original_event IS NULL
    OR EXISTS(SELECT 1 FROM mbox.order_payment_facts WHERE tenant_id=target.tenant_id AND store_id=target.store_id AND order_id=target.order_id AND status NOT IN ('failed','closed'))
    OR EXISTS(SELECT 1 FROM mbox.item_after_sales_case_refunds WHERE tenant_id=target.tenant_id AND store_id=target.store_id AND case_id=p_case)
    OR NOT EXISTS(SELECT 1 FROM mbox.item_after_sales_case_units WHERE tenant_id=target.tenant_id AND store_id=target.store_id AND case_id=p_case)
    OR EXISTS(SELECT 1 FROM mbox.item_after_sales_case_units selected JOIN mbox.order_item_quantity_units unit
      ON unit.tenant_id=selected.tenant_id AND unit.store_id=selected.store_id AND unit.id=selected.unit_id
      WHERE selected.tenant_id=target.tenant_id AND selected.store_id=target.store_id AND selected.case_id=p_case AND (
        unit.production_state<>'unmade' OR unit.inventory_evidence_state='unresolved' OR NOT unit.operationally_stopped
        OR unit.held_by_case_id IS DISTINCT FROM p_case AND unit.stopped_by_case_id IS DISTINCT FROM p_case
        OR EXISTS(SELECT 1 FROM mbox.order_item_unit_inventory stock WHERE stock.tenant_id=unit.tenant_id AND stock.store_id=unit.store_id AND stock.unit_id=unit.id AND stock.status NOT IN ('released','returned')))) THEN RETURN false;
  END IF;
  UPDATE mbox.order_item_quantity_units SET held_by_case_id=NULL,stopped_by_case_id=p_case,updated_at=clock_timestamp()
    WHERE tenant_id=target.tenant_id AND store_id=target.store_id AND held_by_case_id=p_case;
  UPDATE mbox.item_after_sales_cases SET closed_by_order_event_id=original_event,
    resolved_kind=CASE WHEN kind='payment_review' AND status='requested' THEN 'unpaid_stop' ELSE resolved_kind END,
    completed_at=CASE WHEN status='requested' THEN clock_timestamp() ELSE completed_at END,
    status=CASE WHEN status='requested' THEN 'completed' ELSE status END
    WHERE tenant_id=target.tenant_id AND store_id=target.store_id AND id=p_case;
  RETURN true;
END $case_close$;
REVOKE ALL ON FUNCTION mbox.complete_quantity_case_from_order_cancellation(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mbox.complete_quantity_case_from_order_cancellation(uuid) TO mbox_runtime;

-- Closing the visit and declining the refund can happen in either order.
-- Only already-released, unused shares settle without a physical stock action.
CREATE FUNCTION mbox.settle_declined_quantity_after_closure(p_case uuid) RETURNS integer LANGUAGE plpgsql AS $settle$
DECLARE changed integer;
BEGIN
  PERFORM original.id FROM mbox.orders original JOIN mbox.item_after_sales_cases target
    ON target.tenant_id=original.tenant_id AND target.store_id=original.store_id AND target.order_id=original.id
    WHERE target.tenant_id=mbox.current_tenant_id() AND target.store_id=mbox.current_store_id() AND target.id=p_case FOR UPDATE OF original;
  UPDATE mbox.order_item_quantity_units unit SET stopped_by_case_id=unit.held_by_case_id,
    held_by_case_id=NULL,updated_at=clock_timestamp()
    FROM mbox.item_after_sales_cases target
    WHERE unit.tenant_id=mbox.current_tenant_id() AND unit.store_id=mbox.current_store_id()
      AND target.tenant_id=unit.tenant_id AND target.store_id=unit.store_id AND target.id=p_case AND target.id=unit.held_by_case_id
      AND target.status IN ('rejected','withdrawn') AND unit.production_state='unmade' AND unit.operationally_stopped
      AND unit.inventory_evidence_state<>'unresolved' AND NOT EXISTS(
        SELECT 1 FROM mbox.order_item_unit_inventory stock WHERE stock.tenant_id=unit.tenant_id
          AND stock.store_id=unit.store_id AND stock.unit_id=unit.id AND stock.status NOT IN ('released','returned'));
  GET DIAGNOSTICS changed=ROW_COUNT;
  RETURN changed;
END $settle$;
REVOKE ALL ON FUNCTION mbox.settle_declined_quantity_after_closure(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mbox.settle_declined_quantity_after_closure(uuid) TO mbox_runtime;
CREATE FUNCTION mbox.settle_declined_quantity_case_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM mbox.settle_declined_quantity_after_closure(NEW.id);
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION mbox.settle_declined_quantity_case_trigger() FROM PUBLIC;
CREATE TRIGGER quantity_declined_closure AFTER UPDATE OF status ON mbox.item_after_sales_cases
  FOR EACH ROW WHEN(NEW.status IN ('rejected','withdrawn') AND OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION mbox.settle_declined_quantity_case_trigger();

CREATE FUNCTION mbox.retire_quantity_on_order_closure() RETURNS trigger LANGUAGE plpgsql AS $closure$
DECLARE order_ids uuid[]; stock_ids uuid[]; unit_ids uuid[]; demand record; case_id_value uuid;
BEGIN
  IF TG_TABLE_NAME='order_cancellation_events' THEN order_ids:=ARRAY[NEW.order_id];
  ELSE SELECT array_agg(id ORDER BY id) INTO order_ids FROM mbox.orders
    WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND table_session_id=NEW.table_session_id;
  END IF;
  SELECT array_agg(unit.id ORDER BY item.id,unit.unit_index) INTO unit_ids
    FROM mbox.order_item_quantity_units unit JOIN mbox.order_items item
      ON item.tenant_id=unit.tenant_id AND item.store_id=unit.store_id AND item.id=unit.order_item_id
    WHERE unit.tenant_id=NEW.tenant_id AND unit.store_id=NEW.store_id AND item.order_id=ANY(order_ids)
      AND item.status='cancelled' AND NOT mbox.quantity_unit_has_delivery(unit.tenant_id,unit.store_id,unit.id) AND NOT unit.operationally_stopped;
  IF COALESCE(cardinality(unit_ids),0)=0 THEN RETURN NEW; END IF;
  PERFORM 1 FROM mbox.order_item_quantity_units WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=ANY(unit_ids) ORDER BY order_item_id,unit_index FOR UPDATE;
  PERFORM 1 FROM mbox.inventory_balances balance WHERE balance.tenant_id=NEW.tenant_id AND balance.store_id=NEW.store_id
    AND inventory_item_id IN (SELECT stock.inventory_item_id FROM mbox.order_item_unit_inventory stock
      WHERE stock.tenant_id=NEW.tenant_id AND stock.store_id=NEW.store_id AND stock.unit_id=ANY(unit_ids) AND stock.status='reserved')
    ORDER BY inventory_item_id FOR UPDATE;
  SELECT array_agg(id ORDER BY inventory_item_id,id) INTO stock_ids FROM mbox.order_item_unit_inventory
    WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND unit_id=ANY(unit_ids) AND status='reserved';
  IF EXISTS(SELECT 1 FROM mbox.order_item_unit_inventory stock JOIN mbox.order_item_quantity_units unit
      ON unit.tenant_id=stock.tenant_id AND unit.store_id=stock.store_id AND unit.id=stock.unit_id
      WHERE stock.tenant_id=NEW.tenant_id AND stock.store_id=NEW.store_id AND stock.id=ANY(stock_ids) AND unit.production_state<>'unmade') THEN
    RAISE EXCEPTION 'made quantity still has unused inventory reservation' USING ERRCODE='55000';
  END IF;
  FOR demand IN SELECT inventory_item_id,sum(quantity) AS quantity FROM mbox.order_item_unit_inventory
      WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=ANY(stock_ids)
      GROUP BY inventory_item_id ORDER BY inventory_item_id LOOP
    UPDATE mbox.inventory_balances SET reserved_quantity=reserved_quantity-demand.quantity,updated_at=clock_timestamp()
      WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND inventory_item_id=demand.inventory_item_id AND reserved_quantity>=demand.quantity;
    IF NOT FOUND THEN RAISE EXCEPTION 'remaining quantity inventory reservation is inconsistent' USING ERRCODE='55000'; END IF;
  END LOOP;
  UPDATE mbox.order_item_unit_inventory SET status='released',updated_at=clock_timestamp()
    WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=ANY(stock_ids);
  UPDATE mbox.order_item_quantity_units SET
    closed_by_order_event_id=CASE WHEN TG_TABLE_NAME='order_cancellation_events' THEN NEW.id ELSE NULL END,
    closed_by_turnover_event_id=CASE WHEN TG_TABLE_NAME='table_customer_left_turnover_events' THEN NEW.id ELSE NULL END,updated_at=clock_timestamp()
    WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=ANY(unit_ids);
  FOR case_id_value IN SELECT DISTINCT held_by_case_id FROM mbox.order_item_quantity_units
    WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=ANY(unit_ids) AND held_by_case_id IS NOT NULL LOOP
    PERFORM mbox.complete_quantity_case_from_order_cancellation(case_id_value);
    PERFORM mbox.settle_declined_quantity_after_closure(case_id_value);
  END LOOP;
  RETURN NEW;
END $closure$;
REVOKE ALL ON FUNCTION mbox.retire_quantity_on_order_closure() FROM PUBLIC;
CREATE TRIGGER order_closure_quantity_retirement AFTER INSERT ON mbox.order_cancellation_events FOR EACH ROW EXECUTE FUNCTION mbox.retire_quantity_on_order_closure();
CREATE TRIGGER table_closure_quantity_retirement AFTER INSERT ON mbox.table_customer_left_turnover_events FOR EACH ROW EXECUTE FUNCTION mbox.retire_quantity_on_order_closure();

CREATE FUNCTION mbox.quantity_delivered_item_amount(p_tenant uuid,p_store uuid,p_item uuid) RETURNS bigint LANGUAGE plpgsql STABLE AS $amount$
DECLARE original_amount bigint; total_units integer; delivered_units integer; known_units integer; delivered_amount bigint;
BEGIN
  SELECT total_amount_minor INTO original_amount FROM mbox.order_items WHERE tenant_id=p_tenant AND store_id=p_store AND id=p_item;
  SELECT count(*)::int,count(*) FILTER(WHERE mbox.quantity_unit_has_delivery(tenant_id,store_id,id))::int,
    count(original_amount_minor) FILTER(WHERE mbox.quantity_unit_has_delivery(tenant_id,store_id,id))::int,COALESCE(sum(original_amount_minor) FILTER(WHERE mbox.quantity_unit_has_delivery(tenant_id,store_id,id)),0)::bigint
    INTO total_units,delivered_units,known_units,delivered_amount FROM mbox.order_item_quantity_units
    WHERE tenant_id=p_tenant AND store_id=p_store AND order_item_id=p_item;
  IF total_units=0 OR delivered_units=total_units THEN RETURN original_amount; END IF;
  IF known_units<>delivered_units THEN RAISE EXCEPTION 'delivered quantity original price allocation requires review' USING ERRCODE='55000'; END IF;
  RETURN delivered_amount;
END $amount$;
REVOKE ALL ON FUNCTION mbox.quantity_delivered_item_amount(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mbox.quantity_delivered_item_amount(uuid,uuid,uuid) TO mbox_runtime;

DO $whole_quantity$
DECLARE signature text; definition text; old_clause text; new_clause text; order_variable text; order_filter text; lock_prefix text;
BEGIN
  FOREACH signature IN ARRAY ARRAY['mbox.cancel_unpaid_order(uuid,uuid,date,text,text,text,character)',
    'mbox.close_table_after_customer_left(uuid,uuid,date,text,text,character)',
    'mbox.close_table_after_automatic_cutoff(uuid,uuid,date,text,text,character)'] LOOP
    definition:=pg_get_functiondef(signature::regprocedure);
    order_variable:=CASE WHEN signature LIKE 'mbox.cancel_unpaid_order%' THEN 'p_order_id' ELSE 'order_row.id' END;
    order_filter:=CASE WHEN order_variable='p_order_id' THEN 'original.id=p_order_id' ELSE 'original.table_session_id=p_table_session_id' END;
    -- Lock every affected order first, then all inventory ids in one order,
    -- before either legacy or quantity writers touch a balance. Mixed old/new
    -- lines must not acquire these shared stocks in opposite per-line order.
    lock_prefix:='PERFORM 1 FROM mbox.orders original WHERE original.tenant_id=tenant_scope AND original.store_id=store_scope AND '||order_filter||' ORDER BY original.id FOR UPDATE;
    PERFORM 1 FROM mbox.inventory_balances balance WHERE balance.tenant_id=tenant_scope AND balance.store_id=store_scope AND balance.inventory_item_id IN (
      SELECT reservation.inventory_item_id FROM mbox.inventory_order_reservations reservation JOIN mbox.orders original
        ON original.tenant_id=reservation.tenant_id AND original.store_id=reservation.store_id AND original.id=reservation.order_id
        WHERE original.tenant_id=tenant_scope AND original.store_id=store_scope AND '||order_filter||'
      UNION SELECT stock.inventory_item_id FROM mbox.order_item_unit_inventory stock JOIN mbox.order_item_quantity_units unit
        ON unit.tenant_id=stock.tenant_id AND unit.store_id=stock.store_id AND unit.id=stock.unit_id
      JOIN mbox.order_items item ON item.tenant_id=unit.tenant_id AND item.store_id=unit.store_id AND item.id=unit.order_item_id
      JOIN mbox.orders original ON original.tenant_id=item.tenant_id AND original.store_id=item.store_id AND original.id=item.order_id
        WHERE original.tenant_id=tenant_scope AND original.store_id=store_scope AND '||order_filter||'
    ) ORDER BY balance.inventory_item_id FOR UPDATE;
    IF EXISTS(SELECT 1 FROM mbox.order_item_unit_inventory stock JOIN mbox.order_item_quantity_units unit
        ON unit.tenant_id=stock.tenant_id AND unit.store_id=stock.store_id AND unit.id=stock.unit_id
      JOIN mbox.order_items item ON item.tenant_id=unit.tenant_id AND item.store_id=unit.store_id AND item.id=unit.order_item_id
      JOIN mbox.orders original ON original.tenant_id=item.tenant_id AND original.store_id=item.store_id AND original.id=item.order_id
      WHERE original.tenant_id=tenant_scope AND original.store_id=store_scope AND '||order_filter||' AND (
        stock.status=''reserved'' AND (unit.production_state<>''unmade'' OR item.status=''delivered'')
        OR stock.reservation_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM mbox.inventory_order_reservations reservation
          WHERE reservation.tenant_id=stock.tenant_id AND reservation.store_id=stock.store_id AND reservation.id=stock.reservation_id
            AND reservation.quantity=(SELECT sum(part.quantity) FROM mbox.order_item_unit_inventory part
              WHERE part.tenant_id=stock.tenant_id AND part.store_id=stock.store_id AND part.reservation_id=stock.reservation_id)))) THEN
      RAISE EXCEPTION ''original quantity reservation evidence is inconsistent'' USING ERRCODE=''55000'';
    END IF;
    ';
    old_clause:=CASE WHEN order_variable='p_order_id' THEN 'SELECT count(*)::integer INTO delivered_count' ELSE 'FOR order_row IN' END;
    IF (length(definition)-length(replace(definition,old_clause,'')))/length(old_clause)<>1 THEN
      RAISE EXCEPTION 'whole-order lock baseline does not match: %',signature USING ERRCODE='55000';
    END IF;
    definition:=replace(definition,old_clause,lock_prefix||old_clause);
    old_clause:='reservation.order_id='||order_variable||' AND reservation.status=''reserved''';
    IF (length(definition)-length(replace(definition,old_clause,'')))/length(old_clause)<>4 THEN
      RAISE EXCEPTION 'whole-order reservation baseline does not match: %',signature USING ERRCODE='55000';
    END IF;
    new_clause:=old_clause||' AND NOT EXISTS(SELECT 1 FROM mbox.order_item_unit_inventory exact_stock WHERE exact_stock.tenant_id=reservation.tenant_id AND exact_stock.store_id=reservation.store_id AND exact_stock.reservation_id=reservation.id)';
    definition:=replace(definition,old_clause,new_clause);
    old_clause:='SELECT count(*)::integer INTO released_reservations FROM released;';
    IF position(old_clause IN definition)=0 THEN RAISE EXCEPTION 'whole-order release result baseline does not match' USING ERRCODE='55000'; END IF;
    definition:=replace(definition,old_clause,old_clause||'
    released_reservations:=released_reservations+(SELECT count(DISTINCT exact_stock.reservation_id)::integer
      FROM mbox.order_item_unit_inventory exact_stock JOIN mbox.order_item_quantity_units unit
        ON unit.tenant_id=exact_stock.tenant_id AND unit.store_id=exact_stock.store_id AND unit.id=exact_stock.unit_id
      JOIN mbox.order_items item ON item.tenant_id=unit.tenant_id AND item.store_id=unit.store_id AND item.id=unit.order_item_id
      WHERE exact_stock.tenant_id=tenant_scope AND exact_stock.store_id=store_scope AND item.order_id='||order_variable||' AND item.status=''cancelled'' AND exact_stock.status=''reserved'');');
    old_clause:='AND item.order_id='||order_variable||' AND item.status=''delivered'';';
    IF position(old_clause IN definition)=0 THEN RAISE EXCEPTION 'whole-order delivered baseline does not match' USING ERRCODE='55000'; END IF;
    definition:=replace(definition,old_clause,'AND item.order_id='||order_variable||' AND (item.status=''delivered'' OR EXISTS(SELECT 1 FROM mbox.order_item_quantity_units unit WHERE unit.tenant_id=item.tenant_id AND unit.store_id=item.store_id AND unit.order_item_id=item.id AND mbox.quantity_unit_has_delivery(unit.tenant_id,unit.store_id,unit.id)));');
    definition:=replace(definition,'COALESCE(sum(item.total_amount_minor),0)','COALESCE(sum(mbox.quantity_delivered_item_amount(item.tenant_id,item.store_id,item.id)),0)');
    EXECUTE definition;
  END LOOP;
END $whole_quantity$;

-- Redelivery of the same physical goods is separate from producing a new batch.
CREATE TABLE mbox.quantity_redeliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,
  order_item_id uuid NOT NULL,service_task_id uuid NOT NULL,requested_by_employee_id uuid NOT NULL,
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 2 AND 1000),original_goods_available boolean NOT NULL CHECK(original_goods_available),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(tenant_id,store_id,id),UNIQUE(tenant_id,store_id,service_task_id),
  FOREIGN KEY(tenant_id,store_id,order_item_id) REFERENCES mbox.order_items(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,service_task_id) REFERENCES mbox.service_tasks(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,requested_by_employee_id) REFERENCES mbox.employees(tenant_id,store_id,id)
);
CREATE TABLE mbox.quantity_redelivery_units (
  tenant_id uuid NOT NULL,store_id uuid NOT NULL,redelivery_id uuid NOT NULL,unit_id uuid NOT NULL,
  outcome text CHECK(outcome IN ('delivered','cancelled')),closed_at timestamptz,closed_by_employee_id uuid,close_reason text,
  PRIMARY KEY(tenant_id,store_id,redelivery_id,unit_id),
  CHECK((outcome IS NULL AND closed_at IS NULL AND closed_by_employee_id IS NULL AND close_reason IS NULL)
     OR (outcome IS NOT NULL AND closed_at IS NOT NULL AND length(btrim(close_reason))>0)),
  CHECK(outcome IS DISTINCT FROM 'delivered' OR closed_by_employee_id IS NOT NULL),
  FOREIGN KEY(tenant_id,store_id,redelivery_id) REFERENCES mbox.quantity_redeliveries(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,unit_id) REFERENCES mbox.order_item_quantity_units(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,closed_by_employee_id) REFERENCES mbox.employees(tenant_id,store_id,id)
);
CREATE UNIQUE INDEX quantity_redelivery_active_unit_once ON mbox.quantity_redelivery_units(tenant_id,store_id,unit_id) WHERE outcome IS NULL;
CREATE INDEX quantity_redelivery_item_history ON mbox.quantity_redeliveries(tenant_id,store_id,order_item_id,created_at,id);
CREATE FUNCTION mbox.guard_quantity_redelivery_parent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM mbox.order_items item JOIN mbox.orders original ON original.tenant_id=item.tenant_id AND original.store_id=item.store_id AND original.id=item.order_id
    JOIN mbox.table_sessions visit ON visit.tenant_id=original.tenant_id AND visit.store_id=original.store_id AND visit.id=original.table_session_id
    JOIN mbox.service_tasks task ON task.tenant_id=visit.tenant_id AND task.store_id=visit.store_id AND task.table_session_id=visit.id
    WHERE item.tenant_id=NEW.tenant_id AND item.store_id=NEW.store_id AND item.id=NEW.order_item_id AND task.id=NEW.service_task_id
      AND task.task_type='goods.redelivery' AND task.status IN ('pending','acknowledged','in_progress') AND task.created_by_employee_id=NEW.requested_by_employee_id
      AND visit.status IN ('open','closing') AND original.status<>'cancelled' AND item.status<>'cancelled'
  ) THEN RAISE EXCEPTION 'redelivery must belong to the original active visit and goods' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER quantity_redelivery_parent_source BEFORE INSERT ON mbox.quantity_redeliveries FOR EACH ROW EXECUTE FUNCTION mbox.guard_quantity_redelivery_parent();
CREATE TRIGGER quantity_redelivery_parent_immutable BEFORE UPDATE OR DELETE ON mbox.quantity_redeliveries FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();
CREATE FUNCTION mbox.guard_quantity_redelivery_unit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND (NEW.tenant_id,NEW.store_id,NEW.redelivery_id,NEW.unit_id,NEW.source_remake_unit_id) IS DISTINCT FROM (OLD.tenant_id,OLD.store_id,OLD.redelivery_id,OLD.unit_id,OLD.source_remake_unit_id) THEN
    RAISE EXCEPTION 'redelivery original unit is immutable' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND OLD.outcome IS NOT NULL THEN RAISE EXCEPTION 'redelivery outcome is immutable' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' AND NEW.outcome IS NOT NULL THEN RAISE EXCEPTION 'redelivery must start pending' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' OR NEW.outcome='delivered' THEN
    IF NOT EXISTS(SELECT 1 FROM mbox.quantity_redeliveries parent JOIN mbox.order_item_quantity_units unit
      ON unit.tenant_id=parent.tenant_id AND unit.store_id=parent.store_id AND unit.order_item_id=parent.order_item_id
      JOIN mbox.order_items item ON item.tenant_id=unit.tenant_id AND item.store_id=unit.store_id AND item.id=unit.order_item_id
      JOIN mbox.orders original ON original.tenant_id=item.tenant_id AND original.store_id=item.store_id AND original.id=item.order_id
      JOIN mbox.table_sessions visit ON visit.tenant_id=original.tenant_id AND visit.store_id=original.store_id AND visit.id=original.table_session_id
      JOIN mbox.service_tasks task ON task.tenant_id=parent.tenant_id AND task.store_id=parent.store_id AND task.id=parent.service_task_id AND task.table_session_id=visit.id
      WHERE parent.tenant_id=NEW.tenant_id AND parent.store_id=NEW.store_id AND parent.id=NEW.redelivery_id AND unit.id=NEW.unit_id
        AND ((NEW.source_remake_unit_id IS NULL AND unit.production_state='delivered' AND NOT EXISTS(SELECT 1 FROM mbox.quantity_remake_units physical WHERE physical.tenant_id=unit.tenant_id AND physical.store_id=unit.store_id AND physical.unit_id=unit.id))
         OR EXISTS(SELECT 1 FROM mbox.quantity_remake_units physical WHERE physical.tenant_id=unit.tenant_id AND physical.store_id=unit.store_id AND physical.unit_id=unit.id AND physical.id=NEW.source_remake_unit_id AND physical.production_state='delivered' AND physical.cancelled_at IS NULL
          AND NOT EXISTS(SELECT 1 FROM mbox.quantity_remake_units later WHERE later.tenant_id=physical.tenant_id AND later.store_id=physical.store_id AND later.unit_id=physical.unit_id AND later.generation>physical.generation))) AND unit.held_by_case_id IS NULL AND NOT unit.operationally_stopped
        AND visit.status IN ('open','closing') AND original.status<>'cancelled' AND item.status<>'cancelled'
        AND task.status IN ('pending','acknowledged','in_progress')
    ) THEN RAISE EXCEPTION 'redelivery unit is held, stopped, not originally delivered or belongs to a different visit' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER quantity_redelivery_unit_guard BEFORE INSERT OR UPDATE ON mbox.quantity_redelivery_units FOR EACH ROW EXECUTE FUNCTION mbox.guard_quantity_redelivery_unit();
CREATE TRIGGER quantity_redelivery_unit_no_delete BEFORE DELETE ON mbox.quantity_redelivery_units FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();
CREATE FUNCTION mbox.sync_quantity_redelivery_task(p_tenant uuid,p_store uuid,p_id uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE pending_count integer;done_count integer;paused_count integer;task_row mbox.service_tasks%ROWTYPE;next_status text;goods_name text;
BEGIN
  SELECT task.* INTO task_row FROM mbox.quantity_redeliveries parent JOIN mbox.service_tasks task
    ON task.tenant_id=parent.tenant_id AND task.store_id=parent.store_id AND task.id=parent.service_task_id
    WHERE parent.tenant_id=p_tenant AND parent.store_id=p_store AND parent.id=p_id FOR UPDATE OF task;
  IF NOT FOUND OR task_row.status NOT IN ('pending','acknowledged','in_progress') THEN RETURN; END IF;
  SELECT count(*) FILTER(WHERE part.outcome IS NULL),count(*) FILTER(WHERE part.outcome='delivered'),count(*) FILTER(WHERE part.outcome IS NULL AND unit.held_by_case_id IS NOT NULL)
    INTO pending_count,done_count,paused_count FROM mbox.quantity_redelivery_units part JOIN mbox.order_item_quantity_units unit
      ON unit.tenant_id=part.tenant_id AND unit.store_id=part.store_id AND unit.id=part.unit_id
    WHERE part.tenant_id=p_tenant AND part.store_id=p_store AND part.redelivery_id=p_id;
  SELECT COALESCE(item.product_snapshot->>'name','原商品') INTO goods_name FROM mbox.quantity_redeliveries parent JOIN mbox.order_items item
    ON item.tenant_id=parent.tenant_id AND item.store_id=parent.store_id AND item.id=parent.order_item_id WHERE parent.tenant_id=p_tenant AND parent.store_id=p_store AND parent.id=p_id;
  next_status:=CASE WHEN pending_count=0 THEN CASE WHEN done_count>0 THEN 'completed' ELSE 'cancelled' END
    WHEN done_count>0 THEN 'in_progress' ELSE task_row.status END;
  UPDATE mbox.service_tasks SET status=next_status,title=goods_name||'原实物补送（待'||pending_count||'份'||CASE WHEN paused_count>0 THEN '，暂停'||paused_count||'份' ELSE '' END||'）',
    completed_at=CASE WHEN next_status='completed' THEN clock_timestamp() ELSE completed_at END,
    cancelled_at=CASE WHEN next_status='cancelled' THEN clock_timestamp() ELSE cancelled_at END
    WHERE tenant_id=p_tenant AND store_id=p_store AND id=task_row.id;
  IF next_status<>task_row.status THEN
    INSERT INTO mbox.service_task_events(tenant_id,store_id,service_task_id,event_type,from_status,to_status,actor_type,note,metadata)
      VALUES(p_tenant,p_store,task_row.id,'task.redelivery_progress',task_row.status,next_status,'system','按原实物补送的逐份结果更新任务',jsonb_build_object('redeliveryId',p_id,'pending',pending_count,'delivered',done_count));
  END IF;
END $$;
CREATE FUNCTION mbox.sync_quantity_redelivery_unit_outcome() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM mbox.sync_quantity_redelivery_task(NEW.tenant_id,NEW.store_id,NEW.redelivery_id);RETURN NEW;
END $$;
CREATE TRIGGER quantity_redelivery_unit_progress AFTER UPDATE OF outcome ON mbox.quantity_redelivery_units FOR EACH ROW EXECUTE FUNCTION mbox.sync_quantity_redelivery_unit_outcome();
CREATE FUNCTION mbox.sync_quantity_redelivery_original() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_id uuid;
BEGIN
  IF NEW.operationally_stopped THEN
    UPDATE mbox.quantity_redelivery_units SET outcome='cancelled',closed_at=clock_timestamp(),close_reason='原商品已停止，取消待补送实物'
      WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND unit_id=NEW.id AND outcome IS NULL;
  END IF;
  FOR parent_id IN SELECT redelivery_id FROM mbox.quantity_redelivery_units WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND unit_id=NEW.id AND outcome IS NULL LOOP
    PERFORM mbox.sync_quantity_redelivery_task(NEW.tenant_id,NEW.store_id,parent_id);
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER quantity_redelivery_original_progress AFTER UPDATE OF held_by_case_id,stopped_by_case_id,closed_by_order_event_id,closed_by_turnover_event_id ON mbox.order_item_quantity_units FOR EACH ROW EXECUTE FUNCTION mbox.sync_quantity_redelivery_original();
CREATE FUNCTION mbox.sync_quantity_redelivery_service_end() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.task_type='goods.redelivery' AND NEW.status IN ('cancelled','expired') THEN
    UPDATE mbox.quantity_redelivery_units SET outcome='cancelled',closed_at=clock_timestamp(),close_reason='原补送任务已结束'
      WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND outcome IS NULL AND redelivery_id IN(SELECT id FROM mbox.quantity_redeliveries WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND service_task_id=NEW.id);
  ELSIF NEW.task_type='goods.redelivery' AND NEW.status='completed' AND EXISTS(SELECT 1 FROM mbox.quantity_redelivery_units part JOIN mbox.quantity_redeliveries parent
    ON parent.tenant_id=part.tenant_id AND parent.store_id=part.store_id AND parent.id=part.redelivery_id
    WHERE parent.tenant_id=NEW.tenant_id AND parent.store_id=NEW.store_id AND parent.service_task_id=NEW.id AND part.outcome IS NULL) THEN
    RAISE EXCEPTION 'pending original goods require explicit redelivery confirmation' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER quantity_redelivery_service_end AFTER UPDATE OF status ON mbox.service_tasks FOR EACH ROW EXECUTE FUNCTION mbox.sync_quantity_redelivery_service_end();
DO $redelivery_permissions$
DECLARE relation text;signature text;
BEGIN
  FOREACH relation IN ARRAY ARRAY['quantity_redeliveries','quantity_redelivery_units'] LOOP
    EXECUTE format('ALTER TABLE mbox.%I ENABLE ROW LEVEL SECURITY',relation);
    EXECUTE format('ALTER TABLE mbox.%I FORCE ROW LEVEL SECURITY',relation);
    EXECUTE format('CREATE POLICY scope_guard ON mbox.%I USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())',relation);
    EXECUTE format('GRANT SELECT,INSERT ON mbox.%I TO mbox_runtime',relation);
  END LOOP;
  FOREACH signature IN ARRAY ARRAY['mbox.guard_quantity_redelivery_parent()','mbox.guard_quantity_redelivery_unit()','mbox.sync_quantity_redelivery_task(uuid,uuid,uuid)','mbox.sync_quantity_redelivery_unit_outcome()','mbox.sync_quantity_redelivery_original()','mbox.sync_quantity_redelivery_service_end()'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',signature);
  END LOOP;
END $redelivery_permissions$;
GRANT UPDATE ON mbox.quantity_redelivery_units TO mbox_runtime;
GRANT EXECUTE ON FUNCTION mbox.sync_quantity_redelivery_task(uuid,uuid,uuid) TO mbox_runtime;


-- Physical replacement batches remain separate from the original financial unit.
-- No production API admits these rows until task, refund and closure integration
-- is accepted. Existing quantity rows and historic consumption are not rewound.
CREATE TABLE mbox.quantity_remake_batches (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,
 order_item_id uuid NOT NULL,kds_task_id uuid NOT NULL,original_kds_task_id uuid NOT NULL,
 requested_by_employee_id uuid NOT NULL,reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 2 AND 1000),
 original_goods_lost boolean NOT NULL CHECK(original_goods_lost),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,store_id,id),UNIQUE(tenant_id,store_id,kds_task_id),
 FOREIGN KEY(tenant_id,store_id,order_item_id) REFERENCES mbox.order_items(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,kds_task_id) REFERENCES mbox.kds_tasks(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,original_kds_task_id) REFERENCES mbox.kds_tasks(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,requested_by_employee_id) REFERENCES mbox.employees(tenant_id,store_id,id)
);
ALTER TABLE mbox.kds_tasks ADD COLUMN quantity_remake_batch_id uuid;
ALTER TABLE mbox.kds_tasks ADD FOREIGN KEY(tenant_id,store_id,quantity_remake_batch_id) REFERENCES mbox.quantity_remake_batches(tenant_id,store_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE UNIQUE INDEX kds_quantity_remake_batch_unique ON mbox.kds_tasks(tenant_id,store_id,quantity_remake_batch_id) WHERE quantity_remake_batch_id IS NOT NULL;
DROP INDEX mbox.kds_tasks_one_direct_remake_unique;
CREATE UNIQUE INDEX kds_tasks_one_direct_remake_unique ON mbox.kds_tasks(tenant_id,store_id,remake_of_task_id) WHERE remake_of_task_id IS NOT NULL AND quantity_remake_batch_id IS NULL;
CREATE FUNCTION mbox.guard_kds_quantity_remake_batch_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND NEW.quantity_remake_batch_id IS DISTINCT FROM OLD.quantity_remake_batch_id THEN
  RAISE EXCEPTION 'KDS physical batch identity is immutable' USING ERRCODE='23514';
 END IF;
 IF NEW.quantity_remake_batch_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM mbox.quantity_remake_batches batch WHERE batch.tenant_id=NEW.tenant_id AND batch.store_id=NEW.store_id AND batch.id=NEW.quantity_remake_batch_id AND batch.kds_task_id=NEW.id AND batch.order_item_id=NEW.order_item_id AND batch.original_kds_task_id=NEW.remake_of_task_id) THEN
  RAISE EXCEPTION 'KDS task must belong to the exact physical batch' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER kds_quantity_remake_identity AFTER INSERT OR UPDATE ON mbox.kds_tasks DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION mbox.guard_kds_quantity_remake_batch_identity();
REVOKE ALL ON FUNCTION mbox.guard_kds_quantity_remake_batch_identity() FROM PUBLIC;
CREATE TABLE mbox.quantity_remake_units (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,
 batch_id uuid NOT NULL,unit_id uuid NOT NULL,generation integer NOT NULL CHECK(generation>0),previous_remake_unit_id uuid,
 production_state text NOT NULL DEFAULT 'unmade' CHECK(production_state IN ('unmade','started','ready','delivered')),
 cancelled_at timestamptz,cancel_reason text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,store_id,id),UNIQUE(tenant_id,store_id,unit_id,generation),UNIQUE(tenant_id,store_id,previous_remake_unit_id),
 FOREIGN KEY(tenant_id,store_id,batch_id) REFERENCES mbox.quantity_remake_batches(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,unit_id) REFERENCES mbox.order_item_quantity_units(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,previous_remake_unit_id) REFERENCES mbox.quantity_remake_units(tenant_id,store_id,id),
 CHECK((generation=1)=(previous_remake_unit_id IS NULL)),
 CHECK((cancelled_at IS NULL)=(cancel_reason IS NULL)),CHECK(cancel_reason IS NULL OR length(btrim(cancel_reason))>=2)
);
CREATE INDEX quantity_remake_units_current ON mbox.quantity_remake_units(tenant_id,store_id,unit_id,generation DESC);
CREATE TABLE mbox.quantity_remake_stocks (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,
 remake_unit_id uuid NOT NULL,inventory_item_id uuid NOT NULL,quantity numeric(18,6) NOT NULL CHECK(quantity>0),
 source_original_stock_id uuid,source_remake_stock_id uuid,
 status text NOT NULL DEFAULT 'reserved' CHECK(status IN ('reserved','consumed','released','returned','used_loss')),
 consumption_movement_id uuid,return_movement_id uuid,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,remake_unit_id) REFERENCES mbox.quantity_remake_units(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,inventory_item_id) REFERENCES mbox.inventory_items(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,source_original_stock_id) REFERENCES mbox.order_item_unit_inventory(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,source_remake_stock_id) REFERENCES mbox.quantity_remake_stocks(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,consumption_movement_id) REFERENCES mbox.inventory_movements(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,return_movement_id) REFERENCES mbox.inventory_movements(tenant_id,store_id,id),
 CHECK(num_nonnulls(source_original_stock_id,source_remake_stock_id)=1),
 CHECK(status NOT IN ('consumed','returned','used_loss') OR consumption_movement_id IS NOT NULL),
 CHECK(status<>'returned' OR return_movement_id IS NOT NULL)
);
CREATE UNIQUE INDEX quantity_remake_original_stock_once ON mbox.quantity_remake_stocks(tenant_id,store_id,remake_unit_id,source_original_stock_id) WHERE source_original_stock_id IS NOT NULL;
CREATE UNIQUE INDEX quantity_remake_previous_stock_once ON mbox.quantity_remake_stocks(tenant_id,store_id,remake_unit_id,source_remake_stock_id) WHERE source_remake_stock_id IS NOT NULL;
ALTER TABLE mbox.inventory_movements ADD COLUMN quantity_remake_stock_id uuid;
ALTER TABLE mbox.inventory_movements ADD FOREIGN KEY(tenant_id,store_id,quantity_remake_stock_id) REFERENCES mbox.quantity_remake_stocks(tenant_id,store_id,id);
CREATE UNIQUE INDEX quantity_remake_consumption_once ON mbox.inventory_movements(tenant_id,store_id,quantity_remake_stock_id) WHERE quantity_remake_stock_id IS NOT NULL AND quantity_delta<0;
CREATE UNIQUE INDEX quantity_remake_return_once ON mbox.inventory_movements(tenant_id,store_id,quantity_remake_stock_id) WHERE quantity_remake_stock_id IS NOT NULL AND quantity_delta>0;
CREATE FUNCTION mbox.guard_quantity_remake_batch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM mbox.order_items item JOIN mbox.orders original ON original.tenant_id=item.tenant_id AND original.store_id=item.store_id AND original.id=item.order_id
 JOIN mbox.table_sessions visit ON visit.tenant_id=original.tenant_id AND visit.store_id=original.store_id AND visit.id=original.table_session_id
 JOIN mbox.kds_tasks task ON task.tenant_id=item.tenant_id AND task.store_id=item.store_id AND task.order_item_id=item.id
 JOIN mbox.kds_tasks source ON source.tenant_id=item.tenant_id AND source.store_id=item.store_id AND source.order_item_id=item.id
 WHERE item.tenant_id=NEW.tenant_id AND item.store_id=NEW.store_id AND item.id=NEW.order_item_id AND task.id=NEW.kds_task_id AND source.id=NEW.original_kds_task_id
 AND task.remake_of_task_id=source.id AND task.quantity_remake_batch_id=NEW.id AND task.status='pending' AND visit.status IN ('open','closing') AND original.status<>'cancelled' AND item.status<>'cancelled')
 THEN RAISE EXCEPTION 'remake must have its own pending task for the original active goods' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER quantity_remake_batch_source BEFORE INSERT ON mbox.quantity_remake_batches FOR EACH ROW EXECUTE FUNCTION mbox.guard_quantity_remake_batch();
CREATE TRIGGER quantity_remake_batch_immutable BEFORE UPDATE OR DELETE ON mbox.quantity_remake_batches FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();
CREATE FUNCTION mbox.guard_quantity_remake_unit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE latest mbox.quantity_remake_units%ROWTYPE;
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.production_state<>'unmade' OR NEW.cancelled_at IS NOT NULL THEN RAISE EXCEPTION 'new physical batch starts unmade' USING ERRCODE='23514';END IF;
  SELECT * INTO latest FROM mbox.quantity_remake_units WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND unit_id=NEW.unit_id ORDER BY generation DESC LIMIT 1;
  IF (latest.id IS NULL AND NEW.generation<>1) OR (latest.id IS NOT NULL AND (NEW.previous_remake_unit_id IS DISTINCT FROM latest.id OR NEW.generation<>latest.generation+1 OR latest.cancelled_at IS NULL AND latest.production_state<>'delivered')) THEN
   RAISE EXCEPTION 'remake must follow the last terminal physical batch, without forks' USING ERRCODE='23514';END IF;
  IF NOT EXISTS(SELECT 1 FROM mbox.quantity_remake_batches batch JOIN mbox.order_item_quantity_units unit ON unit.tenant_id=batch.tenant_id AND unit.store_id=batch.store_id AND unit.order_item_id=batch.order_item_id
   WHERE batch.tenant_id=NEW.tenant_id AND batch.store_id=NEW.store_id AND batch.id=NEW.batch_id AND unit.id=NEW.unit_id
   AND unit.production_state<>'unmade' AND unit.held_by_case_id IS NULL AND NOT unit.operationally_stopped
   AND NOT EXISTS(SELECT 1 FROM mbox.quantity_redelivery_units delivery WHERE delivery.tenant_id=unit.tenant_id AND delivery.store_id=unit.store_id AND delivery.unit_id=unit.id AND delivery.outcome IS NULL)) THEN
   RAISE EXCEPTION 'original unit is unmade, held, stopped or already pending physical redelivery' USING ERRCODE='23514';END IF;
 ELSE
  IF (NEW.id,NEW.tenant_id,NEW.store_id,NEW.batch_id,NEW.unit_id,NEW.generation,NEW.previous_remake_unit_id,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.store_id,OLD.batch_id,OLD.unit_id,OLD.generation,OLD.previous_remake_unit_id,OLD.created_at)
   OR array_position(ARRAY['unmade','started','ready','delivered'],NEW.production_state)<array_position(ARRAY['unmade','started','ready','delivered'],OLD.production_state)
   OR OLD.cancelled_at IS NOT NULL AND (NEW.cancelled_at,NEW.cancel_reason,NEW.production_state) IS DISTINCT FROM(OLD.cancelled_at,OLD.cancel_reason,OLD.production_state) THEN
   RAISE EXCEPTION 'physical batch identity and recorded history are immutable' USING ERRCODE='23514';END IF;
  IF NEW.production_state<>OLD.production_state THEN
   IF NEW.cancelled_at IS NOT NULL OR NOT EXISTS(SELECT 1 FROM mbox.order_item_quantity_units unit JOIN mbox.order_items item
    ON item.tenant_id=unit.tenant_id AND item.store_id=unit.store_id AND item.id=unit.order_item_id
    JOIN mbox.orders original ON original.tenant_id=item.tenant_id AND original.store_id=item.store_id AND original.id=item.order_id
    JOIN mbox.table_sessions visit ON visit.tenant_id=original.tenant_id AND visit.store_id=original.store_id AND visit.id=original.table_session_id
    WHERE unit.tenant_id=NEW.tenant_id AND unit.store_id=NEW.store_id AND unit.id=NEW.unit_id
     AND unit.held_by_case_id IS NULL AND NOT unit.operationally_stopped AND unit.inventory_evidence_state<>'unresolved'
     AND item.status<>'cancelled' AND original.status<>'cancelled' AND visit.status IN ('open','closing'))
    OR EXISTS(SELECT 1 FROM mbox.quantity_remake_units later WHERE later.tenant_id=NEW.tenant_id AND later.store_id=NEW.store_id AND later.unit_id=NEW.unit_id AND later.generation>NEW.generation)
    OR EXISTS(SELECT 1 FROM mbox.quantity_remake_stocks stock WHERE stock.tenant_id=NEW.tenant_id AND stock.store_id=NEW.store_id AND stock.remake_unit_id=NEW.id AND stock.status<>'consumed')
    OR EXISTS(SELECT inventory_item_id FROM (
      SELECT inventory_item_id,-quantity AS amount FROM mbox.order_item_unit_inventory WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND unit_id=NEW.unit_id
      UNION ALL SELECT inventory_item_id,quantity AS amount FROM mbox.quantity_remake_stocks WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND remake_unit_id=NEW.id
     ) materials GROUP BY inventory_item_id HAVING sum(amount)<>0) THEN
     RAISE EXCEPTION 'physical remake cannot advance without active original goods and exact consumed materials' USING ERRCODE='23514';END IF;
  END IF;
  IF NEW.cancelled_at IS NOT NULL AND OLD.cancelled_at IS NULL AND EXISTS(SELECT 1 FROM mbox.quantity_remake_stocks stock WHERE stock.tenant_id=NEW.tenant_id AND stock.store_id=NEW.store_id AND stock.remake_unit_id=NEW.id AND stock.status IN ('reserved','consumed')) THEN
   RAISE EXCEPTION 'finish actual remake material disposition before closing its physical unit' USING ERRCODE='23514';END IF;

 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER quantity_remake_unit_guard BEFORE INSERT OR UPDATE ON mbox.quantity_remake_units FOR EACH ROW EXECUTE FUNCTION mbox.guard_quantity_remake_unit();
CREATE TRIGGER quantity_remake_unit_no_delete BEFORE DELETE ON mbox.quantity_remake_units FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();
CREATE FUNCTION mbox.guard_quantity_remake_stock() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_quantity numeric;source_inventory uuid;source_unit uuid;original_unit uuid;
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.status<>'reserved' OR NEW.consumption_movement_id IS NOT NULL OR NEW.return_movement_id IS NOT NULL THEN RAISE EXCEPTION 'remake stock starts with new reserved materials' USING ERRCODE='23514';END IF;
  SELECT unit_id INTO original_unit FROM mbox.quantity_remake_units WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=NEW.remake_unit_id;
  IF NEW.source_original_stock_id IS NOT NULL THEN
   SELECT quantity,inventory_item_id,unit_id INTO source_quantity,source_inventory,source_unit FROM mbox.order_item_unit_inventory
   WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=NEW.source_original_stock_id AND status IN ('consumed','used_loss');
  ELSE
   SELECT stock.quantity,stock.inventory_item_id,unit.unit_id INTO source_quantity,source_inventory,source_unit FROM mbox.quantity_remake_stocks stock JOIN mbox.quantity_remake_units unit
    ON unit.tenant_id=stock.tenant_id AND unit.store_id=stock.store_id AND unit.id=stock.remake_unit_id
   WHERE stock.tenant_id=NEW.tenant_id AND stock.store_id=NEW.store_id AND stock.id=NEW.source_remake_stock_id AND stock.status IN ('consumed','used_loss');
  END IF;
  IF source_quantity IS NULL OR (source_quantity,source_inventory,source_unit) IS DISTINCT FROM(NEW.quantity,NEW.inventory_item_id,original_unit) THEN
   RAISE EXCEPTION 'new materials must match the exact previously consumed physical share' USING ERRCODE='23514';END IF;
 ELSE
  IF (NEW.id,NEW.tenant_id,NEW.store_id,NEW.remake_unit_id,NEW.inventory_item_id,NEW.quantity,NEW.source_original_stock_id,NEW.source_remake_stock_id,NEW.created_at)
   IS DISTINCT FROM(OLD.id,OLD.tenant_id,OLD.store_id,OLD.remake_unit_id,OLD.inventory_item_id,OLD.quantity,OLD.source_original_stock_id,OLD.source_remake_stock_id,OLD.created_at)
   OR NEW.status<>OLD.status AND NOT(OLD.status='reserved' AND NEW.status IN ('consumed','released') OR OLD.status='consumed' AND NEW.status IN ('returned','used_loss')) THEN
   RAISE EXCEPTION 'remake material source and terminal outcome cannot be rewritten' USING ERRCODE='23514';END IF;
  IF OLD.consumption_movement_id IS NOT NULL AND NEW.consumption_movement_id IS DISTINCT FROM OLD.consumption_movement_id OR OLD.return_movement_id IS NOT NULL AND NEW.return_movement_id IS DISTINCT FROM OLD.return_movement_id THEN
   RAISE EXCEPTION 'physical batch movement identity cannot be rewritten' USING ERRCODE='23514';END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER quantity_remake_stock_guard BEFORE INSERT OR UPDATE ON mbox.quantity_remake_stocks FOR EACH ROW EXECUTE FUNCTION mbox.guard_quantity_remake_stock();
CREATE TRIGGER quantity_remake_stock_no_delete BEFORE DELETE ON mbox.quantity_remake_stocks FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();
DO $$ DECLARE relation text;signature text;BEGIN
 FOREACH relation IN ARRAY ARRAY['quantity_remake_batches','quantity_remake_units','quantity_remake_stocks'] LOOP
  EXECUTE format('ALTER TABLE mbox.%I ENABLE ROW LEVEL SECURITY',relation);EXECUTE format('ALTER TABLE mbox.%I FORCE ROW LEVEL SECURITY',relation);
  EXECUTE format('CREATE POLICY store_scope ON mbox.%I USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())',relation);
  EXECUTE format('GRANT SELECT,INSERT ON mbox.%I TO mbox_runtime',relation);
 END LOOP;
 FOREACH signature IN ARRAY ARRAY['mbox.guard_quantity_remake_batch()','mbox.guard_quantity_remake_unit()','mbox.guard_quantity_remake_stock()'] LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||signature||' FROM PUBLIC';END LOOP;
END $$;
GRANT UPDATE ON mbox.quantity_remake_units,mbox.quantity_remake_stocks TO mbox_runtime;

CREATE OR REPLACE FUNCTION mbox.guard_quantity_inventory_movement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE unit_item uuid;
BEGIN
  IF NEW.quantity_remake_stock_id IS NOT NULL THEN
    IF NEW.quantity_unit_id IS NOT NULL OR NOT EXISTS(SELECT 1 FROM mbox.quantity_remake_stocks stock JOIN mbox.quantity_remake_units part
      ON part.tenant_id=stock.tenant_id AND part.store_id=stock.store_id AND part.id=stock.remake_unit_id
      JOIN mbox.quantity_remake_batches batch ON batch.tenant_id=part.tenant_id AND batch.store_id=part.store_id AND batch.id=part.batch_id
      WHERE stock.tenant_id=NEW.tenant_id AND stock.store_id=NEW.store_id AND stock.id=NEW.quantity_remake_stock_id
      AND batch.order_item_id=NEW.order_item_id AND stock.inventory_item_id=NEW.inventory_item_id AND stock.quantity=abs(NEW.quantity_delta)
      AND ((NEW.movement_type='waste' AND NEW.quantity_delta<0 AND stock.status='reserved') OR (NEW.movement_type='return' AND NEW.quantity_delta>0 AND stock.status='consumed')))
    THEN RAISE EXCEPTION 'remake movement must match the separate available physical batch' USING ERRCODE='23514';END IF;
    RETURN NEW;
  END IF;
  IF NEW.quantity_unit_id IS NOT NULL THEN
    SELECT order_item_id INTO unit_item FROM mbox.order_item_quantity_units WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=NEW.quantity_unit_id;
    IF unit_item IS DISTINCT FROM NEW.order_item_id OR unit_item IS NULL OR NEW.movement_type NOT IN ('sale','return') THEN
      RAISE EXCEPTION 'quantity movement must retain original order item' USING ERRCODE='23514';
    END IF;
    IF NOT EXISTS(SELECT 1 FROM mbox.order_item_unit_inventory stock WHERE stock.tenant_id=NEW.tenant_id AND stock.store_id=NEW.store_id
      AND stock.unit_id=NEW.quantity_unit_id AND stock.inventory_item_id=NEW.inventory_item_id AND stock.quantity=abs(NEW.quantity_delta)
      AND ((NEW.movement_type='sale' AND stock.status='reserved' AND NEW.quantity_delta<0) OR
           (NEW.movement_type='return' AND stock.status='consumed' AND NEW.quantity_delta>0))) THEN
      RAISE EXCEPTION 'quantity movement must match the original available inventory share' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.movement_type IN ('sale','return') AND EXISTS(
    SELECT 1 FROM mbox.order_item_quantity_units unit WHERE unit.tenant_id=NEW.tenant_id AND unit.store_id=NEW.store_id
      AND unit.order_item_id=NEW.order_item_id AND unit.inventory_evidence_state='allocated'
  ) THEN
    RAISE EXCEPTION 'quantity inventory requires exact units; whole line movement refused' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
ALTER TABLE mbox.quantity_remake_stocks ADD CHECK(status NOT IN ('reserved','released') OR consumption_movement_id IS NULL);
ALTER TABLE mbox.quantity_remake_stocks ADD CHECK(status='returned' OR return_movement_id IS NULL);
ALTER TABLE mbox.quantity_redelivery_units ADD COLUMN source_remake_unit_id uuid;
ALTER TABLE mbox.quantity_redelivery_units ADD FOREIGN KEY(tenant_id,store_id,source_remake_unit_id) REFERENCES mbox.quantity_remake_units(tenant_id,store_id,id);
CREATE FUNCTION mbox.end_redelivery_for_remake_physical_disposition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.cancelled_at IS NOT NULL AND OLD.cancelled_at IS NULL THEN
  UPDATE mbox.quantity_redelivery_units SET outcome='cancelled',closed_at=clock_timestamp(),close_reason='对应的新批实物已另行处置，本次补送结束'
   WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND source_remake_unit_id=NEW.id AND outcome IS NULL;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER remake_disposition_ends_redelivery AFTER UPDATE OF cancelled_at ON mbox.quantity_remake_units FOR EACH ROW EXECUTE FUNCTION mbox.end_redelivery_for_remake_physical_disposition();
REVOKE ALL ON FUNCTION mbox.end_redelivery_for_remake_physical_disposition() FROM PUBLIC;
CREATE TABLE mbox.delivery_batch_remake_units (
 tenant_id uuid NOT NULL,store_id uuid NOT NULL,batch_id uuid NOT NULL,kds_task_id uuid NOT NULL,remake_unit_id uuid NOT NULL,
 PRIMARY KEY(tenant_id,store_id,remake_unit_id),
 FOREIGN KEY(tenant_id,store_id,batch_id,kds_task_id) REFERENCES mbox.delivery_batch_items(tenant_id,store_id,batch_id,kds_task_id),
 FOREIGN KEY(tenant_id,store_id,remake_unit_id) REFERENCES mbox.quantity_remake_units(tenant_id,store_id,id)
);
CREATE FUNCTION mbox.validate_delivery_remake_unit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM mbox.quantity_remake_units part JOIN mbox.quantity_remake_batches batch
  ON batch.tenant_id=part.tenant_id AND batch.store_id=part.store_id AND batch.id=part.batch_id
  JOIN mbox.order_item_quantity_units original ON original.tenant_id=part.tenant_id AND original.store_id=part.store_id AND original.id=part.unit_id
  WHERE part.tenant_id=NEW.tenant_id AND part.store_id=NEW.store_id AND part.id=NEW.remake_unit_id AND batch.kds_task_id=NEW.kds_task_id
    AND part.production_state='ready' AND part.cancelled_at IS NULL AND original.held_by_case_id IS NULL AND NOT original.operationally_stopped
    AND NOT EXISTS(SELECT 1 FROM mbox.quantity_remake_units later WHERE later.tenant_id=part.tenant_id AND later.store_id=part.store_id AND later.unit_id=part.unit_id AND later.generation>part.generation)) THEN
  RAISE EXCEPTION 'delivery slip must use the actual ready unheld remake physical units' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER delivery_remake_source BEFORE INSERT ON mbox.delivery_batch_remake_units FOR EACH ROW EXECUTE FUNCTION mbox.validate_delivery_remake_unit();
CREATE TRIGGER delivery_remake_immutable BEFORE UPDATE OR DELETE ON mbox.delivery_batch_remake_units FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();
ALTER TABLE mbox.delivery_batch_remake_units ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.delivery_batch_remake_units FORCE ROW LEVEL SECURITY;
CREATE POLICY store_scope ON mbox.delivery_batch_remake_units USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
GRANT SELECT,INSERT ON mbox.delivery_batch_remake_units TO mbox_runtime;
REVOKE ALL ON FUNCTION mbox.validate_delivery_remake_unit() FROM PUBLIC;

-- Stopping the original financial share requires every actual replacement to
-- have its own material disposition; a refund cannot erase a reserved new batch.
CREATE FUNCTION mbox.guard_quantity_stop_remake_materials() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.production_state IS DISTINCT FROM OLD.production_state AND EXISTS(SELECT 1 FROM mbox.quantity_remake_units part
    WHERE part.tenant_id=NEW.tenant_id AND part.store_id=NEW.store_id AND part.unit_id=NEW.id) THEN
    RAISE EXCEPTION 'original physical history cannot advance after remake' USING ERRCODE='23514';
  END IF;
  IF NEW.stopped_by_case_id IS NOT NULL AND NEW.stopped_by_case_id IS DISTINCT FROM OLD.stopped_by_case_id
    AND EXISTS(SELECT 1 FROM mbox.quantity_remake_units part WHERE part.tenant_id=NEW.tenant_id AND part.store_id=NEW.store_id AND part.unit_id=NEW.id AND part.cancelled_at IS NULL) THEN
    RAISE EXCEPTION 'dispose actual remake materials before stopping original quantity' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER quantity_stop_remake_materials BEFORE UPDATE ON mbox.order_item_quantity_units
  FOR EACH ROW EXECUTE FUNCTION mbox.guard_quantity_stop_remake_materials();
REVOKE ALL ON FUNCTION mbox.guard_quantity_stop_remake_materials() FROM PUBLIC;


-- Closing a visit releases only unused new materials. Made physical goods stay
-- pending actual disposition; closure never invents a return or a refund.
CREATE FUNCTION mbox.retire_remake_on_visit_end() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE order_ids uuid[]; part_ids uuid[]; batch_ids uuid[]; demand record; batch_row record;
BEGIN
  IF TG_TABLE_NAME='orders' THEN
    IF NEW.status<>'cancelled' OR OLD.status=NEW.status THEN RETURN NEW; END IF;
    order_ids:=ARRAY[NEW.id];
  ELSE
    IF NEW.status<>'closed' OR OLD.status=NEW.status THEN RETURN NEW; END IF;
    SELECT array_agg(id ORDER BY id) INTO order_ids FROM mbox.orders WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND table_session_id=NEW.id;
  END IF;
  PERFORM 1 FROM mbox.orders WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=ANY(order_ids) ORDER BY id FOR UPDATE;
  SELECT array_agg(DISTINCT batch.id) INTO batch_ids FROM mbox.quantity_remake_batches batch JOIN mbox.order_items item
    ON item.tenant_id=batch.tenant_id AND item.store_id=batch.store_id AND item.id=batch.order_item_id
    WHERE batch.tenant_id=NEW.tenant_id AND batch.store_id=NEW.store_id AND item.order_id=ANY(order_ids);
  IF COALESCE(cardinality(batch_ids),0)=0 THEN RETURN NEW; END IF;
  PERFORM 1 FROM mbox.quantity_remake_units WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND batch_id=ANY(batch_ids) ORDER BY id FOR UPDATE;
  SELECT array_agg(id ORDER BY id) INTO part_ids FROM mbox.quantity_remake_units
    WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND batch_id=ANY(batch_ids) AND production_state='unmade' AND cancelled_at IS NULL;
  PERFORM 1 FROM mbox.inventory_balances balance WHERE balance.tenant_id=NEW.tenant_id AND balance.store_id=NEW.store_id AND balance.inventory_item_id IN(
    SELECT stock.inventory_item_id FROM mbox.quantity_remake_stocks stock WHERE stock.tenant_id=NEW.tenant_id AND stock.store_id=NEW.store_id AND stock.remake_unit_id=ANY(part_ids)) ORDER BY balance.inventory_item_id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM mbox.quantity_remake_stocks WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND remake_unit_id=ANY(part_ids) AND status NOT IN ('reserved','released')) THEN
    RAISE EXCEPTION 'unmade remake has inconsistent consumed materials' USING ERRCODE='23514';
  END IF;
  FOR demand IN SELECT inventory_item_id,sum(quantity) AS quantity FROM mbox.quantity_remake_stocks
    WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND remake_unit_id=ANY(part_ids) AND status='reserved' GROUP BY inventory_item_id ORDER BY inventory_item_id LOOP
    UPDATE mbox.inventory_balances SET reserved_quantity=reserved_quantity-demand.quantity,updated_at=clock_timestamp()
      WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND inventory_item_id=demand.inventory_item_id AND reserved_quantity>=demand.quantity;
    IF NOT FOUND THEN RAISE EXCEPTION 'remake remaining reservation is inconsistent' USING ERRCODE='23514'; END IF;
  END LOOP;
  UPDATE mbox.quantity_remake_stocks SET status='released',updated_at=clock_timestamp() WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND remake_unit_id=ANY(part_ids) AND status='reserved';
  UPDATE mbox.quantity_remake_units SET cancelled_at=clock_timestamp(),cancel_reason='原订单或桌次已结束，仅释放本批尚未使用的材料',updated_at=clock_timestamp()
    WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=ANY(part_ids);
  FOR batch_row IN SELECT batch.id,task.id AS task_id,task.status FROM mbox.quantity_remake_batches batch JOIN mbox.kds_tasks task
    ON task.tenant_id=batch.tenant_id AND task.store_id=batch.store_id AND task.id=batch.kds_task_id
    WHERE batch.tenant_id=NEW.tenant_id AND batch.store_id=NEW.store_id AND batch.id=ANY(batch_ids) ORDER BY task.id FOR UPDATE OF task LOOP
    INSERT INTO mbox.kds_task_events(tenant_id,store_id,kds_task_id,event_type,from_status,to_status,metadata,idempotency_key)
      VALUES(NEW.tenant_id,NEW.store_id,batch_row.task_id,'task.remake_visit_ended',batch_row.status,'cancelled',jsonb_build_object('remakeBatchId',batch_row.id,'unusedMaterialsReleased',true,'madeGoods','pending_actual_disposition'),'remake-visit-ended:'||batch_row.id::text) ON CONFLICT DO NOTHING;
    UPDATE mbox.kds_tasks SET status='cancelled',cancelled_at=COALESCE(cancelled_at,clock_timestamp()),worker_locked_by=NULL,worker_locked_at=NULL,updated_at=clock_timestamp()
      WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=batch_row.task_id AND status NOT IN ('cancelled','failed');
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER order_remake_visit_end AFTER UPDATE OF status ON mbox.orders FOR EACH ROW EXECUTE FUNCTION mbox.retire_remake_on_visit_end();
CREATE TRIGGER session_remake_visit_end AFTER UPDATE OF status ON mbox.table_sessions FOR EACH ROW EXECUTE FUNCTION mbox.retire_remake_on_visit_end();
REVOKE ALL ON FUNCTION mbox.retire_remake_on_visit_end() FROM PUBLIC;


CREATE FUNCTION mbox.quantity_unit_has_delivery(p_tenant uuid,p_store uuid,p_unit uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM mbox.order_item_quantity_units original WHERE original.tenant_id=p_tenant AND original.store_id=p_store AND original.id=p_unit AND original.production_state='delivered')
  OR EXISTS(SELECT 1 FROM mbox.quantity_remake_units part WHERE part.tenant_id=p_tenant AND part.store_id=p_store AND part.unit_id=p_unit AND part.production_state='delivered')
$$;
REVOKE ALL ON FUNCTION mbox.quantity_unit_has_delivery(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mbox.quantity_unit_has_delivery(uuid,uuid,uuid) TO mbox_runtime;

-- A new physical remake has its own work. Its completion must not release
-- the original item's still-active production reservation.
CREATE OR REPLACE FUNCTION mbox.release_kds_terminal_fulfillment_capacity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.quantity_remake_batch_id IS NOT NULL THEN RETURN NEW; END IF;
  UPDATE mbox.fulfillment_capacity_reservations
  SET status='released', expires_at=NULL, activated_at=NULL,
    released_at=clock_timestamp(), release_reason='kds:' || NEW.status,
    updated_at=clock_timestamp()
  WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id
    AND order_item_id=NEW.order_item_id AND status='active';
  RETURN NEW;
END $$;

-- Record the immediate remake workload against the already configured window.
-- This never rejects an authorized remedy because the window is full; new
-- sales continue using their existing capacity policy including this workload.
CREATE TABLE mbox.quantity_remake_capacity (
 tenant_id uuid NOT NULL,store_id uuid NOT NULL,batch_id uuid NOT NULL,
 policy_version_id uuid NOT NULL,capacity_window_id uuid NOT NULL,
 units_per_portion integer NOT NULL CHECK(units_per_portion BETWEEN 1 AND 1000),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,store_id,batch_id),
 FOREIGN KEY(tenant_id,store_id,batch_id) REFERENCES mbox.quantity_remake_batches(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,policy_version_id,capacity_window_id) REFERENCES mbox.fulfillment_capacity_windows(tenant_id,store_id,policy_version_id,id)
);
CREATE INDEX quantity_remake_capacity_window ON mbox.quantity_remake_capacity(tenant_id,store_id,capacity_window_id);
CREATE TRIGGER quantity_remake_capacity_immutable BEFORE UPDATE OR DELETE ON mbox.quantity_remake_capacity FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();
ALTER TABLE mbox.quantity_remake_capacity ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.quantity_remake_capacity FORCE ROW LEVEL SECURITY;
CREATE POLICY scope_guard ON mbox.quantity_remake_capacity USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
GRANT SELECT,INSERT ON mbox.quantity_remake_capacity TO mbox_runtime;
CREATE FUNCTION mbox.guard_quantity_remake_capacity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM mbox.quantity_remake_batches batch
  JOIN mbox.order_items item ON item.tenant_id=batch.tenant_id AND item.store_id=batch.store_id AND item.id=batch.order_item_id
  JOIN mbox.products product ON product.tenant_id=item.tenant_id AND product.store_id=item.store_id AND product.id=item.product_id
  JOIN mbox.fulfillment_capacity_policy_versions policy ON policy.tenant_id=batch.tenant_id AND policy.store_id=batch.store_id AND policy.id=NEW.policy_version_id
  JOIN mbox.fulfillment_capacity_windows window_row ON window_row.tenant_id=policy.tenant_id AND window_row.store_id=policy.store_id AND window_row.policy_version_id=policy.id AND window_row.id=NEW.capacity_window_id
  LEFT JOIN mbox.fulfillment_capacity_reservations original ON original.tenant_id=item.tenant_id AND original.store_id=item.store_id AND original.order_item_id=item.id
  WHERE batch.tenant_id=NEW.tenant_id AND batch.store_id=NEW.store_id AND batch.id=NEW.batch_id
   AND policy.station_code=item.fulfillment_station AND policy.status='published'
   AND batch.created_at>=window_row.starts_at AND batch.created_at<window_row.ends_at
   AND NEW.units_per_portion=CASE WHEN original.capacity_units IS NOT NULL AND mod(original.capacity_units,item.quantity)=0 THEN original.capacity_units/item.quantity ELSE product.capacity_units END)
 THEN RAISE EXCEPTION 'remake capacity must match actual batch station window and original portion units' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER quantity_remake_capacity_guard BEFORE INSERT ON mbox.quantity_remake_capacity FOR EACH ROW EXECUTE FUNCTION mbox.guard_quantity_remake_capacity();
CREATE FUNCTION mbox.capture_quantity_remake_capacity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE selected record;
BEGIN
 SELECT policy.id AS policy_id,window_row.id AS window_id,
  CASE WHEN original.capacity_units IS NOT NULL AND mod(original.capacity_units,item.quantity)=0 THEN original.capacity_units/item.quantity ELSE product.capacity_units END AS units
 INTO selected FROM mbox.order_items item
 JOIN mbox.products product ON product.tenant_id=item.tenant_id AND product.store_id=item.store_id AND product.id=item.product_id
 JOIN mbox.fulfillment_capacity_policy_versions policy ON policy.tenant_id=item.tenant_id AND policy.store_id=item.store_id AND policy.station_code=item.fulfillment_station AND policy.status='published'
 JOIN mbox.fulfillment_capacity_windows window_row ON window_row.tenant_id=policy.tenant_id AND window_row.store_id=policy.store_id AND window_row.policy_version_id=policy.id
 LEFT JOIN mbox.fulfillment_capacity_reservations original ON original.tenant_id=item.tenant_id AND original.store_id=item.store_id AND original.order_item_id=item.id
 WHERE item.tenant_id=NEW.tenant_id AND item.store_id=NEW.store_id AND item.id=NEW.order_item_id
  AND NEW.created_at>=window_row.starts_at AND NEW.created_at<window_row.ends_at
 FOR UPDATE OF window_row;
 IF FOUND THEN INSERT INTO mbox.quantity_remake_capacity(tenant_id,store_id,batch_id,policy_version_id,capacity_window_id,units_per_portion)
  VALUES(NEW.tenant_id,NEW.store_id,NEW.id,selected.policy_id,selected.window_id,selected.units); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER quantity_remake_capture_capacity AFTER INSERT ON mbox.quantity_remake_batches FOR EACH ROW EXECUTE FUNCTION mbox.capture_quantity_remake_capacity();
CREATE FUNCTION mbox.remake_window_used_units(p_tenant uuid,p_store uuid,p_window uuid)
RETURNS bigint LANGUAGE sql STABLE AS $$
 SELECT COALESCE(sum(usage.units_per_portion),0)::bigint FROM mbox.quantity_remake_capacity usage
 JOIN mbox.quantity_remake_units part ON part.tenant_id=usage.tenant_id AND part.store_id=usage.store_id AND part.batch_id=usage.batch_id
 WHERE usage.tenant_id=p_tenant AND usage.store_id=p_store AND usage.capacity_window_id=p_window
  AND part.cancelled_at IS NULL AND part.production_state IN ('unmade','started')
$$;
REVOKE ALL ON FUNCTION mbox.guard_quantity_remake_capacity(),mbox.capture_quantity_remake_capacity(),mbox.remake_window_used_units(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mbox.remake_window_used_units(uuid,uuid,uuid) TO mbox_runtime;
-- Lost original physical portions no longer occupy original production slots.
CREATE OR REPLACE FUNCTION mbox.item_remaining_capacity_units(p_tenant uuid,p_store uuid,p_item uuid,p_original integer)
RETURNS integer LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN quantities.total=item.quantity AND mod(p_original,item.quantity)=0
  THEN (p_original/item.quantity)*quantities.remaining ELSE p_original END
 FROM mbox.order_items item CROSS JOIN LATERAL(
  SELECT count(*)::integer AS total,count(*) FILTER(WHERE NOT unit.operationally_stopped AND unit.production_state IN ('unmade','started')
   AND NOT EXISTS(SELECT 1 FROM mbox.quantity_remake_units physical WHERE physical.tenant_id=unit.tenant_id AND physical.store_id=unit.store_id AND physical.unit_id=unit.id))::integer AS remaining
  FROM mbox.order_item_quantity_units unit WHERE unit.tenant_id=item.tenant_id AND unit.store_id=item.store_id AND unit.order_item_id=item.id
 ) quantities WHERE item.tenant_id=p_tenant AND item.store_id=p_store AND item.id=p_item
$$;
DO $remake_load$ DECLARE definition text;needle text; BEGIN
 definition:=pg_get_functiondef('mbox.validate_fulfillment_capacity_reservation()'::regprocedure);
 needle:='IF used_units + NEW.capacity_units > window_limit THEN';
 IF position(needle IN definition)=0 THEN RAISE EXCEPTION 'capacity validation source changed'; END IF;
 EXECUTE replace(definition,needle,'IF used_units + mbox.remake_window_used_units(NEW.tenant_id,NEW.store_id,NEW.capacity_window_id) + NEW.capacity_units > window_limit THEN');
 definition:=pg_get_functiondef('mbox.reserve_order_fulfillment_capacity(uuid,uuid,uuid)'::regprocedure);
 needle:='IF used_units + required_units > window_row.capacity_limit_units THEN';
 IF position(needle IN definition)=0 THEN RAISE EXCEPTION 'capacity reservation source changed'; END IF;
 EXECUTE replace(definition,needle,'IF used_units + mbox.remake_window_used_units(p_tenant_id,p_store_id,window_row.id) + required_units > window_row.capacity_limit_units THEN');
END $remake_load$;

-- A closed attempt may later carry a verified receipt for the old full amount.
-- Keep every existing signal except this order-level comparison; only actual
-- successful refunds remove an excess, not approval or a quantity stock return.
DO $quantity_overcollection$ DECLARE definition text; BEGIN
  definition:=rtrim(pg_get_viewdef('mbox.payment_financial_monitoring_signals'::regclass,true),E';\n ');
  EXECUTE 'CREATE OR REPLACE VIEW mbox.payment_financial_monitoring_signals WITH(security_invoker=true) AS
    SELECT * FROM ('||definition||') original WHERE signal<>''order_overcollected''
    UNION ALL SELECT original.tenant_id,original.store_id,original.id AS subject_id,
      ''order_overcollected''::text AS signal,max(payment.succeeded_at) AS observed_at
    FROM mbox.orders original JOIN mbox.order_payment_facts payment
      ON payment.tenant_id=original.tenant_id AND payment.store_id=original.store_id AND payment.order_id=original.id
    WHERE payment.status IN (''succeeded'',''partially_refunded'',''refunded'')
    GROUP BY original.tenant_id,original.store_id,original.id
    HAVING sum(payment.amount_minor-COALESCE((SELECT sum(refund.amount_minor)
      FROM mbox.refunds refund WHERE refund.tenant_id=payment.tenant_id AND refund.store_id=payment.store_id
        AND refund.payment_id=payment.id AND (refund.order_id IS NULL OR refund.order_id=payment.order_id)
        AND refund.status=''succeeded''),0))>original.total_amount_minor-COALESCE((SELECT sum(waiver.amount_minor)
          FROM mbox.item_receivable_adjustments waiver WHERE waiver.tenant_id=original.tenant_id
            AND waiver.store_id=original.store_id AND waiver.order_id=original.id),0)';
END $quantity_overcollection$;

COMMIT;
