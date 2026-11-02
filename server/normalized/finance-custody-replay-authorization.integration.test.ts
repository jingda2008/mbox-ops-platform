import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance, type FastifyRequest, type InjectOptions } from 'fastify'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { NormalizedCommandExecutor } from './command-executor.js'
import { commercialOpsApiPlugin } from './commercial-ops-api.js'
import { ProfitQueryService } from './profit-query-service.js'
import { bottleCustodyApiPlugin } from './bottle-custody-api.js'
import { createActivityContactProtectionKeyring } from './personal-contact-protection.js'
import { ScopedPostgresTransactionRunner, type PostgresPool } from './transaction-runner.js'

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const runtimeUrl = process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL
const integration = databaseUrl && runtimeUrl ? describe : describe.skip
const scope = { tenantId: randomUUID(), storeId: randomUUID() }
const otherStoreId = randomUUID()
const employeeId = randomUUID(), otherEmployeeId = randomUUID(), roleId = randomUUID()
const permissions = ['commercial.cost.manage','commercial.payroll.manage','inventory.receive','bottle.manage.all','bottle.custody.export','order.history.all']

integration('finance and custody receipt authorization with a restricted PostgreSQL login', () => {
  let admin: Pool, runtime: Pool, app: FastifyInstance
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
    const protection=createActivityContactProtectionKeyring(null,'audit-local-only-no-production-secret')
    for(const native of [false,true])await app.register(bottleCustodyApiPlugin,{prefix:native?'/native':'/api',transactions:runner,commands:new NormalizedCommandExecutor(runner),resolveStaffContext:resolveContext,protection,nativeReceipts:native})
    // All orders/tables here belong to this disposable local test store.
    const area=randomUUID(),table=randomUUID(),session=randomUUID(),order=randomUUID()
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
  const cost=(payload:object=regular)=>request('/api/commercial-ops/costs',payload)
  const report=(native:boolean,scope='sales')=>request(`${native?'/native':'/api'}/staff/bottle-custody/report-export`,{scope})
  const data=(r:Awaited<ReturnType<FastifyInstance['inject']>>,native=false)=>native?r.json().data.result:r.json().data
  async function evidence(){return(await admin.query(`SELECT
    (SELECT count(*) FROM mbox.operating_cost_entries WHERE tenant_id=$1)::int AS costs,
    (SELECT count(*) FROM mbox.audit_events WHERE tenant_id=$1)::int AS audits,
    (SELECT count(*) FROM mbox.outbox_messages WHERE tenant_id=$1)::int AS outbox,
    (SELECT count(*) FROM mbox.orders WHERE tenant_id=$1)::int AS orders`,[scope.tenantId])).rows[0]}
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
  it.each([false,true])('checks base expense permission on create/correction, correction=%s',async correction=>{
    const original=await app.inject(cost());expect(original.statusCode,original.body).toBe(201)
    const req=correction?request(`/api/commercial-ops/costs/${original.json().data.id}/corrections`,{...regular,amountMinor:1100,correctionReason:'Audit correction'}):cost()
    await revokeAndRecover(req,'commercial.cost.manage')
  })
  it.each(sources)('checks source/category authority on creation: $category / $sourceType',async source=>{
    const {permission,...input}=source
    await revokeAndRecover(cost({...regular,...input}),permission)
  })
  it.each(sources.flatMap(source=>['original','replacement'].map(side=>({...source,side}))))('checks $side source on correction: $category / $sourceType',async source=>{
    const {permission,side,...input}=source
    const original=await app.inject(cost({...regular,...(side==='original'?input:{})}));expect(original.statusCode,original.body).toBe(201)
    const req=request(`/api/commercial-ops/costs/${original.json().data.id}/corrections`,{...regular,...(side==='replacement'?input:{}),amountMinor:1100,correctionReason:'Audit reclassification'})
    await revokeAndRecover(req,permission)
  })
  it('keeps ordinary expense receipts available without payroll or receiving rights',async()=>{
    await without('commercial.payroll.manage',()=>without('inventory.receive',async()=>{
      const req=cost(),first=await app.inject(req);expect(first.statusCode,first.body).toBe(201)
      const replay=await app.inject(req);expect(replay.statusCode,replay.body).toBe(200);expect(replay.json().data).toEqual(first.json().data)
    }))
  })
  it.each([false,true].flatMap(native=>['sales','all'].flatMap(scope=>['bottle.custody.export','bottle.manage.all','order.history.all'].map(permission=>({native,scope,permission})))))('checks report $scope / $permission, native=$native',async ({native,scope:reportScope,permission})=>{
    const req=report(native,reportScope), first=await revokeAndRecover(req,permission,native)
    expect(data(first,native).count).toBe(1)
    expect(data(first,native).base64).toBeTruthy()
    if(permission==='order.history.all')await without(permission,async()=>{
      const narrowed=await app.inject({...req,payload:{scope:'custody'}})
      expect(narrowed.statusCode,narrowed.body).toBe(409)
      expect(narrowed.json().data).toBeUndefined()
    })
    if(native){
      const key=(req.headers as Record<string,string>)['idempotency-key']
      const row=(await admin.query("UPDATE mbox.idempotency_records SET created_at=clock_timestamp()-interval '90 days' WHERE tenant_id=$1 AND idempotency_key=$2 RETURNING expires_at::text",[scope.tenantId,key])).rows[0]
      expect(row.expires_at).toBe('infinity')
      await without(permission,()=>denied(req))
      const replay=await app.inject(req);expect(replay.json().meta.replayed).toBe(true);expect(replay.json().data).toEqual(first.json().data)
    }
  })
  it.each([false,true])('does not require order history for custody-only or legacy export, native=%s',async native=>{
    await without('order.history.all',async()=>{
      for(const req of [report(native,'custody'),request(`${native?'/native':'/api'}/staff/bottle-custody/report-export`,{}),request(`${native?'/native':'/api'}/staff/bottle-custody/export`,{})]){
        const first=await app.inject(req);expect(first.statusCode,first.body).toBe(200)
        expect(data(first,native).count).toBe(0)
        const replay=await app.inject(req);expect(replay.json().meta.replayed).toBe(true);expect(replay.json().data).toEqual(first.json().data)
      }
    })
  })
  it.each(['cost','report','native-report'])('blocks crossed identity/store and suspended employees: %s',async kind=>{
    const req=kind==='cost'?cost():report(kind==='native-report')
    const first=await app.inject(req);expect([200,201],first.body).toContain(first.statusCode)
    const before=await evidence()
    const changed=await app.inject({...req,headers:{...req.headers,'x-employee-id':otherEmployeeId}})
    expect(changed.statusCode,changed.body).toBe(409)
    await denied({...req,headers:{...req.headers,'x-other-store':'true'}},401)
    await admin.query("UPDATE mbox.employees SET status='suspended' WHERE id=$1",[employeeId])
    try{await denied(req)}finally{await admin.query("UPDATE mbox.employees SET status='active' WHERE id=$1",[employeeId])}
    expect((await app.inject(req)).json().data).toEqual(first.json().data)
    expect(await evidence()).toEqual(before)
  })
  it.each([false,true])('does not nest context lookup in a single-connection command transaction, native=%s',async native=>{
    resolveViaDatabase=true
    try{await revokeAndRecover(report(native),'order.history.all',native)}finally{resolveViaDatabase=false}
  })
  it.each([false,true])('rejects identity changes between report context reads, native=%s',async native=>{
    const before=await evidence()
    changeIdentity=true;resolveCount=0
    try{await denied(report(native))}finally{changeIdentity=false}
    expect(await evidence()).toEqual(before)
  })
})
