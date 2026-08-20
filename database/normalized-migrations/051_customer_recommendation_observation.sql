BEGIN;

ALTER TABLE mbox.products
  ADD COLUMN recommendation_beverage_family text NOT NULL DEFAULT 'none'
    CHECK (recommendation_beverage_family IN (
      'cocktail', 'wine', 'sparkling', 'beer', 'spirits', 'non_alcoholic', 'mixed', 'none'
    ));

UPDATE mbox.products
SET recommendation_beverage_family = CASE
  WHEN lower(product_snapshot->>'beverageFamily') IN (
    'cocktail', 'wine', 'sparkling', 'beer', 'spirits', 'non_alcoholic', 'mixed', 'none'
  ) THEN lower(product_snapshot->>'beverageFamily')
  ELSE 'none'
END;

ALTER TABLE mbox.products
  DROP CONSTRAINT IF EXISTS products_recommendation_scene_tags_check;
ALTER TABLE mbox.products
  ADD CONSTRAINT products_recommendation_scene_tags_check
    CHECK (recommendation_scene_tags <@ ARRAY[
      'date','brothers','besties','friends','business','celebration','unsure','music','relaxed'
    ]::text[]);

ALTER TABLE mbox.checkout_upgrade_rules
  ADD COLUMN minimum_gross_margin_basis_points integer NOT NULL DEFAULT 6000
    CHECK (minimum_gross_margin_basis_points BETWEEN 0 AND 9999);

UPDATE mbox.checkout_upgrade_rules
SET minimum_gross_margin_basis_points = CASE
  WHEN configuration->>'minimumGrossMarginBasisPoints' ~ '^\d{1,4}$'
    AND (configuration->>'minimumGrossMarginBasisPoints')::integer BETWEEN 0 AND 9999
  THEN (configuration->>'minimumGrossMarginBasisPoints')::integer
  ELSE 6000
END;

CREATE TABLE mbox.table_session_customer_participations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  public_id text NOT NULL CHECK (length(public_id) BETWEEN 8 AND 128),
  table_session_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  join_source text NOT NULL
    CHECK (join_source IN ('qr', 'reservation', 'payment', 'employee_assisted', 'system_identified', 'migration')),
  participation_role text NOT NULL DEFAULT 'unknown'
    CHECK (participation_role IN ('reservation_owner', 'organizer', 'payer', 'companion', 'unknown')),
  confirmation_state text NOT NULL DEFAULT 'unconfirmed'
    CHECK (confirmation_state IN ('unconfirmed', 'confirmed', 'corrected')),
  identity_level text NOT NULL DEFAULT 'anonymous'
    CHECK (identity_level IN ('anonymous', 'wechat', 'member')),
  seat_label text,
  source_reference text,
  joined_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  left_at timestamptz,
  recorded_by_employee_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, table_session_id)
    REFERENCES mbox.table_sessions(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, customer_id)
    REFERENCES mbox.customers(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, recorded_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  CHECK (left_at IS NULL OR left_at >= joined_at),
  UNIQUE (tenant_id, store_id, public_id),
  UNIQUE (tenant_id, store_id, id)
);

CREATE UNIQUE INDEX table_session_customer_participations_active_uq
  ON mbox.table_session_customer_participations (
    tenant_id, store_id, table_session_id, customer_id
  ) WHERE left_at IS NULL;
CREATE INDEX table_session_customer_participations_timeline_idx
  ON mbox.table_session_customer_participations (
    tenant_id, store_id, table_session_id, joined_at, id
  );

INSERT INTO mbox.table_session_customer_participations (
  tenant_id, store_id, public_id, table_session_id, customer_id,
  join_source, participation_role, confirmation_state, identity_level,
  joined_at, recorded_by_employee_id
)
SELECT membership.tenant_id, membership.store_id,
  'participation-' || membership.id::text,
  membership.table_session_id, membership.customer_id, 'migration',
  CASE membership.relationship WHEN 'primary' THEN 'organizer' ELSE 'unknown' END,
  'confirmed',
  CASE WHEN EXISTS (
    SELECT 1 FROM mbox.customer_memberships customer_membership
    WHERE customer_membership.tenant_id=membership.tenant_id
      AND customer_membership.store_id=membership.store_id
      AND customer_membership.customer_id=membership.customer_id
      AND customer_membership.status='active'
  ) THEN 'member' WHEN EXISTS (
    SELECT 1 FROM mbox.customer_identities identity
    WHERE identity.tenant_id=membership.tenant_id
      AND identity.store_id=membership.store_id
      AND identity.customer_id=membership.customer_id
      AND identity.identity_kind='wechat' AND identity.status='active'
  ) THEN 'wechat' ELSE 'anonymous' END,
  membership.linked_at, membership.linked_by_employee_id
