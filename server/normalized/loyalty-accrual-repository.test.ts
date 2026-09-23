import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { NormalizedCommandExecutor } from './command-executor.js'
import { CustomerExperienceRequestError } from './customer-experience-repository.js'
import { CustomerExperienceService } from './customer-experience-service.js'
import { LoyaltyAccrualRepository } from './loyalty-accrual-repository.js'
import { PostgresMembershipConfigurationDraftRepository } from './membership-configuration-draft-repository.js'
import { MembershipConfigurationDraftService } from './membership-configuration-draft-service.js'
import { ScopedPostgresTransactionRunner, type PostgresPool } from './transaction-runner.js'

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip

const id = {
  tenant: randomUUID(), store: randomUUID(), area: randomUUID(), table: randomUUID(), session: randomUUID(),
  drafter: randomUUID(), approver: randomUUID(), publisher: randomUUID(),
  customer: randomUUID(), membership: randomUUID(), account: randomUUID(),
  policy: randomUUID(), eligibleProduct: randomUUID(), excludedProduct: randomUUID(),
  order: randomUUID(), eligibleItem: randomUUID(), excludedItem: randomUUID(), payment: randomUUID(),
  partialRefund: randomUUID(), partialRefundItem: randomUUID(), remainderRefund: randomUUID(), remainderRefundItem: randomUUID(),
  excludedRefund: randomUUID(), excludedRefundItem: randomUUID(),
} as const

