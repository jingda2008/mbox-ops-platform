BEGIN;

ALTER TABLE mbox.employees
  ADD COLUMN lifecycle_version integer NOT NULL DEFAULT 1 CHECK (lifecycle_version > 0);

-- Owner-maintained classifications keep custom labels separate from the stable
-- accounting buckets consumed by reports.
CREATE TABLE mbox.operating_cost_category_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  code text NOT NULL CHECK (code ~ '^[a-z][a-z0-9_.-]{1,63}$'),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 64),
  system_category text NOT NULL CHECK (system_category IN (
    'beverage_purchase','personnel','performer','band','rent','utilities','miscellaneous'
  )),
  is_system boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  sort_order integer NOT NULL DEFAULT 100 CHECK (sort_order BETWEEN 0 AND 10000),
  created_by_employee_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
  FOREIGN KEY (tenant_id,store_id,created_by_employee_id) REFERENCES mbox.employees(tenant_id,store_id,id),
  UNIQUE (tenant_id,store_id,code),
  UNIQUE (tenant_id,store_id,id)
);

CREATE TABLE mbox.cost_centers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  code text NOT NULL CHECK (code ~ '^[a-z][a-z0-9_.-]{1,63}$'),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 64),
  is_system boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  sort_order integer NOT NULL DEFAULT 100 CHECK (sort_order BETWEEN 0 AND 10000),
  created_by_employee_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
  FOREIGN KEY (tenant_id,store_id,created_by_employee_id) REFERENCES mbox.employees(tenant_id,store_id,id),
  UNIQUE (tenant_id,store_id,code),
  UNIQUE (tenant_id,store_id,id)
);

INSERT INTO mbox.operating_cost_category_definitions (
  tenant_id,store_id,code,name,system_category,is_system,sort_order
)
SELECT store.tenant_id,store.id,item.code,item.name,item.system_category,true,item.sort_order
FROM mbox.stores AS store
CROSS JOIN (VALUES
  ('rent','房租','rent',10),
  ('payroll','员工工资','personnel',20),
  ('band','乐队','band',30),
  ('performer','其他演出','performer',40),
  ('utilities','水电与物业','utilities',50),
  ('beverage_purchase','酒水采购','beverage_purchase',60),
  ('miscellaneous','其他费用','miscellaneous',100)
) AS item(code,name,system_category,sort_order)
ON CONFLICT (tenant_id,store_id,code) DO NOTHING;

INSERT INTO mbox.cost_centers (tenant_id,store_id,code,name,is_system,sort_order)
SELECT store.tenant_id,store.id,item.code,item.name,true,item.sort_order
FROM mbox.stores AS store
CROSS JOIN (VALUES
  ('venue','全店',10),('bar','吧台',20),('kitchen','厨房',30),
  ('stage','舞台与演出',40),('front_of_house','前厅',50),('administration','行政',60)
) AS item(code,name,sort_order)
ON CONFLICT (tenant_id,store_id,code) DO NOTHING;

