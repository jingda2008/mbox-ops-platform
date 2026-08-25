BEGIN;

-- A community activity is the event promise.  A package is the one selectable
-- ticket/plan inside that promise.  It intentionally is not an order: activity
-- attendance must never manufacture a table session, order item or KDS task.
CREATE TABLE mbox.community_activity_packages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  activity_id uuid NOT NULL,
  public_id text NOT NULL CHECK (length(public_id) BETWEEN 8 AND 128),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 120),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 1000),
  image_url text,
  included_items text[] NOT NULL DEFAULT '{}'::text[] CHECK (cardinality(included_items) <= 100),
  capacity integer NOT NULL CHECK (capacity BETWEEN 1 AND 1000),
  member_purchase_limit integer NOT NULL DEFAULT 1 CHECK (member_purchase_limit BETWEEN 1 AND 20),
  fee_amount_minor bigint NOT NULL DEFAULT 0 CHECK (fee_amount_minor >= 0),
  deposit_amount_minor bigint NOT NULL DEFAULT 0 CHECK (deposit_amount_minor >= 0),
  fee_basis text NOT NULL DEFAULT 'per_registration'
    CHECK (fee_basis IN ('per_person','per_registration')),
  payment_mode text NOT NULL DEFAULT 'none'
    CHECK (payment_mode IN ('none','deposit_optional','deposit_required','full_required')),
  payment_deadline_minutes integer NOT NULL DEFAULT 15
    CHECK (payment_deadline_minutes BETWEEN 5 AND 1440),
  payment_rule_text text NOT NULL DEFAULT '本套餐无需预付'
    CHECK (length(btrim(payment_rule_text)) BETWEEN 2 AND 240),
  redemption_policy_version text,
  refund_policy_version text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','paused')),
  sort_order integer NOT NULL DEFAULT 100 CHECK (sort_order BETWEEN 0 AND 10000),
  available_from timestamptz,
  available_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
  FOREIGN KEY (tenant_id,store_id,activity_id)
    REFERENCES mbox.community_activities(tenant_id,store_id,id),
  CHECK (deposit_amount_minor <= fee_amount_minor),
  CHECK (
    (payment_mode='none' AND deposit_amount_minor=0)
    OR (payment_mode IN ('deposit_optional','deposit_required')
      AND fee_amount_minor>0 AND deposit_amount_minor>0)
    OR (payment_mode='full_required' AND fee_amount_minor>0 AND deposit_amount_minor=0)
  ),
  CHECK (available_until IS NULL OR available_from IS NULL OR available_until>available_from),
  UNIQUE (tenant_id,store_id,public_id),
  UNIQUE (tenant_id,store_id,id)
);

CREATE INDEX community_activity_packages_activity_idx
  ON mbox.community_activity_packages(tenant_id,store_id,activity_id,status,sort_order,id);

CREATE TABLE mbox.community_activity_package_components (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  activity_package_id uuid NOT NULL,
  inventory_item_id uuid NOT NULL,
  quantity numeric(18,6) NOT NULL CHECK (quantity>0),
  per_participant boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 100 CHECK (sort_order BETWEEN 0 AND 10000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
  FOREIGN KEY (tenant_id,store_id,activity_package_id)
    REFERENCES mbox.community_activity_packages(tenant_id,store_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,store_id,inventory_item_id)
    REFERENCES mbox.inventory_items(tenant_id,store_id,id),
  UNIQUE (tenant_id,store_id,activity_package_id,inventory_item_id),
  UNIQUE (tenant_id,store_id,id)
);

CREATE INDEX community_activity_package_components_package_idx
  ON mbox.community_activity_package_components(tenant_id,store_id,activity_package_id,sort_order,id);

ALTER TABLE mbox.community_activity_registrations
  ADD COLUMN activity_package_id uuid,
  ADD COLUMN activity_package_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(activity_package_snapshot)='object'),
  ADD CONSTRAINT community_activity_registration_package_fk
    FOREIGN KEY (tenant_id,store_id,activity_package_id)
    REFERENCES mbox.community_activity_packages(tenant_id,store_id,id),
  ADD CONSTRAINT community_activity_registration_package_shape_ck CHECK (
    (activity_package_id IS NULL AND activity_package_snapshot='{}'::jsonb)
    OR (activity_package_id IS NOT NULL
      AND activity_package_snapshot ? 'publicId'
      AND activity_package_snapshot ? 'name'
      AND activity_package_snapshot ? 'feeAmountMinor'
      AND activity_package_snapshot ? 'paymentMode')
  );

