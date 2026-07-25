BEGIN;

ALTER TABLE mbox.operational_orders
  ADD COLUMN sales_employee_id text;

CREATE INDEX operational_orders_sales_analytics_idx
  ON mbox.operational_orders (
    tenant_id,
    store_id,
    sales_employee_id,
    status,
    submitted_at
  );

CREATE INDEX operational_order_items_product_analytics_idx
  ON mbox.operational_order_items (
    tenant_id,
    store_id,
    product_id,
    category_id,
    added_at
  );

CREATE INDEX operational_table_sessions_analytics_idx
  ON mbox.operational_table_sessions (
    tenant_id,
    store_id,
    business_date,
    table_id,
    guest_count
  );

CREATE INDEX operational_service_tasks_analytics_idx
  ON mbox.operational_service_tasks (
    tenant_id,
    store_id,
    created_at,
    service_type_id,
    owner_id,
    status
  );

COMMENT ON COLUMN mbox.operational_orders.sales_employee_id IS
  'Latest explicit table-session sales attribution projected for permission-scoped performance analytics.';

COMMIT;
