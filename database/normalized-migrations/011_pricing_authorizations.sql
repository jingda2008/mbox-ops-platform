BEGIN;

CREATE TABLE mbox.table_session_customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  table_session_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  relationship text NOT NULL DEFAULT 'primary'
    CHECK (relationship IN ('primary', 'guest')),
  linked_by_employee_id uuid,
  linked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, table_session_id)
    REFERENCES mbox.table_sessions(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, customer_id)
    REFERENCES mbox.customers(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, linked_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, table_session_id, customer_id),
  UNIQUE (tenant_id, store_id, id)
);

CREATE UNIQUE INDEX table_session_customers_primary_uq
  ON mbox.table_session_customers (tenant_id, store_id, table_session_id)
  WHERE relationship = 'primary';

CREATE TABLE mbox.pricing_authorizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  table_session_id uuid NOT NULL,
  order_id uuid,
  source_type text NOT NULL CHECK (source_type IN ('employee', 'benefit')),
  source_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('discount', 'gift')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  maximum_amount_minor bigint NOT NULL CHECK (maximum_amount_minor >= amount_minor),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  authorized_by_employee_id uuid,
  capability text,
  benefit_id uuid,
  role_approval_limit_id uuid,
  status text NOT NULL DEFAULT 'reserved'
    CHECK (status IN ('reserved', 'consumed')),
  expires_at timestamptz,
  authorization_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(authorization_snapshot) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  consumed_at timestamptz,
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, table_session_id)
    REFERENCES mbox.table_sessions(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, order_id)
    REFERENCES mbox.orders(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, authorized_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, benefit_id)
    REFERENCES mbox.benefits(tenant_id, store_id, id),
  CHECK (
    (source_type = 'employee'
      AND authorized_by_employee_id IS NOT NULL
      AND capability IN ('order.discount', 'order.gift')
      AND role_approval_limit_id = source_id
      AND benefit_id IS NULL)
    OR
    (source_type = 'benefit'
      AND capability IS NULL
      AND benefit_id = source_id
      AND role_approval_limit_id IS NULL)
  ),
  CHECK (
    (status = 'reserved' AND order_id IS NULL AND consumed_at IS NULL)
    OR
    (status = 'consumed' AND order_id IS NOT NULL AND consumed_at IS NOT NULL)
  ),
  UNIQUE (tenant_id, store_id, table_session_id, source_type, source_id),
  UNIQUE (tenant_id, store_id, order_id),
  UNIQUE (tenant_id, store_id, id)
);

CREATE INDEX pricing_authorizations_source_idx
  ON mbox.pricing_authorizations (tenant_id, store_id, source_type, source_id, created_at DESC);

ALTER TABLE mbox.table_session_customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.table_session_customers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.table_session_customers
  USING (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id())
  WITH CHECK (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id());

ALTER TABLE mbox.pricing_authorizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.pricing_authorizations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.pricing_authorizations
  USING (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id())
  WITH CHECK (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id());

REVOKE ALL ON TABLE mbox.table_session_customers FROM PUBLIC;
REVOKE ALL ON TABLE mbox.pricing_authorizations FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE mbox.table_session_customers TO mbox_runtime;
GRANT SELECT, INSERT, UPDATE ON TABLE mbox.pricing_authorizations TO mbox_runtime;

COMMENT ON TABLE mbox.pricing_authorizations IS
  'Server-issued, table-scoped pricing authority. A source can be consumed at most once per table session.';
COMMENT ON TABLE mbox.table_session_customers IS
  'Normalized proof that a customer belongs to a table session; required before a benefit can affect an order.';

COMMIT;