integration('loyalty accrual PostgreSQL integration', () => {
  let pool: Pool
  let runner: ScopedPostgresTransactionRunner

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    pool = new Pool({ connectionString: databaseUrl, max: 4 })
    runner = new ScopedPostgresTransactionRunner(pool as unknown as PostgresPool)
    await seed(pool)
  })

  afterAll(async () => pool?.end())

  it('awards separate points and growth only once from a verified fully paid eligible order', async () => {
    const first = await runner.run({ tenantId: id.tenant, storeId: id.store }, async (transaction) => (
      new LoyaltyAccrualRepository(transaction).recordPaidOrder({
        orderId: id.order,
        paymentId: id.payment,
        occurredAt: '2026-08-16T03:00:00.000Z',
      })
    ))
    expect(first).toMatchObject({ applied: true, pointsDelta: 80, growthDelta: 80, pendingRecoveryPoints: 0 })

    const replay = await runner.run({ tenantId: id.tenant, storeId: id.store }, async (transaction) => (
      new LoyaltyAccrualRepository(transaction).recordPaidOrder({
        orderId: id.order,
        paymentId: id.payment,
        occurredAt: '2026-08-16T03:00:00.000Z',
      })
    ))
    expect(replay.applied).toBe(false)
    expect(await account(pool)).toMatchObject({
      available_points: 80,
      growth_value: 80,
      pending_recovery_points: 0,
      redemption_status: 'active',
    })
    const locked = await pool.query(`SELECT loyalty_policy_version_id FROM mbox.orders WHERE id=$1`, [id.order])
    expect(locked.rows[0]?.loyalty_policy_version_id).toBe(id.policy)
    const ledgers = await pool.query(`
      SELECT entry_type, points_delta, balance_after, policy_version_id, payment_id
      FROM mbox.loyalty_point_ledger WHERE tenant_id=$1 AND store_id=$2 ORDER BY occurred_at, id
    `, [id.tenant, id.store])
    expect(ledgers.rows).toEqual([{
      entry_type: 'earn', points_delta: 80, balance_after: 80,
      policy_version_id: id.policy, payment_id: id.payment,
    }])
  })

  it('ignores excluded-item refunds and reverses eligible refunds from the original award without negative balance', async () => {
    const excluded = await reverse(id.excludedRefund)
    expect(excluded).toMatchObject({ applied: true, pointsDelta: 0, growthDelta: 0 })

    const partial = await reverse(id.partialRefund)
    expect(partial).toMatchObject({ applied: true, pointsDelta: -20, growthDelta: -20 })
    expect(await account(pool)).toMatchObject({ available_points: 60, growth_value: 60, pending_recovery_points: 0 })

    await pool.query(`UPDATE mbox.loyalty_accounts SET available_points=5 WHERE id=$1`, [id.account])
    await pool.query(`
      UPDATE mbox.loyalty_point_lots
      SET remaining_points=5, status='available'
      WHERE membership_id=$1 AND status='available'
    `, [id.membership])
    const remainder = await reverse(id.remainderRefund)
    expect(remainder).toMatchObject({ applied: true, pointsDelta: -60, growthDelta: -60, pendingRecoveryPoints: 55 })
    expect(await account(pool)).toMatchObject({
      available_points: 0,
      growth_value: 0,
      pending_recovery_points: 55,
      redemption_status: 'suspended',
    })
    expect((await reverse(id.remainderRefund)).applied).toBe(false)
    const award = await pool.query(`
      SELECT reversed_amount_minor::text, reversed_points, reversed_growth
      FROM mbox.loyalty_order_awards WHERE order_id=$1
    `, [id.order])
    expect(award.rows[0]).toEqual({ reversed_amount_minor: '8000', reversed_points: 80, reversed_growth: 80 })
  })

  it('carries sub-unit rewards across orders, reverses the original exact contribution, and isolates a new policy version', async () => {
    const tiny = {
      customer: randomUUID(), membership: randomUUID(), account: randomUUID(), policy: randomUUID(), nextPolicy: randomUUID(),
      firstOrder: randomUUID(), firstItem: randomUUID(), firstPayment: randomUUID(),
      secondOrder: randomUUID(), secondItem: randomUUID(), secondPayment: randomUUID(),
      thirdOrder: randomUUID(), thirdItem: randomUUID(), thirdPayment: randomUUID(),
      refund: randomUUID(), refundItem: randomUUID(),
    }
    const suffix = tiny.customer.replaceAll('-', '').slice(0, 10)
    await pool.query(`INSERT INTO mbox.customers(id,tenant_id,store_id,public_id,status) VALUES($1,$2,$3,$4,'active')`, [
      tiny.customer, id.tenant, id.store, `tiny-customer-${suffix}`,
    ])
    await pool.query(`INSERT INTO mbox.customer_memberships(id,tenant_id,store_id,customer_id,member_no,level,status) VALUES($1,$2,$3,$4,$5,'member','active')`, [
      tiny.membership, id.tenant, id.store, tiny.customer, `MBXTINY${suffix.toUpperCase()}`,
    ])
    await pool.query(`INSERT INTO mbox.loyalty_accounts(id,tenant_id,store_id,membership_id,customer_id) VALUES($1,$2,$3,$4,$5)`, [
      tiny.account, id.tenant, id.store, tiny.membership, tiny.customer,
    ])
    await pool.query(`
      INSERT INTO mbox.loyalty_policy_versions(
        id,tenant_id,store_id,policy_code,version,status,points_numerator,points_denominator_minor,
        growth_numerator,growth_denominator_minor,rounding_mode,points_validity_months,effective_from,
        drafted_by_employee_id,approved_by_employee_id,approved_at,published_by_employee_id,published_at,
        publication_mode,reason
      ) VALUES
        ($1,$2,$3,$4,1,'published',1,100,1,100,'floor',18,'2026-01-01T00:00:00Z',$5,$6,'2026-01-01T00:00:00Z',$7,'2026-01-01T00:01:00Z','separated','不足一元跨订单精确累计'),
        ($8,$2,$3,$9,1,'published',1,100,1,100,'floor',18,'2026-01-01T00:00:00Z',$5,$6,'2026-01-01T00:00:00Z',$7,'2026-01-01T00:01:00Z','separated','换版后余数必须隔离')
    `, [tiny.policy, id.tenant, id.store, `TINY${suffix.toUpperCase()}`, id.drafter, id.approver, id.publisher, tiny.nextPolicy, `TINY2${suffix.toUpperCase()}`])
    await seedTinyPaidOrder(pool, {
      orderId: tiny.firstOrder, itemId: tiny.firstItem, paymentId: tiny.firstPayment,
      policyId: tiny.policy, customerId: tiny.customer, suffix: `tiny-first-${suffix}`,
    })
    await seedTinyPaidOrder(pool, {
      orderId: tiny.secondOrder, itemId: tiny.secondItem, paymentId: tiny.secondPayment,
      policyId: tiny.policy, customerId: tiny.customer, suffix: `tiny-second-${suffix}`,
    })
    expect(await recordTiny(tiny.firstOrder, tiny.firstPayment)).toMatchObject({ applied: true, pointsDelta: 0, growthDelta: 0 })
    await pool.query(`
      UPDATE mbox.orders
      SET loyalty_points_multiplier_numerator=2,loyalty_points_multiplier_denominator=2
      WHERE id=$1
    `, [tiny.secondOrder])
    expect(await recordTiny(tiny.secondOrder, tiny.secondPayment)).toMatchObject({ applied: true, pointsDelta: 1, growthDelta: 1 })
    expect((await recordTiny(tiny.secondOrder, tiny.secondPayment)).applied).toBe(false)
    expect((await pool.query(`SELECT available_points,growth_value FROM mbox.loyalty_accounts WHERE id=$1`, [tiny.account])).rows[0])
      .toEqual({ available_points: 1, growth_value: 1 })
    expect((await pool.query(`SELECT count(*)::integer AS count FROM mbox.loyalty_order_reward_contributions WHERE membership_id=$1`, [tiny.membership])).rows[0])
      .toEqual({ count: 2 })

    await pool.query(`
      INSERT INTO mbox.refunds(
        id,tenant_id,store_id,payment_id,public_id,provider_refund_id,amount_minor,currency,status,reason,
        requested_by_employee_id,approved_by_employee_id,decision_reason,completed_at
      ) VALUES($1,$2,$3,$4,$5,$6,25,'CNY','succeeded','第一笔订单部分退款',$7,$8,'收银复核通过','2026-08-17T01:00:00Z')
    `, [tiny.refund, id.tenant, id.store, tiny.firstPayment, `tiny-refund-${suffix}`, `tiny-refund-provider-${suffix}`, id.drafter, id.approver])
    await pool.query(`INSERT INTO mbox.refund_items(id,tenant_id,store_id,refund_id,order_item_id,amount_minor,currency) VALUES($1,$2,$3,$4,$5,25,'CNY')`, [
      tiny.refundItem, id.tenant, id.store, tiny.refund, tiny.firstItem,
    ])
    const reversed = await runner.run({ tenantId: id.tenant, storeId: id.store }, (transaction) => (
      new LoyaltyAccrualRepository(transaction).reverseSucceededRefund({
        orderId: tiny.firstOrder, paymentId: tiny.firstPayment, refundId: tiny.refund,
        occurredAt: '2026-08-17T01:00:00.000Z',
      })
    ))
    expect(reversed).toMatchObject({ applied: true, pointsDelta: -1, growthDelta: -1, pendingRecoveryPoints: 0 })
    expect((await pool.query(`SELECT available_points,growth_value FROM mbox.loyalty_accounts WHERE id=$1`, [tiny.account])).rows[0])
      .toEqual({ available_points: 0, growth_value: 0 })
    expect((await pool.query(`SELECT awarded_points,reversed_points,calculation_model FROM mbox.loyalty_order_awards WHERE order_id=$1`, [tiny.firstOrder])).rows[0])
      .toEqual({ awarded_points: 0, reversed_points: 1, calculation_model: 'exact_carry' })

    await seedTinyPaidOrder(pool, {
      orderId: tiny.thirdOrder, itemId: tiny.thirdItem, paymentId: tiny.thirdPayment,
      policyId: tiny.nextPolicy, customerId: tiny.customer, suffix: `tiny-third-${suffix}`,
    })
    expect(await recordTiny(tiny.thirdOrder, tiny.thirdPayment)).toMatchObject({ applied: true, pointsDelta: 0, growthDelta: 0 })
    const carries = await pool.query(`
      SELECT policy_version_id,reward_kind,denominator::text AS denominator,remainder_numerator::text AS remainder
      FROM mbox.loyalty_reward_carry_balances WHERE membership_id=$1
      ORDER BY policy_version_id,reward_kind
    `, [tiny.membership])
    expect(carries.rows).toEqual(expect.arrayContaining([
      { policy_version_id: tiny.policy, reward_kind: 'points', denominator: '200', remainder: '150' },
      { policy_version_id: tiny.policy, reward_kind: 'growth', denominator: '100', remainder: '75' },
      { policy_version_id: tiny.nextPolicy, reward_kind: 'points', denominator: '100', remainder: '50' },
      { policy_version_id: tiny.nextPolicy, reward_kind: 'growth', denominator: '100', remainder: '50' },
    ]))

    async function recordTiny(orderId: string, paymentId: string) {
      return runner.run({ tenantId: id.tenant, storeId: id.store }, (transaction) => (
        new LoyaltyAccrualRepository(transaction).recordPaidOrder({
          orderId, paymentId, occurredAt: '2026-08-17T00:00:00.000Z',
        })
      ))
    }
  })

  it('separates policy approval from publication and keeps the current version active until cut-over', async () => {
    const cutoverAt = new Date(Math.ceil((Date.now() + 60_000) / 1000) * 1000)
    const cutoverIso = cutoverAt.toISOString()
    const expectedCutoverText = `${cutoverIso.slice(0, 19).replace('T', ' ')}+00`
    const overlapFromIso = new Date(cutoverAt.getTime() + 2 * 60_000).toISOString()
    const overlapUntilIso = new Date(cutoverAt.getTime() + 3 * 60_000).toISOString()
    const service = new CustomerExperienceService(
      runner,
      new NormalizedCommandExecutor(runner),
      { updateProfile: async () => { throw new Error('not used') } },
    )
    const draft = await service.draftLoyaltyPolicy(staff(id.drafter), {
      policyCode: 'BASE',
      pointsNumerator: 2,
      pointsDenominatorMinor: 100,
      growthNumerator: 1,
      growthDenominatorMinor: 100,
      roundingMode: 'floor',
      pointsValidityMonths: 18,
      reason: '新积分比例待双人复核',
      idempotencyKey: 'loyalty-policy-draft-v2',
    })
    await expect(service.approveLoyaltyPolicy(staff(id.drafter), {
      policyId: draft.value.id,
      reason: '本人不能批准',
      idempotencyKey: 'loyalty-policy-self-approve-v2',
    })).rejects.toMatchObject<CustomerExperienceRequestError>({ code: 'LOYALTY_POLICY_APPROVAL_DENIED' })
    const configuration = new MembershipConfigurationDraftService(
      new PostgresMembershipConfigurationDraftRepository(
        runner,{tenantId:id.tenant,storeId:id.store},
      ),
    )
    const currentDraft = await configuration.get('base_points',draft.value.id)
    const preview = await configuration.preview('base_points',draft.value.id,id.approver)
    const approved = await configuration.approve({domain:'base_points',publicId:draft.value.id,
      expectedRevision:currentDraft.revision,approverEmployeeId:id.approver,
      reason:'复核历史分布与权益成本后同意',impactPreviewPublicId:preview.publicId})
    expect(approved.status).toBe('approved')
    await expect(service.publishLoyaltyPolicy(staff(id.approver), {
      policyId: draft.value.id,
      effectiveFrom: cutoverIso,
      effectiveUntil: null,
      reason: '审批人不能正式发布',
      idempotencyKey: 'loyalty-policy-approver-publish-v2',
    })).rejects.toMatchObject<CustomerExperienceRequestError>({ code: 'LOYALTY_POLICY_PUBLISHER_NOT_INDEPENDENT' })
    const published = await service.publishLoyaltyPolicy(staff(id.publisher), {
      policyId: draft.value.id,
      effectiveFrom: cutoverIso,
      effectiveUntil: null,
      reason: '最高授权人员确认正式排期发布',
      idempotencyKey: 'loyalty-policy-publish-v2',
    })
    expect(published.value).toMatchObject({ version: 2, status: 'published' })
    const policies = await service.listLoyaltyPolicies(staff(id.approver))
    expect(policies.slice(0, 2).map((policy) => ({ version: policy.version, status: policy.status })))
      .toEqual([{ version: 2, status: 'published' }, { version: 1, status: 'published' }])
    expect(policies.find((policy) => policy.version===1)?.effectiveUntil).toBe(expectedCutoverText)
    const orderId = randomUUID()
    await pool.query(`
      INSERT INTO mbox.orders(
        id,tenant_id,store_id,table_session_id,public_id,channel,status,payment_status,
        subtotal_amount_minor,discount_amount_minor,total_amount_minor,currency,created_by_customer_id
      ) VALUES($1,$2,$3,$4,$5,'guest_qr','draft','unpaid',100,0,100,'CNY',$6)
    `, [orderId, id.tenant, id.store, id.session, `scheduled-policy-order-${orderId.slice(0, 8)}`, id.customer])
    expect((await pool.query(`SELECT loyalty_policy_version_id::text FROM mbox.orders WHERE id=$1`, [orderId]))
      .rows[0]?.loyalty_policy_version_id).toBe(id.policy)
    await expect(pool.query(`
      INSERT INTO mbox.loyalty_policy_versions(
        tenant_id,store_id,policy_code,version,status,points_numerator,points_denominator_minor,
        growth_numerator,growth_denominator_minor,rounding_mode,points_validity_months,
        effective_from,effective_until,drafted_by_employee_id,approved_by_employee_id,approved_at,
        published_by_employee_id,published_at,publication_mode,reason
      ) VALUES($1,$2,'BASE',3,'published',3,100,1,100,'floor',18,
        '${overlapFromIso}','${overlapUntilIso}',$3,$4,'2026-08-16T10:00:00Z',
        $5,'2026-08-16T10:01:00Z','separated','重叠时间窗必须由数据库拒绝')
    `, [id.tenant, id.store, id.drafter, id.approver, id.publisher]))
      .rejects.toThrow(/loyalty_policy_versions_no_published_overlap_excl/)
  })

  it('requires a different employee and executes only the calculated missing loyalty amount', async () => {
    const orderId = randomUUID()
    const itemId = randomUUID()
    const paymentId = randomUUID()
    const suffix = orderId.replaceAll('-', '').slice(0, 10)
    await pool.query(`
      INSERT INTO mbox.orders(
        id,tenant_id,store_id,table_session_id,public_id,channel,status,payment_status,
        subtotal_amount_minor,discount_amount_minor,total_amount_minor,currency,
        created_by_customer_id,submitted_at,settlement_mode,fulfillment_state,loyalty_policy_version_id
      ) VALUES($1,$2,$3,$4,$5,'guest_qr','submitted','paid',8000,0,8000,'CNY',$6,
        '2026-08-16T05:00:00Z','immediate_payment','active',$7::uuid)
    `, [orderId, id.tenant, id.store, id.session, `loyalty-missing-${suffix}`, id.customer, id.policy])
    await pool.query(`
      INSERT INTO mbox.order_items(
        id,tenant_id,store_id,order_id,product_id,quantity,unit_price_minor,
        discount_amount_minor,total_amount_minor,currency,fulfillment_station,product_snapshot,
        loyalty_eligible_at_submission,loyalty_eligibility_source,status
      ) VALUES($1,$2,$3,$4,$5,1,8000,0,8000,'CNY','bar','{}',true,'catalog_product','submitted')
    `, [itemId, id.tenant, id.store, orderId, id.eligibleProduct])
    await pool.query(`
      INSERT INTO mbox.payments(
        id,tenant_id,store_id,order_id,public_id,provider,provider_transaction_id,
        method,amount_minor,currency,status,succeeded_at
      ) VALUES($1,$2,$3,$4,$5,'cash',$6,'cash',8000,'CNY','succeeded','2026-08-16T05:01:00Z')
    `, [paymentId, id.tenant, id.store, orderId, `loyalty-missing-pay-${suffix}`, `cash-missing-${suffix}`])

    const service = new CustomerExperienceService(
      runner,
      new NormalizedCommandExecutor(runner),
      { updateProfile: async () => { throw new Error('not used') } },
    )
    const requested = await service.requestLoyaltySupplement(staff(id.drafter), {
      orderPublicId: `loyalty-missing-${suffix}`,
      reason: '付款成功但积分未自动入账',
      idempotencyKey: `loyalty-supplement-request-${suffix}`,
    })
    expect(requested.value).toMatchObject({ status: 'requested', requestedPoints: 80, requestedGrowth: 80 })
    await expect(service.decideLoyaltySupplement(staff(id.drafter), {
      publicId: requested.value.publicId,
      decision: 'approve',
      reason: '本人复核',
      idempotencyKey: `loyalty-supplement-self-${suffix}`,
    })).rejects.toMatchObject<CustomerExperienceRequestError>({ code: 'LOYALTY_SUPPLEMENT_SELF_APPROVAL_DENIED' })
    const approved = await service.decideLoyaltySupplement(staff(id.approver), {
      publicId: requested.value.publicId,
      decision: 'approve',
      reason: '核对付款和原积分规则无误',
      idempotencyKey: `loyalty-supplement-approve-${suffix}`,
    })
    expect(approved.value).toMatchObject({ status: 'executed', pointsDelta: 25, growthDelta: 80 })
    expect(await account(pool)).toMatchObject({ available_points: 25, growth_value: 80, pending_recovery_points: 0 })
    const lots = await pool.query(`
      SELECT source_type, original_points, remaining_points
      FROM mbox.loyalty_point_lots WHERE membership_id=$1 AND source_type='supplement'
    `, [id.membership])
    expect(lots.rows).toEqual([{ source_type: 'supplement', original_points: 25, remaining_points: 25 }])
  })

  async function reverse(refundId: string) {
    return runner.run({ tenantId: id.tenant, storeId: id.store }, async (transaction) => (
      new LoyaltyAccrualRepository(transaction).reverseSucceededRefund({
        orderId: id.order,
        paymentId: id.payment,
        refundId,
        occurredAt: '2026-08-16T04:00:00.000Z',
      })
    ))
  }
})

