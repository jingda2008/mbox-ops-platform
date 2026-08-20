import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Pool } from 'pg'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { ScopedPostgresTransactionRunner, type PostgresPool } from './transaction-runner.js'
import {
  WechatLoyaltyNotificationRepository,
  WechatNotificationAuthorizationError,
} from './wechat-loyalty-notification-repository.js'
import { WechatLoyaltyNotificationWorker } from './wechat-loyalty-notification-worker.js'

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip
const ids = Object.freeze({
  tenant: randomUUID(), store: randomUUID(), customer: randomUUID(), otherCustomer: randomUUID(),
  membership: randomUUID(), otherMembership: randomUUID(), identity: randomUUID(), otherIdentity: randomUUID(),
  policy: randomUUID(), refundPolicy: randomUUID(), expiryPolicy: randomUUID(),
  employee: randomUUID(), approver: randomUUID(), loyaltyPolicy: randomUUID(), area: randomUUID(),
  table: randomUUID(), session: randomUUID(), source: randomUUID(), secondSource: randomUUID(),
  thirdSource: randomUUID(), order: randomUUID(), secondOrder: randomUUID(), thirdOrder: randomUUID(),
  payment: randomUUID(), secondPayment: randomUUID(), thirdPayment: randomUUID(),
  refund: randomUUID(), refundApplication: randomUUID(), expiringLot: randomUUID(),
})
const scope = { tenantId: ids.tenant, storeId: ids.store }

