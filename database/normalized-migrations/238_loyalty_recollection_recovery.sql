BEGIN;

-- Preserve cumulative original award/refund facts. A later ordinary recollection
-- restores only its original contribution; future refunds are bounded by the net.
ALTER TABLE mbox.loyalty_order_awards
 ADD COLUMN restored_amount_minor bigint NOT NULL DEFAULT 0 CHECK(restored_amount_minor>=0),
 ADD COLUMN restored_points integer NOT NULL DEFAULT 0 CHECK(restored_points>=0),
 ADD COLUMN restored_growth integer NOT NULL DEFAULT 0 CHECK(restored_growth>=0);
ALTER TABLE mbox.loyalty_order_reward_contributions
 ADD COLUMN restored_eligible_amount_minor bigint NOT NULL DEFAULT 0 CHECK(restored_eligible_amount_minor>=0);
DO $$ DECLARE constraint_name text; BEGIN
 FOR constraint_name IN SELECT conname FROM pg_constraint WHERE conrelid='mbox.loyalty_order_awards'::regclass
   AND contype='c' AND pg_get_constraintdef(oid) LIKE '%reversed_amount_minor <= eligible_amount_minor%'
 LOOP EXECUTE format('ALTER TABLE mbox.loyalty_order_awards DROP CONSTRAINT %I',constraint_name); END LOOP;
 FOR constraint_name IN SELECT conname FROM pg_constraint WHERE conrelid='mbox.loyalty_order_reward_contributions'::regclass
   AND contype='c' AND pg_get_constraintdef(oid) LIKE '%reversed_eligible_amount_minor <= eligible_amount_minor%'
 LOOP EXECUTE format('ALTER TABLE mbox.loyalty_order_reward_contributions DROP CONSTRAINT %I',constraint_name); END LOOP;
END $$;
ALTER TABLE mbox.loyalty_order_awards DROP CONSTRAINT loyalty_order_awards_reversal_model_ck,
 ADD CONSTRAINT loyalty_award_net_reversal_amount CHECK(reversed_amount_minor-restored_amount_minor BETWEEN 0 AND eligible_amount_minor),
 ADD CONSTRAINT loyalty_order_awards_reversal_model_ck CHECK(calculation_model='exact_carry' OR
   (reversed_points-restored_points BETWEEN 0 AND awarded_points AND reversed_growth-restored_growth BETWEEN 0 AND awarded_growth));
ALTER TABLE mbox.loyalty_order_reward_contributions ADD CONSTRAINT loyalty_contribution_net_reversal CHECK(
 reversed_eligible_amount_minor>=0 AND reversed_eligible_amount_minor-restored_eligible_amount_minor BETWEEN 0 AND eligible_amount_minor);

