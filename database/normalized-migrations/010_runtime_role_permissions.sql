BEGIN;

DO $$
DECLARE
  existing_role record;
BEGIN
  SELECT rolcanlogin, rolsuper, rolreplication, rolbypassrls
  INTO existing_role
  FROM pg_roles
  WHERE rolname = 'mbox_runtime';

  IF NOT FOUND THEN
    CREATE ROLE mbox_runtime
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  ELSIF existing_role.rolsuper OR existing_role.rolreplication OR existing_role.rolbypassrls THEN
    RAISE EXCEPTION 'existing mbox_runtime role has unsafe cluster privileges';
  ELSE
    ALTER ROLE mbox_runtime NOLOGIN NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END $$;

COMMENT ON ROLE mbox_runtime IS
  'NOLOGIN group role for M-BOX normalized runtime access. Grant membership to the deployment login outside migrations; never store login passwords here.';

REVOKE ALL ON SCHEMA mbox FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA mbox FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA mbox FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA mbox FROM PUBLIC;

REVOKE ALL ON SCHEMA mbox FROM mbox_runtime;
-- Reset only the objects owned by this migration baseline. Blanket revocation
-- would silently remove least-privilege grants added by later migrations when
-- this defensive role setup is replayed in verification.
REVOKE ALL ON TABLE
  mbox.tenants,
  mbox.stores,
  mbox.areas,
  mbox.tables,
  mbox.employees,
  mbox.roles,
  mbox.employee_roles,
  mbox.table_assignments,
  mbox.products,
  mbox.product_prices,
  mbox.inventory_items,
  mbox.recipes,
  mbox.recipe_items,
  mbox.performers,
  mbox.schedules,
  mbox.staff_permission_definitions,
  mbox.role_permission_assignments,
  mbox.employee_permission_overrides,
  mbox.role_data_scopes,
  mbox.role_approval_limits,
  mbox.role_navigation_items,
  mbox.store_daily_credentials,
  mbox.store_device_access_leases,
  mbox.staff_sessions,
  mbox.idempotency_records,
  mbox.outbox_messages,
  mbox.table_sessions,
  mbox.service_tasks,
  mbox.orders,
  mbox.order_items,
  mbox.kds_tasks,
  mbox.inventory_balances,
  mbox.payments,
  mbox.refunds,
  mbox.reservations,
  mbox.reservation_table_locks,
  mbox.customers,
  mbox.customer_profiles,
  mbox.benefits,
  mbox.song_requests,
  mbox.notifications,
  mbox.audit_events,
  mbox.service_task_events,
  mbox.kds_task_events,
  mbox.inventory_movements,
  mbox.refund_items,
  mbox.reconciliation_entries
FROM mbox_runtime;
REVOKE ALL ON FUNCTION mbox.current_tenant_id() FROM mbox_runtime;
REVOKE ALL ON FUNCTION mbox.current_store_id() FROM mbox_runtime;

GRANT USAGE ON SCHEMA mbox TO mbox_runtime;
GRANT EXECUTE ON FUNCTION mbox.current_tenant_id() TO mbox_runtime;
GRANT EXECUTE ON FUNCTION mbox.current_store_id() TO mbox_runtime;

GRANT SELECT ON TABLE
  mbox.tenants,
  mbox.stores
TO mbox_runtime;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  mbox.areas,
  mbox.tables,
  mbox.employees,
  mbox.roles,
  mbox.employee_roles,
  mbox.table_assignments,
  mbox.products,
  mbox.product_prices,
  mbox.inventory_items,
  mbox.recipes,
  mbox.recipe_items,
  mbox.performers,
  mbox.schedules,
  mbox.staff_permission_definitions,
  mbox.role_permission_assignments,
  mbox.employee_permission_overrides,
  mbox.role_data_scopes,
  mbox.role_approval_limits,
  mbox.role_navigation_items,
  mbox.store_daily_credentials,
  mbox.store_device_access_leases,
  mbox.staff_sessions
TO mbox_runtime;

GRANT SELECT, INSERT, UPDATE ON TABLE
  mbox.idempotency_records,
  mbox.outbox_messages,
  mbox.table_sessions,
  mbox.service_tasks,
  mbox.orders,
  mbox.order_items,
  mbox.kds_tasks,
  mbox.inventory_balances,
  mbox.payments,
  mbox.refunds,
  mbox.reservations,
  mbox.reservation_table_locks,
  mbox.customers,
  mbox.customer_profiles,
  mbox.benefits,
  mbox.song_requests,
  mbox.notifications
TO mbox_runtime;

GRANT DELETE ON TABLE
  mbox.idempotency_records
TO mbox_runtime;

GRANT SELECT, INSERT ON TABLE
  mbox.audit_events,
  mbox.service_task_events,
  mbox.kds_task_events,
  mbox.inventory_movements,
  mbox.refund_items,
  mbox.reconciliation_entries
TO mbox_runtime;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA mbox TO mbox_runtime;

COMMIT;
