BEGIN;

-- Manual labor is recorded on the expense form. It stays on the miscellaneous
-- bucket so finance can save it without payroll permission. Formal wages remain
-- the payroll category and are still excluded from this form.
INSERT INTO mbox.operating_cost_category_definitions (
  tenant_id,store_id,code,name,system_category,is_system,sort_order
)
SELECT store.tenant_id,store.id,'labor','人工费用','miscellaneous',true,55
FROM mbox.stores AS store
ON CONFLICT (tenant_id,store_id,code) DO NOTHING;

CREATE OR REPLACE FUNCTION mbox.seed_store_owner_finance_defaults()
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
    (NEW.tenant_id,NEW.id,'labor','人工费用','miscellaneous',true,55),
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

UPDATE mbox.normalized_schema_metadata SET schema_version='274',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
