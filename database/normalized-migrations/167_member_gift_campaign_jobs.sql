BEGIN;
-- Empty, default-closed campaign definitions and recoverable delivery facts.
-- No existing card/benefit is backfilled, issued, revoked or reclassified.
CREATE TABLE mbox.member_gift_campaign_versions(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,
  code text NOT NULL CHECK(code ~ '^[A-Z][A-Z0-9_]{1,39}$'),version integer NOT NULL CHECK(version>0),
  name text NOT NULL CHECK(length(btrim(name)) BETWEEN 2 AND 120),
  trigger_kind text NOT NULL CHECK(trigger_kind IN('card_entry','targeted')),card_project_id uuid,
  CHECK((trigger_kind='card_entry')=(card_project_id IS NOT NULL)),
  minimum_tier text CHECK(minimum_tier IN('member','silver','gold','black')),
  card_codes text[] NOT NULL DEFAULT '{}',card_match text NOT NULL CHECK(card_match IN('any','all')),
  tier_and_cards text NOT NULL CHECK(tier_and_cards IN('and','or')),
  CHECK(minimum_tier IS NOT NULL OR cardinality(card_codes)>0),CHECK(cardinality(card_codes)<=100),
  quantity_per_customer integer NOT NULL CHECK(quantity_per_customer BETWEEN 1 AND 100),
  maximum_quantity integer NOT NULL CHECK(maximum_quantity BETWEEN 1 AND 1000000),
  maximum_daily_quantity integer NOT NULL CHECK(maximum_daily_quantity BETWEEN 1 AND maximum_quantity),
  CHECK(quantity_per_customer<=maximum_daily_quantity),
  maximum_cost_minor bigint NOT NULL CHECK(maximum_cost_minor BETWEEN 0 AND 9007199254740991),
  maximum_daily_cost_minor bigint NOT NULL CHECK(maximum_daily_cost_minor BETWEEN 0 AND maximum_cost_minor),
  maximum_unit_cost_minor bigint NOT NULL CHECK(maximum_unit_cost_minor BETWEEN 0 AND 9007199254740991),
  currency char(3) NOT NULL DEFAULT 'CNY' CHECK(currency='CNY'),
  budget_date_basis text NOT NULL CHECK(budget_date_basis IN('natural','business')),
  budget_day_start_minute integer NOT NULL CHECK(budget_day_start_minute BETWEEN 0 AND 1439),
  CHECK(budget_date_basis<>'natural' OR budget_day_start_minute=0),
  available_from timestamptz NOT NULL,available_until timestamptz NOT NULL CHECK(available_until>available_from),
  coupon_calendar_version_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK(status IN('draft','approved','published','stopped')),
  created_by_employee_id uuid NOT NULL,approved_by_employee_id uuid,published_by_employee_id uuid,stopped_by_employee_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),approved_at timestamptz,published_at timestamptz,stopped_at timestamptz,
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 2 AND 500),
  request_key text NOT NULL CHECK(length(request_key) BETWEEN 8 AND 128),request_fingerprint char(64) NOT NULL,
  CHECK((status='draft')=(approved_by_employee_id IS NULL)),
  CHECK((approved_by_employee_id IS NULL)=(approved_at IS NULL)),
  CHECK((status IN('draft','approved'))=(published_by_employee_id IS NULL)),
  CHECK((published_by_employee_id IS NULL)=(published_at IS NULL)),
  CHECK((status='stopped')=(stopped_by_employee_id IS NOT NULL)),CHECK((stopped_by_employee_id IS NULL)=(stopped_at IS NULL)),
  CHECK(approved_by_employee_id IS DISTINCT FROM created_by_employee_id),
  CHECK(published_by_employee_id IS DISTINCT FROM created_by_employee_id),
  CHECK(published_by_employee_id IS NULL OR published_by_employee_id<>approved_by_employee_id),
  UNIQUE(tenant_id,store_id,id),UNIQUE(tenant_id,store_id,id,code),UNIQUE(tenant_id,store_id,code,version),UNIQUE(tenant_id,store_id,request_key),
  FOREIGN KEY(tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
  FOREIGN KEY(tenant_id,store_id,card_project_id) REFERENCES mbox.member_card_projects(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,coupon_calendar_version_id) REFERENCES mbox.coupon_calendar_versions(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,created_by_employee_id) REFERENCES mbox.employees(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,approved_by_employee_id) REFERENCES mbox.employees(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,published_by_employee_id) REFERENCES mbox.employees(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,stopped_by_employee_id) REFERENCES mbox.employees(tenant_id,store_id,id)
);
CREATE UNIQUE INDEX member_gift_campaign_one_published ON mbox.member_gift_campaign_versions(tenant_id,store_id,code) WHERE status='published';
CREATE TABLE mbox.member_gift_campaign_products(
  tenant_id uuid NOT NULL,store_id uuid NOT NULL,campaign_version_id uuid NOT NULL,product_id uuid NOT NULL,
  unit_cost_minor bigint NOT NULL CHECK(unit_cost_minor BETWEEN 0 AND 9007199254740991),
  unit_price_minor bigint NOT NULL CHECK(unit_price_minor BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY(tenant_id,store_id,campaign_version_id,product_id),
  FOREIGN KEY(tenant_id,store_id,campaign_version_id) REFERENCES mbox.member_gift_campaign_versions(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,product_id) REFERENCES mbox.products(tenant_id,store_id,id)
);
CREATE TABLE mbox.member_gift_delivery_jobs(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,
  campaign_version_id uuid NOT NULL,campaign_code text NOT NULL,cycle_key text NOT NULL CHECK(length(cycle_key) BETWEEN 1 AND 100),
  customer_id uuid NOT NULL,source_application_id uuid,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','blocked','issued','cancelled','duplicate')),
  benefit_id uuid,budget_date date,quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 100),
  estimated_cost_minor bigint CHECK(estimated_cost_minor BETWEEN 0 AND 9007199254740991),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_error_code text CHECK(length(last_error_code)<=100),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),completed_at timestamptz,
  CHECK((status='issued')=(benefit_id IS NOT NULL)),
  CHECK(status<>'issued' OR (estimated_cost_minor IS NOT NULL AND budget_date IS NOT NULL AND completed_at IS NOT NULL)),
  CHECK((status IN('issued','cancelled','duplicate'))=(completed_at IS NOT NULL)),
  UNIQUE(tenant_id,store_id,id),UNIQUE(tenant_id,store_id,campaign_code,cycle_key,customer_id),UNIQUE(tenant_id,store_id,benefit_id),
  FOREIGN KEY(tenant_id,store_id,campaign_version_id,campaign_code) REFERENCES mbox.member_gift_campaign_versions(tenant_id,store_id,id,code),
  FOREIGN KEY(tenant_id,store_id,customer_id) REFERENCES mbox.customers(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,source_application_id) REFERENCES mbox.member_card_applications(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,benefit_id) REFERENCES mbox.benefits(tenant_id,store_id,id)
);
CREATE INDEX member_gift_jobs_due ON mbox.member_gift_delivery_jobs(tenant_id,store_id,next_attempt_at,id) WHERE status IN('pending','blocked');
CREATE INDEX member_gift_jobs_budget ON mbox.member_gift_delivery_jobs(tenant_id,store_id,campaign_code,budget_date) WHERE status='issued';
CREATE INDEX member_card_approved_gift_discovery ON mbox.member_card_applications(tenant_id,store_id,project_id,resolved_at,id) WHERE status='approved';
DO $$ DECLARE name text; BEGIN
  FOREACH name IN ARRAY ARRAY['member_gift_campaign_versions','member_gift_campaign_products','member_gift_delivery_jobs'] LOOP
    EXECUTE format('ALTER TABLE mbox.%I ENABLE ROW LEVEL SECURITY',name);
    EXECUTE format('ALTER TABLE mbox.%I FORCE ROW LEVEL SECURITY',name);
    EXECUTE format('CREATE POLICY tenant_store_isolation ON mbox.%I USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())',name);
    EXECUTE format('REVOKE ALL ON mbox.%I FROM PUBLIC,mbox_runtime',name);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE ON mbox.%I TO mbox_runtime',name);
  END LOOP;
