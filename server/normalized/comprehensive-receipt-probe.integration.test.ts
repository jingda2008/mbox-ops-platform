import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Pool } from 'pg';
import Fastify from 'fastify';
import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest';
import { runNormalizedMigrations } from '../migrate-normalized.js';
import { ScopedPostgresTransactionRunner } from './transaction-runner.js';
import { NormalizedCommandExecutor } from './command-executor.js';
import { assertRuntimeDatabasePool } from './runtime-database-identity.js';
import { holdFixtureReceipts } from './staff-permission.test-helper.js';
import { StaffAccessRepository } from './staff-access-repository.js';
import { normalizedOperationsApiPlugin } from './normalized-operations-api.js';
import { TableManagementRepository } from './table-management-repository.js';
import { TableSessionCommandService, TableSessionRepository } from './table-session-repository.js';
import { ServiceTaskRepository } from './service-task-repository.js';
import { OperationsQueryService } from './operations-query-service.js';
import { paymentFinanceApiPlugin } from './payment-finance-api.js';
import { promotionalLoyaltyApiPlugin } from './promotional-loyalty-api.js';
import { PromotionalLoyaltyService } from './promotional-loyalty-service.js';
import { customerExperienceApiPlugin } from './customer-experience-api.js';
import { CustomerExperienceService } from './customer-experience-service.js';
import { MembershipTermsService } from './membership-terms-service.js';
import { reservationPerformanceApiPlugin } from './reservation-performance-api.js';
import { PerformanceCommandService } from './performance-command-service.js';
import { ReservationCommandService } from './reservation-command-service.js';
import { AiCapabilityCenter, createCoreAiCapabilities } from './ai-capability-center.js';
import { aiExecutionApiPlugin } from './ai-execution-api.js';
import { hardwareApiPlugin } from './hardware-api.js';
import { paymentApiPlugin } from './payment-api.js';
import { PaymentCommandService } from './payment-command-service.js';
import { NormalizedPaymentCapabilityAuthorization } from './payment-security-policy.js';
import { CashHandoverService } from './cash-handover-service.js';
import { LoyaltyOperationalControlService } from './loyalty-operational-control-service.js';
import { registerNativeTableConfiguration } from './native-table-configuration.js';
import { guestCommerceServiceApiPlugin } from './guest-commerce-service-api.js';
import { seedActiveGuestTableAuthority } from './guest-table-authority.test-helper.js';
import { staffAuthorizedCommands } from './staff-authorized-command.js';
const database = process.env.TEST_NORMALIZED_DATABASE_URL, runtimeUrl = process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL;
(database && runtimeUrl ? describe : describe.skip)('cross-module command authority and receipt recovery', () => {
    let admin: Pool, runtime: Pool, runner: ScopedPostgresTransactionRunner, app: ReturnType<typeof Fastify>, executor: NormalizedCommandExecutor, commands: Pick<NormalizedCommandExecutor, 'execute'>;
    let scope: {
        tenantId: string;
        storeId: string;
    }, actor: string, other: string, customer: string, outsider: string, businessDate: string;
    let beforeExecute: (() => Promise<void>) | undefined, afterAuthorize: (() => Promise<void>) | undefined;
    let guestContexts: Record<string, any>;
    const permissions = ['hardware.manage', 'refund.approve', 'refund.request', 'table.open', 'table.manage', 'service.execute', 'song.manage', 'reconciliation.view', 'reconciliation.manage', 'loyalty.promotion.manage', 'membership.terms.manage', 'ai.execute', 'ai.schedule', 'loyalty.operations.control', 'loyalty.operations.pause', 'loyalty.operations.resume', 'loyalty.operations.view'];
    const revoke = () => admin.query('DELETE FROM mbox.role_permission_assignments WHERE tenant_id=$1', [scope.tenantId]).then(() => { });
    const context = (r?: {
        headers: Record<string, unknown>;
    }) => ({ scope, employeeId: String(r?.headers['x-test-actor'] ?? actor), businessDate });
    const currentContext = async (r?: {
        headers: Record<string, unknown>;
    }) => ({ ...context(r), capabilities: await runner.run(scope, async (tx) => (await new StaffAccessRepository(tx).resolve(context(r).employeeId)).permissions, { readOnly: true }) });
    const counters = ['areas', 'tables', 'devices', 'cash_handover_events', 'table_sessions', 'service_tasks', 'performers', 'membership_terms_versions', 'loyalty_promotion_policy_versions', 'payment_finance_cases', 'ai_execution_requests', 'cash_handovers', 'loyalty_operational_control_events', 'guest_behavior_events', 'service_task_events', 'audit_events', 'outbox_messages', 'idempotency_records'];
    const counts = async () => { const r: Record<string, number> = {}; for (const t of counters)
        r[t] = Number((await admin.query(`SELECT count(*) n FROM mbox.${t} WHERE tenant_id=$1`, [scope.tenantId])).rows[0].n); return r; };
    const failUnused = () => { throw new Error('Unused external/identity port called'); };
    beforeAll(async () => {
        await runNormalizedMigrations(database!);
        admin = new Pool({ connectionString: database });
        runtime = new Pool({ connectionString: runtimeUrl });
        await assertRuntimeDatabasePool(runtime, runtimeUrl!);
        runner = new ScopedPostgresTransactionRunner(runtime);
        executor = new NormalizedCommandExecutor(runner);
        commands = { execute: ((cmd: any, handler: any, authorize?: any) => { const hook = beforeExecute; beforeExecute = undefined; const late = afterAuthorize; afterAuthorize = undefined; return (async () => { await hook?.(); return executor.execute(cmd, handler, late ? async (tx) => { await authorize?.(tx); await late(); } : authorize); })(); }) as NormalizedCommandExecutor['execute'] };
        app = Fastify();
        await app.register(normalizedOperationsApiPlugin, { operationsQuery: new OperationsQueryService(runner), tableSessions: new TableSessionCommandService(commands), commandExecutor: commands, resolveContext: currentContext, createTableSessionRepository: tx => new TableSessionRepository(tx), createServiceTaskRepository: tx => new ServiceTaskRepository(tx) });
        await app.register(paymentFinanceApiPlugin, { transactions: runner, commands, resolveContext: currentContext });
        await app.register(promotionalLoyaltyApiPlugin, { transactions: runner, service: new PromotionalLoyaltyService(runner, commands), resolveStaffContext: context });
        await app.register(customerExperienceApiPlugin, { transactions: runner, service: new CustomerExperienceService(runner, commands), membershipTerms: new MembershipTermsService(runner, commands), resolveStaffContext: context, resolvePublicContext: () => ({ scope }), resolveGuestContext: failUnused, protectContact: failUnused });
        await app.register(reservationPerformanceApiPlugin, { transactions: runner, reservations: new ReservationCommandService(commands), performance: new PerformanceCommandService(commands), resolveStaffContext: context, resolveGuestContext: failUnused });
        const ai = new AiCapabilityCenter(commands, createCoreAiCapabilities({ resolveTable: async (tx, code) => { const row = (await tx.query<{
                id: string;
                code: string;
            }>('SELECT id,code FROM mbox.tables WHERE tenant_id=$1 AND store_id=$2 AND code=$3', [scope.tenantId, scope.storeId, code])).rows[0]; return row ? { kind: 'exact', tableId: row.id, tableCode: row.code } : { kind: 'not_found', candidates: [] }; }, resolveEmployee: failUnused, openTable: async ({ transaction, context: c, tableId, guestCount }) => JSON.parse(JSON.stringify(await new TableManagementRepository(transaction).open({ tableId, publicId: randomUUID(), businessDate: c.businessDate, guestCount, openedByEmployeeId: c.employeeId, guestProfileSnapshot: {} }))), createWaterServiceTask: failUnused }));
        await app.register(aiExecutionApiPlugin, { center: ai, resolveContext: context, prefix: '/ai' });
        registerNativeTableConfiguration(app, { transactions: runner, nativeCommands: commands, resolveContext: currentContext } as never);
        await app.register(guestCommerceServiceApiPlugin, { transactions: runner, commandExecutor: commands, commerce: {} as never, payments: {} as never, onlinePayments: {} as never, resolveGuestContext: r => guestContexts[String(r.headers['x-test-customer'] ?? customer)], resolvePublicContext: () => ({ scope }), resolveDeviceFingerprint: r => 'local:' + String(r.headers['x-test-customer'] ?? customer), paymentMode: 'simulation', paymentActionSecret: 'local-synthetic-audit-secret-only-123456' });
        await app.register(hardwareApiPlugin, { transactions: runner, commands, resolveContext: currentContext });
        await app.register(paymentApiPlugin, { commands: new PaymentCommandService(commands, new NormalizedPaymentCapabilityAuthorization()), transactions: runner, providerVerifier: {} as never, providerObservations: {} as never, reconciliationQuery: {} as never, cashierWorkbenchQuery: {} as never, orderCancellation: {} as never, orderSettlementException: {} as never, resolveActorContext: failUnused, resolveStaffContext: async () => ({ ...await currentContext(), actor: { type: 'employee' as const, employeeId: actor } }), resolveProviderBusinessDate: failUnused });
        await app.ready();
    });
    beforeEach(async () => {
        beforeExecute = undefined;
        afterAuthorize = undefined;
        guestContexts = {};
        scope = { tenantId: randomUUID(), storeId: randomUUID() };
        actor = randomUUID();
        other = randomUUID();
        customer = randomUUID();
        outsider = randomUUID();
        await admin.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1::uuid,$1::text,'Comprehensive local audit')", [scope.tenantId]);
        await admin.query("INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1::uuid,$2,$1::text,'Comprehensive local audit')", [scope.storeId, scope.tenantId]);
        businessDate = await runner.run(scope, async (tx) => (await tx.query('SELECT mbox.current_operating_business_date($1,$2)::text d', [scope.tenantId, scope.storeId])).rows[0].d);
        for (const id of [actor, other])
            await admin.query('INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1::uuid,$2,$3,$1::text,$1::text)', [id, scope.tenantId, scope.storeId]);
        for (const id of [customer, outsider])
            await admin.query('INSERT INTO mbox.customers(id,tenant_id,store_id,public_id) VALUES($1::uuid,$2,$3,$1::text)', [id, scope.tenantId, scope.storeId]);
        const roleId = randomUUID();
        await admin.query("INSERT INTO mbox.roles(id,tenant_id,store_id,code,name) VALUES($1,$2,$3,$4,'Audit role')", [roleId, scope.tenantId, scope.storeId, 'A' + roleId.slice(0, 8).toUpperCase()]);
        for (const code of permissions) {
            const p = (await admin.query('INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name) VALUES($1,$2,$3,$3) ON CONFLICT(tenant_id,store_id,code) DO UPDATE SET name=EXCLUDED.name RETURNING id', [scope.tenantId, scope.storeId, code])).rows[0].id;
            await admin.query('INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [scope.tenantId, scope.storeId, roleId, p]);
        }
        for (const id of [actor, other])
            await admin.query("INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id,starts_at) VALUES($1,$2,$3,$4,clock_timestamp()-interval '1 day')", [scope.tenantId, scope.storeId, id, roleId]);
        await admin.query("INSERT INTO mbox.role_approval_limits(tenant_id,store_id,role_id,approval_code,currency,amount_minor,enabled) VALUES($1,$2,$3,'refund.approve','CNY',10000,true)", [scope.tenantId, scope.storeId, roleId]);
    });
    afterAll(async () => { await app?.close(); await runtime?.end(); await admin?.end(); });
    const send = (url: string, body: object, key = randomUUID(), employee = actor, cust = customer) => app.inject({ method: 'POST', url, headers: { 'idempotency-key': key, 'x-test-actor': employee, 'x-test-customer': cust }, payload: body });
    async function table(open = false) {
        const areaId = randomUUID(), tableId = randomUUID(), sessionId = randomUUID(), code = 'T' + tableId.slice(0, 8);
        await admin.query("INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type) VALUES($1::uuid,$2,$3,substring($1::text,1,8),'Local','indoor')", [areaId, scope.tenantId, scope.storeId]);
        await admin.query('INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) VALUES($1,$2,$3,$4,$5,$5,8)', [tableId, scope.tenantId, scope.storeId, areaId, code]);
        await admin.query("INSERT INTO mbox.table_assignments(tenant_id,store_id,table_id,employee_id,role_id,created_by_employee_id,reason,starts_at) SELECT $1,$2,$3,$4,role_id,$4,'隔离责任分配',clock_timestamp()-interval '1 hour' FROM mbox.employee_roles WHERE tenant_id=$1 AND store_id=$2 AND employee_id=$4 LIMIT 1", [scope.tenantId, scope.storeId, tableId, actor]);
        if (open)
            await admin.query('INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count) VALUES($1::uuid,$2,$3,$4,$1::text,$5,2)', [sessionId, scope.tenantId, scope.storeId, tableId, businessDate]);
        return { tableId, sessionId, code };
    }
    async function fixture(kind: string) {
        if (kind === 'hardware-create')
            return { url: '/hardware/devices', body: { code: 'LOCAL_DEVICE', name: '隔离出品屏', deviceType: 'kds_display', stationCode: 'kitchen', reason: '本地设备配置检查' }, status: 201 };
        if (kind === 'table-open') {
            const t = await table();
            return { url: '/table-sessions', body: { tableId: t.tableId, guestCount: 2, primaryServiceEmployeeId: actor }, status: 201 };
        }
        if (kind === 'service-task') {
            const t = await table(true);
            return { url: '/service-tasks', body: { tableId: t.tableId, tableSessionId: t.sessionId, taskType: 'water', title: '隔离送水任务' }, status: 201 };
        }
        if (kind === 'performer')
            return { url: '/staff/performers', body: { code: 'LOCAL', stageName: '隔离演出测试' }, status: 201 };
        if (kind === 'membership-terms')
            return { url: '/staff/membership-terms/drafts', body: { title: '隔离会员条款', summary: '仅验证本地权限边界', content: '这是一份仅在隔离测试库中创建的会员加入规则文案。', reason: '本地权限审计' }, status: 201 };
        if (kind === 'promotion') {
            const id = randomUUID();
            await admin.query("INSERT INTO mbox.community_activities(id,tenant_id,store_id,public_id,activity_kind,title,summary,assembly_location,starts_at,ends_at,capacity,status,created_by_employee_id) VALUES($1::uuid,$2,$3,$1::text,'member_night','隔离活动','本地活动概况','隔离测试库',clock_timestamp()+interval '2 days',clock_timestamp()+interval '3 days',20,'draft',$4)", [id, scope.tenantId, scope.storeId, actor]);
            return { url: '/staff/loyalty/promotion-policies', body: { campaignCode: 'LOCAL', name: '隔离促销积分', activityId: id, stackingGroup: 'LOCAL', stackingMode: 'exclusive_highest', priority: 100, storeBudgetPoints: 10000, perMemberPointsLimit: 200, pointValidityDays: 180, refundPolicy: 'reverse_on_any_refund', budgetReuseAfterRefund: false, memberLimitReuseAfterRefund: false, eligibleMemberLevels: ['member'], rules: [{ ruleCode: 'CHECKIN', triggerKind: 'activity_check_in', points: 60, perMemberAwardLimit: 1, minimumPaidAmountMinor: 0, enabled: true }], reason: '隔离权限测试' }, status: 201 };
        }
        if (kind === 'finance-review') {
            const t = await table(true), orderId = randomUUID(), paymentId = randomUUID();
            await admin.query("INSERT INTO mbox.orders(id,tenant_id,store_id,table_session_id,public_id,channel,status,subtotal_amount_minor,total_amount_minor) VALUES($1::uuid,$2,$3,$4,$1::text,'staff_assisted','submitted',200,200)", [orderId, scope.tenantId, scope.storeId, t.sessionId]);
            await admin.query("INSERT INTO mbox.payments(id,tenant_id,store_id,order_id,public_id,provider,method,amount_minor,status) VALUES($1::uuid,$2,$3,$4,$1::text,'cash','cash',200,'created')", [paymentId, scope.tenantId, scope.storeId, orderId]);
            return { url: `/payments/${paymentId}/finance-review`, body: { note: '本地隔离核对记录', resolve: false }, status: 200 };
        }
        throw new Error('unknown fixture');
    }
    for (const kind of ['table-open', 'service-task', 'performer', 'membership-terms', 'promotion', 'finance-review', 'hardware-create']) {
        for (const mode of ['fresh', 'receipt'])
            it(`${kind} ${mode}: revoked permission before command entry must be denied`, async () => {
                const f = await fixture(kind), key = randomUUID();
                if (mode === 'receipt') {
                    const first = await send(f.url, f.body, key);
                    expect(first.statusCode, first.body).toBe(f.status);
                    expect((await send(f.url, f.body, key)).statusCode).toBe(200);
                }
                const before = await counts();
                beforeExecute = revoke;
                const result = await send(f.url, f.body, key), after = await counts(), independent = await send(f.url, f.body, key);
                expect(independent.statusCode, independent.body).toBe(403);
                console.info(JSON.stringify({ case: kind, mode, status: result.statusCode, replayed: result.json().meta?.replayed ?? result.json().replayed, independentStatus: independent.statusCode, before, after }));
                expect(result.statusCode, result.body).toBe(403);
                expect(after).toEqual(before);
            });
    }
    it('promotion different employee cannot adopt original draft receipt', async () => { const f = await fixture('promotion'), key = randomUUID(), first = await send(f.url, f.body, key); expect(first.statusCode, first.body).toBe(f.status); const res = await send(f.url, f.body, key, other); console.info(JSON.stringify({ case: 'promotion', mode: 'different-employee', status: res.statusCode, sameData: isDeepStrictEqual(first.json().data, res.json().data) })); expect(res.statusCode, res.body).toBe(409); });
    it('AI core table.open receipt must recheck permission on an ordinary later retry', async () => { const t = await table(), key = randomUUID(), body = { toolName: 'table.open', arguments: { tableCode: t.code, guestCount: 2 } }; const first = await send('/ai/executions', body, key); expect(first.statusCode, first.body).toBe(200); const before = await counts(); await revoke(); const fresh = await send('/ai/executions', body); expect(fresh.statusCode, fresh.body).toBe(403); const res = await send('/ai/executions', body, key); console.info(JSON.stringify({ case: 'ai-execution', mode: 'direct-revoked-retry', status: res.statusCode, freshStatus: fresh.statusCode, replayed: res.json().data?.replayed, sameResult: isDeepStrictEqual(res.json().data?.result, first.json().data?.result), unchanged: isDeepStrictEqual(before, await counts()) })); expect(res.statusCode, res.body).toBe(403); });
    for (const kind of ['cash-handover', 'loyalty-control', 'native-table-configuration'])
        it(`${kind}: receipt authorization must remain current after beforeClaim`, async () => {
            const key = kind === 'native-table-configuration' ? 'native-business-' + randomUUID() : randomUUID();
            const perform = () => kind === 'cash-handover' ? new CashHandoverService(runner, commands).execute({ ...context(), capabilities: [] }, key, { action: 'open', amountMinor: 0, reason: '隔离现金交接检查' }) : kind === 'loyalty-control' ? new LoyaltyOperationalControlService(runner, commands).set(context(), { capability: 'points_accrual', operation: 'pause', expectedVersion: 0, reviewAt: null, reason: '隔离临时暂停检查', idempotencyKey: key }) : send('/table-management/native-configuration/area-create', { code: 'LOCAL', name: '隔离区域', areaType: 'indoor', sortOrder: 0, status: 'active', reason: '本地检查' }, key);
            const first = await perform();
            if (kind === 'native-table-configuration')
                expect((first as any).statusCode, (first as any).body).toBe(200);
            const before = await counts(), held = await holdFixtureReceipts(admin, scope.tenantId);
            const pending = Promise.resolve(perform()).then(value => ({ value }), error => ({ error }));
            try {
                await held.waitUntilBlocked();
                await revoke();
            }
            finally {
                await held.release();
            }
            const { value, error } = await pending as any;
            const denied = error !== undefined || (value?.statusCode === 403);
            console.info(JSON.stringify({ case: kind, mode: 'revoked-during-observed-receipt-lock-wait', denied, status: value?.statusCode, replayed: value?.replayed ?? value?.json?.().meta?.replayed, error: error?.message, unchanged: isDeepStrictEqual(before, await counts()) }));
            expect(denied).toBe(true);
        });
    async function guest(cust: string) { const t = await table(true); await admin.query("INSERT INTO mbox.table_session_customers(tenant_id,store_id,table_session_id,customer_id,relationship) VALUES($1,$2,$3,$4,'primary')", [scope.tenantId, scope.storeId, t.sessionId, cust]); const ref = await seedActiveGuestTableAuthority(admin, { ...scope, tableSessionId: t.sessionId, customerId: cust }); guestContexts[cust] = { scope, sessionKind: 'table', customerId: cust, tableSessionId: t.sessionId, reservationId: null, tableCode: t.code, tableDisplayName: t.code, businessDate, expiresAt: new Date(Date.now() + 3600000).toISOString(), capabilities: ['guest.service.create', 'guest.session.read'], actorRef: ref }; return t; }
    it('guest mood: another customer/table cannot receive false success from original key', async () => { await guest(customer); await guest(outsider); const key = randomUUID(), body = { mood: 'happy' }, first = await send('/guest/mood', body, key); expect(first.statusCode, first.body).toBe(201); const before = await counts(), res = await send('/guest/mood', body, key, actor, outsider); console.info(JSON.stringify({ case: 'guest-mood', mode: 'different-customer-and-table', status: res.statusCode, replayed: res.json().meta?.replayed, sameData: isDeepStrictEqual(first.json().data, res.json().data), unchanged: isDeepStrictEqual(before, await counts()), outsiderRecorded: (await admin.query('SELECT count(*)::int n FROM mbox.guest_behavior_events WHERE customer_id=$1', [outsider])).rows[0].n })); expect(res.statusCode, res.body).toBe(409); });
    it('guest service feedback: other table must not read original receipt', async () => { const t = await guest(customer); await guest(outsider); const taskId = randomUUID(), publicId = randomUUID(); await admin.query("INSERT INTO mbox.service_tasks(id,tenant_id,store_id,table_id,table_session_id,public_id,task_type,title,source,status) VALUES($1,$2,$3,$4,$5,$6,'water','隔离客人反馈','guest','pending')", [taskId, scope.tenantId, scope.storeId, t.tableId, t.sessionId, publicId]); await admin.query("INSERT INTO mbox.guest_service_request_groups(tenant_id,store_id,table_session_id,customer_id,request_type,merge_key,current_service_task_id) VALUES($1,$2,$3,$4,'call_staff',repeat('a',64),$5)", [scope.tenantId, scope.storeId, t.sessionId, customer, taskId]); const url = `/guest/service-requests/${publicId}/feedback`, key = randomUUID(), body = { action: 'escalate' }; const denied = await send(url, body, randomUUID(), actor, outsider); expect(denied.statusCode, denied.body).toBe(404); const first = await send(url, body, key); expect(first.statusCode, first.body).toBe(200); const before = await counts(), res = await send(url, body, key, actor, outsider); console.info(JSON.stringify({ case: 'guest-feedback', mode: 'different-customer-and-table', freshStatus: denied.statusCode, status: res.statusCode, replayed: res.json().meta?.replayed, sameData: isDeepStrictEqual(first.json().data, res.json().data), unchanged: isDeepStrictEqual(before, await counts()) })); expect(res.statusCode, res.body).toBe(404); });
    it('control: staffAuthorizedCommands rejects revocation after initial authorization', async () => { const c = staffAuthorizedCommands(commands, actor, 'table.manage'), cmd = { scope, operationScope: 'local-audit.control', idempotencyKey: randomUUID(), requestFingerprint: 'same', resultCodec: { encode: (v: any) => v, decode: (v: any) => v } }, fn = async () => ({ result: { ok: true }, auditEvents: [], outboxMessages: [] }); expect((await c.execute(cmd, fn)).replayed).toBe(false); expect((await c.execute(cmd, fn)).replayed).toBe(true); const before = await counts(); afterAuthorize = revoke; await expect(c.execute(cmd, fn)).rejects.toThrow(); expect(await counts()).toEqual(before); });
    it('refund rejection receipt must not bypass revoked approval on ordinary retry', async () => {
        const f = await fixture('finance-review'), paymentId = f.url.split('/')[2], refundId = randomUUID();
        await admin.query("INSERT INTO mbox.refunds(id,tenant_id,store_id,payment_id,public_id,amount_minor,currency,status,reason,requested_by_employee_id) VALUES($1::uuid,$2,$3,$4,$1::text,100,'CNY','requested','隔离退款申请',$5)", [refundId, scope.tenantId, scope.storeId, paymentId, other]);
        const key = randomUUID(), url = `/refunds/${refundId}/reject`, body = { reason: '隔离退款复核拒绝' }, first = await send(url, body, key);
        expect(first.statusCode, first.body).toBe(200);
        const before = await counts();
        await revoke();
        const fresh = await send(url, body), res = await send(url, body, key);
        console.info(JSON.stringify({ case: 'refund-reject', mode: 'direct-revoked-retry', freshStatus: fresh.statusCode, status: res.statusCode, replayed: res.json().meta?.replayed ?? res.json().replayed, sameData: isDeepStrictEqual(res.json().data, first.json().data), unchanged: isDeepStrictEqual(before, await counts()) }));
        expect(fresh.statusCode, fresh.body).toBe(403);
        expect(res.statusCode, res.body).toBe(403);
    });
    it('AI relative schedule must recover an unchanged original payload and key', async () => {
        const t = await table(), key = randomUUID(), body = { toolName: 'table.open', arguments: { tableCode: t.code, guestCount: 2 }, delaySeconds: 300 };
        const first = await send('/ai/executions', body, key);
        expect(first.statusCode, first.body).toBe(202);
        const res = await send('/ai/executions', body, key);
        console.info(JSON.stringify({ case: 'ai-relative-schedule', mode: 'same-key-same-payload', firstStatus: first.statusCode, status: res.statusCode, error: res.json().error?.code, requestCount: (await admin.query('SELECT count(*)::int n FROM mbox.ai_execution_requests WHERE tenant_id=$1', [scope.tenantId])).rows[0].n }));
        expect(res.statusCode, res.body).toBe(200);
        expect(res.json().data.runAt).toBe(first.json().data.runAt);
        expect((await send('/ai/executions', { ...body, delaySeconds: 301 }, key)).statusCode).toBe(409);
        expect((await admin.query('SELECT count(*)::int n FROM mbox.ai_execution_requests WHERE tenant_id=$1', [scope.tenantId])).rows[0].n).toBe(1);
    });
});
