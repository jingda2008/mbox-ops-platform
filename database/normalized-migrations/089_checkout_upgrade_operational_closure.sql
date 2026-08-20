BEGIN;

-- Checkout-upgrade releases are immutable versions.  Approval no longer
-- publishes a rule; a third, distinct operator performs the release.
ALTER TABLE mbox.checkout_upgrade_rules
  ADD COLUMN published_by_employee_id uuid,
  ADD COLUMN published_at timestamptz,
  ADD COLUMN publication_mode text NOT NULL DEFAULT 'separated'
    CHECK (publication_mode IN ('legacy_import','separated')),
  ADD COLUMN approval_reason text,
  ADD COLUMN publication_reason text,
  ADD CONSTRAINT checkout_upgrade_rules_publisher_fk
    FOREIGN KEY (tenant_id,store_id,published_by_employee_id)
    REFERENCES mbox.employees(tenant_id,store_id,id);

UPDATE mbox.checkout_upgrade_rules
SET publication_mode='legacy_import',
    published_by_employee_id=CASE WHEN status='active' THEN approved_by_employee_id ELSE NULL END,
    published_at=CASE WHEN status='active' THEN approved_at ELSE NULL END;

ALTER TABLE mbox.checkout_upgrade_rules
  DROP CONSTRAINT checkout_upgrade_rules_status_check,
  DROP CONSTRAINT checkout_upgrade_rules_maker_checker_check,
  DROP CONSTRAINT checkout_upgrade_rules_tenant_id_store_id_code_key,
  ADD CONSTRAINT checkout_upgrade_rules_status_check
    CHECK (status IN ('draft','approved','active','paused','retired')),
  ADD CONSTRAINT checkout_upgrade_rules_release_shape_ck CHECK (
    publication_mode='legacy_import'
    OR (status='draft' AND drafted_by_employee_id IS NOT NULL
      AND approved_by_employee_id IS NULL AND approved_at IS NULL
      AND published_by_employee_id IS NULL AND published_at IS NULL
      AND valid_from IS NULL AND valid_until IS NULL)
    OR (status='approved' AND drafted_by_employee_id IS NOT NULL
      AND approved_by_employee_id IS NOT NULL AND approved_at IS NOT NULL
      AND approved_by_employee_id<>drafted_by_employee_id
      AND published_by_employee_id IS NULL AND published_at IS NULL
      AND valid_from IS NULL AND valid_until IS NULL)
    OR (status IN ('active','retired') AND drafted_by_employee_id IS NOT NULL
      AND approved_by_employee_id IS NOT NULL AND approved_at IS NOT NULL
      AND published_by_employee_id IS NOT NULL AND published_at IS NOT NULL
      AND approved_by_employee_id<>drafted_by_employee_id
      AND published_by_employee_id<>drafted_by_employee_id
      AND published_by_employee_id<>approved_by_employee_id
      AND valid_from IS NOT NULL)
  ),
  ADD CONSTRAINT checkout_upgrade_rules_code_revision_uq
    UNIQUE (tenant_id,store_id,code,revision);

CREATE UNIQUE INDEX checkout_upgrade_rules_one_active_code_uq
  ON mbox.checkout_upgrade_rules(tenant_id,store_id,code)
  WHERE status='active';

