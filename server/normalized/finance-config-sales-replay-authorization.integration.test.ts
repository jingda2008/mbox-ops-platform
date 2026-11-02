import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance, type FastifyRequest, type InjectOptions } from 'fastify'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { NormalizedCommandExecutor } from './command-executor.js'
import { commercialOpsApiPlugin } from './commercial-ops-api.js'
import { ProfitQueryService } from './profit-query-service.js'
import { ownerFinanceApiPlugin } from './owner-finance-api.js'
import { ScopedPostgresTransactionRunner, type PostgresPool } from './transaction-runner.js'

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const runtimeUrl = process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL
const integration = databaseUrl && runtimeUrl ? describe : describe.skip
const scope = { tenantId: randomUUID(), storeId: randomUUID() }
const otherStoreId = randomUUID()
const employeeId = randomUUID(), otherEmployeeId = randomUUID(), roleId = randomUUID()
const permissions = ['commercial.cost.manage','commercial.payroll.manage','commercial.payroll.post','inventory.receive','commercial.sales.rule.manage','commercial.sales.attribute']

integration('finance configuration and sales receipt authorization with a restricted PostgreSQL login', () => {
  let admin: Pool, runtime: Pool, app: FastifyInstance
  const session=randomUUID()
  let resolveViaDatabase = false, changeIdentity = false, resolveCount = 0
  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    admin = new Pool({ connectionString: databaseUrl })
    runtime = new Pool({ connectionString: runtimeUrl, max:1, connectionTimeoutMillis:1000 })
    await admin.query("INSERT INTO mbox.tenants(id,code,name) VALUES ($1,$2,'Replay audit')", [scope.tenantId, `replay-${scope.tenantId}`])
    await admin.query("INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES ($1,$2,'replay','Replay audit')", [scope.storeId,scope.tenantId])
    await admin.query("INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES ($1,$2,'other','Other audit store')", [otherStoreId,scope.tenantId])
    await admin.query("INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES ($1,$3,$4,'one','One'),($2,$3,$4,'two','Two')", [employeeId,otherEmployeeId,scope.tenantId,scope.storeId])
    await admin.query("INSERT INTO mbox.roles(id,tenant_id,store_id,code,name) VALUES ($1,$2,$3,'REPLAY','Replay')", [roleId,scope.tenantId,scope.storeId])
    await admin.query('INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id) VALUES ($1,$2,$3,$5),($1,$2,$4,$5)', [scope.tenantId,scope.storeId,employeeId,otherEmployeeId,roleId])
    for (const code of permissions) {
      await admin.query("INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name,category) VALUES ($1,$2,$3,$3,'inventory') ON CONFLICT (tenant_id,store_id,code) DO UPDATE SET status='active'", [scope.tenantId,scope.storeId,code])
      await grant(code)
    }
    const runner = new ScopedPostgresTransactionRunner(runtime as unknown as PostgresPool)
    app = Fastify()
    const resolveContext=async(request:FastifyRequest)=>{
      if(resolveViaDatabase)await runner.run(scope,tx=>tx.query('SELECT 1'))
      const actor=request.headers['x-employee-id']===otherEmployeeId?otherEmployeeId:employeeId
      return {scope:request.headers['x-other-store']?{...scope,storeId:otherStoreId}:scope,
        employeeId:changeIdentity&&++resolveCount>1?otherEmployeeId:actor,businessDate:'2026-11-02',capabilities:[]}
    }
    await app.register(commercialOpsApiPlugin,{prefix:'/api',transactions:runner,commandExecutor:new NormalizedCommandExecutor(runner),queryService:new ProfitQueryService(runner),resolveContext})
    for(const native of [false,true])await app.register(ownerFinanceApiPlugin,{prefix:native?'/native':'/api',transactions:runner,commandExecutor:new NormalizedCommandExecutor(runner),resolveContext,nativeReceipts:native})
    // All orders/tables here belong to this disposable local test store.
    const area=randomUUID(),table=randomUUID(),order=randomUUID()
    await admin.query("INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type) VALUES($1,$2,$3,'AUDIT','Audit','bar')",[area,scope.tenantId,scope.storeId])
    await admin.query("INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) VALUES($1,$2,$3,$4,'AUDIT','Audit',4)",[table,scope.tenantId,scope.storeId,area])
    await admin.query("INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count) VALUES($1::uuid,$2,$3,$4,$1::text,'2026-11-02',1)",[session,scope.tenantId,scope.storeId,table])
    await admin.query("INSERT INTO mbox.orders(id,tenant_id,store_id,table_session_id,public_id,channel) VALUES($1::uuid,$2,$3,$4,$1::text,'staff_assisted')",[order,scope.tenantId,scope.storeId,session])
    await app.ready()
  })
  afterAll(async () => { await app?.close(); await runtime?.end(); await admin?.end() })

  async function grant(code:string) {
    await admin.query('INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) SELECT $1,$2,$3,id FROM mbox.staff_permission_definitions WHERE tenant_id=$1 AND store_id=$2 AND code=$4 ON CONFLICT DO NOTHING', [scope.tenantId,scope.storeId,roleId,code])
  }
  async function without(code:string, run:()=>Promise<void>) {
    await admin.query('DELETE FROM mbox.role_permission_assignments a USING mbox.staff_permission_definitions p WHERE a.permission_id=p.id AND a.role_id=$1 AND p.code=$2', [roleId,code])
    try { await run() } finally { await grant(code) }
  }
  const regular={category:'rent',recognitionState:'actual',allocationPeriod:'month',serviceStartDate:'2026-11-01',serviceEndDate:'2026-11-30',amountMinor:1000,currency:'CNY',sourceType:'lease'}
  const sources=[
    {category:'rent',sourceType:'payroll',permission:'commercial.payroll.manage'},
    {category:'personnel',sourceType:'manual',permission:'commercial.payroll.manage'},
    {category:'rent',sourceType:'inventory_purchase',permission:'inventory.receive'},
    {category:'beverage_purchase',sourceType:'manual',permission:'inventory.receive'},
  ]
  function request(url:string,payload:object):InjectOptions{return{method:'POST',url,headers:{'idempotency-key':`native-business-${randomUUID()}`},payload}}
  const data=(r:Awaited<ReturnType<FastifyInstance['inject']>>,native=false)=>native?r.json().data.result:r.json().data
  async function evidence(){
    const tables=['operating_cost_category_definitions','cost_centers','recurring_operating_cost_rules','employee_compensation_rules','payroll_runs','payroll_lines','operating_cost_entries','employee_sales_rules','employee_sales_attribution_events','audit_events','outbox_messages','orders','order_items','refunds']
    const result:Record<string,unknown>={}
    for(const table of tables)result[table]=(await admin.query(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) AS rows FROM mbox.${table} t WHERE tenant_id=$1`,[scope.tenantId])).rows[0].rows
    return result
  }
  async function denied(req:InjectOptions,status=403){const r=await app.inject(req);expect(r.statusCode,r.body).toBe(status);expect(r.json().data).toBeUndefined()}
  async function revokeAndRecover(req:InjectOptions,permission:string,native=false){
    const first=await app.inject(req);expect([200,201],first.body).toContain(first.statusCode)
    const before=await evidence()
    await without(permission,async()=>{
      await denied(req)
      await denied({...req,headers:{...req.headers,'idempotency-key':`native-business-${randomUUID()}`}})
    })
    const replay=await app.inject(req);expect(replay.statusCode,replay.body).toBe(200)
    expect(native?replay.json().meta.replayed:(replay.json().replayed??replay.json().meta?.replayed)).toBe(true)
    expect(replay.json().data).toEqual(first.json().data)
    expect(await evidence()).toEqual(before)
    return first
  }
  const finance=(native:boolean,path:string,payload:object,headers:Record<string,string>={})=>{
    const req=request(`${native?'/native':'/api'}/commercial-ops/${path}`,payload)
    return {...req,headers:{...req.headers,...headers}}
  }
  const category=(native:boolean)=>finance(native,'cost-categories',{code:`audit_${randomUUID().replaceAll('-','').slice(0,12)}`,name:'Audit category',systemCategory:'rent'})
  async function first(req:InjectOptions,native=false){const r=await app.inject(req);expect(r.statusCode,r.body).toBe(201);return data(r,native)}
  async function recurring(native:boolean){
    const categoryId=(await admin.query("SELECT id FROM mbox.operating_cost_category_definitions WHERE store_id=$1 AND code='rent'",[scope.storeId])).rows[0].id
    const centerId=(await admin.query("SELECT id FROM mbox.cost_centers WHERE store_id=$1 AND code='venue'",[scope.storeId])).rows[0].id
    const payload={name:'Audit rent',categoryDefinitionId:categoryId,costCenterId:centerId,recurrence:'day',allocationPeriod:'day',recognitionState:'accrual',startsOn:'2026-11-01',endsOn:'2026-11-01',netAmountMinor:100,taxAmountMinor:0,sourceType:'lease'}
    return {payload,req:finance(native,'recurring-costs',payload)}
  }
  let payrollYear=2030
  async function payroll(native:boolean){
    const person=randomUUID(),year=payrollYear++
    await admin.query("INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1::uuid,$2,$3,$1::text,'Payroll fixture')",[person,scope.tenantId,scope.storeId])
    const centerId=(await admin.query("SELECT id FROM mbox.cost_centers WHERE store_id=$1 AND code='administration'",[scope.storeId])).rows[0].id
    const compensation=finance(native,'compensation-rules',{employeeId:person,costCenterId:centerId,payBasis:'monthly',baseRateMinor:10000,effectiveFrom:`${year}-01-01`,reason:'Audit salary'}, {'x-owner-compensation':'none'})
    const rule=await first(compensation,native)
    const payload={periodStart:`${year}-01-01`,periodEnd:`${year}-01-31`,lines:[{employeeId:person,compensationRuleId:rule.id,units:'1',bonusMinor:100,deductionMinor:0,employerContributionMinor:0}]}
    return {compensation,payload,req:finance(native,'payroll-runs',payload)}
  }
  it.each([false,true].flatMap(native=>['category','center','recurring-create','recurring-update','recurring-status','materialize','compensation','payroll-create','payroll-edit','approve','void','post'].map(kind=>({native,kind}))))('requires current permission for $kind, native=$native',async({native,kind})=>{
    let req:InjectOptions,permission='commercial.cost.manage'
    if(kind==='category')req=category(native)
    else if(kind==='center')req=finance(native,'cost-centers',{code:`audit_${randomUUID().replaceAll('-','').slice(0,12)}`,name:'Audit center'})
    else if(kind.startsWith('recurring')||kind==='materialize'){
      const fixture=await recurring(native)
      if(kind==='recurring-create')req=fixture.req
      else {
        const rule=await first(fixture.req,native)
        req=kind==='recurring-update'?finance(native,'recurring-costs',{...fixture.payload,ruleId:rule.id,expectedVersion:1,changeReason:'Audit update',netAmountMinor:200}):kind==='recurring-status'?finance(native,`recurring-costs/${rule.id}/status`,{status:'paused',reason:'Audit pause'},{'x-owner-version':'1'}):finance(native,'recurring-costs/materialize',{throughDate:'2026-11-01'})
      }
    }else{
      permission=kind==='post'?'commercial.payroll.post':'commercial.payroll.manage'
      const fixture=await payroll(native)
      if(kind==='compensation')req=fixture.compensation // Already committed; exercise the same original receipt.
      else if(kind==='payroll-create')req=fixture.req
      else{
        const run=await first(fixture.req,native)
        if(kind==='post')await first(finance(native,`payroll-runs/${run.id}/approve`,{reason:'Audit approve'},{'x-owner-version':'1'}),native)
        req=kind==='payroll-edit'?finance(native,'payroll-runs',{...fixture.payload,draftRunId:run.id,expectedVersion:1,replaceEmployeeLine:true}):finance(native,`payroll-runs/${run.id}/${kind}`,{reason:'Audit payroll action'},{'x-owner-version':kind==='post'?'2':'1'})
      }
    }
    await revokeAndRecover(req,permission,native)
    if(native){
      const key=(req.headers as Record<string,string>)['idempotency-key']
      const row=(await admin.query("UPDATE mbox.idempotency_records SET created_at=clock_timestamp()-interval '90 days' WHERE tenant_id=$1 AND idempotency_key=$2 RETURNING expires_at::text",[scope.tenantId,key])).rows[0]
      expect(row.expires_at).toBe('infinity')
      await without(permission,()=>denied(req))
      expect((await app.inject(req)).json().meta.replayed).toBe(true)
    }
  })
  it.each(sources.flatMap(source=>['create','original','replacement'].map(side=>({...source,side}))))('checks native expense $side source: $category / $sourceType',async source=>{
    const {permission,side,...input}=source
    let req=finance(true,'costs',{...regular,...input})
    if(side!=='create'){
      const original=await first(finance(true,'costs',{...regular,...(side==='original'?input:{})}),true)
      req=finance(true,`costs/${original.id}/corrections`,{...regular,...(side==='replacement'?input:{}),amountMinor:1100,correctionReason:'Audit reclassification'})
    }
    await revokeAndRecover(req,permission,true)
  })
  it.each([false,true])('keeps expense configuration available without payroll/receiving rights, native=%s',async native=>{
    await without('commercial.payroll.manage',()=>without('commercial.payroll.post',()=>without('inventory.receive',()=>revokeAndRecover(category(native),'commercial.cost.manage',native).then(()=>{}))))
  })
  it.each([false,true])('resolves identity outside a single connection transaction, native=%s',async native=>{
    resolveViaDatabase=true
    try{await revokeAndRecover(category(native),'commercial.cost.manage',native)}finally{resolveViaDatabase=false}
  })
  it.each([false,true])('rejects changed identity before claiming a receipt, native=%s',async native=>{
    const before=await evidence();changeIdentity=true;resolveCount=0
    try{await denied(category(native))}finally{changeIdentity=false}
    expect(await evidence()).toEqual(before)
  })
  it.each([false,true])('protects actor/store scope and suspended employees, native=%s',async native=>{
    const req=category(native);await first(req,native);const before=await evidence()
    await denied({...req,headers:{...req.headers,'x-employee-id':otherEmployeeId}},409)
    await denied({...req,headers:{...req.headers,'x-other-store':'true'}},401)
    await admin.query("UPDATE mbox.employees SET status='suspended' WHERE id=$1",[employeeId])
    try{await denied(req)}finally{await admin.query("UPDATE mbox.employees SET status='active' WHERE id=$1",[employeeId])}
    expect(await evidence()).toEqual(before)
  })
  async function salesRule(){
    const product=randomUUID()
    await admin.query("INSERT INTO mbox.products(id,tenant_id,store_id,code,name,category_code,fulfillment_station) VALUES($1::uuid,$2,$3,$1::text,'Audit sales','wine','bar')",[product,scope.tenantId,scope.storeId])
    const payload={productId:product,attributionMode:'explicit',salesCreditBps:1000,costSource:'none',effectiveFrom:'2026-11-01T00:00:00Z',effectiveUntil:'2026-12-01T00:00:00Z',reason:'Audit sales rule'}
    return {product,req:request('/api/commercial-ops/sales-rules',payload),payload}
  }
  async function sale(){
    const rule=await salesRule();await first(rule.req)
    const order=randomUUID(),item=randomUUID(),payment=randomUUID(),refund=randomUUID()
    await admin.query("INSERT INTO mbox.orders(id,tenant_id,store_id,table_session_id,public_id,channel,status,payment_status,subtotal_amount_minor,total_amount_minor,created_at) VALUES($1::uuid,$2,$3,$4,$1::text,'staff_assisted','completed','paid',10000,10000,'2026-11-02T12:00:00Z')",[order,scope.tenantId,scope.storeId,session])
    await admin.query("INSERT INTO mbox.order_items(id,tenant_id,store_id,order_id,product_id,quantity,unit_price_minor,total_amount_minor,fulfillment_station,status,product_snapshot) VALUES($1,$2,$3,$4,$5,2,5000,10000,'bar','delivered','{}')",[item,scope.tenantId,scope.storeId,order,rule.product])
    await admin.query("INSERT INTO mbox.payments(id,tenant_id,store_id,order_id,public_id,provider,provider_transaction_id,method,amount_minor,currency,status,succeeded_at) VALUES($1::uuid,$2,$3,$4,$1::text,'simulation',$1::text,'native_qr',10000,'CNY','succeeded',clock_timestamp())",[payment,scope.tenantId,scope.storeId,order])
    await admin.query("INSERT INTO mbox.refunds(id,tenant_id,store_id,payment_id,public_id,provider_refund_id,amount_minor,currency,status,reason,requested_by_employee_id,approved_by_employee_id,decision_reason,completed_at) VALUES($1::uuid,$2,$3,$4,$1::text,$1::text,5000,'CNY','succeeded','Audit refund',$5,$6,'Audit approval',clock_timestamp())",[refund,scope.tenantId,scope.storeId,payment,employeeId,otherEmployeeId])
    await admin.query("INSERT INTO mbox.refund_items(tenant_id,store_id,refund_id,order_item_id,amount_minor,currency) VALUES($1,$2,$3,$4,5000,'CNY')",[scope.tenantId,scope.storeId,refund,item])
    await admin.query("INSERT INTO mbox.reconciliation_entries(tenant_id,store_id,payment_id,refund_id,entry_type,provider,provider_reference,amount_minor,currency,business_date,occurred_at) VALUES($1,$2,$3,$4::uuid,'refund','simulation',$4::text,-5000,'CNY','2026-11-02',clock_timestamp())",[scope.tenantId,scope.storeId,payment,refund])
    return {order,item,refund,req:request('/api/commercial-ops/sales-attributions',{orderItemId:item,employeeId})}
  }
  it('reauthorizes sales rule receipts and preserves conflict/overlap validation',async()=>{
    const rule=await salesRule();await revokeAndRecover(rule.req,'commercial.sales.rule.manage')
    await denied({...rule.req,payload:{...rule.payload,salesCreditBps:2000}},409)
    await denied({...rule.req,headers:{'idempotency-key':randomUUID()}},409)
    await denied({...rule.req,headers:{...rule.req.headers,'x-employee-id':otherEmployeeId}},409)
    await denied({...rule.req,headers:{...rule.req.headers,'x-other-store':'true'}},401)
  })
  it('reauthorizes sales attribution receipts without recording another attribution',async()=>{
    const fixture=await sale();await revokeAndRecover(fixture.req,'commercial.sales.attribute')
  })
  it('reauthorizes refund reversal receipts without reversing sales twice',async()=>{
    const fixture=await sale();await first(fixture.req)
    const r=await revokeAndRecover(request(`/api/commercial-ops/refunds/${fixture.refund}/sales-reversal`,{}),'commercial.sales.attribute')
    expect(r.json().data.reversals).toHaveLength(1)
    expect(r.json().data.reversals[0].salesAmountDeltaMinor).toBe(-500)
  })
  it.each([false,true])('posting keeps its dedicated permission independent of payroll editing, native=%s',async native=>{
    const fixture=await payroll(native),run=await first(fixture.req,native)
    await first(finance(native,`payroll-runs/${run.id}/approve`,{reason:'Audit approve'},{'x-owner-version':'1'}),native)
    await without('commercial.payroll.manage',()=>revokeAndRecover(finance(native,`payroll-runs/${run.id}/post`,{reason:'Audit posting'},{'x-owner-version':'2'}),'commercial.payroll.post',native).then(()=>{}))
  })
  it.each(['attribution','reversal'])('still rejects uncommitted invalid sales state: %s',async kind=>{
    const fixture=await sale()
    let req=fixture.req
    if(kind==='attribution')await admin.query("UPDATE mbox.orders SET payment_status='unpaid' WHERE id=$1",[fixture.order])
    else{
      await first(req)
      await admin.query("UPDATE mbox.refunds SET status='failed' WHERE id=$1",[fixture.refund])
      req=request(`/api/commercial-ops/refunds/${fixture.refund}/sales-reversal`,{})
    }
    const before=await evidence()
    await denied(req,400)
    expect(await evidence()).toEqual(before)
  })
})