FROM mbox.table_session_customers membership
ON CONFLICT (tenant_id, store_id, table_session_id, customer_id)
  WHERE left_at IS NULL DO NOTHING;

CREATE OR REPLACE FUNCTION mbox.capture_table_session_customer_participation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE resolved_identity_level text;
BEGIN
  IF TG_OP='DELETE' OR (TG_OP='UPDATE' AND NEW.relationship IS DISTINCT FROM OLD.relationship) THEN
    UPDATE mbox.table_session_customer_participations
    SET left_at=clock_timestamp()
    WHERE tenant_id=OLD.tenant_id AND store_id=OLD.store_id
      AND table_session_id=OLD.table_session_id AND customer_id=OLD.customer_id
      AND left_at IS NULL;
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  ELSIF TG_OP='UPDATE' THEN
    RETURN NEW;
  END IF;

  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM mbox.customer_memberships membership
      WHERE membership.tenant_id=NEW.tenant_id AND membership.store_id=NEW.store_id
        AND membership.customer_id=NEW.customer_id AND membership.status='active'
    ) THEN 'member'
    WHEN EXISTS (
      SELECT 1 FROM mbox.customer_identities identity
      WHERE identity.tenant_id=NEW.tenant_id AND identity.store_id=NEW.store_id
        AND identity.customer_id=NEW.customer_id
        AND identity.identity_kind='wechat' AND identity.status='active'
    ) THEN 'wechat'
    ELSE 'anonymous'
  END INTO resolved_identity_level;

  INSERT INTO mbox.table_session_customer_participations (
    tenant_id, store_id, public_id, table_session_id, customer_id,
    join_source, participation_role, confirmation_state, identity_level,
    source_reference, joined_at, recorded_by_employee_id
  ) VALUES (
    NEW.tenant_id, NEW.store_id,
    'participation-' || replace(gen_random_uuid()::text, '-', ''),
    NEW.table_session_id, NEW.customer_id,
    CASE WHEN NEW.linked_by_employee_id IS NULL THEN 'system_identified' ELSE 'employee_assisted' END,
    CASE NEW.relationship WHEN 'primary' THEN 'organizer' ELSE 'companion' END,
    'confirmed', resolved_identity_level, NEW.id::text, NEW.linked_at,
    NEW.linked_by_employee_id
  )
  ON CONFLICT (tenant_id, store_id, table_session_id, customer_id)
    WHERE left_at IS NULL DO NOTHING;
  RETURN NEW;
END $$;

CREATE TRIGGER table_session_customers_capture_participation
  AFTER INSERT OR UPDATE OF relationship OR DELETE ON mbox.table_session_customers
  FOR EACH ROW EXECUTE FUNCTION mbox.capture_table_session_customer_participation();

CREATE OR REPLACE FUNCTION mbox.close_table_session_customer_participations()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('closed', 'cancelled') AND OLD.status IS DISTINCT FROM NEW.status THEN
    UPDATE mbox.table_session_customer_participations
    SET left_at=COALESCE(NEW.closed_at, clock_timestamp())
    WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id
      AND table_session_id=NEW.id AND left_at IS NULL;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER table_sessions_close_customer_participations
  AFTER UPDATE OF status ON mbox.table_sessions
  FOR EACH ROW EXECUTE FUNCTION mbox.close_table_session_customer_participations();