-- An activity ticket can stand on its own.  At most one package may be added
-- to it; this flag is deliberately activity-wide so two packages can never
-- both become accidentally mandatory.
ALTER TABLE mbox.community_activities
  ADD COLUMN package_selection_required boolean NOT NULL DEFAULT false;

CREATE INDEX community_activity_registrations_package_idx
  ON mbox.community_activity_registrations(tenant_id,store_id,activity_package_id,status,id)
  WHERE activity_package_id IS NOT NULL;

-- These reservations use a registration and package component as their
-- reference.  They are deliberately separate from inventory_order_reservations:
-- no activity registration can masquerade as a table order.
CREATE TABLE mbox.community_activity_package_inventory_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  registration_id uuid NOT NULL,
  registration_cycle integer NOT NULL CHECK (registration_cycle>=1),
  package_component_id uuid NOT NULL,
  inventory_item_id uuid NOT NULL,
  quantity numeric(18,6) NOT NULL CHECK (quantity>0),
  status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','consumed','released')),
  expires_at timestamptz,
  movement_id uuid,
  release_reason text,
  reserved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  consumed_at timestamptz,
  released_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
  FOREIGN KEY (tenant_id,store_id,registration_id)
    REFERENCES mbox.community_activity_registrations(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,package_component_id)
    REFERENCES mbox.community_activity_package_components(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,inventory_item_id)
    REFERENCES mbox.inventory_items(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,inventory_item_id,movement_id)
    REFERENCES mbox.inventory_movements(tenant_id,store_id,inventory_item_id,id),
  CHECK (
    (status='reserved' AND expires_at IS NOT NULL AND movement_id IS NULL
      AND consumed_at IS NULL AND released_at IS NULL)
    OR (status='consumed' AND expires_at IS NULL AND movement_id IS NOT NULL
      AND consumed_at IS NOT NULL AND released_at IS NULL)
    OR (status='released' AND expires_at IS NULL AND movement_id IS NULL
      AND consumed_at IS NULL AND released_at IS NOT NULL AND length(btrim(release_reason))>0)
  ),
  UNIQUE (tenant_id,store_id,registration_id,registration_cycle,package_component_id),
  UNIQUE (tenant_id,store_id,id)
);

CREATE INDEX community_activity_package_inventory_reservations_due_idx
  ON mbox.community_activity_package_inventory_reservations(tenant_id,store_id,expires_at,id)
  WHERE status='reserved';

CREATE INDEX community_activity_package_inventory_reservations_registration_idx
  ON mbox.community_activity_package_inventory_reservations(tenant_id,store_id,registration_id,registration_cycle,status,id);

-- Check-in proves attendance, not physical handover.  A separate intent keeps
-- that distinction visible: only its explicit delivery action can consume the
-- corresponding reservation and write an inventory movement.
CREATE TABLE mbox.community_activity_package_fulfillment_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  registration_id uuid NOT NULL,
  registration_cycle integer NOT NULL CHECK (registration_cycle>=1),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivered','cancelled')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  delivered_at timestamptz,
  delivered_by_employee_id uuid,
  cancelled_at timestamptz,
  cancel_reason text,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
  FOREIGN KEY (tenant_id,store_id,registration_id)
    REFERENCES mbox.community_activity_registrations(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,delivered_by_employee_id)
    REFERENCES mbox.employees(tenant_id,store_id,id),
  UNIQUE (tenant_id,store_id,registration_id,registration_cycle),
  UNIQUE (tenant_id,store_id,id),
  CHECK (
    (status='pending' AND delivered_at IS NULL AND delivered_by_employee_id IS NULL
      AND cancelled_at IS NULL AND cancel_reason IS NULL)
    OR (status='delivered' AND delivered_at IS NOT NULL AND delivered_by_employee_id IS NOT NULL
      AND cancelled_at IS NULL AND cancel_reason IS NULL)
    OR (status='cancelled' AND delivered_at IS NULL AND delivered_by_employee_id IS NULL
      AND cancelled_at IS NOT NULL AND length(btrim(cancel_reason)) BETWEEN 2 AND 500)
  )
);
CREATE TRIGGER community_activity_package_fulfillment_intents_touch
  BEFORE UPDATE ON mbox.community_activity_package_fulfillment_intents
  FOR EACH ROW EXECUTE FUNCTION mbox.touch_updated_at();

