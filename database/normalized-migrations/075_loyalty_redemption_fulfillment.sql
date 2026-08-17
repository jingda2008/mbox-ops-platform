BEGIN;

CREATE TABLE mbox.loyalty_redemption_controls (
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'disabled' CHECK (state IN ('disabled', 'pilot', 'enabled', 'paused')),
  pilot_starts_at timestamptz,
  pilot_ends_at timestamptz,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 2 AND 500),
  changed_by_employee_id uuid NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, store_id),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, changed_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  CHECK (pilot_ends_at IS NULL OR pilot_starts_at IS NULL OR pilot_ends_at > pilot_starts_at)
);

CREATE TABLE mbox.redemption_catalog_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'retired')),
  effective_from timestamptz,
  effective_until timestamptz,
  drafted_by_employee_id uuid NOT NULL,
  approved_by_employee_id uuid,
  approved_at timestamptz,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 2 AND 500),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, drafted_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, approved_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, version),
  UNIQUE (tenant_id, store_id, id),
  CHECK (effective_until IS NULL OR effective_from IS NULL OR effective_until > effective_from),
  CHECK (
    (status='published' AND approved_by_employee_id IS NOT NULL
      AND approved_at IS NOT NULL AND approved_by_employee_id<>drafted_by_employee_id
      AND effective_from IS NOT NULL)
    OR status<>'published'
  )
);

CREATE UNIQUE INDEX redemption_catalog_versions_one_published_uq
  ON mbox.redemption_catalog_versions (tenant_id, store_id)
  WHERE status='published';

CREATE TABLE mbox.loyalty_benefit_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  public_id text NOT NULL CHECK (length(public_id) BETWEEN 8 AND 128),
  benefit_code text NOT NULL CHECK (benefit_code ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{1,63}$'),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 120),
  benefit_kind text NOT NULL CHECK (benefit_kind IN (
    'gift_product','service_experience','activity_access','reservation_priority',
    'customization','birthday_benefit','tier_benefit','points_redemption'
  )),
  product_id uuid,
  activity_id uuid,
  validity_days smallint NOT NULL CHECK (validity_days BETWEEN 1 AND 366),
  requires_employee_fulfillment boolean NOT NULL DEFAULT true,
  cost_amount_minor bigint NOT NULL CHECK (cost_amount_minor >= 0),
  currency char(3) NOT NULL DEFAULT 'CNY' CHECK (currency ~ '^[A-Z]{3}$'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','retired')),
  display_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(display_snapshot)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, product_id) REFERENCES mbox.products(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, activity_id)
    REFERENCES mbox.community_activities(tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, public_id),
  UNIQUE (tenant_id, store_id, benefit_code),
  UNIQUE (tenant_id, store_id, id),
  CHECK (benefit_kind<>'gift_product' OR product_id IS NOT NULL),
  CHECK (benefit_kind<>'activity_access' OR activity_id IS NOT NULL)
);

ALTER TABLE mbox.benefits
  ADD COLUMN benefit_definition_id uuid,
  ADD COLUMN benefit_kind text CHECK (benefit_kind IN (
    'gift_product','service_experience','activity_access','reservation_priority',
    'customization','birthday_benefit','tier_benefit','points_redemption'
  )),
  ADD CONSTRAINT benefits_definition_fk FOREIGN KEY (tenant_id, store_id, benefit_definition_id)
    REFERENCES mbox.loyalty_benefit_definitions(tenant_id, store_id, id),
  ADD CONSTRAINT benefits_definition_kind_pair CHECK (
    (benefit_definition_id IS NULL AND benefit_kind IS NULL)
    OR (benefit_definition_id IS NOT NULL AND benefit_kind IS NOT NULL)
  );

