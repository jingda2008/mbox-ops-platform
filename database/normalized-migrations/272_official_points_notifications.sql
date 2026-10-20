BEGIN;
-- No historical backfill: installing notifications must never contact old customers.
CREATE TABLE mbox.official_points_settings (
 tenant_id uuid NOT NULL, store_id uuid NOT NULL, account_id uuid NOT NULL,
 enabled boolean NOT NULL DEFAULT false, template_id text NOT NULL,
 data_keys jsonb NOT NULL CHECK(jsonb_typeof(data_keys)='object'),
 certification_expires_at timestamptz NOT NULL, evidence_reference text NOT NULL CHECK(length(evidence_reference) BETWEEN 8 AND 500),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,store_id),
 FOREIGN KEY(tenant_id,store_id,account_id) REFERENCES mbox.social_accounts(tenant_id,store_id,id)
);
CREATE TABLE mbox.official_points_preferences (
 tenant_id uuid NOT NULL,store_id uuid NOT NULL,customer_id uuid NOT NULL,account_id uuid NOT NULL,
 enabled boolean NOT NULL,updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,store_id,customer_id,account_id),
 FOREIGN KEY(tenant_id,store_id,customer_id) REFERENCES mbox.customers(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,account_id) REFERENCES mbox.social_accounts(tenant_id,store_id,id)
);
CREATE TABLE mbox.official_points_notifications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,
 customer_id uuid NOT NULL,membership_id uuid NOT NULL,event_key text NOT NULL,event_type text NOT NULL,
 points_delta integer NOT NULL,balance_after integer NOT NULL CHECK(balance_after>=0),
 reason text NOT NULL,occurred_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 status text NOT NULL DEFAULT 'queued' CHECK(status IN('queued','dispatching','accepted','delivered','delivery_failed','blocked','skipped','rejected','unknown')),
 account_id uuid,template_id text,provider_reference text,error_code text,
 attempted_at timestamptz,completed_at timestamptz,next_check_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,store_id,event_key),UNIQUE(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,customer_id) REFERENCES mbox.customers(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,membership_id) REFERENCES mbox.customer_memberships(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,account_id) REFERENCES mbox.social_accounts(tenant_id,store_id,id)
);
CREATE INDEX official_points_due ON mbox.official_points_notifications(tenant_id,store_id,next_check_at,created_at) WHERE status IN('queued','blocked');
CREATE UNIQUE INDEX official_points_receipt ON mbox.official_points_notifications(tenant_id,store_id,account_id,provider_reference) WHERE provider_reference IS NOT NULL;
CREATE TABLE mbox.official_points_receipts (
 tenant_id uuid NOT NULL,store_id uuid NOT NULL,account_id uuid NOT NULL,provider_reference text NOT NULL,
 delivered boolean NOT NULL,received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,store_id,account_id,provider_reference),
 FOREIGN KEY(tenant_id,store_id,account_id) REFERENCES mbox.social_accounts(tenant_id,store_id,id)
);
DO $$ DECLARE n text; BEGIN
 FOREACH n IN ARRAY ARRAY['official_points_settings','official_points_preferences','official_points_notifications','official_points_receipts'] LOOP
 EXECUTE format('ALTER TABLE mbox.%I ENABLE ROW LEVEL SECURITY',n);
 EXECUTE format('ALTER TABLE mbox.%I FORCE ROW LEVEL SECURITY',n);
 EXECUTE format('CREATE POLICY tenant_store_isolation ON mbox.%I USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())',n);
 EXECUTE format('REVOKE ALL ON mbox.%I FROM PUBLIC',n);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE ON mbox.%I TO mbox_runtime',n);
 END LOOP;
END $$;
REVOKE UPDATE ON mbox.official_points_receipts FROM mbox_runtime;
CREATE FUNCTION mbox.guard_official_points_payload() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,mbox AS $$
BEGIN
 IF (to_jsonb(NEW)-ARRAY['status','account_id','template_id','provider_reference','error_code','attempted_at','completed_at','next_check_at']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['status','account_id','template_id','provider_reference','error_code','attempted_at','completed_at','next_check_at']) THEN
 RAISE EXCEPTION 'Points notification source is immutable' USING ERRCODE='23514';
 END IF;
 IF OLD.status IN('accepted','delivered','delivery_failed','rejected','unknown','skipped') AND NEW.status NOT IN(OLD.status,'delivered','delivery_failed') THEN
 RAISE EXCEPTION 'Points notification cannot be resent' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_official_points_payload BEFORE UPDATE ON mbox.official_points_notifications FOR EACH ROW EXECUTE FUNCTION mbox.guard_official_points_payload();
