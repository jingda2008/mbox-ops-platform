BEGIN;

ALTER TABLE mbox.products
  ADD COLUMN capacity_units integer NOT NULL DEFAULT 1
    CHECK (capacity_units BETWEEN 1 AND 1000);

CREATE TABLE mbox.fulfillment_capacity_policy_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  station_code text NOT NULL CHECK (station_code IN ('bar', 'kitchen', 'cashier')),
  policy_version integer NOT NULL CHECK (policy_version > 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'retired')),
  published_at timestamptz,
  retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  CHECK (
    (status='draft' AND published_at IS NULL AND retired_at IS NULL)
    OR (status='published' AND published_at IS NOT NULL AND retired_at IS NULL)
    OR (status='retired' AND published_at IS NOT NULL AND retired_at IS NOT NULL)
  ),
  UNIQUE (tenant_id, store_id, station_code, policy_version),
  UNIQUE (tenant_id, store_id, id)
);

CREATE UNIQUE INDEX fulfillment_capacity_one_published_policy_uq
  ON mbox.fulfillment_capacity_policy_versions (tenant_id, store_id, station_code)
  WHERE status='published';

CREATE TABLE mbox.fulfillment_capacity_windows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  policy_version_id uuid NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  capacity_limit_units integer NOT NULL CHECK (capacity_limit_units BETWEEN 1 AND 1000000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id, policy_version_id)
    REFERENCES mbox.fulfillment_capacity_policy_versions(tenant_id, store_id, id),
  CHECK (ends_at > starts_at),
  UNIQUE (tenant_id, store_id, policy_version_id, starts_at, ends_at),
  UNIQUE (tenant_id, store_id, policy_version_id, id),
  EXCLUDE USING gist (
    tenant_id WITH =,
    store_id WITH =,
    policy_version_id WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  )
);

CREATE INDEX fulfillment_capacity_windows_lookup_idx
  ON mbox.fulfillment_capacity_windows
    (tenant_id, store_id, policy_version_id, starts_at, ends_at, id);

CREATE TABLE mbox.fulfillment_capacity_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  order_id uuid NOT NULL,
  order_item_id uuid NOT NULL,
  policy_version_id uuid NOT NULL,
  capacity_window_id uuid NOT NULL,
  capacity_units integer NOT NULL CHECK (capacity_units BETWEEN 1 AND 1000000),
  status text NOT NULL DEFAULT 'reserved'
    CHECK (status IN ('reserved', 'active', 'released')),
  expires_at timestamptz,
  activated_at timestamptz,
  released_at timestamptz,
  release_reason text,
  reserved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, order_id) REFERENCES mbox.orders(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, order_id, order_item_id)
    REFERENCES mbox.order_items(tenant_id, store_id, order_id, id),
  FOREIGN KEY (tenant_id, store_id, policy_version_id, capacity_window_id)
    REFERENCES mbox.fulfillment_capacity_windows(tenant_id, store_id, policy_version_id, id),
  CHECK (
    (status='reserved' AND expires_at IS NOT NULL
      AND activated_at IS NULL AND released_at IS NULL AND release_reason IS NULL)
    OR (status='active' AND expires_at IS NULL
      AND activated_at IS NOT NULL AND released_at IS NULL AND release_reason IS NULL)
    OR (status='released' AND expires_at IS NULL
      AND activated_at IS NULL AND released_at IS NOT NULL
      AND length(btrim(release_reason)) > 0)
  ),
  UNIQUE (tenant_id, store_id, order_item_id),
  UNIQUE (tenant_id, store_id, id)
);

CREATE INDEX fulfillment_capacity_reservations_window_idx
  ON mbox.fulfillment_capacity_reservations
    (tenant_id, store_id, capacity_window_id, status, order_item_id);
CREATE INDEX fulfillment_capacity_reservations_order_idx
  ON mbox.fulfillment_capacity_reservations
    (tenant_id, store_id, order_id, status, order_item_id);