CREATE OR REPLACE FUNCTION mbox.protect_checkout_upgrade_rule_release()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.publication_mode='separated' AND NEW.status<>'draft' THEN
      RAISE EXCEPTION 'checkout upgrade rule must be created as draft' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN
    IF OLD.publication_mode='separated' THEN
      RAISE EXCEPTION 'versioned checkout upgrade rules are append-only' USING ERRCODE='23514';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.publication_mode='legacy_import' THEN RETURN NEW; END IF;
  IF NEW.publication_mode<>OLD.publication_mode OR ROW(
    NEW.tenant_id,NEW.store_id,NEW.code,NEW.revision,NEW.name,
    NEW.source_product_id,NEW.target_product_id,NEW.minimum_party_size,
    NEW.maximum_party_size,NEW.occasion_tags,NEW.alcohol_preference_tags,
    NEW.prompt_title,NEW.prompt_body,NEW.call_to_action,NEW.priority,
    NEW.offer_valid_minutes,NEW.minimum_gross_margin_basis_points,
    NEW.configuration,NEW.drafted_by_employee_id,NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.tenant_id,OLD.store_id,OLD.code,OLD.revision,OLD.name,
    OLD.source_product_id,OLD.target_product_id,OLD.minimum_party_size,
    OLD.maximum_party_size,OLD.occasion_tags,OLD.alcohol_preference_tags,
    OLD.prompt_title,OLD.prompt_body,OLD.call_to_action,OLD.priority,
    OLD.offer_valid_minutes,OLD.minimum_gross_margin_basis_points,
    OLD.configuration,OLD.drafted_by_employee_id,OLD.created_at
  ) THEN
    RAISE EXCEPTION 'checkout upgrade rule version facts are immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.status='draft' AND NEW.status='approved' THEN
    IF NEW.approved_by_employee_id IS NULL OR NEW.approved_by_employee_id=OLD.drafted_by_employee_id
      OR NEW.approved_at IS NULL OR NEW.published_by_employee_id IS NOT NULL
      OR NEW.published_at IS NOT NULL OR NEW.valid_from IS NOT NULL OR NEW.valid_until IS NOT NULL THEN
      RAISE EXCEPTION 'checkout upgrade approval requires an independent approver' USING ERRCODE='23514';
    END IF;
    IF NEW.approval_reason IS NULL OR NEW.publication_reason IS DISTINCT FROM OLD.publication_reason THEN
      RAISE EXCEPTION 'checkout upgrade approval reason is required' USING ERRCODE='23514';
    END IF;
  ELSIF OLD.status='approved' AND NEW.status='active' THEN
    IF NEW.approved_by_employee_id IS DISTINCT FROM OLD.approved_by_employee_id
      OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
      OR NEW.published_by_employee_id IS NULL
      OR NEW.published_by_employee_id IN (OLD.drafted_by_employee_id,OLD.approved_by_employee_id)
      OR NEW.published_at IS NULL OR NEW.valid_from IS NULL THEN
      RAISE EXCEPTION 'checkout upgrade publication requires a third independent publisher' USING ERRCODE='23514';
    END IF;
    IF NEW.approval_reason IS DISTINCT FROM OLD.approval_reason OR NEW.publication_reason IS NULL THEN
      RAISE EXCEPTION 'checkout upgrade publication reason is required' USING ERRCODE='23514';
    END IF;
  ELSIF OLD.status='active' AND NEW.status='retired' THEN
    IF NEW.approved_by_employee_id IS DISTINCT FROM OLD.approved_by_employee_id
      OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
      OR NEW.published_by_employee_id IS DISTINCT FROM OLD.published_by_employee_id
      OR NEW.published_at IS DISTINCT FROM OLD.published_at
      OR NEW.valid_from IS DISTINCT FROM OLD.valid_from
      OR NEW.valid_until IS NULL
      OR (OLD.valid_until IS NOT NULL AND NEW.valid_until>OLD.valid_until) THEN
      RAISE EXCEPTION 'released checkout upgrade rule may only be retired at a cut-over' USING ERRCODE='23514';
    END IF;
    IF NEW.approval_reason IS DISTINCT FROM OLD.approval_reason
      OR NEW.publication_reason IS DISTINCT FROM OLD.publication_reason THEN
      RAISE EXCEPTION 'released checkout upgrade reasons are immutable' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.status<>OLD.status
    OR NEW.approved_by_employee_id IS DISTINCT FROM OLD.approved_by_employee_id
    OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
    OR NEW.published_by_employee_id IS DISTINCT FROM OLD.published_by_employee_id
    OR NEW.published_at IS DISTINCT FROM OLD.published_at
    OR NEW.valid_from IS DISTINCT FROM OLD.valid_from
    OR NEW.valid_until IS DISTINCT FROM OLD.valid_until
    OR NEW.approval_reason IS DISTINCT FROM OLD.approval_reason
    OR NEW.publication_reason IS DISTINCT FROM OLD.publication_reason THEN
    RAISE EXCEPTION 'invalid checkout upgrade rule release transition' USING ERRCODE='23514';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$;

CREATE TRIGGER checkout_upgrade_rule_release_protect
  BEFORE INSERT OR UPDATE OR DELETE ON mbox.checkout_upgrade_rules
  FOR EACH ROW EXECUTE FUNCTION mbox.protect_checkout_upgrade_rule_release();