CREATE TABLE mbox.recommendation_policy_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  public_id text NOT NULL CHECK (length(public_id) BETWEEN 8 AND 128),
  policy_code text NOT NULL CHECK (policy_code ~ '^[A-Z][A-Z0-9_-]{2,63}$'),
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'approved', 'published', 'retired')),
  preference_weight integer NOT NULL DEFAULT 100 CHECK (preference_weight BETWEEN -1000 AND 1000),
  scene_weight integer NOT NULL DEFAULT 60 CHECK (scene_weight BETWEEN -1000 AND 1000),
  margin_weight integer NOT NULL DEFAULT 50 CHECK (margin_weight BETWEEN -1000 AND 1000),
  priority_weight integer NOT NULL DEFAULT 50 CHECK (priority_weight BETWEEN -1000 AND 1000),
  performance_weight integer NOT NULL DEFAULT 0 CHECK (performance_weight BETWEEN -1000 AND 1000),
  inventory_weight integer NOT NULL DEFAULT 0 CHECK (inventory_weight BETWEEN -1000 AND 1000),
  capacity_weight integer NOT NULL DEFAULT 0 CHECK (capacity_weight BETWEEN -1000 AND 1000),
  minimum_gross_margin_basis_points integer NOT NULL DEFAULT 0
    CHECK (minimum_gross_margin_basis_points BETWEEN 0 AND 9999),
  explanation_template text NOT NULL DEFAULT '按人数、场景、偏好和当前可售状态推荐',
  display_configuration jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(display_configuration)='object'),
  created_by_employee_id uuid,
  approved_by_employee_id uuid,
  published_by_employee_id uuid,
  approved_at timestamptz,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, created_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, approved_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, published_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  CHECK (approved_by_employee_id IS NULL OR created_by_employee_id IS NULL OR approved_by_employee_id<>created_by_employee_id),
  CHECK ((status IN ('approved','published','retired')) = (approved_by_employee_id IS NOT NULL OR created_by_employee_id IS NULL)),
  CHECK ((status IN ('published','retired')) = (published_at IS NOT NULL)),
  UNIQUE (tenant_id, store_id, public_id),
  UNIQUE (tenant_id, store_id, policy_code, version),
  UNIQUE (tenant_id, store_id, id)
);

CREATE UNIQUE INDEX recommendation_policy_versions_published_uq
  ON mbox.recommendation_policy_versions (tenant_id, store_id, policy_code)
  WHERE status='published';

INSERT INTO mbox.recommendation_policy_versions (
  tenant_id, store_id, public_id, policy_code, version, status,
  approved_at, published_at, explanation_template
)
SELECT store.tenant_id, store.id,
  'recommendation-default-' || replace(store.id::text, '-', ''),
  'DEFAULT', 1, 'published', clock_timestamp(), clock_timestamp(),
  '按人数、场景、偏好、价格与合理毛利综合推荐'
FROM mbox.stores store
ON CONFLICT (tenant_id, store_id, policy_code, version) DO NOTHING;

CREATE TABLE mbox.recommendation_options (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  recommendation_session_id uuid NOT NULL,
  policy_version_id uuid NOT NULL,
  product_id uuid NOT NULL,
  rank integer NOT NULL CHECK (rank BETWEEN 1 AND 20),
  tier text NOT NULL CHECK (tier IN ('comfortable', 'enhanced', 'signature')),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  cost_amount_minor bigint NOT NULL CHECK (cost_amount_minor >= 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  total_score integer NOT NULL,
  preference_contribution integer NOT NULL DEFAULT 0,
  scene_contribution integer NOT NULL DEFAULT 0,
  margin_contribution integer NOT NULL DEFAULT 0,
  priority_contribution integer NOT NULL DEFAULT 0,
  performance_contribution integer NOT NULL DEFAULT 0,
  inventory_contribution integer NOT NULL DEFAULT 0,
  capacity_contribution integer NOT NULL DEFAULT 0,
  explanation text NOT NULL,
  display_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(display_snapshot)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, recommendation_session_id)
    REFERENCES mbox.recommendation_sessions(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, policy_version_id)
    REFERENCES mbox.recommendation_policy_versions(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, product_id)
    REFERENCES mbox.products(tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, recommendation_session_id, rank),
  UNIQUE (tenant_id, store_id, recommendation_session_id, product_id),
  UNIQUE (tenant_id, store_id, id)
);

