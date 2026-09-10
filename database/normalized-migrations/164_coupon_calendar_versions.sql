BEGIN;
-- No existing benefit is rebound, no promotion is published by this migration.
CREATE TABLE mbox.coupon_calendar_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, store_id uuid NOT NULL,
  code text NOT NULL CHECK (code ~ '^[A-Z][A-Z0-9_]{1,39}$'), version integer NOT NULL CHECK(version>0),
  timezone text NOT NULL CHECK(timezone='Asia/Shanghai'),
  date_basis text NOT NULL CHECK(date_basis IN ('natural','business')),
  business_day_start_minute integer NOT NULL CHECK(business_day_start_minute BETWEEN 0 AND 1439),
  date_from date NOT NULL, date_through date NOT NULL,
  valid_from timestamptz NOT NULL, valid_until timestamptz NOT NULL,
  relative_validity_days integer CHECK(relative_validity_days BETWEEN 1 AND 3660),
  relative_validity_basis text CHECK(relative_validity_basis IN('elapsed','natural_end','business_end')),
  CHECK((relative_validity_days IS NULL)=(relative_validity_basis IS NULL)),
  CHECK(relative_validity_basis IS DISTINCT FROM 'business_end' OR date_basis='business'),
  weekdays integer[] NOT NULL CHECK(cardinality(weekdays) BETWEEN 1 AND 7 AND weekdays <@ ARRAY[1,2,3,4,5,6,7]),
  week_starts_on integer NOT NULL CHECK(week_starts_on BETWEEN 1 AND 7),
  per_customer_day_limit integer CHECK(per_customer_day_limit BETWEEN 1 AND 1000000),
  per_customer_week_limit integer CHECK(per_customer_week_limit BETWEEN 1 AND 1000000),
  per_customer_campaign_limit integer CHECK(per_customer_campaign_limit BETWEEN 1 AND 1000000),
  created_by_employee_id uuid NOT NULL, reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 2 AND 500),
  request_key text NOT NULL CHECK(length(request_key) BETWEEN 8 AND 128),
  request_fingerprint char(64) NOT NULL CHECK(request_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK(date_through>=date_from AND date_through-date_from<=3660), CHECK(valid_until>valid_from),
  CHECK(date_basis<>'natural' OR business_day_start_minute=0),
  UNIQUE(tenant_id,store_id,id), UNIQUE(tenant_id,store_id,code,version), UNIQUE(tenant_id,store_id,request_key),
  FOREIGN KEY(tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
  FOREIGN KEY(tenant_id,store_id,created_by_employee_id) REFERENCES mbox.employees(tenant_id,store_id,id)
);
CREATE TABLE mbox.coupon_calendar_windows (
  tenant_id uuid NOT NULL,store_id uuid NOT NULL,version_id uuid NOT NULL,position integer NOT NULL CHECK(position BETWEEN 0 AND 11),
  start_minute integer NOT NULL CHECK(start_minute BETWEEN 0 AND 1439),end_minute integer NOT NULL CHECK(end_minute BETWEEN 0 AND 1440),
  CHECK(start_minute<>end_minute),PRIMARY KEY(tenant_id,store_id,version_id,position),
  FOREIGN KEY(tenant_id,store_id,version_id) REFERENCES mbox.coupon_calendar_versions(tenant_id,store_id,id)
);
CREATE TABLE mbox.coupon_calendar_exclusions (
  tenant_id uuid NOT NULL,store_id uuid NOT NULL,version_id uuid NOT NULL,excluded_date date NOT NULL,
  PRIMARY KEY(tenant_id,store_id,version_id,excluded_date),
  FOREIGN KEY(tenant_id,store_id,version_id) REFERENCES mbox.coupon_calendar_versions(tenant_id,store_id,id)
);
CREATE TABLE mbox.coupon_calendar_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,version_id uuid NOT NULL,
  action text NOT NULL CHECK(action IN ('approve','publish','stop_issuing')),
  employee_id uuid NOT NULL,reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 2 AND 500),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(tenant_id,store_id,version_id,action),
  FOREIGN KEY(tenant_id,store_id,version_id) REFERENCES mbox.coupon_calendar_versions(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,employee_id) REFERENCES mbox.employees(tenant_id,store_id,id)
);
CREATE TABLE mbox.benefit_coupon_calendar_bindings (
  tenant_id uuid NOT NULL,store_id uuid NOT NULL,benefit_id uuid NOT NULL,version_id uuid NOT NULL,
  PRIMARY KEY(tenant_id,store_id,benefit_id),
  FOREIGN KEY(tenant_id,store_id,benefit_id) REFERENCES mbox.benefits(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,version_id) REFERENCES mbox.coupon_calendar_versions(tenant_id,store_id,id)
);
CREATE TABLE mbox.benefit_coupon_calendar_usage (
  tenant_id uuid NOT NULL,store_id uuid NOT NULL,reservation_id uuid NOT NULL,version_id uuid NOT NULL,
  customer_id uuid NOT NULL,usage_date date NOT NULL,usage_week_start date NOT NULL,
  PRIMARY KEY(tenant_id,store_id,reservation_id),
  FOREIGN KEY(tenant_id,store_id,reservation_id) REFERENCES mbox.benefit_reservations(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,version_id) REFERENCES mbox.coupon_calendar_versions(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,customer_id) REFERENCES mbox.customers(tenant_id,store_id,id)
);
CREATE INDEX coupon_calendar_recent_idx ON mbox.coupon_calendar_versions(tenant_id,store_id,created_at DESC,id DESC);
CREATE INDEX coupon_calendar_usage_customer_idx ON mbox.benefit_coupon_calendar_usage(tenant_id,store_id,customer_id,version_id,usage_date);
CREATE FUNCTION mbox.freeze_approved_coupon_calendar_children() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Do not allow a late child insert to race with approval/publication. Use
  -- the same scoped guard as the repository, and fail fast rather than wait.
  IF NOT pg_try_advisory_xact_lock(hashtextextended('coupon-calendar:' || NEW.tenant_id::text || ':' || NEW.store_id::text || ':decision:' || NEW.version_id::text,0)) THEN
    RAISE EXCEPTION 'Coupon calendar decision in progress; retry after reading the version' USING ERRCODE='23514';
  END IF;
  IF EXISTS(SELECT 1 FROM mbox.coupon_calendar_decisions d WHERE d.tenant_id=NEW.tenant_id AND d.store_id=NEW.store_id AND d.version_id=NEW.version_id) THEN
    RAISE EXCEPTION 'Approved coupon calendar cannot acquire new windows or exclusions' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER coupon_calendar_windows_frozen BEFORE INSERT ON mbox.coupon_calendar_windows FOR EACH ROW EXECUTE FUNCTION mbox.freeze_approved_coupon_calendar_children();
