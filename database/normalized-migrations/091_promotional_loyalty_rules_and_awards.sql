BEGIN;

-- Historical community_activities.points_reward stays disabled. Promotion
-- points start only from future, independently approved typed policy versions.
CREATE TABLE mbox.loyalty_promotion_policy_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  campaign_code text NOT NULL CHECK (campaign_code ~ '^[A-Z0-9][A-Z0-9_.-]{2,63}$'),
  version integer NOT NULL CHECK (version>0),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 80),
  activity_id uuid NOT NULL,
  stacking_group text NOT NULL CHECK (stacking_group ~ '^[A-Z0-9][A-Z0-9_.-]{2,63}$'),
  stacking_mode text NOT NULL CHECK (stacking_mode IN (
    'stackable','exclusive_highest','exclusive_first'
  )),
  priority integer NOT NULL CHECK (priority BETWEEN 0 AND 10000),
  store_budget_points integer NOT NULL CHECK (store_budget_points BETWEEN 1 AND 10000000),
  per_member_points_limit integer NOT NULL CHECK (per_member_points_limit BETWEEN 1 AND 100000),
  point_validity_days integer NOT NULL CHECK (point_validity_days BETWEEN 1 AND 730),
  refund_policy text NOT NULL CHECK (refund_policy IN (
    'reverse_on_any_refund','reverse_on_full_refund'
  )),
  budget_reuse_after_refund boolean NOT NULL DEFAULT false,
  member_limit_reuse_after_refund boolean NOT NULL DEFAULT false,
  eligible_member_levels text[] NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft','approved','published','retired'
  )),
  effective_from timestamptz,
  effective_until timestamptz,
  drafted_by_employee_id uuid NOT NULL,
  approved_by_employee_id uuid,
  approved_at timestamptz,
  published_by_employee_id uuid,
  published_at timestamptz,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 2 AND 500),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
  FOREIGN KEY (tenant_id,store_id,activity_id)
    REFERENCES mbox.community_activities(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,drafted_by_employee_id)
    REFERENCES mbox.employees(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,approved_by_employee_id)
    REFERENCES mbox.employees(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,published_by_employee_id)
    REFERENCES mbox.employees(tenant_id,store_id,id),
  UNIQUE (tenant_id,store_id,campaign_code,version),
  UNIQUE (tenant_id,store_id,id),
  CHECK (cardinality(eligible_member_levels) BETWEEN 1 AND 3),
  CHECK (eligible_member_levels <@ ARRAY['member','silver','gold']::text[]),
  CHECK (cardinality(eligible_member_levels)=(
    CASE WHEN 'member'=ANY(eligible_member_levels) THEN 1 ELSE 0 END
    + CASE WHEN 'silver'=ANY(eligible_member_levels) THEN 1 ELSE 0 END
    + CASE WHEN 'gold'=ANY(eligible_member_levels) THEN 1 ELSE 0 END
  )),
  CHECK (effective_until IS NULL OR (
    effective_from IS NOT NULL AND effective_until>effective_from
  )),
  CHECK (
    (status='draft' AND approved_by_employee_id IS NULL AND approved_at IS NULL
      AND published_by_employee_id IS NULL AND published_at IS NULL
      AND effective_from IS NULL AND effective_until IS NULL)
    OR
    (status='approved' AND approved_by_employee_id IS NOT NULL AND approved_at IS NOT NULL
      AND approved_by_employee_id<>drafted_by_employee_id
      AND published_by_employee_id IS NULL AND published_at IS NULL
      AND effective_from IS NULL AND effective_until IS NULL)
    OR
    (status='published' AND approved_by_employee_id IS NOT NULL AND approved_at IS NOT NULL
      AND published_by_employee_id IS NOT NULL AND published_at IS NOT NULL
      AND effective_from IS NOT NULL AND effective_from>=published_at
      AND approved_by_employee_id<>drafted_by_employee_id
      AND published_by_employee_id<>drafted_by_employee_id
      AND published_by_employee_id<>approved_by_employee_id)
    OR
    (status='retired' AND approved_by_employee_id IS NOT NULL AND approved_at IS NOT NULL
      AND published_by_employee_id IS NOT NULL AND published_at IS NOT NULL
      AND effective_from IS NOT NULL AND effective_until IS NOT NULL)
  )
);

ALTER TABLE mbox.loyalty_promotion_policy_versions
  ADD CONSTRAINT loyalty_promotion_policy_versions_no_overlap_excl
  EXCLUDE USING gist (
    tenant_id WITH =,store_id WITH =,campaign_code WITH =,
    tstzrange(effective_from,effective_until,'[)') WITH &&
  ) WHERE (status IN ('published','retired')) DEFERRABLE INITIALLY IMMEDIATE;

CREATE INDEX loyalty_promotion_policy_versions_current_idx
  ON mbox.loyalty_promotion_policy_versions(
    tenant_id,store_id,activity_id,status,effective_from DESC,priority DESC,id
  ) WHERE status='published';

