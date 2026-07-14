BEGIN;

CREATE TABLE mbox.reservation_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  code text NOT NULL CHECK (code ~ '^[a-z][a-z0-9_.-]{0,63}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  enabled boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  config_version integer NOT NULL CHECK (config_version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  CONSTRAINT reservation_sources_code_uq UNIQUE (tenant_id, store_id, code),
  CONSTRAINT reservation_sources_tenant_store_id_uq UNIQUE (tenant_id, store_id, id)
);

CREATE TABLE mbox.reservation_occasion_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  code text NOT NULL CHECK (code ~ '^[a-z][a-z0-9_.-]{0,63}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  service_script jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(service_script) = 'array'),
  enabled boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  config_version integer NOT NULL CHECK (config_version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  CONSTRAINT reservation_occasion_types_code_uq UNIQUE (tenant_id, store_id, code),
  CONSTRAINT reservation_occasion_types_tenant_store_id_uq UNIQUE (tenant_id, store_id, id)
);

CREATE TABLE mbox.reservation_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  code text NOT NULL CHECK (code ~ '^[a-z][a-z0-9_.-]{0,63}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  minimum_party_size integer NOT NULL CHECK (minimum_party_size BETWEEN 1 AND 100),
  maximum_party_size integer NOT NULL CHECK (maximum_party_size BETWEEN minimum_party_size AND 100),
  no_show_grace_minutes integer NOT NULL DEFAULT 30 CHECK (no_show_grace_minutes BETWEEN 0 AND 240),
  enabled boolean NOT NULL DEFAULT true,
  config_version integer NOT NULL CHECK (config_version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  CONSTRAINT reservation_policies_code_uq UNIQUE (tenant_id, store_id, code),
  CONSTRAINT reservation_policies_tenant_store_id_uq UNIQUE (tenant_id, store_id, id)
);

CREATE TRIGGER reservation_sources_touch_version
BEFORE UPDATE ON mbox.reservation_sources
FOR EACH ROW EXECUTE FUNCTION mbox.touch_versioned_row();

CREATE TRIGGER reservation_occasion_types_touch_version
BEFORE UPDATE ON mbox.reservation_occasion_types
FOR EACH ROW EXECUTE FUNCTION mbox.touch_versioned_row();

CREATE TRIGGER reservation_policies_touch_version
BEFORE UPDATE ON mbox.reservation_policies
FOR EACH ROW EXECUTE FUNCTION mbox.touch_versioned_row();

CREATE TABLE mbox.reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  policy_id uuid NOT NULL,
  source_id uuid NOT NULL,
  customer_member_id uuid,
  customer_reference text NOT NULL CHECK (length(customer_reference) BETWEEN 1 AND 256),
  customer_name text NOT NULL CHECK (length(customer_name) BETWEEN 1 AND 100),
  contact_reference text NOT NULL CHECK (length(contact_reference) BETWEEN 1 AND 512),
  party_size integer NOT NULL CHECK (party_size BETWEEN 1 AND 100),
  area_preference_id uuid,
  occasion_type_id uuid,
  occasion_note text NOT NULL DEFAULT '' CHECK (length(occasion_note) <= 500),
  scheduled_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'requested' CHECK (
    status IN ('requested', 'confirmed', 'arrived', 'seated', 'cancelled', 'no_show')
  ),
  table_id uuid,
  table_session_id uuid,
  requested_at timestamptz NOT NULL,
  confirmed_at timestamptz,
  arrived_at timestamptz,
  seated_at timestamptz,
  cancelled_at timestamptz,
  no_show_at timestamptz,
  cancellation_reason text CHECK (cancellation_reason IS NULL OR length(cancellation_reason) BETWEEN 1 AND 500),
  created_by_employee_id uuid NOT NULL,
  config_version integer NOT NULL CHECK (config_version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, policy_id)
    REFERENCES mbox.reservation_policies(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, source_id)
    REFERENCES mbox.reservation_sources(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, customer_member_id)
    REFERENCES mbox.customer_members(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, area_preference_id)
    REFERENCES mbox.areas(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, occasion_type_id)
    REFERENCES mbox.reservation_occasion_types(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, table_id)
    REFERENCES mbox.venue_tables(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, table_session_id)
    REFERENCES mbox.table_sessions(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, created_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  CONSTRAINT reservations_tenant_store_id_uq UNIQUE (tenant_id, store_id, id),
  CONSTRAINT reservations_table_binding_uq UNIQUE (tenant_id, store_id, table_session_id),
  CONSTRAINT reservations_status_shape CHECK (
    (
      status = 'requested'
      AND confirmed_at IS NULL AND arrived_at IS NULL AND seated_at IS NULL
      AND cancelled_at IS NULL AND no_show_at IS NULL
      AND table_id IS NULL AND table_session_id IS NULL AND cancellation_reason IS NULL
    ) OR (
      status = 'confirmed'
      AND confirmed_at IS NOT NULL AND arrived_at IS NULL AND seated_at IS NULL
      AND cancelled_at IS NULL AND no_show_at IS NULL
      AND table_id IS NULL AND table_session_id IS NULL AND cancellation_reason IS NULL
    ) OR (
      status = 'arrived'
      AND confirmed_at IS NOT NULL AND arrived_at IS NOT NULL AND seated_at IS NULL
      AND cancelled_at IS NULL AND no_show_at IS NULL
      AND table_id IS NULL AND table_session_id IS NULL AND cancellation_reason IS NULL
    ) OR (
      status = 'seated'
      AND confirmed_at IS NOT NULL AND arrived_at IS NOT NULL AND seated_at IS NOT NULL
      AND cancelled_at IS NULL AND no_show_at IS NULL
      AND table_id IS NOT NULL AND table_session_id IS NOT NULL AND cancellation_reason IS NULL
    ) OR (
      status = 'cancelled'
      AND cancelled_at IS NOT NULL AND no_show_at IS NULL
      AND table_id IS NULL AND table_session_id IS NULL AND cancellation_reason IS NOT NULL
    ) OR (
      status = 'no_show'
      AND confirmed_at IS NOT NULL AND arrived_at IS NULL AND seated_at IS NULL
      AND cancelled_at IS NULL AND no_show_at IS NOT NULL
      AND table_id IS NULL AND table_session_id IS NULL AND cancellation_reason IS NULL
    )
  ),
  CONSTRAINT reservations_event_order CHECK (
    (confirmed_at IS NULL OR confirmed_at >= requested_at)
    AND (arrived_at IS NULL OR arrived_at >= confirmed_at)
    AND (seated_at IS NULL OR seated_at >= arrived_at)
    AND (cancelled_at IS NULL OR cancelled_at >= requested_at)
    AND (no_show_at IS NULL OR no_show_at >= scheduled_at)
  )
);

CREATE INDEX reservations_schedule_idx
  ON mbox.reservations (tenant_id, store_id, scheduled_at, status, id);
CREATE INDEX reservations_customer_idx
  ON mbox.reservations (tenant_id, store_id, customer_member_id, scheduled_at DESC)
  WHERE customer_member_id IS NOT NULL;
CREATE INDEX reservations_area_idx
  ON mbox.reservations (tenant_id, store_id, area_preference_id, scheduled_at)
  WHERE area_preference_id IS NOT NULL;
CREATE INDEX reservations_birthday_idx
  ON mbox.reservations (tenant_id, store_id, scheduled_at, id)
  WHERE occasion_type_id IS NOT NULL AND status IN ('requested', 'confirmed', 'arrived');

CREATE OR REPLACE FUNCTION mbox.validate_reservation_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  session_table_id uuid;
  policy_minimum integer;
  policy_maximum integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT minimum_party_size, maximum_party_size
      INTO policy_minimum, policy_maximum
    FROM mbox.reservation_policies
    WHERE tenant_id = NEW.tenant_id AND store_id = NEW.store_id AND id = NEW.policy_id AND enabled;
    IF policy_minimum IS NULL OR NEW.party_size NOT BETWEEN policy_minimum AND policy_maximum THEN
      RAISE EXCEPTION 'reservation party size is outside the active policy'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.store_id IS DISTINCT FROM OLD.store_id
       OR NEW.policy_id IS DISTINCT FROM OLD.policy_id
       OR NEW.source_id IS DISTINCT FROM OLD.source_id
       OR NEW.customer_member_id IS DISTINCT FROM OLD.customer_member_id
       OR NEW.customer_reference IS DISTINCT FROM OLD.customer_reference
       OR NEW.customer_name IS DISTINCT FROM OLD.customer_name
       OR NEW.contact_reference IS DISTINCT FROM OLD.contact_reference
       OR NEW.party_size IS DISTINCT FROM OLD.party_size
       OR NEW.area_preference_id IS DISTINCT FROM OLD.area_preference_id
       OR NEW.occasion_type_id IS DISTINCT FROM OLD.occasion_type_id
       OR NEW.occasion_note IS DISTINCT FROM OLD.occasion_note
       OR NEW.scheduled_at IS DISTINCT FROM OLD.scheduled_at
       OR NEW.requested_at IS DISTINCT FROM OLD.requested_at
       OR NEW.created_by_employee_id IS DISTINCT FROM OLD.created_by_employee_id
       OR NEW.config_version IS DISTINCT FROM OLD.config_version THEN
      RAISE EXCEPTION 'reservation request facts are immutable'
        USING ERRCODE = '55000';
    END IF;

    IF NEW.status <> OLD.status AND NOT (
      (OLD.status = 'requested' AND NEW.status IN ('confirmed', 'cancelled')) OR
      (OLD.status = 'confirmed' AND NEW.status IN ('arrived', 'cancelled', 'no_show')) OR
      (OLD.status = 'arrived' AND NEW.status IN ('seated', 'cancelled'))
    ) THEN
      RAISE EXCEPTION 'invalid reservation transition: % -> %', OLD.status, NEW.status
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.status = 'seated' THEN
    SELECT table_id INTO session_table_id
    FROM mbox.table_sessions
    WHERE tenant_id = NEW.tenant_id
      AND store_id = NEW.store_id
      AND id = NEW.table_session_id
      AND status IN ('open', 'transferred', 'closing');
    IF session_table_id IS DISTINCT FROM NEW.table_id THEN
      RAISE EXCEPTION 'reservation table session does not match the bound table'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER reservations_validate_transition
BEFORE INSERT OR UPDATE ON mbox.reservations
FOR EACH ROW EXECUTE FUNCTION mbox.validate_reservation_transition();

CREATE TRIGGER reservations_touch_version
BEFORE UPDATE ON mbox.reservations
FOR EACH ROW EXECUTE FUNCTION mbox.touch_versioned_row();

CREATE TABLE mbox.reservation_deposits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  reservation_id uuid NOT NULL,
  required_amount_minor bigint NOT NULL CHECK (required_amount_minor >= 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status text NOT NULL CHECK (status IN (
    'not_required', 'payment_required', 'payment_intent_recorded', 'payment_confirmed',
    'refund_required', 'refund_processing', 'refunded', 'refund_failed'
  )),
  payment_intent_reference text,
  payment_intent_recorded_at timestamptz,
  payment_confirmation_reference text,
  payment_confirmed_at timestamptz,
  refund_request_reference text,
  refund_requested_at timestamptz,
  refund_confirmation_reference text,
  refunded_at timestamptz,
  refund_failure_reason text CHECK (refund_failure_reason IS NULL OR length(refund_failure_reason) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, reservation_id)
    REFERENCES mbox.reservations(tenant_id, store_id, id),
  CONSTRAINT reservation_deposits_reservation_uq UNIQUE (tenant_id, store_id, reservation_id),
  CONSTRAINT reservation_deposits_tenant_store_id_uq UNIQUE (tenant_id, store_id, id),
  CONSTRAINT reservation_deposits_status_shape CHECK (
    (
      status = 'not_required' AND required_amount_minor = 0
      AND payment_intent_reference IS NULL AND payment_intent_recorded_at IS NULL
      AND payment_confirmation_reference IS NULL AND payment_confirmed_at IS NULL
      AND refund_request_reference IS NULL AND refund_requested_at IS NULL
      AND refund_confirmation_reference IS NULL AND refunded_at IS NULL AND refund_failure_reason IS NULL
    ) OR (
      status = 'payment_required' AND required_amount_minor > 0
      AND payment_intent_reference IS NULL AND payment_intent_recorded_at IS NULL
      AND payment_confirmation_reference IS NULL AND payment_confirmed_at IS NULL
      AND refund_request_reference IS NULL AND refund_requested_at IS NULL
      AND refund_confirmation_reference IS NULL AND refunded_at IS NULL AND refund_failure_reason IS NULL
    ) OR (
      status = 'payment_intent_recorded' AND required_amount_minor > 0
      AND payment_intent_reference IS NOT NULL AND payment_intent_recorded_at IS NOT NULL
      AND payment_confirmation_reference IS NULL AND payment_confirmed_at IS NULL
      AND refund_request_reference IS NULL AND refund_requested_at IS NULL
      AND refund_confirmation_reference IS NULL AND refunded_at IS NULL AND refund_failure_reason IS NULL
    ) OR (
      status IN ('payment_confirmed', 'refund_required') AND required_amount_minor > 0
      AND payment_intent_reference IS NOT NULL AND payment_intent_recorded_at IS NOT NULL
      AND payment_confirmation_reference IS NOT NULL AND payment_confirmed_at IS NOT NULL
      AND refund_request_reference IS NULL AND refund_requested_at IS NULL
      AND refund_confirmation_reference IS NULL AND refunded_at IS NULL AND refund_failure_reason IS NULL
    ) OR (
      status = 'refund_processing' AND required_amount_minor > 0
      AND payment_intent_reference IS NOT NULL AND payment_intent_recorded_at IS NOT NULL
      AND payment_confirmation_reference IS NOT NULL AND payment_confirmed_at IS NOT NULL
      AND refund_request_reference IS NOT NULL AND refund_requested_at IS NOT NULL
      AND refund_confirmation_reference IS NULL AND refunded_at IS NULL AND refund_failure_reason IS NULL
    ) OR (
      status = 'refunded' AND required_amount_minor > 0
      AND payment_intent_reference IS NOT NULL AND payment_intent_recorded_at IS NOT NULL
      AND payment_confirmation_reference IS NOT NULL AND payment_confirmed_at IS NOT NULL
      AND refund_request_reference IS NOT NULL AND refund_requested_at IS NOT NULL
      AND refund_confirmation_reference IS NOT NULL AND refunded_at IS NOT NULL AND refund_failure_reason IS NULL
    ) OR (
      status = 'refund_failed' AND required_amount_minor > 0
      AND payment_intent_reference IS NOT NULL AND payment_intent_recorded_at IS NOT NULL
      AND payment_confirmation_reference IS NOT NULL AND payment_confirmed_at IS NOT NULL
      AND refund_request_reference IS NOT NULL AND refund_requested_at IS NOT NULL
      AND refund_confirmation_reference IS NULL AND refunded_at IS NULL AND refund_failure_reason IS NOT NULL
    )
  ),
  CONSTRAINT reservation_deposits_time_order CHECK (
    (payment_intent_recorded_at IS NULL OR payment_intent_recorded_at >= created_at)
    AND (payment_confirmed_at IS NULL OR payment_confirmed_at >= payment_intent_recorded_at)
    AND (refund_requested_at IS NULL OR refund_requested_at >= payment_confirmed_at)
    AND (refunded_at IS NULL OR refunded_at >= refund_requested_at)
  )
);

CREATE INDEX reservation_deposits_status_idx
  ON mbox.reservation_deposits (tenant_id, store_id, status, updated_at, id);
CREATE UNIQUE INDEX reservation_deposits_payment_confirmation_uq
  ON mbox.reservation_deposits (tenant_id, store_id, payment_confirmation_reference)
  WHERE payment_confirmation_reference IS NOT NULL;
CREATE UNIQUE INDEX reservation_deposits_refund_confirmation_uq
  ON mbox.reservation_deposits (tenant_id, store_id, refund_confirmation_reference)
  WHERE refund_confirmation_reference IS NOT NULL;

CREATE OR REPLACE FUNCTION mbox.validate_reservation_deposit_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.store_id IS DISTINCT FROM OLD.store_id
       OR NEW.reservation_id IS DISTINCT FROM OLD.reservation_id
       OR NEW.required_amount_minor IS DISTINCT FROM OLD.required_amount_minor
       OR NEW.currency IS DISTINCT FROM OLD.currency
       OR NEW.payment_intent_reference IS DISTINCT FROM OLD.payment_intent_reference
          AND OLD.payment_intent_reference IS NOT NULL
       OR NEW.payment_confirmation_reference IS DISTINCT FROM OLD.payment_confirmation_reference
          AND OLD.payment_confirmation_reference IS NOT NULL THEN
      RAISE EXCEPTION 'reservation deposit payment facts are immutable'
        USING ERRCODE = '55000';
    END IF;
    IF NEW.status <> OLD.status AND NOT (
      (OLD.status = 'payment_required' AND NEW.status = 'payment_intent_recorded') OR
      (OLD.status = 'payment_intent_recorded' AND NEW.status = 'payment_confirmed') OR
      (OLD.status = 'payment_confirmed' AND NEW.status = 'refund_required') OR
      (OLD.status IN ('refund_required', 'refund_failed') AND NEW.status = 'refund_processing') OR
      (OLD.status = 'refund_processing' AND NEW.status IN ('refunded', 'refund_failed'))
    ) THEN
      RAISE EXCEPTION 'invalid reservation deposit transition: % -> %', OLD.status, NEW.status
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER reservation_deposits_validate_transition
BEFORE UPDATE ON mbox.reservation_deposits
FOR EACH ROW EXECUTE FUNCTION mbox.validate_reservation_deposit_transition();

CREATE TRIGGER reservation_deposits_touch_version
BEFORE UPDATE ON mbox.reservation_deposits
FOR EACH ROW EXECUTE FUNCTION mbox.touch_versioned_row();

CREATE TABLE mbox.reservation_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  reservation_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN (
    'reservation.requested.v1', 'reservation.confirmed.v1', 'reservation.arrived.v1',
    'reservation.seated.v1', 'reservation.cancelled.v1', 'reservation.no_show.v1',
    'reservation.deposit_intent_recorded.v1', 'reservation.deposit_confirmed.v1',
    'reservation.deposit_refund_required.v1', 'reservation.deposit_refund_started.v1',
    'reservation.deposit_refunded.v1', 'reservation.deposit_refund_failed.v1'
  )),
  actor_employee_id uuid NOT NULL,
  from_status text,
  to_status text NOT NULL,
  deposit_from_status text,
  deposit_to_status text NOT NULL,
  reason text CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 500),
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, reservation_id)
    REFERENCES mbox.reservations(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, actor_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  CONSTRAINT reservation_events_tenant_store_id_uq UNIQUE (tenant_id, store_id, id)
);

