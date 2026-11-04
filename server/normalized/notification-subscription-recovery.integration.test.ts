import { NotificationRepository } from './notification-repository.js'
import { NotificationWorker } from './notification-worker.js'
import { CustomerNotificationConsentRepository } from './customer-notification-consent-repository.js'
import { CustomerExperienceService } from './customer-experience-service.js'
import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { assertRuntimeDatabasePool } from './runtime-database-identity.js'
import { ScopedPostgresTransactionRunner, type PostgresPool } from './transaction-runner.js'
import { NormalizedCommandExecutor } from './command-executor.js'
import { wechatLoyaltyNotificationApiPlugin } from './wechat-loyalty-notification-api.js'
import { wechatMemberServiceNotificationApiPlugin } from './wechat-member-service-notification-api.js'
import { reservationPerformanceNotificationApiPlugin } from './reservation-performance-notification-api.js'
import { ReservationPerformanceRevisionRepository } from './reservation-performance-revision-repository.js'
import { ReservationPerformanceNotificationWorker } from './reservation-performance-notification-worker.js'

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const runtimeUrl = process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL
const integration = databaseUrl && runtimeUrl ? describe : describe.skip
const domains = ['loyalty', 'member', 'reservation'] as const
type Domain = typeof domains[number]
type Fixture = Awaited<ReturnType<typeof seed>>
const prefix = { loyalty: 'wechat_notification', member: 'wechat_member_service_notification', reservation: 'reservation_performance_notification' }
const paths = { loyalty: '/public/mini/wechat-notification-authorizations', member: '/public/mini/wechat-member-service-notification-authorizations', reservation: '/public/reservation/performance-notification-authorizations' }
function payload(f: Fixture, domain: Domain) {
  return { ...(domain === 'loyalty' ? { notificationType: 'loyalty_points_credited', policyId: f.policy, templateId: 'wechat-template-credit-001' }
    : domain === 'member' ? { notificationType: 'member_benefit_issued', policyId: f.memberPolicy, templateId: 'wechat-template-benefit-001' }
      : { reservationPublicId: 'notification-test-reservation', policyId: f.reservationPolicy, templateId: 'reservation-change-template-001' }),
  policyVersion: 1, expectedVersion: 0, platformResult: 'accept', platformEventReference: 'subscription-regression-grant' }
}