CREATE TABLE mbox.recommendation_behavior_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  recommendation_session_id uuid NOT NULL,
  recommendation_option_id uuid,
  customer_id uuid NOT NULL,
  table_session_id uuid,
  order_id uuid,
  event_type text NOT NULL CHECK (event_type IN (
    'generated', 'exposed', 'viewed', 'selected', 'ignored', 'rejected',
    'staff_modified', 'ordered', 'paid', 'refunded'
  )),
  actor_type text NOT NULL CHECK (actor_type IN ('guest','employee','system')),
  actor_ref text NOT NULL CHECK (length(btrim(actor_ref)) BETWEEN 2 AND 128),
  reason_code text,
  evidence_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(evidence_snapshot)='object'),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, recommendation_session_id)
    REFERENCES mbox.recommendation_sessions(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, recommendation_option_id)
    REFERENCES mbox.recommendation_options(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, customer_id)
    REFERENCES mbox.customers(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, table_session_id)
    REFERENCES mbox.table_sessions(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, order_id)
    REFERENCES mbox.orders(tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, id)
);

CREATE INDEX recommendation_behavior_events_session_idx
  ON mbox.recommendation_behavior_events (
    tenant_id, store_id, recommendation_session_id, occurred_at, id
  );

CREATE TABLE mbox.observation_inputs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  public_id text NOT NULL CHECK (length(public_id) BETWEEN 8 AND 128),
  table_session_id uuid NOT NULL,
  order_id uuid,
  schedule_id uuid,
  recorded_by_employee_id uuid NOT NULL,
  input_kind text NOT NULL CHECK (input_kind IN ('text','voice_transcript')),
  raw_content text NOT NULL CHECK (length(btrim(raw_content)) BETWEEN 1 AND 2000),
  audio_evidence_ref text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','confirmed','rejected')),
  needs_immediate_action boolean NOT NULL DEFAULT false,
  service_task_id uuid,
  parse_confidence numeric(5,4) NOT NULL DEFAULT 0 CHECK (parse_confidence BETWEEN 0 AND 1),
  confirmed_by_employee_id uuid,
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, table_session_id)
    REFERENCES mbox.table_sessions(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, order_id)
    REFERENCES mbox.orders(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, schedule_id)
    REFERENCES mbox.schedules(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, recorded_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, service_task_id)
    REFERENCES mbox.service_tasks(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, confirmed_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  CHECK ((status='confirmed')=(confirmed_at IS NOT NULL)),
  UNIQUE (tenant_id, store_id, public_id),
  UNIQUE (tenant_id, store_id, id)
);

CREATE TABLE mbox.observation_parse_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  observation_input_id uuid NOT NULL,
  parser_kind text NOT NULL CHECK (parser_kind IN ('deterministic','ai_assisted','manual')),
  parser_version text NOT NULL CHECK (length(btrim(parser_version)) BETWEEN 1 AND 64),
  overall_confidence numeric(5,4) NOT NULL CHECK (overall_confidence BETWEEN 0 AND 1),
  raw_result_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(raw_result_snapshot)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, observation_input_id)
    REFERENCES mbox.observation_inputs(tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, id)
);

CREATE TABLE mbox.observation_match_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  observation_input_id uuid NOT NULL,
  mention_index integer NOT NULL CHECK (mention_index BETWEEN 0 AND 100),
  raw_mention text NOT NULL CHECK (length(btrim(raw_mention)) BETWEEN 1 AND 200),
  order_item_id uuid NOT NULL,
  product_id uuid NOT NULL,
  candidate_rank integer NOT NULL CHECK (candidate_rank BETWEEN 1 AND 20),
  confidence numeric(5,4) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  match_kind text NOT NULL CHECK (match_kind IN ('exact_name','search_text','order_context','manual')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, observation_input_id)
    REFERENCES mbox.observation_inputs(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, order_item_id)
    REFERENCES mbox.order_items(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, product_id)
    REFERENCES mbox.products(tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, observation_input_id, mention_index, candidate_rank),
  UNIQUE (tenant_id, store_id, id)
);

