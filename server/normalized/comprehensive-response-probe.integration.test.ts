import { commerceKdsApiPlugin } from './commerce-kds-api.js';
import { StaffAccessRepository } from './staff-access-repository.js';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runNormalizedMigrations } from '../migrate-normalized.js';
import { ScopedPostgresTransactionRunner } from './transaction-runner.js';
import { NormalizedCommandExecutor } from './command-executor.js';
import { KdsRepository } from './kds-repository.js';
import { OrderRepository } from './order-repository.js';
import { FulfillmentQueryService } from './fulfillment-query-service.js';
import { kitchenProductionApiPlugin } from './kitchen-production-api.js';
const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL;
const integration = databaseUrl && process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL ? describe : describe.skip;
integration('delivery public response and original facts', () => {
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
        for (const code of ['kds.prepare', 'kds.deliver', 'table.transfer', 'fulfillment.view_all']) {
            const permission = (await pool.query("INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name,category) VALUES($1,$2,$3,$3,'operations') ON CONFLICT(tenant_id,store_id,code) DO UPDATE SET name=EXCLUDED.name RETURNING id", [tenantId, storeId, code])).rows[0].id;
            await pool.query('INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) VALUES($1,$2,$3,$4)', [tenantId, storeId, roleId, permission]);
        }
        await pool.query(`INSERT INTO mbox.role_data_scopes(tenant_id,store_id,role_id,scope_key,effect,scope_value,value_kind,text_values,enabled) VALUES($1,$2,$3,'kds.station_codes','include','["kitchen"]','text_set',ARRAY['kitchen'],true)`, [tenantId, storeId, roleId]);
        await pool.query("INSERT INTO mbox.store_daily_credentials(id,tenant_id,store_id,business_date,credential_hash,valid_from,valid_until,configured_by_employee_id) VALUES($1,$2,$3,current_date,'scrypt$kitchen-test',clock_timestamp()-interval '1 hour',clock_timestamp()+interval '8 hours',$4)", [credentialId, tenantId, storeId, employeeId]);
        await pool.query("INSERT INTO mbox.store_device_access_leases(id,tenant_id,store_id,daily_credential_id,business_date,device_key_hash,lease_token_hash,issued_at,expires_at) VALUES($1,$2,$3,$4,current_date,repeat('a',64),repeat('b',64),clock_timestamp()-interval '1 hour',clock_timestamp()+interval '8 hours')", [leaseId, tenantId, storeId, credentialId]);
        // Session expiry is constrained to exactly six hours after issuance; all fixture times must share one statement timestamp.
        await pool.query("INSERT INTO mbox.staff_sessions(id,tenant_id,store_id,employee_id,device_access_lease_id,session_token_hash,issued_at,expires_at,online_lease_until) VALUES($1,$2,$3,$4,$5,repeat('c',64),statement_timestamp(),statement_timestamp()+interval '6 hours',statement_timestamp()+interval '30 minutes')", [staffSessionId, tenantId, storeId, employeeId, leaseId]);
        await pool.query("INSERT INTO mbox.products(id,tenant_id,store_id,code,name,category_code,fulfillment_station,cost_amount_minor) VALUES($1,$2,$3,'K-FOOD','测试薯条','food','kitchen',321)", [productId, tenantId, storeId]);
        await app.register(kitchenProductionApiPlugin, { enabled: true, prefix: '/api', staffAccessTransactions: runtime, commandExecutor: { execute: (async (...args: Parameters<NormalizedCommandExecutor['execute']>) => { const hook = beforeExecute; beforeExecute = undefined; await hook?.(); return new NormalizedCommandExecutor(runtime).execute(...args); }) as NormalizedCommandExecutor['execute'] }, resolveContext: () => ({ scope, employeeId, staffSessionId, deviceAccessLeaseId: leaseId, businessDate }), createKdsRepository: tx => new KdsRepository(tx), createOrderRepository: tx => new OrderRepository(tx) });
        await app.register(commerceKdsApiPlugin, { prefix: '/api', commerce: {} as never, fulfillmentQuery: new FulfillmentQueryService(runtime), commandExecutor: new NormalizedCommandExecutor(runtime), staffAccessTransactions: runtime, resolveContext: () => ({ scope, employeeId, businessDate, staffSessionId, deviceAccessLeaseId: leaseId }), createKdsRepository: tx => new KdsRepository(tx), createOrderRepository: tx => new OrderRepository(tx) });
    }, 30000);
    afterAll(async () => { await app.close(); await pool?.end(); await runtimePool?.end(); });
    async function table() { const id = randomUUID(); await pool.query("INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) VALUES($1,$2,$3,$4,$5,$5,8)", [id, tenantId, storeId, areaId, `T${id.slice(0, 8)}`]); return id; }
    async function item(note = '', stock = false) {
        const tableId = await table(), tableSessionId = randomUUID(), orderId = randomUUID(), itemId = randomUUID(), taskId = randomUUID();
        await pool.query('INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count) VALUES($1,$2,$3,$4,$5,$6,2)', [tableSessionId, tenantId, storeId, tableId, `s-${tableSessionId}`, businessDate]);
        await pool.query("INSERT INTO mbox.orders(id,tenant_id,store_id,table_session_id,public_id,channel,status,submitted_at,subtotal_amount_minor,total_amount_minor) VALUES($1,$2,$3,$4,$5,'staff_assisted','submitted',clock_timestamp(),5000,5000)", [orderId, tenantId, storeId, tableSessionId, `k-${orderId}`]);
        await pool.query(`INSERT INTO mbox.order_items(id,tenant_id,store_id,order_id,product_id,quantity,unit_price_minor,total_amount_minor,fulfillment_station,product_snapshot,note,unit_cost_minor_at_submission,total_cost_minor_at_submission,cost_source,cost_reference_product_id,cost_reference_product_updated_at,cost_snapshot) VALUES($1,$2,$3,$4,$5,5,1000,5000,'kitchen',$6::jsonb,$7,321,1605,'catalog_product',$5,(SELECT updated_at FROM mbox.products WHERE id=$5),'{"unitCostMinor":321,"totalCostMinor":1605,"source":"catalog_product","authority":"strong_order_item_columns"}'::jsonb)`, [itemId, tenantId, storeId, orderId, productId, JSON.stringify({ name: '测试薯条', inventoryControlMode: stock ? 'tracked' : 'not_managed' }), note]);
        await pool.query("INSERT INTO mbox.kds_tasks(id,tenant_id,store_id,order_item_id,station_code,quantity) VALUES($1,$2,$3,$4,'kitchen',5)", [taskId, tenantId, storeId, itemId]);
        const stockId = randomUUID();
        if (stock) {
            await pool.query("INSERT INTO mbox.inventory_items(id,tenant_id,store_id,sku,name,item_type,base_unit) VALUES($1,$2,$3,$4,'薯条材料','food','piece')", [stockId, tenantId, storeId, `K-${stockId}`]);
            await pool.query('INSERT INTO mbox.inventory_balances(tenant_id,store_id,inventory_item_id,on_hand_quantity,reserved_quantity) VALUES($1,$2,$3,10,5)', [tenantId, storeId, stockId]);
            await pool.query("INSERT INTO mbox.inventory_order_reservations(tenant_id,store_id,order_id,order_item_id,inventory_item_id,quantity,expires_at) VALUES($1,$2,$3,$4,$5,5,clock_timestamp()+interval '1 hour')", [tenantId, storeId, orderId, itemId, stockId]);
        }
        return { taskId, itemId, tableId, tableSessionId, orderId, stockId };
    }
    it('delivery response must not expose inventory cost to a delivery-only employee', async () => {
        const row = await item(), send = (action: string, key = randomUUID()) => app.inject({ method: 'POST', url: `/api/commerce/kds/${row.taskId}/actions`, headers: { 'idempotency-key': key }, payload: { action } });
        const allowed = await runtime.run(scope, tx => new StaffAccessRepository(tx).resolve(employeeId));
        expect(allowed.permissions).not.toContain('inventory.cost.view');
        const completed = await send('complete');
        expect(completed.statusCode, completed.body).toBe(200);
        const first = await send('deliver');
        expect(first.statusCode, first.body).toBe(200);
        console.info(JSON.stringify({ case: 'delivery-cost', mode: 'employee-without-cost-permission', status: first.statusCode, costSnapshot: first.json().deliveredOrderItem?.costSnapshot }));
        expect(first.json().deliveredOrderItem?.costSnapshot?.unitCostMinor).toBeUndefined();
    });
    it('delivery retry must retain the actual original delivery timestamp', async () => {
        const row = await item(), send = (action: string, key = randomUUID()) => app.inject({ method: 'POST', url: `/api/commerce/kds/${row.taskId}/actions`, headers: { 'idempotency-key': key }, payload: { action } });
        expect((await send('complete')).statusCode).toBe(200);
        const key = randomUUID(), first = await send('deliver', key);
        expect(first.statusCode, first.body).toBe(200);
        const replay = await send('deliver', key);
        expect(replay.statusCode, replay.body).toBe(200);
        console.info(JSON.stringify({ case: 'delivery-time', mode: 'same-key-replay', first: first.json().deliveredAt, replay: replay.json().deliveredAt, replayed: replay.json().meta?.replayed }));
        expect(replay.json().deliveredAt).toBe(first.json().deliveredAt);
    });
    it('legacy delivery receipts redact cost and do not invent missing time or employee evidence', async () => {
        const row = await item(), send = (action: string, key = randomUUID()) => app.inject({ method: 'POST', url: `/api/commerce/kds/${row.taskId}/actions`, headers: { 'idempotency-key': key }, payload: { action } });
        expect((await send('complete')).statusCode).toBe(200);
        const key = randomUUID(), first = await send('deliver', key);
        expect(first.statusCode, first.body).toBe(200);
        expect(first.json().deliveredAt).toBeTruthy();
        expect(first.json().deliveredBy).toBe(employeeId);
        await pool.query(`UPDATE mbox.idempotency_records SET response_snapshot=jsonb_set(response_snapshot,'{result}',(response_snapshot->'result')-'deliveredAt'-'deliveredBy')
      WHERE tenant_id=$1 AND idempotency_key=$2 AND operation_scope='commerce.kds.action'`, [tenantId, key]);
        const replay = await send('deliver', key);
        expect(replay.statusCode, replay.body).toBe(200);
        expect(replay.json()).toMatchObject({ deliveredAt: null, deliveredBy: null, meta: { replayed: true } });
        for (const field of ['costSnapshot', 'unitCostMinorAtSubmission', 'totalCostMinorAtSubmission', 'costSource', 'costReferenceProductId'])
            expect(replay.json().deliveredOrderItem[field]).toBeUndefined();
    });
});