ALTER TABLE mbox.checkout_upgrade_offers
  ADD COLUMN rule_revision integer NOT NULL DEFAULT 1 CHECK (rule_revision>0),
  ADD COLUMN converted_order_item_id uuid,
  ADD CONSTRAINT checkout_upgrade_offer_converted_item_fk
    FOREIGN KEY (tenant_id,store_id,converted_order_id,converted_order_item_id)
    REFERENCES mbox.order_items(tenant_id,store_id,order_id,id);

UPDATE mbox.checkout_upgrade_offers offer
SET rule_revision=rule.revision,
    converted_order_item_id=(
      SELECT item.id FROM mbox.order_items item
      WHERE item.tenant_id=offer.tenant_id AND item.store_id=offer.store_id
        AND item.order_id=offer.converted_order_id
        AND item.product_id=offer.target_product_id
        AND item.parent_order_item_id IS NULL
      ORDER BY item.id LIMIT 1
    )
FROM mbox.checkout_upgrade_rules rule
WHERE rule.tenant_id=offer.tenant_id AND rule.store_id=offer.store_id
  AND rule.id=offer.rule_id;

-- Historical converted rows without an unambiguous target line are not
-- promoted into authoritative attribution.
UPDATE mbox.checkout_upgrade_offers
SET status='cancelled',converted_order_id=NULL,converted_order_item_id=NULL,
  converted_at=NULL,updated_at=clock_timestamp()
WHERE status='converted' AND converted_order_item_id IS NULL;

ALTER TABLE mbox.checkout_upgrade_offers
  ADD CONSTRAINT checkout_upgrade_offer_converted_item_shape_ck CHECK (
    (status='converted' AND converted_order_item_id IS NOT NULL)
    OR (status<>'converted' AND converted_order_item_id IS NULL)
  );

CREATE TABLE mbox.checkout_upgrade_offer_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  public_id text NOT NULL CHECK (length(public_id) BETWEEN 8 AND 128),
  offer_id uuid NOT NULL,
  event_type text NOT NULL CHECK (
    event_type IN ('offered','viewed','declined','accepted','converted','invalidated')
  ),
  actor_type text NOT NULL CHECK (actor_type IN ('guest','system')),
  actor_customer_id uuid,
  reason_code text CHECK (reason_code IS NULL OR reason_code IN (
    'kept_original','not_needed','expired','price_changed','structure_changed',
    'capacity_unavailable','order_failed','rule_replaced'
  )),
  order_id uuid,
  order_item_id uuid,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 160),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
  FOREIGN KEY (tenant_id,store_id,offer_id)
    REFERENCES mbox.checkout_upgrade_offers(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,actor_customer_id)
    REFERENCES mbox.customers(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,order_id,order_item_id)
    REFERENCES mbox.order_items(tenant_id,store_id,order_id,id),
  CHECK (
    (actor_type='guest' AND actor_customer_id IS NOT NULL)
    OR (actor_type='system' AND actor_customer_id IS NULL)
  ),
  CHECK ((order_id IS NULL)=(order_item_id IS NULL)),
  CHECK ((event_type='converted')=(order_id IS NOT NULL)),
  UNIQUE (tenant_id,store_id,public_id),
  UNIQUE (tenant_id,store_id,offer_id,idempotency_key),
  UNIQUE (tenant_id,store_id,id)
);

CREATE INDEX checkout_upgrade_offer_events_timeline_idx
  ON mbox.checkout_upgrade_offer_events(tenant_id,store_id,offer_id,occurred_at,id);
CREATE TRIGGER checkout_upgrade_offer_events_append_only
  BEFORE UPDATE OR DELETE ON mbox.checkout_upgrade_offer_events
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();

ALTER TABLE mbox.guest_service_request_groups
  ADD COLUMN related_order_id uuid,
  ADD CONSTRAINT guest_service_request_related_order_fk
    FOREIGN KEY (tenant_id,store_id,related_order_id)
    REFERENCES mbox.orders(tenant_id,store_id,id),
  ADD CONSTRAINT guest_service_request_related_order_kind_ck CHECK (
    related_order_id IS NULL OR request_type='complaint'
  );

