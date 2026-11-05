import {QuantityRedeliveryCommandService} from './quantity-redelivery-command-service.js'
import {QuantityRemakeCommandService} from './quantity-remake-command-service.js'
import {QuantityRemakeHandoverCommand} from './quantity-remake-handover.js'
import {IdempotencyReceiptUnavailableError} from './command-executor.js'
import { itemAfterSalesApiPlugin } from './item-after-sales-api.js';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runNormalizedMigrations } from '../migrate-normalized.js';
import { ScopedPostgresTransactionRunner } from './transaction-runner.js';
import { NormalizedCommandExecutor } from './command-executor.js';
import { KdsRepository } from './kds-repository.js';
import { OrderRepository } from './order-repository.js';
import { kitchenProductionApiPlugin } from './kitchen-production-api.js';
const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL;
const integration = databaseUrl && process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL ? describe : describe.skip;
integration('after-sales durable recovery', () => {
    const tenantId = randomUUID(), storeId = randomUUID(), employeeId = randomUUID(), areaId = randomUUID(), productId = randomUUID(), roleId = randomUUID();
    const credentialId = randomUUID(), leaseId = randomUUID(), staffSessionId = randomUUID(), scope = { tenantId, storeId };
    let pool: Pool, runner: ScopedPostgresTransactionRunner, runtime: ScopedPostgresTransactionRunner, businessDate: string;
    let beforeExecute: (() => Promise<void>) | undefined, runtimePool: Pool;
    const app = Fastify();
    beforeAll(async () => {
        await runNormalizedMigrations(databaseUrl!);
        pool = new Pool({ connectionString: databaseUrl, max: 8 });
        runner = new ScopedPostgresTransactionRunner(pool);
        runtimePool = new Pool({ connectionString: process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL });
        runtime = new ScopedPostgresTransactionRunner(runtimePool);
        await pool.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'Kitchen isolation')", [tenantId, `k-${tenantId}`]);
        await pool.query("INSERT INTO mbox.stores(id,tenant_id,code,name,timezone,business_day_cutoff) VALUES($1,$2,'kitchen-store','Kitchen','Asia/Shanghai','06:00')", [storeId, tenantId]);
        businessDate = await runner.run(scope, async (tx) => (await tx.query<{
            date: string;
        }>('SELECT mbox.current_operating_business_date($1,$2)::text AS date', [tenantId, storeId])).rows[0]!.date);
        await pool.query("INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type) VALUES($1,$2,$3,'K','K','indoor')", [areaId, tenantId, storeId]);
        await pool.query("INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$2,$3,'cook','测试厨师')", [employeeId, tenantId, storeId]);
        await pool.query("INSERT INTO mbox.roles(id,tenant_id,store_id,code,name) VALUES($1,$2,$3,'KITCHEN_TEST','Kitchen')", [roleId, tenantId, storeId]);
        await pool.query("INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id,starts_at) VALUES($1,$2,$3,$4,clock_timestamp()-interval '1 hour')", [tenantId, storeId, employeeId, roleId]);
        for (const code of ['kds.prepare', 'kds.deliver', 'table.transfer', 'fulfillment.view_all', 'refund.request', 'table.view_all']) {
            const permission = (await pool.query("INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name,category) VALUES($1,$2,$3,$3,'operations') ON CONFLICT(tenant_id,store_id,code) DO UPDATE SET name=EXCLUDED.name RETURNING id", [tenantId, storeId, code])).rows[0].id;
            await pool.query('INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [tenantId, storeId, roleId, permission]);
        }
        await pool.query(`INSERT INTO mbox.role_data_scopes(tenant_id,store_id,role_id,scope_key,effect,scope_value,value_kind,text_values,enabled) VALUES($1,$2,$3,'kds.station_codes','include','["kitchen"]','text_set',ARRAY['kitchen'],true)`, [tenantId, storeId, roleId]);
        await pool.query("INSERT INTO mbox.store_daily_credentials(id,tenant_id,store_id,business_date,credential_hash,valid_from,valid_until,configured_by_employee_id) VALUES($1,$2,$3,current_date,'scrypt$kitchen-test',clock_timestamp()-interval '1 hour',clock_timestamp()+interval '8 hours',$4)", [credentialId, tenantId, storeId, employeeId]);
        await pool.query("INSERT INTO mbox.store_device_access_leases(id,tenant_id,store_id,daily_credential_id,business_date,device_key_hash,lease_token_hash,issued_at,expires_at) VALUES($1,$2,$3,$4,current_date,repeat('a',64),repeat('b',64),clock_timestamp()-interval '1 hour',clock_timestamp()+interval '8 hours')", [leaseId, tenantId, storeId, credentialId]);
        // Session expiry is constrained to exactly six hours after issuance; all fixture times must share one statement timestamp.
        await pool.query("INSERT INTO mbox.staff_sessions(id,tenant_id,store_id,employee_id,device_access_lease_id,session_token_hash,issued_at,expires_at,online_lease_until) VALUES($1,$2,$3,$4,$5,repeat('c',64),statement_timestamp(),statement_timestamp()+interval '6 hours',statement_timestamp()+interval '30 minutes')", [staffSessionId, tenantId, storeId, employeeId, leaseId]);
        await pool.query("INSERT INTO mbox.products(id,tenant_id,store_id,code,name,category_code,fulfillment_station) VALUES($1,$2,$3,'K-FOOD','测试薯条','food','kitchen')", [productId, tenantId, storeId]);
        await app.register(kitchenProductionApiPlugin, { enabled: true, prefix: '/api', staffAccessTransactions: runtime, commandExecutor: { execute: (async (...args: Parameters<NormalizedCommandExecutor['execute']>) => { const hook = beforeExecute; beforeExecute = undefined; await hook?.(); return new NormalizedCommandExecutor(runtime).execute(...args); }) as NormalizedCommandExecutor['execute'] }, resolveContext: () => ({ scope, employeeId, staffSessionId, deviceAccessLeaseId: leaseId, businessDate }), createKdsRepository: tx => new KdsRepository(tx), createOrderRepository: tx => new OrderRepository(tx) });
        await app.register(itemAfterSalesApiPlugin, { prefix: '/api', transactions: runtime, commands: new NormalizedCommandExecutor(runtime), enabled: true, resolveContext: () => ({ scope, employeeId, businessDate, capabilities: [] }) });
    }, 30000);
    beforeEach(async () => {
        await pool.query('INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) SELECT $1,$2,$3,id FROM mbox.staff_permission_definitions WHERE tenant_id=$1 AND store_id=$2 ON CONFLICT DO NOTHING', [tenantId, storeId, roleId]);
    });
    afterAll(async () => { await app.close(); await pool?.end(); await runtimePool?.end(); });
    it.each(['request','complete','cancel','remake','handover'])('does not execute missing or expired Web recovery: %s', async action => {
      const id=randomUUID(),key='item-after-sales-'+randomUUID(),commands=new NormalizedCommandExecutor(runtime)
      const input={scope,employeeId,businessDate,idempotencyKey:key,reason:'原操作只读恢复',replayOnly:true}
      const run=()=>action==='request'?new QuantityRedeliveryCommandService(commands).request({...input,orderItemId:id,quantity:1,originalGoodsAvailable:true})
        :action==='complete'?new QuantityRedeliveryCommandService(commands).complete({...input,redeliveryId:id,quantity:1})
        :action==='cancel'?new QuantityRedeliveryCommandService(commands).cancel({...input,redeliveryId:id})
        :action==='remake'?new QuantityRemakeCommandService(commands,true).create({...input,taskId:id,quantity:1,originalGoodsLost:true,staffSessionId,deviceAccessLeaseId:leaseId})
        :new QuantityRemakeHandoverCommand(commands).dispose({...input,batchId:id,unitIds:[randomUUID()],disposition:'used_loss',unopenedReceived:false})
      const count=async()=>Number((await pool.query('SELECT count(*) FROM mbox.idempotency_records WHERE tenant_id=$1 AND idempotency_key=$2',[tenantId,key])).rows[0].count)
      await expect(run()).rejects.toBeInstanceOf(IdempotencyReceiptUnavailableError)
      expect(await count()).toBe(0)
      const operationScope=action==='remake'?'quantity.remake.create':action==='handover'?'quantity.remake.handover':`quantity.redelivery.${action}`
      await commands.execute({scope,operationScope,idempotencyKey:key,requestFingerprint:'old',resultCodec:{encode:()=>({ok:true}),decode:()=>({ok:true})}},async()=>({result:{ok:true},auditEvents:[],outboxMessages:[]}))
      await pool.query("UPDATE mbox.idempotency_records SET created_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND idempotency_key=$2",[tenantId,key])
      await expect(run()).rejects.toBeInstanceOf(IdempotencyReceiptUnavailableError)
      expect(await count()).toBe(1)
    })
    it.each(['redeliveries','redeliveries/:id/complete','redeliveries/:id/cancel','remakes/:id/after-visit-physical'])('honors Web recovery header at HTTP entry: %s',async path=>{
      const response=await app.inject({method:'POST',url:'/api/commerce/item-after-sales/'+path.replace(':id',randomUUID()),headers:{'idempotency-key':'item-after-sales-'+randomUUID(),'x-mbox-replay-only':'true'},payload:{reason:'原记录恢复',orderItemId:randomUUID(),quantity:1,originalGoodsAvailable:true,disposition:'used_loss',unitIds:[randomUUID()]}})
      expect(response.statusCode,response.body).toBe(409)
      expect(response.json().error.code).toBe('IDEMPOTENCY_RECEIPT_UNAVAILABLE')
    })
    async function table() { const id = randomUUID(); await pool.query("INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) VALUES($1,$2,$3,$4,$5,$5,8)", [id, tenantId, storeId, areaId, `T${id.slice(0, 8)}`]); return id; }
    async function item(note = '', stock = false) {
        const tableId = await table(), tableSessionId = randomUUID(), orderId = randomUUID(), itemId = randomUUID(), taskId = randomUUID();
        await pool.query('INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count) VALUES($1,$2,$3,$4,$5,$6,2)', [tableSessionId, tenantId, storeId, tableId, `s-${tableSessionId}`, businessDate]);
        await pool.query("INSERT INTO mbox.orders(id,tenant_id,store_id,table_session_id,public_id,channel,status,submitted_at,subtotal_amount_minor,total_amount_minor) VALUES($1,$2,$3,$4,$5,'staff_assisted','submitted',clock_timestamp(),5000,5000)", [orderId, tenantId, storeId, tableSessionId, `k-${orderId}`]);
        await pool.query(`INSERT INTO mbox.order_items(id,tenant_id,store_id,order_id,product_id,quantity,unit_price_minor,total_amount_minor,fulfillment_station,product_snapshot,note) VALUES($1,$2,$3,$4,$5,5,1000,5000,'kitchen',$6::jsonb,$7)`, [itemId, tenantId, storeId, orderId, productId, JSON.stringify({ name: '测试薯条', inventoryControlMode: stock ? 'tracked' : 'not_managed' }), note]);
        await pool.query("INSERT INTO mbox.kds_tasks(id,tenant_id,store_id,order_item_id,station_code,quantity) VALUES($1,$2,$3,$4,'kitchen',5)", [taskId, tenantId, storeId, itemId]);
        const stockId = randomUUID();
        if (stock) {
            await pool.query("INSERT INTO mbox.inventory_items(id,tenant_id,store_id,sku,name,item_type,base_unit) VALUES($1,$2,$3,$4,'薯条材料','food','piece')", [stockId, tenantId, storeId, `K-${stockId}`]);
            await pool.query('INSERT INTO mbox.inventory_balances(tenant_id,store_id,inventory_item_id,on_hand_quantity,reserved_quantity) VALUES($1,$2,$3,10,5)', [tenantId, storeId, stockId]);
            await pool.query("INSERT INTO mbox.inventory_order_reservations(tenant_id,store_id,order_id,order_item_id,inventory_item_id,quantity,expires_at) VALUES($1,$2,$3,$4,$5,5,clock_timestamp()+interval '1 hour')", [tenantId, storeId, orderId, itemId, stockId]);
        }
        return { taskId, itemId, tableId, tableSessionId, orderId, stockId };
    }
    it('item after-sales original receipt must reject revoked requester permission', async () => {
        const row = await item(), key = randomUUID(), url = '/api/commerce/item-after-sales/requests', body = { orderItemId: row.itemId, quantity: 1, reason: '隔离商品售后检查' }, send = (k: string) => app.inject({ method: 'POST', url, headers: { 'idempotency-key': k }, payload: body });
        const first = await send(key);
        expect(first.statusCode, first.body).toBe(201);
        const count = async () => (await pool.query('SELECT count(*)::int n FROM mbox.item_after_sales_cases WHERE tenant_id=$1', [tenantId])).rows[0].n, before = await count();
        await pool.query('DELETE FROM mbox.role_permission_assignments WHERE tenant_id=$1', [tenantId]);
        const fresh = await send(randomUUID()), recovered = await send(key);
        console.info(JSON.stringify({ case: 'item-after-sales', mode: 'direct-revoked-retry', status: recovered.statusCode, freshStatus: fresh.statusCode, replayed: recovered.json().replayed, before, after: await count() }));
        expect(fresh.statusCode, fresh.body).toBe(403);
        expect(recovered.statusCode, recovered.body).toBe(403);
    });
    it('expired after-sales receipt must never execute the persisted original intent again', async () => {
        await pool.query('INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) SELECT $1,$2,$3,id FROM mbox.staff_permission_definitions WHERE tenant_id=$1 AND store_id=$2 ON CONFLICT DO NOTHING', [tenantId, storeId, roleId]);
        const row = await item(), key = 'item-after-sales-' + randomUUID(), body = { orderItemId: row.itemId, quantity: 1, reason: '隔离过期原操作恢复' }, send = () => app.inject({ method: 'POST', url: '/api/commerce/item-after-sales/requests', headers: { 'idempotency-key': key }, payload: body });
        const first = await send();
        expect(first.statusCode, first.body).toBe(201);
        const facts = async () => (await pool.query(`SELECT (SELECT count(*)::int FROM mbox.item_after_sales_cases WHERE tenant_id=$1 AND order_id=$3) cases,
      (SELECT count(*)::int FROM mbox.order_item_quantity_units WHERE tenant_id=$1 AND order_item_id=$2 AND stopped_by_case_id IS NOT NULL) stopped,
      (SELECT COALESCE(sum(amount_minor),0)::int FROM mbox.item_receivable_adjustments WHERE tenant_id=$1 AND order_id=$3) reducedMinor`, [tenantId, row.itemId, row.orderId])).rows[0], before = await facts();
        const receipt = (await pool.query('SELECT operation_scope,expires_at::text FROM mbox.idempotency_records WHERE tenant_id=$1 AND idempotency_key=$2', [tenantId, key])).rows;
        await pool.query("UPDATE mbox.idempotency_records SET created_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND idempotency_key=$2", [tenantId, key]);
        const replay = await send(), after = await facts();
        console.info(JSON.stringify({ case: 'after-sales-expired-receipt', mode: 'same-persisted-original-key-after-cache-expiry', firstStatus: first.statusCode, status: replay.statusCode, replayed: replay.json().replayed, before, after, receipt, firstData: first.json().data, replayData: replay.json().data, error: replay.json().error }));
        expect(after).toEqual(before);
        if (replay.statusCode === 200)
            expect(replay.json().data).toEqual(first.json().data);
        else
            expect([409, 410]).toContain(replay.statusCode);
    });
    it('a retained receipt recovers once; changed input conflicts without another stop', async () => {
        const row = await item(), key = 'item-after-sales-' + randomUUID(), body = { orderItemId: row.itemId, quantity: 1, reason: '原商品操作恢复' };
        const send = (payload = body) => app.inject({ method: 'POST', url: '/api/commerce/item-after-sales/requests', headers: { 'idempotency-key': key }, payload });
        const first = await send();
        expect(first.statusCode, first.body).toBe(201);
        const again = await send();
        expect(again.statusCode, again.body).toBe(200);
        expect(again.json().data).toEqual(first.json().data);
        expect((await pool.query('SELECT expires_at::text FROM mbox.idempotency_records WHERE tenant_id=$1 AND idempotency_key=$2', [tenantId, key])).rows[0].expires_at).toBe('infinity');
        expect((await send({ ...body, quantity: 2 })).statusCode).toBe(409);
        expect((await pool.query('SELECT count(*)::int n FROM mbox.item_after_sales_cases WHERE tenant_id=$1 AND order_id=$2', [tenantId, row.orderId])).rows[0].n).toBe(1);
    });
    it.each(['never-committed', 'deleted'])('read-only %s recovery never creates another case or receipt', async (state) => {
        const row = await item(), key = 'item-after-sales-' + randomUUID(), body = { orderItemId: row.itemId, quantity: 1, reason: '核对原操作回执' };
        const send = (recovery = false) => app.inject({ method: 'POST', url: '/api/commerce/item-after-sales/requests', headers: { 'idempotency-key': key, ...(recovery ? { 'x-mbox-replay-only': 'true' } : {}) }, payload: body });
        if (state === 'deleted') {
            const first = await send();
            expect(first.statusCode, first.body).toBe(201);
            await pool.query('DELETE FROM mbox.idempotency_records WHERE tenant_id=$1 AND idempotency_key=$2', [tenantId, key]);
        }
        const result = await send(true);
        expect(result.statusCode, result.body).toBe(409);
        expect(result.json().error.code).toBe('IDEMPOTENCY_RECEIPT_UNAVAILABLE');
        expect((await pool.query('SELECT count(*)::int n FROM mbox.item_after_sales_cases WHERE tenant_id=$1 AND order_id=$2', [tenantId, row.orderId])).rows[0].n).toBe(state === 'deleted' ? 1 : 0);
        expect((await pool.query('SELECT count(*)::int n FROM mbox.idempotency_records WHERE tenant_id=$1 AND idempotency_key=$2', [tenantId, key])).rows[0].n).toBe(0);
    });
});
