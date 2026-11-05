import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import Fastify from 'fastify';
import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest';
import { runNormalizedMigrations } from '../migrate-normalized.js';
import { ScopedPostgresTransactionRunner } from './transaction-runner.js';
import { NormalizedCommandExecutor } from './command-executor.js';
import { assertRuntimeDatabasePool } from './runtime-database-identity.js';
import { MemberContentCardService } from './member-content-card-service.js';
import { memberContentCardApiPlugin } from './member-content-card-api.js';
import { LoyaltyAnnualBenefitService } from './loyalty-annual-benefit-service.js';
import { loyaltyAnnualBenefitApiPlugin } from './loyalty-annual-benefit-api.js';
import { ReservationPerformanceRevisionService } from './reservation-performance-revision-service.js';
import { reservationPerformanceRevisionApiPlugin } from './reservation-performance-revision-api.js';
import { grantFixtureStaffPermissions } from './staff-permission.test-helper.js';
const database = process.env.TEST_NORMALIZED_DATABASE_URL, runtimeUrl = process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL;
(database && runtimeUrl ? describe : describe.skip)('followup command authority and customer receipt recovery', () => {
    let admin: Pool, runtime: Pool, runner: ScopedPostgresTransactionRunner, app: ReturnType<typeof Fastify>;
    let scope: {
        tenantId: string;
        storeId: string;
    }, actor: string, other: string, customer: string, outsider: string;
    let beforeExecute: (() => Promise<void>) | undefined;
    const revoke = () => admin.query('DELETE FROM mbox.role_permission_assignments WHERE tenant_id=$1', [scope.tenantId]).then(() => { });
    const counts = async () => {
        const r: Record<string, number> = {};
        for (const t of ['member_content_cards', 'loyalty_annual_benefit_policy_versions', 'performance_schedule_revisions', 'reservation_performance_impacts', 'reservation_performance_acknowledgements', 'audit_events', 'outbox_messages', 'idempotency_records'])
            r[t] = Number((await admin.query(`SELECT count(*) n FROM mbox.${t} WHERE tenant_id=$1`, [scope.tenantId])).rows[0].n);
        return r;
    };
    beforeAll(async () => {
        await runNormalizedMigrations(database!);
        admin = new Pool({ connectionString: database });
        runtime = new Pool({ connectionString: runtimeUrl });
        await assertRuntimeDatabasePool(runtime, runtimeUrl!);
        runner = new ScopedPostgresTransactionRunner(runtime);
        const executor = new NormalizedCommandExecutor(runner);
        const commands = { execute: ((...args: Parameters<NormalizedCommandExecutor['execute']>) => { const hook = beforeExecute; beforeExecute = undefined; return (async () => { await hook?.(); return executor.execute(...args); })(); }) as NormalizedCommandExecutor['execute'] };
        const context = (r: {
            headers: Record<string, unknown>;
        }) => ({ scope, employeeId: String(r.headers['x-test-actor'] ?? actor), businessDate: '2026-11-05' });
        app = Fastify();
        await app.register(memberContentCardApiPlugin, { transactions: runner, service: new MemberContentCardService(runner, commands), resolveStaffContext: context });
        await app.register(loyaltyAnnualBenefitApiPlugin, { transactions: runner, service: new LoyaltyAnnualBenefitService(runner, commands), resolveStaffContext: context });
        await app.register(reservationPerformanceRevisionApiPlugin, { transactions: runner, service: new ReservationPerformanceRevisionService(runner, commands), resolveStaffContext: context, resolveCustomerContext: r => ({ scope, customerId: String(r.headers['x-test-customer'] ?? customer), actorRef: 'synthetic:' + String(r.headers['x-test-customer'] ?? customer), businessDate: '2026-11-05' }) });
        await app.ready();
    });
    beforeEach(async () => {
        beforeExecute = undefined;
        scope = { tenantId: randomUUID(), storeId: randomUUID() };
        actor = randomUUID();
        other = randomUUID();
        customer = randomUUID();
        outsider = randomUUID();
        await admin.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1::uuid,$1::text,'Followup isolated audit')", [scope.tenantId]);
        await admin.query("INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1::uuid,$2,$1::text,'Followup isolated audit')", [scope.storeId, scope.tenantId]);
        for (const id of [actor, other])
            await admin.query('INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1::uuid,$2,$3,$1::text,$1::text)', [id, scope.tenantId, scope.storeId]);
        for (const id of [customer, outsider])
            await admin.query('INSERT INTO mbox.customers(id,tenant_id,store_id,public_id) VALUES($1::uuid,$2,$3,$1::text)', [id, scope.tenantId, scope.storeId]);
        await grantFixtureStaffPermissions(admin, scope, [actor, other], ['community.activity.manage', 'community.activity.publish', 'loyalty.annual-benefit.manage', 'performance.schedule.revise', 'reservation.view']);
    });
    afterAll(async () => { await app?.close(); await runtime?.end(); await admin?.end(); });
    const send = (url: string, body: object, key = randomUUID(), employee = actor, cust = customer) => app.inject({ method: 'POST', url, headers: { 'idempotency-key': key, 'x-test-actor': employee, 'x-test-customer': cust }, payload: body });
    async function fixture(kind: 'content' | 'annual' | 'revision') {
        if (kind === 'content')
            return { url: '/staff/home-content-cards', body: { code: 'audit-content', type: 'article', title: '本地内容审计', summary: '隔离测试不发布实际内容', imageUrl: null, ctaLabel: '查看', targetPath: '/pages/home/index', priority: 10, displayMode: 'pinned', visibility: 'public', audienceMemberLevels: [], audienceLifecycleStages: [], validFrom: '2026-11-01T00:00:00Z', validUntil: '2027-11-01T00:00:00Z', reason: '隔离权限审计' } };
        if (kind === 'annual') {
            const id = randomUUID();
            await admin.query("INSERT INTO mbox.loyalty_benefit_definitions(id,tenant_id,store_id,public_id,benefit_code,name,benefit_kind,validity_days,cost_amount_minor) VALUES($1::uuid,$2,$3,$1::text,'AUDIT_PRIORITY','本地订座礼遇','reservation_priority',30,0)", [id, scope.tenantId, scope.storeId]);
            return { url: '/staff/loyalty/annual-benefit-policies', body: { policyCode: 'AUDIT_ANNUAL', timezone: 'Asia/Shanghai', reason: '隔离年度礼遇审计', rules: [{ ruleCode: 'AUDIT_PRIORITY', title: '本地优先订座', ruleKind: 'priority_seating', eligibleTier: 'member', inheritToHigherTiers: true, benefitDefinitionId: id, quantity: 1, validityDays: 30, windowBeforeDays: 0, windowAfterDays: 0, onSiteOnly: false, requiresTableSession: false, memberDailyLimit: 1, tableDailyLimit: 1, alcoholHandling: 'not_applicable', stackGroup: 'priority_seating', priority: 100, inventoryRequirement: 'not_applicable', revocationPolicy: 'expire_only', feb29Policy: null, substitutes: [], reservationHoldMinutes: 10, redemptionHoldMinutes: null, enabled: true }] } };
        }
        const scheduleId = await schedule();
        return { url: '/staff/performance-revisions', body: { scheduleId, kind: 'rescheduled', startsAt: '2026-12-10T10:00:00Z', endsAt: '2026-12-10T13:00:00Z', replacementScheduleId: null, reason: '隔离排期调整审计' } };
    }
    async function schedule() {
        const performer = randomUUID(), id = randomUUID();
        await admin.query("INSERT INTO mbox.performers(id,tenant_id,store_id,code,stage_name) VALUES($1,$2,$3,'AUDIT_STAGE','测试演出')", [performer, scope.tenantId, scope.storeId]);
        await admin.query("INSERT INTO mbox.schedules(id,tenant_id,store_id,performer_id,starts_at,ends_at,status) VALUES($1,$2,$3,$4,'2026-12-10T11:00:00Z','2026-12-10T14:00:00Z','scheduled')", [id, scope.tenantId, scope.storeId, performer]);
        return id;
    }
    for (const kind of ['content', 'annual', 'revision'] as const) {
        for (const mode of ['fresh', 'receipt'] as const)
            it(`${kind} ${mode}: reject authority revoked after successful route preflight`, async () => {
                const { url, body } = await fixture(kind), key = randomUUID();
                if (mode === 'receipt') {
                    const first = await send(url, body, key);
                    expect(first.statusCode, first.body).toBe(201);
                    expect((await send(url, body, key)).statusCode).toBe(200);
                }
                const before = await counts();
                beforeExecute = revoke;
                const result = await send(url, body, key), after = await counts(), subsequent = await send(url, body, key);
                expect(subsequent.statusCode, subsequent.body).toBe(403);
                console.info(JSON.stringify({ case: kind, mode, status: result.statusCode, replayed: result.json().meta?.replayed, subsequentStatus: subsequent.statusCode, before, after }));
                // Once revoked before command entry, both mutation and old-result exposure must be denied.
                expect(result.statusCode, result.body).toBe(403);
                expect(after).toEqual(before);
            });
        it(`${kind}: another authorized employee cannot adopt the same request key`, async () => {
            const { url, body } = await fixture(kind), key = randomUUID(), first = await send(url, body, key);
            expect(first.statusCode, first.body).toBe(201);
            const result = await send(url, body, key, other);
            console.info(JSON.stringify({ case: kind, mode: 'different-employee', status: result.statusCode, replayed: result.json().meta?.replayed, sameData: isDeepStrictEqual(result.json().data, first.json().data) }));
            expect(result.statusCode, result.body).toBe(409);
        });
    }
    it('customer impact acknowledgement: outsider must not recover original customer receipt', async () => {
        const { url, body } = await fixture('revision'), reservationId = randomUUID();
        await admin.query('INSERT INTO mbox.public_reservation_policies(tenant_id,store_id) VALUES($1,$2)', [scope.tenantId, scope.storeId]);
        await admin.query("INSERT INTO mbox.reservations(id,tenant_id,store_id,public_id,customer_id,customer_name,contact_token,guest_count,arrival_at,expected_end_at,status,source,preferred_schedule_id) VALUES($1::uuid,$2,$3,$1::text,$4,'隔离顾客','local-contact',2,'2026-12-10T12:30:00Z','2026-12-10T16:30:00Z','confirmed','wechat',$5)", [reservationId, scope.tenantId, scope.storeId, customer, body.scheduleId]);
        const revised = await send(url, body);
        expect(revised.statusCode, revised.body).toBe(201);
        const impact = (await admin.query('SELECT public_id FROM mbox.reservation_performance_impacts WHERE tenant_id=$1', [scope.tenantId])).rows[0].public_id;
        const ackUrl = `/public/reservation/performance-impacts/${impact}/acknowledgements`, payload = { decision: 'keep', selectedScheduleId: null }, key = randomUUID();
        const freshOutsider = await send(ackUrl, payload, randomUUID(), actor, outsider);
        expect(freshOutsider.statusCode, freshOutsider.body).toBe(404);
        const owned = await send(ackUrl, payload, key);
        expect(owned.statusCode, owned.body).toBe(200);
        const before = await counts(), leaked = await send(ackUrl, payload, key, actor, outsider);
        console.info(JSON.stringify({ case: 'customer-acknowledgement', freshOutsiderStatus: freshOutsider.statusCode, replayOutsiderStatus: leaked.statusCode, replayed: leaked.json().meta?.replayed, sameData: isDeepStrictEqual(owned.json().data, leaked.json().data), responseFields: Object.keys(leaked.json().data ?? {}), unchanged: JSON.stringify(await counts()) === JSON.stringify(before) }));
        expect(leaked.json().data).toBeUndefined();
        expect(await counts()).toEqual(before);
        const recovered = await send(ackUrl, payload, key);
        expect(recovered.statusCode, recovered.body).toBe(200);
        expect(recovered.json().data).toEqual(owned.json().data);
        expect(leaked.statusCode, leaked.body).toBe(404);
    });
});
