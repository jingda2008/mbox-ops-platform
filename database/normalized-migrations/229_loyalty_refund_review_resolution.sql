BEGIN;

CREATE TABLE mbox.loyalty_refund_review_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,
 order_id uuid NOT NULL,refund_id uuid NOT NULL,payment_id uuid NOT NULL,
 basis_sha256 char(64) NOT NULL CHECK(basis_sha256 ~ '^[0-9a-f]{64}$'),
 refund_amount_minor bigint NOT NULL CHECK(refund_amount_minor>0),
 excess_amount_minor bigint NOT NULL CHECK(excess_amount_minor>=0),
 sales_amount_minor bigint NOT NULL CHECK(sales_amount_minor>=0),
 eligible_amount_minor bigint NOT NULL CHECK(eligible_amount_minor>=0 AND eligible_amount_minor<=sales_amount_minor),
 requested_by_employee_id uuid NOT NULL,reason text NOT NULL CHECK(length(reason) BETWEEN 3 AND 1000),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,store_id,id),UNIQUE(tenant_id,store_id,id,refund_id),
 CHECK(refund_amount_minor=excess_amount_minor+sales_amount_minor),
 FOREIGN KEY(tenant_id,store_id,refund_id) REFERENCES mbox.loyalty_refund_reviews(tenant_id,store_id,refund_id),
 FOREIGN KEY(tenant_id,store_id,refund_id,payment_id) REFERENCES mbox.refunds(tenant_id,store_id,id,payment_id),
 FOREIGN KEY(tenant_id,store_id,order_id) REFERENCES mbox.orders(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,requested_by_employee_id) REFERENCES mbox.employees(tenant_id,store_id,id)
);
CREATE INDEX loyalty_refund_review_request_order ON mbox.loyalty_refund_review_requests(tenant_id,store_id,refund_id,created_at,id);
CREATE TRIGGER loyalty_review_request_order BEFORE INSERT ON mbox.loyalty_refund_review_requests
 FOR EACH ROW EXECUTE FUNCTION mbox.validate_loyalty_refund_order();

CREATE TABLE mbox.loyalty_refund_review_request_items (
 tenant_id uuid NOT NULL,store_id uuid NOT NULL,request_id uuid NOT NULL,refund_id uuid NOT NULL,order_item_id uuid NOT NULL,
 amount_minor bigint NOT NULL CHECK(amount_minor>0),loyalty_eligible boolean NOT NULL,
 PRIMARY KEY(tenant_id,store_id,request_id,refund_id,order_item_id),
 FOREIGN KEY(tenant_id,store_id,request_id) REFERENCES mbox.loyalty_refund_review_requests(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,refund_id) REFERENCES mbox.refunds(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,order_item_id) REFERENCES mbox.order_items(tenant_id,store_id,id)
);
CREATE FUNCTION mbox.validate_loyalty_review_item() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM mbox.loyalty_refund_review_requests request
   JOIN mbox.order_items item ON (item.tenant_id,item.store_id,item.order_id)=(request.tenant_id,request.store_id,request.order_id)
   JOIN mbox.refunds refund ON (refund.tenant_id,refund.store_id)=(request.tenant_id,request.store_id)
     AND refund.id=NEW.refund_id AND refund.status='succeeded'
   JOIN mbox.payments payment ON (payment.tenant_id,payment.store_id,payment.id)=(refund.tenant_id,refund.store_id,refund.payment_id)
     AND COALESCE(refund.order_id,payment.order_id)=request.order_id
   JOIN mbox.refund_items refund_item ON (refund_item.tenant_id,refund_item.store_id,refund_item.refund_id,refund_item.order_item_id)=(request.tenant_id,request.store_id,refund.id,item.id)
   WHERE (request.tenant_id,request.store_id,request.id)=(NEW.tenant_id,NEW.store_id,NEW.request_id)
    AND item.id=NEW.order_item_id AND item.parent_order_item_id IS NULL
    AND NEW.loyalty_eligible=item.loyalty_eligible_at_submission AND NEW.amount_minor<=refund_item.amount_minor)
 THEN RAISE EXCEPTION 'review item must match the original refund allocation' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION mbox.validate_loyalty_review_item() FROM PUBLIC;
CREATE TRIGGER loyalty_review_item_identity BEFORE INSERT ON mbox.loyalty_refund_review_request_items
 FOR EACH ROW EXECUTE FUNCTION mbox.validate_loyalty_review_item();