CREATE FUNCTION mbox.manage_fulfillment_capacity_policy_version()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'draft' THEN
      RAISE EXCEPTION 'capacity policy must be created as draft' USING ERRCODE='23514';
    END IF;
    NEW.published_at := NULL;
    NEW.retired_at := NULL;
    NEW.updated_at := clock_timestamp();
    RETURN NEW;
  END IF;

  IF NEW.id<>OLD.id OR NEW.tenant_id<>OLD.tenant_id OR NEW.store_id<>OLD.store_id
    OR NEW.station_code<>OLD.station_code OR NEW.policy_version<>OLD.policy_version THEN
    RAISE EXCEPTION 'capacity policy identity and version are immutable'
      USING ERRCODE='23514';
  END IF;
  IF NOT (
    NEW.status=OLD.status
    OR (OLD.status='draft' AND NEW.status='published')
    OR (OLD.status='published' AND NEW.status='retired')
  ) THEN
    RAISE EXCEPTION 'invalid capacity policy transition % -> %', OLD.status, NEW.status
      USING ERRCODE='23514';
  END IF;

  IF OLD.status='draft' AND NEW.status='published' THEN
    IF NOT EXISTS (
      SELECT 1 FROM mbox.fulfillment_capacity_windows window_row
      WHERE window_row.tenant_id=NEW.tenant_id AND window_row.store_id=NEW.store_id
        AND window_row.policy_version_id=NEW.id
    ) THEN
      RAISE EXCEPTION 'published capacity policy requires at least one time window'
        USING ERRCODE='23514';
    END IF;
    NEW.published_at := clock_timestamp();
    NEW.retired_at := NULL;
  ELSIF OLD.status='published' AND NEW.status='retired' THEN
    NEW.published_at := OLD.published_at;
    NEW.retired_at := clock_timestamp();
  ELSE
    NEW.published_at := OLD.published_at;
    NEW.retired_at := OLD.retired_at;
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$;

CREATE TRIGGER fulfillment_capacity_policy_manage
  BEFORE INSERT OR UPDATE ON mbox.fulfillment_capacity_policy_versions
  FOR EACH ROW EXECUTE FUNCTION mbox.manage_fulfillment_capacity_policy_version();

CREATE FUNCTION mbox.protect_fulfillment_capacity_window()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  policy_status text;
  target_tenant_id uuid;
  target_store_id uuid;
  target_policy_id uuid;
BEGIN
  IF TG_OP='DELETE' THEN
    target_tenant_id := OLD.tenant_id;
    target_store_id := OLD.store_id;
    target_policy_id := OLD.policy_version_id;
  ELSE
    target_tenant_id := NEW.tenant_id;
    target_store_id := NEW.store_id;
    target_policy_id := NEW.policy_version_id;
  END IF;
  SELECT policy.status INTO policy_status
  FROM mbox.fulfillment_capacity_policy_versions policy
  WHERE policy.tenant_id=target_tenant_id
    AND policy.store_id=target_store_id
    AND policy.id=target_policy_id;
  IF policy_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'capacity windows are immutable after their policy is published'
      USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' THEN NEW.updated_at := clock_timestamp(); END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER fulfillment_capacity_windows_protect
  BEFORE INSERT OR UPDATE OR DELETE ON mbox.fulfillment_capacity_windows
  FOR EACH ROW EXECUTE FUNCTION mbox.protect_fulfillment_capacity_window();

CREATE FUNCTION mbox.validate_fulfillment_capacity_reservation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  item_station text;
  item_due_at timestamptz;
  expected_units bigint;
  order_mode text;
  order_state text;
  order_expires_at timestamptz;
  policy_station text;
  policy_status text;
  window_starts_at timestamptz;
  window_ends_at timestamptz;
  window_limit bigint;
  used_units bigint;
