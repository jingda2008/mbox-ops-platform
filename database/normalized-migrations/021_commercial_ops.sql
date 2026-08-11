BEGIN;

CREATE TABLE mbox.operating_cost_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  public_id text NOT NULL CHECK (length(public_id) BETWEEN 8 AND 128),
  category text NOT NULL CHECK (category IN (
    'beverage_purchase', 'personnel', 'performer', 'band',
    'rent', 'utilities', 'miscellaneous'
  )),
  recognition_state text NOT NULL CHECK (recognition_state IN ('known', 'accrual', 'actual')),
  allocation_period text NOT NULL CHECK (allocation_period IN ('day', 'week', 'month', 'quarter', 'year')),
  service_start_date date NOT NULL,
  service_end_date date NOT NULL,
  cash_paid_on date,
  net_amount_minor bigint NOT NULL CHECK (net_amount_minor >= 0),
  tax_amount_minor bigint NOT NULL DEFAULT 0 CHECK (tax_amount_minor >= 0),
  gross_amount_minor bigint GENERATED ALWAYS AS (net_amount_minor + tax_amount_minor) STORED,
  currency char(3) NOT NULL DEFAULT 'CNY' CHECK (currency ~ '^[A-Z]{3}$'),
  source_type text NOT NULL CHECK (source_type IN (
    'inventory_purchase', 'payroll', 'performance', 'lease', 'utility_bill', 'manual'
  )),
  purchase_receipt_line_id uuid,
  employee_id uuid,
  schedule_id uuid,
  source_reference text,
  source_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(source_snapshot) = 'object'),
  corrects_cost_entry_id uuid,
  correction_reason text,
  recorded_business_date date NOT NULL,
  recorded_by_employee_id uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, purchase_receipt_line_id)
    REFERENCES mbox.purchase_receipt_lines(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, schedule_id)
    REFERENCES mbox.schedules(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, recorded_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, corrects_cost_entry_id)
    REFERENCES mbox.operating_cost_entries(tenant_id, store_id, id),
  CHECK (service_end_date >= service_start_date),
  CHECK (
    (corrects_cost_entry_id IS NULL AND correction_reason IS NULL)
    OR (corrects_cost_entry_id IS NOT NULL AND length(btrim(correction_reason)) BETWEEN 2 AND 1000)
  ),
  CHECK (purchase_receipt_line_id IS NULL OR source_type = 'inventory_purchase'),
  CHECK (employee_id IS NULL OR source_type = 'payroll'),
  CHECK (schedule_id IS NULL OR source_type = 'performance'),
  CHECK (id IS DISTINCT FROM corrects_cost_entry_id),
  UNIQUE (tenant_id, store_id, public_id),
  UNIQUE (tenant_id, store_id, corrects_cost_entry_id),
  UNIQUE (tenant_id, store_id, id)
);

CREATE INDEX operating_cost_entries_service_period_idx
  ON mbox.operating_cost_entries (
    tenant_id, store_id, service_start_date, service_end_date, category, id
  );
CREATE INDEX operating_cost_entries_cash_date_idx
  ON mbox.operating_cost_entries (tenant_id, store_id, cash_paid_on, category, id)
  WHERE cash_paid_on IS NOT NULL;
CREATE INDEX operating_cost_entries_correction_idx
  ON mbox.operating_cost_entries (tenant_id, store_id, corrects_cost_entry_id)
  WHERE corrects_cost_entry_id IS NOT NULL;

CREATE TABLE mbox.employee_sales_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  product_id uuid NOT NULL,
  attribution_mode text NOT NULL CHECK (attribution_mode IN (
    'explicit', 'order_creator', 'table_primary', 'disabled'
  )),
  sales_credit_bps integer NOT NULL DEFAULT 10000 CHECK (sales_credit_bps BETWEEN 0 AND 10000),
  cost_source text NOT NULL DEFAULT 'order_item_snapshot' CHECK (cost_source IN (
    'order_item_snapshot', 'none'
  )),
  effective_during tstzrange NOT NULL,
  rule_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(rule_snapshot) = 'object'),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 2 AND 1000),
  configured_by_employee_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, product_id)
    REFERENCES mbox.products(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, configured_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  CHECK (NOT isempty(effective_during) AND lower_inc(effective_during) AND NOT upper_inc(effective_during)),
  CHECK (attribution_mode <> 'disabled' OR sales_credit_bps = 0),
  UNIQUE (tenant_id, store_id, id),
  EXCLUDE USING gist (
    tenant_id WITH =,
    store_id WITH =,
    product_id WITH =,
    effective_during WITH &&
  )
);

