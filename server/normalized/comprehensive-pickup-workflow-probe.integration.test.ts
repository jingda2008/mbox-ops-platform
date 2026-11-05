import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import Fastify from 'fastify';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runNormalizedMigrations } from '../migrate-normalized.js';
import { ScopedPostgresTransactionRunner } from './transaction-runner.js';
import { NormalizedCommandExecutor } from './command-executor.js';
import { pickupWorkflowApiPlugin } from './pickup-workflow-api.js';
const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL;
const integration = databaseUrl && process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL ? describe : describe.skip;
integration('trusted pickup exact physical transaction boundary', () => {
    const tenantId = randomUUID(), storeId = randomUUID(), employeeId = randomUUID(), areaId = randomUUID(), productId = randomUUID(), roleId = randomUUID();
    const credentialId = randomUUID(), leaseId = randomUUID(), staffSessionId = randomUUID(), scope = { tenantId, storeId };
    let currentSessionId = staffSessionId;
    const latency: Array<Record<string, unknown>> = [];
    let pool: Pool, runner: ScopedPostgresTransactionRunner, runtime: ScopedPostgresTransactionRunner, businessDate: string;
    let beforeExecute: (() => Promise<void>) | undefined, runtimePool: Pool;
    const app = Fastify({ logger: { level: 'error' } });
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
        for (const code of ['kds.prepare', 'kds.deliver', 'table.transfer', 'fulfillment.view_all', 'staff.access.configure', 'kds.exception.manage']) {
            const permission = (await pool.query("INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name,category) VALUES($1,$2,$3,$3,'operations') ON CONFLICT(tenant_id,store_id,code) DO UPDATE SET name=EXCLUDED.name RETURNING id", [tenantId, storeId, code])).rows[0].id;
            await pool.query('INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) VALUES($1,$2,$3,$4)', [tenantId, storeId, roleId, permission]);
        }
        await pool.query(`INSERT INTO mbox.role_data_scopes(tenant_id,store_id,role_id,scope_key,effect,scope_value,value_kind,text_values,enabled) VALUES($1,$2,$3,'kds.station_codes','include','["kitchen"]','text_set',ARRAY['kitchen'],true)`, [tenantId, storeId, roleId]);
        await pool.query("INSERT INTO mbox.store_daily_credentials(id,tenant_id,store_id,business_date,credential_hash,valid_from,valid_until,configured_by_employee_id) VALUES($1,$2,$3,current_date,'scrypt$kitchen-test',clock_timestamp()-interval '1 hour',clock_timestamp()+interval '8 hours',$4)", [credentialId, tenantId, storeId, employeeId]);
        await pool.query("INSERT INTO mbox.store_device_access_leases(id,tenant_id,store_id,daily_credential_id,business_date,device_key_hash,lease_token_hash,issued_at,expires_at) VALUES($1,$2,$3,$4,current_date,repeat('a',64),repeat('b',64),clock_timestamp()-interval '1 hour',clock_timestamp()+interval '8 hours')", [leaseId, tenantId, storeId, credentialId]);
        // Session expiry is constrained to exactly six hours after issuance; all fixture times must share one statement timestamp.
        await pool.query("INSERT INTO mbox.staff_sessions(id,tenant_id,store_id,employee_id,device_access_lease_id,session_token_hash,issued_at,expires_at,online_lease_until) VALUES($1,$2,$3,$4,$5,repeat('c',64),statement_timestamp(),statement_timestamp()+interval '6 hours',statement_timestamp()+interval '30 minutes')", [staffSessionId, tenantId, storeId, employeeId, leaseId]);
        await pool.query("INSERT INTO mbox.products(id,tenant_id,store_id,code,name,category_code,fulfillment_station) VALUES($1,$2,$3,'K-FOOD','测试薯条','food','kitchen')", [productId, tenantId, storeId]);
        await app.register(pickupWorkflowApiPlugin, { enabled: true, prefix: '/api', staffAccessTransactions: runtime, commandExecutor: { execute: (async (...args: Parameters<NormalizedCommandExecutor['execute']>) => { const hook = beforeExecute; beforeExecute = undefined; await hook?.(); return new NormalizedCommandExecutor(runtime).execute(...args); }) as NormalizedCommandExecutor['execute'] }, resolveContext: () => ({ scope, employeeId, staffSessionId: currentSessionId, deviceAccessLeaseId: leaseId, businessDate }) });
    }, 30000);
    afterAll(async () => {
        await app.close();
        await pool?.end();
        await runtimePool?.end();
        if (process.env.PICKUP_LATENCY_OUTPUT) {
            const paths = ['server/normalized/pickup-workflow-api.ts', 'server/normalized/pickup-workflow-query.ts', 'server/normalized/pickup-workflow-repository.ts', 'server/normalized/pickup-workflow.test.ts', 'server/normalized/item-quantity-projection.ts', 'src/shared/pickup-workflow.ts', 'database/normalized-migrations/225_loyalty_order_financial_basis.sql', 'database/normalized-migrations/226_inventory_waste_receipts.sql', 'database/normalized-migrations/227_staff_permission_deployment_recovery.sql', 'database/normalized-migrations/228_three_screen_workflow.sql'];
            writeFileSync(process.env.PICKUP_LATENCY_OUTPUT, JSON.stringify({ measuredAt: new Date().toISOString(), boundary: 'Local Fastify.inject plus isolated PostgreSQL under mbox_runtime, sequential regression with accumulated fixture data; excludes physical production, network, touch and delivery travel.', outsideScopeFixtureUnits: 1000, forceGenericPlan: process.env.PICKUP_FORCE_GENERIC_PLAN === 'true', sourceSha256: Object.fromEntries(paths.map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')])), samples: latency }, null, 2));
        }
    });
    it('pickup configuration receipt must reject role revoked after route authorization', async () => {
        const key = randomUUID(), send = (k: string) => app.inject({ method: 'POST', url: '/api/commerce/pickup-board/device', headers: { 'idempotency-key': k }, payload: { enabled: true, label: '隔离取货设备' } }), first = await send(key);
        expect(first.statusCode, first.body).toBe(200);
        const count = async () => (await pool.query('SELECT count(*)::int n FROM mbox.audit_events WHERE tenant_id=$1', [tenantId])).rows[0].n, before = await count();
        beforeExecute = async () => { await pool.query('DELETE FROM mbox.role_permission_assignments WHERE tenant_id=$1', [tenantId]); };
        const recovered = await send(key), fresh = await send(randomUUID());
        console.info(JSON.stringify({ case: 'pickup-device', mode: 'preflight-revoked-receipt', status: recovered.statusCode, freshStatus: fresh.statusCode, response: recovered.json(), before, after: await count() }));
        expect(fresh.statusCode, fresh.body).toBe(403);
        expect(recovered.statusCode, recovered.body).toBe(403);
    });
});