CREATE TABLE mbox.redemption_catalog_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  catalog_version_id uuid NOT NULL,
  public_id text NOT NULL CHECK (length(public_id) BETWEEN 8 AND 128),
  item_code text NOT NULL CHECK (item_code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 120),
  fulfillment_kind text NOT NULL CHECK (fulfillment_kind IN ('product', 'benefit', 'activity', 'service')),
  product_id uuid,
  benefit_definition_id uuid,
  activity_id uuid,
  points_required integer NOT NULL CHECK (points_required > 0),
  cost_amount_minor bigint NOT NULL CHECK (cost_amount_minor >= 0),
  currency char(3) NOT NULL DEFAULT 'CNY' CHECK (currency ~ '^[A-Z]{3}$'),
  total_inventory integer CHECK (total_inventory IS NULL OR total_inventory >= 0),
  daily_inventory integer CHECK (daily_inventory IS NULL OR daily_inventory >= 0),
  member_daily_limit smallint NOT NULL DEFAULT 1 CHECK (member_daily_limit BETWEEN 1 AND 100),
  member_rolling_30_day_limit smallint NOT NULL DEFAULT 4 CHECK (member_rolling_30_day_limit BETWEEN 1 AND 500),
  member_lifetime_limit integer CHECK (member_lifetime_limit IS NULL OR member_lifetime_limit > 0),
  minimum_tier text NOT NULL DEFAULT 'member' CHECK (minimum_tier IN ('member', 'silver', 'gold')),
  requires_table_session boolean NOT NULL DEFAULT true,
  requires_employee_fulfillment boolean NOT NULL DEFAULT true,
  cancellation_allowed_before_fulfillment boolean NOT NULL DEFAULT true,
  restore_expired_points_days smallint NOT NULL DEFAULT 7 CHECK (restore_expired_points_days BETWEEN 0 AND 30),
  available_from timestamptz NOT NULL,
  available_until timestamptz,
  fulfillment_timeout_minutes integer NOT NULL DEFAULT 240 CHECK (fulfillment_timeout_minutes BETWEEN 5 AND 10080),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'retired')),
  display_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(display_snapshot)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, catalog_version_id)
    REFERENCES mbox.redemption_catalog_versions(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, product_id) REFERENCES mbox.products(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, benefit_definition_id)
    REFERENCES mbox.loyalty_benefit_definitions(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, activity_id)
    REFERENCES mbox.community_activities(tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, catalog_version_id, item_code),
  UNIQUE (tenant_id, store_id, public_id),
  UNIQUE (tenant_id, store_id, id),
  CHECK (available_until IS NULL OR available_until > available_from),
  CHECK (
    (fulfillment_kind='product' AND product_id IS NOT NULL AND benefit_definition_id IS NULL AND activity_id IS NULL)
    OR (fulfillment_kind='benefit' AND product_id IS NULL AND benefit_definition_id IS NOT NULL AND activity_id IS NULL)
    OR (fulfillment_kind='activity' AND product_id IS NULL AND benefit_definition_id IS NULL AND activity_id IS NOT NULL)
    OR (fulfillment_kind='service' AND product_id IS NULL AND benefit_definition_id IS NULL AND activity_id IS NULL)
  )
);

CREATE TABLE mbox.redemption_inventory_balances (
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  catalog_item_id uuid NOT NULL,
  total_consumed integer NOT NULL DEFAULT 0 CHECK (total_consumed >= 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, store_id, catalog_item_id),
  FOREIGN KEY (tenant_id, store_id, catalog_item_id)
    REFERENCES mbox.redemption_catalog_items(tenant_id, store_id, id)
);

CREATE TABLE mbox.redemption_daily_inventory (
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  catalog_item_id uuid NOT NULL,
  business_date date NOT NULL,
  consumed integer NOT NULL DEFAULT 0 CHECK (consumed >= 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, store_id, catalog_item_id, business_date),
  FOREIGN KEY (tenant_id, store_id, catalog_item_id)
    REFERENCES mbox.redemption_catalog_items(tenant_id, store_id, id)
);