BEGIN
  IF TG_OP='INSERT' AND NEW.status<>'reserved' THEN
    RAISE EXCEPTION 'capacity reservation must start reserved' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND NOT (
    NEW.status=OLD.status
    OR (OLD.status='reserved' AND NEW.status IN ('active','released'))
    OR (OLD.status='active' AND NEW.status='released')
    OR (OLD.status='released' AND NEW.status='reserved')
  ) THEN
    RAISE EXCEPTION 'invalid capacity reservation transition % -> %', OLD.status, NEW.status
      USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND (
    NEW.id<>OLD.id OR NEW.tenant_id<>OLD.tenant_id OR NEW.store_id<>OLD.store_id
    OR NEW.order_id<>OLD.order_id OR NEW.order_item_id<>OLD.order_item_id
  ) THEN
    RAISE EXCEPTION 'capacity reservation order identity is immutable'
      USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND NOT (OLD.status='released' AND NEW.status='reserved')
    AND (
      NEW.policy_version_id<>OLD.policy_version_id
      OR NEW.capacity_window_id<>OLD.capacity_window_id
      OR NEW.capacity_units<>OLD.capacity_units
    ) THEN
    RAISE EXCEPTION 'active capacity policy, window and units are immutable'
      USING ERRCODE='23514';
  END IF;

  SELECT item.fulfillment_station, item.fulfillment_due_at,
    item.quantity::bigint * product.capacity_units::bigint,
    order_row.settlement_mode, order_row.fulfillment_state,
    order_row.fulfillment_expires_at,
    policy.station_code, policy.status,
    window_row.starts_at, window_row.ends_at, window_row.capacity_limit_units
  INTO item_station, item_due_at, expected_units, order_mode, order_state,
    order_expires_at, policy_station, policy_status,
    window_starts_at, window_ends_at, window_limit
  FROM mbox.order_items item
  JOIN mbox.orders order_row
    ON order_row.tenant_id=item.tenant_id AND order_row.store_id=item.store_id
   AND order_row.id=item.order_id
  JOIN mbox.products product
    ON product.tenant_id=item.tenant_id AND product.store_id=item.store_id
   AND product.id=item.product_id
  JOIN mbox.fulfillment_capacity_policy_versions policy
    ON policy.tenant_id=item.tenant_id AND policy.store_id=item.store_id
   AND policy.id=NEW.policy_version_id
  JOIN mbox.fulfillment_capacity_windows window_row
    ON window_row.tenant_id=policy.tenant_id AND window_row.store_id=policy.store_id
   AND window_row.policy_version_id=policy.id AND window_row.id=NEW.capacity_window_id
  WHERE item.tenant_id=NEW.tenant_id AND item.store_id=NEW.store_id
    AND item.order_id=NEW.order_id AND item.id=NEW.order_item_id
  FOR SHARE OF item, order_row, product, policy;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'capacity reservation target is not a valid scoped order item'
      USING ERRCODE='23514';
  END IF;
  IF order_mode<>'immediate_payment' OR item_station<>policy_station OR item_station='none'
    OR item_due_at IS NULL OR item_due_at<window_starts_at OR item_due_at>=window_ends_at THEN
    RAISE EXCEPTION 'capacity reservation does not match final order fulfillment facts'
      USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' OR (TG_OP='UPDATE' AND OLD.status='released' AND NEW.status='reserved') THEN
    IF NEW.capacity_units::bigint<>expected_units THEN
      RAISE EXCEPTION 'capacity reservation units do not match final order facts'
        USING ERRCODE='23514';
    END IF;
    IF policy_status<>'published' OR order_state<>'awaiting_payment'
      OR order_expires_at IS NULL OR NEW.expires_at IS DISTINCT FROM order_expires_at THEN
      RAISE EXCEPTION 'capacity reservation requires a published policy and active payment hold'
        USING ERRCODE='23514';
    END IF;
  ELSIF NEW.status='reserved' AND order_state<>'awaiting_payment' THEN
    RAISE EXCEPTION 'reserved capacity requires awaiting-payment fulfillment'
      USING ERRCODE='23514';
  ELSIF NEW.status='active' AND order_state<>'active' THEN
    RAISE EXCEPTION 'active capacity requires active order fulfillment'
      USING ERRCODE='23514';
  END IF;

  IF NEW.status IN ('reserved','active') THEN
    SELECT capacity_limit_units INTO window_limit
    FROM mbox.fulfillment_capacity_windows
    WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id
      AND id=NEW.capacity_window_id
    FOR UPDATE;
    SELECT COALESCE(sum(reservation.capacity_units), 0) INTO used_units
    FROM mbox.fulfillment_capacity_reservations reservation
    WHERE reservation.tenant_id=NEW.tenant_id AND reservation.store_id=NEW.store_id
      AND reservation.capacity_window_id=NEW.capacity_window_id
      AND reservation.status IN ('reserved','active')
      AND reservation.id<>NEW.id;
    IF used_units + NEW.capacity_units > window_limit THEN
      RAISE EXCEPTION 'fulfillment capacity exceeded for window %', NEW.capacity_window_id
        USING ERRCODE='23514';
    END IF;
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$;

