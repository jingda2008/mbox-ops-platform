BEGIN;

CREATE TABLE mbox.singers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  employee_id uuid,
  stage_name text NOT NULL CHECK (length(btrim(stage_name)) BETWEEN 1 AND 80),
  active boolean NOT NULL DEFAULT true,
  config_version_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, employee_id) REFERENCES mbox.employees(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, config_version_id) REFERENCES mbox.config_versions(tenant_id, store_id, id),
  CONSTRAINT singers_stage_name_uq UNIQUE (tenant_id, store_id, stage_name),
  CONSTRAINT singers_tenant_store_id_uq UNIQUE (tenant_id, store_id, id)
);

CREATE TABLE mbox.song_catalog (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  original_artist text NOT NULL CHECK (length(btrim(original_artist)) BETWEEN 1 AND 200),
  duration_seconds integer NOT NULL CHECK (duration_seconds BETWEEN 30 AND 1800),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  CONSTRAINT song_catalog_identity_uq UNIQUE (tenant_id, store_id, title, original_artist),
  CONSTRAINT song_catalog_tenant_store_id_uq UNIQUE (tenant_id, store_id, id)
);

CREATE TABLE mbox.singer_repertoire (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  singer_id uuid NOT NULL,
  song_id uuid NOT NULL,
  price_amount_minor bigint NOT NULL CHECK (price_amount_minor > 0),
  currency char(3) NOT NULL DEFAULT 'CNY' CHECK (currency ~ '^[A-Z]{3}$'),
  enabled boolean NOT NULL DEFAULT true,
  config_version_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  FOREIGN KEY (tenant_id, store_id, singer_id) REFERENCES mbox.singers(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, song_id) REFERENCES mbox.song_catalog(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, config_version_id) REFERENCES mbox.config_versions(tenant_id, store_id, id),
  CONSTRAINT singer_repertoire_offer_uq UNIQUE (tenant_id, store_id, singer_id, song_id, config_version_id),
  CONSTRAINT singer_repertoire_tenant_store_id_uq UNIQUE (tenant_id, store_id, id)
);

CREATE INDEX singer_repertoire_active_idx ON mbox.singer_repertoire
  (tenant_id, store_id, singer_id, song_id) WHERE enabled;

CREATE TABLE mbox.performance_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  business_date date NOT NULL,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 160),
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'live', 'completed', 'cancelled')),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  config_version_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, config_version_id) REFERENCES mbox.config_versions(tenant_id, store_id, id),
  CONSTRAINT performance_sessions_time_order CHECK (ends_at > starts_at),
  CONSTRAINT performance_sessions_tenant_store_id_uq UNIQUE (tenant_id, store_id, id)
);

CREATE INDEX performance_sessions_business_date_idx ON mbox.performance_sessions
  (tenant_id, store_id, business_date, starts_at, id);

CREATE TABLE mbox.singer_appearances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  performance_session_id uuid NOT NULL,
  singer_id uuid NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  request_opens_at timestamptz NOT NULL,
  request_closes_at timestamptz NOT NULL,
  accepting_requests boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  FOREIGN KEY (tenant_id, store_id, performance_session_id)
    REFERENCES mbox.performance_sessions(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, singer_id) REFERENCES mbox.singers(tenant_id, store_id, id),
  CONSTRAINT singer_appearances_time_order CHECK (
    ends_at > starts_at AND request_closes_at > request_opens_at
    AND request_opens_at <= ends_at AND request_closes_at >= starts_at
  ),
  CONSTRAINT singer_appearances_slot_uq UNIQUE (tenant_id, store_id, performance_session_id, singer_id, starts_at),
  CONSTRAINT singer_appearances_tenant_store_id_uq UNIQUE (tenant_id, store_id, id),
  CONSTRAINT singer_appearances_identity_uq UNIQUE (tenant_id, store_id, id, singer_id)
);