CREATE INDEX employee_sales_rules_lookup_idx
  ON mbox.employee_sales_rules (tenant_id, store_id, product_id, lower(effective_during), id);

CREATE TABLE mbox.employee_sales_attribution_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('sale', 'refund_reversal')),
  order_id uuid NOT NULL,
  order_item_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  rule_id uuid,
  source_sale_event_id uuid,
  refund_id uuid,
  business_date date NOT NULL,
  quantity_delta numeric(18,6) NOT NULL CHECK (quantity_delta <> 0),
  sales_amount_delta_minor bigint NOT NULL CHECK (sales_amount_delta_minor <> 0),
  cost_amount_delta_minor bigint,
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  product_snapshot jsonb NOT NULL CHECK (jsonb_typeof(product_snapshot) = 'object'),
  attribution_snapshot jsonb NOT NULL CHECK (jsonb_typeof(attribution_snapshot) = 'object'),
  recorded_by_employee_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, order_id)
    REFERENCES mbox.orders(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, order_item_id)
    REFERENCES mbox.order_items(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, rule_id)
    REFERENCES mbox.employee_sales_rules(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, source_sale_event_id)
    REFERENCES mbox.employee_sales_attribution_events(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, refund_id)
    REFERENCES mbox.refunds(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, recorded_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  CHECK (
    (event_type = 'sale'
      AND source_sale_event_id IS NULL
      AND refund_id IS NULL
      AND quantity_delta > 0
      AND sales_amount_delta_minor > 0
      AND (cost_amount_delta_minor IS NULL OR cost_amount_delta_minor >= 0))
    OR (event_type = 'refund_reversal'
      AND source_sale_event_id IS NOT NULL
      AND refund_id IS NOT NULL
      AND quantity_delta < 0
      AND sales_amount_delta_minor < 0
      AND (cost_amount_delta_minor IS NULL OR cost_amount_delta_minor <= 0))
  ),
  UNIQUE (tenant_id, store_id, source_sale_event_id, refund_id),
  UNIQUE (tenant_id, store_id, id)
);

-- Multiple independent refunds are valid; only original sale ownership must be unique.
CREATE UNIQUE INDEX employee_sales_attribution_one_sale_uq
  ON mbox.employee_sales_attribution_events (tenant_id, store_id, order_item_id)
  WHERE event_type = 'sale';
CREATE INDEX employee_sales_attribution_employee_date_idx
  ON mbox.employee_sales_attribution_events (
    tenant_id, store_id, employee_id, business_date, occurred_at, id
  );
CREATE INDEX employee_sales_attribution_product_date_idx
  ON mbox.employee_sales_attribution_events (
    tenant_id, store_id, order_item_id, business_date, id
  );

CREATE TABLE mbox.group_voucher_redemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  public_id text NOT NULL CHECK (length(public_id) BETWEEN 8 AND 128),
  platform text NOT NULL CHECK (length(btrim(platform)) BETWEEN 1 AND 64),
  campaign_name text NOT NULL CHECK (length(btrim(campaign_name)) BETWEEN 1 AND 128),
  voucher_code_hash char(64) NOT NULL CHECK (voucher_code_hash ~ '^[0-9a-f]{64}$'),
  voucher_code_masked text NOT NULL CHECK (length(btrim(voucher_code_masked)) BETWEEN 4 AND 32),
  face_value_minor bigint NOT NULL CHECK (face_value_minor >= 0),
  settlement_amount_minor bigint NOT NULL CHECK (settlement_amount_minor >= 0),
  currency char(3) NOT NULL DEFAULT 'CNY' CHECK (currency ~ '^[A-Z]{3}$'),
  order_id uuid,
  table_session_id uuid,
  reconciliation_entry_id uuid,
  redeemed_by_employee_id uuid NOT NULL,
  redeemed_business_date date NOT NULL,
  redeemed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, order_id)
    REFERENCES mbox.orders(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, table_session_id)
    REFERENCES mbox.table_sessions(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, reconciliation_entry_id)
    REFERENCES mbox.reconciliation_entries(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, redeemed_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, public_id),
  UNIQUE (tenant_id, store_id, platform, voucher_code_hash),
  UNIQUE (tenant_id, store_id, reconciliation_entry_id),
  UNIQUE (tenant_id, store_id, id)
);