CREATE TRIGGER fulfillment_capacity_reservations_validate
  BEFORE INSERT OR UPDATE ON mbox.fulfillment_capacity_reservations
  FOR EACH ROW EXECUTE FUNCTION mbox.validate_fulfillment_capacity_reservation();

CREATE FUNCTION mbox.reserve_order_fulfillment_capacity(
  p_tenant_id uuid, p_store_id uuid, p_order_id uuid
) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  order_row record;
  item_row record;
  policy_row record;
  window_row record;
  existing_row record;
  used_units bigint;
  required_units bigint;
  affected_count integer := 0;
BEGIN
  SELECT settlement_mode, fulfillment_state, fulfillment_expires_at
  INTO order_row
  FROM mbox.orders
  WHERE tenant_id=p_tenant_id AND store_id=p_store_id AND id=p_order_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'capacity order not found' USING ERRCODE='P0002'; END IF;
  IF order_row.settlement_mode<>'immediate_payment' THEN RETURN 0; END IF;
  IF order_row.fulfillment_state<>'awaiting_payment' OR order_row.fulfillment_expires_at IS NULL THEN
    RAISE EXCEPTION 'capacity reservation requires awaiting-payment fulfillment'
      USING ERRCODE='23514';
  END IF;

  FOR item_row IN
    SELECT item.id, item.fulfillment_station, item.fulfillment_due_at,
      item.quantity, product.capacity_units
    FROM mbox.order_items item
    JOIN mbox.products product
      ON product.tenant_id=item.tenant_id AND product.store_id=item.store_id
     AND product.id=item.product_id
    WHERE item.tenant_id=p_tenant_id AND item.store_id=p_store_id
      AND item.order_id=p_order_id AND item.fulfillment_station<>'none'
    ORDER BY item.fulfillment_station, item.fulfillment_due_at, item.id
    FOR SHARE OF item, product
  LOOP
    policy_row := NULL;
    SELECT policy.id, policy.policy_version INTO policy_row
    FROM mbox.fulfillment_capacity_policy_versions policy
    WHERE policy.tenant_id=p_tenant_id AND policy.store_id=p_store_id
      AND policy.station_code=item_row.fulfillment_station AND policy.status='published'
    FOR SHARE;
    IF policy_row.id IS NULL THEN CONTINUE; END IF;
    IF item_row.fulfillment_due_at IS NULL THEN
      RAISE EXCEPTION 'published capacity policy requires an order due time for station %', item_row.fulfillment_station
        USING ERRCODE='23514';
    END IF;

    window_row := NULL;
    SELECT window_value.id, window_value.capacity_limit_units INTO window_row
    FROM mbox.fulfillment_capacity_windows window_value
    WHERE window_value.tenant_id=p_tenant_id AND window_value.store_id=p_store_id
      AND window_value.policy_version_id=policy_row.id
      AND item_row.fulfillment_due_at>=window_value.starts_at
      AND item_row.fulfillment_due_at<window_value.ends_at
    ORDER BY window_value.starts_at, window_value.id
    LIMIT 1
    FOR UPDATE;
    IF window_row.id IS NULL THEN
      RAISE EXCEPTION 'published capacity policy has no window for station % at %',
        item_row.fulfillment_station, item_row.fulfillment_due_at
        USING ERRCODE='23514';
    END IF;

    required_units := item_row.quantity::bigint * item_row.capacity_units::bigint;
    existing_row := NULL;
    SELECT id, policy_version_id, capacity_window_id, capacity_units, status INTO existing_row
    FROM mbox.fulfillment_capacity_reservations
    WHERE tenant_id=p_tenant_id AND store_id=p_store_id AND order_item_id=item_row.id
    FOR UPDATE;
    IF existing_row.id IS NOT NULL AND existing_row.status IN ('reserved','active') THEN
      IF existing_row.policy_version_id<>policy_row.id
        OR existing_row.capacity_window_id<>window_row.id
        OR existing_row.capacity_units::bigint<>required_units THEN
        RAISE EXCEPTION 'existing capacity reservation conflicts with final order facts'
          USING ERRCODE='23514';
      END IF;
      CONTINUE;
    END IF;

    SELECT COALESCE(sum(reservation.capacity_units),0) INTO used_units
    FROM mbox.fulfillment_capacity_reservations reservation
    WHERE reservation.tenant_id=p_tenant_id AND reservation.store_id=p_store_id
      AND reservation.capacity_window_id=window_row.id
      AND reservation.status IN ('reserved','active');
    IF used_units + required_units > window_row.capacity_limit_units THEN
      RAISE EXCEPTION 'fulfillment capacity exceeded for station %', item_row.fulfillment_station
        USING ERRCODE='23514';
    END IF;

    INSERT INTO mbox.fulfillment_capacity_reservations (
      tenant_id, store_id, order_id, order_item_id,
      policy_version_id, capacity_window_id, capacity_units,
      status, expires_at
    ) VALUES (
      p_tenant_id, p_store_id, p_order_id, item_row.id,
      policy_row.id, window_row.id, required_units,
      'reserved', order_row.fulfillment_expires_at
    )
    ON CONFLICT (tenant_id, store_id, order_item_id) DO UPDATE
    SET order_id=EXCLUDED.order_id,
      policy_version_id=EXCLUDED.policy_version_id,
      capacity_window_id=EXCLUDED.capacity_window_id,
      capacity_units=EXCLUDED.capacity_units,
      status='reserved', expires_at=EXCLUDED.expires_at,
      activated_at=NULL, released_at=NULL, release_reason=NULL,
      reserved_at=clock_timestamp(), updated_at=clock_timestamp()
    WHERE mbox.fulfillment_capacity_reservations.status='released';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'capacity reservation lost a concurrent transition'
        USING ERRCODE='40001';
    END IF;
    affected_count := affected_count + 1;
  END LOOP;
  RETURN affected_count;