-- Capacity configuration was already authoritative for runtime holds, but 060
-- had no accountable maker-checker-publisher release workflow.
ALTER TABLE mbox.fulfillment_capacity_policy_versions
  ADD COLUMN drafted_by_employee_id uuid,
  ADD COLUMN approved_by_employee_id uuid,
  ADD COLUMN approved_at timestamptz,
  ADD COLUMN published_by_employee_id uuid,
  ADD COLUMN publication_mode text NOT NULL DEFAULT 'separated'
    CHECK (publication_mode IN ('legacy_import','separated')),
  ADD COLUMN reason text NOT NULL DEFAULT '历史产能策略',
  ADD CONSTRAINT fulfillment_capacity_policy_drafter_fk
    FOREIGN KEY (tenant_id,store_id,drafted_by_employee_id)
    REFERENCES mbox.employees(tenant_id,store_id,id),
  ADD CONSTRAINT fulfillment_capacity_policy_approver_fk
    FOREIGN KEY (tenant_id,store_id,approved_by_employee_id)
    REFERENCES mbox.employees(tenant_id,store_id,id),
  ADD CONSTRAINT fulfillment_capacity_policy_publisher_fk
    FOREIGN KEY (tenant_id,store_id,published_by_employee_id)
    REFERENCES mbox.employees(tenant_id,store_id,id);

UPDATE mbox.fulfillment_capacity_policy_versions
SET publication_mode='legacy_import',reason='迁移前既有产能策略';

ALTER TABLE mbox.fulfillment_capacity_policy_versions
  DROP CONSTRAINT fulfillment_capacity_policy_versions_status_check,
  DROP CONSTRAINT fulfillment_capacity_policy_versions_check,
  ADD CONSTRAINT fulfillment_capacity_policy_versions_status_check
    CHECK (status IN ('draft','approved','published','retired')),
  ADD CONSTRAINT fulfillment_capacity_policy_release_shape_ck CHECK (
    publication_mode='legacy_import'
    OR (status='draft' AND drafted_by_employee_id IS NOT NULL
      AND approved_by_employee_id IS NULL AND approved_at IS NULL
      AND published_by_employee_id IS NULL AND published_at IS NULL AND retired_at IS NULL)
    OR (status='approved' AND drafted_by_employee_id IS NOT NULL
      AND approved_by_employee_id IS NOT NULL AND approved_at IS NOT NULL
      AND approved_by_employee_id<>drafted_by_employee_id
      AND published_by_employee_id IS NULL AND published_at IS NULL AND retired_at IS NULL)
    OR (status IN ('published','retired') AND drafted_by_employee_id IS NOT NULL
      AND approved_by_employee_id IS NOT NULL AND approved_at IS NOT NULL
      AND published_by_employee_id IS NOT NULL AND published_at IS NOT NULL
      AND approved_by_employee_id<>drafted_by_employee_id
      AND published_by_employee_id<>drafted_by_employee_id
      AND published_by_employee_id<>approved_by_employee_id
      AND (status='published' OR retired_at IS NOT NULL))
  );