CREATE INDEX singer_appearances_request_window_idx ON mbox.singer_appearances
  (tenant_id, store_id, request_opens_at, request_closes_at, id) WHERE accepting_requests;

CREATE TABLE mbox.song_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  appearance_id uuid NOT NULL,
  singer_id uuid NOT NULL,
  repertoire_id uuid NOT NULL,
  table_session_id uuid NOT NULL,
  requested_by_member_id uuid,
  requested_by_ref text,
  customer_note text NOT NULL DEFAULT '' CHECK (length(customer_note) <= 300),
  status text NOT NULL DEFAULT 'pending_payment' CHECK (status IN (
    'pending_payment', 'paid', 'accepted', 'performing', 'completed',
    'rejected', 'cancelled', 'refund_required', 'refunded'
  )),
  singer_name_snapshot text NOT NULL,
  song_title_snapshot text NOT NULL,
  song_artist_snapshot text NOT NULL,
  price_amount_minor_snapshot bigint NOT NULL CHECK (price_amount_minor_snapshot > 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  repertoire_config_version_id uuid NOT NULL,
  order_id uuid,
  payment_intent_id uuid,
  refund_id uuid,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  paid_at timestamptz,
  accepted_at timestamptz,
  performing_at timestamptz,
  completed_at timestamptz,
  rejected_at timestamptz,
  cancelled_at timestamptz,
  refunded_at timestamptz,
  rejection_reason text,
  refund_reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  FOREIGN KEY (tenant_id, store_id, appearance_id, singer_id)
    REFERENCES mbox.singer_appearances(tenant_id, store_id, id, singer_id),
  FOREIGN KEY (tenant_id, store_id, repertoire_id)
    REFERENCES mbox.singer_repertoire(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, table_session_id)
    REFERENCES mbox.table_sessions(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, requested_by_member_id)
    REFERENCES mbox.customer_members(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, repertoire_config_version_id)
    REFERENCES mbox.config_versions(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, order_id, table_session_id)
    REFERENCES mbox.orders(tenant_id, store_id, id, table_session_id),
  FOREIGN KEY (tenant_id, store_id, payment_intent_id)
    REFERENCES mbox.payment_intents(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, refund_id)
    REFERENCES mbox.refunds(tenant_id, store_id, id),
  CONSTRAINT song_requests_requester_shape CHECK (
    requested_by_member_id IS NOT NULL OR length(btrim(requested_by_ref)) > 0
  ),
  CONSTRAINT song_requests_status_evidence CHECK (
    (status <> 'paid' OR paid_at IS NOT NULL) AND
    (status <> 'accepted' OR (paid_at IS NOT NULL AND accepted_at IS NOT NULL)) AND
    (status <> 'performing' OR (accepted_at IS NOT NULL AND performing_at IS NOT NULL)) AND
    (status <> 'completed' OR completed_at IS NOT NULL) AND
    (status <> 'rejected' OR (rejected_at IS NOT NULL AND length(btrim(rejection_reason)) > 0)) AND
    (status <> 'cancelled' OR cancelled_at IS NOT NULL) AND
    (status <> 'refund_required' OR (paid_at IS NOT NULL AND length(btrim(refund_reason)) > 0)) AND
    (status <> 'refunded' OR (refund_id IS NOT NULL AND refunded_at IS NOT NULL))
  ),
  CONSTRAINT song_requests_idempotency_uq UNIQUE (tenant_id, store_id, idempotency_key),
  CONSTRAINT song_requests_tenant_store_id_uq UNIQUE (tenant_id, store_id, id)
);

CREATE INDEX song_requests_queue_idx ON mbox.song_requests
  (tenant_id, store_id, status, created_at, id)
  WHERE status IN ('pending_payment', 'paid', 'accepted', 'performing', 'refund_required');
CREATE INDEX song_requests_table_timeline_idx ON mbox.song_requests
  (tenant_id, store_id, table_session_id, created_at DESC, id);

