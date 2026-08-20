BEGIN;

-- The former points_reward value has no approved earning policy, budget,
-- settlement state or reversal contract.  Refuse to reinterpret historical
-- values as money-like loyalty facts.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM mbox.community_activities WHERE points_reward<>0
  ) THEN
    RAISE EXCEPTION 'nonzero activity points_reward requires explicit reconciliation before 088';
  END IF;
END $$;

ALTER TABLE mbox.community_activities
  ADD CONSTRAINT community_activities_points_reward_disabled_ck
  CHECK (points_reward=0);

-- Older waitlisted rows deliberately discarded the requested payment choice.
-- A paid-mode waitlist therefore cannot be promoted safely without operator
-- reconciliation; fail closed instead of inventing intent from JSON.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM mbox.community_activity_registrations registration
    JOIN mbox.community_activities activity
      ON activity.tenant_id=registration.tenant_id
     AND activity.store_id=registration.store_id
     AND activity.id=registration.activity_id
    WHERE registration.status='waitlisted'
      AND activity.registration_payment_mode<>'none'
  ) THEN
    RAISE EXCEPTION 'paid activity waitlist intent is unavailable; reconcile before 088';
  END IF;
END $$;

ALTER TABLE mbox.community_activity_registrations
  ADD COLUMN registration_cycle integer NOT NULL DEFAULT 1,
  ADD COLUMN requested_payment_choice text,
  ADD COLUMN requested_payment_method text,
  ADD COLUMN requested_amount_due_minor bigint;

UPDATE mbox.community_activity_registrations registration
SET requested_payment_choice=registration.payment_choice,
  requested_payment_method=CASE
    WHEN registration.payment_choice='none' THEN NULL
    ELSE (
      SELECT payment.method
      FROM mbox.payments payment
      WHERE payment.tenant_id=registration.tenant_id
        AND payment.store_id=registration.store_id
        AND payment.id=registration.payment_id
    )
  END,
  requested_amount_due_minor=CASE
    WHEN registration.payment_choice='none' THEN 0
    ELSE COALESCE(
      (SELECT payment.amount_minor
       FROM mbox.payments payment
       WHERE payment.tenant_id=registration.tenant_id
         AND payment.store_id=registration.store_id
         AND payment.id=registration.payment_id),
      NULLIF(registration.amount_due_minor,0),
      NULLIF(registration.paid_amount_minor,0)
    )
  END;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM mbox.community_activity_registrations
    WHERE requested_payment_choice IS NULL
      OR requested_amount_due_minor IS NULL
      OR (
        requested_payment_choice<>'none'
        AND (requested_payment_method IS NULL OR requested_amount_due_minor<=0)
      )
  ) THEN
    RAISE EXCEPTION 'historical activity registration payment intent cannot be normalized';
  END IF;
END $$;

ALTER TABLE mbox.community_activity_registrations
  ALTER COLUMN requested_payment_choice SET NOT NULL,
  ALTER COLUMN requested_amount_due_minor SET NOT NULL,
  ADD CONSTRAINT community_activity_registration_cycle_ck
    CHECK (registration_cycle>=1),
  ADD CONSTRAINT community_activity_requested_payment_choice_ck
    CHECK (requested_payment_choice IN ('none','deposit','full')),
  ADD CONSTRAINT community_activity_requested_payment_method_ck
    CHECK (requested_payment_method IS NULL OR requested_payment_method IN ('jsapi','native_qr')),
  ADD CONSTRAINT community_activity_requested_amount_ck
    CHECK (requested_amount_due_minor>=0),
  ADD CONSTRAINT community_activity_requested_payment_shape_ck CHECK (
    (requested_payment_choice='none'
      AND requested_payment_method IS NULL AND requested_amount_due_minor=0)
    OR
    (requested_payment_choice IN ('deposit','full')
      AND requested_payment_method IS NOT NULL AND requested_amount_due_minor>0)
  );

