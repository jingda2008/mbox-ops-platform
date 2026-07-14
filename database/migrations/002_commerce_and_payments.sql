BEGIN;

CREATE TABLE mbox.products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  sku text NOT NULL,
  name text NOT NULL,
  category_code text NOT NULL,
  production_station text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'retired')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  CONSTRAINT products_sku_format CHECK (sku ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$'),
  CONSTRAINT products_tenant_store_sku_uq UNIQUE (tenant_id, store_id, sku),
  CONSTRAINT products_tenant_store_id_uq UNIQUE (tenant_id, store_id, id)
);

CREATE INDEX products_catalog_idx
  ON mbox.products (tenant_id, store_id, status, category_code, name);

CREATE TRIGGER products_touch_version
BEFORE UPDATE ON mbox.products
FOR EACH ROW EXECUTE FUNCTION mbox.touch_versioned_row();

CREATE TABLE mbox.product_prices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  product_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  valid_from timestamptz NOT NULL,
  valid_to timestamptz,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'retired')),
  created_by_employee_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  activated_at timestamptz,
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, product_id) REFERENCES mbox.products(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, created_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  CONSTRAINT product_prices_range_order CHECK (valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT product_prices_activation_fields CHECK (status <> 'active' OR activated_at IS NOT NULL),
  CONSTRAINT product_prices_product_version_uq UNIQUE (tenant_id, store_id, product_id, version),
  CONSTRAINT product_prices_tenant_store_id_uq UNIQUE (tenant_id, store_id, id)
);

CREATE INDEX product_prices_lookup_idx
  ON mbox.product_prices (tenant_id, store_id, product_id, status, valid_from DESC);

CREATE OR REPLACE FUNCTION mbox.validate_product_price()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status IN ('active', 'retired') AND (
    NEW.product_id IS DISTINCT FROM OLD.product_id OR
    NEW.version IS DISTINCT FROM OLD.version OR
    NEW.amount_minor IS DISTINCT FROM OLD.amount_minor OR
    NEW.currency IS DISTINCT FROM OLD.currency OR
    NEW.valid_from IS DISTINCT FROM OLD.valid_from OR
    NEW.valid_to IS DISTINCT FROM OLD.valid_to
  ) THEN
    RAISE EXCEPTION 'an active or retired price version is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' AND NOT (
    NEW.status = OLD.status OR
    (OLD.status = 'draft' AND NEW.status IN ('active', 'retired')) OR
    (OLD.status = 'active' AND NEW.status = 'retired')
  ) THEN
    RAISE EXCEPTION 'invalid product price transition: % -> %', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status = 'active' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.product_id::text, 0));
    IF EXISTS (
      SELECT 1
      FROM mbox.product_prices p
      WHERE p.tenant_id = NEW.tenant_id
        AND p.store_id = NEW.store_id
        AND p.product_id = NEW.product_id
        AND p.status = 'active'
        AND p.id <> NEW.id
        AND tstzrange(p.valid_from, p.valid_to, '[)') && tstzrange(NEW.valid_from, NEW.valid_to, '[)')
    ) THEN
      RAISE EXCEPTION 'active price ranges may not overlap for product %', NEW.product_id
        USING ERRCODE = '23P01';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER product_prices_validate
BEFORE INSERT OR UPDATE ON mbox.product_prices
FOR EACH ROW EXECUTE FUNCTION mbox.validate_product_price();

