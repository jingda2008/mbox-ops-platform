import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { ScopedPostgresTransactionRunner } from './transaction-runner.js'
import { ProfitQueryService } from './profit-query-service.js'
import { CommercialOpsRepository } from './commercial-ops-repository.js'

const database=process.env.TEST_NORMALIZED_DATABASE_URL
;(database?describe:describe.skip)('operating dashboard authoritative sources under restricted LOGIN',()=>{
  const scope={tenantId:randomUUID(),storeId:randomUUID()},customer=randomUUID(),employee=randomUUID(),reviewer=randomUUID(),activity=randomUUID()
  let admin:Pool,runtime:Pool,runner:ScopedPostgresTransactionRunner,service:ProfitQueryService,today:string
  beforeAll(async()=>{
    await runNormalizedMigrations(database!)
    admin=new Pool({connectionString:database});runtime=new Pool({connectionString:process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL??database})
    runner=new ScopedPostgresTransactionRunner(runtime);service=new ProfitQueryService(runner)
    await admin.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1::uuid,$1::text,'Dashboard')",[scope.tenantId])
    await admin.query("INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1::uuid,$2,$1::text,'Dashboard')",[scope.storeId,scope.tenantId])
    await admin.query("INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$3,$4,'DF','Finance'),($2,$3,$4,'DR','Review')",[employee,reviewer,scope.tenantId,scope.storeId])
    await admin.query("INSERT INTO mbox.customers(id,tenant_id,store_id,public_id) VALUES($1::uuid,$2,$3,$1::text)",[customer,scope.tenantId,scope.storeId])
    await admin.query(`INSERT INTO mbox.community_activities(id,tenant_id,store_id,public_id,activity_kind,title,summary,starts_at,ends_at,assembly_location,capacity,fee_amount_minor,deposit_amount_minor,fee_basis,registration_payment_mode,payment_deadline_minutes,payment_rule_text,currency,points_reward,visibility,safety_policy_version,safety_acknowledgement_text,safety_requirements,refund_policy_version,refund_policy_summary,activity_details,included_items,participation_requirements,contact_instructions,status,published_at,created_by_employee_id,approved_by_employee_id)
      VALUES($1::uuid,$2,$3,$1::text,'member_night','经营测试','完整来源',clock_timestamp()-interval '1 day',clock_timestamp()+interval '1 day','门口',1000,0,0,'per_registration','none',15,'免费活动','CNY',0,'public','activity-safety-v1','已知安全规则',ARRAY['年满18周岁'],'activity-refund-v1','按原退款约定','现场音乐、交流与限定饮品体验。',ARRAY['欢迎饮品'],ARRAY['提前到场'],'查看集合通知','published',clock_timestamp(),$4,$4)`,[activity,scope.tenantId,scope.storeId,employee])
    today=await runner.run(scope,async tx=>(await tx.query<{day:string}>('SELECT mbox.current_operating_business_date($1,$2)::text AS day',[scope.tenantId,scope.storeId])).rows[0]!.day)
  })
  afterAll(async()=>{await runtime?.end();await admin?.end()})
  async function product(cost:number|null){const id=randomUUID();await admin.query(`INSERT INTO mbox.products(id,tenant_id,store_id,code,name,category_code,fulfillment_station,inventory_control_mode,cost_amount_minor) VALUES($1::uuid,$2,$3,$1::text,'活动菜品','food','kitchen','not_managed',$4)`,[id,scope.tenantId,scope.storeId,cost]);return id}
  async function purchase(date:string,items:Array<{productId:string;quantity:number}>,options:{parent?:string;pending?:boolean;free?:boolean;hasMeal?:boolean}={}){
    const id=randomUUID(),kind=options.parent?'single_dish':'admission_package',amount=options.free?0:5000
    await runner.run(scope,tx=>tx.query(`INSERT INTO mbox.community_activity_registrations(id,tenant_id,store_id,public_id,activity_id,customer_id,party_size,status,payment_choice,payment_status,fee_amount_minor,amount_due_minor,paid_amount_minor,currency,safety_acknowledgement,idempotency_key,refund_policy_snapshot,acknowledged_safety_policy_version,acknowledged_refund_policy_version,terms_acknowledged_at,terms_acknowledgement_source,requested_payment_choice,requested_payment_method,requested_amount_due_minor,payment_due_at,seat_hold_expires_at,service_version,reserved_seats,max_participants,includes_admission,parent_registration_id,purchase_kind,service_items_snapshot,service_has_meal,registered_at)
      VALUES($1::uuid,$2,$3,$1::text,$4,$5,1,$6,$7,$8,$9,CASE WHEN $6='payment_pending' THEN $9::bigint ELSE 0 END,$10,'CNY','{}',$1::text,'{"policyVersion":"activity-refund-v1"}','activity-safety-v1','activity-refund-v1',clock_timestamp(),'staff_assisted',$7,CASE WHEN $7='none' THEN NULL ELSE 'jsapi' END,$9,CASE WHEN $6='payment_pending' THEN clock_timestamp()+interval '15 minutes' ELSE NULL END,CASE WHEN $6='payment_pending' THEN clock_timestamp()+interval '15 minutes' ELSE NULL END,3,$11,5,$12,$13,$14,$15::jsonb,$16,$17::date+interval '12 hours')`,
      [id,scope.tenantId,scope.storeId,activity,customer,options.pending?'payment_pending':'confirmed',options.free?'none':'full',options.pending?'pending':options.free?'not_required':'paid',amount,options.free||options.pending?0:amount,options.parent?0:5,!options.parent,options.parent??null,kind,JSON.stringify(items.map(x=>({...x,name:'测试菜',station:'kitchen'}))),options.hasMeal??items.length>0,date]))
    return id
  }
  async function payment(registration:string,day:string,amount=5000,cycle=1){const id=randomUUID();await admin.query(`INSERT INTO mbox.payments(id,tenant_id,store_id,payable_kind,activity_registration_id,activity_registration_cycle,public_id,provider,provider_transaction_id,method,amount_minor,currency,status,succeeded_at) VALUES($1::uuid,$2,$3,'activity_registration',$4,$6,$1::text,'simulation',$1::text,'native_qr',$5,'CNY','succeeded',clock_timestamp())`,[id,scope.tenantId,scope.storeId,registration,amount,cycle]);await admin.query(`INSERT INTO mbox.reconciliation_entries(tenant_id,store_id,payment_id,entry_type,provider,provider_reference,amount_minor,currency,business_date,occurred_at) VALUES($1,$2,$3::uuid,'payment','simulation',$3::text,$4,'CNY',$5::date,clock_timestamp())`,[scope.tenantId,scope.storeId,id,amount,day]);return id}

  it('runs reporting and new evidence capture with the restricted runtime role',async()=>{
    if(process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL)expect((await runtime.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]).toEqual({rolsuper:false,rolbypassrls:false})
    const p=await product(123),r=await purchase('2026-07-01',[{productId:p,quantity:2}]);await payment(r,'2026-07-01')
    await admin.query('UPDATE mbox.products SET cost_amount_minor=999 WHERE id=$1',[p])
    const report=await service.getProfitReport(scope,'day','2026-07-01')
    expect(report.dashboard).toMatchObject({incomeMinor:5000,totalCostMinor:246,operatingProfitMinor:4754,actualNetReceiptsMinor:5000,validOrderCount:1,paidOrderCount:1})
    expect((await admin.query('SELECT goods_cost_minor FROM mbox.activity_purchase_finance WHERE registration_id=$1',[r])).rows[0].goods_cost_minor).toBe('246')
    await expect(admin.query('UPDATE mbox.activity_purchase_finance SET goods_cost_minor=1 WHERE registration_id=$1',[r])).rejects.toThrow('immutable')
    expect(report.incomeBreakdown).toEqual([{code:'admission_package',label:'活动报名套餐',amountMinor:5000,count:1,missingCount:0}])
  })
  it('attributes later refunds to their original purchase, separately from refund-day cash',async()=>{
    const r=await purchase('2026-07-02',[]),p=await payment(r,'2026-07-02'),f=randomUUID()
    await admin.query(`INSERT INTO mbox.refunds(id,tenant_id,store_id,payment_id,public_id,provider_refund_id,amount_minor,currency,status,reason,requested_by_employee_id,approved_by_employee_id,decision_reason,completed_at) VALUES($1::uuid,$2,$3,$4,$1::text,$1::text,1000,'CNY','succeeded','部分补偿',$5,$6,'独立复核',clock_timestamp())`,[f,scope.tenantId,scope.storeId,p,employee,reviewer])
    await admin.query(`INSERT INTO mbox.reconciliation_entries(tenant_id,store_id,payment_id,refund_id,entry_type,provider,provider_reference,amount_minor,currency,business_date,occurred_at) VALUES($1,$2,$3,$4::uuid,'refund','simulation',$4::text,-1000,'CNY','2026-07-03',clock_timestamp())`,[scope.tenantId,scope.storeId,p,f])
    expect((await service.getProfitReport(scope,'day','2026-07-02')).dashboard).toMatchObject({incomeMinor:4000,actualNetReceiptsMinor:5000})
    expect((await service.getProfitReport(scope,'day','2026-07-03')).dashboard).toMatchObject({incomeMinor:0,actualNetReceiptsMinor:-1000,successfulRefundsMinor:1000})
  })
  it('preserves a pre-finance legacy cycle date before re-registration and attributes its later refund to that cycle',async()=>{
    const packageId=randomUUID()
    await admin.query(`INSERT INTO mbox.community_activity_packages(id,tenant_id,store_id,activity_id,public_id,name,capacity)
      VALUES($1::uuid,$2,$3,$4,$1::text,'旧活动套餐',100)`,[packageId,scope.tenantId,scope.storeId,activity])
    let old:string
    // Represent a registration already present when 282 is installed: no finance
    // trigger existed on that original INSERT. All mutations below use the new trigger.
    await admin.query('ALTER TABLE mbox.community_activity_registrations DISABLE TRIGGER freeze_activity_purchase_finance')
    try {
      old=await purchase('2026-07-17',[],{pending:true})
      await admin.query(`UPDATE mbox.community_activity_registrations SET service_version=1,
        reserved_seats=NULL,max_participants=NULL,purchase_kind=NULL,activity_package_id=$2::uuid,
        activity_package_snapshot=jsonb_build_object('publicId',$2::uuid,'name','旧活动套餐','feeAmountMinor',5000,'paymentMode','full_required') WHERE id=$1`,[old,packageId])
    } finally { await admin.query('ALTER TABLE mbox.community_activity_registrations ENABLE TRIGGER freeze_activity_purchase_finance') }
    expect((await admin.query('SELECT id FROM mbox.activity_purchase_finance WHERE registration_id=$1',[old!])).rows).toHaveLength(0)
    await runner.run(scope,tx=>tx.query("UPDATE mbox.community_activity_registrations SET registration_cycle=2,registered_at='2026-07-18 12:00:00+00',status='confirmed',payment_status='paid',amount_due_minor=0,paid_amount_minor=5000 WHERE id=$1",[old!]))
    // A prior pending cycle can receive a late channel success after re-registration.
    const oldPayment=await payment(old!,'2026-07-17')
    await payment(old!,'2026-07-18',5000,2)
    const preserved=(await admin.query('SELECT registration_cycle,business_date::text,purchased_at,goods_cost_minor,missing_cost_count FROM mbox.activity_purchase_finance WHERE registration_id=$1 ORDER BY registration_cycle',[old!])).rows
    expect(preserved).toHaveLength(2)
    expect(preserved[0]).toMatchObject({registration_cycle:1,business_date:'2026-07-17',goods_cost_minor:null,missing_cost_count:1})
    expect(preserved[1]).toMatchObject({registration_cycle:2,business_date:'2026-07-18',goods_cost_minor:null,missing_cost_count:1})
    const refundId=randomUUID()
    await admin.query(`INSERT INTO mbox.refunds(id,tenant_id,store_id,payment_id,public_id,provider_refund_id,amount_minor,currency,status,reason,requested_by_employee_id,approved_by_employee_id,decision_reason,completed_at)
      VALUES($1::uuid,$2,$3,$4,$1::text,$1::text,5000,'CNY','succeeded','旧周期迟到款退回',$5,$6,'独立复核',clock_timestamp())`,[refundId,scope.tenantId,scope.storeId,oldPayment,employee,reviewer])
    await admin.query(`INSERT INTO mbox.reconciliation_entries(tenant_id,store_id,payment_id,refund_id,entry_type,provider,provider_reference,amount_minor,currency,business_date,occurred_at)
      VALUES($1,$2,$3,$4::uuid,'refund','simulation',$4::text,-5000,'CNY','2026-08-02',clock_timestamp())`,[scope.tenantId,scope.storeId,oldPayment,refundId])
    const original=await service.getProfitReport(scope,'day','2026-07-17')
    expect(original.dashboard).toMatchObject({incomeMinor:0,actualNetReceiptsMinor:5000})
    expect(original.unassignedIncomeCount).toBe(0)
    expect((await service.getProfitReport(scope,'day','2026-07-18')).dashboard?.incomeMinor).toBe(5000)
    expect((await service.getProfitReport(scope,'day','2026-08-02')).dashboard).toMatchObject({incomeMinor:0,actualNetReceiptsMinor:-5000,successfulRefundsMinor:5000})
    await expect(admin.query('UPDATE mbox.activity_purchase_finance SET purchased_at=clock_timestamp() WHERE registration_id=$1 AND registration_cycle=1',[old!])).rejects.toThrow('immutable')
  })
  it('never overwrites a previously captured cycle while freezing the new purchase at its own current cost',async()=>{
    const productId=await product(77),registration=await purchase('2026-07-19',[{productId,quantity:2}])
    await admin.query('UPDATE mbox.products SET cost_amount_minor=99 WHERE id=$1',[productId])
    await runner.run(scope,tx=>tx.query("UPDATE mbox.community_activity_registrations SET registration_cycle=2,registered_at='2026-07-20 12:00:00+00' WHERE id=$1",[registration]))
    expect((await admin.query('SELECT registration_cycle,business_date::text,goods_cost_minor,missing_cost_count FROM mbox.activity_purchase_finance WHERE registration_id=$1 ORDER BY registration_cycle',[registration])).rows).toEqual([
      {registration_cycle:1,business_date:'2026-07-19',goods_cost_minor:'154',missing_cost_count:0},
      {registration_cycle:2,business_date:'2026-07-20',goods_cost_minor:'198',missing_cost_count:0},
    ])
  })
  it('uses the add-on own purchase day, counts missing costs, and leaves zero genuine',async()=>{
    const parent=await purchase('2026-07-04',[]);await payment(parent,'2026-07-04')
    const p=await product(null),child=await purchase('2026-07-05',[{productId:p,quantity:1}],{parent});await payment(child,'2026-07-05')
    const report=await service.getProfitReport(scope,'day','2026-07-05',{kind:'cost',includeCostDetails:true})
    expect(report.dashboard?.incomeMinor).toBe(5000);expect(report.knownMissingCostCount).toBe(1);expect(report.status).toBe('provisional')
    expect(report.sources?.rows).toContainEqual(expect.objectContaining({publicId:child,amountMinor:null,missingCount:1}))
    const z=await product(0),free=await purchase('2026-07-06',[{productId:z,quantity:1}],{free:true})
    expect((await service.getProfitReport(scope,'day','2026-07-06',{kind:'cost',includeCostDetails:true})).sources?.rows).toContainEqual(expect.objectContaining({publicId:free,amountMinor:0,missingCount:0}))
  })
  it('aggregates all sources before paging and excludes expired pending attempts from debt',async()=>{
    await Promise.all(Array.from({length:107},()=>purchase('2026-07-07',[],{pending:true})))
    const expired=await purchase('2026-07-07',[],{pending:true})
    await admin.query("UPDATE mbox.community_activity_registrations SET payment_due_at=clock_timestamp()-interval '1 minute' WHERE id=$1",[expired])
    const a=await service.getProfitReport(scope,'day','2026-07-07',{kind:'outstanding'}),b=await service.getProfitReport(scope,'day','2026-07-07',{kind:'outstanding',page:2})
    expect(a.dashboard?.periodOutstandingMinor).toBe(107*5000);expect(a.sources).toMatchObject({total:107,hasMore:true});expect(a.sources?.rows).toHaveLength(50)
    expect(b.sources?.rows).toHaveLength(7);expect(b.dashboard).toEqual(a.dashboard)
  })
  it('clips current period costs to the current business date and rejects future periods',async()=>{
    const start=today.slice(0,8)+'01',end=new Date(Date.UTC(Number(today.slice(0,4)),Number(today.slice(5,7)),0)).toISOString().slice(0,10)
    await runner.run(scope,tx=>new CommercialOpsRepository(tx).createCost({publicId:randomUUID(),category:'rent',recognitionState:'actual',allocationPeriod:'month',serviceStartDate:start,serviceEndDate:end,cashPaidOn:null,netAmountMinor:3100,taxAmountMinor:0,currency:'CNY',sourceType:'manual',sourceSnapshot:{},recordedByEmployeeId:employee,recordedBusinessDate:today}))
    const report=await service.getProfitReport(scope,'month',today,{kind:'cost',includeCostDetails:true})
    expect(report.sources?.rows.filter(row=>row.sourceType==='operating_cost')).toHaveLength(1)
    expect(report.sources?.rows.find(row=>row.sourceType==='operating_cost')).toMatchObject({originalAmountMinor:3100})
    expect(report.range.endDate).toBe(today);expect(report.requestedEndDate).toBe(end);expect(report.trend?.at(-1)?.businessDate).toBe(today)
    expect(report.dashboard?.totalCostMinor).toBe(Math.floor(3100/Number(end.slice(8)))*Number(today.slice(8))+Math.min(3100%Number(end.slice(8)),Number(today.slice(8))))
    await expect(service.getProfitReport(scope,'day','2099-01-01')).rejects.toThrow('未来')
  })
  it('separates provider fees from receipts and retains a negative profit for free meals',async()=>{
    const r=await purchase('2026-07-10',[]),p=await payment(r,'2026-07-10')
    await admin.query(`INSERT INTO mbox.reconciliation_entries(tenant_id,store_id,payment_id,entry_type,provider,provider_reference,amount_minor,currency,business_date,occurred_at)
      VALUES($1,$2,$3::uuid,'fee','simulation',$3::text||'-fee',-100,'CNY','2026-07-10',clock_timestamp())`,[scope.tenantId,scope.storeId,p])
    expect((await service.getProfitReport(scope,'day','2026-07-10')).dashboard).toMatchObject({incomeMinor:5000,actualNetReceiptsMinor:5000,totalCostMinor:100,operatingProfitMinor:4900})
    await purchase('2026-07-11',[{productId:await product(80),quantity:1}],{free:true})
    expect((await service.getProfitReport(scope,'day','2026-07-11')).dashboard).toMatchObject({incomeMinor:0,totalCostMinor:80,operatingProfitMinor:-80})
  })
  it('does not infer adjustment classification or expose protected cost detail in the default projection',async()=>{
    const r=await purchase('2026-07-12',[{productId:await product(30),quantity:1}]),p=await payment(r,'2026-07-12')
    await admin.query(`INSERT INTO mbox.reconciliation_entries(tenant_id,store_id,payment_id,entry_type,provider,provider_reference,amount_minor,currency,business_date,occurred_at)
      VALUES($1,$2,$3::uuid,'adjustment','simulation',$3::text||'-adjust',200,'CNY','2026-07-12',clock_timestamp())`,[scope.tenantId,scope.storeId,p])
    const report=await service.getProfitReport(scope,'day','2026-07-12')
    expect(report.dashboard).toMatchObject({incomeMinor:5000,actualNetReceiptsMinor:5000,totalCostMinor:30})
    expect(report.unassignedIncomeCount).toBe(1);expect(report.status).toBe('provisional')
    expect(report.sources?.rows.some(row=>row.kind==='cost')).toBe(false)
    expect(report.sources?.rows.find(row=>row.category==='unassigned')).toMatchObject({amountMinor:null,originalAmountMinor:200})
  })
  it('keeps compensated meal costs and does not reopen collection after full financial refund',async()=>{
    const r=await purchase('2026-07-14',[{productId:await product(200),quantity:2}]),p=await payment(r,'2026-07-14'),f=randomUUID()
    await admin.query(`INSERT INTO mbox.refunds(id,tenant_id,store_id,payment_id,public_id,provider_refund_id,amount_minor,currency,status,reason,requested_by_employee_id,approved_by_employee_id,decision_reason,completed_at,activity_disposition,activity_customer_confirmed)
      VALUES($1::uuid,$2,$3,$4,$1::text,$1::text,5000,'CNY','succeeded','全额补偿保留履约',$5,$6,'已核实',clock_timestamp(),'retain_fulfillment',true)`,[f,scope.tenantId,scope.storeId,p,employee,reviewer])
    await admin.query(`INSERT INTO mbox.reconciliation_entries(tenant_id,store_id,payment_id,refund_id,entry_type,provider,provider_reference,amount_minor,currency,business_date,occurred_at)
      VALUES($1,$2,$3,$4::uuid,'refund','simulation',$4::text,-5000,'CNY','2026-07-15',clock_timestamp())`,[scope.tenantId,scope.storeId,p,f])
    await runner.run(scope,tx=>tx.query("UPDATE mbox.community_activity_registrations SET payment_status='refunded',service_refund_disposition='retain_fulfillment' WHERE id=$1",[r]))
    expect((await service.getProfitReport(scope,'day','2026-07-14')).dashboard).toMatchObject({incomeMinor:0,totalCostMinor:400,operatingProfitMinor:-400,periodOutstandingMinor:0})
  })
  it('marks a captured activity payment without a ledger receipt as a known gap',async()=>{
    const r=await purchase('2026-07-16',[]),id=randomUUID()
    await admin.query(`INSERT INTO mbox.payments(id,tenant_id,store_id,payable_kind,activity_registration_id,activity_registration_cycle,public_id,provider,provider_transaction_id,method,amount_minor,currency,status,succeeded_at)
      VALUES($1::uuid,$2,$3,'activity_registration',$4,1,$1::text,'simulation',$1::text,'native_qr',5000,'CNY','succeeded',clock_timestamp())`,[id,scope.tenantId,scope.storeId,r])
    const report=await service.getProfitReport(scope,'day','2026-07-16')
    expect(report.unreconciledActivityPaymentsMinor).toBe(5000);expect(report.gaps.unreconciledCapturedPaymentsMinor).toBe(5000)
    expect(report.status).toBe('provisional');expect(report.dashboard?.actualReceiptsMinor).toBe(0)
  })
  it('uses the existing manual business-day boundary and keeps earlier purchase dates frozen',async()=>{
    const p=await product(20),r=await purchase('2026-07-13',[{productId:p,quantity:1}])
    const next=new Date(Date.parse(today+'T00:00:00Z')+86400000).toISOString().slice(0,10)
    await admin.query(`INSERT INTO mbox.manual_business_day_ends(tenant_id,store_id,business_date,next_business_date,calendar_business_date,employee_id,reason,ledger_snapshot)
      VALUES($1,$2,$3::date,$4::date,$3::date,$5,'测试营业日边界','[]')`,[scope.tenantId,scope.storeId,today,next,employee])
    const report=await service.getProfitReport(scope,'day',next)
    expect(report.currentBusinessDate).toBe(next)
    await runner.run(scope,tx=>tx.query('UPDATE mbox.community_activity_registrations SET registered_at=clock_timestamp() WHERE id=$1',[r]))
    expect((await admin.query('SELECT business_date::text FROM mbox.activity_purchase_finance WHERE registration_id=$1',[r])).rows[0].business_date).toBe('2026-07-13')
  })
  it('replaces a full corrected cost across periods without resurrecting the original',async()=>{
    const original=await runner.run(scope,tx=>new CommercialOpsRepository(tx).createCost({publicId:randomUUID(),category:'miscellaneous',recognitionState:'actual',allocationPeriod:'day',serviceStartDate:'2026-07-08',serviceEndDate:'2026-07-08',cashPaidOn:null,netAmountMinor:100,taxAmountMinor:0,currency:'CNY',sourceType:'manual',sourceSnapshot:{},recordedByEmployeeId:employee,recordedBusinessDate:today}))
    await runner.run(scope,tx=>new CommercialOpsRepository(tx).correctCost(original.id,{publicId:randomUUID(),category:'miscellaneous',recognitionState:'actual',allocationPeriod:'day',serviceStartDate:'2026-07-09',serviceEndDate:'2026-07-09',cashPaidOn:null,netAmountMinor:250,taxAmountMinor:0,currency:'CNY',sourceType:'manual',sourceSnapshot:{},recordedByEmployeeId:employee,recordedBusinessDate:today},'日期金额更正'))
    expect((await service.getProfitReport(scope,'day','2026-07-08')).dashboard?.totalCostMinor).toBe(0)
    expect((await service.getProfitReport(scope,'day','2026-07-09')).dashboard?.totalCostMinor).toBe(250)
  })
})
