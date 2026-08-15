-- Runs after the configurable refund workflow migration (049).
BEGIN;

CREATE TABLE mbox.customer_experience_features (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  feature_code text NOT NULL CHECK (feature_code ~ '^[a-z][a-z0-9_.-]{2,63}$'),
  rollout_state text NOT NULL DEFAULT 'disabled'
    CHECK (rollout_state IN ('disabled', 'shadow', 'pilot', 'enabled')),
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(configuration) = 'object'),
  reason text NOT NULL,
  approved_by_employee_id uuid,
  effective_from timestamptz,
  effective_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, approved_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  CHECK (effective_until IS NULL OR effective_from IS NULL OR effective_until > effective_from),
  UNIQUE (tenant_id, store_id, feature_code),
  UNIQUE (tenant_id, store_id, id)
);

CREATE TABLE mbox.customer_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  member_no text NOT NULL CHECK (member_no ~ '^MBX[0-9A-Z-]{6,32}$'),
  level text NOT NULL DEFAULT 'member'
    CHECK (level IN ('member', 'silver', 'gold', 'black')),
  lifecycle_stage text NOT NULL DEFAULT 'new'
    CHECK (lifecycle_stage IN ('new', 'active', 'high_value', 'at_risk', 'dormant')),
  points_balance integer NOT NULL DEFAULT 0 CHECK (points_balance >= 0),
  lifetime_points integer NOT NULL DEFAULT 0 CHECK (lifetime_points >= 0),
  visit_count integer NOT NULL DEFAULT 0 CHECK (visit_count >= 0),
  lifetime_spend_amount_minor bigint NOT NULL DEFAULT 0 CHECK (lifetime_spend_amount_minor >= 0),
  currency char(3) NOT NULL DEFAULT 'CNY' CHECK (currency ~ '^[A-Z]{3}$'),
  service_owner_employee_id uuid,
  joined_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_visit_at timestamptz,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'closed')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, customer_id)
    REFERENCES mbox.customers(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, service_owner_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, customer_id),
  UNIQUE (tenant_id, store_id, member_no),
  UNIQUE (tenant_id, store_id, id)
);

CREATE TABLE mbox.loyalty_point_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  entry_type text NOT NULL CHECK (entry_type IN ('earn', 'redeem', 'expire', 'adjust')),
  points_delta integer NOT NULL CHECK (points_delta <> 0),
  balance_after integer NOT NULL CHECK (balance_after >= 0),
  source_type text NOT NULL
    CHECK (source_type IN ('order', 'activity', 'benefit', 'campaign', 'service_recovery', 'manual')),
  source_id text NOT NULL CHECK (length(btrim(source_id)) BETWEEN 1 AND 128),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 2 AND 256),
  expires_at timestamptz,
  created_by_employee_id uuid,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, membership_id)
    REFERENCES mbox.customer_memberships(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, customer_id)
    REFERENCES mbox.customers(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, created_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, idempotency_key),
  UNIQUE (tenant_id, store_id, id)
);

CREATE TABLE mbox.recommendation_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  public_id text NOT NULL CHECK (length(public_id) BETWEEN 8 AND 128),
  customer_id uuid NOT NULL,
  table_session_id uuid,
  business_date date NOT NULL,
  source text NOT NULL
    CHECK (source IN ('miniprogram', 'guest_table', 'staff_assisted', 'reservation')),
  party_size integer NOT NULL CHECK (party_size BETWEEN 1 AND 200),
  occasion text NOT NULL
    CHECK (occasion IN ('business', 'friends', 'date', 'birthday', 'music', 'relax', 'other')),
  alcohol_preference text NOT NULL
    CHECK (alcohol_preference IN ('cocktail', 'wine', 'sparkling', 'beer', 'whisky', 'baijiu', 'non_alcoholic', 'mixed', 'undecided')),
  experience_level text NOT NULL
    CHECK (experience_level IN ('comfortable', 'enhanced', 'signature')),
  service_intensity text NOT NULL DEFAULT 'balanced'
    CHECK (service_intensity IN ('quiet', 'balanced', 'hosted')),
  answers_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(answers_snapshot) = 'object'),
  recommendation_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(recommendation_snapshot) = 'array'),
  selected_product_id uuid,
  abandoned_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, customer_id)
    REFERENCES mbox.customers(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, table_session_id)
    REFERENCES mbox.table_sessions(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, selected_product_id)
    REFERENCES mbox.products(tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, public_id),
  UNIQUE (tenant_id, store_id, id)
);

