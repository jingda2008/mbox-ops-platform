BEGIN;

-- A historical ordinary refund remains a real refund. Once its explicitly
-- authorized debt has been collected, append an item-bound restoration fact;
-- never rewrite cash, the refund, or the original recommendation sale.
CREATE TABLE mbox.order_recollection_item_restorations (
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  order_id uuid NOT NULL,
  refund_id uuid NOT NULL,
  order_item_id uuid NOT NULL,
  recollection_payment_id uuid NOT NULL,
  reconciliation_entry_id uuid NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor>0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  settled_at timestamptz NOT NULL,
  ledger_occurred_at timestamptz NOT NULL,
  restored_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_ref text NOT NULL CHECK (length(btrim(actor_ref)) BETWEEN 2 AND 128),
  PRIMARY KEY (tenant_id,store_id,order_id,refund_id,order_item_id),
  FOREIGN KEY (tenant_id,store_id,order_id,refund_id)
    REFERENCES mbox.order_recollection_refund_obligations(tenant_id,store_id,order_id,refund_id),
  FOREIGN KEY (tenant_id,store_id,order_id,order_item_id)
    REFERENCES mbox.order_items(tenant_id,store_id,order_id,id),
  FOREIGN KEY (tenant_id,store_id,refund_id,order_item_id)
    REFERENCES mbox.refund_items(tenant_id,store_id,refund_id,order_item_id),
  FOREIGN KEY (tenant_id,store_id,recollection_payment_id)
    REFERENCES mbox.payments(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,reconciliation_entry_id)
    REFERENCES mbox.reconciliation_entries(tenant_id,store_id,id)
);
ALTER TABLE mbox.order_recollection_item_restorations ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.order_recollection_item_restorations FORCE ROW LEVEL SECURITY;
CREATE POLICY order_recollection_item_restoration_scope ON mbox.order_recollection_item_restorations
  USING (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())
  WITH CHECK (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
CREATE TRIGGER order_recollection_item_restorations_append_only
  BEFORE UPDATE OR DELETE ON mbox.order_recollection_item_restorations
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();
REVOKE ALL ON mbox.order_recollection_item_restorations FROM PUBLIC;
GRANT SELECT,INSERT ON mbox.order_recollection_item_restorations TO mbox_runtime;

CREATE FUNCTION mbox.order_recollection_item_restoration_valid(
  p_tenant uuid,p_store uuid,p_order uuid,p_refund uuid,p_item uuid,p_payment uuid
) RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER
SET search_path=pg_catalog,mbox AS $valid$
  SELECT p_tenant=mbox.current_tenant_id() AND p_store=mbox.current_store_id() AND EXISTS (
    SELECT 1 FROM mbox.order_recollection_refund_obligations obligation
    JOIN mbox.refunds refund ON (refund.tenant_id,refund.store_id,refund.id)
      =(obligation.tenant_id,obligation.store_id,obligation.refund_id)
      AND refund.status='succeeded' AND refund.purpose IS DISTINCT FROM 'service_compensation'
    JOIN mbox.refund_items item ON (item.tenant_id,item.store_id,item.refund_id)
      =(refund.tenant_id,refund.store_id,refund.id)
      AND item.order_item_id=p_item AND item.amount_minor>0 AND item.currency=refund.currency
    JOIN mbox.order_items original_item ON (original_item.tenant_id,original_item.store_id,original_item.order_id,original_item.id)
      =(item.tenant_id,item.store_id,obligation.order_id,item.order_item_id)
      AND original_item.currency=item.currency
    JOIN mbox.order_recollection_authorizations approval
      ON (approval.tenant_id,approval.store_id,approval.id,approval.order_id)
        =(obligation.tenant_id,obligation.store_id,obligation.authorization_id,obligation.order_id)
    JOIN mbox.order_payment_facts receipt ON (receipt.tenant_id,receipt.store_id,receipt.order_id)
      =(obligation.tenant_id,obligation.store_id,obligation.order_id)
      AND receipt.id=p_payment AND receipt.amount_minor>0 AND receipt.currency=item.currency
      AND receipt.status IN ('succeeded','partially_refunded','refunded')
      AND receipt.succeeded_at>=refund.completed_at AND receipt.succeeded_at>=approval.created_at
    JOIN mbox.payments payment ON (payment.tenant_id,payment.store_id,payment.id)
      =(receipt.tenant_id,receipt.store_id,receipt.id)
    WHERE (obligation.tenant_id,obligation.store_id,obligation.order_id,obligation.refund_id)
      =(p_tenant,p_store,p_order,p_refund)
      AND NOT EXISTS (SELECT 1 FROM mbox.item_after_sales_case_refunds quantity_refund
        WHERE (quantity_refund.tenant_id,quantity_refund.store_id,quantity_refund.refund_id)
          =(refund.tenant_id,refund.store_id,refund.id))
      AND (SELECT count(*) FROM mbox.reconciliation_entries ledger
        WHERE (ledger.tenant_id,ledger.store_id,ledger.payment_id)=(payment.tenant_id,payment.store_id,payment.id)
          AND ledger.entry_type='payment' AND ledger.amount_minor=payment.amount_minor
          AND ledger.currency=payment.currency AND ledger.provider=payment.provider)=1
      -- Bind the latest locally recorded confirmed receipt. An earlier partial
      -- receipt cannot acquire a false settlement time after another receipt
      -- eventually completes the debt. Provider occurrence time can be delayed.
      AND NOT EXISTS (
        SELECT 1 FROM mbox.order_payment_facts later_receipt
        JOIN mbox.reconciliation_entries later_ledger
          ON (later_ledger.tenant_id,later_ledger.store_id,later_ledger.payment_id)
            =(later_receipt.tenant_id,later_receipt.store_id,later_receipt.id)
          AND later_ledger.entry_type='payment'
        WHERE (later_receipt.tenant_id,later_receipt.store_id,later_receipt.order_id)
            =(p_tenant,p_store,p_order)
          AND later_receipt.status IN ('succeeded','partially_refunded','refunded')
          AND later_receipt.amount_minor>0
          AND (later_ledger.created_at,later_ledger.id)>(
            SELECT ledger.created_at,ledger.id FROM mbox.reconciliation_entries ledger
            WHERE (ledger.tenant_id,ledger.store_id,ledger.payment_id)
              =(payment.tenant_id,payment.store_id,payment.id)
              AND ledger.entry_type='payment' AND ledger.amount_minor=payment.amount_minor
              AND ledger.currency=payment.currency AND ledger.provider=payment.provider
          )
      )
      AND NOT EXISTS (SELECT 1 FROM mbox.order_payment_facts pending
        WHERE (pending.tenant_id,pending.store_id,pending.order_id)=(p_tenant,p_store,p_order)
          AND (pending.status IN ('created','pending') OR EXISTS(
            SELECT 1 FROM mbox.verified_provider_observations observation
            WHERE (observation.tenant_id,observation.store_id,observation.payment_id)
              =(pending.tenant_id,pending.store_id,pending.id)
              AND observation.observed_status='payment_succeeded' AND observation.consumed_at IS NULL)))
      AND NOT EXISTS (SELECT 1 FROM mbox.order_refund_facts unresolved_refund
        JOIN mbox.verified_provider_observations observation
          ON (observation.tenant_id,observation.store_id,observation.refund_id)
            =(unresolved_refund.tenant_id,unresolved_refund.store_id,unresolved_refund.id)
        WHERE (unresolved_refund.tenant_id,unresolved_refund.store_id,unresolved_refund.order_id)=(p_tenant,p_store,p_order)
          AND observation.observed_status='refund_succeeded' AND observation.consumed_at IS NULL)
      AND mbox.order_consumption_settled(p_tenant,p_store,p_order)
  )
$valid$;
REVOKE ALL ON FUNCTION mbox.order_recollection_item_restoration_valid(uuid,uuid,uuid,uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mbox.order_recollection_item_restoration_valid(uuid,uuid,uuid,uuid,uuid,uuid) TO mbox_runtime;
CREATE FUNCTION mbox.validate_order_recollection_item_restoration()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,mbox AS $guard$
BEGIN
  PERFORM id FROM mbox.orders WHERE (tenant_id,store_id,id)=(NEW.tenant_id,NEW.store_id,NEW.order_id) FOR UPDATE;
  IF NOT COALESCE(mbox.order_recollection_item_restoration_valid(
      NEW.tenant_id,NEW.store_id,NEW.order_id,NEW.refund_id,NEW.order_item_id,NEW.recollection_payment_id),false)
    OR NOT EXISTS (SELECT 1 FROM mbox.refund_items item
      JOIN mbox.payments payment ON (payment.tenant_id,payment.store_id,payment.id)
        =(item.tenant_id,item.store_id,NEW.recollection_payment_id)
      JOIN mbox.reconciliation_entries ledger ON (ledger.tenant_id,ledger.store_id,ledger.payment_id)
        =(payment.tenant_id,payment.store_id,payment.id)
      WHERE (item.tenant_id,item.store_id,item.refund_id,item.order_item_id,item.amount_minor,item.currency)
          =(NEW.tenant_id,NEW.store_id,NEW.refund_id,NEW.order_item_id,NEW.amount_minor,NEW.currency)
        AND payment.succeeded_at=NEW.settled_at AND ledger.id=NEW.reconciliation_entry_id
        AND ledger.occurred_at=NEW.ledger_occurred_at AND ledger.entry_type='payment'
        AND ledger.amount_minor=payment.amount_minor AND ledger.currency=payment.currency
        AND ledger.provider=payment.provider) THEN
    RAISE EXCEPTION 'item restoration requires an authorized settled original refund' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $guard$;
REVOKE ALL ON FUNCTION mbox.validate_order_recollection_item_restoration() FROM PUBLIC;
CREATE TRIGGER order_recollection_item_restoration_authority
  BEFORE INSERT ON mbox.order_recollection_item_restorations
  FOR EACH ROW EXECUTE FUNCTION mbox.validate_order_recollection_item_restoration();

UPDATE mbox.normalized_schema_metadata SET schema_version='237',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';
COMMIT;