CREATE TRIGGER coupon_calendar_exclusions_frozen BEFORE INSERT ON mbox.coupon_calendar_exclusions FOR EACH ROW EXECUTE FUNCTION mbox.freeze_approved_coupon_calendar_children();
CREATE FUNCTION mbox.lock_coupon_calendar_decision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('coupon-calendar:' || NEW.tenant_id::text || ':' || NEW.store_id::text || ':decision:' || NEW.version_id::text,0));
  RETURN NEW;
END $$;
CREATE TRIGGER coupon_calendar_decision_guard BEFORE INSERT ON mbox.coupon_calendar_decisions FOR EACH ROW EXECUTE FUNCTION mbox.lock_coupon_calendar_decision();
DO $$ DECLARE name text; BEGIN
  FOREACH name IN ARRAY ARRAY['coupon_calendar_versions','coupon_calendar_windows','coupon_calendar_exclusions','coupon_calendar_decisions','benefit_coupon_calendar_bindings','benefit_coupon_calendar_usage'] LOOP
    EXECUTE format('ALTER TABLE mbox.%I ENABLE ROW LEVEL SECURITY',name);
    EXECUTE format('ALTER TABLE mbox.%I FORCE ROW LEVEL SECURITY',name);
    EXECUTE format('CREATE POLICY tenant_store_isolation ON mbox.%I USING (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())',name);
    EXECUTE format('REVOKE ALL ON mbox.%I FROM PUBLIC,mbox_runtime',name);
    EXECUTE format('GRANT SELECT,INSERT ON mbox.%I TO mbox_runtime',name);
  END LOOP;
END $$;
UPDATE mbox.normalized_schema_metadata SET schema_version='164',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';
COMMIT;
