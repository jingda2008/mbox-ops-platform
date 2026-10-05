import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { restoreQuantityInventoryBalance } from './quantity-inventory-return-balance.js'
import { InventoryReturnCostProjectionBusyError } from './inventory-return-cost-projection.js'
import { NormalizedCommandExecutor } from './command-executor.js'
import { ScopedPostgresTransactionRunner, type ScopedTransaction } from './transaction-runner.js'

const adminUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const runtimeUrl = process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL
const integration = adminUrl ? describe : describe.skip
integration('inventory return cost projection is atomic and retryable', () => {
  const scope = { tenantId: randomUUID(), storeId: randomUUID() }
  let admin: Pool, runtime: Pool, runner: ScopedPostgresTransactionRunner
  beforeAll(async () => {
    await runNormalizedMigrations(adminUrl!)
    admin = new Pool({ connectionString: adminUrl, max: 4 })
    runtime = new Pool({ connectionString: runtimeUrl ?? adminUrl, max: 4 })
    runner = new ScopedPostgresTransactionRunner(runtime)
    await admin.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1::uuid,$1::text,'Return projection')", [scope.tenantId])
    await admin.query("INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1,$2,'projection','Return projection')", [scope.storeId, scope.tenantId])
  }, 30_000)
  afterAll(async () => { await runtime?.end(); await admin?.end() })
  const run = <T>(operation: (tx: ScopedTransaction) => Promise<T>) => runner.run(scope, async tx => {
    if (!runtimeUrl) await tx.query('SET LOCAL ROLE mbox_runtime')
    await tx.query("SET LOCAL statement_timeout='2000ms'")
    return operation(tx)
  })
  async function fixture(onHand = 6, originalCost: number | null = 300, currentCost: number | null = 500) {
    const inventory = randomUUID(), shared = randomUUID(), product = randomUUID(), sibling = randomUUID(), companion = randomUUID(), bundle = randomUUID(), recipe = randomUUID(), siblingRecipe = randomUUID(), component = randomUUID(), movement = randomUUID()
    for (const [id, cost] of [[inventory,currentCost],[shared,100]] as const) {
      await admin.query("INSERT INTO mbox.inventory_items(id,tenant_id,store_id,sku,name,item_type,base_unit) VALUES($1::uuid,$2,$3,$1::text,'食材','food','piece')",[id,scope.tenantId,scope.storeId])
      await admin.query("INSERT INTO mbox.inventory_balances(tenant_id,store_id,inventory_item_id,on_hand_quantity,weighted_unit_cost_minor,cost_status,cost_basis) VALUES($1,$2,$3,$4,$5,$6,$7)",[scope.tenantId,scope.storeId,id,id===inventory?onHand:6,cost,cost===null?'needs_review':'complete',cost===null?'none':'moving_weighted_average'])
    }
    for (const id of [product,sibling,companion,bundle]) await admin.query("INSERT INTO mbox.products(id,tenant_id,store_id,code,name,category_code,fulfillment_station,inventory_control_mode,product_kind,cost_amount_minor) VALUES($1::uuid,$2,$3,$1::text,'商品','food','kitchen',$4,$5,999)",[id,scope.tenantId,scope.storeId,[product,sibling].includes(id)?'tracked':'not_managed',id===bundle?'bundle':'single'])
    for (const [id,owner] of [[recipe,product],[siblingRecipe,sibling]]) await admin.query("INSERT INTO mbox.recipes(id,tenant_id,store_id,product_id,version,status,effective_at) VALUES($1,$2,$3,$4,1,'active',clock_timestamp())",[id,scope.tenantId,scope.storeId,owner])
    await admin.query('INSERT INTO mbox.recipe_items(id,tenant_id,store_id,recipe_id,inventory_item_id,quantity) VALUES($1,$2,$3,$4,$5,1)',[component,scope.tenantId,scope.storeId,recipe,inventory])
    await admin.query('INSERT INTO mbox.recipe_items(tenant_id,store_id,recipe_id,inventory_item_id,quantity) VALUES($1,$2,$3,$4,2),($1,$2,$5,$6,3)',[scope.tenantId,scope.storeId,recipe,shared,siblingRecipe,inventory])
    await admin.query('INSERT INTO mbox.product_bundle_components(tenant_id,store_id,bundle_product_id,component_product_id,quantity) VALUES($1,$2,$3,$4,2),($1,$2,$3,$5,1)',[scope.tenantId,scope.storeId,bundle,product,companion])
    return {inventory,shared,product,sibling,companion,bundle,recipe,component,movement,originalCost,onHand}
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>
  async function restore(tx: ScopedTransaction, f: Fixture) {
    await tx.query('SELECT inventory_item_id FROM mbox.inventory_balances WHERE tenant_id=$1 AND store_id=$2 AND inventory_item_id=$3 FOR UPDATE',[scope.tenantId,scope.storeId,f.inventory])
    await tx.query("INSERT INTO mbox.inventory_movements(id,tenant_id,store_id,inventory_item_id,movement_type,quantity_delta,reference_type,reference_id,unit_cost_minor) VALUES($1,$2,$3,$4,'return',2,'refund_unmade',$1,$5)",[f.movement,scope.tenantId,scope.storeId,f.inventory,f.originalCost])
    await restoreQuantityInventoryBalance(tx,{inventoryItemId:f.inventory,movementId:f.movement,quantity:'2'})
  }
  async function addChoice(f:Fixture){
    const group=randomUUID(),option=randomUUID()
    await admin.query("INSERT INTO mbox.product_bundle_choice_groups(id,tenant_id,store_id,bundle_product_id,code,display_name) VALUES($1,$2,$3,$4,'choice','任选一项')",[group,scope.tenantId,scope.storeId,f.bundle])
    await admin.query('INSERT INTO mbox.product_bundle_choice_options(id,tenant_id,store_id,choice_group_id,component_product_id) VALUES($1,$2,$3,$4,$5)',[option,scope.tenantId,scope.storeId,group,f.product])
    return {group,option}
  }
  const costs = async (tx: Pick<ScopedTransaction,'query'>, f: Fixture) => (await tx.query<{id:string;cost:string|null}>(
    'SELECT id,cost_amount_minor::text AS cost FROM mbox.products WHERE id=ANY($1::uuid[]) ORDER BY id',[[f.product,f.sibling,f.bundle]],
  )).rows
  it.each([
    {name:'weighted stock',onHand:6,original:300,current:500,cost:450},
    {name:'empty stock',onHand:0,original:300,current:null,cost:300},
    {name:'unknown returned lot',onHand:6,original:null,current:500,cost:null},
    {name:'unknown existing stock',onHand:6,original:300,current:null,cost:null},
    {name:'zero-cost returned lot',onHand:0,original:0,current:null,cost:0},
  ])('updates shared recipes and bundles in the same transaction: $name',async scenario=>{
    const f=await fixture(scenario.onHand,scenario.original,scenario.current)
    const expected=[{id:f.product,cost:scenario.cost===null?null:String(scenario.cost+200)}, {id:f.sibling,cost:scenario.cost===null?null:String(scenario.cost*3)}, {id:f.bundle,cost:scenario.cost===null?null:String((scenario.cost+200)*2+999)}].sort((a,b)=>a.id.localeCompare(b.id))
    await run(async tx=>{await restore(tx,f);expect(await costs(tx,f)).toEqual(expected)})
    expect(await costs(admin,f)).toEqual(expected)
    const versions=(await admin.query('SELECT calculated_by_employee_id,source_inventory_movement_id FROM mbox.recipe_cost_versions WHERE product_id=ANY($1::uuid[])',[[f.product,f.sibling]])).rows
    expect(versions).toHaveLength(scenario.cost===null?0:2)
    for(const version of versions)expect(version).toEqual({calculated_by_employee_id:null,source_inventory_movement_id:f.movement})
  })
  for(const dependency of ['product','recipe','component','shared_balance','bundle','companion','inventory_item','choice_group','choice_option'] as const) {
    it(`fails promptly on ${dependency} contention and retries the identical command exactly once`,async()=>{
      const f=await fixture(),key=randomUUID()
      const choice=dependency.startsWith('choice_')?await addChoice(f):{group:randomUUID(),option:randomUUID()}
      let release!:()=>void,ready!:()=>void
      const held=new Promise<void>(resolve=>{ready=resolve}),gate=new Promise<void>(resolve=>{release=resolve})
      const blocking=run(async tx=>{
        const locks={
          choice_group:['mbox.product_bundle_choice_groups','id',choice.group,'UPDATE'],choice_option:['mbox.product_bundle_choice_options','id',choice.option,'UPDATE'],
          inventory_item:['mbox.inventory_items','id',f.shared,'UPDATE'],
          product:['mbox.products','id',f.product,'SHARE'],recipe:['mbox.recipes','id',f.recipe,'UPDATE'],component:['mbox.recipe_items','id',f.component,'UPDATE'],shared_balance:['mbox.inventory_balances','inventory_item_id',f.shared,'UPDATE'],bundle:['mbox.products','id',f.bundle,'SHARE'],companion:['mbox.products','id',f.companion,'UPDATE'],
        } as const
        const [table,column,id,mode]=locks[dependency]
        await tx.query(`SELECT ${column} FROM ${table} WHERE tenant_id=$1 AND store_id=$2 AND ${column}=$3 FOR ${mode}`,[scope.tenantId,scope.storeId,id])
        ready();await gate
      })
      await held
      const executor=new NormalizedCommandExecutor({run:(_scope,operation)=>run(operation)})
      const command={scope,operationScope:'test.inventory-return',idempotencyKey:key,requestFingerprint:JSON.stringify(f),resultCodec:{encode:(id:string)=>id,decode:(value:unknown)=>String(value)}}
      const execute=()=>executor.execute(command,async tx=>{await restore(tx,f);return {result:f.movement,auditEvents:[],outboxMessages:[]}})
      try {
        await expect(execute()).rejects.toBeInstanceOf(InventoryReturnCostProjectionBusyError)
        expect((await admin.query('SELECT on_hand_quantity::text AS q FROM mbox.inventory_balances WHERE inventory_item_id=$1',[f.inventory])).rows[0].q).toBe('6.000000')
        expect((await admin.query('SELECT id FROM mbox.inventory_movements WHERE id=$1',[f.movement])).rowCount).toBe(0)
        expect((await admin.query('SELECT id FROM mbox.idempotency_records WHERE idempotency_key=$1',[key])).rowCount).toBe(0)
      }finally{release();await blocking}
      expect(await execute()).toEqual({value:f.movement,replayed:false})
      expect(await execute()).toEqual({value:f.movement,replayed:true})
      expect((await admin.query('SELECT on_hand_quantity::text AS q FROM mbox.inventory_balances WHERE inventory_item_id=$1',[f.inventory])).rows[0].q).toBe('8.000000')
    })
  }
  it('two returns sharing recipe dependencies never wait in a stock/product cycle',async()=>{
    const f=await fixture(),other={...f,inventory:f.shared,movement:randomUUID(),originalCost:50}
    let readyCount=0,release!:()=>void,ready!:()=>void
    const both=new Promise<void>(resolve=>{ready=resolve}),gate=new Promise<void>(resolve=>{release=resolve})
    const concurrent=(value:Fixture)=>run(async tx=>{
      await tx.query('SELECT inventory_item_id FROM mbox.inventory_balances WHERE tenant_id=$1 AND store_id=$2 AND inventory_item_id=$3 FOR UPDATE',[scope.tenantId,scope.storeId,value.inventory])
      if(++readyCount===2)ready();await gate;await restore(tx,value)
    })
    const pending=[concurrent(f),concurrent(other)]
    const settled=Promise.allSettled(pending)
    await both;release()
    const results=await settled
    expect(results.some(result=>result.status==='rejected')).toBe(true)
    for(let index=0;index<results.length;index++)if(results[index]!.status==='rejected'){
      expect((results[index] as PromiseRejectedResult).reason).toBeInstanceOf(InventoryReturnCostProjectionBusyError)
      await run(tx=>restore(tx,[f,other][index]!))
    }
    expect(await costs(admin,f)).toEqual([{id:f.product,cost:'625'},{id:f.sibling,cost:'1350'},{id:f.bundle,cost:'2249'}].sort((a,b)=>a.id.localeCompare(b.id)))
    expect((await admin.query('SELECT id FROM mbox.inventory_movements WHERE id=ANY($1::uuid[])',[[f.movement,other.movement]])).rowCount).toBe(2)
  })

  it.each([false,true])('keeps undecided bundle choices incomplete (options-only: %s)',async optionsOnly=>{
    const f=await fixture();await addChoice(f)
    if(optionsOnly)await admin.query('DELETE FROM mbox.product_bundle_components WHERE bundle_product_id=$1',[f.bundle])
    await run(tx=>restore(tx,f))
    expect((await admin.query('SELECT cost_amount_minor,cost_source FROM mbox.products WHERE id=$1',[f.bundle])).rows[0]).toEqual({cost_amount_minor:null,cost_source:'incomplete'})
  })

  it('does not apply a partial recipe cost when a legacy component balance is missing',async()=>{
    const f=await fixture()
    await admin.query('DELETE FROM mbox.inventory_balances WHERE inventory_item_id=$1',[f.shared])
    await expect(run(tx=>restore(tx,f))).rejects.toThrow('配方物料库存余额不完整')
    expect((await admin.query('SELECT on_hand_quantity::text AS q FROM mbox.inventory_balances WHERE inventory_item_id=$1',[f.inventory])).rows[0].q).toBe('6.000000')
    expect((await admin.query('SELECT id FROM mbox.inventory_movements WHERE id=$1',[f.movement])).rowCount).toBe(0)
    expect((await costs(admin,f)).every(row=>row.cost==='999')).toBe(true)
  })

})