CREATE TABLE mbox.loyalty_recollection_restorations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,
 award_id uuid NOT NULL,application_id uuid NOT NULL,order_id uuid NOT NULL,refund_id uuid NOT NULL,payment_id uuid NOT NULL,
 eligible_amount_minor bigint NOT NULL CHECK(eligible_amount_minor>=0),
 points_delta integer NOT NULL CHECK(points_delta>=0),growth_delta integer NOT NULL CHECK(growth_delta>=0),
 credited_points integer NOT NULL CHECK(credited_points>=0),released_recovery_points integer NOT NULL CHECK(released_recovery_points>=0),
 expired_points integer NOT NULL CHECK(expired_points>=0),original_expires_at timestamptz,policy_version_id uuid NOT NULL,
 request_id uuid,actor_ref text NOT NULL CHECK(length(actor_ref) BETWEEN 1 AND 160),restored_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(points_delta=credited_points+released_recovery_points+expired_points),
 UNIQUE(tenant_id,store_id,id),UNIQUE(tenant_id,store_id,application_id),UNIQUE(tenant_id,store_id,refund_id),
 FOREIGN KEY(tenant_id,store_id,award_id,order_id) REFERENCES mbox.loyalty_order_awards(tenant_id,store_id,id,order_id),
 FOREIGN KEY(tenant_id,store_id,application_id) REFERENCES mbox.loyalty_award_refund_applications(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,payment_id) REFERENCES mbox.payments(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,policy_version_id) REFERENCES mbox.loyalty_policy_versions(tenant_id,store_id,id)
);
CREATE FUNCTION mbox.validate_loyalty_recollection_restoration() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,mbox AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM mbox.loyalty_award_refund_applications application
   JOIN mbox.loyalty_order_awards award ON (award.tenant_id,award.store_id,award.id)=(application.tenant_id,application.store_id,application.award_id)
   WHERE (application.tenant_id,application.store_id,application.id,application.order_id,application.award_id,application.refund_id,application.eligible_refund_amount_minor)=
     (NEW.tenant_id,NEW.store_id,NEW.application_id,NEW.order_id,NEW.award_id,NEW.refund_id,NEW.eligible_amount_minor)
     AND award.policy_version_id=NEW.policy_version_id
     AND EXISTS(SELECT 1 FROM mbox.order_recollection_item_restorations restored
       WHERE (restored.tenant_id,restored.store_id,restored.order_id,restored.refund_id,restored.recollection_payment_id)=
         (NEW.tenant_id,NEW.store_id,NEW.order_id,NEW.refund_id,NEW.payment_id))
     AND NOT EXISTS(SELECT 1 FROM mbox.refund_items item WHERE item.tenant_id=NEW.tenant_id AND item.store_id=NEW.store_id AND item.refund_id=NEW.refund_id
       AND NOT EXISTS(SELECT 1 FROM mbox.order_recollection_item_restorations restored
         WHERE (restored.tenant_id,restored.store_id,restored.order_id,restored.refund_id,restored.order_item_id,restored.amount_minor)=
           (NEW.tenant_id,NEW.store_id,NEW.order_id,NEW.refund_id,item.order_item_id,item.amount_minor)))
 ) THEN RAISE EXCEPTION 'loyalty restoration requires its original refund contribution and immutable item settlement' USING ERRCODE='23503'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION mbox.validate_loyalty_recollection_restoration() FROM PUBLIC;
CREATE TRIGGER loyalty_recollection_original_facts BEFORE INSERT ON mbox.loyalty_recollection_restorations
 FOR EACH ROW EXECUTE FUNCTION mbox.validate_loyalty_recollection_restoration();
CREATE TRIGGER loyalty_recollection_append_only BEFORE UPDATE OR DELETE ON mbox.loyalty_recollection_restorations
 FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();
ALTER TABLE mbox.loyalty_recollection_restorations ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.loyalty_recollection_restorations FORCE ROW LEVEL SECURITY;
CREATE POLICY loyalty_recollection_scope ON mbox.loyalty_recollection_restorations
 USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())
 WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
