import {randomUUID} from 'node:crypto'
import Fastify,{type FastifyInstance} from 'fastify'
import {Pool} from 'pg'
import {beforeAll,afterAll,describe,it,expect} from 'vitest'
import {runNormalizedMigrations} from '../migrate-normalized.js'
import {ScopedPostgresTransactionRunner} from './transaction-runner.js'
import {assertRuntimeDatabasePool} from './runtime-database-identity.js'
import {NormalizedCommandExecutor} from './command-executor.js'
import {InventoryRepository} from './inventory-repository.js'
import {InventoryQueryService} from './inventory-query-service.js'
import {inventoryApiPlugin} from './inventory-api.js'
const database=process.env.TEST_NORMALIZED_DATABASE_URL,runtimeUrl=process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL
;(database&&runtimeUrl?describe:describe.skip)('native inventory complete history and guarded cost correction',()=>{
 const scope={tenantId:randomUUID(),storeId:randomUUID()},employee=randomUUID(),role=randomUUID();let admin:Pool,runtime:Pool,app:FastifyInstance,item:string
 const get=async(query='')=>{const r=await app.inject({method:'GET',url:'/api/native/inventory'+query});expect(r.statusCode,r.body).toBe(200);return r.json().data}
 beforeAll(async()=>{
  await runNormalizedMigrations(database!);admin=new Pool({connectionString:database});runtime=new Pool({connectionString:runtimeUrl});await assertRuntimeDatabasePool(runtime,runtimeUrl!);const transactions=new ScopedPostgresTransactionRunner(runtime),commands=new NormalizedCommandExecutor(transactions)
  await admin.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1::uuid,$1::text,'Native inventory')",[scope.tenantId]);await admin.query("INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1::uuid,$2,$1::text,'Native inventory')",[scope.storeId,scope.tenantId]);await admin.query("INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$2,$3,'STOCK','库存管理员')",[employee,scope.tenantId,scope.storeId]);await admin.query("INSERT INTO mbox.roles(id,tenant_id,store_id,code,name) VALUES($1,$2,$3,'STOCK','库存管理员')",[role,scope.tenantId,scope.storeId]);await admin.query("INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id,starts_at) VALUES($1,$2,$3,$4,clock_timestamp()-interval '1 day')",[scope.tenantId,scope.storeId,employee,role]);await admin.query("INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name,category,description) SELECT $1,$2,p,p,'inventory','Test inventory permissions' FROM unnest($3::text[]) p ON CONFLICT(tenant_id,store_id,code) DO NOTHING",[scope.tenantId,scope.storeId,['inventory.view','inventory.receive','inventory.cost.view','inventory.cost.correct']]);await admin.query("INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) SELECT $1,$2,$3,id FROM mbox.staff_permission_definitions WHERE tenant_id=$1 AND store_id=$2 AND code=ANY($4)",[scope.tenantId,scope.storeId,role,['inventory.view','inventory.receive','inventory.cost.view','inventory.cost.correct']])
  await transactions.run(scope,async tx=>{const repo=new InventoryRepository(tx);item=(await repo.createItem({sku:'NATIVE-HISTORY',name:'历史测试物料',itemType:'other',baseUnit:'piece',categoryCode:'uncategorized'})).id;for(let i=0;i<101;i++)await repo.createPurchaseReceipt({publicId:'native-history-'+String(i).padStart(3,'0'),employeeId:employee,currency:'CNY',lines:[{inventoryItemId:item,batchCode:'HISTORY-'+i,quantity:'1',totalCostMinor:'100'}]})})
  app=Fastify();await app.register(inventoryApiPlugin,{prefix:'/api',transactions,commands,query:new InventoryQueryService(transactions),resolveContext:()=>({scope,employeeId:employee,businessDate:'2026-10-01',capabilities:[]})});await app.ready()
 })
 afterAll(async()=>{await app?.close();await runtime?.end();await admin?.end()})
 it('pages all 101 receipts, searches item or original number, keeps legacy at 100',async()=>{
  const first=await get(),second=await get('?receiptsPage=1');expect(first.receipts).toHaveLength(100);expect(first.receiptsPage).toEqual({page:0,hasMore:true});expect(second.receipts).toHaveLength(1);expect(second.receiptsPage.hasMore).toBe(false);expect(new Set([...first.receipts,...second.receipts].map((x:any)=>x.id)).size).toBe(101)
  expect((await get('?receiptSearch=native-history-000')).receipts).toHaveLength(1);expect((await get('?receiptSearch='+encodeURIComponent('历史测试'))).receiptsPage.hasMore).toBe(true)
  expect((await get('?receiptFrom=2000-01-01&receiptTo=2000-01-31')).receipts).toHaveLength(0)
  expect((await app.inject({method:'GET',url:'/api/native/inventory?receiptFrom=2026-02-30'})).statusCode).toBe(400)
  const old=await app.inject({method:'GET',url:'/api/inventory'});expect(old.statusCode,old.body).toBe(200);expect(old.json().data.receipts).toHaveLength(100);expect(old.json().data).not.toHaveProperty('receiptsPage')
 })
 it('corrects a cost once, rejects stale snapshot, and blocks a replay after cost-view revocation',async()=>{
  const board=await get();const key=`native-business-${randomUUID()}`;const payload={expectedObservedAt:new Date(board.inventoryObservedAt).toISOString(),expectedWeightedUnitCostMinor:null,weightedUnitCostMinor:'0.123456',reason:'核对原单位成本凭证'}
  const request={method:'POST' as const,url:'/api/native/inventory/items/'+item+'/cost-corrections',headers:{'idempotency-key':key},payload};const first=await app.inject(request);expect(first.statusCode,first.body).toBe(200);expect(first.json().data.weightedUnitCostMinor).toBe('0.123456')
  expect((await app.inject({...request,headers:{'idempotency-key':`native-business-${randomUUID()}`}})).json().error.commitDisposition).toBe('not_committed')
  await admin.query('DELETE FROM mbox.idempotency_records WHERE tenant_id=$1 AND store_id=$2 AND idempotency_key=$3',[scope.tenantId,scope.storeId,key]);const replay=await app.inject(request);expect(replay.statusCode,replay.body).toBe(200);expect(replay.json()).toMatchObject({data:first.json().data,meta:{replayed:true}})
  expect((await admin.query('SELECT count(*)::int n FROM mbox.inventory_cost_corrections WHERE inventory_item_id=$1',[item])).rows[0].n).toBe(1)
  await admin.query("DELETE FROM mbox.role_permission_assignments a USING mbox.staff_permission_definitions p WHERE a.permission_id=p.id AND a.role_id=$1 AND p.code='inventory.cost.view'",[role]);expect((await app.inject(request)).statusCode).toBe(403);const hidden=await get();expect(hidden.items[0]).not.toHaveProperty('weightedUnitCostMinor');expect(hidden.receipts[0]).not.toHaveProperty('supplierRef')
 })
})