CREATE TABLE mbox.customer_experience_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  public_id text NOT NULL CHECK (length(public_id) BETWEEN 8 AND 128),
  table_session_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  recommendation_session_id uuid,
  business_date date NOT NULL,
  plan_version integer NOT NULL DEFAULT 1 CHECK (plan_version > 0),
  plan_state text NOT NULL DEFAULT 'planned'
    CHECK (plan_state IN ('planned', 'active', 'paused', 'completed', 'cancelled')),
  party_size integer NOT NULL CHECK (party_size BETWEEN 1 AND 200),
  occasion text NOT NULL,
  alcohol_preference text NOT NULL,
  service_intensity text NOT NULL CHECK (service_intensity IN ('quiet', 'balanced', 'hosted')),
  music_preference text,
  promise_summary text NOT NULL CHECK (length(btrim(promise_summary)) BETWEEN 2 AND 280),
  selected_product_id uuid,
  selected_product_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(selected_product_snapshot) = 'object'),
  show_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(show_snapshot) = 'object'),
  created_by_actor_type text NOT NULL CHECK (created_by_actor_type IN ('guest', 'employee', 'system')),
  created_by_actor_ref text NOT NULL CHECK (length(btrim(created_by_actor_ref)) BETWEEN 2 AND 128),
  activated_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, table_session_id)
    REFERENCES mbox.table_sessions(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, customer_id)
    REFERENCES mbox.customers(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, recommendation_session_id)
    REFERENCES mbox.recommendation_sessions(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, selected_product_id)
    REFERENCES mbox.products(tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, table_session_id),
  UNIQUE (tenant_id, store_id, public_id),
  UNIQUE (tenant_id, store_id, id)
);

CREATE TABLE mbox.experience_plan_cues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  experience_plan_id uuid NOT NULL,
  cue_code text NOT NULL CHECK (cue_code ~ '^[a-z][a-z0-9_.-]{2,63}$'),
  sequence_no integer NOT NULL CHECK (sequence_no BETWEEN 1 AND 100),
  trigger_kind text NOT NULL CHECK (trigger_kind IN ('elapsed', 'performance', 'manual', 'product_state')),
  trigger_offset_minutes integer CHECK (trigger_offset_minutes BETWEEN 0 AND 240),
  performance_phase text CHECK (performance_phase IN ('before_show', 'acoustic', 'band_live', 'intermission', 'after_show')),
  action_kind text NOT NULL
    CHECK (action_kind IN ('welcome', 'service', 'drink', 'food', 'music', 'interaction', 'checkin', 'upsell', 'farewell')),
  station text NOT NULL CHECK (station IN ('host', 'service', 'bar', 'cold_kitchen', 'stage', 'manager', 'marketing')),
  product_id uuid,
  action_payload jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(action_payload) = 'object'),
  due_at timestamptz,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'ready', 'dispatched', 'completed', 'skipped', 'failed')),
  service_task_id uuid,
  completed_by_employee_id uuid,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, experience_plan_id)
    REFERENCES mbox.customer_experience_plans(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, product_id)
    REFERENCES mbox.products(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, service_task_id)
    REFERENCES mbox.service_tasks(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, completed_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, experience_plan_id, cue_code),
  UNIQUE (tenant_id, store_id, experience_plan_id, sequence_no),
  UNIQUE (tenant_id, store_id, id)
);