CREATE TABLE mbox.member_redemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  public_id text NOT NULL CHECK (length(public_id) BETWEEN 8 AND 128),
  membership_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  catalog_item_id uuid NOT NULL,
  catalog_version_id uuid NOT NULL,
  table_session_id uuid,
  business_date date NOT NULL,
  points_used integer NOT NULL CHECK (points_used > 0),
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity=1),
  status text NOT NULL DEFAULT 'authorizing'
    CHECK (status IN ('authorizing', 'awaiting_fulfillment', 'fulfilled', 'cancelled', 'failed', 'expired')),
  fulfillment_kind text NOT NULL CHECK (fulfillment_kind IN ('product', 'benefit', 'activity', 'service')),
  order_id uuid,
  order_item_id uuid,
  expires_at timestamptz NOT NULL,
  fulfilled_by_employee_id uuid,
  fulfilled_at timestamptz,
  cancelled_at timestamptz,
  failure_reason text,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 160),
  request_fingerprint char(64) NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, membership_id)
    REFERENCES mbox.customer_memberships(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, customer_id) REFERENCES mbox.customers(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, catalog_item_id)
    REFERENCES mbox.redemption_catalog_items(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, catalog_version_id)
    REFERENCES mbox.redemption_catalog_versions(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, table_session_id)
    REFERENCES mbox.table_sessions(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, order_id) REFERENCES mbox.orders(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, order_item_id) REFERENCES mbox.order_items(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, fulfilled_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, public_id),
  UNIQUE (tenant_id, store_id, idempotency_key),
  UNIQUE (tenant_id, store_id, id),
  CHECK (
    (status='authorizing' AND order_id IS NULL AND order_item_id IS NULL
      AND fulfilled_at IS NULL AND cancelled_at IS NULL)
    OR (status='awaiting_fulfillment' AND fulfilled_at IS NULL AND cancelled_at IS NULL)
    OR (status='fulfilled' AND fulfilled_at IS NOT NULL AND fulfilled_by_employee_id IS NOT NULL)
    OR (status IN ('cancelled','failed','expired') AND cancelled_at IS NOT NULL)
  )
);

CREATE TABLE mbox.redemption_point_allocations (
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  redemption_id uuid NOT NULL,
  point_lot_id uuid NOT NULL,
  points integer NOT NULL CHECK (points > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, store_id, redemption_id, point_lot_id),
  FOREIGN KEY (tenant_id, store_id, redemption_id)
    REFERENCES mbox.member_redemptions(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, point_lot_id)
    REFERENCES mbox.loyalty_point_lots(tenant_id, store_id, id)
);

CREATE TABLE mbox.redemption_fulfillment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  redemption_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('authorized', 'kds_created', 'fulfilled', 'cancelled', 'failed', 'points_restored')),
  from_status text,
  to_status text NOT NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('customer', 'employee', 'system')),
  actor_ref text,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 2 AND 500),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 160),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id, redemption_id)
    REFERENCES mbox.member_redemptions(tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, redemption_id, idempotency_key),
  UNIQUE (tenant_id, store_id, id)
);

CREATE TABLE mbox.member_redemption_entitlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  redemption_id uuid NOT NULL,
  entitlement_kind text NOT NULL CHECK (entitlement_kind IN ('benefit','activity','service')),
  benefit_id uuid,
  activity_id uuid,
  status text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','consumed','cancelled')),
  issued_by_employee_id uuid NOT NULL,
  issued_at timestamptz NOT NULL,
  consumed_at timestamptz,
  cancelled_at timestamptz,
  FOREIGN KEY (tenant_id, store_id, redemption_id)
    REFERENCES mbox.member_redemptions(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, benefit_id)
    REFERENCES mbox.benefits(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, activity_id)
    REFERENCES mbox.community_activities(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, issued_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, redemption_id),
  UNIQUE (tenant_id, store_id, id),
  CHECK (
    (entitlement_kind='benefit' AND benefit_id IS NOT NULL AND activity_id IS NULL)
    OR (entitlement_kind='activity' AND benefit_id IS NULL AND activity_id IS NOT NULL)
    OR (entitlement_kind='service' AND benefit_id IS NULL AND activity_id IS NULL)
  ),
  CHECK (
    (status='issued' AND consumed_at IS NULL AND cancelled_at IS NULL)
    OR (status='consumed' AND consumed_at IS NOT NULL AND cancelled_at IS NULL)
    OR (status='cancelled' AND cancelled_at IS NOT NULL)
  )
);

ALTER TABLE mbox.order_items
  ADD COLUMN pricing_kind text NOT NULL DEFAULT 'none'
    CHECK (pricing_kind IN ('none', 'discount', 'gift', 'points_redemption'));

CREATE TABLE mbox.loyalty_redemption_order_items (
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  redemption_id uuid NOT NULL,
  order_id uuid NOT NULL,
  order_item_id uuid NOT NULL,
  points_used integer NOT NULL CHECK (points_used > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, store_id, redemption_id, order_item_id),
  FOREIGN KEY (tenant_id, store_id, redemption_id)
    REFERENCES mbox.member_redemptions(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, order_id, order_item_id)
    REFERENCES mbox.order_items(tenant_id, store_id, order_id, id),
  UNIQUE (tenant_id, store_id, order_item_id)
);