CREATE TABLE mbox.orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  table_session_id uuid NOT NULL,
  order_number text NOT NULL,
  source text NOT NULL CHECK (source IN ('guest', 'employee', 'pos', 'integration', 'system')),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'submitted', 'authorized', 'fulfilling', 'completed', 'cancelled', 'partially_refunded', 'refunded')),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  subtotal_amount_minor bigint NOT NULL DEFAULT 0 CHECK (subtotal_amount_minor >= 0),
  discount_amount_minor bigint NOT NULL DEFAULT 0 CHECK (discount_amount_minor >= 0),
  tax_amount_minor bigint NOT NULL DEFAULT 0 CHECK (tax_amount_minor >= 0),
  total_amount_minor bigint NOT NULL DEFAULT 0 CHECK (total_amount_minor >= 0),
  config_version_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  external_source text,
  external_order_id text,
  submitted_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  created_by_employee_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, table_session_id)
    REFERENCES mbox.table_sessions(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, config_version_id)
    REFERENCES mbox.config_versions(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, created_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  CONSTRAINT orders_total_equation CHECK (
    total_amount_minor = subtotal_amount_minor - discount_amount_minor + tax_amount_minor
  ),
  CONSTRAINT orders_discount_limit CHECK (discount_amount_minor <= subtotal_amount_minor + tax_amount_minor),
  CONSTRAINT orders_external_pair CHECK (
    (external_source IS NULL AND external_order_id IS NULL) OR
    (external_source IS NOT NULL AND external_order_id IS NOT NULL)
  ),
  CONSTRAINT orders_store_number_uq UNIQUE (tenant_id, store_id, order_number),
  CONSTRAINT orders_idempotency_uq UNIQUE (tenant_id, store_id, idempotency_key),
  CONSTRAINT orders_tenant_store_id_uq UNIQUE (tenant_id, store_id, id)
);

CREATE UNIQUE INDEX orders_external_source_uq
  ON mbox.orders (tenant_id, store_id, external_source, external_order_id)
  WHERE external_source IS NOT NULL;
CREATE INDEX orders_session_timeline_idx
  ON mbox.orders (tenant_id, store_id, table_session_id, created_at DESC);
CREATE INDEX orders_business_queue_idx
  ON mbox.orders (tenant_id, store_id, status, submitted_at)
  WHERE status IN ('submitted', 'authorized', 'fulfilling');

CREATE OR REPLACE FUNCTION mbox.validate_order_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  IF NOT (
    (OLD.status = 'draft' AND NEW.status IN ('submitted', 'cancelled')) OR
    (OLD.status = 'submitted' AND NEW.status IN ('authorized', 'cancelled')) OR
    (OLD.status = 'authorized' AND NEW.status IN ('fulfilling', 'completed', 'cancelled')) OR
    (OLD.status = 'fulfilling' AND NEW.status IN ('completed', 'cancelled')) OR
    (OLD.status = 'completed' AND NEW.status IN ('partially_refunded', 'refunded')) OR
    (OLD.status = 'partially_refunded' AND NEW.status = 'refunded')
  ) THEN
    RAISE EXCEPTION 'invalid order transition: % -> %', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER orders_validate_transition
BEFORE UPDATE OF status ON mbox.orders
FOR EACH ROW EXECUTE FUNCTION mbox.validate_order_transition();

CREATE TRIGGER orders_touch_version
BEFORE UPDATE ON mbox.orders
FOR EACH ROW EXECUTE FUNCTION mbox.touch_versioned_row();

CREATE TABLE mbox.order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  order_id uuid NOT NULL,
  product_id uuid NOT NULL,
  price_version_id uuid NOT NULL,
  sku_snapshot text NOT NULL,
  name_snapshot text NOT NULL,
  unit_price_amount_minor bigint NOT NULL CHECK (unit_price_amount_minor >= 0),
  quantity integer NOT NULL CHECK (quantity > 0 AND quantity <= 999),
  discount_amount_minor bigint NOT NULL DEFAULT 0 CHECK (discount_amount_minor >= 0),
  tax_amount_minor bigint NOT NULL DEFAULT 0 CHECK (tax_amount_minor >= 0),
  line_total_amount_minor bigint GENERATED ALWAYS AS
    ((unit_price_amount_minor * quantity::bigint) - discount_amount_minor + tax_amount_minor) STORED,
  fulfillment_status text NOT NULL DEFAULT 'pending'
    CHECK (fulfillment_status IN ('pending', 'routed', 'preparing', 'ready', 'delivered', 'cancelled', 'partially_refunded', 'refunded')),
  station_snapshot text,
  notes text NOT NULL DEFAULT '' CHECK (length(notes) <= 500),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, order_id) REFERENCES mbox.orders(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, product_id) REFERENCES mbox.products(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, price_version_id)
    REFERENCES mbox.product_prices(tenant_id, store_id, id),
  CONSTRAINT order_items_total_nonnegative CHECK (line_total_amount_minor >= 0),
  CONSTRAINT order_items_tenant_store_id_uq UNIQUE (tenant_id, store_id, id)
);