integration('subscription authorization recovery with restricted LOGIN', () => {
  let pool: Pool; let runtime: Pool; let transactions: ScopedPostgresTransactionRunner
  const apps: FastifyInstance[] = []
  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    pool = new Pool({ connectionString: databaseUrl, max: 4 })
    runtime = new Pool({ connectionString: runtimeUrl, max: 4, options: '-c search_path=pg_catalog' })
    await assertRuntimeDatabasePool(runtime, runtimeUrl!)
    transactions = new ScopedPostgresTransactionRunner(runtime as unknown as PostgresPool)
  })
  afterAll(async () => { await Promise.all(apps.map(app => app.close())); await runtime?.end(); await pool?.end() })
  async function application(f: Fixture, channelConfigured: boolean) {
    const app = Fastify(); apps.push(app)
    const context = (request: FastifyRequest) => ({ scope: { tenantId: f.tenant, storeId: f.store },
      customerId: request.headers['x-test-outsider'] ? f.otherCustomer : f.customer,
      actorRef: 'synthetic-customer', businessDate: '2026-11-04' })
    const options = { transactions, commands: new NormalizedCommandExecutor(transactions), channelConfigured }
    await app.register(wechatLoyaltyNotificationApiPlugin, { ...options, resolvePublicContext: context })
    await app.register(wechatMemberServiceNotificationApiPlugin, { ...options, resolvePublicContext: context })
    await app.register(reservationPerformanceNotificationApiPlugin, { ...options, resolveCustomerContext: context })
    return app
  }
  function post(app: FastifyInstance, domain: Domain, body: object, key: string, outsider = false) {
    return app.inject({ method: 'POST', url: paths[domain], headers: { 'idempotency-key': key, ...(outsider ? { 'x-test-outsider': 'yes' } : {}) }, payload: body })
  }
  async function snapshot(f: Fixture) {
    const tables = [...domains.map(d => prefix[d] + '_authorizations'), 'idempotency_records', 'audit_events', 'outbox_messages', 'customer_annual_benefit_consents', 'customer_preferences', 'customer_notification_consents']
    return Promise.all(tables.map(async table => (await pool.query(`SELECT to_jsonb(row) AS data FROM mbox.${table} row WHERE tenant_id=$1 AND store_id=$2 ORDER BY id`, [f.tenant,f.store])).rows))
  }
  for (const domain of domains) {
    it(`${domain}: channel outage permits original receipt recovery and withdrawal, blocks fresh grants without effects`, async () => {
      const f = await seed(pool), on = await application(f, true), off = await application(f, false), body = payload(f, domain)
      const original = await post(on, domain, body, 'original-subscription-grant')
      expect(original.statusCode, original.body).toBe(201)
      const before = await snapshot(f)
      const replay = await post(off, domain, body, 'original-subscription-grant')
      expect(replay.statusCode, replay.body).toBe(200)
      expect(replay.json().data).toEqual(original.json().data)
      expect((await post(off, domain, { ...body, expectedVersion: 1 }, 'new-offline-grant')).statusCode).toBe(503)
      expect(await snapshot(f)).toEqual(before)
      const revoked = { ...body, expectedVersion: 1, platformResult: 'revoke', platformEventReference: 'subscription-revoke-event' }
      expect((await post(off, domain, revoked, 'offline-subscription-withdrawal')).statusCode).toBe(201)
      const withdrawn = await snapshot(f)
      expect((await post(off, domain, revoked, 'offline-subscription-withdrawal')).statusCode).toBe(200)
      expect((await post(off, domain, body, 'original-subscription-grant')).statusCode).toBe(200)
      expect(await snapshot(f)).toEqual(withdrawn)
      expect((await pool.query(`SELECT decision FROM mbox.${prefix[domain]}_authorizations WHERE tenant_id=$1 ORDER BY authorization_version DESC LIMIT 1`, [f.tenant])).rows).toEqual([{ decision: 'revoked' }])
    })
    it.each(['retired', 'expired'] as const)(`${domain}: existing negative decisions remain possible after policy %s with owner/version/template checks`, async state => {
      const f = await seed(pool), app = await application(f, true), body = payload(f, domain)
      expect((await post(app, domain, body, 'policy-grant-original')).statusCode).toBe(201)
      await pool.query(`UPDATE mbox.${prefix[domain]}_policies SET ${state === 'retired' ? "status='retired'" : "effective_until=clock_timestamp()-interval '1 second'"} WHERE id=$1`, [body.policyId])
      const before = await snapshot(f), negative = { ...body, expectedVersion: 1, platformResult: 'revoke', platformEventReference: 'historical-policy-withdrawal' }
      for (const candidate of [{ ...negative, templateId: 'wrong-template-id' }, { ...negative, expectedVersion: 0 }, { ...negative, policyVersion: 2 }, { ...negative, platformResult: 'accept' }]) {
        expect((await post(app, domain, candidate, randomUUID())).statusCode).toBe(domain === 'reservation' && candidate.platformResult === 'accept' ? 404 : 409)
      }
      expect([403,404,409]).toContain((await post(app, domain, negative, randomUUID(), true)).statusCode)
      expect(await snapshot(f)).toEqual(before)
      const result = await post(app, domain, negative, 'historical-policy-withdrawal')
      expect(result.statusCode, result.body).toBe(201)
      expect(result.json().data).toMatchObject({ decision: 'revoked', authorizationVersion: 2 })
    })
    it(`${domain}: binds original receipts to customer and content and maps malformed input`, async () => {
      const f = await seed(pool), app = await application(f, true), body = payload(f, domain)
      expect((await post(app, domain, body, 'bound-subscription-grant')).statusCode).toBe(201)
      const before = await snapshot(f)
      expect((await post(app, domain, { ...body, platformResult: 'reject' }, 'bound-subscription-grant')).statusCode).toBe(409)
      expect((await post(app, domain, body, 'bound-subscription-grant', true)).statusCode).toBe(409)
      expect((await post(app, domain, { ...body, policyVersion: 'invalid' }, 'malformed-subscription-grant')).statusCode).toBe(400)
      expect(await snapshot(f)).toEqual(before)
    })
    it(`${domain}: serializes accept and revoke for one expected version`, async () => {
      const f = await seed(pool), app = await application(f, true), body = payload(f, domain)
      expect((await post(app, domain, body, 'concurrent-initial-grant')).statusCode).toBe(201)
      const results = await Promise.all(['accept','revoke'].map(platformResult => post(app, domain, { ...body, expectedVersion: 1, platformResult, platformEventReference: 'concurrent-' + platformResult }, 'concurrent-' + platformResult)))
      expect(results.map(r => r.statusCode).sort()).toEqual([201,409])
      expect((await pool.query(`SELECT count(*)::int AS n FROM mbox.${prefix[domain]}_authorizations WHERE tenant_id=$1`, [f.tenant])).rows[0].n).toBe(2)
    })
  }
  it.each(['loyalty','member'] as const)('%s permits an existing owner to withdraw after membership suspension, never to grant', async domain => {
    const f = await seed(pool), app = await application(f, true), body = payload(f, domain)
    expect((await post(app, domain, body, 'before-membership-suspension')).statusCode).toBe(201)
    await pool.query("UPDATE mbox.customer_memberships SET status='suspended' WHERE id=$1", [f.membership])
    const result = await post(app, domain, { ...body, expectedVersion: 1, platformResult: 'revoke', platformEventReference: 'suspended-membership-withdrawal' }, 'after-membership-suspension')
    expect(result.statusCode, result.body).toBe(201)
    expect((await post(app, domain, { ...body, expectedVersion: 2 }, 'suspended-fresh-grant')).statusCode).toBe(409)
  })
  it('allows withdrawal of an existing reservation grant after the reservation is cancelled', async () => {
    const f = await seed(pool), app = await application(f, true), body = payload(f, 'reservation')
    expect((await post(app, 'reservation', body, 'reservation-before-cancel')).statusCode).toBe(201)
    await pool.query("UPDATE mbox.reservations SET status='cancelled',preferred_schedule_id=NULL WHERE id=$1", [f.reservation])
    const cancelledResult = await post(app, 'reservation', { ...body, expectedVersion: 1, platformResult: 'revoke', platformEventReference: 'new-withdrawal-platform-event' }, 'reservation-after-cancel')
    expect(cancelledResult.statusCode, cancelledResult.body).toBe(201)
    expect((await post(app, 'reservation', { ...body, expectedVersion: 2 }, 'reservation-regrant-after-cancel')).statusCode).toBe(404)
    await expect(transactions.run({ tenantId: f.tenant, storeId: f.store }, tx => tx.query(`
      INSERT INTO mbox.reservation_performance_notification_authorizations(
        tenant_id,store_id,reservation_id,canonical_customer_id,identity_external_id,policy_id,
        notification_type,authorization_context,policy_version,template_id,decision,platform_result,
        authorization_version,uses_allowed,source,platform_event_reference_hash,authorized_at
      ) SELECT tenant_id,store_id,reservation_id,canonical_customer_id,identity_external_id,policy_id,
        notification_type,authorization_context,policy_version,template_id,'granted','accept',3,1,
        'wechat_client',repeat('e',64),clock_timestamp()
        FROM mbox.reservation_performance_notification_authorizations
        WHERE tenant_id=$1 AND authorization_version=2
    `, [f.tenant]))).rejects.toMatchObject({ code: '23514' })

  })
  it.each(['revoke','retire','expire','identity','crash'] as const)('reservation worker blocks %s after claim and never resends the consumed grant', async change => {
    const f = await seed(pool), app = await application(f, true), body = payload(f, 'reservation')
    expect((await post(app, 'reservation', body, 'reservation-worker-grant')).statusCode).toBe(201)
    const scope = { tenantId: f.tenant, storeId: f.store }
    await transactions.run(scope, tx => new ReservationPerformanceRevisionRepository(tx).revise({
      publicId: 'synthetic-revision', scheduleId: f.schedule, kind: 'cancelled', startsAt: null, endsAt: null,
      replacementScheduleId: null, reason: '测试演出取消通知', employeeId: f.employee, idempotencyKey: 'synthetic-revision-key', requestFingerprint: 'a'.repeat(64),
    }))
    expect((await pool.query('SELECT count(*)::int AS n FROM mbox.reservation_performance_notification_jobs WHERE tenant_id=$1', [f.tenant])).rows[0].n).toBe(1)
    if (change === 'crash') await transactions.run(scope, async tx => {
      await tx.query('INSERT INTO mbox.reservation_performance_notification_authorization_uses(tenant_id,store_id,authorization_id,notification_job_id) SELECT tenant_id,store_id,authorization_id,id FROM mbox.reservation_performance_notification_jobs WHERE tenant_id=$1', [f.tenant])
      await tx.query("UPDATE mbox.reservation_performance_notification_jobs SET status='sending',attempts=1,locked_by='old-worker',locked_at=clock_timestamp()-interval '10 minutes' WHERE tenant_id=$1", [f.tenant])
    })
    const sendTemplate = vi.fn(async () => ({ outcome: 'accepted' as const, providerReference: 'must-not-send' }))
    const worker = new ReservationPerformanceNotificationWorker(transactions, { resolveMiniProgramNotificationRecipient: async () => {
      if (change === 'revoke') expect((await post(app, 'reservation', { ...body, expectedVersion: 1, platformResult: 'revoke', platformEventReference: 'new-withdrawal-platform-event' }, 'reservation-final-withdrawal')).statusCode).toBe(201)
      if (change === 'retire') await pool.query("UPDATE mbox.reservation_performance_notification_policies SET status='retired' WHERE id=$1", [f.reservationPolicy])
      if (change === 'expire') await pool.query("UPDATE mbox.reservation_performance_notification_policies SET effective_until=clock_timestamp()-interval '1 second' WHERE id=$1", [f.reservationPolicy])
      if (change === 'identity') await pool.query('UPDATE mbox.wechat_identities SET revoked_at=clock_timestamp() WHERE tenant_id=$1', [f.tenant])
      return { identityExternalId: `wx-identity-${f.identity}`, openId: 'synthetic-only' }
    } }, { sendTemplate })
    const result = await worker.runBatch(scope, 'reservation-final-check')
    expect(result).toMatchObject(change === 'crash' ? { claimed: 0, unknown: [expect.any(String)] } : { claimed: 1, rejected: [expect.any(String)] })
    expect(sendTemplate).not.toHaveBeenCalled()
    expect((await pool.query('SELECT outcome FROM mbox.reservation_performance_notification_receipts WHERE tenant_id=$1', [f.tenant])).rows).toEqual([{ outcome: change === 'crash' ? 'unknown' : 'provider_rejected' }])
    expect(await worker.runBatch(scope, 'reservation-final-retry')).toMatchObject({ claimed: 0 })
    expect(sendTemplate).not.toHaveBeenCalled()
  })
  it.each(['wechat','sms','customer-in-app','employee-in-app','employee-wecom'] as const)('generic %s queue rechecks recipient eligibility and stops retries after revocation', async kind => {
    const f = await seed(pool), scope = { tenantId: f.tenant, storeId: f.store }
    const channel = kind === 'wechat' || kind === 'sms' ? kind : kind === 'employee-wecom' ? 'wecom' : 'in_app'
    const recipient = kind.startsWith('employee-') ? { type: 'employee' as const, id: f.employee } : { type: 'customer' as const, id: f.customer }
    const consent = { customerId: f.customer, channel: channel === 'sms' ? 'sms' as const : 'wechat' as const,
      purpose: 'transactional_service' as const, expectedVersion: 0, policyVersion: 'v1', source: 'customer_self_service' as const, actorType: 'customer' as const }
    if (channel === 'wechat' || channel === 'sms') await transactions.run(scope, tx => new CustomerNotificationConsentRepository(tx).record({ ...consent, decision: 'granted' }))
    if (channel === 'wecom') {
      await pool.query("INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name) VALUES($1,$2,'notifications.receive.wecom','接收通知')", [f.tenant,f.store])
      await pool.query("INSERT INTO mbox.employee_permission_overrides(tenant_id,store_id,employee_id,permission_id,effect,reason,configured_by_employee_id) SELECT tenant_id,store_id,$3,id,'grant','合成权限',$4 FROM mbox.staff_permission_definitions WHERE tenant_id=$1 AND store_id=$2 AND code='notifications.receive.wecom'", [f.tenant,f.store,f.employee,f.approver])
    }
    const allowed = await transactions.run(scope, tx => new NotificationRepository(tx).create({ businessKey: 'generic-notification-allowed', channel, recipient, templateCode: 'service.ready', payload: { status: 'ready' } }))
    const positiveDelivery = vi.fn(async () => undefined)
    expect(await new NotificationWorker(transactions).runBatch(scope, 'generic-positive-control', positiveDelivery)).toMatchObject({ delivered: [allowed.id] })
    expect(positiveDelivery).toHaveBeenCalledOnce()
    const job = await transactions.run(scope, tx => new NotificationRepository(tx).create({ businessKey: 'generic-notification-revocation', channel, recipient, templateCode: 'service.ready', payload: { status: 'ready' } }))
    if (channel === 'wechat' || channel === 'sms') await transactions.run(scope, tx => new CustomerNotificationConsentRepository(tx).record({ ...consent, expectedVersion: 1, decision: 'revoked' }))
    else if (channel === 'wecom') await pool.query("UPDATE mbox.employee_permission_overrides SET effect='deny' WHERE tenant_id=$1 AND employee_id=$2", [f.tenant,f.employee])
    else if (kind === 'employee-in-app') await pool.query("UPDATE mbox.employees SET status='suspended' WHERE id=$1", [f.employee])
    else await pool.query("UPDATE mbox.customers SET status='blocked' WHERE id=$1", [f.customer])
    const deliver = vi.fn(async () => undefined), worker = new NotificationWorker(transactions)
    expect(await worker.runBatch(scope, 'generic-final-check', deliver)).toMatchObject({ claimed: 1, delivered: [], dead: [job.id] })
    expect(deliver).not.toHaveBeenCalled()
    expect((await pool.query('SELECT status,last_error FROM mbox.notifications WHERE id=$1', [job.id])).rows).toEqual([{ status: 'dead', last_error: 'recipient_no_longer_eligible' }])
    expect(await worker.runBatch(scope, 'generic-final-check-retry', deliver)).toMatchObject({ claimed: 0 })
    expect(deliver).not.toHaveBeenCalled()
  })
  it('birthday grant and withdrawal receipts cannot be read by another customer and never restore withdrawn consent', async () => {
    const f = await seed(pool), scope = { tenantId: f.tenant, storeId: f.store }
    const service = new CustomerExperienceService(transactions, new NormalizedCommandExecutor(transactions), {} as never)
    const context = { scope, customerId: f.customer, actorRef: 'synthetic-owner', businessDate: '2026-11-04' }
    const outsider = { ...context, customerId: f.otherCustomer }
    const grant = { birthdayMonthDay: '02-10', idempotencyKey: 'birthday-original-grant' }
    const withdraw = { reason: '本人撤回授权', idempotencyKey: 'birthday-original-withdrawal' }
    const original = await service.recordBirthdayBenefitConsent(context, grant)
    const granted = await snapshot(f)
    await expect(service.recordBirthdayBenefitConsent(outsider, grant)).rejects.toMatchObject({ name: 'IdempotencyConflictError' })
    expect(await snapshot(f)).toEqual(granted)
    await service.withdrawBirthdayBenefitConsent(context, withdraw)
    const withdrawn = await snapshot(f)
    await expect(service.withdrawBirthdayBenefitConsent(outsider, withdraw)).rejects.toMatchObject({ name: 'IdempotencyConflictError' })
    expect(await service.recordBirthdayBenefitConsent(context, grant)).toEqual({ ...original, replayed: true })
    expect((await service.withdrawBirthdayBenefitConsent(context, withdraw)).replayed).toBe(true)
    expect(await snapshot(f)).toEqual(withdrawn)
    expect((await pool.query("SELECT status FROM mbox.customer_annual_benefit_consents WHERE tenant_id=$1", [f.tenant])).rows).toEqual([{ status: 'withdrawn' }])
    expect((await pool.query("SELECT bool_and(expires_at='infinity'::timestamptz) AS retained FROM mbox.idempotency_records WHERE tenant_id=$1", [f.tenant])).rows[0].retained).toBe(true)
  })
  it('legacy notification consent withdrawal and original receipt recovery survive missing or changed configuration', async () => {
    const f = await seed(pool), scope = { tenantId: f.tenant, storeId: f.store }
    const service = new CustomerExperienceService(transactions, new NormalizedCommandExecutor(transactions), {} as never)
    const context = { scope, customerId: f.customer, actorRef: 'synthetic-owner', businessDate: '2026-11-04' }
    const policy = { serviceTemplateId: 'legacy-service-template', policyVersion: 'v1' }
    const grant = { expectedVersion: 0, authorizationContext: 'service' as const, platformResult: 'accept' as const, platformEventReference: 'legacy-grant-platform-event', idempotencyKey: 'legacy-original-grant' }
    const original = await service.recordNotificationConsent(context, policy, grant)
    const granted = await snapshot(f)
    expect((await service.recordNotificationConsent(context, null, grant)).value).toEqual(original.value)
    expect((await service.recordNotificationConsent(context, { ...policy, serviceTemplateId: 'changed-template' }, grant)).replayed).toBe(true)
    await expect(service.recordNotificationConsent(context, null, { ...grant, expectedVersion: 1, idempotencyKey: 'legacy-fresh-grant' })).rejects.toMatchObject({ code: 'WECHAT_NOTIFICATION_TEMPLATE_NOT_CONFIGURED' })
    await expect(service.recordNotificationConsent({ ...context, customerId: f.otherCustomer }, policy, grant)).rejects.toMatchObject({ name: 'IdempotencyConflictError' })
    expect(await snapshot(f)).toEqual(granted)
    const withdraw = { ...grant, expectedVersion: 1, platformResult: 'revoke' as const, idempotencyKey: 'legacy-original-withdrawal' }
    expect((await service.recordNotificationConsent(context, null, withdraw)).value).toMatchObject({ decision: 'revoked', consentVersion: 2 })
    const withdrawn = await snapshot(f)
    expect((await service.recordNotificationConsent(context, null, withdraw)).replayed).toBe(true)
    expect((await service.recordNotificationConsent(context, null, grant)).replayed).toBe(true)
    expect(await snapshot(f)).toEqual(withdrawn)
    expect((await pool.query('SELECT decision,policy_version,template_id FROM mbox.customer_notification_consents WHERE tenant_id=$1 ORDER BY consent_version DESC LIMIT 1', [f.tenant])).rows).toEqual([{ decision: 'revoked', policy_version: 'v1', template_id: policy.serviceTemplateId }])
  })

})
async function seed(pool: Pool) {
  const ids = { tenant: randomUUID(), store: randomUUID(), customer: randomUUID(), otherCustomer: randomUUID(),
    employee: randomUUID(), approver: randomUUID(), membership: randomUUID(), otherMembership: randomUUID(),
    identity: randomUUID(), otherIdentity: randomUUID(), policy: randomUUID(), memberPolicy: randomUUID(),
    reservationPolicy: randomUUID(), performer: randomUUID(), schedule: randomUUID(), reservation: randomUUID() }
  const principal = `principal-${ids.identity}`
  const otherPrincipal = `principal-${ids.otherIdentity}`
  await pool.query(`INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'Wechat notice tenant')`, [
    ids.tenant, `wn-${ids.tenant.slice(0,8)}`,
  ])
  await pool.query(`
    INSERT INTO mbox.stores(id,tenant_id,code,name,timezone)
    VALUES($1,$2,$3,'Wechat notice store','Asia/Shanghai')
  `, [ids.store, ids.tenant, `wn-${ids.store.slice(0,8)}`])
  await pool.query(`
    INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name)
    VALUES($1,$3,$4,'WN_OWNER','通知测试员工'),
      ($2,$3,$4,'WN_APPROVER','通知测试复核人')
  `, [ids.employee, ids.approver, ids.tenant, ids.store])
  await pool.query(`
    INSERT INTO mbox.customers(id,tenant_id,store_id,public_id) VALUES
      ($1,$3,$4,'wechat-notice-customer'),($2,$3,$4,'wechat-notice-other')
  `, [ids.customer, ids.otherCustomer, ids.tenant, ids.store])
  await pool.query(`
    INSERT INTO mbox.customer_memberships(id,tenant_id,store_id,customer_id,member_no) VALUES
      ($1,$3,$4,$5,'MBX-WECHAT-NOTICE-001'),($2,$3,$4,$6,'MBX-WECHAT-NOTICE-002')
  `, [ids.membership, ids.otherMembership, ids.tenant, ids.store, ids.customer, ids.otherCustomer])
  await pool.query(`
    INSERT INTO mbox.customer_identities(tenant_id,store_id,customer_id,identity_kind,identity_hash) VALUES
      ($1,$2,$3,'wechat',encode(digest('wechat:'||$5,'sha256'),'hex')),
      ($1,$2,$4,'wechat',encode(digest('wechat:'||$6,'sha256'),'hex'))
  `, [ids.tenant, ids.store, ids.customer, ids.otherCustomer, principal, otherPrincipal])
  await pool.query(`
    INSERT INTO mbox.wechat_identities(
      tenant_id,store_id,external_identity_id,principal_type,principal_id,channel,app_id,
      openid_sha256,openid_ciphertext,openid_key_version,member_id,consent_version,
      consented_at,last_authenticated_at
    ) VALUES
      ($1,$2,$3,'member',$4,'mini_program','wxMboxNotification01',encode(digest('openid-a','sha256'),'hex'),
        decode(repeat('00',29),'hex'),1,$5,'login-v1',clock_timestamp(),clock_timestamp()),
      ($1,$2,$6,'member',$7,'mini_program','wxMboxNotification01',encode(digest('openid-b','sha256'),'hex'),
        decode(repeat('11',29),'hex'),1,$8,'login-v1',clock_timestamp(),clock_timestamp())
  `, [
    ids.tenant, ids.store, `wx-identity-${ids.identity}`, principal, ids.membership,
    `wx-identity-${ids.otherIdentity}`, otherPrincipal, ids.otherMembership,
  ])
  await pool.query(`
    INSERT INTO mbox.wechat_notification_policies(
      id,tenant_id,store_id,notification_type,authorization_purpose,authorization_context,
      policy_version,status,template_id,page_path,points_data_key,balance_data_key,
      occurred_at_data_key,reason,effective_from,published_at
    ) VALUES($1,$2,$3,'loyalty_points_credited','loyalty_balance_change','loyalty_accrual',
      1,'published','wechat-template-credit-001','pages/profile/index','thing1','number2',
      'time3','积分到账模板正式发布',clock_timestamp()-interval '1 hour',clock_timestamp())
  `, [ids.policy, ids.tenant, ids.store])
  await pool.query(`INSERT INTO mbox.wechat_member_service_notification_policies(
    id,tenant_id,store_id,notification_type,authorization_purpose,authorization_context,policy_version,status,
    template_id,page_path,title_data_key,detail_data_key,occurred_at_data_key,reason,effective_from,published_at
  ) VALUES($1,$2,$3,'member_benefit_issued','member_service_update','member_benefit',1,'published',
    'wechat-template-benefit-001','pages/profile-coupons/index','thing1','thing2','time3','服务通知测试',clock_timestamp()-interval '1 hour',clock_timestamp())`,[ids.memberPolicy,ids.tenant,ids.store])
  await pool.query("INSERT INTO mbox.performers(id,tenant_id,store_id,code,stage_name) VALUES($1,$2,$3,'TEST','测试歌手')", [ids.performer,ids.tenant,ids.store])
  await pool.query("INSERT INTO mbox.schedules(id,tenant_id,store_id,performer_id,starts_at,ends_at,status) VALUES($1,$2,$3,$4,'2027-01-01T11:00:00Z','2027-01-01T14:00:00Z','scheduled')", [ids.schedule,ids.tenant,ids.store,ids.performer])
  await pool.query("INSERT INTO mbox.public_reservation_policies(tenant_id,store_id) VALUES($1,$2)", [ids.tenant,ids.store])
  await pool.query(`INSERT INTO mbox.reservations(id,tenant_id,store_id,public_id,customer_id,customer_name,contact_token,guest_count,arrival_at,expected_end_at,status,source,preferred_schedule_id)
    VALUES($1,$2,$3,'notification-test-reservation',$4,'测试顾客','synthetic',2,'2027-01-01T12:30:00Z','2027-01-01T16:30:00Z','confirmed','wechat',$5)`,[ids.reservation,ids.tenant,ids.store,ids.customer,ids.schedule])
  await pool.query(`INSERT INTO mbox.reservation_performance_notification_policies(id,tenant_id,store_id,notification_type,authorization_context,policy_version,status,template_id,page_path,change_type_data_key,performance_time_data_key,reservation_time_data_key,effective_from,reason,published_at)
    VALUES($1,$2,$3,'reservation_performance_revised','reservation',1,'published','reservation-change-template-001','pages/reservations/index','change_type','performance_time','reservation_time',clock_timestamp()-interval '1 hour','预约通知测试',clock_timestamp())`,[ids.reservationPolicy,ids.tenant,ids.store])
  return ids
}