CREATE TABLE mbox.checkout_upgrade_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  code text NOT NULL CHECK (code ~ '^[A-Z][A-Z0-9_-]{2,63}$'),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 80),
  source_product_id uuid NOT NULL,
  target_product_id uuid NOT NULL,
  minimum_party_size integer NOT NULL DEFAULT 1 CHECK (minimum_party_size BETWEEN 1 AND 200),
  maximum_party_size integer NOT NULL DEFAULT 200 CHECK (maximum_party_size BETWEEN 1 AND 200),
  occasion_tags text[] NOT NULL DEFAULT ARRAY[]::text[],
  alcohol_preference_tags text[] NOT NULL DEFAULT ARRAY[]::text[],
  prompt_title text NOT NULL CHECK (length(btrim(prompt_title)) BETWEEN 2 AND 60),
  prompt_body text NOT NULL CHECK (length(btrim(prompt_body)) BETWEEN 2 AND 240),
  call_to_action text NOT NULL CHECK (length(btrim(call_to_action)) BETWEEN 2 AND 30),
  priority integer NOT NULL DEFAULT 100 CHECK (priority BETWEEN 0 AND 10000),
  offer_valid_minutes integer NOT NULL DEFAULT 10 CHECK (offer_valid_minutes BETWEEN 2 AND 30),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'active', 'paused', 'retired')),
  approved_by_employee_id uuid,
  valid_from timestamptz,
  valid_until timestamptz,
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(configuration) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, source_product_id)
    REFERENCES mbox.products(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, target_product_id)
    REFERENCES mbox.products(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, approved_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  CHECK (source_product_id <> target_product_id),
  CHECK (maximum_party_size >= minimum_party_size),
  CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until > valid_from),
  UNIQUE (tenant_id, store_id, code),
  UNIQUE (tenant_id, store_id, id)
);

CREATE TABLE mbox.checkout_upgrade_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  public_id text NOT NULL CHECK (length(public_id) BETWEEN 8 AND 128),
  table_session_id uuid NOT NULL,
  business_date date NOT NULL,
  customer_id uuid NOT NULL,
  rule_id uuid NOT NULL,
  source_product_id uuid NOT NULL,
  target_product_id uuid NOT NULL,
  source_quantity integer NOT NULL DEFAULT 1 CHECK (source_quantity = 1),
  source_amount_minor bigint NOT NULL CHECK (source_amount_minor > 0),
  target_amount_minor bigint NOT NULL CHECK (target_amount_minor > 0),
  amount_to_add_minor bigint NOT NULL CHECK (amount_to_add_minor > 0),
  currency char(3) NOT NULL DEFAULT 'CNY' CHECK (currency ~ '^[A-Z]{3}$'),
  original_basket jsonb NOT NULL CHECK (jsonb_typeof(original_basket) = 'array'),
  upgraded_basket jsonb NOT NULL CHECK (jsonb_typeof(upgraded_basket) = 'array'),
  basket_fingerprint text NOT NULL CHECK (basket_fingerprint ~ '^[a-f0-9]{64}$'),
  source_snapshot jsonb NOT NULL CHECK (jsonb_typeof(source_snapshot) = 'object'),
  target_snapshot jsonb NOT NULL CHECK (jsonb_typeof(target_snapshot) = 'object'),
  valid_until timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'offered'
    CHECK (status IN ('offered', 'selected', 'converted', 'expired', 'cancelled')),
  converted_order_id uuid,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  selected_at timestamptz,
  converted_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, table_session_id)
    REFERENCES mbox.table_sessions(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, customer_id)
    REFERENCES mbox.customers(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, rule_id)
    REFERENCES mbox.checkout_upgrade_rules(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, source_product_id)
    REFERENCES mbox.products(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, target_product_id)
    REFERENCES mbox.products(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, converted_order_id)
    REFERENCES mbox.orders(tenant_id, store_id, id),
  CHECK (target_amount_minor = source_amount_minor + amount_to_add_minor),
  CHECK (selected_at IS NULL OR status IN ('selected', 'converted')),
  CHECK (converted_at IS NULL OR (status = 'converted' AND converted_order_id IS NOT NULL)),
  UNIQUE (tenant_id, store_id, public_id),
  UNIQUE (tenant_id, store_id, idempotency_key),
  UNIQUE (tenant_id, store_id, id)
);