CREATE INDEX redemption_catalog_items_public_idx
  ON mbox.redemption_catalog_items (tenant_id, store_id, status, available_from, available_until, id);
CREATE INDEX member_redemptions_member_timeline_idx
  ON mbox.member_redemptions (tenant_id, store_id, membership_id, created_at DESC, id);
CREATE INDEX member_redemptions_fulfillment_idx
  ON mbox.member_redemptions (tenant_id, store_id, status, expires_at, id)
  WHERE status IN ('authorizing','awaiting_fulfillment');

CREATE OR REPLACE FUNCTION mbox.enforce_kds_paid_fulfillment_gate()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM mbox.order_items item
    JOIN mbox.orders order_row
      ON order_row.tenant_id=item.tenant_id AND order_row.store_id=item.store_id
     AND order_row.id=item.order_id
    WHERE item.tenant_id=NEW.tenant_id AND item.store_id=NEW.store_id
      AND item.id=NEW.order_item_id AND order_row.fulfillment_state='active'
      AND (
        item.pricing_kind<>'points_redemption'
        OR EXISTS (
          SELECT 1 FROM mbox.loyalty_redemption_order_items link
          JOIN mbox.member_redemptions redemption
            ON redemption.tenant_id=link.tenant_id AND redemption.store_id=link.store_id
           AND redemption.id=link.redemption_id
          WHERE link.tenant_id=item.tenant_id AND link.store_id=item.store_id
            AND link.order_item_id=item.id
            AND redemption.status IN ('authorizing','awaiting_fulfillment','fulfilled')
        )
      )
  ) THEN
    RAISE EXCEPTION 'KDS task requires an active paid or points-authorized fulfillment order'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION mbox.enforce_order_payment_fulfillment_gate()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE reservation_minutes integer;
DECLARE points_redemption_authorized boolean := false;
BEGIN
  IF TG_OP='INSERT' AND NEW.settlement_mode='immediate_payment' AND NEW.payment_status<>'paid' THEN
    SELECT policy.payment_reservation_minutes INTO reservation_minutes
    FROM mbox.store_commerce_policies policy
    WHERE policy.tenant_id=NEW.tenant_id AND policy.store_id=NEW.store_id;
    NEW.fulfillment_state := 'awaiting_payment';
    NEW.fulfillment_expires_at := COALESCE(
      NEW.fulfillment_expires_at,
      clock_timestamp() + make_interval(mins => COALESCE(reservation_minutes, 10))
    );
    NEW.fulfillment_activated_at := NULL;
    NEW.fulfillment_released_at := NULL;
  ELSIF TG_OP='INSERT' THEN
    NEW.fulfillment_state := 'active';
    NEW.fulfillment_expires_at := NULL;
    NEW.fulfillment_activated_at := COALESCE(NEW.fulfillment_activated_at, clock_timestamp());
    NEW.fulfillment_released_at := NULL;
  ELSIF OLD.fulfillment_state<>'active' AND NEW.fulfillment_state='active'
    AND NEW.settlement_mode='immediate_payment' AND NEW.payment_status<>'paid' THEN
    SELECT NEW.total_amount_minor=0
      AND EXISTS (
        SELECT 1 FROM mbox.order_items item
        WHERE item.tenant_id=NEW.tenant_id AND item.store_id=NEW.store_id
          AND item.order_id=NEW.id AND item.parent_order_item_id IS NULL
          AND item.status<>'cancelled'
      )
      AND NOT EXISTS (
        SELECT 1 FROM mbox.order_items item
        WHERE item.tenant_id=NEW.tenant_id AND item.store_id=NEW.store_id
          AND item.order_id=NEW.id AND item.parent_order_item_id IS NULL
          AND item.status<>'cancelled'
          AND (
            item.pricing_kind<>'points_redemption'
            OR NOT EXISTS (
              SELECT 1 FROM mbox.loyalty_redemption_order_items link
              JOIN mbox.member_redemptions redemption
                ON redemption.tenant_id=link.tenant_id AND redemption.store_id=link.store_id
               AND redemption.id=link.redemption_id
              WHERE link.tenant_id=item.tenant_id AND link.store_id=item.store_id
                AND link.order_id=item.order_id AND link.order_item_id=item.id
                AND redemption.status IN ('authorizing','awaiting_fulfillment','fulfilled')
            )
          )
      ) INTO points_redemption_authorized;
    IF NOT points_redemption_authorized THEN
      RAISE EXCEPTION 'immediate-payment order cannot enter active fulfillment before trusted payment or points authorization'
        USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION mbox.activate_order_fulfillment_capacity(
  p_tenant_id uuid, p_store_id uuid, p_order_id uuid
) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE affected_count integer;
DECLARE order_row record;
DECLARE points_redemption_authorized boolean := false;
BEGIN
  SELECT settlement_mode, fulfillment_state, payment_status, total_amount_minor INTO order_row
  FROM mbox.orders
  WHERE tenant_id=p_tenant_id AND store_id=p_store_id AND id=p_order_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'capacity order not found' USING ERRCODE='P0002'; END IF;
  IF order_row.settlement_mode<>'immediate_payment' THEN RETURN 0; END IF;
  SELECT order_row.total_amount_minor=0
    AND EXISTS (
      SELECT 1 FROM mbox.loyalty_redemption_order_items link
      JOIN mbox.member_redemptions redemption
        ON redemption.tenant_id=link.tenant_id AND redemption.store_id=link.store_id
       AND redemption.id=link.redemption_id
      WHERE link.tenant_id=p_tenant_id AND link.store_id=p_store_id
        AND link.order_id=p_order_id
        AND redemption.status IN ('authorizing','awaiting_fulfillment','fulfilled')
    ) INTO points_redemption_authorized;
  IF order_row.fulfillment_state<>'active'
    OR (order_row.payment_status<>'paid' AND NOT points_redemption_authorized) THEN
    RAISE EXCEPTION 'capacity activation requires trusted paid or points-authorized fulfillment'
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