CREATE FUNCTION mbox.seed_store_owner_finance_defaults()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO mbox.operating_cost_category_definitions(
    tenant_id,store_id,code,name,system_category,is_system,sort_order
  ) VALUES
    (NEW.tenant_id,NEW.id,'rent','房租','rent',true,10),
    (NEW.tenant_id,NEW.id,'payroll','员工工资','personnel',true,20),
    (NEW.tenant_id,NEW.id,'band','乐队','band',true,30),
    (NEW.tenant_id,NEW.id,'performer','其他演出','performer',true,40),
    (NEW.tenant_id,NEW.id,'utilities','水电与物业','utilities',true,50),
    (NEW.tenant_id,NEW.id,'beverage_purchase','酒水采购','beverage_purchase',true,60),
    (NEW.tenant_id,NEW.id,'miscellaneous','其他费用','miscellaneous',true,100)
  ON CONFLICT (tenant_id,store_id,code) DO NOTHING;

  INSERT INTO mbox.cost_centers(tenant_id,store_id,code,name,is_system,sort_order) VALUES
    (NEW.tenant_id,NEW.id,'venue','全店',true,10),
    (NEW.tenant_id,NEW.id,'bar','吧台',true,20),
    (NEW.tenant_id,NEW.id,'kitchen','厨房',true,30),
    (NEW.tenant_id,NEW.id,'stage','舞台与演出',true,40),
    (NEW.tenant_id,NEW.id,'front_of_house','前厅',true,50),
    (NEW.tenant_id,NEW.id,'administration','行政',true,60)
  ON CONFLICT (tenant_id,store_id,code) DO NOTHING;

  INSERT INTO mbox.staff_permission_definitions(
    tenant_id,store_id,code,name,category,description,status
  ) VALUES
    (NEW.tenant_id,NEW.id,'commercial.cost.view','查看经营成本','commercial','查看脱敏后的经营成本与未确认成本','active'),
    (NEW.tenant_id,NEW.id,'commercial.cost.manage','管理经营成本','commercial','录入成本并以不可变更正记录修正','active'),
    (NEW.tenant_id,NEW.id,'commercial.profit.view','查看经营利润','commercial','查看现金结余、商品成本、经营费用和数据缺口','active'),
    (NEW.tenant_id,NEW.id,'commercial.sales.view','查看员工销售','commercial','查看本人或数据范围内的员工销售统计','active'),
    (NEW.tenant_id,NEW.id,'commercial.sales.view_all','查看全店员工销售','commercial','查看全店员工销售归属与退款反冲统计','active'),
    (NEW.tenant_id,NEW.id,'commercial.sales.rule.manage','配置销售归属','commercial','按单品配置员工销售归属规则','active'),
    (NEW.tenant_id,NEW.id,'commercial.sales.attribute','登记销售归属','commercial','根据生效规则记录销售归属和退款反冲','active'),
    (NEW.tenant_id,NEW.id,'commercial.voucher.view','查看团购核销','commercial','查看脱敏后的团购券核销结果','active'),
    (NEW.tenant_id,NEW.id,'commercial.voucher.redeem','核销团购券','commercial','核销团购券并防止重复使用','active'),
    (NEW.tenant_id,NEW.id,'commercial.payroll.view','查看工资核算','commercial','查看员工薪资规则、工资草稿及汇总','active'),
    (NEW.tenant_id,NEW.id,'commercial.payroll.manage','管理工资核算','commercial','维护薪资规则并建立工资草稿，不包含转账','active'),
    (NEW.tenant_id,NEW.id,'commercial.payroll.post','确认工资入账','commercial','人工确认工资草稿并生成不可变经营成本记录','active')
  ON CONFLICT (tenant_id,store_id,code) DO UPDATE SET
    name=EXCLUDED.name,category=EXCLUDED.category,description=EXCLUDED.description,status='active';
  RETURN NEW;
END $$;

CREATE TRIGGER stores_seed_owner_finance_defaults
  AFTER INSERT ON mbox.stores
  FOR EACH ROW EXECUTE FUNCTION mbox.seed_store_owner_finance_defaults();

CREATE TABLE mbox.recurring_operating_cost_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  public_id text NOT NULL CHECK (length(public_id) BETWEEN 8 AND 128),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 128),
  category_definition_id uuid NOT NULL,
  cost_center_id uuid NOT NULL,
  recurrence text NOT NULL CHECK (recurrence IN ('day','week','month','quarter','year')),
  starts_on date NOT NULL,
  ends_on date,
  allocation_period text NOT NULL CHECK (allocation_period IN ('day','week','month','quarter','year')),
  recognition_state text NOT NULL CHECK (recognition_state IN ('known','accrual','actual')),
  net_amount_minor bigint NOT NULL CHECK (net_amount_minor >= 0),
  tax_amount_minor bigint NOT NULL DEFAULT 0 CHECK (tax_amount_minor >= 0),
  gross_amount_minor bigint GENERATED ALWAYS AS (net_amount_minor+tax_amount_minor) STORED,
  currency char(3) NOT NULL DEFAULT 'CNY' CHECK (currency ~ '^[A-Z]{3}$'),
  source_type text NOT NULL CHECK (source_type IN ('payroll','performance','lease','utility_bill','manual')),
  counterparty text CHECK (counterparty IS NULL OR length(btrim(counterparty)) BETWEEN 1 AND 128),
  note text CHECK (note IS NULL OR length(btrim(note)) BETWEEN 1 AND 1000),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','ended')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by_employee_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
  FOREIGN KEY (tenant_id,store_id,category_definition_id)
    REFERENCES mbox.operating_cost_category_definitions(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,cost_center_id) REFERENCES mbox.cost_centers(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,created_by_employee_id) REFERENCES mbox.employees(tenant_id,store_id,id),
  CHECK (ends_on IS NULL OR ends_on>=starts_on),
  UNIQUE (tenant_id,store_id,public_id),
  UNIQUE (tenant_id,store_id,id)
);