CREATE INDEX order_items_order_idx ON mbox.order_items (tenant_id, store_id, order_id, id);
CREATE INDEX order_items_fulfillment_idx
  ON mbox.order_items (tenant_id, store_id, fulfillment_status, station_snapshot, created_at)
  WHERE fulfillment_status IN ('pending', 'routed', 'preparing', 'ready');

CREATE TRIGGER order_items_touch_version
BEFORE UPDATE ON mbox.order_items
FOR EACH ROW EXECUTE FUNCTION mbox.touch_versioned_row();

CREATE TABLE mbox.table_ledgers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  table_session_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'settling', 'settled', 'closed', 'void')),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  debit_total_amount_minor bigint NOT NULL DEFAULT 0 CHECK (debit_total_amount_minor >= 0),
  credit_total_amount_minor bigint NOT NULL DEFAULT 0 CHECK (credit_total_amount_minor >= 0),
  balance_amount_minor bigint GENERATED ALWAYS AS
    (debit_total_amount_minor - credit_total_amount_minor) STORED,
  opened_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  settled_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, table_session_id)
    REFERENCES mbox.table_sessions(tenant_id, store_id, id),
  CONSTRAINT table_ledgers_session_uq UNIQUE (tenant_id, store_id, table_session_id),
  CONSTRAINT table_ledgers_tenant_store_id_uq UNIQUE (tenant_id, store_id, id)
);

CREATE INDEX table_ledgers_open_idx
  ON mbox.table_ledgers (tenant_id, store_id, status, opened_at)
  WHERE status IN ('open', 'settling');

CREATE TRIGGER table_ledgers_touch_version
BEFORE UPDATE ON mbox.table_ledgers
FOR EACH ROW EXECUTE FUNCTION mbox.touch_versioned_row();

CREATE TABLE mbox.ledger_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  ledger_id uuid NOT NULL,
  sequence_no bigint NOT NULL CHECK (sequence_no > 0),
  entry_type text NOT NULL
    CHECK (entry_type IN ('order_charge', 'discount', 'payment', 'refund', 'adjustment', 'minimum_spend', 'transfer_in', 'transfer_out')),
  direction text NOT NULL CHECK (direction IN ('debit', 'credit')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  reference_type text NOT NULL,
  reference_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  business_date date NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by_type text NOT NULL CHECK (created_by_type IN ('employee', 'system', 'integration')),
  created_by_employee_id uuid,
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 500),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, ledger_id) REFERENCES mbox.table_ledgers(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, created_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  CONSTRAINT ledger_entries_actor_check CHECK (
    (created_by_type = 'employee' AND created_by_employee_id IS NOT NULL) OR
    (created_by_type <> 'employee' AND created_by_employee_id IS NULL)
  ),
  CONSTRAINT ledger_entries_reference_type_format CHECK (reference_type ~ '^[a-z][a-z0-9_.-]{1,63}$'),
  CONSTRAINT ledger_entries_sequence_uq UNIQUE (tenant_id, store_id, ledger_id, sequence_no),
  CONSTRAINT ledger_entries_reference_uq UNIQUE (tenant_id, store_id, ledger_id, reference_type, reference_id),
  CONSTRAINT ledger_entries_idempotency_uq UNIQUE (tenant_id, store_id, idempotency_key),
  CONSTRAINT ledger_entries_tenant_store_id_uq UNIQUE (tenant_id, store_id, id)
);