function staff(employeeId: string) {
  return {
    scope: { tenantId: id.tenant, storeId: id.store },
    employeeId,
    businessDate: '2026-08-16',
  }
}

async function account(pool: Pool) {
  const result = await pool.query(`
    SELECT available_points, growth_value, pending_recovery_points, redemption_status
    FROM mbox.loyalty_accounts WHERE id=$1
  `, [id.account])
  return result.rows[0]
}

async function seed(pool: Pool) {
  const suffix = id.tenant.replaceAll('-', '').slice(0, 10)
  await pool.query(`INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'Loyalty Tenant')`, [id.tenant, `loy-${suffix}`])
  await pool.query(`INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1,$2,$3,'Loyalty Store')`, [id.store, id.tenant, `loy-${suffix}`])
  await pool.query(`
    INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name,status) VALUES
      ($1,$4,$5,$6,'Loyalty Drafter','active'),($2,$4,$5,$7,'Loyalty Approver','active'),
      ($3,$4,$5,$8,'Loyalty Publisher','active')
  `, [id.drafter, id.approver, id.publisher, id.tenant, id.store,
    `LD-${suffix}`, `LA-${suffix}`, `LP-${suffix}`])
  await pool.query(`INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type) VALUES($1,$2,$3,$4,'Loyalty Area','bar')`, [id.area, id.tenant, id.store, `A-${suffix}`])
  await pool.query(`
    INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity,status)
    VALUES($1,$2,$3,$4,$5,'Loyalty Table',4,'available')
  `, [id.table, id.tenant, id.store, id.area, `T-${suffix}`])
  await pool.query(`
    INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count,status)
    VALUES($1,$2,$3,$4,$5,'2026-08-16',2,'open')
  `, [id.session, id.tenant, id.store, id.table, `loyalty-session-${suffix}`])
  await pool.query(`
    INSERT INTO mbox.customers(id,tenant_id,store_id,public_id,status)
    VALUES($1,$2,$3,$4,'active')
  `, [id.customer, id.tenant, id.store, `loyalty-customer-${suffix}`])
  await pool.query(`
    INSERT INTO mbox.customer_memberships(
      id,tenant_id,store_id,customer_id,member_no,level,status
    ) VALUES($1,$2,$3,$4,$5,'member','active')
  `, [id.membership, id.tenant, id.store, id.customer, `MBX${suffix.toUpperCase()}`])
  await pool.query(`
    INSERT INTO mbox.loyalty_accounts(id,tenant_id,store_id,membership_id,customer_id)
    VALUES($1,$2,$3,$4,$5)
  `, [id.account, id.tenant, id.store, id.membership, id.customer])
  await pool.query(`
    INSERT INTO mbox.loyalty_policy_versions(
      id,tenant_id,store_id,policy_code,version,status,
      points_numerator,points_denominator_minor,growth_numerator,growth_denominator_minor,
      rounding_mode,points_validity_months,effective_from,drafted_by_employee_id,
      approved_by_employee_id,approved_at,published_by_employee_id,published_at,
      publication_mode,reason
    ) VALUES($1,$2,$3,'BASE',1,'published',1,100,1,100,'floor',18,
      '2026-08-01T00:00:00Z',$4,$5,'2026-08-01T00:00:00Z',$6,'2026-08-01T00:01:00Z',
      'separated','三人审批发布测试政策')
  `, [id.policy, id.tenant, id.store, id.drafter, id.approver, id.publisher])
  await pool.query(`
    INSERT INTO mbox.products(
      id,tenant_id,store_id,code,name,category_code,fulfillment_station,status,loyalty_eligible
    ) VALUES
      ($1,$3,$4,$5,'Eligible','drink','bar','active',true),
      ($2,$3,$4,$6,'Excluded','fee','none','active',false)
  `, [id.eligibleProduct, id.excludedProduct, id.tenant, id.store, `EP-${suffix}`, `XP-${suffix}`])
  await pool.query(`
    INSERT INTO mbox.orders(
      id,tenant_id,store_id,table_session_id,public_id,channel,status,payment_status,
      subtotal_amount_minor,discount_amount_minor,total_amount_minor,currency,
      created_by_customer_id,submitted_at,settlement_mode,fulfillment_state
    ) VALUES($1,$2,$3,$4,$5,'guest_qr','submitted','paid',10000,0,10000,'CNY',$6,
      '2026-08-16T02:55:00Z','immediate_payment','active')
  `, [id.order, id.tenant, id.store, id.session, `loyalty-order-${suffix}`, id.customer])
  await pool.query(`
    INSERT INTO mbox.order_items(
      id,tenant_id,store_id,order_id,product_id,quantity,unit_price_minor,
      discount_amount_minor,total_amount_minor,currency,fulfillment_station,product_snapshot,
      loyalty_eligible_at_submission,loyalty_eligibility_source,status
    ) VALUES
      ($1,$3,$4,$5,$6,1,8000,0,8000,'CNY','bar','{}',true,'catalog_product','submitted'),
      ($2,$3,$4,$5,$7,1,2000,0,2000,'CNY','none','{}',false,'catalog_product','submitted')
  `, [id.eligibleItem, id.excludedItem, id.tenant, id.store, id.order, id.eligibleProduct, id.excludedProduct])
  await pool.query(`
    INSERT INTO mbox.payments(
      id,tenant_id,store_id,order_id,public_id,provider,provider_transaction_id,
      method,amount_minor,currency,status,succeeded_at
    ) VALUES($1,$2,$3,$4,$5,'cash',$6,'cash',10000,'CNY','succeeded','2026-08-16T03:00:00Z')
  `, [id.payment, id.tenant, id.store, id.order, `loyalty-payment-${suffix}`, `cash-${suffix}`])
  await insertRefund(pool, id.excludedRefund, id.excludedRefundItem, id.excludedItem, 1000, 'excluded', suffix)
  await insertRefund(pool, id.partialRefund, id.partialRefundItem, id.eligibleItem, 2000, 'partial', suffix)
  await insertRefund(pool, id.remainderRefund, id.remainderRefundItem, id.eligibleItem, 6000, 'remainder', suffix)
}