CREATE TABLE mbox.activity_waitlist_release_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  activity_id uuid NOT NULL,
  source_registration_id uuid NOT NULL,
  source_registration_cycle integer NOT NULL CHECK (source_registration_cycle>=1),
  from_status text NOT NULL CHECK (from_status IN ('reserved','payment_pending','confirmed','checked_in')),
  to_status text NOT NULL CHECK (to_status IN ('cancelled','no_show','refunded')),
  released_seats integer NOT NULL CHECK (released_seats BETWEEN 1 AND 50),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 10000),
  last_block_reason text CHECK (last_block_reason IN ('payment_gate_closed')),
  processed_at timestamptz,
  resolution text CHECK (resolution IN ('activity_unavailable','waitlist_empty','head_party_does_not_fit')),
  promotion_count integer CHECK (promotion_count>=0),
  processed_by_worker_id text CHECK (
    processed_by_worker_id IS NULL OR length(btrim(processed_by_worker_id)) BETWEEN 3 AND 128
  ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
  FOREIGN KEY (tenant_id,store_id,activity_id)
    REFERENCES mbox.community_activities(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,source_registration_id)
    REFERENCES mbox.community_activity_registrations(tenant_id,store_id,id),
  CHECK (
    (processed_at IS NULL AND resolution IS NULL AND promotion_count IS NULL)
    OR
    (processed_at IS NOT NULL AND resolution IS NOT NULL AND promotion_count IS NOT NULL
      AND processed_by_worker_id IS NOT NULL)
  ),
  UNIQUE (tenant_id,store_id,id)
);

CREATE INDEX activity_waitlist_release_events_due_idx
  ON mbox.activity_waitlist_release_events(tenant_id,store_id,next_attempt_at,created_at,id)
  WHERE processed_at IS NULL;

CREATE TABLE mbox.activity_waitlist_promotions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  release_event_id uuid NOT NULL,
  activity_id uuid NOT NULL,
  registration_id uuid NOT NULL,
  registration_cycle integer NOT NULL CHECK (registration_cycle>=1),
  party_size integer NOT NULL CHECK (party_size BETWEEN 1 AND 50),
  promotion_status text NOT NULL CHECK (promotion_status IN ('confirmed','payment_pending')),
  payment_id uuid,
  notification_id uuid NOT NULL,
  promoted_by_worker_id text NOT NULL
    CHECK (length(btrim(promoted_by_worker_id)) BETWEEN 3 AND 128),
  promoted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
  FOREIGN KEY (tenant_id,store_id,release_event_id)
    REFERENCES mbox.activity_waitlist_release_events(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,activity_id)
    REFERENCES mbox.community_activities(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,registration_id)
    REFERENCES mbox.community_activity_registrations(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,payment_id)
    REFERENCES mbox.payments(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,notification_id)
    REFERENCES mbox.notifications(tenant_id,store_id,id),
  CHECK (
    (promotion_status='confirmed' AND payment_id IS NULL)
    OR (promotion_status='payment_pending' AND payment_id IS NOT NULL)
  ),
  UNIQUE (tenant_id,store_id,registration_id,registration_cycle),
  UNIQUE (tenant_id,store_id,id)
);

CREATE INDEX activity_waitlist_promotions_activity_idx
  ON mbox.activity_waitlist_promotions(tenant_id,store_id,activity_id,promoted_at,id);

CREATE FUNCTION mbox.queue_activity_waitlist_release()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('reserved','payment_pending','confirmed','checked_in')
    AND NEW.status IN ('cancelled','no_show','refunded') THEN
    INSERT INTO mbox.activity_waitlist_release_events(
      tenant_id,store_id,activity_id,source_registration_id,
      source_registration_cycle,from_status,to_status,released_seats
    ) VALUES (
      NEW.tenant_id,NEW.store_id,NEW.activity_id,NEW.id,
      NEW.registration_cycle,OLD.status,NEW.status,OLD.party_size
    );
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER community_activity_registration_waitlist_release
AFTER UPDATE OF status ON mbox.community_activity_registrations
FOR EACH ROW EXECUTE FUNCTION mbox.queue_activity_waitlist_release();

CREATE FUNCTION mbox.protect_activity_waitlist_release_event()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'activity waitlist release events cannot be deleted' USING ERRCODE='23514';
  END IF;
  IF NEW.id<>OLD.id OR NEW.tenant_id<>OLD.tenant_id OR NEW.store_id<>OLD.store_id
    OR NEW.activity_id<>OLD.activity_id
    OR NEW.source_registration_id<>OLD.source_registration_id
    OR NEW.source_registration_cycle<>OLD.source_registration_cycle
    OR NEW.from_status<>OLD.from_status OR NEW.to_status<>OLD.to_status
    OR NEW.released_seats<>OLD.released_seats OR NEW.created_at<>OLD.created_at THEN
    RAISE EXCEPTION 'activity waitlist release facts are immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.processed_at IS NOT NULL AND ROW(
    NEW.processed_at,NEW.resolution,NEW.promotion_count,NEW.processed_by_worker_id
  ) IS DISTINCT FROM ROW(
    OLD.processed_at,OLD.resolution,OLD.promotion_count,OLD.processed_by_worker_id
  ) THEN
    RAISE EXCEPTION 'processed activity waitlist release is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER activity_waitlist_release_events_protect