CREATE TABLE mbox.observation_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  observation_input_id uuid NOT NULL,
  event_group_id uuid NOT NULL DEFAULT gen_random_uuid(),
  revision_no integer NOT NULL DEFAULT 1 CHECK (revision_no > 0),
  expression_kind text NOT NULL
    CHECK (expression_kind IN ('objective_fact','customer_quote','staff_judgement','system_inference')),
  scope_kind text NOT NULL CHECK (scope_kind IN ('table','seat','customer','product')),
  event_type text NOT NULL CHECK (event_type IN (
    'remaining','consumed_little','praise','complaint','too_sweet','too_cold',
    'served_late','presentation','portion','other'
  )),
  degree text CHECK (degree IN ('little','half','most','almost_untouched','unknown')),
  reason_code text,
  seat_label text,
  customer_id uuid,
  product_id uuid,
  order_item_id uuid,
  selected_candidate_id uuid,
  confidence numeric(5,4) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  raw_excerpt text NOT NULL CHECK (length(btrim(raw_excerpt)) BETWEEN 1 AND 1000),
  needs_immediate_action boolean NOT NULL DEFAULT false,
  service_task_id uuid,
  confirmation_state text NOT NULL DEFAULT 'confirmed'
    CHECK (confirmation_state IN ('draft','confirmed','corrected')),
  confirmed_by_employee_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, observation_input_id)
    REFERENCES mbox.observation_inputs(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, customer_id)
    REFERENCES mbox.customers(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, product_id)
    REFERENCES mbox.products(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, order_item_id)
    REFERENCES mbox.order_items(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, selected_candidate_id)
    REFERENCES mbox.observation_match_candidates(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, service_task_id)
    REFERENCES mbox.service_tasks(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, confirmed_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  CHECK (scope_kind<>'customer' OR customer_id IS NOT NULL),
  CHECK (scope_kind<>'seat' OR seat_label IS NOT NULL),
  CHECK (scope_kind<>'product' OR product_id IS NOT NULL),
  UNIQUE (tenant_id, store_id, event_group_id, revision_no),
  UNIQUE (tenant_id, store_id, id)
);

CREATE TABLE mbox.observation_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  observation_input_id uuid NOT NULL,
  previous_event_id uuid NOT NULL,
  replacement_event_id uuid NOT NULL,
  corrected_by_employee_id uuid NOT NULL,
  correction_reason text NOT NULL CHECK (length(btrim(correction_reason)) BETWEEN 2 AND 500),
  before_snapshot jsonb NOT NULL CHECK (jsonb_typeof(before_snapshot)='object'),
  after_snapshot jsonb NOT NULL CHECK (jsonb_typeof(after_snapshot)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, observation_input_id)
    REFERENCES mbox.observation_inputs(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, previous_event_id)
    REFERENCES mbox.observation_events(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, replacement_event_id)
    REFERENCES mbox.observation_events(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, corrected_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, previous_event_id, replacement_event_id),
  UNIQUE (tenant_id, store_id, id)
);

CREATE TABLE mbox.preference_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  observation_event_id uuid NOT NULL,
  preference_key text NOT NULL CHECK (preference_key ~ '^[a-z][a-z0-9_.-]{1,63}$'),
  preference_value text NOT NULL CHECK (length(btrim(preference_value)) BETWEEN 1 AND 200),
  polarity text NOT NULL CHECK (polarity IN ('supports','contradicts')),
  evidence_weight integer NOT NULL CHECK (evidence_weight BETWEEN 1 AND 100),
  confidence numeric(5,4) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  valid_until timestamptz,
  allowed_for_recommendation boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, customer_id)
    REFERENCES mbox.customers(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, observation_event_id)
    REFERENCES mbox.observation_events(tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, customer_id, observation_event_id, preference_key),
  UNIQUE (tenant_id, store_id, id)
);