async function insertRefund(
  pool: Pool,
  refundId: string,
  refundItemId: string,
  orderItemId: string,
  amountMinor: number,
  code: string,
  suffix: string,
) {
  await pool.query(`
    INSERT INTO mbox.refunds(
      id,tenant_id,store_id,payment_id,public_id,provider_refund_id,amount_minor,currency,
      status,reason,requested_by_employee_id,approved_by_employee_id,decision_reason,completed_at
    ) VALUES($1,$2,$3,$4,$5,$6,$7,'CNY','succeeded','测试退款',$8,$9,'收银复核通过','2026-08-16T04:00:00Z')
  `, [refundId, id.tenant, id.store, id.payment, `loyalty-refund-${code}-${suffix}`, `refund-${code}-${suffix}`, amountMinor, id.drafter, id.approver])
  await pool.query(`
    INSERT INTO mbox.refund_items(id,tenant_id,store_id,refund_id,order_item_id,amount_minor,currency)
    VALUES($1,$2,$3,$4,$5,$6,'CNY')
  `, [refundItemId, id.tenant, id.store, refundId, orderItemId, amountMinor])
}

async function seedTinyPaidOrder(pool: Pool, input: Readonly<{
  orderId: string
  itemId: string
  paymentId: string
  policyId: string
  customerId: string
  suffix: string
}>) {
  await pool.query(`
    INSERT INTO mbox.orders(
      id,tenant_id,store_id,table_session_id,public_id,channel,status,payment_status,
      subtotal_amount_minor,discount_amount_minor,total_amount_minor,currency,created_by_customer_id,
      submitted_at,settlement_mode,fulfillment_state,loyalty_policy_version_id
    ) VALUES($1,$2,$3,$4,$5,'guest_qr','submitted','paid',50,0,50,'CNY',$6,
      '2026-08-17T00:00:00Z','immediate_payment','active',$7::uuid)
  `, [input.orderId, id.tenant, id.store, id.session, input.suffix, input.customerId, input.policyId])
  await pool.query(`
    INSERT INTO mbox.order_items(
      id,tenant_id,store_id,order_id,product_id,quantity,unit_price_minor,discount_amount_minor,
      total_amount_minor,currency,fulfillment_station,product_snapshot,loyalty_eligible_at_submission,
      loyalty_eligibility_source,status
    ) VALUES($1,$2,$3,$4,$5,1,50,0,50,'CNY','bar','{}',true,'catalog_product','submitted')
  `, [input.itemId, id.tenant, id.store, input.orderId, id.eligibleProduct])
  await pool.query(`
    INSERT INTO mbox.payments(
      id,tenant_id,store_id,order_id,public_id,provider,provider_transaction_id,method,amount_minor,currency,status,succeeded_at
    ) VALUES($1,$2,$3,$4,$5,'cash',$6,'cash',50,'CNY','succeeded','2026-08-17T00:00:00Z')
  `, [input.paymentId, id.tenant, id.store, input.orderId, `tiny-payment-${input.suffix}`, `tiny-provider-${input.suffix}`])
}