CREATE INDEX group_voucher_redemptions_date_idx
  ON mbox.group_voucher_redemptions (
    tenant_id, store_id, redeemed_business_date, redeemed_at, id
  );

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'operating_cost_entries', 'employee_sales_rules',
    'employee_sales_attribution_events', 'group_voucher_redemptions'
  ]
  LOOP
    EXECUTE format('ALTER TABLE mbox.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE mbox.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_store_isolation ON mbox.%I '
      'USING (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id()) '
      'WITH CHECK (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id())',
      table_name
    );
    EXECUTE format('REVOKE ALL ON TABLE mbox.%I FROM PUBLIC', table_name);
    EXECUTE format('GRANT SELECT, INSERT ON TABLE mbox.%I TO mbox_runtime', table_name);
  END LOOP;
END $$;

CREATE TRIGGER operating_cost_entries_append_only
  BEFORE UPDATE OR DELETE ON mbox.operating_cost_entries
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();
CREATE TRIGGER employee_sales_rules_append_only
  BEFORE UPDATE OR DELETE ON mbox.employee_sales_rules
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();
CREATE TRIGGER employee_sales_attribution_events_append_only
  BEFORE UPDATE OR DELETE ON mbox.employee_sales_attribution_events
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();
CREATE TRIGGER group_voucher_redemptions_append_only
  BEFORE UPDATE OR DELETE ON mbox.group_voucher_redemptions
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();

INSERT INTO mbox.staff_permission_definitions (
  tenant_id, store_id, code, name, category, description, status
)
SELECT store.tenant_id, store.id, permission.code, permission.name,
  'commercial', permission.description, 'active'
FROM mbox.stores AS store
CROSS JOIN (VALUES
  ('commercial.cost.view', '查看经营成本', '查看脱敏后的经营成本与未确认成本'),
  ('commercial.cost.manage', '管理经营成本', '录入成本并以不可变更正记录修正'),
  ('commercial.profit.view', '查看经营利润', '查看现金和权责口径利润及数据缺口'),
  ('commercial.sales.view', '查看员工销售', '查看本人或数据范围内的员工销售统计'),
  ('commercial.sales.view_all', '查看全店员工销售', '查看全店员工销售归属与退款反冲统计'),
  ('commercial.sales.rule.manage', '配置销售归属', '按单品配置员工销售归属规则'),
  ('commercial.sales.attribute', '登记销售归属', '根据生效规则记录销售归属和退款反冲'),
  ('commercial.voucher.view', '查看团购核销', '查看脱敏后的团购券核销结果'),
  ('commercial.voucher.redeem', '核销团购券', '核销团购券并防止重复使用')
) AS permission(code, name, description)
ON CONFLICT (tenant_id, store_id, code) DO UPDATE
SET name = EXCLUDED.name,
    category = EXCLUDED.category,
    description = EXCLUDED.description,
    status = 'active';

COMMENT ON TABLE mbox.operating_cost_entries IS
  'Append-only known, accrued and actual operating costs. Corrections append a replacement row.';
COMMENT ON COLUMN mbox.operating_cost_entries.gross_amount_minor IS
  'Integer minor units including tax; generated from net_amount_minor plus tax_amount_minor.';
COMMENT ON TABLE mbox.employee_sales_attribution_events IS
  'Append-only employee sales ownership snapshot and refund reversal ledger.';
COMMENT ON TABLE mbox.group_voucher_redemptions IS
  'Voucher codes are stored only as SHA-256 hashes plus display-safe masks. Redemption alone is not recognized revenue.';

COMMIT;