CREATE TABLE mbox.customer_preference_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  preference_key text NOT NULL CHECK (preference_key ~ '^[a-z][a-z0-9_.-]{1,63}$'),
  preference_value text NOT NULL CHECK (length(btrim(preference_value)) BETWEEN 1 AND 200),
  confidence numeric(5,4) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  supporting_evidence_count integer NOT NULL DEFAULT 0 CHECK (supporting_evidence_count >= 0),
  contrary_evidence_count integer NOT NULL DEFAULT 0 CHECK (contrary_evidence_count >= 0),
  policy_version integer NOT NULL CHECK (policy_version > 0),
  valid_until timestamptz,
  calculated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, customer_id)
    REFERENCES mbox.customers(tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, customer_id, preference_key, preference_value),
  UNIQUE (tenant_id, store_id, id)
);

CREATE INDEX observation_inputs_table_timeline_idx
  ON mbox.observation_inputs (tenant_id, store_id, table_session_id, created_at DESC, id);
CREATE INDEX observation_events_product_timeline_idx
  ON mbox.observation_events (tenant_id, store_id, product_id, created_at DESC, id)
  WHERE product_id IS NOT NULL;
CREATE INDEX preference_evidence_customer_idx
  ON mbox.preference_evidence (tenant_id, store_id, customer_id, created_at DESC, id);

CREATE OR REPLACE FUNCTION mbox.protect_observation_input_evidence()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.table_session_id IS DISTINCT FROM OLD.table_session_id
    OR NEW.order_id IS DISTINCT FROM OLD.order_id
    OR NEW.schedule_id IS DISTINCT FROM OLD.schedule_id
    OR NEW.recorded_by_employee_id IS DISTINCT FROM OLD.recorded_by_employee_id
    OR NEW.input_kind IS DISTINCT FROM OLD.input_kind
    OR NEW.raw_content IS DISTINCT FROM OLD.raw_content
    OR NEW.audio_evidence_ref IS DISTINCT FROM OLD.audio_evidence_ref
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'observation raw evidence is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER observation_inputs_protect_evidence
  BEFORE UPDATE ON mbox.observation_inputs
  FOR EACH ROW EXECUTE FUNCTION mbox.protect_observation_input_evidence();
CREATE TRIGGER observation_inputs_touch_updated_at
  BEFORE UPDATE ON mbox.observation_inputs
  FOR EACH ROW EXECUTE FUNCTION mbox.touch_updated_at();
CREATE TRIGGER recommendation_policy_versions_touch_updated_at
  BEFORE UPDATE ON mbox.recommendation_policy_versions
  FOR EACH ROW EXECUTE FUNCTION mbox.touch_updated_at();
CREATE TRIGGER customer_preference_facts_touch_updated_at
  BEFORE UPDATE ON mbox.customer_preference_facts
  FOR EACH ROW EXECUTE FUNCTION mbox.touch_updated_at();

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'observation_parse_runs', 'observation_match_candidates',
    'observation_revisions', 'preference_evidence', 'recommendation_behavior_events'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I_append_only BEFORE UPDATE OR DELETE ON mbox.%I FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change()',
      table_name, table_name
    );
  END LOOP;
END $$;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'table_session_customer_participations', 'recommendation_policy_versions',
    'recommendation_options', 'recommendation_behavior_events', 'observation_inputs',
    'observation_parse_runs', 'observation_match_candidates', 'observation_events',
    'observation_revisions', 'preference_evidence', 'customer_preference_facts'
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

GRANT SELECT, INSERT, UPDATE ON TABLE
  mbox.table_session_customer_participations,
  mbox.recommendation_policy_versions,
  mbox.observation_inputs,
  mbox.customer_preference_facts
TO mbox_runtime;
GRANT SELECT, INSERT ON TABLE
  mbox.recommendation_options,
  mbox.recommendation_behavior_events,
  mbox.observation_parse_runs,
  mbox.observation_match_candidates,
  mbox.observation_events,
  mbox.observation_revisions,
  mbox.preference_evidence
TO mbox_runtime;