CREATE OR REPLACE FUNCTION mbox.manage_fulfillment_capacity_policy_version()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'draft' THEN RAISE EXCEPTION 'capacity policy must be created as draft' USING ERRCODE='23514'; END IF;
    IF NEW.publication_mode='separated' AND NEW.drafted_by_employee_id IS NULL THEN
      RAISE EXCEPTION 'capacity policy drafter is required' USING ERRCODE='23514';
    END IF;
    NEW.approved_by_employee_id:=NULL; NEW.approved_at:=NULL;
    NEW.published_by_employee_id:=NULL; NEW.published_at:=NULL; NEW.retired_at:=NULL;
    NEW.updated_at:=clock_timestamp(); RETURN NEW;
  END IF;
  IF NEW.id<>OLD.id OR NEW.tenant_id<>OLD.tenant_id OR NEW.store_id<>OLD.store_id
    OR NEW.station_code<>OLD.station_code OR NEW.policy_version<>OLD.policy_version
    OR NEW.drafted_by_employee_id IS DISTINCT FROM OLD.drafted_by_employee_id
    OR NEW.reason IS DISTINCT FROM OLD.reason OR NEW.publication_mode<>OLD.publication_mode THEN
    RAISE EXCEPTION 'capacity policy identity and version are immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.publication_mode='legacy_import' THEN
    IF NOT (NEW.status=OLD.status OR (OLD.status='published' AND NEW.status='retired')) THEN
      RAISE EXCEPTION 'invalid legacy capacity policy transition' USING ERRCODE='23514';
    END IF;
  ELSIF OLD.status='draft' AND NEW.status='approved' THEN
    IF NEW.approved_by_employee_id IS NULL OR NEW.approved_by_employee_id=OLD.drafted_by_employee_id
      OR NEW.approved_at IS NULL THEN
      RAISE EXCEPTION 'capacity approval requires an independent approver' USING ERRCODE='23514';
    END IF;
  ELSIF OLD.status='approved' AND NEW.status='published' THEN
    IF NEW.approved_by_employee_id IS DISTINCT FROM OLD.approved_by_employee_id
      OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
      OR NEW.published_by_employee_id IS NULL
      OR NEW.published_by_employee_id IN (OLD.drafted_by_employee_id,OLD.approved_by_employee_id) THEN
      RAISE EXCEPTION 'capacity publication requires a third independent publisher' USING ERRCODE='23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM mbox.fulfillment_capacity_windows window_row
      WHERE window_row.tenant_id=NEW.tenant_id AND window_row.store_id=NEW.store_id
        AND window_row.policy_version_id=NEW.id) THEN
      RAISE EXCEPTION 'published capacity policy requires at least one time window' USING ERRCODE='23514';
    END IF;
    NEW.published_at:=clock_timestamp(); NEW.retired_at:=NULL;
  ELSIF OLD.status='published' AND NEW.status='retired' THEN
    NEW.published_at:=OLD.published_at; NEW.retired_at:=clock_timestamp();
  ELSIF NEW.status<>OLD.status
    OR NEW.approved_by_employee_id IS DISTINCT FROM OLD.approved_by_employee_id
    OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
    OR NEW.published_by_employee_id IS DISTINCT FROM OLD.published_by_employee_id
    OR NEW.published_at IS DISTINCT FROM OLD.published_at
    OR NEW.retired_at IS DISTINCT FROM OLD.retired_at THEN
    RAISE EXCEPTION 'invalid capacity policy transition' USING ERRCODE='23514';
  END IF;
  NEW.updated_at:=clock_timestamp(); RETURN NEW;
END $$;

-- Permissions are separate so store owners can delegate configuration without
-- changing role names or trusting the client UI.
CREATE OR REPLACE FUNCTION mbox.seed_store_checkout_upgrade_permissions()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO mbox.staff_permission_definitions(
    tenant_id,store_id,code,name,category,description,status
  ) SELECT NEW.tenant_id,NEW.id,p.code,p.name,'customer_experience',p.description,'active'
  FROM (VALUES
    ('checkout.upgrade.rule.view','查看付款前升级规则','查看不可变规则版本、发布状态与经营结果'),
    ('checkout.upgrade.rule.draft','起草付款前升级规则','建立新的不可变规则版本，不可自行审批或发布'),
    ('checkout.upgrade.rule.approve','审批付款前升级规则','独立复核商品、价格、毛利和履约条件，不直接生效'),
    ('checkout.upgrade.rule.publish','发布付款前升级规则','第三人发布已审批规则或按历史版本建立回滚草稿'),
    ('fulfillment.capacity.view','查看履约产能','查看吧台、厨房和收银强类型产能版本与时间窗'),
    ('fulfillment.capacity.draft','起草履约产能','建立产能版本及明确时间窗'),
    ('fulfillment.capacity.approve','审批履约产能','独立复核产能上限和时间窗'),
    ('fulfillment.capacity.publish','发布履约产能','第三人发布已审批产能版本')
  ) p(code,name,description)
  ON CONFLICT (tenant_id,store_id,code) DO UPDATE SET
    name=EXCLUDED.name,category=EXCLUDED.category,description=EXCLUDED.description,status='active';
  RETURN NEW;
END $$;