integration('typed WeChat loyalty notification authorization and delivery', () => {
  let pool: Pool
  let transactions: ScopedPostgresTransactionRunner

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    pool = new Pool({ connectionString: databaseUrl, max: 4 })
    transactions = new ScopedPostgresTransactionRunner(pool as unknown as PostgresPool)
    await seed(pool)
  })

  afterAll(async () => pool?.end())

  it('requires the exact current purpose, type, context, template and customer-owned identity', async () => {
    const options = await transactions.run(scope, (transaction) => (
      new WechatLoyaltyNotificationRepository(transaction).authorizationOptions(ids.customer, true)
    ), { readOnly: true })
    expect(options).toEqual([expect.objectContaining({
      policyId: ids.policy,
      notificationType: 'loyalty_points_credited',
      purpose: 'loyalty_balance_change',
      authorizationContext: 'loyalty_accrual',
      decision: null,
    })])

    await expect(transactions.run(scope, (transaction) => (
      new WechatLoyaltyNotificationRepository(transaction).recordAuthorization({
        customerId: ids.customer,
        notificationType: 'loyalty_points_credited',
        policyId: ids.policy,
        policyVersion: 1,
        templateId: 'wrong-template-id',
        expectedVersion: 0,
        platformResult: 'accept',
        platformEventReference: 'wx-event-wrong-template-001',
      })
    ))).rejects.toMatchObject<Partial<WechatNotificationAuthorizationError>>({
      code: 'WECHAT_NOTIFICATION_POLICY_STALE',
    })

    const granted = await transactions.run(scope, (transaction) => (
      new WechatLoyaltyNotificationRepository(transaction).recordAuthorization({
        customerId: ids.customer,
        notificationType: 'loyalty_points_credited',
        policyId: ids.policy,
        policyVersion: 1,
        templateId: 'wechat-template-credit-001',
        expectedVersion: 0,
        platformResult: 'accept',
        platformEventReference: 'wx-event-credit-accepted-001',
      })
    ))
    expect(granted).toMatchObject({ decision: 'granted', authorizationVersion: 1 })

    await expect(pool.query(`
      INSERT INTO mbox.wechat_notification_authorizations(
        tenant_id,store_id,customer_id,membership_id,identity_external_id,
        policy_id,notification_type,authorization_purpose,authorization_context,
        policy_version,template_id,decision,platform_result,authorization_version,
        uses_allowed,source,platform_event_reference_hash,authorized_at
      ) VALUES($1,$2,$3,$4,$5,$6,'loyalty_points_credited','loyalty_balance_change',
        'loyalty_accrual',1,'wechat-template-credit-001','granted','accept',1,1,
        'wechat_client',$7,clock_timestamp())
    `, [
      ids.tenant, ids.store, ids.otherCustomer, ids.otherMembership,
      `wx-identity-${ids.identity}`, ids.policy, createHash('sha256').update('cross-customer').digest('hex'),
    ])).rejects.toThrow(/does not belong to customer/)
  })

  it('consumes a one-use grant once, writes a typed receipt and suppresses reuse', async () => {
    const authorization = await pool.query<{ id: string }>(`
      SELECT id FROM mbox.wechat_notification_authorizations
      WHERE tenant_id=$1 AND store_id=$2 AND customer_id=$3 AND decision='granted'
    `, [ids.tenant, ids.store, ids.customer])
    const authorizationId = authorization.rows[0]!.id
    await expect(insertJob(pool, authorizationId, randomUUID()))
      .rejects.toThrow(/no matching loyalty award/)
    const creditFact = await pool.query<{ occurred_at: string }>(`
      SELECT awarded_at::text AS occurred_at FROM mbox.loyalty_order_awards WHERE id=$1
    `, [ids.source])
    const enqueued = await transactions.run(scope, (transaction) => (
      new WechatLoyaltyNotificationRepository(transaction).enqueuePointsCredited({
        awardId: ids.source,
        pointsChange: 10,
        balanceAfter: 110,
        occurredAt: creditFact.rows[0]!.occurred_at,
      })
    ))
    expect(enqueued).toBe(true)
    const send = vi.fn(async () => ({ outcome: 'accepted' as const, providerReference: 'provider-accepted-001' }))
    const worker = new WechatLoyaltyNotificationWorker(
      transactions,
      { resolveMiniProgramNotificationRecipient: async () => ({
        identityExternalId: `wx-identity-${ids.identity}`, openId: 'openid-self',
      }) },
      { preflight: async () => undefined, send },
    )
    const first = await worker.runBatch(scope, 'wechat-notification-pg-01')
    expect(first).toMatchObject({ claimed: 1, accepted: [expect.any(String)] })
    expect(send).toHaveBeenCalledOnce()
    const receipt = await pool.query(`
      SELECT receipt.outcome,receipt.provider_error_code,job.status,job.failure_code
      FROM mbox.wechat_notification_receipts receipt
      JOIN mbox.wechat_customer_notification_jobs job ON job.id=receipt.notification_job_id
      WHERE receipt.tenant_id=$1 AND receipt.store_id=$2
    `, [ids.tenant, ids.store])
    expect(receipt.rows[0]).toMatchObject({
      outcome: 'accepted', provider_error_code: null, status: 'sent', failure_code: null,
    })

    await insertJob(pool, authorizationId, ids.secondSource)
    const second = await worker.runBatch(scope, 'wechat-notification-pg-02')
    expect(second.claimed).toBe(0)
    const suppressed = await pool.query<{ status: string; failure_code: string }>(`
      SELECT status,failure_code FROM mbox.wechat_customer_notification_jobs
      WHERE tenant_id=$1 AND store_id=$2 AND source_id=$3
    `, [ids.tenant, ids.store, ids.secondSource])
    expect(suppressed.rows[0]).toEqual({
      status: 'suppressed', failure_code: 'authorization_already_used',
    })

    await transactions.run(scope, (transaction) => (
      new WechatLoyaltyNotificationRepository(transaction).recordAuthorization({
        customerId: ids.customer,
        notificationType: 'loyalty_points_credited',
        policyId: ids.policy,
        policyVersion: 1,
        templateId: 'wechat-template-credit-001',
        expectedVersion: 1,
        platformResult: 'accept',
        platformEventReference: 'wx-event-credit-accepted-002',
      })
    ))
    const thirdFact = await pool.query<{ occurred_at: string }>(`
      SELECT awarded_at::text AS occurred_at FROM mbox.loyalty_order_awards WHERE id=$1
    `, [ids.thirdSource])
    expect(await transactions.run(scope, (transaction) => (
      new WechatLoyaltyNotificationRepository(transaction).enqueuePointsCredited({
        awardId: ids.thirdSource,
        pointsChange: 10,
        balanceAfter: 120,
        occurredAt: thirdFact.rows[0]!.occurred_at,
      })
    ))).toBe(true)
    const rateLimited = await worker.runBatch(scope, 'wechat-notification-pg-03')
    expect(rateLimited.claimed).toBe(0)
    expect(send).toHaveBeenCalledOnce()
    const deferred = await pool.query<{ deferred: boolean }>(`
      SELECT scheduled_for>clock_timestamp() AS deferred
      FROM mbox.wechat_customer_notification_jobs
      WHERE tenant_id=$1 AND store_id=$2 AND source_id=$3
    `, [ids.tenant, ids.store, ids.thirdSource])
    expect(deferred.rows[0]?.deferred).toBe(true)
  })

  it('creates reversal and expiry jobs only from their exact normalized facts', async () => {
    await pool.query(`
      INSERT INTO mbox.refunds(
        id,tenant_id,store_id,payment_id,public_id,provider_refund_id,amount_minor,
        currency,status,reason,requested_by_employee_id,approved_by_employee_id,
        decision_reason,completed_at
      ) VALUES($1,$2,$3,$4,'wechat-notice-refund-001','wechat-notice-provider-refund-001',
        400,'CNY','succeeded','通知退款来源测试',$5,$6,'独立复核通过','2026-08-16T04:00:00Z')
    `, [ids.refund, ids.tenant, ids.store, ids.secondPayment, ids.employee, ids.approver])
    await pool.query(`
      INSERT INTO mbox.loyalty_award_refund_applications(
        id,tenant_id,store_id,award_id,refund_id,order_id,payment_id,
        eligible_refund_amount_minor,reversed_points,reversed_growth,applied_at
      ) VALUES($1,$2,$3,$4,$5,$6,$7,400,4,4,clock_timestamp()-interval '1 minute')
    `, [
      ids.refundApplication, ids.tenant, ids.store, ids.secondSource,
      ids.refund, ids.secondOrder, ids.secondPayment,
    ])
    await pool.query(`
      INSERT INTO mbox.loyalty_point_lots(
        id,tenant_id,store_id,membership_id,customer_id,source_type,source_id,
        original_points,remaining_points,available_at,expires_at,status
      ) VALUES($1,$2,$3,$4,$5,'adjust','wechat-expiry-test',8,8,
        clock_timestamp()-interval '1 day',clock_timestamp()+interval '2 days','available')
    `, [ids.expiringLot, ids.tenant, ids.store, ids.membership, ids.customer])
    await pool.query(`
      INSERT INTO mbox.wechat_notification_policies(
        id,tenant_id,store_id,notification_type,authorization_purpose,authorization_context,
        policy_version,status,template_id,page_path,points_data_key,balance_data_key,
        occurred_at_data_key,expires_at_data_key,expiry_lead_days,reason,effective_from,published_at
      ) VALUES
        ($1,$3,$4,'loyalty_points_reversed','loyalty_balance_change','loyalty_refund',
          1,'published','wechat-template-refund-001','pages/profile/index','thing1','number2',
          'time3',NULL,NULL,'退款积分冲回模板正式发布',clock_timestamp()-interval '1 hour',clock_timestamp()),
        ($2,$3,$4,'loyalty_points_expiring','loyalty_expiry_reminder','loyalty_expiry',
          1,'published','wechat-template-expiry-001','pages/profile/index','thing1',NULL,
          'time3','time4',7,'积分即将到期模板正式发布',clock_timestamp()-interval '1 hour',clock_timestamp())
    `, [ids.refundPolicy, ids.expiryPolicy, ids.tenant, ids.store])
    for (const input of [
      {
        notificationType: 'loyalty_points_reversed' as const,
        policyId: ids.refundPolicy,
        templateId: 'wechat-template-refund-001',
        platformEventReference: 'wx-event-refund-accepted-001',
      },
      {
        notificationType: 'loyalty_points_expiring' as const,
        policyId: ids.expiryPolicy,
        templateId: 'wechat-template-expiry-001',
        platformEventReference: 'wx-event-expiry-accepted-001',
      },
    ]) {
      await transactions.run(scope, (transaction) => (
        new WechatLoyaltyNotificationRepository(transaction).recordAuthorization({
          customerId: ids.customer,
          policyVersion: 1,
          expectedVersion: 0,
          platformResult: 'accept',
          ...input,
        })
      ))
    }
    const refundFact = await pool.query<{ occurred_at: string }>(`
      SELECT applied_at::text AS occurred_at
      FROM mbox.loyalty_award_refund_applications WHERE id=$1
    `, [ids.refundApplication])
    const reversalCreated = await transactions.run(scope, (transaction) => (
      new WechatLoyaltyNotificationRepository(transaction).enqueuePointsReversed({
        refundApplicationId: ids.refundApplication,
        pointsChange: -4,
        balanceAfter: 106,
        occurredAt: refundFact.rows[0]!.occurred_at,
      })
    ))
    const expiryCreated = await transactions.run(scope, (transaction) => (
      new WechatLoyaltyNotificationRepository(transaction).enqueueExpiringLots(10)
    ))
    expect(reversalCreated).toBe(true)
    expect(expiryCreated).toBe(1)
    const jobs = await pool.query<{ notification_type: string; source_id: string }>(`
      SELECT notification_type,source_id::text
      FROM mbox.wechat_customer_notification_jobs
      WHERE tenant_id=$1 AND store_id=$2
        AND notification_type IN ('loyalty_points_reversed','loyalty_points_expiring')
      ORDER BY notification_type
    `, [ids.tenant, ids.store])
    expect(jobs.rows).toEqual([
      { notification_type: 'loyalty_points_expiring', source_id: ids.expiringLot },
      { notification_type: 'loyalty_points_reversed', source_id: ids.refundApplication },
    ])
  })

  it('moves an overnight quiet-hours event to the local end of the quiet period', async () => {
    const scheduled = await pool.query<{ scheduled: string }>(`
      SELECT mbox.wechat_notification_scheduled_at(
        '2026-08-16T16:30:00Z'::timestamptz,'22:00'::time,'08:00'::time,'Asia/Shanghai'
      )::text AS scheduled
    `)
    expect(new Date(scheduled.rows[0]!.scheduled).toISOString()).toBe('2026-08-17T00:00:00.000Z')
  })
})