CREATE TABLE mbox.employee_compensation_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  public_id text NOT NULL CHECK (length(public_id) BETWEEN 8 AND 128),
  employee_id uuid NOT NULL,
  cost_center_id uuid NOT NULL,
  pay_basis text NOT NULL CHECK (pay_basis IN ('monthly','daily','hourly','per_shift')),
  base_rate_minor bigint NOT NULL CHECK (base_rate_minor>=0),
  currency char(3) NOT NULL DEFAULT 'CNY' CHECK (currency ~ '^[A-Z]{3}$'),
  effective_from date NOT NULL,
  effective_until date,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','ended')),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 2 AND 1000),
  created_by_employee_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
  FOREIGN KEY (tenant_id,store_id,employee_id) REFERENCES mbox.employees(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,cost_center_id) REFERENCES mbox.cost_centers(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,created_by_employee_id) REFERENCES mbox.employees(tenant_id,store_id,id),
  CHECK (effective_until IS NULL OR effective_until>=effective_from),
  UNIQUE (tenant_id,store_id,public_id),
  UNIQUE (tenant_id,store_id,employee_id,effective_from),
  UNIQUE (tenant_id,store_id,id)
);

ALTER TABLE mbox.employee_compensation_rules
  ADD CONSTRAINT employee_compensation_rules_no_overlap
  EXCLUDE USING gist (
    tenant_id WITH =,
    store_id WITH =,
    employee_id WITH =,
    daterange(effective_from,COALESCE(effective_until,'infinity'::date),'[]') WITH &&
  );

CREATE TABLE mbox.payroll_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  public_id text NOT NULL CHECK (length(public_id) BETWEEN 8 AND 128),
  period_start date NOT NULL,
  period_end date NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','posted','voided')),
  currency char(3) NOT NULL DEFAULT 'CNY' CHECK (currency ~ '^[A-Z]{3}$'),
  note text CHECK (note IS NULL OR length(btrim(note)) BETWEEN 1 AND 1000),
  created_by_employee_id uuid NOT NULL,
  approved_by_employee_id uuid,
  approved_at timestamptz,
  posted_by_employee_id uuid,
  posted_at timestamptz,
  voided_by_employee_id uuid,
  voided_at timestamptz,
  void_reason text CHECK (void_reason IS NULL OR length(btrim(void_reason)) BETWEEN 2 AND 1000),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
  FOREIGN KEY (tenant_id,store_id,created_by_employee_id) REFERENCES mbox.employees(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,approved_by_employee_id) REFERENCES mbox.employees(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,posted_by_employee_id) REFERENCES mbox.employees(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,voided_by_employee_id) REFERENCES mbox.employees(tenant_id,store_id,id),
  CHECK (period_end>=period_start),
  CHECK ((approved_by_employee_id IS NULL)=(approved_at IS NULL)),
  CHECK ((posted_by_employee_id IS NULL)=(posted_at IS NULL)),
  CHECK ((voided_by_employee_id IS NULL)=(voided_at IS NULL)),
  CHECK ((void_reason IS NULL)=(voided_at IS NULL)),
  CHECK (status NOT IN ('approved','posted') OR approved_at IS NOT NULL),
  CHECK (status<>'posted' OR posted_at IS NOT NULL),
  CHECK ((status='voided')=(voided_at IS NOT NULL)),
  UNIQUE (tenant_id,store_id,public_id),
  UNIQUE (tenant_id,store_id,id)
);

ALTER TABLE mbox.payroll_runs
  ADD CONSTRAINT payroll_runs_no_overlapping_active_periods
  EXCLUDE USING gist (
    tenant_id WITH =,
    store_id WITH =,
    daterange(period_start,period_end,'[]') WITH &&
  ) WHERE (status<>'voided');