CREATE INDEX ledger_entries_timeline_idx
  ON mbox.ledger_entries (tenant_id, store_id, ledger_id, sequence_no);
CREATE INDEX ledger_entries_business_date_idx
  ON mbox.ledger_entries (tenant_id, store_id, business_date, occurred_at, id);

CREATE TABLE mbox.approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  approval_type text NOT NULL CHECK (approval_type IN ('refund', 'discount', 'void', 'writeoff', 'manual_payment')),
  object_type text NOT NULL,
  object_id uuid NOT NULL,
  requester_employee_id uuid NOT NULL,
  approver_employee_id uuid,
  rule_config_version_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'approved', 'rejected', 'cancelled', 'expired')),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 1000),
  decision_note text,
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  decided_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, requester_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, approver_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, rule_config_version_id)
    REFERENCES mbox.config_versions(tenant_id, store_id, id),
  CONSTRAINT approvals_decision_fields CHECK (
    (status = 'requested' AND decided_at IS NULL) OR
    (status <> 'requested' AND decided_at IS NOT NULL)
  ),
  CONSTRAINT approvals_tenant_store_id_uq UNIQUE (tenant_id, store_id, id)
);

CREATE INDEX approvals_pending_idx
  ON mbox.approvals (tenant_id, store_id, approval_type, requested_at)
  WHERE status = 'requested';

CREATE TRIGGER approvals_touch_version
BEFORE UPDATE ON mbox.approvals
FOR EACH ROW EXECUTE FUNCTION mbox.touch_versioned_row();

CREATE OR REPLACE FUNCTION mbox.validate_approval_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  IF OLD.status <> 'requested' OR NEW.status NOT IN ('approved', 'rejected', 'cancelled', 'expired') THEN
    RAISE EXCEPTION 'invalid approval transition: % -> %', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER approvals_validate_transition
BEFORE UPDATE OF status ON mbox.approvals
FOR EACH ROW EXECUTE FUNCTION mbox.validate_approval_transition();

CREATE TABLE mbox.payment_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  ledger_id uuid NOT NULL,
  order_id uuid,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status text NOT NULL DEFAULT 'created'
    CHECK (status IN ('created', 'processing', 'succeeded', 'failed', 'expired', 'cancelled')),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  expires_at timestamptz NOT NULL,
  succeeded_at timestamptz,
  created_by_type text NOT NULL CHECK (created_by_type IN ('guest', 'employee', 'system', 'integration')),
  created_by_employee_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, ledger_id) REFERENCES mbox.table_ledgers(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, order_id) REFERENCES mbox.orders(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, created_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  CONSTRAINT payment_intents_actor_check CHECK (
    (created_by_type = 'employee' AND created_by_employee_id IS NOT NULL) OR
    (created_by_type <> 'employee' AND created_by_employee_id IS NULL)
  ),
  CONSTRAINT payment_intents_expiry_order CHECK (expires_at > created_at),
  CONSTRAINT payment_intents_success_time CHECK (status <> 'succeeded' OR succeeded_at IS NOT NULL),
  CONSTRAINT payment_intents_idempotency_uq UNIQUE (tenant_id, store_id, idempotency_key),
  CONSTRAINT payment_intents_tenant_store_id_uq UNIQUE (tenant_id, store_id, id)
);

CREATE INDEX payment_intents_ledger_idx
  ON mbox.payment_intents (tenant_id, store_id, ledger_id, status, created_at DESC);
CREATE INDEX payment_intents_expiry_idx
  ON mbox.payment_intents (expires_at)
  WHERE status IN ('created', 'processing');