CREATE TABLE mbox.loyalty_promotion_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  policy_version_id uuid NOT NULL,
  rule_code text NOT NULL CHECK (rule_code ~ '^[A-Z0-9][A-Z0-9_.-]{2,63}$'),
  trigger_kind text NOT NULL CHECK (trigger_kind IN (
    'activity_payment','activity_check_in','activity_completion'
  )),
  points integer NOT NULL CHECK (points BETWEEN 1 AND 100000),
  per_member_award_limit integer NOT NULL CHECK (per_member_award_limit BETWEEN 1 AND 100),
  minimum_paid_amount_minor bigint NOT NULL DEFAULT 0 CHECK (minimum_paid_amount_minor>=0),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
  FOREIGN KEY (tenant_id,store_id,policy_version_id)
    REFERENCES mbox.loyalty_promotion_policy_versions(tenant_id,store_id,id),
  UNIQUE (tenant_id,store_id,policy_version_id,rule_code),
  UNIQUE (tenant_id,store_id,id),
  CHECK (trigger_kind='activity_payment' OR minimum_paid_amount_minor=0)
);

ALTER TABLE mbox.community_activity_registrations
  ADD CONSTRAINT community_activity_registrations_cycle_identity_uq
    UNIQUE (tenant_id,store_id,id,registration_cycle);

CREATE TABLE mbox.loyalty_promotion_trigger_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  trigger_kind text NOT NULL CHECK (trigger_kind IN (
    'activity_payment','activity_check_in','activity_completion'
  )),
  registration_id uuid NOT NULL,
  registration_cycle integer NOT NULL CHECK (registration_cycle>=1),
  activity_id uuid NOT NULL,
  payment_id uuid,
  occurred_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending','processing','deferred','applied','not_applicable','review_required'
  )),
  worker_id text CHECK (
    worker_id IS NULL OR length(btrim(worker_id)) BETWEEN 3 AND 96
  ),
  claimed_at timestamptz,
  pause_control_version integer CHECK (pause_control_version>0),
  resolution_code text CHECK (resolution_code IS NULL OR resolution_code IN (
    'points_accrual_paused','non_member','refunded','no_matching_policy',
    'awarded','partially_awarded','stacking_excluded','limit_reached','processing_failed'
  )),
  award_count integer CHECK (award_count>=0),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
  FOREIGN KEY (tenant_id,store_id,registration_id,registration_cycle)
    REFERENCES mbox.community_activity_registrations(
      tenant_id,store_id,id,registration_cycle
    ),
  FOREIGN KEY (tenant_id,store_id,activity_id)
    REFERENCES mbox.community_activities(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,payment_id)
    REFERENCES mbox.payments(tenant_id,store_id,id),
  UNIQUE (tenant_id,store_id,trigger_kind,registration_id,registration_cycle),
  UNIQUE (tenant_id,store_id,id),
  CHECK ((trigger_kind='activity_payment' AND payment_id IS NOT NULL)
    OR trigger_kind<>'activity_payment'),
  CHECK (
    (status='pending' AND worker_id IS NULL AND claimed_at IS NULL
      AND pause_control_version IS NULL AND resolution_code IS NULL
      AND award_count IS NULL AND resolved_at IS NULL)
    OR
    (status='processing' AND worker_id IS NOT NULL AND claimed_at IS NOT NULL
      AND pause_control_version IS NULL AND resolution_code IS NULL
      AND award_count IS NULL AND resolved_at IS NULL)
    OR
    (status='deferred' AND worker_id IS NULL AND claimed_at IS NULL
      AND pause_control_version IS NOT NULL
      AND resolution_code='points_accrual_paused'
      AND award_count IS NULL AND resolved_at IS NULL)
    OR
    (status='applied' AND worker_id IS NULL AND claimed_at IS NULL
      AND pause_control_version IS NULL
      AND resolution_code IN ('awarded','partially_awarded')
      AND award_count>0 AND resolved_at IS NOT NULL)
    OR
    (status='not_applicable' AND worker_id IS NULL AND claimed_at IS NULL
      AND pause_control_version IS NULL
      AND resolution_code IN (
        'non_member','refunded','no_matching_policy','stacking_excluded','limit_reached'
      ) AND award_count=0 AND resolved_at IS NOT NULL)
    OR
    (status='review_required' AND worker_id IS NULL AND claimed_at IS NULL
      AND pause_control_version IS NULL AND resolution_code='processing_failed'
      AND award_count IS NULL AND resolved_at IS NOT NULL)
  )
);

CREATE INDEX loyalty_promotion_trigger_facts_pending_idx
  ON mbox.loyalty_promotion_trigger_facts(tenant_id,store_id,occurred_at,id)
  WHERE status IN ('pending','deferred','processing','review_required');