async function insertJob(
  pool: Pool,
  authorizationId: string,
  sourceId: string,
  eventOccurredAt?: string,
): Promise<void> {
  const source = await pool.query<{ occurred_at: string }>(`
    SELECT awarded_at::text AS occurred_at FROM mbox.loyalty_order_awards WHERE id=$1
  `, [sourceId])
  const occurredAt = eventOccurredAt ?? source.rows[0]?.occurred_at ?? new Date(Date.now()-60_000).toISOString()
  await pool.query(`
    INSERT INTO mbox.wechat_customer_notification_jobs(
      tenant_id,store_id,customer_id,membership_id,identity_external_id,
      authorization_id,policy_id,notification_type,authorization_purpose,
      authorization_context,policy_version,template_id,source_type,source_id,
      points_change,points_at_risk,balance_after,expires_at,event_occurred_at,scheduled_for
    ) VALUES($1,$2,$3,$4,$5,$6,$7,'loyalty_points_credited','loyalty_balance_change',
      'loyalty_accrual',1,'wechat-template-credit-001','loyalty_order_award',$8,
      10,0,110,NULL,$9::timestamptz,clock_timestamp())
  `, [
    ids.tenant, ids.store, ids.customer, ids.membership, `wx-identity-${ids.identity}`,
    authorizationId, ids.policy, sourceId, occurredAt,
  ])
}