END $$;
CREATE FUNCTION mbox.protect_member_gift_campaign() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'draft' THEN RAISE EXCEPTION 'Gift campaign must begin as draft'; END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW)-ARRAY['status','approved_by_employee_id','approved_at','published_by_employee_id','published_at','stopped_by_employee_id','stopped_at'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','approved_by_employee_id','approved_at','published_by_employee_id','published_at','stopped_by_employee_id','stopped_at']) THEN
    RAISE EXCEPTION 'Gift campaign terms are immutable';
  END IF;
  IF NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
  IF NOT ((OLD.status='draft' AND NEW.status='approved') OR (OLD.status='approved' AND NEW.status='published') OR (OLD.status='published' AND NEW.status='stopped')) THEN
    RAISE EXCEPTION 'Invalid gift campaign transition';
  END IF;
  IF OLD.approved_at IS NOT NULL AND (NEW.approved_at,NEW.approved_by_employee_id) IS DISTINCT FROM (OLD.approved_at,OLD.approved_by_employee_id) THEN RAISE EXCEPTION 'Gift campaign approval is immutable'; END IF;
  IF OLD.published_at IS NOT NULL AND (NEW.published_at,NEW.published_by_employee_id) IS DISTINCT FROM (OLD.published_at,OLD.published_by_employee_id) THEN RAISE EXCEPTION 'Gift campaign publication is immutable'; END IF;
  IF NEW.status IN('approved','published') AND NOT EXISTS(SELECT 1 FROM mbox.member_gift_campaign_products WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND campaign_version_id=NEW.id) THEN
    RAISE EXCEPTION 'Gift campaign requires a product pool';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER protect_member_gift_campaign BEFORE INSERT OR UPDATE ON mbox.member_gift_campaign_versions FOR EACH ROW EXECUTE FUNCTION mbox.protect_member_gift_campaign();
CREATE FUNCTION mbox.protect_member_gift_product() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE campaign_status text;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Gift campaign products are immutable'; END IF;
  -- Same parent row lock as approval: a concurrent insert cannot append an
  -- unreviewed product after the approver has frozen the pool.
  SELECT status INTO campaign_status FROM mbox.member_gift_campaign_versions WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=NEW.campaign_version_id FOR UPDATE;
  IF campaign_status IS DISTINCT FROM 'draft' THEN RAISE EXCEPTION 'Gift campaign product pool is frozen'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER protect_member_gift_product BEFORE INSERT OR UPDATE OR DELETE ON mbox.member_gift_campaign_products FOR EACH ROW EXECUTE FUNCTION mbox.protect_member_gift_product();
CREATE FUNCTION mbox.protect_member_gift_job() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE campaign mbox.member_gift_campaign_versions; benefit mbox.benefits;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'pending' OR NEW.attempts<>0 THEN RAISE EXCEPTION 'Gift delivery must begin pending'; END IF;
    SELECT * INTO campaign FROM mbox.member_gift_campaign_versions WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=NEW.campaign_version_id;
    IF campaign.status NOT IN('published','stopped') OR NEW.quantity<>campaign.quantity_per_customer THEN RAISE EXCEPTION 'Gift delivery requires published campaign quantity'; END IF;
    IF campaign.trigger_kind='card_entry' THEN
      IF NEW.cycle_key<>'entry' OR NOT EXISTS(SELECT 1 FROM mbox.member_card_applications a WHERE a.tenant_id=NEW.tenant_id AND a.store_id=NEW.store_id AND a.id=NEW.source_application_id AND a.project_id=campaign.card_project_id AND a.status='approved' AND a.resolved_at>=campaign.published_at AND a.resolved_at>=campaign.available_from AND a.resolved_at<campaign.available_until AND (campaign.stopped_at IS NULL OR a.resolved_at<campaign.stopped_at) AND mbox.canonical_customer_id(a.tenant_id,a.store_id,a.customer_id)=mbox.canonical_customer_id(NEW.tenant_id,NEW.store_id,NEW.customer_id)) THEN RAISE EXCEPTION 'Gift entry requires approved same-family application'; END IF;
    ELSIF NEW.source_application_id IS NOT NULL OR campaign.status<>'published' THEN RAISE EXCEPTION 'Targeted gift requires open campaign and cannot impersonate card entry'; END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id,NEW.tenant_id,NEW.store_id,NEW.campaign_version_id,NEW.campaign_code,NEW.cycle_key,NEW.customer_id,NEW.source_application_id,NEW.quantity,NEW.created_at)
    IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.store_id,OLD.campaign_version_id,OLD.campaign_code,OLD.cycle_key,OLD.customer_id,OLD.source_application_id,OLD.quantity,OLD.created_at) THEN RAISE EXCEPTION 'Gift delivery identity is immutable'; END IF;
  IF OLD.status IN('issued','cancelled','duplicate') AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Completed gift delivery is immutable'; END IF;
  IF NEW.attempts<OLD.attempts THEN RAISE EXCEPTION 'Gift delivery attempts cannot decrease'; END IF;
  IF NEW.status='issued' THEN
    SELECT * INTO benefit FROM mbox.benefits WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=NEW.benefit_id;
    IF benefit.id IS NULL OR benefit.benefit_type<>'gift_product' OR benefit.quantity_total<>NEW.quantity OR benefit.issuance_idempotency_key<>('member-gift:'||NEW.id::text) OR mbox.canonical_customer_id(benefit.tenant_id,benefit.store_id,benefit.customer_id)<>mbox.canonical_customer_id(NEW.tenant_id,NEW.store_id,NEW.customer_id) THEN RAISE EXCEPTION 'Gift delivery benefit mismatch'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER protect_member_gift_job BEFORE INSERT OR UPDATE ON mbox.member_gift_delivery_jobs FOR EACH ROW EXECUTE FUNCTION mbox.protect_member_gift_job();
REVOKE ALL ON FUNCTION mbox.protect_member_gift_campaign(),mbox.protect_member_gift_product(),mbox.protect_member_gift_job() FROM PUBLIC;
UPDATE mbox.normalized_schema_metadata SET schema_version='167',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
