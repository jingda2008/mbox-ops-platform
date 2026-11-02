import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { NormalizedCommandExecutor } from './command-executor.js'
import { inventoryApiPlugin } from './inventory-api.js'
import { InventoryQueryService } from './inventory-query-service.js'
import { ScopedPostgresTransactionRunner, type PostgresPool } from './transaction-runner.js'

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const runtimeUrl = process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL
const integration = databaseUrl && runtimeUrl ? describe : describe.skip
const scope = { tenantId: randomUUID(), storeId: randomUUID() }
const otherStoreId = randomUUID()
const employeeId = randomUUID(), otherEmployeeId = randomUUID(), roleId = randomUUID()
const permissions = ['inventory.manage','inventory.receive','inventory.view','inventory.cost.view',
  'inventory.cost.correct','inventory.waste','catalog.product.manage','bottle.manage','bottle.manage.all']

integration('inventory receipt authorization with a restricted PostgreSQL login', () => {
  let admin: Pool, runtime: Pool, app: FastifyInstance
  let changeIdentityBeforeClaim = false, resolveCount = 0, resolveViaDatabase = false
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
    await app.register(inventoryApiPlugin, { prefix:'/api', transactions:runner,
      commands:new NormalizedCommandExecutor(runner), query:new InventoryQueryService(runner),
      async resolveContext(request) {
        if(resolveViaDatabase)await runner.run(scope,tx=>tx.query('SELECT 1'))
        const actor = request.headers['x-employee-id'] === otherEmployeeId ? otherEmployeeId : employeeId
        const current = changeIdentityBeforeClaim && ++resolveCount > 1 ? otherEmployeeId : actor
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
  function request(path:string, payload:unknown={}, native=false):InjectOptions {
    return {method:'POST',url:`/api/${native?'native/':''}inventory/${path}`,headers:{'idempotency-key':randomUUID()},payload:payload as InjectOptions['payload']}
  }
  function itemRequest(native=false) {
    return request('items',{sku:`AUD-${randomUUID()}`,name:'Replay audit ingredient',itemType:'ingredient',baseUnit:'ml',categoryCode:'spirits',packageVolumeMl:'750',lowStockThreshold:'0',reasonableWasteQuantity:'100'},native)
  }
  async function item() {
    const response = await app.inject(itemRequest())
    expect(response.statusCode,response.body).toBe(201)
    return response.json().data.id as string
  }
  async function evidence() {
    const r=await admin.query(`SELECT
      (SELECT count(*) FROM mbox.audit_events WHERE tenant_id=$1 AND store_id=$2)::int AS audits,
      (SELECT count(*) FROM mbox.outbox_messages WHERE tenant_id=$1 AND store_id=$2)::int AS outbox,
      (SELECT count(*) FROM mbox.inventory_movements WHERE tenant_id=$1 AND store_id=$2)::int AS movements,
      (SELECT count(*) FROM mbox.inventory_cost_corrections WHERE tenant_id=$1 AND store_id=$2)::int AS corrections`,[scope.tenantId,scope.storeId])
    return r.rows[0]
  }
  async function deleteCache(req:InjectOptions) {
    await admin.query('DELETE FROM mbox.idempotency_records WHERE tenant_id=$1 AND store_id=$2 AND idempotency_key=$3', [scope.tenantId,scope.storeId,(req.headers as Record<string,string>)['idempotency-key']])
  }
  async function expectDenied(req:InjectOptions) {
    const reply=await app.inject(req)
    expect(reply.statusCode,reply.body).toBe(403)
    expect(reply.json().data).toBeUndefined()
  }

  it.each([false,true])('reauthorizes item receipts before replay, native=%s', async native => {
    const req=itemRequest(native), first=await app.inject(req)
    expect(first.statusCode,first.body).toBe(201)
    const before=await evidence()
    await without('inventory.manage',async()=>{
      await expectDenied(req)
      await expectDenied(itemRequest(native))
      if(native){await deleteCache(req);await expectDenied(req)}
    })
    const replay=await app.inject(req)
    expect(replay.statusCode,replay.body).toBe(200)
    expect(replay.json()).toMatchObject({data:first.json().data,meta:{replayed:true}})
    expect(await evidence()).toEqual(before)
  })

  it.each([false,true])('requires cost-view AND correction authority on old receipts, native=%s',async native=>{
    const id=await item()
    const seeded=request(`items/${id}/cost-corrections`,{weightedUnitCostMinor:'10',reason:'Initial audit cost'})
    expect((await app.inject(seeded)).statusCode).toBe(200)
    // Preserve PostgreSQL microseconds; Date.toISOString() truncation can make
    // an immediate valid snapshot appear older than the preceding update.
    const observed=(await admin.query(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`)).rows[0].at
    const req=request(`items/${id}/cost-corrections`,{weightedUnitCostMinor:'26.125',reason:'Audit correction',...(native?{expectedObservedAt:observed,expectedWeightedUnitCostMinor:'10'}:{})},native)
    const first=await app.inject(req);expect(first.statusCode,first.body).toBe(200)
    const before=await evidence()
    for(const permission of ['inventory.cost.view','inventory.cost.correct']) {
      await without(permission,async()=>{await expectDenied(req);if(native){await deleteCache(req);await expectDenied(req)}})
    }
    const replay=await app.inject(req)
    expect(replay.statusCode,replay.body).toBe(200)
    expect(replay.json()).toMatchObject({data:first.json().data,meta:{replayed:true}})
    expect(await evidence()).toEqual(before)
  })

  it.each([false,true])('revoked receiving authority blocks create and receive receipts without duplicating stock, native=%s',async native=>{
    const id=await item(), create=request('receipts',{invoiceTotalMinor:'120',lines:[{inventoryItemId:id,batchCode:`audit-${randomUUID()}`,quantity:'10',totalCostMinor:'120'}]},native)
    const first=await app.inject(create);expect(first.statusCode,first.body).toBe(201)
    const receive=request(`receipts/${first.json().data.id}/receive`,{},native)
    expect((await app.inject(receive)).statusCode).toBe(200)
    const before=await evidence()
    await without('inventory.receive',async()=>{
      for(const req of [create,receive]){await expectDenied(req);if(native){await deleteCache(req);await expectDenied(req)}}
    })
    for(const req of [create,receive])expect((await app.inject(req)).json().meta.replayed).toBe(true)
    expect(await evidence()).toEqual(before)
    expect(Number((await admin.query('SELECT on_hand_quantity FROM mbox.inventory_balances WHERE inventory_item_id=$1',[id])).rows[0].on_hand_quantity)).toBe(10)
  })

  it.each([false,true])('redacts waste costs from cached and durable replay after cost revocation, native=%s',async native=>{
    const id=await item(), create=await app.inject(request('receipts',{lines:[{inventoryItemId:id,quantity:'10',totalCostMinor:'120'}]}))
    expect(create.statusCode,create.body).toBe(201)
    expect((await app.inject(request(`receipts/${create.json().data.id}/receive`))).statusCode).toBe(200)
    const req=request(`items/${id}/waste`,{quantity:'1',reason:'Audit breakage',wasteType:'discarded'},native)
    const first=await app.inject(req);expect(first.statusCode,first.body).toBe(200)
    expect(first.json().data.wasteCostMinor).toBeDefined()
    const before=await evidence()
    await without('inventory.cost.view',async()=>{
      for(const clear of [false,true]){
        if(clear)await deleteCache(req)
        const replay=await app.inject(req);expect(replay.statusCode,replay.body).toBe(200)
        expect(replay.json().meta.replayed).toBe(true)
        expect(replay.json().data.wasteCostMinor).toBeUndefined()
        expect(replay.json().data.unitCostMinor).toBeUndefined()
      }
    })
    await without('inventory.waste',()=>expectDenied(req))
    expect(await evidence()).toEqual(before)
    expect(Number((await admin.query('SELECT on_hand_quantity FROM mbox.inventory_balances WHERE inventory_item_id=$1',[id])).rows[0].on_hand_quantity)).toBe(9)
  })

  it.each([false,true])('does not expose another actor or store receipt, native=%s',async native=>{
    const req=itemRequest(native),first=await app.inject(req);expect(first.statusCode,first.body).toBe(201)
    const before=await evidence()
    const other=await app.inject({...req,headers:{...req.headers,'x-employee-id':otherEmployeeId}})
    expect(other.statusCode,other.body).toBe(409);expect(other.json().data).toBeUndefined()
    const otherStore=await app.inject({...req,headers:{...req.headers,'x-other-store':'1'}})
    expect(otherStore.statusCode,otherStore.body).toBe(403);expect(otherStore.json().data).toBeUndefined()
    expect(await evidence()).toEqual(before)
  })

  it.each([false,true])('rejects an identity change between route resolution and receipt lookup, native=%s',async native=>{
    const req=itemRequest(native),first=await app.inject(req);expect(first.statusCode,first.body).toBe(201)
    const before=await evidence()
    resolveCount=0;changeIdentityBeforeClaim=true
    try{await expectDenied(req)}finally{changeIdentityBeforeClaim=false}
    expect(await evidence()).toEqual(before)
  })

  it.each(['recipe-cost','publish-preview','publish'] as const)('reauthorizes every extra permission on a %s receipt',async operation=>{
    const id=await item(), productId=randomUUID()
    await admin.query(`INSERT INTO mbox.products(id,tenant_id,store_id,code,name,category_code,fulfillment_station,product_kind,product_snapshot,status,cost_amount_minor,inventory_control_mode,guest_visible,allowed_channels)
      VALUES($1,$2,$3,$4,'Audit drink','spirits','bar','single','{"salesSpecificationType":"glass"}'::jsonb,'inactive',100,'tracked',true,ARRAY['guest_qr','staff_assisted']::text[])`,[productId,scope.tenantId,scope.storeId,`AUD-${productId}`])
    await admin.query("INSERT INTO mbox.product_prices(tenant_id,store_id,product_id,price_type,currency,amount_minor,valid_from) VALUES($1,$2,$3,'standard','CNY',6800,clock_timestamp())",[scope.tenantId,scope.storeId,productId])
    const recipe=await app.inject({...request(`products/${productId}/recipe`,{yieldQuantity:1,components:[{inventoryItemId:id,quantity:'1',expectedWasteQuantity:'0'}]}),method:'PUT'})
    expect(recipe.statusCode,recipe.body).toBe(200)
    const create=await app.inject(request('receipts',{invoiceTotalMinor:'120',lines:[{inventoryItemId:id,quantity:'10',totalCostMinor:'120'}]}))
    expect(create.statusCode,create.body).toBe(201)
    const receiptId=create.json().data.id
    if(operation==='recipe-cost')expect((await app.inject(request(`receipts/${receiptId}/receive`))).statusCode).toBe(200)
    const req=operation==='recipe-cost'?request(`products/${productId}/recipe-cost/apply`,{reason:'Audit recipe cost'}):request(`receipts/${receiptId}/receive-and-publish${operation==='publish-preview'?'-preview':''}`,{productId})
    const first=await app.inject(req);expect(first.statusCode,first.body).toBe(200)
    const before=await evidence()
    const required=operation==='recipe-cost'?['catalog.product.manage','inventory.cost.view']:['inventory.receive','catalog.product.manage','inventory.cost.view']
    for(const permission of required)await without(permission,()=>expectDenied(req))
    const replay=await app.inject(req);expect(replay.statusCode,replay.body).toBe(200)
    expect(replay.json()).toMatchObject({data:first.json().data,meta:{replayed:true}})
    expect(await evidence()).toEqual(before)
  })

  it('rechecks bottle responsibility on old receipts without requiring the original mutation state',async()=>{
    const areaId=randomUUID(),tableId=randomUUID(),sessionId=randomUUID()
    await admin.query("INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type) VALUES($1,$2,$3,'AUDIT','Audit','indoor')",[areaId,scope.tenantId,scope.storeId])
    await admin.query("INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) VALUES($1,$2,$3,$4,'AUDIT','Audit',4)",[tableId,scope.tenantId,scope.storeId,areaId])
    await admin.query("INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count,capacity_at_open) VALUES($1,$2,$3,$4,$5,'2026-11-02',2,4)",[sessionId,scope.tenantId,scope.storeId,tableId,randomUUID()])
    const created=await app.inject(request('items',{sku:`BOTTLE-${randomUUID()}`,name:'Audit bottle',itemType:'bottle',baseUnit:'ml',categoryCode:'bottled_spirits',packageVolumeMl:'750'}))
    expect(created.statusCode,created.body).toBe(201)
    const store=request('stored-bottles',{inventoryItemId:created.json().data.id,tableSessionId:sessionId,quantity:'500'})
    const stored=await app.inject(store);expect(stored.statusCode,stored.body).toBe(201)
    const id=stored.json().data.id
    const use=request(`stored-bottles/${id}/use`,{quantity:'100'}), voidRequest=request(`stored-bottles/${id}/void`,{reason:'Audit terminal state'})
    expect((await app.inject(use)).statusCode).toBe(200)
    expect((await app.inject(voidRequest)).statusCode).toBe(200)
    const before=await evidence()
    await without('bottle.manage.all',async()=>{
      for(const req of [store,use,voidRequest])await expectDenied(req)
      await admin.query("INSERT INTO mbox.table_assignments(tenant_id,store_id,table_id,employee_id,role_id,reason) VALUES($1,$2,$3,$4,$5,'Audit responsibility')",[scope.tenantId,scope.storeId,tableId,employeeId,roleId])
      for(const req of [store,use,voidRequest]){
        const replay=await app.inject(req);expect(replay.statusCode,replay.body).toBe(200);expect(replay.json().meta.replayed).toBe(true)
      }
      await admin.query('UPDATE mbox.table_assignments SET ends_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND table_id=$3',[scope.tenantId,scope.storeId,tableId])
      for(const req of [store,use,voidRequest])await expectDenied(req)
    })
    expect(await evidence()).toEqual(before)
    expect((await admin.query('SELECT remaining_quantity::text,status FROM mbox.stored_bottles WHERE id=$1',[id])).rows[0]).toMatchObject({remaining_quantity:'400.000000',status:'voided'})
  })


  it.each([false,true])('resolves live identity without borrowing a nested command connection, native=%s',async native=>{
    resolveViaDatabase=true
    try {
      const req=itemRequest(native),first=await app.inject(req)
      expect(first.statusCode,first.body).toBe(201)
      const replay=await app.inject(req)
      expect(replay.statusCode,replay.body).toBe(200)
      expect(replay.json()).toMatchObject({data:first.json().data,meta:{replayed:true}})
    } finally {resolveViaDatabase=false}
  })

})
