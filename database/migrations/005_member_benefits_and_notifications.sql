BEGIN;

CREATE TABLE mbox.customer_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  member_no text NOT NULL,
  display_name text NOT NULL,
  phone_masked text,
  identity_ref text,
  level text NOT NULL DEFAULT 'standard' CHECK (level IN ('standard', 'silver', 'gold', 'platinum')),
  tags text[] NOT NULL DEFAULT ARRAY[]::text[],
  last_visit_at timestamptz,
  visit_count integer NOT NULL DEFAULT 0 CHECK (visit_count >= 0),
  total_spend_amount_minor bigint NOT NULL DEFAULT 0 CHECK (total_spend_amount_minor >= 0),
  sales_owner_id uuid,
  service_account_bound boolean NOT NULL DEFAULT false,
  wecom_bound boolean NOT NULL DEFAULT false,
  notification_consent boolean NOT NULL DEFAULT false,
  consent_updated_at timestamptz,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'merged', 'closed')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, sales_owner_id) REFERENCES mbox.employees(tenant_id, store_id, id),
  CONSTRAINT customer_members_member_no_uq UNIQUE (tenant_id, store_id, member_no),
  CONSTRAINT customer_members_tenant_store_id_uq UNIQUE (tenant_id, store_id, id)
);

CREATE TABLE mbox.benefit_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('product_gift', 'amount_coupon', 'service', 'song')),
  description text NOT NULL,
  value_amount_minor bigint NOT NULL CHECK (value_amount_minor >= 0),
  cost_amount_minor bigint NOT NULL CHECK (cost_amount_minor >= 0),
  product_id uuid,
  validity_days integer NOT NULL CHECK (validity_days BETWEEN 1 AND 730),
  max_per_member integer NOT NULL CHECK (max_per_member BETWEEN 1 AND 100),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'retired')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, product_id) REFERENCES mbox.products(tenant_id, store_id, id),
  CONSTRAINT benefit_templates_code_uq UNIQUE (tenant_id, store_id, code),
  CONSTRAINT benefit_templates_tenant_store_id_uq UNIQUE (tenant_id, store_id, id)
);

CREATE TABLE mbox.benefit_grant_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  role_id uuid NOT NULL,
  max_cost_per_grant_amount_minor bigint NOT NULL CHECK (max_cost_per_grant_amount_minor >= 0),
  max_daily_cost_amount_minor bigint NOT NULL CHECK (max_daily_cost_amount_minor >= 0),
  can_approve boolean NOT NULL DEFAULT false,
  can_launch_campaign boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, role_id) REFERENCES mbox.roles(tenant_id, store_id, id),
  CONSTRAINT benefit_grant_policies_role_uq UNIQUE (tenant_id, store_id, role_id),
  CONSTRAINT benefit_grant_policies_tenant_store_id_uq UNIQUE (tenant_id, store_id, id)
);

CREATE TABLE mbox.benefit_policy_templates (
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  policy_id uuid NOT NULL,
  benefit_template_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, store_id, policy_id, benefit_template_id),
  FOREIGN KEY (tenant_id, store_id, policy_id) REFERENCES mbox.benefit_grant_policies(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, benefit_template_id) REFERENCES mbox.benefit_templates(tenant_id, store_id, id)
);

CREATE TABLE mbox.benefit_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  name text NOT NULL,
  segment text NOT NULL CHECK (segment IN ('dormant_30', 'dormant_60', 'vip', 'all_opted_in')),
  benefit_template_id uuid NOT NULL,
  channel text NOT NULL CHECK (channel IN ('service_account', 'wecom')),
  reason text NOT NULL,
  status text NOT NULL CHECK (status IN ('completed', 'cancelled')),
  launched_by_employee_id uuid NOT NULL,
  launched_at timestamptz NOT NULL,
  eligible_count integer NOT NULL CHECK (eligible_count >= 0),
  issued_count integer NOT NULL CHECK (issued_count >= 0),
  skipped_count integer NOT NULL CHECK (skipped_count >= 0),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, benefit_template_id) REFERENCES mbox.benefit_templates(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, launched_by_employee_id) REFERENCES mbox.employees(tenant_id, store_id, id),
  CONSTRAINT benefit_campaigns_idempotency_uq UNIQUE (tenant_id, store_id, idempotency_key),
  CONSTRAINT benefit_campaigns_tenant_store_id_uq UNIQUE (tenant_id, store_id, id)
);

CREATE TABLE mbox.benefit_grant_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  member_id uuid NOT NULL,
  benefit_template_id uuid NOT NULL,
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 100),
  reason text NOT NULL,
  source text NOT NULL CHECK (source IN ('staff', 'campaign', 'service_recovery')),
  requested_by_employee_id uuid NOT NULL,
  requested_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'granted', 'rejected')),
  decided_by_employee_id uuid,
  decided_at timestamptz,
  decision_note text,
  channel text NOT NULL CHECK (channel IN ('none', 'service_account', 'wecom')),
  campaign_id uuid,
  benefit_id uuid,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 256),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, member_id) REFERENCES mbox.customer_members(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, benefit_template_id) REFERENCES mbox.benefit_templates(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, requested_by_employee_id) REFERENCES mbox.employees(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, decided_by_employee_id) REFERENCES mbox.employees(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, campaign_id) REFERENCES mbox.benefit_campaigns(tenant_id, store_id, id),
  CONSTRAINT benefit_grant_requests_decision_shape CHECK (
    (status = 'pending' AND decided_at IS NULL AND decided_by_employee_id IS NULL) OR
    (status <> 'pending' AND decided_at IS NOT NULL AND decided_by_employee_id IS NOT NULL)
  ),
  CONSTRAINT benefit_grant_requests_idempotency_uq UNIQUE (tenant_id, store_id, idempotency_key),
  CONSTRAINT benefit_grant_requests_tenant_store_id_uq UNIQUE (tenant_id, store_id, id)
);