CREATE TRIGGER community_activity_packages_touch
  BEFORE UPDATE ON mbox.community_activity_packages
  FOR EACH ROW EXECUTE FUNCTION mbox.touch_updated_at();
CREATE TRIGGER community_activity_package_components_touch
  BEFORE UPDATE ON mbox.community_activity_package_components
  FOR EACH ROW EXECUTE FUNCTION mbox.touch_updated_at();
CREATE TRIGGER community_activity_package_inventory_reservations_touch
  BEFORE UPDATE ON mbox.community_activity_package_inventory_reservations
  FOR EACH ROW EXECUTE FUNCTION mbox.touch_updated_at();

-- Published package promises cannot be repriced, resized or have their stock
-- recipe silently rewritten.  Later pause/resume is intentionally allowed.
CREATE FUNCTION mbox.protect_published_activity_package_promises()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status<>'draft' AND ROW(
    NEW.activity_id,NEW.public_id,NEW.name,NEW.description,NEW.image_url,NEW.included_items,
    NEW.capacity,NEW.fee_amount_minor,NEW.deposit_amount_minor,NEW.fee_basis,
    NEW.payment_mode,NEW.payment_deadline_minutes,NEW.payment_rule_text,
    NEW.member_purchase_limit,NEW.redemption_policy_version,NEW.refund_policy_version,
    NEW.sort_order,NEW.available_from,NEW.available_until
  ) IS DISTINCT FROM ROW(
    OLD.activity_id,OLD.public_id,OLD.name,OLD.description,OLD.image_url,OLD.included_items,
    OLD.capacity,OLD.fee_amount_minor,OLD.deposit_amount_minor,OLD.fee_basis,
    OLD.payment_mode,OLD.payment_deadline_minutes,OLD.payment_rule_text,
    OLD.member_purchase_limit,OLD.redemption_policy_version,OLD.refund_policy_version,
    OLD.sort_order,OLD.available_from,OLD.available_until
  ) THEN
    RAISE EXCEPTION 'published activity package promises are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER community_activity_packages_published_promises_protect
  BEFORE UPDATE ON mbox.community_activity_packages
  FOR EACH ROW EXECUTE FUNCTION mbox.protect_published_activity_package_promises();

CREATE FUNCTION mbox.protect_published_activity_package_components()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE package_status text;
BEGIN
  SELECT status INTO package_status
  FROM mbox.community_activity_packages
  WHERE tenant_id=COALESCE(NEW.tenant_id,OLD.tenant_id)
    AND store_id=COALESCE(NEW.store_id,OLD.store_id)
    AND id=COALESCE(NEW.activity_package_id,OLD.activity_package_id);
  IF package_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'published activity package components are immutable' USING ERRCODE='23514';
  END IF;
  IF TG_OP='DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER community_activity_package_components_published_protect
  BEFORE INSERT OR UPDATE OR DELETE ON mbox.community_activity_package_components
  FOR EACH ROW EXECUTE FUNCTION mbox.protect_published_activity_package_components();

-- Package publication is tied to the existing independent activity publication
-- action.  It does not publish new packages after an activity is already live.
CREATE FUNCTION mbox.publish_activity_packages_with_activity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status='draft' AND NEW.status='published' THEN
    UPDATE mbox.community_activity_packages
    SET status='published',updated_at=clock_timestamp()
    WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id
      AND activity_id=NEW.id AND status='draft';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER community_activity_packages_publish_with_activity
  AFTER UPDATE OF status ON mbox.community_activities
  FOR EACH ROW EXECUTE FUNCTION mbox.publish_activity_packages_with_activity();