CREATE TABLE mbox.loyalty_promotion_refund_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  refund_id uuid NOT NULL,
  payment_id uuid NOT NULL,
  registration_id uuid NOT NULL,
  activity_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending','processing','deferred','processed','review_required'
  )),
  worker_id text CHECK (
    worker_id IS NULL OR length(btrim(worker_id)) BETWEEN 3 AND 96
  ),
  claimed_at timestamptz,
  resolution_code text CHECK (resolution_code IS NULL OR resolution_code IN (
    'promotion_trigger_pending','reversed','no_promotion_award','processing_failed'
  )),
  application_count integer CHECK (application_count>=0),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
  FOREIGN KEY (tenant_id,store_id,refund_id)
    REFERENCES mbox.refunds(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,payment_id)
    REFERENCES mbox.payments(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,registration_id)
    REFERENCES mbox.community_activity_registrations(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,activity_id)
    REFERENCES mbox.community_activities(tenant_id,store_id,id),
  UNIQUE (tenant_id,store_id,refund_id),
  UNIQUE (tenant_id,store_id,id),
  CHECK (
    (status='pending' AND worker_id IS NULL AND claimed_at IS NULL
      AND resolution_code IS NULL AND application_count IS NULL AND resolved_at IS NULL)
    OR
    (status='processing' AND worker_id IS NOT NULL AND claimed_at IS NOT NULL
      AND resolution_code IS NULL AND application_count IS NULL AND resolved_at IS NULL)
    OR
    (status='deferred' AND worker_id IS NULL AND claimed_at IS NULL
      AND resolution_code='promotion_trigger_pending'
      AND application_count IS NULL AND resolved_at IS NULL)
    OR
    (status='processed' AND worker_id IS NULL AND claimed_at IS NULL
      AND resolution_code IN ('reversed','no_promotion_award')
      AND application_count IS NOT NULL AND resolved_at IS NOT NULL)
    OR
    (status='review_required' AND worker_id IS NULL AND claimed_at IS NULL
      AND resolution_code='processing_failed' AND application_count IS NULL
      AND resolved_at IS NOT NULL)
  )
);

CREATE INDEX loyalty_promotion_refund_facts_pending_idx
  ON mbox.loyalty_promotion_refund_facts(tenant_id,store_id,occurred_at,id)
  WHERE status IN ('pending','processing','deferred','review_required');

CREATE TABLE mbox.loyalty_promotion_awards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  trigger_fact_id uuid NOT NULL,
  policy_version_id uuid NOT NULL,
  rule_id uuid NOT NULL,
  registration_id uuid NOT NULL,
  registration_cycle integer NOT NULL CHECK (registration_cycle>=1),
  activity_id uuid NOT NULL,
  payment_id uuid,
  membership_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  awarded_points integer NOT NULL CHECK (awarded_points>0),
  credited_points integer NOT NULL CHECK (credited_points>=0),
  recovered_debt_points integer NOT NULL CHECK (recovered_debt_points>=0),
  source_ledger_entry_id uuid,
  awarded_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
  FOREIGN KEY (tenant_id,store_id,trigger_fact_id)
    REFERENCES mbox.loyalty_promotion_trigger_facts(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,policy_version_id)
    REFERENCES mbox.loyalty_promotion_policy_versions(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,rule_id)
    REFERENCES mbox.loyalty_promotion_rules(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,registration_id,registration_cycle)
    REFERENCES mbox.community_activity_registrations(
      tenant_id,store_id,id,registration_cycle
    ),
  FOREIGN KEY (tenant_id,store_id,activity_id)
    REFERENCES mbox.community_activities(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,payment_id)
    REFERENCES mbox.payments(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,membership_id)
    REFERENCES mbox.customer_memberships(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,customer_id)
    REFERENCES mbox.customers(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,source_ledger_entry_id)
    REFERENCES mbox.loyalty_point_ledger(tenant_id,store_id,id),
  UNIQUE (tenant_id,store_id,trigger_fact_id,rule_id),
  UNIQUE (tenant_id,store_id,source_ledger_entry_id),
  UNIQUE (tenant_id,store_id,id),
  CHECK (awarded_points=credited_points+recovered_debt_points)
);

CREATE TABLE mbox.loyalty_promotion_refund_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  promotion_award_id uuid NOT NULL,
  refund_fact_id uuid NOT NULL,
  refund_id uuid NOT NULL,
  payment_id uuid NOT NULL,
  registration_id uuid NOT NULL,
  reversed_points integer NOT NULL CHECK (reversed_points>=0),
  deducted_points integer NOT NULL CHECK (deducted_points>=0),
  recovery_debt_points integer NOT NULL CHECK (recovery_debt_points>=0),
  applied_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
  FOREIGN KEY (tenant_id,store_id,promotion_award_id)
    REFERENCES mbox.loyalty_promotion_awards(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,refund_fact_id)
    REFERENCES mbox.loyalty_promotion_refund_facts(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,refund_id)
    REFERENCES mbox.refunds(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,payment_id)
    REFERENCES mbox.payments(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,registration_id)
    REFERENCES mbox.community_activity_registrations(tenant_id,store_id,id),
  UNIQUE (tenant_id,store_id,promotion_award_id,refund_id),
  UNIQUE (tenant_id,store_id,id),
  CHECK (reversed_points=deducted_points+recovery_debt_points)
);

ALTER TABLE mbox.loyalty_point_ledger
  ADD COLUMN promotion_award_id uuid,
  ADD COLUMN promotion_refund_application_id uuid,
  ADD CONSTRAINT loyalty_point_ledger_promotion_award_fk
    FOREIGN KEY (tenant_id,store_id,promotion_award_id)
    REFERENCES mbox.loyalty_promotion_awards(tenant_id,store_id,id),
  ADD CONSTRAINT loyalty_point_ledger_promotion_refund_application_fk
    FOREIGN KEY (tenant_id,store_id,promotion_refund_application_id)
    REFERENCES mbox.loyalty_promotion_refund_applications(tenant_id,store_id,id),
  ADD CONSTRAINT loyalty_point_ledger_promotion_shape_ck CHECK (
    (promotion_award_id IS NULL AND promotion_refund_application_id IS NULL)
    OR
    (promotion_award_id IS NOT NULL AND promotion_refund_application_id IS NULL
      AND (
        (entry_type='earn' AND source_type='campaign' AND points_delta>0)
        OR (entry_type='reverse' AND source_type='refund' AND points_delta<0)
      ))
    OR
    (promotion_award_id IS NOT NULL AND promotion_refund_application_id IS NOT NULL
      AND entry_type='reverse' AND source_type='refund' AND points_delta<0)
  );