INSERT INTO mbox.staff_permission_definitions(
  tenant_id,store_id,code,name,category,description,status
)
SELECT store.tenant_id,store.id,p.code,p.name,'customer_experience',p.description,'active'
FROM mbox.stores store CROSS JOIN (VALUES
  ('checkout.upgrade.rule.view','查看付款前升级规则','查看不可变规则版本、发布状态与经营结果'),
  ('checkout.upgrade.rule.draft','起草付款前升级规则','建立新的不可变规则版本，不可自行审批或发布'),
  ('checkout.upgrade.rule.approve','审批付款前升级规则','独立复核商品、价格、毛利和履约条件，不直接生效'),
  ('checkout.upgrade.rule.publish','发布付款前升级规则','第三人发布已审批规则或按历史版本建立回滚草稿'),
  ('fulfillment.capacity.view','查看履约产能','查看吧台、厨房和收银强类型产能版本与时间窗'),
  ('fulfillment.capacity.draft','起草履约产能','建立产能版本及明确时间窗'),
  ('fulfillment.capacity.approve','审批履约产能','独立复核产能上限和时间窗'),
  ('fulfillment.capacity.publish','发布履约产能','第三人发布已审批产能版本')
) p(code,name,description)
ON CONFLICT (tenant_id,store_id,code) DO UPDATE SET
  name=EXCLUDED.name,category=EXCLUDED.category,description=EXCLUDED.description,status='active';

INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id)
SELECT role.tenant_id,role.store_id,role.id,permission.id
FROM mbox.roles role JOIN mbox.staff_permission_definitions permission
  ON permission.tenant_id=role.tenant_id AND permission.store_id=role.store_id
WHERE role.status='active' AND (
  (role.code='MANAGER' AND permission.code IN (
    'checkout.upgrade.rule.view','checkout.upgrade.rule.draft',
    'fulfillment.capacity.view','fulfillment.capacity.draft'))
  OR (role.code='OPS_LEAD' AND permission.code IN (
    'checkout.upgrade.rule.view','checkout.upgrade.rule.approve',
    'fulfillment.capacity.view','fulfillment.capacity.approve'))
  OR (role.code='OWNER' AND permission.code IN (
    'checkout.upgrade.rule.view','checkout.upgrade.rule.publish',
    'fulfillment.capacity.view','fulfillment.capacity.publish'))
) ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION mbox.seed_checkout_upgrade_role_permissions()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id)
  SELECT NEW.tenant_id,NEW.store_id,NEW.id,permission.id
  FROM mbox.staff_permission_definitions permission
  WHERE permission.tenant_id=NEW.tenant_id AND permission.store_id=NEW.store_id
    AND ((NEW.code='MANAGER' AND permission.code IN (
      'checkout.upgrade.rule.view','checkout.upgrade.rule.draft','fulfillment.capacity.view','fulfillment.capacity.draft'))
      OR (NEW.code='OPS_LEAD' AND permission.code IN (
      'checkout.upgrade.rule.view','checkout.upgrade.rule.approve','fulfillment.capacity.view','fulfillment.capacity.approve'))
      OR (NEW.code='OWNER' AND permission.code IN (
      'checkout.upgrade.rule.view','checkout.upgrade.rule.publish','fulfillment.capacity.view','fulfillment.capacity.publish')))
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;

CREATE TRIGGER roles_seed_checkout_upgrade_permissions
  AFTER INSERT ON mbox.roles
  FOR EACH ROW EXECUTE FUNCTION mbox.seed_checkout_upgrade_role_permissions();

ALTER TABLE mbox.checkout_upgrade_offer_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.checkout_upgrade_offer_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.checkout_upgrade_offer_events
  USING (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())
  WITH CHECK (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
GRANT SELECT,INSERT ON TABLE mbox.checkout_upgrade_offer_events TO mbox_runtime;

COMMENT ON TABLE mbox.checkout_upgrade_offer_events IS
  'Append-only, strongly typed offer lifecycle evidence; display JSON and free-form telemetry never determine checkout.';
COMMENT ON COLUMN mbox.checkout_upgrade_rules.revision IS
  'Immutable business version within a rule code. Rollback clones a historical version into a new revision.';
COMMENT ON COLUMN mbox.checkout_upgrade_offers.converted_order_item_id IS
  'Authoritative target order line created by the accepted upgrade; payment and refund attribution joins strong commerce facts.';
COMMENT ON COLUMN mbox.guest_service_request_groups.related_order_id IS
  'Optional customer-selected order for a complaint; never inferred from time, amount or free JSON.';

UPDATE mbox.customer_experience_features
SET rollout_state='disabled',effective_until=NULL,
  reason='付款前升级089经营闭环候选仍待同一提交CI、真机、真实岗位和营业影子验收',
  updated_at=clock_timestamp()
WHERE feature_code='checkout_upgrade';

UPDATE mbox.normalized_schema_metadata
SET schema_version='089',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