CREATE TABLE mbox.community_activities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  public_id text NOT NULL CHECK (length(public_id) BETWEEN 8 AND 128),
  activity_kind text NOT NULL
    CHECK (activity_kind IN ('member_night', 'hike', 'camping', 'city_walk', 'music_picnic', 'proposal', 'other')),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 2 AND 120),
  summary text NOT NULL CHECK (length(btrim(summary)) BETWEEN 2 AND 600),
  cover_url text,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  assembly_location text NOT NULL,
  capacity integer NOT NULL CHECK (capacity BETWEEN 1 AND 1000),
  fee_amount_minor bigint NOT NULL DEFAULT 0 CHECK (fee_amount_minor >= 0),
  deposit_amount_minor bigint NOT NULL DEFAULT 0 CHECK (deposit_amount_minor >= 0),
  fee_basis text NOT NULL DEFAULT 'per_registration'
    CHECK (fee_basis IN ('per_person', 'per_registration')),
  registration_payment_mode text NOT NULL DEFAULT 'none'
    CHECK (registration_payment_mode IN ('none', 'deposit_optional', 'deposit_required', 'full_required')),
  payment_deadline_minutes integer NOT NULL DEFAULT 15
    CHECK (payment_deadline_minutes BETWEEN 5 AND 1440),
  payment_rule_text text NOT NULL DEFAULT '本活动无需预付'
    CHECK (length(btrim(payment_rule_text)) BETWEEN 2 AND 240),
  refund_policy_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(refund_policy_snapshot) = 'object'),
  currency char(3) NOT NULL DEFAULT 'CNY' CHECK (currency ~ '^[A-Z]{3}$'),
  points_reward integer NOT NULL DEFAULT 0 CHECK (points_reward BETWEEN 0 AND 100000),
  visibility text NOT NULL DEFAULT 'public'
    CHECK (visibility IN ('public', 'member', 'segment')),
  audience_rule jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(audience_rule) = 'object'),
  safety_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(safety_snapshot) = 'object'),
  sales_copy jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(sales_copy) = 'object'),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'published', 'full', 'cancelled', 'completed')),
  published_at timestamptz,
  created_by_employee_id uuid NOT NULL,
  approved_by_employee_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, created_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, approved_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  CHECK (ends_at > starts_at),
  CHECK (deposit_amount_minor <= fee_amount_minor),
  CHECK (
    (registration_payment_mode = 'none' AND deposit_amount_minor = 0)
    OR (registration_payment_mode IN ('deposit_optional', 'deposit_required')
      AND deposit_amount_minor > 0 AND fee_amount_minor > 0)
    OR (registration_payment_mode = 'full_required'
      AND fee_amount_minor > 0 AND deposit_amount_minor = 0)
  ),
  CHECK ((status = 'draft' AND published_at IS NULL) OR status <> 'draft'),
  UNIQUE (tenant_id, store_id, public_id),
  UNIQUE (tenant_id, store_id, id)
);