-- Cancellation/no-show/refund releases activity-package holds in the same
-- transaction. Check-in only creates a fulfillment intent; actual consumption
-- is deliberately performed by an explicit delivery operation with its
-- responsible employee, not by this generic trigger.
CREATE FUNCTION mbox.release_activity_package_inventory_on_registration_exit()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE reservation record;
BEGIN
  IF OLD.status IN ('reserved','payment_pending','confirmed','checked_in')
    AND NEW.status IN ('cancelled','no_show','refunded') THEN
    UPDATE mbox.community_activity_package_fulfillment_intents
    SET status='cancelled',cancelled_at=clock_timestamp(),
      cancel_reason='registration_'||NEW.status,updated_at=clock_timestamp()
    WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id
      AND registration_id=NEW.id AND registration_cycle=NEW.registration_cycle
      AND status='pending';
    FOR reservation IN
      SELECT id,inventory_item_id,quantity
      FROM mbox.community_activity_package_inventory_reservations
      WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id
        AND registration_id=NEW.id AND registration_cycle=NEW.registration_cycle
        AND status='reserved'
      ORDER BY inventory_item_id,id
      FOR UPDATE
    LOOP
      UPDATE mbox.inventory_balances
      SET reserved_quantity=reserved_quantity-reservation.quantity,updated_at=clock_timestamp()
      WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id
        AND inventory_item_id=reservation.inventory_item_id
        AND reserved_quantity>=reservation.quantity;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'activity package inventory reservation balance is inconsistent' USING ERRCODE='23514';
      END IF;
      UPDATE mbox.community_activity_package_inventory_reservations
      SET status='released',expires_at=NULL,release_reason='registration_'||NEW.status,
        released_at=clock_timestamp(),updated_at=clock_timestamp()
      WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=reservation.id
        AND status='reserved';
      IF NOT FOUND THEN
        RAISE EXCEPTION 'activity package inventory reservation release raced' USING ERRCODE='40001';
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER community_activity_registration_package_inventory_release
  AFTER UPDATE OF status ON mbox.community_activity_registrations
  FOR EACH ROW EXECUTE FUNCTION mbox.release_activity_package_inventory_on_registration_exit();

-- A release event can now finish with a package-specific blocker without
-- falsely claiming the whole activity queue is empty.
ALTER TABLE mbox.activity_waitlist_release_events
  DROP CONSTRAINT activity_waitlist_release_events_resolution_check,
  ADD CONSTRAINT activity_waitlist_release_events_resolution_check
    CHECK (resolution IN ('activity_unavailable','waitlist_empty','head_party_does_not_fit','package_unavailable'));

ALTER TABLE mbox.community_activity_packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.community_activity_packages FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.community_activity_packages
  USING (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())
  WITH CHECK (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());

ALTER TABLE mbox.community_activity_package_components ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.community_activity_package_components FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.community_activity_package_components
  USING (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())
  WITH CHECK (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());

ALTER TABLE mbox.community_activity_package_inventory_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.community_activity_package_inventory_reservations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.community_activity_package_inventory_reservations
  USING (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())
  WITH CHECK (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());

ALTER TABLE mbox.community_activity_package_fulfillment_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.community_activity_package_fulfillment_intents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.community_activity_package_fulfillment_intents
  USING (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())
  WITH CHECK (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());

GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE mbox.community_activity_packages TO mbox_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE mbox.community_activity_package_components TO mbox_runtime;
GRANT SELECT,INSERT,UPDATE ON TABLE mbox.community_activity_package_inventory_reservations TO mbox_runtime;
GRANT SELECT,INSERT,UPDATE ON TABLE mbox.community_activity_package_fulfillment_intents TO mbox_runtime;

COMMENT ON TABLE mbox.community_activity_packages IS
  'One optional or required add-on package inside a community activity. Its price is added to the activity ticket and its commercial promise is immutable after publication.';
COMMENT ON TABLE mbox.community_activity_package_components IS
  'Direct inventory components reserved per selected activity package; not order or KDS components.';
COMMENT ON TABLE mbox.community_activity_package_inventory_reservations IS
  'Activity-package inventory hold. It reserves on confirmed/free or payment-pending registration, releases on terminal exit, and is consumed only on explicit post-check-in delivery.';
COMMENT ON TABLE mbox.community_activity_package_fulfillment_intents IS
  'Post-check-in delivery intent for an activity package. It is not a table order or KDS task; stock is consumed only when delivery is explicitly recorded.';

COMMIT;