BEFORE UPDATE OR DELETE ON mbox.activity_waitlist_release_events
FOR EACH ROW EXECUTE FUNCTION mbox.protect_activity_waitlist_release_event();

CREATE TRIGGER activity_waitlist_promotions_append_only
BEFORE UPDATE OR DELETE ON mbox.activity_waitlist_promotions
FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();

-- Application permissions already permit operational status transitions, so
-- enforce the published customer promise at the database boundary as well.
CREATE FUNCTION mbox.protect_published_activity_promises()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status<>'draft' AND ROW(
    NEW.activity_kind,NEW.title,NEW.summary,NEW.cover_url,NEW.starts_at,NEW.ends_at,
    NEW.assembly_location,NEW.capacity,NEW.fee_amount_minor,NEW.deposit_amount_minor,
    NEW.fee_basis,NEW.registration_payment_mode,NEW.payment_deadline_minutes,
    NEW.payment_rule_text,NEW.points_reward,NEW.visibility,
    NEW.audience_member_levels,NEW.audience_lifecycle_stages,
    NEW.safety_policy_version,NEW.safety_acknowledgement_text,NEW.safety_requirements,
    NEW.refund_policy_version,NEW.refund_policy_summary,NEW.activity_details,
    NEW.included_items,NEW.participation_requirements,NEW.contact_instructions,
    NEW.member_benefit_text,NEW.audience_rule,NEW.safety_snapshot,
    NEW.refund_policy_snapshot,NEW.sales_copy
  ) IS DISTINCT FROM ROW(
    OLD.activity_kind,OLD.title,OLD.summary,OLD.cover_url,OLD.starts_at,OLD.ends_at,
    OLD.assembly_location,OLD.capacity,OLD.fee_amount_minor,OLD.deposit_amount_minor,
    OLD.fee_basis,OLD.registration_payment_mode,OLD.payment_deadline_minutes,
    OLD.payment_rule_text,OLD.points_reward,OLD.visibility,
    OLD.audience_member_levels,OLD.audience_lifecycle_stages,
    OLD.safety_policy_version,OLD.safety_acknowledgement_text,OLD.safety_requirements,
    OLD.refund_policy_version,OLD.refund_policy_summary,OLD.activity_details,
    OLD.included_items,OLD.participation_requirements,OLD.contact_instructions,
    OLD.member_benefit_text,OLD.audience_rule,OLD.safety_snapshot,
    OLD.refund_policy_snapshot,OLD.sales_copy
  ) THEN
    RAISE EXCEPTION 'published activity promises are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER community_activities_published_promises_protect
BEFORE UPDATE ON mbox.community_activities
FOR EACH ROW EXECUTE FUNCTION mbox.protect_published_activity_promises();

ALTER TABLE mbox.activity_waitlist_release_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.activity_waitlist_release_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.activity_waitlist_release_events
  USING (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())
  WITH CHECK (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());

ALTER TABLE mbox.activity_waitlist_promotions ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.activity_waitlist_promotions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.activity_waitlist_promotions
  USING (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())
  WITH CHECK (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());

REVOKE ALL ON TABLE mbox.activity_waitlist_release_events FROM PUBLIC;
REVOKE ALL ON TABLE mbox.activity_waitlist_promotions FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON TABLE mbox.activity_waitlist_release_events TO mbox_runtime;
GRANT SELECT,INSERT ON TABLE mbox.activity_waitlist_promotions TO mbox_runtime;

COMMENT ON COLUMN mbox.community_activity_registrations.requested_payment_choice IS
  'Customer choice captured before capacity evaluation; waitlisting never creates or starts a payment.';
COMMENT ON TABLE mbox.activity_waitlist_release_events IS
  'Strong seat-release queue emitted only by an occupied-to-released registration transition.';
COMMENT ON TABLE mbox.activity_waitlist_promotions IS
  'Append-only evidence linking one registration cycle to its release event, payment when required and customer notification.';

UPDATE mbox.normalized_schema_metadata
SET schema_version='088',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