END $$;

CREATE FUNCTION mbox.activate_order_fulfillment_capacity(
  p_tenant_id uuid, p_store_id uuid, p_order_id uuid
) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE affected_count integer;
DECLARE order_row record;
BEGIN
  SELECT settlement_mode, fulfillment_state, payment_status INTO order_row
  FROM mbox.orders
  WHERE tenant_id=p_tenant_id AND store_id=p_store_id AND id=p_order_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'capacity order not found' USING ERRCODE='P0002'; END IF;
  IF order_row.settlement_mode<>'immediate_payment' THEN RETURN 0; END IF;
  IF order_row.fulfillment_state<>'active' OR order_row.payment_status<>'paid' THEN
    RAISE EXCEPTION 'capacity activation requires trusted paid fulfillment'
      USING ERRCODE='23514';
  END IF;
  UPDATE mbox.fulfillment_capacity_reservations
  SET status='active', expires_at=NULL, activated_at=clock_timestamp(),
    released_at=NULL, release_reason=NULL, updated_at=clock_timestamp()
  WHERE tenant_id=p_tenant_id AND store_id=p_store_id AND order_id=p_order_id
    AND status='reserved';
  GET DIAGNOSTICS affected_count = ROW_COUNT;
  RETURN affected_count;
END $$;

CREATE FUNCTION mbox.release_reserved_order_fulfillment_capacity(
  p_tenant_id uuid, p_store_id uuid, p_order_id uuid, p_reason text
) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE affected_count integer;
BEGIN
  IF length(btrim(p_reason))=0 THEN
    RAISE EXCEPTION 'capacity release reason is required' USING ERRCODE='22023';
  END IF;
  UPDATE mbox.fulfillment_capacity_reservations
  SET status='released', expires_at=NULL, activated_at=NULL,
    released_at=clock_timestamp(), release_reason=p_reason,
    updated_at=clock_timestamp()
  WHERE tenant_id=p_tenant_id AND store_id=p_store_id AND order_id=p_order_id
    AND status='reserved';
  GET DIAGNOSTICS affected_count = ROW_COUNT;
  RETURN affected_count;