CREATE TABLE mbox.member_benefits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  member_id uuid NOT NULL,
  benefit_template_id uuid NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  remaining_quantity integer NOT NULL CHECK (remaining_quantity >= 0 AND remaining_quantity <= quantity),
  status text NOT NULL CHECK (status IN ('available', 'locked', 'redeemed', 'expired', 'revoked')),
  valid_from timestamptz NOT NULL,
  valid_until timestamptz NOT NULL,
  source text NOT NULL CHECK (source IN ('staff', 'campaign', 'service_recovery')),
  reason text NOT NULL,
  issued_by_employee_id uuid NOT NULL,
  approved_by_employee_id uuid,
  issued_at timestamptz NOT NULL,
  grant_request_id uuid NOT NULL,
  campaign_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, member_id) REFERENCES mbox.customer_members(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, benefit_template_id) REFERENCES mbox.benefit_templates(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, issued_by_employee_id) REFERENCES mbox.employees(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, approved_by_employee_id) REFERENCES mbox.employees(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, grant_request_id) REFERENCES mbox.benefit_grant_requests(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, campaign_id) REFERENCES mbox.benefit_campaigns(tenant_id, store_id, id),
  CONSTRAINT member_benefits_validity_check CHECK (valid_until > valid_from),
  CONSTRAINT member_benefits_request_uq UNIQUE (tenant_id, store_id, grant_request_id),
  CONSTRAINT member_benefits_tenant_store_id_uq UNIQUE (tenant_id, store_id, id)
);

ALTER TABLE mbox.benefit_grant_requests ADD CONSTRAINT benefit_grant_requests_benefit_fk
  FOREIGN KEY (tenant_id, store_id, benefit_id) REFERENCES mbox.member_benefits(tenant_id, store_id, id);

CREATE TABLE mbox.customer_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  member_id uuid NOT NULL,
  benefit_id uuid NOT NULL,
  campaign_id uuid,
  channel text NOT NULL CHECK (channel IN ('service_account', 'wecom')),
  status text NOT NULL CHECK (status IN ('queued', 'sent', 'failed', 'skipped')),
  template_code text NOT NULL,
  content_parameters jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(content_parameters) = 'object'),
  queued_at timestamptz NOT NULL,
  sent_at timestamptz,
  failure_reason text,
  provider_message_id text,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, member_id) REFERENCES mbox.customer_members(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, benefit_id) REFERENCES mbox.member_benefits(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, campaign_id) REFERENCES mbox.benefit_campaigns(tenant_id, store_id, id),
  CONSTRAINT customer_notifications_benefit_channel_uq UNIQUE (tenant_id, store_id, benefit_id, channel),
  CONSTRAINT customer_notifications_tenant_store_id_uq UNIQUE (tenant_id, store_id, id)
);

CREATE INDEX member_benefits_account_idx ON mbox.member_benefits
  (tenant_id, store_id, member_id, status, valid_until);
CREATE INDEX benefit_grant_requests_pending_idx ON mbox.benefit_grant_requests
  (tenant_id, store_id, requested_at) WHERE status = 'pending';
CREATE INDEX customer_notifications_due_idx ON mbox.customer_notifications
  (tenant_id, store_id, next_attempt_at, queued_at) WHERE status = 'queued';

CREATE TRIGGER customer_members_touch_version BEFORE UPDATE ON mbox.customer_members
FOR EACH ROW EXECUTE FUNCTION mbox.touch_versioned_row();
CREATE TRIGGER benefit_templates_touch_version BEFORE UPDATE ON mbox.benefit_templates
FOR EACH ROW EXECUTE FUNCTION mbox.touch_versioned_row();
CREATE TRIGGER benefit_grant_policies_touch_version BEFORE UPDATE ON mbox.benefit_grant_policies
FOR EACH ROW EXECUTE FUNCTION mbox.touch_versioned_row();
CREATE TRIGGER benefit_campaigns_touch_version BEFORE UPDATE ON mbox.benefit_campaigns
FOR EACH ROW EXECUTE FUNCTION mbox.touch_versioned_row();
CREATE TRIGGER benefit_grant_requests_touch_version BEFORE UPDATE ON mbox.benefit_grant_requests
FOR EACH ROW EXECUTE FUNCTION mbox.touch_versioned_row();
CREATE TRIGGER member_benefits_touch_version BEFORE UPDATE ON mbox.member_benefits
FOR EACH ROW EXECUTE FUNCTION mbox.touch_versioned_row();
CREATE TRIGGER customer_notifications_touch_version BEFORE UPDATE ON mbox.customer_notifications
FOR EACH ROW EXECUTE FUNCTION mbox.touch_versioned_row();

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'customer_members', 'benefit_templates', 'benefit_grant_policies',
    'benefit_policy_templates', 'benefit_campaigns', 'benefit_grant_requests',
    'member_benefits', 'customer_notifications'
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

COMMENT ON TABLE mbox.member_benefits IS 'Member entitlement ledger. Issuance, lock, redemption, expiry and revocation remain auditable business facts.';
COMMENT ON TABLE mbox.customer_notifications IS 'Provider-neutral notification outbox for service-account and WeCom delivery adapters.';

COMMIT;