CREATE OR REPLACE FUNCTION mbox.reject_published_redemption_catalog_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' AND OLD.status='published' THEN
    RAISE EXCEPTION 'published redemption catalog versions are immutable';
  END IF;
  IF TG_OP='UPDATE' AND OLD.status='published' THEN
    IF NEW.status<>'retired'
      OR NEW.id<>OLD.id OR NEW.tenant_id<>OLD.tenant_id OR NEW.store_id<>OLD.store_id
      OR NEW.version<>OLD.version OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
      OR NEW.drafted_by_employee_id<>OLD.drafted_by_employee_id
      OR NEW.approved_by_employee_id IS DISTINCT FROM OLD.approved_by_employee_id
      OR NEW.approved_at IS DISTINCT FROM OLD.approved_at OR NEW.reason<>OLD.reason
      OR NEW.created_at<>OLD.created_at THEN
      RAISE EXCEPTION 'published redemption catalog versions are immutable';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;

CREATE OR REPLACE FUNCTION mbox.reject_non_draft_redemption_item_change()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_status text;
BEGIN
  SELECT status INTO parent_status
  FROM mbox.redemption_catalog_versions
  WHERE tenant_id=COALESCE(NEW.tenant_id,OLD.tenant_id)
    AND store_id=COALESCE(NEW.store_id,OLD.store_id)
    AND id=COALESCE(NEW.catalog_version_id,OLD.catalog_version_id);
  IF parent_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'redemption catalog items are mutable only while their version is draft';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;

CREATE OR REPLACE FUNCTION mbox.reject_published_redemption_benefit_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM mbox.redemption_catalog_items item
    JOIN mbox.redemption_catalog_versions version
      ON version.tenant_id=item.tenant_id AND version.store_id=item.store_id
     AND version.id=item.catalog_version_id
    WHERE item.tenant_id=COALESCE(NEW.tenant_id,OLD.tenant_id)
      AND item.store_id=COALESCE(NEW.store_id,OLD.store_id)
      AND item.benefit_definition_id=COALESCE(NEW.id,OLD.id)
      AND version.status IN ('published','retired')
  ) THEN
    RAISE EXCEPTION 'benefit definitions referenced by published redemption catalogs are immutable';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;