CREATE TABLE mbox.payroll_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  payroll_run_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  compensation_rule_id uuid,
  units numeric(12,2) NOT NULL DEFAULT 1 CHECK (units>=0 AND units<=10000),
  base_pay_minor bigint NOT NULL CHECK (base_pay_minor>=0),
  overtime_minor bigint NOT NULL DEFAULT 0 CHECK (overtime_minor>=0),
  bonus_minor bigint NOT NULL DEFAULT 0 CHECK (bonus_minor>=0),
  commission_minor bigint NOT NULL DEFAULT 0 CHECK (commission_minor>=0),
  allowance_minor bigint NOT NULL DEFAULT 0 CHECK (allowance_minor>=0),
  deduction_minor bigint NOT NULL DEFAULT 0 CHECK (deduction_minor>=0),
  employer_contribution_minor bigint NOT NULL DEFAULT 0 CHECK (employer_contribution_minor>=0),
  gross_pay_minor bigint GENERATED ALWAYS AS
    (base_pay_minor+overtime_minor+bonus_minor+commission_minor+allowance_minor) STORED,
  net_pay_minor bigint GENERATED ALWAYS AS
    (base_pay_minor+overtime_minor+bonus_minor+commission_minor+allowance_minor-deduction_minor) STORED,
  employer_cost_minor bigint GENERATED ALWAYS AS
    (base_pay_minor+overtime_minor+bonus_minor+commission_minor+allowance_minor+employer_contribution_minor) STORED,
  note text CHECK (note IS NULL OR length(btrim(note)) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
  FOREIGN KEY (tenant_id,store_id,payroll_run_id) REFERENCES mbox.payroll_runs(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,employee_id) REFERENCES mbox.employees(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,compensation_rule_id)
    REFERENCES mbox.employee_compensation_rules(tenant_id,store_id,id),
  CHECK (deduction_minor<=base_pay_minor+overtime_minor+bonus_minor+commission_minor+allowance_minor),
  UNIQUE (tenant_id,store_id,payroll_run_id,employee_id),
  UNIQUE (tenant_id,store_id,id)
);

ALTER TABLE mbox.operating_cost_entries
  ADD COLUMN display_name text CHECK (display_name IS NULL OR length(btrim(display_name)) BETWEEN 1 AND 128),
  ADD COLUMN category_definition_id uuid,
  ADD COLUMN cost_center_id uuid,
  ADD COLUMN recurring_rule_id uuid,
  ADD COLUMN recurring_occurrence_on date,
  ADD COLUMN counterparty text CHECK (counterparty IS NULL OR length(btrim(counterparty)) BETWEEN 1 AND 128),
  ADD COLUMN note text CHECK (note IS NULL OR length(btrim(note)) BETWEEN 1 AND 1000),
  ADD COLUMN payroll_run_id uuid,
  ADD COLUMN payroll_line_id uuid,
  ADD FOREIGN KEY (tenant_id,store_id,category_definition_id)
    REFERENCES mbox.operating_cost_category_definitions(tenant_id,store_id,id),
  ADD FOREIGN KEY (tenant_id,store_id,cost_center_id) REFERENCES mbox.cost_centers(tenant_id,store_id,id),
  ADD FOREIGN KEY (tenant_id,store_id,recurring_rule_id)
    REFERENCES mbox.recurring_operating_cost_rules(tenant_id,store_id,id),
  ADD FOREIGN KEY (tenant_id,store_id,payroll_run_id) REFERENCES mbox.payroll_runs(tenant_id,store_id,id),
  ADD FOREIGN KEY (tenant_id,store_id,payroll_line_id) REFERENCES mbox.payroll_lines(tenant_id,store_id,id),
  ADD CHECK ((recurring_rule_id IS NULL)=(recurring_occurrence_on IS NULL)),
  ADD CHECK ((payroll_run_id IS NULL)=(payroll_line_id IS NULL)),
  ADD CHECK (payroll_line_id IS NULL OR source_type='payroll');

CREATE FUNCTION mbox.validate_operating_cost_classification()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,mbox AS $$
DECLARE mapped_category text;
BEGIN
  IF NEW.category_definition_id IS NOT NULL THEN
    SELECT definition.system_category INTO mapped_category
    FROM mbox.operating_cost_category_definitions AS definition
    WHERE definition.tenant_id=NEW.tenant_id AND definition.store_id=NEW.store_id
      AND definition.id=NEW.category_definition_id;
    IF mapped_category IS DISTINCT FROM NEW.category THEN
      RAISE EXCEPTION 'Cost category definition does not match accounting category' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER operating_cost_classification_guard
  BEFORE INSERT ON mbox.operating_cost_entries
  FOR EACH ROW EXECUTE FUNCTION mbox.validate_operating_cost_classification();