CREATE OR REPLACE FUNCTION mbox.validate_payment_intent_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  IF NOT (
    (OLD.status = 'created' AND NEW.status IN ('processing', 'expired', 'cancelled')) OR
    (OLD.status = 'processing' AND NEW.status IN ('succeeded', 'failed', 'expired', 'cancelled')) OR
    (OLD.status = 'failed' AND NEW.status = 'processing')
  ) THEN
    RAISE EXCEPTION 'invalid payment intent transition: % -> %', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER payment_intents_validate_transition
BEFORE UPDATE OF status ON mbox.payment_intents
FOR EACH ROW EXECUTE FUNCTION mbox.validate_payment_intent_transition();

CREATE TRIGGER payment_intents_touch_version
BEFORE UPDATE ON mbox.payment_intents
FOR EACH ROW EXECUTE FUNCTION mbox.touch_versioned_row();

CREATE TABLE mbox.payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  payment_intent_id uuid NOT NULL,
  provider text NOT NULL,
  provider_transaction_id text,
  attempt_no integer NOT NULL CHECK (attempt_no > 0),
  status text NOT NULL DEFAULT 'created'
    CHECK (status IN ('created', 'processing', 'succeeded', 'failed', 'cancelled')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  provider_response jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(provider_response) = 'object'),
  succeeded_at timestamptz,
  failed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, payment_intent_id)
    REFERENCES mbox.payment_intents(tenant_id, store_id, id),
  CONSTRAINT payments_provider_format CHECK (provider ~ '^[a-z][a-z0-9_.-]{1,31}$'),
  CONSTRAINT payments_status_time CHECK (
    (status <> 'succeeded' OR succeeded_at IS NOT NULL) AND
    (status <> 'failed' OR failed_at IS NOT NULL)
  ),
  CONSTRAINT payments_attempt_uq UNIQUE (tenant_id, store_id, payment_intent_id, attempt_no),
  CONSTRAINT payments_idempotency_uq UNIQUE (tenant_id, store_id, idempotency_key),
  CONSTRAINT payments_tenant_store_id_uq UNIQUE (tenant_id, store_id, id)
);

CREATE UNIQUE INDEX payments_provider_transaction_uq
  ON mbox.payments (tenant_id, store_id, provider, provider_transaction_id)
  WHERE provider_transaction_id IS NOT NULL;
CREATE UNIQUE INDEX payments_one_success_per_intent_uq
  ON mbox.payments (tenant_id, store_id, payment_intent_id)
  WHERE status = 'succeeded';
CREATE INDEX payments_intent_idx
  ON mbox.payments (tenant_id, store_id, payment_intent_id, status, attempt_no DESC);

CREATE OR REPLACE FUNCTION mbox.validate_payment_amount()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  intent_amount bigint;
  intent_currency char(3);
BEGIN
  SELECT amount_minor, currency
    INTO intent_amount, intent_currency
  FROM mbox.payment_intents
  WHERE tenant_id = NEW.tenant_id
    AND store_id = NEW.store_id
    AND id = NEW.payment_intent_id;

  IF intent_amount IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.amount_minor <> intent_amount OR NEW.currency <> intent_currency THEN
    RAISE EXCEPTION 'payment amount/currency must match its payment intent'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER payments_validate_amount
BEFORE INSERT OR UPDATE OF payment_intent_id, amount_minor, currency ON mbox.payments
FOR EACH ROW EXECUTE FUNCTION mbox.validate_payment_amount();

CREATE OR REPLACE FUNCTION mbox.validate_payment_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  IF NOT (
    (OLD.status = 'created' AND NEW.status IN ('processing', 'failed', 'cancelled')) OR
    (OLD.status = 'processing' AND NEW.status IN ('succeeded', 'failed', 'cancelled')) OR
    (OLD.status = 'failed' AND NEW.status = 'processing')
  ) THEN
    RAISE EXCEPTION 'invalid payment transition: % -> %', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER payments_validate_transition