CREATE TABLE mbox.community_activity_registrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  public_id text NOT NULL CHECK (length(public_id) BETWEEN 8 AND 128),
  activity_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  membership_id uuid,
  party_size integer NOT NULL DEFAULT 1 CHECK (party_size BETWEEN 1 AND 50),
  status text NOT NULL
    CHECK (status IN ('reserved', 'payment_pending', 'confirmed', 'waitlisted', 'cancelled', 'checked_in', 'no_show', 'refunded')),
  payment_choice text NOT NULL DEFAULT 'none'
    CHECK (payment_choice IN ('none', 'deposit', 'full')),
  payment_status text NOT NULL DEFAULT 'not_required'
    CHECK (payment_status IN ('not_required', 'pending', 'paid', 'expired', 'refunded')),
  fee_amount_minor bigint NOT NULL CHECK (fee_amount_minor >= 0),
  amount_due_minor bigint NOT NULL DEFAULT 0 CHECK (amount_due_minor >= 0),
  paid_amount_minor bigint NOT NULL DEFAULT 0 CHECK (paid_amount_minor >= 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  payment_id uuid,
  contact_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(contact_snapshot) = 'object'),
  safety_acknowledgement jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(safety_acknowledgement) = 'object'),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  registered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  payment_due_at timestamptz,
  seat_hold_expires_at timestamptz,
  refund_policy_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(refund_policy_snapshot) = 'object'),
  checked_in_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, activity_id)
    REFERENCES mbox.community_activities(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, customer_id)
    REFERENCES mbox.customers(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, membership_id)
    REFERENCES mbox.customer_memberships(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, payment_id)
    REFERENCES mbox.payments(tenant_id, store_id, id),
  CHECK (paid_amount_minor <= fee_amount_minor),
  CHECK (amount_due_minor <= fee_amount_minor),
  CHECK (
    (payment_status = 'pending' AND status = 'payment_pending'
      AND payment_choice IN ('deposit', 'full')
      AND amount_due_minor > 0 AND payment_due_at IS NOT NULL AND seat_hold_expires_at IS NOT NULL)
    OR (payment_status <> 'pending' AND status <> 'payment_pending'
      AND (payment_status IN ('paid', 'refunded') OR amount_due_minor = 0))
  ),
  UNIQUE (tenant_id, store_id, activity_id, customer_id),
  UNIQUE (tenant_id, store_id, public_id),
  UNIQUE (tenant_id, store_id, idempotency_key),
  UNIQUE (tenant_id, store_id, id)
);

CREATE TABLE mbox.member_content_cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  code text NOT NULL CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{2,63}$'),
  card_type text NOT NULL
    CHECK (card_type IN ('activity', 'presale', 'benefit', 'article', 'return_offer', 'show')),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 2 AND 120),
  summary text NOT NULL CHECK (length(btrim(summary)) BETWEEN 2 AND 400),
  image_url text,
  cta_label text NOT NULL CHECK (length(btrim(cta_label)) BETWEEN 1 AND 20),
  target_path text NOT NULL CHECK (length(btrim(target_path)) BETWEEN 1 AND 256),
  priority integer NOT NULL DEFAULT 100 CHECK (priority BETWEEN 0 AND 10000),
  audience_rule jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(audience_rule) = 'object'),
  source_ref text,
  valid_from timestamptz NOT NULL,
  valid_until timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'paused', 'retired')),
  approved_by_employee_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, approved_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  CHECK (valid_until > valid_from),
  UNIQUE (tenant_id, store_id, code),
  UNIQUE (tenant_id, store_id, id)
);

CREATE TABLE mbox.customer_followup_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  public_id text NOT NULL CHECK (length(public_id) BETWEEN 8 AND 128),
  customer_id uuid NOT NULL,
  owner_employee_id uuid NOT NULL,
  source_type text NOT NULL
    CHECK (source_type IN ('reservation', 'visit', 'complaint', 'activity', 'dormancy', 'manual')),
  source_id text,
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  recommended_action text NOT NULL CHECK (length(btrim(recommended_action)) BETWEEN 2 AND 400),
  recommended_channel text NOT NULL CHECK (recommended_channel IN ('in_person', 'wecom', 'service_account', 'phone')),
  due_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'in_progress', 'completed', 'dismissed', 'expired')),
  outcome_code text,
  outcome_note text,
  completed_by_employee_id uuid,
  completed_at timestamptz,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, customer_id)
    REFERENCES mbox.customers(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, owner_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, completed_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  CHECK ((status = 'completed') = (completed_at IS NOT NULL)),
  UNIQUE (tenant_id, store_id, public_id),
  UNIQUE (tenant_id, store_id, idempotency_key),
  UNIQUE (tenant_id, store_id, id)
);