CREATE OR REPLACE FUNCTION mbox.apply_song_request_snapshot()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  offer_singer_id uuid;
  offer_price bigint;
  offer_currency char(3);
  offer_config uuid;
  offer_enabled boolean;
  singer_name text;
  song_title text;
  song_artist text;
  appearance_open boolean;
  appearance_opens timestamptz;
  appearance_closes timestamptz;
  table_open boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.store_id IS DISTINCT FROM OLD.store_id
       OR NEW.appearance_id IS DISTINCT FROM OLD.appearance_id
       OR NEW.singer_id IS DISTINCT FROM OLD.singer_id
       OR NEW.repertoire_id IS DISTINCT FROM OLD.repertoire_id
       OR NEW.table_session_id IS DISTINCT FROM OLD.table_session_id
       OR NEW.singer_name_snapshot IS DISTINCT FROM OLD.singer_name_snapshot
       OR NEW.song_title_snapshot IS DISTINCT FROM OLD.song_title_snapshot
       OR NEW.song_artist_snapshot IS DISTINCT FROM OLD.song_artist_snapshot
       OR NEW.price_amount_minor_snapshot IS DISTINCT FROM OLD.price_amount_minor_snapshot
       OR NEW.currency IS DISTINCT FROM OLD.currency
       OR NEW.repertoire_config_version_id IS DISTINCT FROM OLD.repertoire_config_version_id
       OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'song request identity and price snapshot are immutable';
    END IF;
    RETURN NEW;
  END IF;

  SELECT r.singer_id, r.price_amount_minor, r.currency, r.config_version_id, r.enabled,
         s.stage_name, c.title, c.original_artist
    INTO offer_singer_id, offer_price, offer_currency, offer_config, offer_enabled,
         singer_name, song_title, song_artist
    FROM mbox.singer_repertoire r
    JOIN mbox.singers s ON s.tenant_id = r.tenant_id AND s.store_id = r.store_id AND s.id = r.singer_id
    JOIN mbox.song_catalog c ON c.tenant_id = r.tenant_id AND c.store_id = r.store_id AND c.id = r.song_id
   WHERE r.tenant_id = NEW.tenant_id AND r.store_id = NEW.store_id AND r.id = NEW.repertoire_id
     AND s.active AND c.active;
  IF NOT FOUND OR NOT offer_enabled OR offer_singer_id <> NEW.singer_id THEN
    RAISE EXCEPTION 'selected singer repertoire offer is unavailable';
  END IF;

  SELECT accepting_requests, request_opens_at, request_closes_at
    INTO appearance_open, appearance_opens, appearance_closes
    FROM mbox.singer_appearances
   WHERE tenant_id = NEW.tenant_id AND store_id = NEW.store_id
     AND id = NEW.appearance_id AND singer_id = NEW.singer_id;
  IF NOT FOUND OR NOT appearance_open OR NEW.created_at < appearance_opens OR NEW.created_at > appearance_closes THEN
    RAISE EXCEPTION 'singer appearance is not accepting requests at this time';
  END IF;

  SELECT status IN ('open', 'transferred', 'closing') INTO table_open
    FROM mbox.table_sessions
   WHERE tenant_id = NEW.tenant_id AND store_id = NEW.store_id AND id = NEW.table_session_id;
  IF NOT FOUND OR NOT table_open THEN RAISE EXCEPTION 'table session is not open'; END IF;

  NEW.singer_name_snapshot := singer_name;
  NEW.song_title_snapshot := song_title;
  NEW.song_artist_snapshot := song_artist;
  NEW.price_amount_minor_snapshot := offer_price;
  NEW.currency := offer_currency;
  NEW.repertoire_config_version_id := offer_config;
  RETURN NEW;
END;
$$;

CREATE TRIGGER song_requests_10_snapshot
BEFORE INSERT OR UPDATE ON mbox.song_requests
FOR EACH ROW EXECUTE FUNCTION mbox.apply_song_request_snapshot();