BEFORE UPDATE OF status ON mbox.payments
FOR EACH ROW EXECUTE FUNCTION mbox.validate_payment_transition();

CREATE TRIGGER payments_touch_version
BEFORE UPDATE ON mbox.payments
FOR EACH ROW EXECUTE FUNCTION mbox.touch_versioned_row();

CREATE TABLE mbox.payment_provider_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  payment_id uuid,
  provider text NOT NULL,
  provider_event_id text NOT NULL,
  provider_transaction_id text,
  signature_verified boolean NOT NULL DEFAULT false,
  processing_status text NOT NULL DEFAULT 'received'
    CHECK (processing_status IN ('received', 'processed', 'ignored', 'failed')),
  payload_sha256 char(64) NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  processed_at timestamptz,
  error_message text,
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, payment_id) REFERENCES mbox.payments(tenant_id, store_id, id),
  CONSTRAINT payment_provider_events_provider_format CHECK (provider ~ '^[a-z][a-z0-9_.-]{1,31}$'),
  CONSTRAINT payment_provider_events_dedupe_uq
    UNIQUE (tenant_id, store_id, provider, provider_event_id),
  CONSTRAINT payment_provider_events_tenant_store_id_uq UNIQUE (tenant_id, store_id, id)
);

CREATE INDEX payment_provider_events_unprocessed_idx
  ON mbox.payment_provider_events (tenant_id, store_id, received_at)
  WHERE processing_status = 'received';

CREATE TABLE mbox.refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  payment_id uuid NOT NULL,
  approval_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'approved', 'processing', 'succeeded', 'failed', 'cancelled')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  reason_code text NOT NULL,
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 1000),
  provider_refund_id text,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  requested_by_employee_id uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  succeeded_at timestamptz,
  failed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, payment_id) REFERENCES mbox.payments(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, approval_id) REFERENCES mbox.approvals(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, requested_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  CONSTRAINT refunds_status_time CHECK (
    (status <> 'succeeded' OR succeeded_at IS NOT NULL) AND
    (status <> 'failed' OR failed_at IS NOT NULL)
  ),
  CONSTRAINT refunds_idempotency_uq UNIQUE (tenant_id, store_id, idempotency_key),
  CONSTRAINT refunds_tenant_store_id_uq UNIQUE (tenant_id, store_id, id)
);

CREATE UNIQUE INDEX refunds_provider_refund_uq
  ON mbox.refunds (tenant_id, store_id, provider_refund_id)
  WHERE provider_refund_id IS NOT NULL;
CREATE INDEX refunds_payment_idx
  ON mbox.refunds (tenant_id, store_id, payment_id, status, requested_at DESC);
CREATE INDEX refunds_processing_idx
  ON mbox.refunds (tenant_id, store_id, status, requested_at)
  WHERE status IN ('approved', 'processing');

CREATE OR REPLACE FUNCTION mbox.validate_refund()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  payment_amount bigint;
  payment_currency char(3);
  payment_status text;
  reserved_amount bigint;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status <> OLD.status AND NOT (
    (OLD.status = 'requested' AND NEW.status IN ('approved', 'cancelled', 'failed')) OR
    (OLD.status = 'approved' AND NEW.status IN ('processing', 'cancelled', 'failed')) OR
    (OLD.status = 'processing' AND NEW.status IN ('succeeded', 'failed')) OR
    (OLD.status = 'failed' AND NEW.status = 'processing')
  ) THEN
    RAISE EXCEPTION 'invalid refund transition: % -> %', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.payment_id::text, 0));

  SELECT amount_minor, currency, status
    INTO payment_amount, payment_currency, payment_status
  FROM mbox.payments
  WHERE tenant_id = NEW.tenant_id
    AND store_id = NEW.store_id
    AND id = NEW.payment_id;

  IF payment_amount IS NULL THEN
    RETURN NEW;
  END IF;

  IF payment_status <> 'succeeded' THEN
    RAISE EXCEPTION 'refunds require a succeeded payment'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.currency <> payment_currency THEN
    RAISE EXCEPTION 'refund currency % does not match payment currency %', NEW.currency, payment_currency
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status IN ('requested', 'approved', 'processing', 'succeeded') THEN
    SELECT COALESCE(sum(r.amount_minor), 0)
      INTO reserved_amount
    FROM mbox.refunds r
    WHERE r.tenant_id = NEW.tenant_id
      AND r.store_id = NEW.store_id
      AND r.payment_id = NEW.payment_id
      AND r.id <> NEW.id
      AND r.status IN ('requested', 'approved', 'processing', 'succeeded');

    IF reserved_amount + NEW.amount_minor > payment_amount THEN
      RAISE EXCEPTION 'total active refunds exceed payment amount'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER refunds_validate