CREATE TRIGGER redemption_catalog_versions_immutable
  BEFORE UPDATE OR DELETE ON mbox.redemption_catalog_versions
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_published_redemption_catalog_change();
CREATE TRIGGER redemption_catalog_versions_touch_updated_at
  BEFORE UPDATE ON mbox.redemption_catalog_versions
  FOR EACH ROW EXECUTE FUNCTION mbox.touch_updated_at();
CREATE TRIGGER loyalty_benefit_definitions_touch_updated_at
  BEFORE UPDATE ON mbox.loyalty_benefit_definitions
  FOR EACH ROW EXECUTE FUNCTION mbox.touch_updated_at();
CREATE TRIGGER redemption_catalog_items_draft_only
  BEFORE INSERT OR UPDATE OR DELETE ON mbox.redemption_catalog_items
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_non_draft_redemption_item_change();
CREATE TRIGGER loyalty_benefit_definitions_published_reference_immutable
  BEFORE UPDATE OR DELETE ON mbox.loyalty_benefit_definitions
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_published_redemption_benefit_change();
CREATE TRIGGER redemption_inventory_balances_touch_updated_at
  BEFORE UPDATE ON mbox.redemption_inventory_balances
  FOR EACH ROW EXECUTE FUNCTION mbox.touch_updated_at();
CREATE TRIGGER redemption_daily_inventory_touch_updated_at
  BEFORE UPDATE ON mbox.redemption_daily_inventory
  FOR EACH ROW EXECUTE FUNCTION mbox.touch_updated_at();
CREATE TRIGGER member_redemptions_touch_updated_at
  BEFORE UPDATE ON mbox.member_redemptions
  FOR EACH ROW EXECUTE FUNCTION mbox.touch_updated_at();
CREATE TRIGGER redemption_fulfillment_events_append_only
  BEFORE UPDATE OR DELETE ON mbox.redemption_fulfillment_events
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();
CREATE TRIGGER member_redemption_entitlements_append_only
  BEFORE UPDATE OR DELETE ON mbox.member_redemption_entitlements
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'loyalty_redemption_controls','redemption_catalog_versions','loyalty_benefit_definitions',
    'redemption_catalog_items',
    'redemption_inventory_balances','redemption_daily_inventory','member_redemptions',
    'redemption_point_allocations','redemption_fulfillment_events','loyalty_redemption_order_items',
    'member_redemption_entitlements'
  ] LOOP
    EXECUTE format('ALTER TABLE mbox.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE mbox.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_store_isolation ON mbox.%I USING (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())', table_name
    );
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON TABLE mbox.%I TO mbox_runtime', table_name);
  END LOOP;
END $$;

REVOKE DELETE ON TABLE mbox.loyalty_redemption_controls, mbox.redemption_catalog_versions,
  mbox.loyalty_benefit_definitions, mbox.redemption_catalog_items, mbox.redemption_inventory_balances,
  mbox.redemption_daily_inventory, mbox.member_redemptions FROM mbox_runtime;
REVOKE UPDATE, DELETE ON TABLE mbox.redemption_point_allocations,
  mbox.redemption_fulfillment_events, mbox.loyalty_redemption_order_items,
  mbox.member_redemption_entitlements FROM mbox_runtime;

INSERT INTO mbox.staff_permission_definitions (
  tenant_id, store_id, code, name, category, description, status
)
SELECT store.tenant_id, store.id, permission.code, permission.name,
  'loyalty', permission.description, 'active'
FROM mbox.stores store CROSS JOIN (VALUES
  ('loyalty.redemption.catalog.manage','编辑积分兑换目录','创建兑换目录草稿，不得自行发布'),
  ('loyalty.redemption.catalog.approve','复核积分兑换目录','由另一名授权人员复核目录成本、库存与履约规则'),
  ('loyalty.redemption.control','控制积分兑换开放','开放、暂停或关闭新兑换，不改变历史记录'),
  ('loyalty.redemption.exception','处理积分兑换异常','处理缺货、超时和积分返还异常')
) permission(code,name,description)
ON CONFLICT (tenant_id,store_id,code) DO UPDATE
SET name=EXCLUDED.name,category=EXCLUDED.category,description=EXCLUDED.description,status='active';

COMMENT ON TABLE mbox.member_redemptions IS
  'Authoritative points-redemption state. A product KDS task is legal only after points lots are allocated and the order item is strongly linked.';

COMMIT;