ALTER TABLE mbox.loyalty_point_lots
  DROP CONSTRAINT loyalty_point_lots_source_type_check,
  ADD CONSTRAINT loyalty_point_lots_source_type_check CHECK (source_type IN (
    'order','supplement','adjust','restore','legacy_balance','promotion'
  ));

ALTER TABLE mbox.loyalty_point_lot_movements
  DROP CONSTRAINT loyalty_point_lot_movements_source_type_check,
  ADD CONSTRAINT loyalty_point_lot_movements_source_type_check CHECK (source_type IN (
    'order','refund','redemption','supplement','manual','system','legacy_balance','promotion'
  ));

CREATE FUNCTION mbox.protect_loyalty_promotion_policy_version()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF EXISTS (
      SELECT 1 FROM mbox.loyalty_promotion_policy_versions existing
      WHERE existing.tenant_id=NEW.tenant_id AND existing.store_id=NEW.store_id
        AND existing.campaign_code=NEW.campaign_code
        AND existing.activity_id<>NEW.activity_id
    ) THEN RAISE EXCEPTION 'promotion campaign versions must keep one activity scope'; END IF;
    IF NEW.status<>'draft' THEN RAISE EXCEPTION 'promotion policy must start as draft'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'promotion policy versions cannot be deleted'; END IF;
  IF OLD.status='draft' AND NEW.status='approved' THEN
    IF ROW(NEW.tenant_id,NEW.store_id,NEW.campaign_code,NEW.version,NEW.name,
      NEW.activity_id,NEW.stacking_group,NEW.stacking_mode,NEW.priority,
      NEW.store_budget_points,NEW.per_member_points_limit,NEW.point_validity_days,
      NEW.refund_policy,NEW.budget_reuse_after_refund,
      NEW.member_limit_reuse_after_refund,NEW.eligible_member_levels,
      NEW.drafted_by_employee_id,NEW.created_at) IS DISTINCT FROM
      ROW(OLD.tenant_id,OLD.store_id,OLD.campaign_code,OLD.version,OLD.name,
      OLD.activity_id,OLD.stacking_group,OLD.stacking_mode,OLD.priority,
      OLD.store_budget_points,OLD.per_member_points_limit,OLD.point_validity_days,
      OLD.refund_policy,OLD.budget_reuse_after_refund,
      OLD.member_limit_reuse_after_refund,OLD.eligible_member_levels,
      OLD.drafted_by_employee_id,OLD.created_at) THEN
      RAISE EXCEPTION 'approval cannot alter promotion policy facts';
    END IF;
  ELSIF OLD.status='approved' AND NEW.status='published' THEN
    IF ROW(NEW.tenant_id,NEW.store_id,NEW.campaign_code,NEW.version,NEW.name,
      NEW.activity_id,NEW.stacking_group,NEW.stacking_mode,NEW.priority,
      NEW.store_budget_points,NEW.per_member_points_limit,NEW.point_validity_days,
      NEW.refund_policy,NEW.budget_reuse_after_refund,
      NEW.member_limit_reuse_after_refund,NEW.eligible_member_levels,
      NEW.drafted_by_employee_id,NEW.approved_by_employee_id,NEW.approved_at,
      NEW.created_at) IS DISTINCT FROM
      ROW(OLD.tenant_id,OLD.store_id,OLD.campaign_code,OLD.version,OLD.name,
      OLD.activity_id,OLD.stacking_group,OLD.stacking_mode,OLD.priority,
      OLD.store_budget_points,OLD.per_member_points_limit,OLD.point_validity_days,
      OLD.refund_policy,OLD.budget_reuse_after_refund,
      OLD.member_limit_reuse_after_refund,OLD.eligible_member_levels,
      OLD.drafted_by_employee_id,OLD.approved_by_employee_id,OLD.approved_at,
      OLD.created_at) THEN
      RAISE EXCEPTION 'publication cannot alter approved promotion policy facts';
    END IF;
  ELSIF OLD.status='published' AND NEW.status='published' THEN
    IF NEW.effective_until IS NULL OR NEW.effective_until<=NEW.effective_from
      OR (OLD.effective_until IS NOT NULL AND NEW.effective_until>=OLD.effective_until)
      OR ROW(NEW.tenant_id,NEW.store_id,NEW.campaign_code,NEW.version,NEW.name,
        NEW.activity_id,NEW.stacking_group,NEW.stacking_mode,NEW.priority,
        NEW.store_budget_points,NEW.per_member_points_limit,NEW.point_validity_days,
        NEW.refund_policy,NEW.budget_reuse_after_refund,
        NEW.member_limit_reuse_after_refund,NEW.eligible_member_levels,
        NEW.drafted_by_employee_id,NEW.approved_by_employee_id,NEW.approved_at,
        NEW.published_by_employee_id,NEW.published_at,NEW.effective_from,
        NEW.reason,NEW.created_at) IS DISTINCT FROM
        ROW(OLD.tenant_id,OLD.store_id,OLD.campaign_code,OLD.version,OLD.name,
        OLD.activity_id,OLD.stacking_group,OLD.stacking_mode,OLD.priority,
        OLD.store_budget_points,OLD.per_member_points_limit,OLD.point_validity_days,
        OLD.refund_policy,OLD.budget_reuse_after_refund,
        OLD.member_limit_reuse_after_refund,OLD.eligible_member_levels,
        OLD.drafted_by_employee_id,OLD.approved_by_employee_id,OLD.approved_at,
        OLD.published_by_employee_id,OLD.published_at,OLD.effective_from,
        OLD.reason,OLD.created_at)
      OR NOT EXISTS (
        SELECT 1 FROM mbox.loyalty_promotion_policy_versions replacement
        WHERE replacement.tenant_id=NEW.tenant_id AND replacement.store_id=NEW.store_id
          AND replacement.campaign_code=NEW.campaign_code AND replacement.id<>NEW.id
          AND replacement.status='approved'
      ) THEN
      RAISE EXCEPTION 'published promotion policy can only close for an approved replacement';
    END IF;
  ELSIF OLD.status='published' AND NEW.status='retired' THEN
    IF OLD.effective_until IS NULL OR OLD.effective_until>clock_timestamp()
      OR ROW(NEW.tenant_id,NEW.store_id,NEW.campaign_code,NEW.version,NEW.name,
        NEW.activity_id,NEW.stacking_group,NEW.stacking_mode,NEW.priority,
        NEW.store_budget_points,NEW.per_member_points_limit,NEW.point_validity_days,
        NEW.refund_policy,NEW.budget_reuse_after_refund,
        NEW.member_limit_reuse_after_refund,NEW.eligible_member_levels,
        NEW.drafted_by_employee_id,NEW.approved_by_employee_id,NEW.approved_at,
        NEW.published_by_employee_id,NEW.published_at,NEW.effective_from,
        NEW.effective_until,NEW.reason,NEW.created_at) IS DISTINCT FROM
        ROW(OLD.tenant_id,OLD.store_id,OLD.campaign_code,OLD.version,OLD.name,
        OLD.activity_id,OLD.stacking_group,OLD.stacking_mode,OLD.priority,
        OLD.store_budget_points,OLD.per_member_points_limit,OLD.point_validity_days,
        OLD.refund_policy,OLD.budget_reuse_after_refund,
        OLD.member_limit_reuse_after_refund,OLD.eligible_member_levels,
        OLD.drafted_by_employee_id,OLD.approved_by_employee_id,OLD.approved_at,
        OLD.published_by_employee_id,OLD.published_at,OLD.effective_from,
        OLD.effective_until,OLD.reason,OLD.created_at) THEN
      RAISE EXCEPTION 'promotion policy can retire only after its published window ends';
    END IF;
  ELSE
    RAISE EXCEPTION 'invalid promotion policy transition % -> %',OLD.status,NEW.status;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER loyalty_promotion_policy_versions_guard
  BEFORE INSERT OR UPDATE OR DELETE ON mbox.loyalty_promotion_policy_versions
  FOR EACH ROW EXECUTE FUNCTION mbox.protect_loyalty_promotion_policy_version();