BEFORE INSERT OR UPDATE ON mbox.refunds
FOR EACH ROW EXECUTE FUNCTION mbox.validate_refund();

CREATE TRIGGER refunds_touch_version
BEFORE UPDATE ON mbox.refunds
FOR EACH ROW EXECUTE FUNCTION mbox.touch_versioned_row();

CREATE TABLE mbox.refund_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  refund_id uuid NOT NULL,
  order_item_id uuid NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, refund_id) REFERENCES mbox.refunds(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, order_item_id) REFERENCES mbox.order_items(tenant_id, store_id, id),
  CONSTRAINT refund_items_refund_order_item_uq
    UNIQUE (tenant_id, store_id, refund_id, order_item_id),
  CONSTRAINT refund_items_tenant_store_id_uq UNIQUE (tenant_id, store_id, id)
);

CREATE INDEX refund_items_order_item_idx
  ON mbox.refund_items (tenant_id, store_id, order_item_id, refund_id);

CREATE OR REPLACE FUNCTION mbox.validate_refund_item()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  refund_amount bigint;
  allocated_amount bigint;
  ordered_quantity integer;
  refunded_quantity bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.refund_id::text, 0));

  SELECT amount_minor INTO refund_amount
  FROM mbox.refunds
  WHERE tenant_id = NEW.tenant_id AND store_id = NEW.store_id AND id = NEW.refund_id;

  SELECT COALESCE(sum(amount_minor), 0) INTO allocated_amount
  FROM mbox.refund_items
  WHERE tenant_id = NEW.tenant_id
    AND store_id = NEW.store_id
    AND refund_id = NEW.refund_id
    AND id <> NEW.id;

  IF allocated_amount + NEW.amount_minor > refund_amount THEN
    RAISE EXCEPTION 'refund item allocation exceeds refund amount'
      USING ERRCODE = '23514';
  END IF;

  SELECT quantity INTO ordered_quantity
  FROM mbox.order_items
  WHERE tenant_id = NEW.tenant_id AND store_id = NEW.store_id AND id = NEW.order_item_id;

  SELECT COALESCE(sum(ri.quantity), 0) INTO refunded_quantity
  FROM mbox.refund_items ri
  JOIN mbox.refunds r
    ON r.tenant_id = ri.tenant_id AND r.store_id = ri.store_id AND r.id = ri.refund_id
  WHERE ri.tenant_id = NEW.tenant_id
    AND ri.store_id = NEW.store_id
    AND ri.order_item_id = NEW.order_item_id
    AND ri.id <> NEW.id
    AND r.status IN ('requested', 'approved', 'processing', 'succeeded');

  IF refunded_quantity + NEW.quantity > ordered_quantity THEN
    RAISE EXCEPTION 'refunded quantity exceeds ordered quantity'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER refund_items_validate
BEFORE INSERT OR UPDATE ON mbox.refund_items
FOR EACH ROW EXECUTE FUNCTION mbox.validate_refund_item();

COMMIT;
