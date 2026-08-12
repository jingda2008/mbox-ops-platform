BEGIN;

CREATE TABLE mbox.payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  order_id uuid NOT NULL,
  public_id text NOT NULL CHECK (length(public_id) BETWEEN 8 AND 128),
  provider text NOT NULL CHECK (provider IN ('wechat', 'postar', 'cash', 'physical_pos', 'simulation')),
  provider_transaction_id text,
  method text NOT NULL CHECK (method IN ('jsapi', 'native_qr', 'auth_code', 'cash', 'card', 'manual')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL DEFAULT 'CNY' CHECK (currency ~ '^[A-Z]{3}$'),
  status text NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'pending', 'succeeded', 'failed', 'closed', 'partially_refunded', 'refunded')),
  provider_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(provider_snapshot) = 'object'),
  succeeded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, order_id) REFERENCES mbox.orders(tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, public_id),
  UNIQUE (tenant_id, store_id, id)
);
CREATE UNIQUE INDEX payments_provider_transaction_uq
  ON mbox.payments (tenant_id, store_id, provider, provider_transaction_id)
  WHERE provider_transaction_id IS NOT NULL;
CREATE INDEX payments_order_idx ON mbox.payments (tenant_id, store_id, order_id, created_at, id);

CREATE TABLE mbox.refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  payment_id uuid NOT NULL,
  public_id text NOT NULL CHECK (length(public_id) BETWEEN 8 AND 128),
  provider_refund_id text,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL DEFAULT 'CNY' CHECK (currency ~ '^[A-Z]{3}$'),
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'approved', 'rejected', 'processing', 'succeeded', 'failed', 'cancelled')),
  reason text NOT NULL CHECK (length(btrim(reason)) > 0),
  requested_by_employee_id uuid NOT NULL,
  approved_by_employee_id uuid,
  provider_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(provider_snapshot) = 'object'),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, payment_id) REFERENCES mbox.payments(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, requested_by_employee_id) REFERENCES mbox.employees(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, approved_by_employee_id) REFERENCES mbox.employees(tenant_id, store_id, id),
  CHECK (approved_by_employee_id IS NULL OR approved_by_employee_id <> requested_by_employee_id),
  UNIQUE (tenant_id, store_id, public_id),
  UNIQUE (tenant_id, store_id, id)
);
CREATE UNIQUE INDEX refunds_provider_refund_uq
  ON mbox.refunds (tenant_id, store_id, provider_refund_id)
  WHERE provider_refund_id IS NOT NULL;
CREATE INDEX refunds_approval_queue_idx
  ON mbox.refunds (tenant_id, store_id, created_at, id) WHERE status = 'requested';

CREATE TABLE mbox.refund_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  refund_id uuid NOT NULL,
  order_item_id uuid NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, refund_id) REFERENCES mbox.refunds(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, order_item_id) REFERENCES mbox.order_items(tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, refund_id, order_item_id),
  UNIQUE (tenant_id, store_id, id)
);
CREATE INDEX refund_items_order_item_idx
  ON mbox.refund_items (tenant_id, store_id, order_item_id, created_at, id);
CREATE TRIGGER refund_items_append_only
  BEFORE UPDATE OR DELETE ON mbox.refund_items
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();

CREATE TABLE mbox.reconciliation_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  payment_id uuid,
  refund_id uuid,
  entry_type text NOT NULL CHECK (entry_type IN ('payment', 'refund', 'fee', 'adjustment')),
  provider text NOT NULL,
  provider_reference text NOT NULL,
  amount_minor bigint NOT NULL,
  currency char(3) NOT NULL DEFAULT 'CNY' CHECK (currency ~ '^[A-Z]{3}$'),
  business_date date NOT NULL,
  occurred_at timestamptz NOT NULL,
  evidence_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence_snapshot) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, payment_id) REFERENCES mbox.payments(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, refund_id) REFERENCES mbox.refunds(tenant_id, store_id, id),
  CHECK (payment_id IS NOT NULL OR refund_id IS NOT NULL OR entry_type IN ('fee', 'adjustment')),
  UNIQUE (tenant_id, store_id, provider, provider_reference, entry_type),
  UNIQUE (tenant_id, store_id, id)
);
CREATE INDEX reconciliation_business_date_idx
  ON mbox.reconciliation_entries (tenant_id, store_id, business_date, occurred_at, id);
CREATE TRIGGER reconciliation_entries_append_only
  BEFORE UPDATE OR DELETE ON mbox.reconciliation_entries
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();

CREATE TABLE mbox.reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  public_id text NOT NULL CHECK (length(public_id) BETWEEN 8 AND 128),
  customer_id uuid,
  customer_name text NOT NULL CHECK (length(btrim(customer_name)) > 0),
  contact_token text NOT NULL CHECK (length(btrim(contact_token)) > 0),
  guest_count integer NOT NULL CHECK (guest_count > 0 AND guest_count <= 200),
  arrival_at timestamptz NOT NULL,
  expected_end_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'arrived', 'seated', 'completed', 'cancelled', 'no_show')),
  source text NOT NULL CHECK (source IN ('wechat', 'phone', 'walk_in', 'employee', 'integration')),
  owner_employee_id uuid,
  note text,
  reservation_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(reservation_snapshot) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, owner_employee_id) REFERENCES mbox.employees(tenant_id, store_id, id),
  CHECK (expected_end_at > arrival_at),
  UNIQUE (tenant_id, store_id, public_id),
  UNIQUE (tenant_id, store_id, id)
);
CREATE INDEX reservations_arrival_queue_idx
  ON mbox.reservations (tenant_id, store_id, arrival_at, status, id);

CREATE TABLE mbox.reservation_table_locks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  reservation_id uuid NOT NULL,
  table_id uuid NOT NULL,
  reserved_during tstzrange NOT NULL,
  status text NOT NULL DEFAULT 'held' CHECK (status IN ('held', 'confirmed', 'released', 'expired', 'cancelled')),
  hold_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, reservation_id) REFERENCES mbox.reservations(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, table_id) REFERENCES mbox.tables(tenant_id, store_id, id),
  CHECK (NOT isempty(reserved_during) AND lower_inc(reserved_during) AND NOT upper_inc(reserved_during)),
  CHECK (status <> 'held' OR hold_expires_at IS NOT NULL),
  EXCLUDE USING gist (
    tenant_id WITH =,
    store_id WITH =,
    table_id WITH =,
    reserved_during WITH &&
  ) WHERE (status IN ('held', 'confirmed')),
  UNIQUE (tenant_id, store_id, id)
);
CREATE INDEX reservation_locks_expiry_claim_idx
  ON mbox.reservation_table_locks (hold_expires_at, created_at, id)
  WHERE status = 'held';

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['payments','refunds','reservations','reservation_table_locks']
  LOOP
    EXECUTE format('CREATE TRIGGER %I_touch_updated_at BEFORE UPDATE ON mbox.%I FOR EACH ROW EXECUTE FUNCTION mbox.touch_updated_at()', table_name, table_name);
  END LOOP;
END $$;

COMMIT;