CREATE TABLE mbox.customer_experience_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  table_session_id uuid,
  activity_registration_id uuid,
  dimension text NOT NULL
    CHECK (dimension IN ('overall', 'service', 'music', 'product', 'value', 'activity')),
  rating integer NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment text,
  recovery_required boolean NOT NULL DEFAULT false,
  recovery_task_id uuid,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  submitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, customer_id)
    REFERENCES mbox.customers(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, table_session_id)
    REFERENCES mbox.table_sessions(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, activity_registration_id)
    REFERENCES mbox.community_activity_registrations(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, recovery_task_id)
    REFERENCES mbox.service_tasks(tenant_id, store_id, id),
  CHECK (table_session_id IS NOT NULL OR activity_registration_id IS NOT NULL),
  UNIQUE (tenant_id, store_id, idempotency_key),
  UNIQUE (tenant_id, store_id, id)
);

CREATE INDEX customer_memberships_segment_idx
  ON mbox.customer_memberships (tenant_id, store_id, lifecycle_stage, level, last_visit_at DESC, id)
  WHERE status = 'active';
CREATE INDEX loyalty_point_ledger_customer_idx
  ON mbox.loyalty_point_ledger (tenant_id, store_id, customer_id, occurred_at DESC, id);
CREATE INDEX recommendation_sessions_customer_idx
  ON mbox.recommendation_sessions (tenant_id, store_id, customer_id, created_at DESC, id);
CREATE INDEX customer_experience_plans_active_idx
  ON mbox.customer_experience_plans (tenant_id, store_id, business_date, plan_state, created_at, id)
  WHERE plan_state IN ('planned', 'active', 'paused');
CREATE INDEX experience_plan_cues_due_idx
  ON mbox.experience_plan_cues (tenant_id, store_id, status, due_at, sequence_no, id)
  WHERE status IN ('pending', 'ready', 'dispatched');
CREATE INDEX checkout_upgrade_rules_active_idx
  ON mbox.checkout_upgrade_rules (tenant_id, store_id, status, priority, valid_from, valid_until, id)
  WHERE status = 'active';
CREATE INDEX checkout_upgrade_offers_active_idx
  ON mbox.checkout_upgrade_offers (tenant_id, store_id, table_session_id, customer_id, valid_until, id)
  WHERE status IN ('offered', 'selected');
CREATE INDEX community_activities_public_idx
  ON mbox.community_activities (tenant_id, store_id, status, starts_at, id)
  WHERE status IN ('published', 'full');
CREATE INDEX community_activity_registrations_customer_idx
  ON mbox.community_activity_registrations (tenant_id, store_id, customer_id, registered_at DESC, id);
CREATE INDEX community_activity_registrations_payment_due_idx
  ON mbox.community_activity_registrations (tenant_id, store_id, seat_hold_expires_at, id)
  WHERE status = 'payment_pending' AND payment_status = 'pending';
CREATE INDEX member_content_cards_active_idx
  ON mbox.member_content_cards (tenant_id, store_id, status, priority, valid_from, valid_until, id)
  WHERE status = 'published';
CREATE INDEX customer_followup_tasks_queue_idx
  ON mbox.customer_followup_tasks (tenant_id, store_id, owner_employee_id, status, due_at, priority, id)
  WHERE status IN ('open', 'in_progress');

CREATE TRIGGER loyalty_point_ledger_append_only
BEFORE UPDATE OR DELETE ON mbox.loyalty_point_ledger
FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();

CREATE TRIGGER customer_experience_feedback_append_only
BEFORE UPDATE OR DELETE ON mbox.customer_experience_feedback
FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'customer_experience_features', 'customer_memberships', 'recommendation_sessions',
    'customer_experience_plans', 'experience_plan_cues', 'checkout_upgrade_rules',
    'checkout_upgrade_offers',
    'community_activities', 'community_activity_registrations', 'member_content_cards',
    'customer_followup_tasks'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I_touch_updated_at BEFORE UPDATE ON mbox.%I FOR EACH ROW EXECUTE FUNCTION mbox.touch_updated_at()',
      table_name, table_name
    );
  END LOOP;
