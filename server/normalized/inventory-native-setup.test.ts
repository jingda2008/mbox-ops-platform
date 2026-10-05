import {randomUUID} from 'node:crypto';
import Fastify,{type FastifyInstance} from 'fastify';
import {Pool} from 'pg';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {runNormalizedMigrations} from '../migrate-normalized.js';
import {NormalizedCommandExecutor} from './command-executor.js';
import {inventoryApiPlugin} from './inventory-api.js';
import {InventoryQueryService} from './inventory-query-service.js';
import {ScopedPostgresTransactionRunner,type PostgresPool} from './transaction-runner.js';

const databaseUrl=process.env.TEST_NORMALIZED_DATABASE_URL;
const integration=databaseUrl?describe:describe.skip;
integration('native inventory material setup and atomic receipt publication',()=>{
  const tenantId=randomUUID(),storeId=randomUUID(),managerId=randomUUID(),otherManagerId=randomUUID(),viewerId=randomUUID(),roleId=randomUUID();
  let pool:Pool,runtime:Pool,app:FastifyInstance;
  const permissions=['inventory.manage','inventory.receive','inventory.view','inventory.cost.view','catalog.product.manage'];
  beforeAll(async()=>{
    await runNormalizedMigrations(databaseUrl!);pool=new Pool({connectionString:databaseUrl});
    await pool.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'Native Inventory')",[tenantId,`native-inv-${tenantId.slice(0,8)}`]);
    await pool.query("INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1,$2,'store','Native Inventory')",[storeId,tenantId]);
    await pool.query("INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$4,$5,'manager','Manager'),($2,$4,$5,'viewer','Viewer'),($3,$4,$5,'other','Other')",[managerId,viewerId,otherManagerId,tenantId,storeId]);
    await pool.query("INSERT INTO mbox.roles(id,tenant_id,store_id,code,name) VALUES($1,$2,$3,'MANAGER','Manager')",[roleId,tenantId,storeId]);
    await pool.query('INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id) VALUES($1,$2,$3,$5),($1,$2,$4,$5)',[tenantId,storeId,managerId,otherManagerId,roleId]);
    for(const code of permissions){
      await pool.query("INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name,category) VALUES($1,$2,$3,$3,'inventory') ON CONFLICT(tenant_id,store_id,code) DO UPDATE SET status='active'",[tenantId,storeId,code]);
      await grant(code);
    }
    runtime=new Pool({connectionString:process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL??databaseUrl});
    const runner=new ScopedPostgresTransactionRunner(runtime as unknown as PostgresPool);
    app=Fastify();await app.register(inventoryApiPlugin,{prefix:'/api',transactions:runner,commands:new NormalizedCommandExecutor(runner),query:new InventoryQueryService(runner),
      resolveContext(req){return {scope:{tenantId,storeId},employeeId:String(req.headers['x-employee-id']??managerId),businessDate:'2026-10-05',capabilities:[]}}});
    await app.ready();
  });
  afterAll(async()=>{await app?.close();await runtime?.end();await pool?.end()});
  function headers(key=randomUUID(),employeeId=managerId){return {'idempotency-key':key,'x-employee-id':employeeId}}
  async function grant(code:string){await pool.query('INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) SELECT $1,$2,$3,id FROM mbox.staff_permission_definitions WHERE tenant_id=$1 AND store_id=$2 AND code=$4',[tenantId,storeId,roleId,code]);}
  async function revoke(code:string){await pool.query('DELETE FROM mbox.role_permission_assignments a USING mbox.staff_permission_definitions p WHERE a.permission_id=p.id AND a.role_id=$1 AND p.tenant_id=$2 AND p.store_id=$3 AND p.code=$4',[roleId,tenantId,storeId,code]);}
  async function clearKey(key:string){await pool.query('DELETE FROM mbox.idempotency_records WHERE tenant_id=$1 AND store_id=$2 AND idempotency_key=$3',[tenantId,storeId,key]);}
  const itemBody=(sku=randomUUID())=>({sku,name:'原生测试食品',itemType:'food',baseUnit:'piece',categoryCode:'snack',wholeUnitCount:true,reasonableWasteQuantity:'0'});
  async function createItem(body=itemBody()){const r=await app.inject({method:'POST',url:'/api/native/inventory/items',headers:headers(),payload:body});expect(r.statusCode,r.body).toBe(201);return r.json().data as {id:string}}
  async function readItem(id:string){const r=await app.inject({method:'GET',url:'/api/native/inventory/setup',headers:headers()});expect(r.statusCode,r.body).toBe(200);return r.json().data.items.find((item:{id:string})=>item.id===id)}

  it('creates the first material without initial stock and preserves its exact durable reply across cache loss',async()=>{
    const key=randomUUID(),body=itemBody(),request={method:'POST' as const,url:'/api/native/inventory/items',headers:headers(key),payload:body};
    const created=await app.inject(request);expect(created.statusCode,created.body).toBe(201);const data=created.json().data;
    expect((await readItem(data.id))).toMatchObject({...body,reasonableWasteQuantity:"0.000000",barcodes:[],updatedAt:expect.any(String)});
    expect((await pool.query('SELECT on_hand_quantity::text AS quantity FROM mbox.inventory_balances WHERE inventory_item_id=$1',[data.id])).rows[0].quantity).toBe('0.000000');
    await clearKey(key);const replay=await app.inject(request);expect(replay.statusCode,replay.body).toBe(200);expect(replay.json()).toEqual({data,meta:{replayed:true}});
    expect((await pool.query('SELECT count(*)::int AS count FROM mbox.inventory_items WHERE tenant_id=$1 AND store_id=$2 AND sku=$3',[tenantId,storeId,body.sku])).rows[0].count).toBe(1);
    const wrongActor=await app.inject({...request,headers:headers(key,otherManagerId)});expect(wrongActor.statusCode).toBe(409);
    await revoke('inventory.manage');try{expect((await app.inject(request)).statusCode).toBe(403);await clearKey(key);expect((await app.inject(request)).statusCode).toBe(403)}finally{await grant('inventory.manage')}
    expect((await app.inject({method:'GET',url:'/api/native/inventory/setup',headers:headers(randomUUID(),viewerId)})).statusCode).toBe(403);
  });

  it('keeps web PATCH working, rejects stale native metadata and duplicate SKU without changing stock',async()=>{
    const body=itemBody(),item=await createItem(body),original=await readItem(item.id);
    const edit={method:'POST' as const,url:`/api/native/inventory/items/${item.id}`,headers:headers(),payload:{name:'原生新名称',categoryCode:'snack',lowStockThreshold:'3',packageVolumeMl:null,expectedUpdatedAt:original.updatedAt}};
    expect((await app.inject(edit)).statusCode).toBe(200);
    const stale=await app.inject({...edit,headers:headers(),payload:{...edit.payload,name:'陈旧覆盖'}});expect(stale.statusCode,stale.body).toBe(409);expect(stale.json().error.commitDisposition).toBe('not_committed');
    const duplicate=await app.inject({method:'POST',url:'/api/native/inventory/items',headers:headers(),payload:body});expect(duplicate.statusCode,duplicate.body).toBe(409);expect(duplicate.json().error.commitDisposition).toBe('not_committed');
    const immutable=await app.inject({...edit,headers:headers(),payload:{...edit.payload,baseUnit:'ml'}});expect(immutable.statusCode).toBe(400);
    const web=await app.inject({method:'PATCH',url:`/api/inventory/items/${item.id}`,headers:headers(),payload:{name:'网页修改仍可用',categoryCode:'snack',lowStockThreshold:null,packageVolumeMl:null}});expect(web.statusCode,web.body).toBe(200);
    expect((await readItem(item.id)).name).toBe('网页修改仍可用');
  });

  it('binds the original material and package quantity, keeps durable reply and refuses barcode takeover or invalid millilitres',async()=>{
    const item=await createItem(),other=await createItem(),original=await readItem(item.id),code=`CODE-${randomUUID()}`,key=randomUUID();
    const request={method:'POST' as const,url:`/api/native/inventory/items/${item.id}/barcodes`,headers:headers(key),payload:{code,codeType:'barcode',packageQuantity:'12',expectedUpdatedAt:original.updatedAt}};
    const bound=await app.inject(request);expect(bound.statusCode,bound.body).toBe(200);expect(bound.json().data).toMatchObject({inventoryItemId:item.id,code,codeType:'barcode',packageQuantity:'12'});
    await clearKey(key);const replay=await app.inject(request);expect(replay.json()).toEqual({data:bound.json().data,meta:{replayed:true}});
    const takeover=await app.inject({...request,url:`/api/native/inventory/items/${other.id}/barcodes`,headers:headers(),payload:{...request.payload,expectedUpdatedAt:(await readItem(other.id)).updatedAt}});expect(takeover.statusCode,takeover.body).toBe(409);expect(takeover.json().error.commitDisposition).toBe('not_committed');
    const scan=await app.inject({method:'GET',url:`/api/native/inventory/scan?code=${code}`,headers:headers()});expect(scan.json().data).toMatchObject({inventoryItemId:item.id,packageQuantity:'12.000000'});
    const invalidLiquid=await app.inject({method:'POST',url:'/api/native/inventory/items',headers:headers(),payload:{...itemBody(),categoryCode:'spirits',baseUnit:'bottle',packageVolumeMl:'750'}});expect(invalidLiquid.statusCode).toBe(400);
    const liquid=await app.inject({method:'POST',url:'/api/native/inventory/items',headers:headers(),payload:{...itemBody(),categoryCode:'spirits',baseUnit:'ml',packageVolumeMl:'750'}});expect(liquid.statusCode,liquid.body).toBe(201);const liquidId=liquid.json().data.id;
    const wrongVolume=await app.inject({...request,url:`/api/native/inventory/items/${liquidId}/barcodes`,headers:headers(),payload:{...request.payload,code:randomUUID(),packageQuantity:'1',expectedUpdatedAt:(await readItem(liquidId)).updatedAt}});expect(wrongVolume.statusCode,wrongVolume.body).toBe(409);expect(wrongVolume.json().error.commitDisposition).toBe('not_committed');
  });

  async function publication(){
    const first=await createItem(),second=await createItem(),productId=randomUUID();
    await pool.query(`INSERT INTO mbox.products(id,tenant_id,store_id,code,name,category_code,fulfillment_station,product_kind,status,inventory_control_mode,guest_visible,allowed_channels)
      VALUES($1,$2,$3,$4,'原生发布食品','snack','none','single','inactive','tracked',true,ARRAY['guest_qr','staff_assisted']::text[])`,[productId,tenantId,storeId,`NATIVE-${productId}`]);
    await pool.query("INSERT INTO mbox.product_prices(tenant_id,store_id,product_id,price_type,currency,amount_minor,valid_from) VALUES($1,$2,$3,'standard','CNY',1000,clock_timestamp())",[tenantId,storeId,productId]);
    const recipe=await app.inject({method:'PUT',url:`/api/inventory/products/${productId}/recipe`,headers:headers(),payload:{yieldQuantity:1,components:[{inventoryItemId:first.id,quantity:'1',expectedWasteQuantity:'0'}]}});expect(recipe.statusCode,recipe.body).toBe(200);
    const receipt=await app.inject({method:'POST',url:'/api/inventory/receipts',headers:headers(),payload:{currency:'CNY',invoiceTotalMinor:'1200',lines:[{inventoryItemId:first.id,quantity:'4',totalCostMinor:'400',batchCode:'PRODUCT-BATCH'},{inventoryItemId:second.id,quantity:'8',totalCostMinor:'800',batchCode:'OTHER-BATCH'}]}});expect(receipt.statusCode,receipt.body).toBe(201);
    const receiptId=receipt.json().data.id as string;
    const preview=await app.inject({method:'GET',url:`/api/native/inventory/receipts/${receiptId}/receive-and-publish-preview?productId=${productId}`,headers:headers()});expect(preview.statusCode,preview.body).toBe(200);
    return {first,second,productId,receiptId,preview:preview.json().data};
  }
  function publishRequest(fixture:Awaited<ReturnType<typeof publication>>,key=randomUUID()) {return {method:'POST' as const,url:`/api/native/inventory/receipts/${fixture.receiptId}/receive-and-publish`,headers:headers(key),payload:{productId:fixture.productId,expectedVersion:fixture.preview.expectedVersion}}}
  async function expectUnreceived(fixture:Awaited<ReturnType<typeof publication>>) {
    expect((await pool.query('SELECT status FROM mbox.purchase_receipts WHERE id=$1',[fixture.receiptId])).rows[0].status).toBe('draft');
    expect((await pool.query('SELECT on_hand_quantity::text AS quantity FROM mbox.inventory_balances WHERE inventory_item_id=ANY($1::uuid[])',[ [fixture.first.id,fixture.second.id] ])).rows.map(r=>r.quantity)).toEqual(['0.000000','0.000000']);
    expect((await pool.query('SELECT status FROM mbox.products WHERE id=$1',[fixture.productId])).rows[0].status).toBe('inactive');
  }

  it('previews all receipt lines and atomically receives the full receipt, publishes one product and replays without duplicate stock',async()=>{
    const fixture=await publication(),key=randomUUID(),request=publishRequest(fixture,key);
    expect(fixture.preview).toMatchObject({nativeInventoryPublishProtocol:1,currentEmployeeId:managerId,currency:'CNY',costAmountMinor:100,standardPriceMinor:1000,sellableServings:4,receiptLines:expect.arrayContaining([expect.objectContaining({inventoryItemId:fixture.second.id,quantity:'8.000000'})])});
    const options=await app.inject({method:'GET',url:`/api/native/inventory/receipts/${fixture.receiptId}/publish-options`,headers:headers()});expect(options.statusCode,options.body).toBe(200);expect(options.json().data.receipt.lines).toHaveLength(2);
    const published=await app.inject(request);expect(published.statusCode,published.body).toBe(200);expect(published.json().data).toMatchObject({id:fixture.receiptId,receiptStatus:'received',productId:fixture.productId,productStatus:'active',costAmountMinor:100,standardPriceMinor:1000});
    await clearKey(key);const replay=await app.inject(request);expect(replay.statusCode,replay.body).toBe(200);expect(replay.json()).toEqual({data:published.json().data,meta:{replayed:true}});
    expect((await pool.query('SELECT count(*)::int AS count FROM mbox.inventory_movements WHERE inventory_item_id=ANY($1::uuid[])',[[fixture.first.id,fixture.second.id]])).rows[0].count).toBe(2);
    for(const permission of ['catalog.product.manage','inventory.cost.view']){await revoke(permission);try{expect((await app.inject(request)).statusCode).toBe(403);await clearKey(key);expect((await app.inject(request)).statusCode).toBe(403)}finally{await grant(permission)}}
  });

  it('rolls back receipt, movements and publication if the confirmed price has changed',async()=>{
    const fixture=await publication();await pool.query('UPDATE mbox.product_prices SET amount_minor=1200 WHERE product_id=$1',[fixture.productId]);
    const result=await app.inject(publishRequest(fixture));expect(result.statusCode,result.body).toBe(409);expect(result.json().error.commitDisposition).toBe('not_committed');await expectUnreceived(fixture);
  });

  it('binds unrelated receipt lines too, and rolls back if their quantity changes after preview',async()=>{
    const fixture=await publication();await pool.query('UPDATE mbox.purchase_receipt_lines SET quantity=9 WHERE receipt_id=$1 AND inventory_item_id=$2',[fixture.receiptId,fixture.second.id]);
    const result=await app.inject(publishRequest(fixture));expect(result.statusCode,result.body).toBe(409);expect(result.json().error.commitDisposition).toBe('not_committed');await expectUnreceived(fixture);
  });

  it('previews multiple batches of one material with the same sequential weighted cost as actual receiving',async()=>{
    const fixture=await publication();
    await pool.query(`INSERT INTO mbox.purchase_receipt_lines(id,tenant_id,store_id,receipt_id,inventory_item_id,batch_code,quantity,unit_cost_minor,total_cost_minor)
      VALUES('ffffffff-ffff-4fff-bfff-ffffffffffff',$1,$2,$3,$4,'SECOND-SAME-MATERIAL',2,200,400)`,[tenantId,storeId,fixture.receiptId,fixture.first.id]);
    await pool.query('UPDATE mbox.purchase_receipts SET invoice_total_minor=1600 WHERE id=$1',[fixture.receiptId]);
    const preview=await app.inject({method:'GET',url:`/api/native/inventory/receipts/${fixture.receiptId}/receive-and-publish-preview?productId=${fixture.productId}`,headers:headers()});
    expect(preview.statusCode,preview.body).toBe(200);fixture.preview=preview.json().data;
    expect(fixture.preview).toMatchObject({costAmountMinor:133,sellableServings:6,components:[expect.objectContaining({sourceUnitCostMinor:'133.333333'})]});
    const received=await app.inject(publishRequest(fixture));expect(received.statusCode,received.body).toBe(200);expect(received.json().data.costAmountMinor).toBe(133);
    expect((await pool.query('SELECT on_hand_quantity::text AS quantity,weighted_unit_cost_minor::text AS cost FROM mbox.inventory_balances WHERE inventory_item_id=$1',[fixture.first.id])).rows[0]).toEqual({quantity:'6.000000',cost:'133.333333'});
  });
});
