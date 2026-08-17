BEGIN;

-- Preference decay is part of the published recommendation policy.  Display
-- configuration remains JSON, but none of these runtime decisions may read it.
ALTER TABLE mbox.recommendation_policy_versions
  ADD COLUMN preference_half_life_days integer NOT NULL DEFAULT 90
    CHECK (preference_half_life_days BETWEEN 7 AND 730),
  ADD COLUMN preference_max_age_days integer NOT NULL DEFAULT 730
    CHECK (preference_max_age_days BETWEEN 30 AND 3650),
  ADD COLUMN preference_min_effective_score integer NOT NULL DEFAULT 1000
    CHECK (preference_min_effective_score BETWEEN 1 AND 10000),
  ADD COLUMN preference_min_confidence_basis_points integer NOT NULL DEFAULT 2500
    CHECK (preference_min_confidence_basis_points BETWEEN 0 AND 10000);

ALTER TABLE mbox.preference_evidence
  ADD COLUMN public_id text;

UPDATE mbox.preference_evidence
SET public_id='preference-evidence-' || replace(id::text, '-', '')
WHERE public_id IS NULL;

ALTER TABLE mbox.preference_evidence
  ALTER COLUMN public_id SET NOT NULL,
  ALTER COLUMN public_id SET DEFAULT
    ('preference-evidence-' || replace(gen_random_uuid()::text, '-', '')),
  ADD CONSTRAINT preference_evidence_public_id_ck
    CHECK (length(public_id) BETWEEN 8 AND 128),
  ADD CONSTRAINT preference_evidence_public_id_uq
    UNIQUE (tenant_id, store_id, public_id);

CREATE OR REPLACE FUNCTION mbox.canonical_customer_id(
  requested_tenant_id uuid,
  requested_store_id uuid,
  requested_customer_id uuid
) RETURNS uuid
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=mbox,pg_temp AS $$
  WITH RECURSIVE ancestry AS (
    SELECT customer.id, customer.merged_into_customer_id, 0 AS depth
    FROM mbox.customers customer
    WHERE customer.tenant_id=requested_tenant_id
      AND customer.store_id=requested_store_id
      AND customer.id=requested_customer_id
    UNION ALL
    SELECT parent.id, parent.merged_into_customer_id, child.depth+1
    FROM mbox.customers parent
    JOIN ancestry child ON child.merged_into_customer_id=parent.id
    WHERE parent.tenant_id=requested_tenant_id
      AND parent.store_id=requested_store_id
      AND child.depth<32
  )
  SELECT id FROM ancestry
  WHERE merged_into_customer_id IS NULL
  ORDER BY depth DESC LIMIT 1
$$;

CREATE TABLE mbox.customer_preference_declarations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  public_id text NOT NULL CHECK (length(public_id) BETWEEN 8 AND 128),
  canonical_customer_id uuid NOT NULL,
  declared_by_customer_id uuid NOT NULL,
  preference_key text NOT NULL
    CHECK (preference_key ~ '^[a-z][a-z0-9_.-]{1,63}$'),
  preference_value text NOT NULL
    CHECK (length(btrim(preference_value)) BETWEEN 1 AND 200),
  polarity text NOT NULL CHECK (polarity IN ('supports','contradicts')),
  evidence_weight integer NOT NULL DEFAULT 100
    CHECK (evidence_weight BETWEEN 1 AND 100),
  confidence_basis_points integer NOT NULL DEFAULT 10000
    CHECK (confidence_basis_points BETWEEN 1 AND 10000),
  valid_until timestamptz,
  allowed_for_recommendation boolean NOT NULL DEFAULT true
    CHECK (allowed_for_recommendation),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, canonical_customer_id)
    REFERENCES mbox.customers(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, declared_by_customer_id)
    REFERENCES mbox.customers(tenant_id, store_id, id),
  CHECK (valid_until IS NULL OR valid_until>created_at),
  UNIQUE (tenant_id, store_id, public_id),
  UNIQUE (tenant_id, store_id, idempotency_key),
  UNIQUE (tenant_id, store_id, id)
);