CREATE FUNCTION mbox.assert_loyalty_promotion_policy_cutover()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status='published' AND NEW.status='published'
    AND NEW.effective_until IS DISTINCT FROM OLD.effective_until
    AND NOT EXISTS (
      SELECT 1 FROM mbox.loyalty_promotion_policy_versions replacement
      WHERE replacement.tenant_id=NEW.tenant_id AND replacement.store_id=NEW.store_id
        AND replacement.campaign_code=NEW.campaign_code AND replacement.id<>NEW.id
        AND replacement.status='published' AND replacement.effective_from=NEW.effective_until
    ) THEN
    RAISE EXCEPTION 'published promotion cut-over requires its exact replacement';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER loyalty_promotion_policy_versions_exact_cutover
  AFTER UPDATE ON mbox.loyalty_promotion_policy_versions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION mbox.assert_loyalty_promotion_policy_cutover();

CREATE FUNCTION mbox.protect_loyalty_promotion_rule()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE policy_status text;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'promotion rules cannot be deleted'; END IF;
  SELECT status INTO policy_status FROM mbox.loyalty_promotion_policy_versions
  WHERE tenant_id=COALESCE(NEW.tenant_id,OLD.tenant_id)
    AND store_id=COALESCE(NEW.store_id,OLD.store_id)
    AND id=COALESCE(NEW.policy_version_id,OLD.policy_version_id);
  IF TG_OP='INSERT' AND policy_status<>'draft' THEN
    RAISE EXCEPTION 'promotion rules can only be added to drafts';
  ELSIF TG_OP='UPDATE' AND policy_status<>'draft' THEN
    RAISE EXCEPTION 'approved promotion rules are immutable';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER loyalty_promotion_rules_guard
  BEFORE INSERT OR UPDATE OR DELETE ON mbox.loyalty_promotion_rules
  FOR EACH ROW EXECUTE FUNCTION mbox.protect_loyalty_promotion_rule();