END $$;

CREATE FUNCTION mbox.release_kds_terminal_fulfillment_capacity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE mbox.fulfillment_capacity_reservations
  SET status='released', expires_at=NULL, activated_at=NULL,
    released_at=clock_timestamp(), release_reason='kds:' || NEW.status,
    updated_at=clock_timestamp()
  WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id
    AND order_item_id=NEW.order_item_id AND status='active';
  RETURN NEW;
END $$;

CREATE TRIGGER kds_tasks_release_terminal_capacity
  AFTER UPDATE OF status ON mbox.kds_tasks
  FOR EACH ROW
  WHEN (NEW.status IN ('ready','cancelled','failed') AND OLD.status<>NEW.status)
  EXECUTE FUNCTION mbox.release_kds_terminal_fulfillment_capacity();

CREATE TRIGGER fulfillment_capacity_policies_touch_updated_at
  BEFORE UPDATE ON mbox.fulfillment_capacity_policy_versions
  FOR EACH ROW EXECUTE FUNCTION mbox.touch_updated_at();
CREATE TRIGGER fulfillment_capacity_windows_touch_updated_at
  BEFORE UPDATE ON mbox.fulfillment_capacity_windows
  FOR EACH ROW EXECUTE FUNCTION mbox.touch_updated_at();
CREATE TRIGGER fulfillment_capacity_reservations_touch_updated_at
  BEFORE UPDATE ON mbox.fulfillment_capacity_reservations
  FOR EACH ROW EXECUTE FUNCTION mbox.touch_updated_at();

ALTER TABLE mbox.fulfillment_capacity_policy_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.fulfillment_capacity_policy_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.fulfillment_capacity_policy_versions
  USING (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())
  WITH CHECK (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());

ALTER TABLE mbox.fulfillment_capacity_windows ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.fulfillment_capacity_windows FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.fulfillment_capacity_windows
  USING (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())
  WITH CHECK (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());

ALTER TABLE mbox.fulfillment_capacity_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.fulfillment_capacity_reservations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.fulfillment_capacity_reservations
  USING (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())
  WITH CHECK (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  mbox.fulfillment_capacity_policy_versions,
  mbox.fulfillment_capacity_windows
TO mbox_runtime;
GRANT SELECT, INSERT, UPDATE ON TABLE mbox.fulfillment_capacity_reservations TO mbox_runtime;
GRANT EXECUTE ON FUNCTION
  mbox.reserve_order_fulfillment_capacity(uuid, uuid, uuid),
  mbox.activate_order_fulfillment_capacity(uuid, uuid, uuid),
  mbox.release_reserved_order_fulfillment_capacity(uuid, uuid, uuid, text)
TO mbox_runtime;
REVOKE ALL ON FUNCTION
  mbox.reserve_order_fulfillment_capacity(uuid, uuid, uuid),
  mbox.activate_order_fulfillment_capacity(uuid, uuid, uuid),
  mbox.release_reserved_order_fulfillment_capacity(uuid, uuid, uuid, text)
FROM PUBLIC;

COMMENT ON COLUMN mbox.products.capacity_units IS
  'Strong fulfillment capacity cost per ordered unit; producing bundle components are counted from final operational order items.';
COMMENT ON TABLE mbox.fulfillment_capacity_policy_versions IS
  'Versioned station-level capacity authority. At most one published version exists per store and station.';
COMMENT ON TABLE mbox.fulfillment_capacity_windows IS
  'Explicit non-overlapping station capacity windows and their available unit limits.';
COMMENT ON TABLE mbox.fulfillment_capacity_reservations IS
  'Immediate-payment order capacity holds: reserved before payment, active after trusted settlement, released by definitive failure or terminal KDS state.';

UPDATE mbox.normalized_schema_metadata
SET schema_version='060', updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
