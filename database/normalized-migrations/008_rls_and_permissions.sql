BEGIN;

ALTER TABLE mbox.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mbox.tenants
  USING (id = mbox.current_tenant_id())
  WITH CHECK (id = mbox.current_tenant_id());

ALTER TABLE mbox.stores ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.stores FORCE ROW LEVEL SECURITY;
CREATE POLICY store_isolation ON mbox.stores
  USING (tenant_id = mbox.current_tenant_id() AND id = mbox.current_store_id())
  WITH CHECK (tenant_id = mbox.current_tenant_id() AND id = mbox.current_store_id());

DO $$
DECLARE target_table record;
BEGIN
  FOR target_table IN
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'mbox'
      AND table_type = 'BASE TABLE'
      AND table_name NOT IN ('tenants', 'stores', 'normalized_schema_metadata', 'normalized_schema_migrations')
      AND EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'mbox'
          AND table_name = information_schema.tables.table_name
          AND column_name = 'tenant_id'
      )
      AND EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'mbox'
          AND table_name = information_schema.tables.table_name
          AND column_name = 'store_id'
      )
  LOOP
    EXECUTE format('ALTER TABLE mbox.%I ENABLE ROW LEVEL SECURITY', target_table.table_name);
    EXECUTE format('ALTER TABLE mbox.%I FORCE ROW LEVEL SECURITY', target_table.table_name);
    EXECUTE format(
      'CREATE POLICY tenant_store_isolation ON mbox.%I '
      'USING (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id()) '
      'WITH CHECK (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id())',
      target_table.table_name
    );
  END LOOP;
END $$;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA mbox FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA mbox FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA mbox FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA mbox FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mbox.current_tenant_id() TO PUBLIC;
GRANT EXECUTE ON FUNCTION mbox.current_store_id() TO PUBLIC;

COMMENT ON SCHEMA mbox IS 'M-BOX normalized transactional schema. No whole-store runtime JSON or compatibility projections.';
COMMENT ON TABLE mbox.outbox_messages IS 'Transactional outbox claimed in bounded batches with FOR UPDATE SKIP LOCKED.';
COMMENT ON TABLE mbox.audit_events IS 'Append-only security and business audit evidence; redact sensitive data before insertion.';
COMMENT ON TABLE mbox.inventory_movements IS 'Append-only inventory journal; balances are derived transactionally.';
COMMENT ON TABLE mbox.kds_tasks IS 'Authoritative KDS task linked by foreign key to exactly one order item.';
COMMENT ON COLUMN mbox.orders.total_amount_minor IS 'Currency amount in integer minor units.';
COMMENT ON COLUMN mbox.payments.amount_minor IS 'Currency amount in integer minor units.';

COMMIT;
