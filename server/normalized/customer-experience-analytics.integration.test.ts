import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { CustomerExperienceAnalyticsRepository } from './customer-experience-analytics-repository.js'
import { ScopedPostgresTransactionRunner, type PostgresPool } from './transaction-runner.js'

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip

integration('customer experience analytics PostgreSQL contract', () => {
  const tenantId = randomUUID()
  const storeId = randomUUID()
  const employeeId = randomUUID()
  const customerId = randomUUID()
  const areaId = randomUUID()
  const friendsTableId = randomUUID()
  const businessTableId = randomUUID()
  const friendsSessionId = randomUUID()
  const businessSessionId = randomUUID()
  const friendsBundleId = randomUUID()
  const businessBundleId = randomUUID()
  const friendsComponentId = randomUUID()
  const businessComponentId = randomUUID()
  let pool: Pool
  let transactions: ScopedPostgresTransactionRunner

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    pool = new Pool({ connectionString: databaseUrl, max: 2 })
    transactions = new ScopedPostgresTransactionRunner(pool as unknown as PostgresPool)
    await pool.query(`INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'Analytics tenant')`, [
      tenantId, `analytics-${tenantId.slice(0,8)}`,
    ])
    await pool.query(`INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1,$2,$3,'Analytics store')`, [
      storeId,tenantId,`analytics-${storeId.slice(0,8)}`,
    ])
    await seedFilterFacts()
  }, 30_000)

  afterAll(async () => { await pool?.end() })

  it('executes all normalized analytics queries without snapshot-based decisions', async () => {
    const view = await transactions.run({ tenantId,storeId }, (transaction) => (
      new CustomerExperienceAnalyticsRepository(transaction).dashboard({
        from: '2026-08-01T00:00:00.000Z',until: '2026-08-08T00:00:00.000Z',
        productId: null,employeeId: null,partySize: null,occasion: null,performancePhase: null,tableCode: null,
        packageProductId: null,
        recommendationOutcome: 'all',
      })
    ), { readOnly: true })
    expect(view).toMatchObject({
      recommendation: [],weeklySuggestions: [],
      dataQuality: { totalInputs: 2,confirmedInputs: 2,unmatchedInputs: 2,correctedEvents: 0 },
    })
    expect(view.products).toHaveLength(2)
    expect(view.packageOptions.map((item) => item.productId).sort()).toEqual([
      businessBundleId,friendsBundleId,
    ].sort())
  })

  it('changes observation, product and quality results for real occasion and package facts', async () => {
    const friends = await dashboard({ occasion:'friends',packageProductId:null })
    const business = await dashboard({ occasion:'business',packageProductId:null })
    const friendsPackage = await dashboard({ occasion:null,packageProductId:friendsBundleId })
    const wrongPackage = await dashboard({ occasion:'business',packageProductId:friendsBundleId })

    expect(friends.dataQuality).toMatchObject({ totalInputs:1,confirmedInputs:1,unmatchedInputs:1 })
    expect(friends.products).toEqual([expect.objectContaining({
      productId:friendsComponentId,observationCount:1,praiseCount:1,
    })])
    expect(business.dataQuality).toMatchObject({ totalInputs:1,confirmedInputs:1,unmatchedInputs:1 })
    expect(business.products).toEqual([expect.objectContaining({
      productId:businessComponentId,observationCount:1,complaintCount:1,
    })])
    expect(friendsPackage.dataQuality.totalInputs).toBe(1)
    expect(friendsPackage.products).toEqual([
      expect.objectContaining({ productId:friendsComponentId,observationCount:1 }),
    ])
    expect(wrongPackage.dataQuality.totalInputs).toBe(0)
    expect(wrongPackage.products).toEqual([])

    const evidence = await transactions.run({ tenantId,storeId }, (transaction) => (
      new CustomerExperienceAnalyticsRepository(transaction).recentObservations({
        from:'2026-08-01T00:00:00.000Z',until:'2026-08-08T00:00:00.000Z',productId:null,
        employeeId:null,partySize:null,occasion:'friends',performancePhase:null,tableCode:null,
        packageProductId:friendsBundleId,recommendationOutcome:'all',
      })
    ), { readOnly:true })
    expect(evidence).toEqual([expect.objectContaining({ tableCode:'A01',eventType:'praise' })])
  })

  function dashboard(overrides: { occasion:string | null;packageProductId:string | null }) {
    return transactions.run({ tenantId,storeId }, (transaction) => (
      new CustomerExperienceAnalyticsRepository(transaction).dashboard({
        from:'2026-08-01T00:00:00.000Z',until:'2026-08-08T00:00:00.000Z',productId:null,
        employeeId:null,partySize:null,occasion:overrides.occasion,performancePhase:null,tableCode:null,
        packageProductId:overrides.packageProductId,recommendationOutcome:'all',
      })
    ), { readOnly:true })
  }

  async function seedFilterFacts() {
    await pool.query(`INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name)
      VALUES($1,$2,$3,'ANALYTICS_EMPLOYEE','分析员工')`,[employeeId,tenantId,storeId])
    await pool.query(`INSERT INTO mbox.customers(id,tenant_id,store_id,public_id,status)
      VALUES($1,$2,$3,'analytics-customer-filter','active')`,[customerId,tenantId,storeId])
    await pool.query(`INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type)
      VALUES($1,$2,$3,'ANALYTICS','分析区','indoor')`,[areaId,tenantId,storeId])
    await pool.query(`INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) VALUES
      ($1,$3,$4,$5,'A01','A01',6),($2,$3,$4,$5,'B01','B01',6)`,[
      friendsTableId,businessTableId,tenantId,storeId,areaId,
    ])
    await pool.query(`INSERT INTO mbox.table_sessions(
      id,tenant_id,store_id,table_id,public_id,business_date,guest_count,status,created_at
    ) VALUES
      ($1,$3,$4,$5,'analytics-friends-session','2026-08-02',4,'open','2026-08-02T12:00:00Z'),
      ($2,$3,$4,$6,'analytics-business-session','2026-08-03',2,'open','2026-08-03T12:00:00Z')`,[
      friendsSessionId,businessSessionId,tenantId,storeId,friendsTableId,businessTableId,
    ])
    await pool.query(`INSERT INTO mbox.products(
      id,tenant_id,store_id,code,name,category_code,fulfillment_station,product_kind,cost_amount_minor,status
    ) VALUES
      ($1,$5,$6,'AN_FRIENDS_BUNDLE','朋友套餐','analytics','none','bundle',3000,'active'),
      ($2,$5,$6,'AN_BUSINESS_BUNDLE','商务套餐','analytics','none','bundle',4000,'active'),
      ($3,$5,$6,'AN_FRIENDS_COMPONENT','朋友套餐饮品','analytics','bar','single',1000,'active'),
      ($4,$5,$6,'AN_BUSINESS_COMPONENT','商务套餐饮品','analytics','bar','single',1500,'active')`,[
      friendsBundleId,businessBundleId,friendsComponentId,businessComponentId,tenantId,storeId,
    ])
    await pool.query(`INSERT INTO mbox.product_bundle_components(
      tenant_id,store_id,bundle_product_id,component_product_id,quantity,sort_order
    ) VALUES($1,$2,$3,$4,1,1),($1,$2,$5,$6,1,1)`,[
      tenantId,storeId,friendsBundleId,friendsComponentId,businessBundleId,businessComponentId,
    ])
    await pool.query(`INSERT INTO mbox.recommendation_sessions(
      tenant_id,store_id,public_id,customer_id,table_session_id,business_date,source,
      party_size,occasion,alcohol_preference,experience_level,service_intensity,created_at
    ) VALUES
      ($1,$2,'analytics-friends-recommendation',$3,$4,'2026-08-02','guest_table',4,'friends','mixed','enhanced','balanced','2026-08-02T12:05:00Z'),
      ($1,$2,'analytics-business-recommendation',$3,$5,'2026-08-03','guest_table',2,'business','mixed','enhanced','balanced','2026-08-03T12:05:00Z')`,[
      tenantId,storeId,customerId,friendsSessionId,businessSessionId,
    ])
    await seedPackageOrder(friendsSessionId,friendsBundleId,friendsComponentId,'friends','2026-08-02T12:06:00Z')
    await seedPackageOrder(businessSessionId,businessBundleId,businessComponentId,'business','2026-08-03T12:06:00Z')
  }

  async function seedPackageOrder(
    tableSessionId:string,bundleId:string,componentId:string,label:string,occurredAt:string,
  ) {
    const orderId=randomUUID(),parentItemId=randomUUID(),childItemId=randomUUID(),inputId=randomUUID()
    await pool.query(`INSERT INTO mbox.orders(
      id,tenant_id,store_id,table_session_id,public_id,channel,status,payment_status,
      subtotal_amount_minor,discount_amount_minor,total_amount_minor,currency,created_by_customer_id,
      submitted_at,settlement_mode,fulfillment_state,created_at
    ) VALUES($1,$2,$3,$4,$5,'guest_qr','submitted','unpaid',8800,0,8800,'CNY',$6,$7,'table_tab','active',$7)`,[
      orderId,tenantId,storeId,tableSessionId,`analytics-${label}-order`,customerId,occurredAt,
    ])
    await pool.query(`INSERT INTO mbox.order_items(
      id,tenant_id,store_id,order_id,product_id,parent_order_item_id,quantity,unit_price_minor,
      discount_amount_minor,total_amount_minor,currency,fulfillment_station,product_snapshot,status,
      unit_cost_minor_at_submission,total_cost_minor_at_submission,cost_source,cost_reference_product_id,
      cost_reference_order_item_id,cost_reference_product_updated_at,loyalty_eligible_at_submission,
      loyalty_eligibility_source,created_at
    ) VALUES
      ($1,$3,$4,$5,$6,NULL,1,8800,0,8800,'CNY','none','{}','submitted',3000,3000,'catalog_product',$6,NULL,$8,true,'catalog_product',$8),
      ($2,$3,$4,$5,$7,$1,1,0,0,0,'CNY','bar','{}','submitted',0,0,'included_in_parent',NULL,$1,NULL,false,'included_in_parent',$8)`,[
      parentItemId,childItemId,tenantId,storeId,orderId,bundleId,componentId,occurredAt,
    ])
    await pool.query(`INSERT INTO mbox.observation_inputs(
      id,tenant_id,store_id,public_id,table_session_id,order_id,recorded_by_employee_id,input_kind,
      raw_content,status,parse_confidence,confirmed_by_employee_id,confirmed_at,created_at,updated_at
    ) VALUES($1,$2,$3,$4,$5,$6,$7,'text',$8,'confirmed',0.9,$7,$9,$9,$9)`,[
      inputId,tenantId,storeId,`analytics-${label}-input`,tableSessionId,orderId,employeeId,
      label==='friends' ? '顾客称赞朋友套餐饮品' : '顾客投诉商务套餐饮品',occurredAt,
    ])
    await pool.query(`INSERT INTO mbox.observation_events(
      tenant_id,store_id,observation_input_id,expression_kind,scope_kind,event_type,product_id,
      order_item_id,confidence,raw_excerpt,confirmation_state,confirmed_by_employee_id,created_at
    ) VALUES($1,$2,$3,'customer_quote','product',$4,$5,$6,0.9,$7,'confirmed',$8,$9)`,[
      tenantId,storeId,inputId,label==='friends' ? 'praise' : 'complaint',componentId,childItemId,
      label==='friends' ? '很好喝' : '不好喝',employeeId,occurredAt,
    ])
  }
})