CREATE OR REPLACE FUNCTION mbox.validate_song_request_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  IF NOT (
    (OLD.status = 'pending_payment' AND NEW.status IN ('paid', 'rejected', 'cancelled')) OR
    (OLD.status = 'paid' AND NEW.status IN ('accepted', 'refund_required')) OR
    (OLD.status = 'accepted' AND NEW.status IN ('performing', 'refund_required')) OR
    (OLD.status = 'performing' AND NEW.status = 'completed') OR
    (OLD.status = 'refund_required' AND NEW.status = 'refunded')
  ) THEN
    RAISE EXCEPTION 'invalid song request transition: % -> %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER song_requests_20_transition
BEFORE UPDATE ON mbox.song_requests
FOR EACH ROW EXECUTE FUNCTION mbox.validate_song_request_transition();
CREATE TRIGGER song_requests_touch_version
BEFORE UPDATE ON mbox.song_requests
FOR EACH ROW EXECUTE FUNCTION mbox.touch_versioned_row();

CREATE TABLE mbox.song_request_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  song_request_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type ~ '^song_request\.[a-z0-9_]+\.v[1-9][0-9]*$'),
  from_status text,
  to_status text NOT NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('guest', 'employee', 'system', 'integration')),
  actor_employee_id uuid,
  actor_ref text,
  reason text,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  occurred_at timestamptz NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id, song_request_id) REFERENCES mbox.song_requests(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, actor_employee_id) REFERENCES mbox.employees(tenant_id, store_id, id),
  CONSTRAINT song_request_events_actor_shape CHECK (
    (actor_type = 'employee' AND actor_employee_id IS NOT NULL) OR
    (actor_type <> 'employee' AND actor_employee_id IS NULL)
  ),
  CONSTRAINT song_request_events_idempotency_uq UNIQUE (tenant_id, store_id, idempotency_key),
  CONSTRAINT song_request_events_tenant_store_id_uq UNIQUE (tenant_id, store_id, id)
);

CREATE INDEX song_request_events_timeline_idx ON mbox.song_request_events
  (tenant_id, store_id, song_request_id, occurred_at, id);
CREATE TRIGGER song_request_events_append_only
BEFORE UPDATE OR DELETE ON mbox.song_request_events
FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();

CREATE TRIGGER singers_touch_version BEFORE UPDATE ON mbox.singers
FOR EACH ROW EXECUTE FUNCTION mbox.touch_versioned_row();
CREATE TRIGGER song_catalog_touch_version BEFORE UPDATE ON mbox.song_catalog
FOR EACH ROW EXECUTE FUNCTION mbox.touch_versioned_row();
CREATE TRIGGER singer_repertoire_touch_version BEFORE UPDATE ON mbox.singer_repertoire
FOR EACH ROW EXECUTE FUNCTION mbox.touch_versioned_row();
CREATE TRIGGER performance_sessions_touch_version BEFORE UPDATE ON mbox.performance_sessions
FOR EACH ROW EXECUTE FUNCTION mbox.touch_versioned_row();
CREATE TRIGGER singer_appearances_touch_version BEFORE UPDATE ON mbox.singer_appearances
FOR EACH ROW EXECUTE FUNCTION mbox.touch_versioned_row();

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'singers', 'song_catalog', 'singer_repertoire', 'performance_sessions',
    'singer_appearances', 'song_requests', 'song_request_events'
  ] LOOP
    EXECUTE format('ALTER TABLE mbox.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE mbox.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_store_isolation ON mbox.%I USING (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id()) WITH CHECK (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id())',
      table_name
    );
  END LOOP;
END;
$$;

COMMENT ON TABLE mbox.song_requests IS
  'Paid song request aggregate. Price and performer snapshots are immutable; paid rejection requires a refund workflow.';
COMMENT ON TABLE mbox.song_request_events IS
  'Append-only song request lifecycle and refund evidence.';

COMMIT;