CREATE OR REPLACE FUNCTION mbox.seed_store_recommendation_observation_permissions()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO mbox.staff_permission_definitions (
    tenant_id, store_id, code, name, category, description, status
  ) SELECT NEW.tenant_id, NEW.id, permission.code, permission.name,
    permission.category, permission.description, 'active'
  FROM (VALUES
    ('observation.record', '记录桌台情况', 'customer_experience', '记录本人负责桌台的原始观察并保留原文'),
    ('observation.record.all', '记录全店桌台情况', 'customer_experience', '跨当前主责、候补或临时分配记录任意桌台观察'),
    ('observation.confirm', '确认观察解析', 'customer_experience', '确认系统候选和结构化观察结果'),
    ('observation.correct', '修正已确认观察', 'customer_experience', '追加修正已确认观察并保留前后版本'),
    ('observation.view.raw', '查看观察原文', 'customer_experience', '按数据范围查看员工观察原文和解析证据'),
    ('recommendation.rule.draft', '起草推荐规则', 'customer_experience', '新建推荐策略草稿，不直接影响顾客'),
    ('recommendation.rule.approve', '审批推荐规则', 'customer_experience', '由非起草人审批推荐策略版本'),
    ('recommendation.rule.publish', '发布推荐规则', 'customer_experience', '发布已审批推荐策略并退出旧版本'),
    ('recommendation.analytics.view', '查看推荐分析', 'customer_experience', '查看推荐曝光、选择、成交和退款结果'),
    ('product.observation.analytics.view', '查看商品观察分析', 'customer_experience', '查看商品观察、纠错率、样本和置信度')
  ) AS permission(code,name,category,description)
  ON CONFLICT (tenant_id,store_id,code) DO UPDATE SET
    name=EXCLUDED.name, category=EXCLUDED.category,
    description=EXCLUDED.description, status='active';
  RETURN NEW;
END $$;

CREATE TRIGGER stores_seed_recommendation_observation_permissions
  AFTER INSERT ON mbox.stores
  FOR EACH ROW EXECUTE FUNCTION mbox.seed_store_recommendation_observation_permissions();

INSERT INTO mbox.staff_permission_definitions (
  tenant_id, store_id, code, name, category, description, status
)
SELECT store.tenant_id, store.id, permission.code, permission.name,
  permission.category, permission.description, 'active'
FROM mbox.stores store
CROSS JOIN (VALUES
  ('observation.record', '记录桌台情况', 'customer_experience', '记录本人负责桌台的原始观察并保留原文'),
  ('observation.record.all', '记录全店桌台情况', 'customer_experience', '跨当前主责、候补或临时分配记录任意桌台观察'),
  ('observation.confirm', '确认观察解析', 'customer_experience', '确认系统候选和结构化观察结果'),
  ('observation.correct', '修正已确认观察', 'customer_experience', '追加修正已确认观察并保留前后版本'),
  ('observation.view.raw', '查看观察原文', 'customer_experience', '按数据范围查看员工观察原文和解析证据'),
  ('recommendation.rule.draft', '起草推荐规则', 'customer_experience', '新建推荐策略草稿，不直接影响顾客'),
  ('recommendation.rule.approve', '审批推荐规则', 'customer_experience', '由非起草人审批推荐策略版本'),
  ('recommendation.rule.publish', '发布推荐规则', 'customer_experience', '发布已审批推荐策略并退出旧版本'),
  ('recommendation.analytics.view', '查看推荐分析', 'customer_experience', '查看推荐曝光、选择、成交和退款结果'),
  ('product.observation.analytics.view', '查看商品观察分析', 'customer_experience', '查看商品观察、纠错率、样本和置信度')
) AS permission(code,name,category,description)
ON CONFLICT (tenant_id,store_id,code) DO UPDATE SET
  name=EXCLUDED.name, category=EXCLUDED.category,
  description=EXCLUDED.description, status='active';

COMMENT ON COLUMN mbox.products.recommendation_beverage_family IS
  'Typed beverage family used by recommendation eligibility and ranking. Runtime must not parse product_snapshot for this decision.';
COMMENT ON TABLE mbox.table_session_customer_participations IS
  'Append-oriented customer participation episodes preserving join source, role, identity assurance and leave history.';
COMMENT ON TABLE mbox.observation_inputs IS
  'Original staff text or voice transcript. Raw evidence is immutable after insertion.';
COMMENT ON TABLE mbox.observation_match_candidates IS
  'Product candidates constrained to actual order items from the observation table session.';
COMMENT ON TABLE mbox.preference_evidence IS
  'Confirmed customer-scoped evidence only. Table observations are never copied to every participant.';

COMMIT;