CREATE UNIQUE INDEX operating_cost_recurring_occurrence_uq
  ON mbox.operating_cost_entries(tenant_id,store_id,recurring_rule_id,recurring_occurrence_on)
  WHERE recurring_rule_id IS NOT NULL AND corrects_cost_entry_id IS NULL;
CREATE UNIQUE INDEX operating_cost_payroll_line_uq
  ON mbox.operating_cost_entries(tenant_id,store_id,payroll_line_id)
  WHERE payroll_line_id IS NOT NULL AND corrects_cost_entry_id IS NULL;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'operating_cost_category_definitions','cost_centers','recurring_operating_cost_rules',
    'employee_compensation_rules','payroll_runs','payroll_lines'
  ] LOOP
    EXECUTE format('ALTER TABLE mbox.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE mbox.%I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format(
      'CREATE POLICY tenant_store_isolation ON mbox.%I USING '
      '(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK '
      '(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())',table_name
    );
    EXECUTE format('REVOKE ALL ON TABLE mbox.%I FROM PUBLIC',table_name);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE ON TABLE mbox.%I TO mbox_runtime',table_name);
  END LOOP;
END $$;

INSERT INTO mbox.staff_permission_definitions (tenant_id,store_id,code,name,category,description,status)
SELECT store.tenant_id,store.id,item.code,item.name,'commercial',item.description,'active'
FROM mbox.stores AS store
CROSS JOIN (VALUES
  ('commercial.payroll.view','查看工资核算','查看员工薪资规则、工资草稿及汇总'),
  ('commercial.payroll.manage','管理工资核算','维护薪资规则并建立工资草稿，不包含转账'),
  ('commercial.payroll.post','确认工资入账','人工确认工资草稿并生成不可变经营成本记录')
) AS item(code,name,description)
ON CONFLICT (tenant_id,store_id,code) DO UPDATE SET
  name=EXCLUDED.name,category=EXCLUDED.category,description=EXCLUDED.description,status='active';

-- Managing a cost without being able to read it is unusable. Existing stores
-- are repaired here; production config is updated separately below.
INSERT INTO mbox.role_permission_assignments (tenant_id,store_id,role_id,permission_id)
SELECT role.tenant_id,role.store_id,role.id,view_permission.id
FROM mbox.roles AS role
JOIN mbox.staff_permission_definitions AS manage_permission
  ON manage_permission.tenant_id=role.tenant_id AND manage_permission.store_id=role.store_id
 AND manage_permission.code='commercial.cost.manage'
JOIN mbox.role_permission_assignments AS assignment
  ON assignment.tenant_id=role.tenant_id AND assignment.store_id=role.store_id
 AND assignment.role_id=role.id AND assignment.permission_id=manage_permission.id
JOIN mbox.staff_permission_definitions AS view_permission
  ON view_permission.tenant_id=role.tenant_id AND view_permission.store_id=role.store_id
 AND view_permission.code='commercial.cost.view'
ON CONFLICT (tenant_id,store_id,role_id,permission_id) DO NOTHING;

INSERT INTO mbox.role_permission_assignments (tenant_id,store_id,role_id,permission_id)
SELECT role.tenant_id,role.store_id,role.id,permission.id
FROM mbox.roles AS role
JOIN mbox.staff_permission_definitions AS permission
  ON permission.tenant_id=role.tenant_id AND permission.store_id=role.store_id
 AND permission.code IN ('commercial.payroll.view','commercial.payroll.manage','commercial.payroll.post')
WHERE role.code='OWNER'
ON CONFLICT (tenant_id,store_id,role_id,permission_id) DO NOTHING;

COMMENT ON TABLE mbox.recurring_operating_cost_rules IS
  'Owner-approved recurring cost templates. Materialized occurrences remain append-only operating cost facts.';
COMMENT ON TABLE mbox.payroll_runs IS
  'Payroll calculation and accounting workflow only; posting never initiates a bank or wallet transfer.';
COMMENT ON COLUMN mbox.payroll_lines.employer_cost_minor IS
  'Expense basis: gross pay plus employer contribution. Employee deductions do not reduce employer expense.';

UPDATE mbox.normalized_schema_metadata
SET schema_version='160',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