CREATE FUNCTION mbox.protect_loyalty_promotion_trigger_fact()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'promotion trigger facts cannot be deleted'; END IF;
  IF ROW(NEW.tenant_id,NEW.store_id,NEW.trigger_kind,NEW.registration_id,
    NEW.registration_cycle,NEW.activity_id,NEW.payment_id,NEW.occurred_at,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.tenant_id,OLD.store_id,OLD.trigger_kind,OLD.registration_id,
    OLD.registration_cycle,OLD.activity_id,OLD.payment_id,OLD.occurred_at,OLD.created_at) THEN
    RAISE EXCEPTION 'promotion trigger source facts are immutable';
  END IF;
  IF NOT (
    (OLD.status IN ('pending','deferred','review_required') AND NEW.status='processing')
    OR (OLD.status='processing' AND NEW.status IN (
      'processing','deferred','applied','not_applicable','review_required'
    ))
    OR (OLD.status=NEW.status AND OLD.status IN ('applied','not_applicable'))
  ) THEN RAISE EXCEPTION 'invalid promotion trigger transition % -> %',OLD.status,NEW.status; END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER loyalty_promotion_trigger_facts_guard
  BEFORE UPDATE OR DELETE ON mbox.loyalty_promotion_trigger_facts
  FOR EACH ROW EXECUTE FUNCTION mbox.protect_loyalty_promotion_trigger_fact();

CREATE FUNCTION mbox.protect_loyalty_promotion_refund_fact()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'promotion refund facts cannot be deleted'; END IF;
  IF ROW(NEW.tenant_id,NEW.store_id,NEW.refund_id,NEW.payment_id,
    NEW.registration_id,NEW.activity_id,NEW.occurred_at,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.tenant_id,OLD.store_id,OLD.refund_id,OLD.payment_id,
    OLD.registration_id,OLD.activity_id,OLD.occurred_at,OLD.created_at) THEN
    RAISE EXCEPTION 'promotion refund source facts are immutable';
  END IF;
  IF NOT (
    (OLD.status IN ('pending','deferred','review_required') AND NEW.status='processing')
    OR (OLD.status='processing' AND NEW.status IN (
      'processing','deferred','processed','review_required'
    ))
    OR (OLD.status=NEW.status AND OLD.status='processed')
  ) THEN RAISE EXCEPTION 'invalid promotion refund transition % -> %',OLD.status,NEW.status; END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER loyalty_promotion_refund_facts_guard
  BEFORE UPDATE OR DELETE ON mbox.loyalty_promotion_refund_facts
  FOR EACH ROW EXECUTE FUNCTION mbox.protect_loyalty_promotion_refund_fact();

CREATE FUNCTION mbox.protect_loyalty_promotion_award()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'promotion awards cannot be deleted'; END IF;
  IF ROW(NEW.tenant_id,NEW.store_id,NEW.trigger_fact_id,NEW.policy_version_id,
    NEW.rule_id,NEW.registration_id,NEW.registration_cycle,NEW.activity_id,
    NEW.payment_id,NEW.membership_id,NEW.customer_id,NEW.awarded_points,
    NEW.credited_points,NEW.recovered_debt_points,NEW.awarded_at,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.tenant_id,OLD.store_id,OLD.trigger_fact_id,
    OLD.policy_version_id,OLD.rule_id,OLD.registration_id,OLD.registration_cycle,
    OLD.activity_id,OLD.payment_id,OLD.membership_id,OLD.customer_id,
    OLD.awarded_points,OLD.credited_points,OLD.recovered_debt_points,
    OLD.awarded_at,OLD.created_at)
    OR OLD.source_ledger_entry_id IS NOT NULL
    OR NEW.source_ledger_entry_id IS NULL THEN
    RAISE EXCEPTION 'promotion award facts are immutable';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER loyalty_promotion_awards_guard
  BEFORE UPDATE OR DELETE ON mbox.loyalty_promotion_awards
  FOR EACH ROW EXECUTE FUNCTION mbox.protect_loyalty_promotion_award();

CREATE FUNCTION mbox.assert_loyalty_promotion_award_ledger()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM mbox.loyalty_promotion_awards award
    JOIN mbox.loyalty_point_ledger ledger
      ON ledger.tenant_id=award.tenant_id AND ledger.store_id=award.store_id
     AND ledger.id=award.source_ledger_entry_id
     AND ledger.promotion_award_id=award.id
     AND ledger.entry_type='earn' AND ledger.source_type='campaign'
     AND ledger.points_delta=award.awarded_points
    WHERE award.tenant_id=NEW.tenant_id AND award.store_id=NEW.store_id
      AND award.id=NEW.id AND award.source_ledger_entry_id IS NOT NULL
  ) THEN RAISE EXCEPTION 'promotion award requires its exact earning ledger'; END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER loyalty_promotion_awards_require_ledger
  AFTER INSERT OR UPDATE ON mbox.loyalty_promotion_awards
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION mbox.assert_loyalty_promotion_award_ledger();

CREATE TRIGGER loyalty_promotion_refund_applications_append_only
  BEFORE UPDATE OR DELETE ON mbox.loyalty_promotion_refund_applications
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();