END $$;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'customer_experience_features', 'customer_memberships', 'loyalty_point_ledger',
    'recommendation_sessions', 'customer_experience_plans', 'experience_plan_cues',
    'checkout_upgrade_rules', 'checkout_upgrade_offers', 'community_activities',
    'community_activity_registrations', 'member_content_cards', 'customer_followup_tasks',
    'customer_experience_feedback'
  ] LOOP
    EXECUTE format('ALTER TABLE mbox.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE mbox.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_store_isolation ON mbox.%I '
      'USING (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id()) '
      'WITH CHECK (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id())',
      table_name
    );
    EXECUTE format('REVOKE ALL ON TABLE mbox.%I FROM PUBLIC', table_name);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE mbox.%I TO mbox_runtime', table_name);
  END LOOP;
END $$;

REVOKE UPDATE, DELETE ON TABLE mbox.loyalty_point_ledger FROM mbox_runtime;
REVOKE UPDATE, DELETE ON TABLE mbox.customer_experience_feedback FROM mbox_runtime;

CREATE OR REPLACE FUNCTION mbox.seed_store_customer_experience_permissions()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO mbox.staff_permission_definitions (
    tenant_id, store_id, code, name, category, description, status
  )
  SELECT NEW.tenant_id, NEW.id, permission.code, permission.name,
    permission.category, permission.description, 'active'
  FROM (VALUES
    ('customer.experience.view', '查看客户体验', 'customer_experience', '查看当前桌体验方案、节奏和客户公开偏好'),
    ('customer.experience.manage', '管理客户体验', 'customer_experience', '建立、调整和完成客户体验方案及执行节点'),
    ('customer.relationship.manage', '管理客户关系', 'customer_experience', '分配并完成客户跟进任务和关系经营动作'),
    ('loyalty.view', '查看积分账户', 'loyalty', '查看会员积分余额和不可变积分流水'),
    ('loyalty.adjust', '调整会员积分', 'loyalty', '按规则和审计要求增加或扣减会员积分'),
    ('community.activity.view', '查看社群活动', 'community', '查看超嗨部落活动、名额和报名状态'),
    ('community.activity.manage', '管理社群活动', 'community', '创建、审批、发布、签到和取消社群活动'),
    ('community.activity.publish', '发布社群活动', 'community', '复核活动费用、预付、退款和安全规则后正式发布'),
    ('customer.experience.feature.manage', '管理客户体验开关', 'customer_experience', '控制客户体验能力的影子、试点和正式启用状态')
  ) AS permission(code, name, category, description)
  ON CONFLICT (tenant_id, store_id, code) DO UPDATE
  SET name = EXCLUDED.name, category = EXCLUDED.category,
      description = EXCLUDED.description, status = 'active';
  RETURN NEW;
END;
$$;

CREATE TRIGGER stores_seed_customer_experience_permissions
  AFTER INSERT ON mbox.stores
  FOR EACH ROW EXECUTE FUNCTION mbox.seed_store_customer_experience_permissions();

INSERT INTO mbox.staff_permission_definitions (
  tenant_id, store_id, code, name, category, description, status
)
SELECT store.tenant_id, store.id, permission.code, permission.name,
  permission.category, permission.description, 'active'
FROM mbox.stores AS store
CROSS JOIN (VALUES
  ('customer.experience.view', '查看客户体验', 'customer_experience', '查看当前桌体验方案、节奏和客户公开偏好'),
  ('customer.experience.manage', '管理客户体验', 'customer_experience', '建立、调整和完成客户体验方案及执行节点'),
  ('customer.relationship.manage', '管理客户关系', 'customer_experience', '分配并完成客户跟进任务和关系经营动作'),
  ('loyalty.view', '查看积分账户', 'loyalty', '查看会员积分余额和不可变积分流水'),
  ('loyalty.adjust', '调整会员积分', 'loyalty', '按规则和审计要求增加或扣减会员积分'),
  ('community.activity.view', '查看社群活动', 'community', '查看超嗨部落活动、名额和报名状态'),
  ('community.activity.manage', '管理社群活动', 'community', '创建、审批、发布、签到和取消社群活动'),
  ('community.activity.publish', '发布社群活动', 'community', '复核活动费用、预付、退款和安全规则后正式发布'),
  ('customer.experience.feature.manage', '管理客户体验开关', 'customer_experience', '控制客户体验能力的影子、试点和正式启用状态')
) AS permission(code, name, category, description)
ON CONFLICT (tenant_id, store_id, code) DO UPDATE
SET name = EXCLUDED.name, category = EXCLUDED.category,
    description = EXCLUDED.description, status = 'active';

