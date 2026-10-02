BEGIN;
CREATE TABLE mbox.voucher_operations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,
 idempotency_key text NOT NULL,request_sha256 char(64) NOT NULL,platform text NOT NULL,
 voucher_hash char(64) NOT NULL,voucher_masked text NOT NULL,
 actor_employee_id uuid NOT NULL,business_date date NOT NULL,public_id text NOT NULL,
 order_id uuid,table_session_id uuid,prepared_snapshot jsonb NOT NULL,
 status text NOT NULL CHECK(status IN ('dispatching','unknown','provider_succeeded','recorded','not_consumed')),
 provider_result jsonb,result_snapshot jsonb,review_snapshot jsonb,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
 FOREIGN KEY(tenant_id,store_id,actor_employee_id) REFERENCES mbox.employees(tenant_id,store_id,id),
 UNIQUE(tenant_id,store_id,id),UNIQUE(tenant_id,store_id,idempotency_key),UNIQUE(tenant_id,store_id,public_id),
 CHECK((order_id IS NULL)=(table_session_id IS NULL))
);
CREATE UNIQUE INDEX voucher_operations_one_active_code ON mbox.voucher_operations(tenant_id,store_id,platform,voucher_hash) WHERE status<>'not_consumed';
CREATE TABLE mbox.voucher_operation_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,
 operation_id uuid NOT NULL,employee_id uuid NOT NULL,event_type text NOT NULL,evidence jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(tenant_id,store_id,operation_id) REFERENCES mbox.voucher_operations(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,employee_id) REFERENCES mbox.employees(tenant_id,store_id,id)
);
CREATE TRIGGER voucher_operation_events_append_only BEFORE UPDATE OR DELETE ON mbox.voucher_operation_events FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();
ALTER TABLE mbox.voucher_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.voucher_operations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.voucher_operations USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
ALTER TABLE mbox.voucher_operation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.voucher_operation_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.voucher_operation_events USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
REVOKE ALL ON mbox.voucher_operations,mbox.voucher_operation_events FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON mbox.voucher_operations TO mbox_runtime;
GRANT SELECT,INSERT ON mbox.voucher_operation_events TO mbox_runtime;
ALTER TABLE mbox.group_voucher_redemptions DROP CONSTRAINT group_voucher_redemptions_provider_status_check;
ALTER TABLE mbox.group_voucher_redemptions ADD CONSTRAINT group_voucher_redemptions_provider_status_check CHECK(provider_status IS NULL OR provider_status IN ('consumed','already_consumed','consumed_manual_review'));
COMMIT;