async function seed(pool: Pool): Promise<void> {
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
    INSERT INTO mbox.loyalty_accounts(tenant_id,store_id,membership_id,customer_id,available_points)
    VALUES($1,$2,$3,$4,100),($1,$2,$5,$6,0)
  `, [ids.tenant, ids.store, ids.membership, ids.customer, ids.otherMembership, ids.otherCustomer])
  await pool.query(`
    INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type)
    VALUES($1,$2,$3,'WECHAT_NOTICE_AREA','通知测试区域','bar')
  `, [ids.area, ids.tenant, ids.store])
  await pool.query(`
    INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity,status)
    VALUES($1,$2,$3,$4,'WECHAT_NOTICE_TABLE','通知测试桌',4,'available')
  `, [ids.table, ids.tenant, ids.store, ids.area])
  await pool.query(`
    INSERT INTO mbox.table_sessions(
      id,tenant_id,store_id,table_id,public_id,business_date,guest_count,status
    ) VALUES($1,$2,$3,$4,'wechat-notice-session','2026-08-16',2,'open')
  `, [ids.session, ids.tenant, ids.store, ids.table])
  await pool.query(`
    INSERT INTO mbox.loyalty_policy_versions(
      id,tenant_id,store_id,policy_code,version,status,points_numerator,
      points_denominator_minor,growth_numerator,growth_denominator_minor,
      rounding_mode,points_validity_months,drafted_by_employee_id,reason
    ) VALUES($1,$2,$3,'NOTICE_TEST',1,'draft',1,100,1,100,'floor',18,$4,'通知来源约束测试')
  `, [ids.loyaltyPolicy, ids.tenant, ids.store, ids.employee])
  await pool.query(`
    INSERT INTO mbox.orders(
      id,tenant_id,store_id,table_session_id,public_id,channel,status,payment_status,
      subtotal_amount_minor,discount_amount_minor,total_amount_minor,currency,
      created_by_customer_id,loyalty_policy_version_id
    ) VALUES
      ($1,$4,$5,$6,'wechat-notice-order-001','guest_qr','completed','paid',1000,0,1000,'CNY',$7,$8),
      ($2,$4,$5,$6,'wechat-notice-order-002','guest_qr','completed','paid',1000,0,1000,'CNY',$7,$8),
      ($3,$4,$5,$6,'wechat-notice-order-003','guest_qr','completed','paid',1000,0,1000,'CNY',$7,$8)
  `, [
    ids.order, ids.secondOrder, ids.thirdOrder, ids.tenant, ids.store,
    ids.session, ids.customer, ids.loyaltyPolicy,
  ])
  await pool.query(`
    INSERT INTO mbox.payments(
      id,tenant_id,store_id,order_id,public_id,provider,provider_transaction_id,
      method,amount_minor,currency,status,succeeded_at
    ) VALUES
      ($1,$4,$5,$6,'wechat-notice-payment-001','cash','wechat-notice-cash-001','cash',1000,'CNY','succeeded','2026-08-16T03:00:00Z'),
      ($2,$4,$5,$7,'wechat-notice-payment-002','cash','wechat-notice-cash-002','cash',1000,'CNY','succeeded','2026-08-16T03:01:00Z'),
      ($3,$4,$5,$8,'wechat-notice-payment-003','cash','wechat-notice-cash-003','cash',1000,'CNY','succeeded','2026-08-16T03:02:00Z')
  `, [
    ids.payment, ids.secondPayment, ids.thirdPayment, ids.tenant, ids.store,
    ids.order, ids.secondOrder, ids.thirdOrder,
  ])
  await pool.query(`
    INSERT INTO mbox.loyalty_order_awards(
      id,tenant_id,store_id,membership_id,customer_id,order_id,payment_id,
      policy_version_id,eligible_amount_minor,awarded_points,awarded_growth,currency,awarded_at
    ) VALUES
      ($1,$4,$5,$6,$7,$8,$9,$10,1000,10,10,'CNY',clock_timestamp()-interval '2 minutes'),
      ($2,$4,$5,$6,$7,$11,$12,$10,1000,10,10,'CNY',clock_timestamp()-interval '1 minute'),
      ($3,$4,$5,$6,$7,$13,$14,$10,1000,10,10,'CNY',clock_timestamp()-interval '30 seconds')
  `, [
    ids.source, ids.secondSource, ids.thirdSource, ids.tenant, ids.store,
    ids.membership, ids.customer, ids.order, ids.payment, ids.loyaltyPolicy,
    ids.secondOrder, ids.secondPayment, ids.thirdOrder, ids.thirdPayment,
  ])
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
}