CREATE TABLE mbox.customer_preference_withdrawals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  public_id text NOT NULL CHECK (length(public_id) BETWEEN 8 AND 128),
  canonical_customer_id uuid NOT NULL,
  withdrawn_by_customer_id uuid NOT NULL,
  target_kind text NOT NULL
    CHECK (target_kind IN ('observation_evidence','customer_declaration')),
  preference_evidence_id uuid,
  customer_declaration_id uuid,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 2 AND 240),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, canonical_customer_id)
    REFERENCES mbox.customers(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, withdrawn_by_customer_id)
    REFERENCES mbox.customers(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, preference_evidence_id)
    REFERENCES mbox.preference_evidence(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, customer_declaration_id)
    REFERENCES mbox.customer_preference_declarations(tenant_id, store_id, id),
  CHECK (
    (target_kind='observation_evidence' AND preference_evidence_id IS NOT NULL
      AND customer_declaration_id IS NULL)
    OR
    (target_kind='customer_declaration' AND customer_declaration_id IS NOT NULL
      AND preference_evidence_id IS NULL)
  ),
  UNIQUE (tenant_id, store_id, public_id),
  UNIQUE (tenant_id, store_id, idempotency_key),
  UNIQUE (tenant_id, store_id, preference_evidence_id),
  UNIQUE (tenant_id, store_id, customer_declaration_id),
  UNIQUE (tenant_id, store_id, id)
);

ALTER TABLE mbox.customer_preference_facts
  ADD COLUMN status text NOT NULL DEFAULT 'suppressed'
    CHECK (status IN ('active','suppressed')),
  ADD COLUMN support_score integer NOT NULL DEFAULT 0 CHECK (support_score>=0),
  ADD COLUMN contrary_score integer NOT NULL DEFAULT 0 CHECK (contrary_score>=0),
  ADD COLUMN net_score integer NOT NULL DEFAULT 0,
  ADD COLUMN last_evidence_at timestamptz,
  ADD COLUMN next_recalculation_at timestamptz;

CREATE INDEX customer_preference_facts_active_idx
  ON mbox.customer_preference_facts (
    tenant_id, store_id, customer_id, preference_key, net_score DESC, preference_value
  ) WHERE status='active';

CREATE OR REPLACE FUNCTION mbox.assert_customer_preference_family()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF mbox.canonical_customer_id(NEW.tenant_id,NEW.store_id,NEW.declared_by_customer_id)
      IS DISTINCT FROM NEW.canonical_customer_id THEN
    RAISE EXCEPTION 'preference declaration customer family mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER customer_preference_declarations_assert_family
  BEFORE INSERT ON mbox.customer_preference_declarations
  FOR EACH ROW EXECUTE FUNCTION mbox.assert_customer_preference_family();

CREATE OR REPLACE FUNCTION mbox.assert_customer_preference_withdrawal_family()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_customer_id uuid;
BEGIN
  IF mbox.canonical_customer_id(NEW.tenant_id,NEW.store_id,NEW.withdrawn_by_customer_id)
      IS DISTINCT FROM NEW.canonical_customer_id THEN
    RAISE EXCEPTION 'preference withdrawal customer family mismatch' USING ERRCODE='23514';
  END IF;
  IF NEW.target_kind='observation_evidence' THEN
    SELECT evidence.customer_id INTO target_customer_id
    FROM mbox.preference_evidence evidence
    WHERE evidence.tenant_id=NEW.tenant_id AND evidence.store_id=NEW.store_id
      AND evidence.id=NEW.preference_evidence_id;
  ELSE
    SELECT declaration.canonical_customer_id INTO target_customer_id
    FROM mbox.customer_preference_declarations declaration
    WHERE declaration.tenant_id=NEW.tenant_id AND declaration.store_id=NEW.store_id
      AND declaration.id=NEW.customer_declaration_id;
  END IF;
  IF mbox.canonical_customer_id(NEW.tenant_id,NEW.store_id,target_customer_id)
      IS DISTINCT FROM NEW.canonical_customer_id THEN
    RAISE EXCEPTION 'preference withdrawal target family mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER customer_preference_withdrawals_assert_family
  BEFORE INSERT ON mbox.customer_preference_withdrawals
  FOR EACH ROW EXECUTE FUNCTION mbox.assert_customer_preference_withdrawal_family();

CREATE TRIGGER customer_preference_declarations_append_only
  BEFORE UPDATE OR DELETE ON mbox.customer_preference_declarations
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();
CREATE TRIGGER customer_preference_withdrawals_append_only
  BEFORE UPDATE OR DELETE ON mbox.customer_preference_withdrawals
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();