CREATE OR REPLACE FUNCTION mbox.seed_store_customer_experience_navigation_definition()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO mbox.staff_access_configuration_definitions (
    tenant_id, store_id, definition_kind, code, label, description,
    required_permission_codes, sort_order, config, status
  ) VALUES (
    NEW.tenant_id, NEW.id, 'navigation', 'experience', '客户体验与活动',
    '桌台体验、客户关系、会员积分和超嗨部落活动',
    ARRAY['customer.experience.view','customer.experience.manage','customer.relationship.manage','community.activity.view','community.activity.manage']::text[],
    285, '{"route":"/staff/customer-experience"}'::jsonb, 'active'
  ) ON CONFLICT (tenant_id, store_id, definition_kind, code) DO UPDATE
  SET label = EXCLUDED.label, description = EXCLUDED.description,
      required_permission_codes = EXCLUDED.required_permission_codes,
      sort_order = EXCLUDED.sort_order, config = EXCLUDED.config,
      status = 'active', updated_at = clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER stores_seed_customer_experience_navigation_definition
  AFTER INSERT ON mbox.stores
  FOR EACH ROW EXECUTE FUNCTION mbox.seed_store_customer_experience_navigation_definition();

INSERT INTO mbox.staff_access_configuration_definitions (
  tenant_id, store_id, definition_kind, code, label, description,
  required_permission_codes, sort_order, config, status
)
SELECT store.tenant_id, store.id, 'navigation', 'experience', '客户体验与活动',
  '桌台体验、客户关系、会员积分和超嗨部落活动',
  ARRAY['customer.experience.view','customer.experience.manage','customer.relationship.manage','community.activity.view','community.activity.manage']::text[],
  285, '{"route":"/staff/customer-experience"}'::jsonb, 'active'
FROM mbox.stores AS store
ON CONFLICT (tenant_id, store_id, definition_kind, code) DO UPDATE
SET label = EXCLUDED.label, description = EXCLUDED.description,
    required_permission_codes = EXCLUDED.required_permission_codes,
    sort_order = EXCLUDED.sort_order, config = EXCLUDED.config,
    status = 'active', updated_at = clock_timestamp();

COMMENT ON TABLE mbox.customer_experience_features IS
  'Store-scoped release controls for customer experience modules. Complete development does not imply production enablement.';
COMMENT ON TABLE mbox.loyalty_point_ledger IS
  'Append-only point balance facts. Current balance must reconcile to the latest ledger entry and membership snapshot.';
COMMENT ON TABLE mbox.recommendation_sessions IS
  'Immutable-at-order recommendation context linking guest intent, ranked plans and the selected product.';
COMMENT ON TABLE mbox.customer_experience_plans IS
  'One active experience promise per table session, with service intensity, show context and product snapshot.';
COMMENT ON TABLE mbox.experience_plan_cues IS
  'Cross-role orchestration cues for host, service, bar, cold kitchen, stage, manager and marketing.';
COMMENT ON TABLE mbox.checkout_upgrade_rules IS
  'Approved menu-specific mappings that may replace one unpaid cart drink with a higher-value package before checkout.';
COMMENT ON TABLE mbox.checkout_upgrade_offers IS
  'Short-lived server-priced checkout suggestions. Selection replaces the unpaid basket line and never refunds a paid drink.';
COMMENT ON TABLE mbox.community_activities IS
  'Approved Superhigh Tribe activities with capacity, fee, audience and safety facts.';
COMMENT ON TABLE mbox.customer_followup_tasks IS
  'Owned and auditable next-best-action queue for customer relationship managers.';

COMMIT;