CREATE FUNCTION mbox.capture_loyalty_promotion_payment_trigger()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.payable_kind='activity_registration' AND NEW.status='succeeded'
    AND (TG_OP='INSERT' OR OLD.status IS DISTINCT FROM 'succeeded') THEN
    INSERT INTO mbox.loyalty_promotion_trigger_facts(
      tenant_id,store_id,trigger_kind,registration_id,registration_cycle,
      activity_id,payment_id,occurred_at
    ) SELECT registration.tenant_id,registration.store_id,'activity_payment',
      registration.id,registration.registration_cycle,registration.activity_id,
      NEW.id,COALESCE(NEW.succeeded_at,NEW.updated_at,clock_timestamp())
    FROM mbox.community_activity_registrations registration
    WHERE registration.tenant_id=NEW.tenant_id AND registration.store_id=NEW.store_id
      AND registration.id=NEW.activity_registration_id
    ON CONFLICT (tenant_id,store_id,trigger_kind,registration_id,registration_cycle)
      DO NOTHING;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER payments_capture_loyalty_promotion_trigger
  AFTER INSERT OR UPDATE OF status ON mbox.payments
  FOR EACH ROW EXECUTE FUNCTION mbox.capture_loyalty_promotion_payment_trigger();

CREATE FUNCTION mbox.capture_loyalty_promotion_check_in_trigger()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status='checked_in' AND OLD.status IS DISTINCT FROM 'checked_in' THEN
    INSERT INTO mbox.loyalty_promotion_trigger_facts(
      tenant_id,store_id,trigger_kind,registration_id,registration_cycle,
      activity_id,payment_id,occurred_at
    ) VALUES(
      NEW.tenant_id,NEW.store_id,'activity_check_in',NEW.id,NEW.registration_cycle,
      NEW.activity_id,NEW.payment_id,COALESCE(NEW.checked_in_at,NEW.updated_at,clock_timestamp())
    ) ON CONFLICT (tenant_id,store_id,trigger_kind,registration_id,registration_cycle)
      DO NOTHING;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER community_activity_registrations_capture_promotion_check_in
  AFTER UPDATE OF status ON mbox.community_activity_registrations
  FOR EACH ROW EXECUTE FUNCTION mbox.capture_loyalty_promotion_check_in_trigger();

CREATE FUNCTION mbox.capture_loyalty_promotion_completion_triggers()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status='completed' AND OLD.status IS DISTINCT FROM 'completed' THEN
    INSERT INTO mbox.loyalty_promotion_trigger_facts(
      tenant_id,store_id,trigger_kind,registration_id,registration_cycle,
      activity_id,payment_id,occurred_at
    ) SELECT registration.tenant_id,registration.store_id,'activity_completion',
      registration.id,registration.registration_cycle,registration.activity_id,
      registration.payment_id,NEW.updated_at
    FROM mbox.community_activity_registrations registration
    WHERE registration.tenant_id=NEW.tenant_id AND registration.store_id=NEW.store_id
      AND registration.activity_id=NEW.id AND registration.status='checked_in'
    ON CONFLICT (tenant_id,store_id,trigger_kind,registration_id,registration_cycle)
      DO NOTHING;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER community_activities_capture_promotion_completion
  AFTER UPDATE OF status ON mbox.community_activities
  FOR EACH ROW EXECUTE FUNCTION mbox.capture_loyalty_promotion_completion_triggers();

CREATE FUNCTION mbox.capture_loyalty_promotion_refund_fact()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status='succeeded'
    AND (TG_OP='INSERT' OR OLD.status IS DISTINCT FROM 'succeeded') THEN
    INSERT INTO mbox.loyalty_promotion_refund_facts(
      tenant_id,store_id,refund_id,payment_id,registration_id,activity_id,occurred_at
    ) SELECT NEW.tenant_id,NEW.store_id,NEW.id,NEW.payment_id,
      registration.id,registration.activity_id,
      COALESCE(NEW.completed_at,NEW.updated_at,clock_timestamp())
    FROM mbox.payments payment
    JOIN mbox.community_activity_registrations registration
      ON registration.tenant_id=payment.tenant_id AND registration.store_id=payment.store_id
     AND registration.id=payment.activity_registration_id
    WHERE payment.tenant_id=NEW.tenant_id AND payment.store_id=NEW.store_id
      AND payment.id=NEW.payment_id AND payment.payable_kind='activity_registration'
    ON CONFLICT (tenant_id,store_id,refund_id) DO NOTHING;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER refunds_capture_loyalty_promotion_fact
  AFTER INSERT OR UPDATE OF status ON mbox.refunds
  FOR EACH ROW EXECUTE FUNCTION mbox.capture_loyalty_promotion_refund_fact();

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'loyalty_promotion_policy_versions','loyalty_promotion_rules',
    'loyalty_promotion_trigger_facts','loyalty_promotion_refund_facts',
    'loyalty_promotion_awards','loyalty_promotion_refund_applications'
  ] LOOP
    EXECUTE format('ALTER TABLE mbox.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE mbox.%I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format(
      'CREATE POLICY tenant_store_isolation ON mbox.%I USING (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())',
      table_name
    );
  END LOOP;
END $$;

GRANT SELECT,INSERT,UPDATE ON TABLE
  mbox.loyalty_promotion_policy_versions,
  mbox.loyalty_promotion_rules,
  mbox.loyalty_promotion_trigger_facts,
  mbox.loyalty_promotion_refund_facts,
  mbox.loyalty_promotion_awards TO mbox_runtime;
GRANT SELECT,INSERT ON TABLE
  mbox.loyalty_promotion_refund_applications TO mbox_runtime;
