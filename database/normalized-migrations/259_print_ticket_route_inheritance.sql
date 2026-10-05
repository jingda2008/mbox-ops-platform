BEGIN;

-- Keep the legacy copies NOT NULL / 1..5 contract intact. An enabled inherited
-- policy has no legacy override; a disabled inherited policy keeps a disabled
-- legacy row. Older servers therefore never receive NULL print-job copies.
CREATE TABLE mbox.print_ticket_policy_inheritance (
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  ticket_kind text NOT NULL CHECK (ticket_kind IN (
    'cashier_settlement','cashier_payment','cashier_refund','bar_production',
    'kitchen_production','order_summary','delivery','table_settlement',
    'daily_settlement','production_notice'
  )),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, store_id, ticket_kind),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id)
);
ALTER TABLE mbox.print_ticket_policy_inheritance ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.print_ticket_policy_inheritance FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.print_ticket_policy_inheritance
  USING (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())
  WITH CHECK (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
REVOKE ALL ON mbox.print_ticket_policy_inheritance FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE,DELETE ON mbox.print_ticket_policy_inheritance TO mbox_runtime;
GRANT DELETE ON mbox.print_ticket_policies TO mbox_runtime;

-- Explicit integer writes from either current or older clients restore an
-- override. The new inherited write stores its marker after this trigger.
CREATE FUNCTION mbox.clear_print_ticket_policy_inheritance() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM mbox.print_ticket_policy_inheritance
    WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND ticket_kind=NEW.ticket_kind;
  RETURN NEW;
END $$;
CREATE TRIGGER clear_print_ticket_policy_inheritance
  AFTER INSERT OR UPDATE ON mbox.print_ticket_policies
  FOR EACH ROW EXECUTE FUNCTION mbox.clear_print_ticket_policy_inheritance();
REVOKE ALL ON FUNCTION mbox.clear_print_ticket_policy_inheritance() FROM PUBLIC;

COMMIT;
