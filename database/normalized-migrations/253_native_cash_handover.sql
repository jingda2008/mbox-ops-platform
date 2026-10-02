BEGIN;
CREATE TABLE mbox.cash_handovers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,
 business_date date NOT NULL,opened_by uuid NOT NULL,opened_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 opening_minor bigint NOT NULL CHECK(opening_minor>=0),opening_ledger_net bigint NOT NULL,opening_ledger_count bigint NOT NULL,
 opening_difference_minor bigint,opening_reason text NOT NULL,
 status text NOT NULL CHECK(status IN('open','count_submitted','closed')) DEFAULT 'open',revision integer NOT NULL DEFAULT 1,
 movement_minor bigint NOT NULL DEFAULT 0,count_snapshot jsonb,closed_by uuid,closed_at timestamptz,
 FOREIGN KEY(tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
 FOREIGN KEY(tenant_id,store_id,opened_by) REFERENCES mbox.employees(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,closed_by) REFERENCES mbox.employees(tenant_id,store_id,id),UNIQUE(tenant_id,store_id,id)
);
CREATE UNIQUE INDEX cash_handovers_one_open ON mbox.cash_handovers(tenant_id,store_id) WHERE status<>'closed';
CREATE TABLE mbox.cash_handover_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,handover_id uuid NOT NULL,employee_id uuid NOT NULL,
 action text NOT NULL,evidence jsonb NOT NULL,occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(tenant_id,store_id,handover_id) REFERENCES mbox.cash_handovers(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,employee_id) REFERENCES mbox.employees(tenant_id,store_id,id)
);
CREATE UNIQUE INDEX cash_handover_event_request ON mbox.cash_handover_events(tenant_id,store_id,(evidence->>'key')) WHERE evidence ? 'key';
CREATE TRIGGER cash_handover_events_append_only BEFORE UPDATE OR DELETE ON mbox.cash_handover_events FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();
ALTER TABLE mbox.cash_handovers ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.cash_handovers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.cash_handovers USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
ALTER TABLE mbox.cash_handover_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.cash_handover_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.cash_handover_events USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
REVOKE ALL ON mbox.cash_handovers,mbox.cash_handover_events FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON mbox.cash_handovers TO mbox_runtime;
GRANT SELECT,INSERT ON mbox.cash_handover_events TO mbox_runtime;
COMMIT;