REVOKE DELETE ON TABLE
  mbox.loyalty_promotion_policy_versions,
  mbox.loyalty_promotion_rules,
  mbox.loyalty_promotion_trigger_facts,
  mbox.loyalty_promotion_refund_facts,
  mbox.loyalty_promotion_awards,
  mbox.loyalty_promotion_refund_applications FROM mbox_runtime;
REVOKE UPDATE ON TABLE mbox.loyalty_promotion_refund_applications FROM mbox_runtime;

CREATE FUNCTION mbox.seed_store_loyalty_promotion_permissions()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO mbox.staff_permission_definitions(
    tenant_id,store_id,code,name,category,description,status
  ) VALUES
    (NEW.tenant_id,NEW.id,'loyalty.promotion.view','查看促销积分','loyalty',
      '查看促销积分规则、预算使用与暂停待处理事实','active'),
    (NEW.tenant_id,NEW.id,'loyalty.promotion.manage','起草促销积分','loyalty',
      '起草活动促销积分、预算、个人上限、叠加及退款规则','active'),
    (NEW.tenant_id,NEW.id,'loyalty.promotion.approve','审批促销积分','loyalty',
      '由非起草人审批促销积分规则','active'),
    (NEW.tenant_id,NEW.id,'loyalty.promotion.publish','发布促销积分','loyalty',
      '由第三名授权人员未来排期发布促销积分规则','active')
  ON CONFLICT (tenant_id,store_id,code) DO UPDATE SET
    name=EXCLUDED.name,category=EXCLUDED.category,
    description=EXCLUDED.description,status='active';
  RETURN NEW;
END $$;

CREATE TRIGGER stores_seed_loyalty_promotion_permissions
  AFTER INSERT ON mbox.stores FOR EACH ROW
  EXECUTE FUNCTION mbox.seed_store_loyalty_promotion_permissions();

INSERT INTO mbox.staff_permission_definitions(
  tenant_id,store_id,code,name,category,description,status
)
SELECT store.tenant_id,store.id,permission.code,permission.name,
  'loyalty',permission.description,'active'
FROM mbox.stores store CROSS JOIN (VALUES
  ('loyalty.promotion.view','查看促销积分','查看促销积分规则、预算使用与暂停待处理事实'),
  ('loyalty.promotion.manage','起草促销积分','起草活动促销积分、预算、个人上限、叠加及退款规则'),
  ('loyalty.promotion.approve','审批促销积分','由非起草人审批促销积分规则'),
  ('loyalty.promotion.publish','发布促销积分','由第三名授权人员未来排期发布促销积分规则')
) permission(code,name,description)
ON CONFLICT (tenant_id,store_id,code) DO UPDATE SET
  name=EXCLUDED.name,category=EXCLUDED.category,
  description=EXCLUDED.description,status='active';

INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id)
SELECT role.tenant_id,role.store_id,role.id,permission.id
FROM mbox.roles role
JOIN mbox.staff_permission_definitions permission
  ON permission.tenant_id=role.tenant_id AND permission.store_id=role.store_id
WHERE role.status='active' AND (
  (role.code='MANAGER' AND permission.code IN (
    'loyalty.promotion.view','loyalty.promotion.manage'
  ))
  OR (role.code='OPS_LEAD' AND permission.code IN (
    'loyalty.promotion.view','loyalty.promotion.approve'
  ))
  OR (role.code='OWNER' AND permission.code IN (
    'loyalty.promotion.view','loyalty.promotion.publish'
  ))
)
ON CONFLICT (tenant_id,store_id,role_id,permission_id) DO NOTHING;

CREATE FUNCTION mbox.seed_role_loyalty_promotion_permissions()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id)
  SELECT NEW.tenant_id,NEW.store_id,NEW.id,permission.id
  FROM mbox.staff_permission_definitions permission
  WHERE permission.tenant_id=NEW.tenant_id AND permission.store_id=NEW.store_id
    AND (
      (NEW.code='MANAGER' AND permission.code IN (
        'loyalty.promotion.view','loyalty.promotion.manage'
      ))
      OR (NEW.code='OPS_LEAD' AND permission.code IN (
        'loyalty.promotion.view','loyalty.promotion.approve'
      ))
      OR (NEW.code='OWNER' AND permission.code IN (
        'loyalty.promotion.view','loyalty.promotion.publish'
      ))
    )
  ON CONFLICT (tenant_id,store_id,role_id,permission_id) DO NOTHING;
  RETURN NEW;
END $$;

CREATE TRIGGER roles_seed_loyalty_promotion_permissions
  AFTER INSERT ON mbox.roles FOR EACH ROW
  EXECUTE FUNCTION mbox.seed_role_loyalty_promotion_permissions();

COMMENT ON TABLE mbox.loyalty_promotion_policy_versions IS
  'Future-effective immutable three-person promotion policy; budget, limits, stacking and refund behavior are typed.';
COMMENT ON TABLE mbox.loyalty_promotion_trigger_facts IS
  'Authoritative activity payment, check-in and completion facts. Paused accrual is deferred rather than lost.';
COMMENT ON TABLE mbox.loyalty_promotion_awards IS
  'Idempotent promotion awards for existing active members; no award creates a membership.';
COMMENT ON TABLE mbox.loyalty_promotion_refund_applications IS
  'Append-only per-award refund reversal applications independent of the accrual pause.';

UPDATE mbox.normalized_schema_metadata
SET schema_version='091',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
