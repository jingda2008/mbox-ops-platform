import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { NormalizedCommandExecutor } from './command-executor.js'
import { catalogApiPlugin } from './catalog-api.js'
import { ScopedPostgresTransactionRunner, type PostgresPool } from './transaction-runner.js'

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const runtimeUrl = process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL
const integration = databaseUrl && runtimeUrl ? describe : describe.skip
const scope = { tenantId: randomUUID(), storeId: randomUUID() }
const otherStoreId = randomUUID()
const employeeId = randomUUID(), otherEmployeeId = randomUUID(), roleId = randomUUID()
const permissions = ['catalog.product.manage','catalog.price.manage','inventory.cost.view']

integration('catalog receipt authorization with a restricted PostgreSQL login', () => {
  let admin: Pool, runtime: Pool, app: FastifyInstance
  let resolveViaDatabase = false
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
    await app.register(catalogApiPlugin, { prefix:'/api', transactions:runner,
      commandExecutor:new NormalizedCommandExecutor(runner),
      resolveGuestContext:()=>({scope}),
      async resolveContext(request) {
        if(resolveViaDatabase)await runner.run(scope,tx=>tx.query('SELECT 1'))
        const actor = request.headers['x-employee-id'] === otherEmployeeId ? otherEmployeeId : employeeId
        const current = actor
        return { scope:request.headers['x-other-store'] ? {...scope,storeId:otherStoreId} : scope,
          employeeId:current,businessDate:'2026-11-02',capabilities:[] }
      },
    })
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
  function request(path:string, payload:unknown, native=false, update=false):InjectOptions {
    return {method:update&&!native?'PATCH':'POST',url:`/api/${native?'native/':''}catalog/${path}`,
      headers:{'idempotency-key':randomUUID()},payload:payload as InjectOptions['payload']}
  }
  function category(native=false) {
    return request('menu-categories',{code:`cat-${randomUUID()}`,displayName:'Audit category',parentCode:null,sortOrder:1,guestVisible:true},native)
  }
  function product(native=false, extra={}) {
    return request('products',{code:`P-${randomUUID()}`,name:'Audit product',categoryCode:'wine',fulfillmentStation:'bar',inventoryControlMode:'not_managed',...extra},native)
  }
  async function created(req:InjectOptions) {
    const r=await app.inject(req);expect(r.statusCode,r.body).toBe(201);return r.json().data
  }
  async function productUpdate(id:string, patch:object, native:boolean) {
    const list=await app.inject({method:'GET',url:'/api/native/catalog/products?limit=100'})
    expect(list.statusCode,list.body).toBe(200)
    const version=list.json().data.products.find((p:{id:string})=>p.id===id).nativeVersion
    return request(`products/${id}`,native?{patch,expectedVersion:version}:patch,native,true)
  }
  async function evidence() {
    return (await admin.query(`SELECT
      (SELECT count(*) FROM mbox.audit_events WHERE tenant_id=$1)::int AS audits,
      (SELECT count(*) FROM mbox.outbox_messages WHERE tenant_id=$1)::int AS outbox,
      (SELECT count(*) FROM mbox.menu_categories WHERE tenant_id=$1)::int AS categories,
      (SELECT count(*) FROM mbox.products WHERE tenant_id=$1)::int AS products,
      (SELECT count(*) FROM mbox.product_prices WHERE tenant_id=$1)::int AS prices`,[scope.tenantId])).rows[0]
  }
  async function deleteCache(req:InjectOptions) {
    await admin.query('DELETE FROM mbox.idempotency_records WHERE tenant_id=$1 AND store_id=$2 AND idempotency_key=$3',[scope.tenantId,scope.storeId,(req.headers as Record<string,string>)['idempotency-key']])
  }
  async function denied(req:InjectOptions) {
    const r=await app.inject(req);expect(r.statusCode,r.body).toBe(403);expect(r.json().data).toBeUndefined()
  }
  async function revokedReplay(req:InjectOptions, permission:string, native:boolean) {
    const before=await evidence()
    await without(permission,async()=>{
      await denied(req)
      await denied({...req,headers:{...req.headers,'idempotency-key':randomUUID()}})
      if(native){await deleteCache(req);await denied(req)}
    })
    const recovered=await app.inject(req)
    expect(recovered.statusCode,recovered.body).toBe(200)
    expect(recovered.json().meta.replayed).toBe(true)
    expect(await evidence()).toEqual(before)
  }
  const writes = [false,true].flatMap(native=>[false,true].map(update=>({native,update})))
  it.each(writes)('reauthorizes category receipts, native=$native update=$update',async ({native,update})=>{
    const create=category(native), first=await created(create)
    const patch={displayName:'Updated category'}
    const req=update?request(`menu-categories/${first.code}`,native?{patch,expectedUpdatedAt:first.updatedAt}:patch,native,true):create
    if(update){const saved=await app.inject(req);expect(saved.statusCode,saved.body).toBe(200)}
    await revokedReplay(req,'catalog.product.manage',native)
    expect((await app.inject(create)).json().data).toEqual(first)
  })
  it.each(writes)('reauthorizes product receipts, native=$native update=$update',async ({native,update})=>{
    const create=product(native), first=await created(create)
    const req=update?await productUpdate(first.id,{name:'Updated product'},native):create
    if(update){const saved=await app.inject(req);expect(saved.statusCode,saved.body).toBe(200)}
    await revokedReplay(req,'catalog.product.manage',native)
    expect((await app.inject(create)).json().data).toEqual(first)
  })
  it.each(writes)('reauthorizes embedded price receipts, native=$native update=$update',async ({native,update})=>{
    const price={amountMinor:12800,currency:'CNY',reason:'Audit price'}
    const create=product(native,update?{}:{standardPrice:price}), first=await created(create)
    const req=update?await productUpdate(first.id,{standardPrice:price},native):create
    if(update){const saved=await app.inject(req);expect(saved.statusCode,saved.body).toBe(200)}
    await revokedReplay(req,'catalog.price.manage',native)
  })
  it.each(writes)('reauthorizes explicit cost receipts, native=$native update=$update',async ({native,update})=>{
    const create=product(native,update?{}:{costAmountMinor:1050}), first=await created(create)
    const req=update?await productUpdate(first.id,{costAmountMinor:1150,costChangeReason:'Audit correction'},native):create
    if(update){const saved=await app.inject(req);expect(saved.statusCode,saved.body).toBe(200)}
    await revokedReplay(req,'inventory.cost.view',native)
  })
  it.each([false,true])('redacts current cost visibility on create and update replay, native=%s',async native=>{
    const req=product(native), first=await created(req)
    await admin.query('UPDATE mbox.products SET cost_amount_minor=1050 WHERE id=$1',[first.id])
    const update=await productUpdate(first.id,{name:'Cost-bearing product'},native)
    const saved=await app.inject(update);expect(saved.statusCode,saved.body).toBe(200)
    expect(saved.json().data.costAmountMinor).toBe(1050)
    const before=await evidence()
    await without('inventory.cost.view',async()=>{
      for(const target of [req,update])for(const durable of native?[false,true]:[false]){
        if(durable)await deleteCache(target)
        const r=await app.inject(target);expect(r.statusCode,r.body).toBe(200)
        expect(r.json().meta.replayed).toBe(true)
        expect(r.json().data).not.toHaveProperty('costAmountMinor')
      }
    })
    expect((await app.inject(update)).json().data.costAmountMinor).toBe(1050)
    expect(await evidence()).toEqual(before)
  })
  it('reauthorizes standalone price receipts and redacts costs without requiring product management',async()=>{
    const first=await created(product(false,{costAmountMinor:1050}))
    const req:InjectOptions={...request(`products/${first.id}/standard-price`,{amountMinor:12800,currency:'CNY',reason:'Audit price'}),method:'PUT'}
    await without('catalog.product.manage',async()=>{const r=await app.inject(req);expect(r.statusCode,r.body).toBe(200)})
    await revokedReplay(req,'catalog.price.manage',false)
    const before=await evidence()
    await without('inventory.cost.view',async()=>{const r=await app.inject(req);expect(r.statusCode,r.body).toBe(200);expect(r.json().data).not.toHaveProperty('costAmountMinor')})
    expect(await evidence()).toEqual(before)
  })
  it.each([false,true])('rejects another actor, scope and suspended employee on category replay, native=%s',async native=>{
    const req=category(native);await created(req);const before=await evidence()
    for(const durable of native?[false,true]:[false]){
      if(durable)await deleteCache(req)
      const actor=await app.inject({...req,headers:{...req.headers,'x-employee-id':otherEmployeeId}})
      expect(actor.statusCode,actor.body).toBe(409)
      await denied({...req,headers:{...req.headers,'x-other-store':'true'}})
      await admin.query("UPDATE mbox.employees SET status='suspended' WHERE id=$1",[employeeId])
      try{await denied(req)}finally{await admin.query("UPDATE mbox.employees SET status='active' WHERE id=$1",[employeeId])}
    }
    expect((await app.inject(req)).json().meta.replayed).toBe(true)
    expect(await evidence()).toEqual(before)
  })
  it('protects sale-quantity replay while retaining original version recovery',async()=>{
    const first=await created(product())
    const req=request(`products/${first.id}/sale-quantity`,{remaining:3,expectedVersion:'0'})
    const saved=await app.inject(req);expect(saved.statusCode,saved.body).toBe(200)
    await revokedReplay(req,'catalog.product.manage',true)
    expect((await app.inject(req)).json().data).toEqual(saved.json().data)
  })
  it.each([false,true])('resolves context using the same single-connection pool without nesting, native=%s',async native=>{
    resolveViaDatabase=true
    try{const req=category(native);await created(req);await revokedReplay(req,'catalog.product.manage',native)}finally{resolveViaDatabase=false}
  })
})