REVOKE ALL ON mbox.loyalty_recollection_restorations FROM PUBLIC;
GRANT SELECT,INSERT ON mbox.loyalty_recollection_restorations TO mbox_runtime;
-- SYS328 request/decision/receipt fragment for owner to include in migration 238.
-- Every monetary/reward value in preview/result is computed by the core repositories.
CREATE TABLE mbox.order_financial_recovery_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,order_id uuid NOT NULL,
 basis_sha256 char(64) NOT NULL CHECK(basis_sha256 ~ '^[0-9a-f]{64}$'),
 dimensions text NOT NULL CHECK(dimensions IN ('attribution','loyalty','all')),
 preview_snapshot jsonb NOT NULL CHECK(jsonb_typeof(preview_snapshot)='object'),
 requested_by_employee_id uuid NOT NULL,reason text NOT NULL CHECK(length(reason) BETWEEN 3 AND 1000),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,store_id,id),
 UNIQUE(tenant_id,store_id,id,order_id,requested_by_employee_id),
 FOREIGN KEY(tenant_id,store_id,order_id) REFERENCES mbox.orders(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,requested_by_employee_id) REFERENCES mbox.employees(tenant_id,store_id,id)
);
CREATE INDEX order_financial_recovery_requests_queue ON mbox.order_financial_recovery_requests(tenant_id,store_id,order_id,created_at,id);
CREATE TABLE mbox.order_financial_recovery_decisions (
 tenant_id uuid NOT NULL,store_id uuid NOT NULL,request_id uuid NOT NULL,order_id uuid NOT NULL,
 requested_by_employee_id uuid NOT NULL,decided_by_employee_id uuid NOT NULL,
 decision text NOT NULL CHECK(decision IN ('approved','rejected')),
 reason text NOT NULL CHECK(length(reason) BETWEEN 3 AND 1000),
 result jsonb NOT NULL CHECK(jsonb_typeof(result)='object'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,store_id,request_id),
 CHECK(requested_by_employee_id<>decided_by_employee_id),
 FOREIGN KEY(tenant_id,store_id,request_id,order_id,requested_by_employee_id)
   REFERENCES mbox.order_financial_recovery_requests(tenant_id,store_id,id,order_id,requested_by_employee_id),
 FOREIGN KEY(tenant_id,store_id,decided_by_employee_id) REFERENCES mbox.employees(tenant_id,store_id,id)
);
CREATE TABLE mbox.order_financial_recovery_command_receipts (
 tenant_id uuid NOT NULL,store_id uuid NOT NULL,
 operation_scope text NOT NULL CHECK(operation_scope IN ('request','decision')),
 idempotency_key text NOT NULL CHECK(idempotency_key ~ '^[A-Za-z0-9_.:-]{8,128}$'),
 actor_employee_id uuid NOT NULL,
 request_sha256 char(64) NOT NULL CHECK(request_sha256 ~ '^[0-9a-f]{64}$'),
 result jsonb NOT NULL CHECK(jsonb_typeof(result)='object'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,store_id,operation_scope,idempotency_key),
 FOREIGN KEY(tenant_id,store_id,actor_employee_id) REFERENCES mbox.employees(tenant_id,store_id,id)
);
DO $$ DECLARE relation text; BEGIN
 FOREACH relation IN ARRAY ARRAY['order_financial_recovery_requests','order_financial_recovery_decisions','order_financial_recovery_command_receipts'] LOOP
  EXECUTE format('ALTER TABLE mbox.%I ENABLE ROW LEVEL SECURITY',relation);
  EXECUTE format('ALTER TABLE mbox.%I FORCE ROW LEVEL SECURITY',relation);
  EXECUTE format('CREATE POLICY tenant_store_isolation ON mbox.%I USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())',relation);
  EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON mbox.%I FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change()',relation);
  EXECUTE format('REVOKE ALL ON mbox.%I FROM PUBLIC',relation);
  EXECUTE format('GRANT SELECT,INSERT ON mbox.%I TO mbox_runtime',relation);
 END LOOP;
END $$;
ALTER TABLE mbox.loyalty_recollection_restorations ADD CONSTRAINT loyalty_recollection_request_fk
 FOREIGN KEY(tenant_id,store_id,request_id) REFERENCES mbox.order_financial_recovery_requests(tenant_id,store_id,id);
-- Preserve the immutable first-settlement anchor. Requeue only when a later
-- factual ordinary recollection has an unapplied original award contribution.
DO $$ DECLARE definition text;needle text := '    (OLD.status=''pending'' AND NEW.status=''processing'')'; BEGIN
 SELECT pg_get_functiondef('mbox.protect_loyalty_accrual_deferred_order()'::regprocedure) INTO definition;
 IF position(needle IN definition)=0 THEN RAISE EXCEPTION 'Unexpected deferred loyalty guard'; END IF;
 EXECUTE replace(definition,needle,needle || '
    OR (OLD.status IN (''applied'',''not_applicable'') AND NEW.status=''pending'' AND EXISTS(
      SELECT 1 FROM mbox.loyalty_award_refund_applications application
      JOIN mbox.order_recollection_item_restorations restored
        ON (restored.tenant_id,restored.store_id,restored.order_id,restored.refund_id)=
          (application.tenant_id,application.store_id,application.order_id,application.refund_id)
      WHERE (application.tenant_id,application.store_id,application.order_id)=(NEW.tenant_id,NEW.store_id,NEW.order_id)
        AND application.eligible_refund_amount_minor>0 AND NOT EXISTS(
          SELECT 1 FROM mbox.loyalty_recollection_restorations applied
          WHERE (applied.tenant_id,applied.store_id,applied.application_id)=(application.tenant_id,application.store_id,application.id))))');
END $$;
UPDATE mbox.normalized_schema_metadata SET schema_version='238',updated_at=clock_timestamp() WHERE singleton=true AND schema_flavor='normalized-core-v1';
COMMIT;