-- An experience plan is an order outcome, never a recommendation click.
ALTER TABLE mbox.recommendation_sessions
  ADD COLUMN experience_intent_summary text
    CHECK (experience_intent_summary IS NULL OR length(btrim(experience_intent_summary)) BETWEEN 2 AND 280),
  ADD COLUMN selected_at timestamptz,
  ADD COLUMN selection_idempotency_key text
    CHECK (selection_idempotency_key IS NULL OR length(selection_idempotency_key) BETWEEN 8 AND 128),
  ADD CONSTRAINT recommendation_sessions_selection_shape_ck CHECK (
    (selected_at IS NULL AND selection_idempotency_key IS NULL)
    OR
    (selected_at IS NOT NULL AND selected_product_id IS NOT NULL
      AND experience_intent_summary IS NOT NULL AND selection_idempotency_key IS NOT NULL)
  ) NOT VALID;

CREATE UNIQUE INDEX recommendation_sessions_selection_idempotency_uq
  ON mbox.recommendation_sessions (tenant_id, store_id, selection_idempotency_key)
  WHERE selection_idempotency_key IS NOT NULL;

ALTER TABLE mbox.order_items
  ADD CONSTRAINT order_items_plan_reference_uq
    UNIQUE (tenant_id, store_id, id, order_id, product_id);
ALTER TABLE mbox.payments
  ADD CONSTRAINT payments_plan_reference_uq
    UNIQUE (tenant_id, store_id, id, order_id);

ALTER TABLE mbox.customer_experience_plans
  ADD COLUMN order_id uuid,
  ADD COLUMN order_item_id uuid,
  ADD COLUMN payment_id uuid,
  ADD COLUMN activation_gate text
    CHECK (activation_gate IN ('deferred_order','verified_payment')),
  ADD COLUMN activation_idempotency_key text
    CHECK (activation_idempotency_key IS NULL OR length(activation_idempotency_key) BETWEEN 8 AND 128),
  ADD COLUMN activation_failed_at timestamptz,
  ADD COLUMN cancelled_reason_code text
    CHECK (cancelled_reason_code IS NULL OR cancelled_reason_code ~ '^[a-z][a-z0-9_.-]{1,63}$'),
  ADD CONSTRAINT customer_experience_plans_order_item_fk
    FOREIGN KEY (tenant_id, store_id, order_item_id, order_id, selected_product_id)
    REFERENCES mbox.order_items(tenant_id, store_id, id, order_id, product_id),
  ADD CONSTRAINT customer_experience_plans_payment_fk
    FOREIGN KEY (tenant_id, store_id, payment_id, order_id)
    REFERENCES mbox.payments(tenant_id, store_id, id, order_id),
  ADD CONSTRAINT customer_experience_plans_activation_shape_ck CHECK (
    (activation_gate IS NULL AND order_id IS NULL AND order_item_id IS NULL
      AND payment_id IS NULL AND activation_idempotency_key IS NULL)
    OR
    (activation_gate='deferred_order' AND order_id IS NOT NULL AND order_item_id IS NOT NULL
      AND payment_id IS NULL AND activation_idempotency_key IS NOT NULL
      AND plan_state IN ('active','paused','completed','cancelled'))
    OR
    (activation_gate='verified_payment' AND order_id IS NOT NULL AND order_item_id IS NOT NULL
      AND activation_idempotency_key IS NOT NULL
      AND ((plan_state='planned' AND payment_id IS NULL AND activated_at IS NULL)
        OR (plan_state='cancelled' AND payment_id IS NULL
          AND cancelled_reason_code='payment_failed' AND activated_at IS NULL)
        OR (plan_state IN ('active','paused','completed','cancelled') AND payment_id IS NOT NULL)))
  ) NOT VALID;

CREATE UNIQUE INDEX customer_experience_plans_order_uq
  ON mbox.customer_experience_plans (tenant_id, store_id, order_id)
  WHERE order_id IS NOT NULL;
CREATE UNIQUE INDEX customer_experience_plans_activation_idempotency_uq
  ON mbox.customer_experience_plans (tenant_id, store_id, activation_idempotency_key)
  WHERE activation_idempotency_key IS NOT NULL;