CREATE TABLE mbox.loyalty_refund_review_decisions (
 tenant_id uuid NOT NULL,store_id uuid NOT NULL,request_id uuid NOT NULL,refund_id uuid NOT NULL,
 decision text NOT NULL CHECK(decision IN ('approved','rejected')),decided_by_employee_id uuid NOT NULL,
 reason text NOT NULL CHECK(length(reason) BETWEEN 3 AND 1000),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,store_id,request_id),
 FOREIGN KEY(tenant_id,store_id,request_id,refund_id) REFERENCES mbox.loyalty_refund_review_requests(tenant_id,store_id,id,refund_id),
 FOREIGN KEY(tenant_id,store_id,decided_by_employee_id) REFERENCES mbox.employees(tenant_id,store_id,id)
);
CREATE UNIQUE INDEX loyalty_refund_review_one_approval ON mbox.loyalty_refund_review_decisions(tenant_id,store_id,refund_id) WHERE decision='approved';
CREATE FUNCTION mbox.validate_loyalty_review_decision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE request mbox.loyalty_refund_review_requests%ROWTYPE; total bigint; eligible bigint;
BEGIN
 SELECT * INTO STRICT request FROM mbox.loyalty_refund_review_requests r
  WHERE (r.tenant_id,r.store_id,r.id)=(NEW.tenant_id,NEW.store_id,NEW.request_id);
 IF request.requested_by_employee_id=NEW.decided_by_employee_id THEN
  RAISE EXCEPTION 'refund reward review requires an independent reviewer' USING ERRCODE='23514'; END IF;
 IF NEW.decision='approved' THEN
  SELECT COALESCE(sum(amount_minor),0),COALESCE(sum(amount_minor) FILTER(WHERE loyalty_eligible),0) INTO total,eligible
  FROM mbox.loyalty_refund_review_request_items i WHERE (i.tenant_id,i.store_id,i.request_id,i.refund_id)=(NEW.tenant_id,NEW.store_id,NEW.request_id,NEW.refund_id);
  IF total<>request.sales_amount_minor OR eligible<>request.eligible_amount_minor THEN
   RAISE EXCEPTION 'review sale allocation totals do not match the original refund' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION mbox.validate_loyalty_review_decision() FROM PUBLIC;
CREATE TRIGGER loyalty_review_decision_validation BEFORE INSERT ON mbox.loyalty_refund_review_decisions
 FOR EACH ROW EXECUTE FUNCTION mbox.validate_loyalty_review_decision();

CREATE TABLE mbox.loyalty_refund_review_command_receipts (
 tenant_id uuid NOT NULL,store_id uuid NOT NULL,operation_scope text NOT NULL CHECK(operation_scope IN ('request','decision')),
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 128),
 request_sha256 char(64) NOT NULL CHECK(request_sha256 ~ '^[0-9a-f]{64}$'),
 result jsonb NOT NULL CHECK(jsonb_typeof(result)='object'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,store_id,operation_scope,idempotency_key),
 FOREIGN KEY(tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id)
);
DO $$ DECLARE relation text; BEGIN
 FOREACH relation IN ARRAY ARRAY['loyalty_refund_review_requests','loyalty_refund_review_request_items','loyalty_refund_review_decisions','loyalty_refund_review_command_receipts'] LOOP
  EXECUTE format('ALTER TABLE mbox.%I ENABLE ROW LEVEL SECURITY',relation);
  EXECUTE format('ALTER TABLE mbox.%I FORCE ROW LEVEL SECURITY',relation);
  EXECUTE format('CREATE POLICY tenant_store_isolation ON mbox.%I USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())',relation);
  EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON mbox.%I FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change()',relation);
  EXECUTE format('REVOKE ALL ON mbox.%I FROM PUBLIC',relation);
  EXECUTE format('GRANT SELECT,INSERT ON mbox.%I TO mbox_runtime',relation);
 END LOOP;
END $$;
CREATE VIEW mbox.loyalty_unresolved_refund_reviews WITH(security_invoker=true) AS
 SELECT review.* FROM mbox.loyalty_refund_reviews review WHERE NOT EXISTS(
  SELECT 1 FROM mbox.loyalty_refund_review_decisions decision
  WHERE (decision.tenant_id,decision.store_id,decision.refund_id)=(review.tenant_id,review.store_id,review.refund_id)
   AND decision.decision='approved');
GRANT SELECT ON mbox.loyalty_unresolved_refund_reviews TO mbox_runtime;

UPDATE mbox.normalized_schema_metadata SET schema_version='229',updated_at=clock_timestamp()
 WHERE singleton=true AND schema_flavor='normalized-core-v1';
COMMIT;