CREATE INDEX reservation_events_timeline_idx
  ON mbox.reservation_events (tenant_id, store_id, reservation_id, occurred_at, id);

CREATE TRIGGER reservation_events_append_only
BEFORE UPDATE OR DELETE ON mbox.reservation_events
FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();

CREATE TABLE mbox.reservation_idempotency_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  operation text NOT NULL CHECK (length(operation) BETWEEN 1 AND 100),
  request_sha256 char(64) NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  reservation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, reservation_id)
    REFERENCES mbox.reservations(tenant_id, store_id, id),
  CONSTRAINT reservation_idempotency_key_uq UNIQUE (tenant_id, store_id, idempotency_key),
  CONSTRAINT reservation_idempotency_records_tenant_store_id_uq UNIQUE (tenant_id, store_id, id)
);

CREATE TRIGGER reservation_idempotency_records_append_only
BEFORE UPDATE OR DELETE ON mbox.reservation_idempotency_records
FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'reservation_sources',
    'reservation_occasion_types',
    'reservation_policies',
    'reservations',
    'reservation_deposits',
    'reservation_events',
    'reservation_idempotency_records'
  ]
  LOOP
    EXECUTE format('ALTER TABLE mbox.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE mbox.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_store_isolation ON mbox.%I USING (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id()) WITH CHECK (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id())',
      table_name
    );
  END LOOP;
END;
$$;

COMMIT;