-- Pre-086 active plans have no authoritative order link.  They are retained as
-- history but fail closed so an old recommendation click cannot dispatch work.
UPDATE mbox.customer_experience_plans
SET plan_state='cancelled',cancelled_reason_code='legacy_unverified_order_binding',
  updated_at=clock_timestamp()
WHERE activation_gate IS NULL AND plan_state IN ('planned','active','paused');

UPDATE mbox.experience_plan_cues cue
SET status='skipped',updated_at=clock_timestamp()
FROM mbox.customer_experience_plans plan
WHERE plan.tenant_id=cue.tenant_id AND plan.store_id=cue.store_id
  AND plan.id=cue.experience_plan_id
  AND plan.cancelled_reason_code='legacy_unverified_order_binding'
  AND cue.status IN ('pending','ready');

CREATE OR REPLACE FUNCTION mbox.reject_unbound_experience_plan()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (TG_OP='INSERT' AND NEW.activation_gate IS NULL)
    OR (TG_OP='UPDATE' AND NEW.activation_gate IS NULL
      AND NEW.plan_state IN ('planned','active','paused')) THEN
    RAISE EXCEPTION 'new runnable experience plans require an authoritative order binding'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER customer_experience_plans_require_order_binding
  BEFORE INSERT OR UPDATE ON mbox.customer_experience_plans
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_unbound_experience_plan();

CREATE TABLE mbox.experience_plan_activation_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  experience_plan_id uuid,
  recommendation_session_id uuid NOT NULL,
  recommendation_option_id uuid NOT NULL,
  order_id uuid NOT NULL,
  order_item_id uuid NOT NULL,
  payment_id uuid,
  event_type text NOT NULL CHECK (event_type IN (
    'created_active','created_pending_payment','activated_after_payment',
    'activation_failed','cancelled_after_payment_failure','cancelled_after_refund'
  )),
  reason_code text NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9_.-]{1,63}$'),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, experience_plan_id)
    REFERENCES mbox.customer_experience_plans(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, recommendation_session_id)
    REFERENCES mbox.recommendation_sessions(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, recommendation_option_id)
    REFERENCES mbox.recommendation_options(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, order_id)
    REFERENCES mbox.orders(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, order_item_id)
    REFERENCES mbox.order_items(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, payment_id)
    REFERENCES mbox.payments(tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, idempotency_key),
  UNIQUE (tenant_id, store_id, id)
);

CREATE OR REPLACE FUNCTION mbox.reject_unactivated_experience_cue()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM mbox.customer_experience_plans plan
    WHERE plan.tenant_id=NEW.tenant_id AND plan.store_id=NEW.store_id
      AND plan.id=NEW.experience_plan_id
      AND plan.plan_state='active' AND plan.activated_at IS NOT NULL
      AND plan.order_id IS NOT NULL AND plan.order_item_id IS NOT NULL
      AND (plan.activation_gate='deferred_order'
        OR (plan.activation_gate='verified_payment' AND plan.payment_id IS NOT NULL))
  ) THEN
    RAISE EXCEPTION 'experience cues require an activated ordered plan' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER experience_plan_cues_require_activation
  BEFORE INSERT ON mbox.experience_plan_cues
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_unactivated_experience_cue();

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'customer_preference_declarations','customer_preference_withdrawals',
    'experience_plan_activation_events'
  ] LOOP
    EXECUTE format('ALTER TABLE mbox.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE mbox.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_store_isolation ON mbox.%I USING (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())',
      table_name
    );
    EXECUTE format('REVOKE ALL ON TABLE mbox.%I FROM PUBLIC', table_name);
  END LOOP;
END $$;

GRANT SELECT,INSERT ON TABLE
  mbox.customer_preference_declarations,
  mbox.customer_preference_withdrawals,
  mbox.experience_plan_activation_events
TO mbox_runtime;

COMMENT ON TABLE mbox.customer_preference_declarations IS
  'Explicit customer-level preference evidence. Recommendation eligibility is a strong boolean, never a JSON key.';
COMMENT ON TABLE mbox.customer_preference_facts IS
  'Canonical-family derived preference facts with decay and contrary evidence; recomputable from append-only evidence.';
COMMENT ON TABLE mbox.experience_plan_activation_events IS
  'Strong activation and recovery evidence. Recommendation selection alone never creates a runnable plan.';

UPDATE mbox.normalized_schema_metadata
SET schema_version='086', updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