REVOKE ALL ON FUNCTION mbox.guard_official_points_payload() FROM PUBLIC;
CREATE FUNCTION mbox.enqueue_official_points_ledger() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,mbox AS $$
BEGIN
 INSERT INTO mbox.official_points_notifications(tenant_id,store_id,customer_id,membership_id,event_key,event_type,points_delta,balance_after,reason,occurred_at)
 VALUES(NEW.tenant_id,NEW.store_id,NEW.customer_id,NEW.membership_id,'ledger:'||NEW.id,
 CASE WHEN NEW.entry_type='redeem' AND NEW.idempotency_key LIKE 'checkout-points:%' THEN 'checkout_hold' WHEN NEW.entry_type='reverse' AND (NEW.source_id LIKE 'recovery-debt:%' OR NEW.idempotency_key LIKE '%:recovery-debt') THEN 'debt_recovery' WHEN NEW.entry_type='earn' AND NEW.source_type<>'order' THEN 'promotion_earn' ELSE NEW.entry_type END,
 NEW.points_delta,NEW.balance_after,NEW.reason,NEW.occurred_at);
 RETURN NEW;
END $$;
CREATE TRIGGER official_points_ledger AFTER INSERT ON mbox.loyalty_point_ledger FOR EACH ROW EXECUTE FUNCTION mbox.enqueue_official_points_ledger();
-- Finalising a hold does not deduct the available balance again.
CREATE FUNCTION mbox.enqueue_official_points_settlement() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,mbox AS $$
BEGIN
 IF OLD.status='held' AND NEW.status='consumed' THEN
 INSERT INTO mbox.official_points_notifications(tenant_id,store_id,customer_id,membership_id,event_key,event_type,points_delta,balance_after,reason,occurred_at)
 SELECT NEW.tenant_id,NEW.store_id,NEW.customer_id,NEW.membership_id,'settled:'||NEW.quote_id,'checkout_settled',0,a.available_points,
 '已占用的'||NEW.points||'积分已确认抵扣，本次不重复扣减',clock_timestamp()
 FROM mbox.loyalty_accounts a WHERE a.tenant_id=NEW.tenant_id AND a.store_id=NEW.store_id AND a.membership_id=NEW.membership_id;
 END IF; RETURN NEW;
END $$;
CREATE TRIGGER official_points_settlement AFTER UPDATE OF status ON mbox.checkout_point_holds FOR EACH ROW EXECUTE FUNCTION mbox.enqueue_official_points_settlement();
-- Returning expired points can legitimately credit zero: still explain that outcome.
CREATE FUNCTION mbox.enqueue_official_points_expired_return() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,mbox AS $$
BEGIN
 IF NEW.points>NEW.credited_points THEN
 INSERT INTO mbox.official_points_notifications(tenant_id,store_id,customer_id,membership_id,event_key,event_type,points_delta,balance_after,reason,occurred_at)
 SELECT NEW.tenant_id,NEW.store_id,h.customer_id,h.membership_id,'expired-return:'||NEW.id,'expired_return',0,a.available_points+NEW.credited_points,
 '取消或退款返还中有'||(NEW.points-NEW.credited_points)||'积分超过原有效期，未增加可用余额',NEW.created_at
 FROM mbox.checkout_point_holds h JOIN mbox.loyalty_accounts a ON(a.tenant_id,a.store_id,a.membership_id)=(h.tenant_id,h.store_id,h.membership_id)
 WHERE(h.tenant_id,h.store_id,h.quote_id)=(NEW.tenant_id,NEW.store_id,NEW.quote_id);
 END IF; RETURN NEW;
END $$;
CREATE TRIGGER official_points_expired_return AFTER INSERT ON mbox.checkout_point_restorations FOR EACH ROW EXECUTE FUNCTION mbox.enqueue_official_points_expired_return();
REVOKE ALL ON FUNCTION mbox.enqueue_official_points_ledger(),mbox.enqueue_official_points_settlement(),mbox.enqueue_official_points_expired_return() FROM PUBLIC;
-- Pending recovery is separate from available points; do not call it a negative balance.
CREATE FUNCTION mbox.enqueue_official_points_debt() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,mbox AS $$
BEGIN
 IF NEW.pending_recovery_points<>OLD.pending_recovery_points THEN
 INSERT INTO mbox.official_points_notifications(tenant_id,store_id,customer_id,membership_id,event_key,event_type,points_delta,balance_after,reason,occurred_at)
 VALUES(NEW.tenant_id,NEW.store_id,NEW.customer_id,NEW.membership_id,'debt:'||gen_random_uuid(),'pending_recovery',NEW.pending_recovery_points-OLD.pending_recovery_points,NEW.available_points,
 '退款待回收积分由'||OLD.pending_recovery_points||'变为'||NEW.pending_recovery_points||'；可用余额单独显示',clock_timestamp());
 END IF; RETURN NEW;
END $$;
CREATE TRIGGER official_points_debt AFTER UPDATE OF pending_recovery_points ON mbox.loyalty_accounts FOR EACH ROW EXECUTE FUNCTION mbox.enqueue_official_points_debt();
REVOKE ALL ON FUNCTION mbox.enqueue_official_points_debt() FROM PUBLIC;
UPDATE mbox.normalized_schema_metadata SET schema_version='272',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
