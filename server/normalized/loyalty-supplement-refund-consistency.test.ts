import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { NormalizedCommandExecutor } from './command-executor.js'
import { CustomerExperienceRequestError } from './customer-experience-repository.js'
import { CustomerExperienceService } from './customer-experience-service.js'
import { LoyaltyAccrualRepository } from './loyalty-accrual-repository.js'
import { ScopedPostgresTransactionRunner, type PostgresPool } from './transaction-runner.js'

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip

const base = {
  tenant: randomUUID(), store: randomUUID(), area: randomUUID(), table: randomUUID(), session: randomUUID(),
  drafter: randomUUID(), approver: randomUUID(), publisher: randomUUID(),
  policy: randomUUID(), product: randomUUID(),
} as const

interface Scenario {
  customerId: string
  membershipId: string
  accountId: string
  orderId: string
  orderPublicId: string
  orderItemId: string
  paymentId: string
}

integration('loyalty supplement and refund consistency PostgreSQL integration', () => {
  let pool: Pool
  let runner: ScopedPostgresTransactionRunner
  let service: CustomerExperienceService

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    pool = new Pool({ connectionString: databaseUrl, max: 8 })
    runner = new ScopedPostgresTransactionRunner(pool as unknown as PostgresPool)
    service = new CustomerExperienceService(
      runner,
      new NormalizedCommandExecutor(runner),
      { updateProfile: async () => { throw new Error('not used') } },
    )
    await seedBase(pool)
  })

  afterAll(async () => pool?.end())

  it('marks an approved request not_required when automatic accrual recovered first', async () => {
    const scenario = await createScenario(pool)
    const request = await requestSupplement(scenario, 'auto-recovers')

    const automatic = await accrue(scenario)
    expect(automatic).toMatchObject({ applied: true, pointsDelta: 80, growthDelta: 80 })

    const decision = await approve(request.value.publicId, 'auto-recovers')
    expect(decision.value).toEqual(expect.objectContaining({
      status: 'not_required', pointsDelta: 0, growthDelta: 0,
    }))
    expect(await account(pool, scenario)).toMatchObject({ available_points: 80, growth_value: 80 })
    expect((await pool.query(`SELECT count(*)::int AS count FROM mbox.loyalty_order_awards WHERE order_id=$1`,
      [scenario.orderId])).rows[0]?.count).toBe(1)
  })

  it('creates the full award then applies every historical and future succeeded refund exactly once', async () => {
    const scenario = await createScenario(pool)
    const request = await requestSupplement(scenario, 'refund-before-approval')
    const firstRefund = await insertRefund(pool, scenario, 2_000, 'before')
    expect((await reverse(scenario, firstRefund.refundId, firstRefund.completedAt)).applied).toBe(false)
    await pool.query(`UPDATE mbox.payments SET status='partially_refunded' WHERE id=$1`, [scenario.paymentId])
    await pool.query(`UPDATE mbox.orders SET payment_status='partially_refunded' WHERE id=$1`, [scenario.orderId])

    const decision = await approve(request.value.publicId, 'refund-before-approval')
    expect(decision.value).toEqual(expect.objectContaining({
      status: 'executed', pointsDelta: 60, growthDelta: 60,
    }))
    expect(await account(pool, scenario)).toMatchObject({
      available_points: 60, pending_recovery_points: 0, growth_value: 60,
    })

    const secondRefund = await insertRefund(pool, scenario, 2_000, 'after')
    const future = await reverse(scenario, secondRefund.refundId, secondRefund.completedAt)
    expect(future).toMatchObject({ applied: true, pointsDelta: -20, growthDelta: -20 })
    expect((await reverse(scenario, secondRefund.refundId, secondRefund.completedAt)).applied).toBe(false)
    expect(await account(pool, scenario)).toMatchObject({ available_points: 40, growth_value: 40 })

    const applications = await pool.query(`
      SELECT eligible_refund_amount_minor::text AS amount, reversed_points, reversed_growth
      FROM mbox.loyalty_award_refund_applications
      WHERE order_id=$1 ORDER BY applied_at, refund_id
    `, [scenario.orderId])
    expect(applications.rows).toEqual([
      { amount: '2000', reversed_points: 20, reversed_growth: 20 },
      { amount: '2000', reversed_points: 20, reversed_growth: 20 },
    ])
  })

  it('records a tiny exact-carry refund and serializes concurrent replay without duplicate effects', async () => {
    const failedScenario = await createScenario(pool)
    await accrue(failedScenario)
    const failedRefund = await insertRefund(pool, failedScenario, 1_000, 'failed', 'failed')
    expect((await reverse(failedScenario, failedRefund.refundId, failedRefund.completedAt)).applied).toBe(false)
    expect((await pool.query(`
      SELECT count(*)::int AS count FROM mbox.loyalty_award_refund_applications WHERE refund_id=$1
    `, [failedRefund.refundId])).rows[0]?.count).toBe(0)

    const tiny = await createScenario(pool)
    await accrue(tiny)
    const tinyRefund = await insertRefund(pool, tiny, 1, 'tiny')
    const tinyApplied = await reverse(tiny, tinyRefund.refundId, tinyRefund.completedAt)
    expect(tinyApplied).toMatchObject({ applied: true, pointsDelta: -1, growthDelta: -1 })
    expect((await reverse(tiny, tinyRefund.refundId, tinyRefund.completedAt)).applied).toBe(false)
    const tinyFact = await pool.query(`
      SELECT eligible_refund_amount_minor::text AS amount, reversed_points, reversed_growth
      FROM mbox.loyalty_award_refund_applications WHERE refund_id=$1
    `, [tinyRefund.refundId])
    expect(tinyFact.rows[0]).toEqual({ amount: '1', reversed_points: 1, reversed_growth: 1 })
    expect((await pool.query(`SELECT reversed_amount_minor::text AS amount FROM mbox.loyalty_order_awards WHERE order_id=$1`,
      [tiny.orderId])).rows[0]?.amount).toBe('1')

    const concurrent = await createScenario(pool)
    await accrue(concurrent)
    const concurrentRefund = await insertRefund(pool, concurrent, 4_000, 'concurrent')
    const results = await Promise.all([
      reverse(concurrent, concurrentRefund.refundId, concurrentRefund.completedAt),
      reverse(concurrent, concurrentRefund.refundId, concurrentRefund.completedAt),
    ])
    expect(results.map((result) => result.applied).toSorted()).toEqual([false, true])
    expect(await account(pool, concurrent)).toMatchObject({ available_points: 40, growth_value: 40 })
    expect((await pool.query(`
      SELECT count(*)::int AS count FROM mbox.loyalty_award_refund_applications WHERE refund_id=$1
    `, [concurrentRefund.refundId])).rows[0]?.count).toBe(1)
  })

  it('tops up a partial automatic award and reverses refunds against automatic plus supplement totals', async () => {
    const scenario = await createScenario(pool)
    await seedPartialAutomaticAward(pool, scenario, 40)
    const request = await requestSupplement(scenario, 'partial-auto-plus-supplement')
    expect(request.value).toMatchObject({ requestedPoints: 40, requestedGrowth: 40 })
    const decision = await approve(request.value.publicId, 'partial-auto-plus-supplement')
    expect(decision.value).toMatchObject({ status: 'executed', pointsDelta: 40, growthDelta: 40 })

    const refund = await insertRefund(pool, scenario, 4_000, 'combined')
    expect(await reverse(scenario, refund.refundId, refund.completedAt))
      .toMatchObject({ applied: true, pointsDelta: -40, growthDelta: -40 })
    expect(await account(pool, scenario)).toMatchObject({ available_points: 40, growth_value: 40 })
    const award = await pool.query(`
      SELECT awarded_points,awarded_growth,reversed_points,reversed_growth
      FROM mbox.loyalty_order_awards WHERE order_id=$1
    `, [scenario.orderId])
    expect(award.rows[0]).toEqual({
      awarded_points: 80, awarded_growth: 80, reversed_points: 40, reversed_growth: 40,
    })
  })

  it('uses the frozen points multiplier and excludes a consumed gift authorization', async () => {
    const multiplied = await createScenario(pool, { multiplierNumerator: 3, multiplierDenominator: 2 })
    const request = await requestSupplement(multiplied, 'frozen-multiplier')
    expect(request.value).toMatchObject({ requestedPoints: 120, requestedGrowth: 80 })
    const reconciliation = await service.loyaltyReconciliation(staff(base.approver))
    expect(reconciliation.find((entry) => entry.orderPublicId===multiplied.orderPublicId))
      .toMatchObject({ expectedPoints: 120, expectedGrowth: 80, status: 'missing' })

    const gifted = await createScenario(pool)
    const benefitId = randomUUID()
    await pool.query(`
      INSERT INTO mbox.benefits(
        id,tenant_id,store_id,customer_id,benefit_code,benefit_type,status,
        value_amount_minor,currency
      ) VALUES($1,$2,$3,$4,$5,'gift_product','redeemed',8000,'CNY')
    `, [benefitId, base.tenant, base.store, gifted.customerId, `gift-${benefitId.slice(0, 8)}`])
    await pool.query(`
      INSERT INTO mbox.pricing_authorizations(
        tenant_id,store_id,table_session_id,order_id,source_type,source_id,kind,
        amount_minor,maximum_amount_minor,currency,benefit_id,status,consumed_at
      ) VALUES($1,$2,$3,$4,'benefit',$5,'gift',8000,8000,'CNY',$5,'consumed',clock_timestamp())
    `, [base.tenant, base.store, base.session, gifted.orderId, benefitId])
    await expect(requestSupplement(gifted, 'gift-excluded'))
      .rejects.toMatchObject<CustomerExperienceRequestError>({ code: 'LOYALTY_SUPPLEMENT_NOT_REQUIRED' })
    const giftReconciliation = await service.loyaltyReconciliation(staff(base.approver))
    expect(giftReconciliation.find((entry) => entry.orderPublicId===gifted.orderPublicId))
      .toMatchObject({ eligibleAmountMinor: 0, expectedPoints: 0, expectedGrowth: 0 })
  })

  it('keeps refund applications append-only and hidden from another runtime store scope', async () => {
    const scenario = await createScenario(pool)
    await accrue(scenario)
    const refund = await insertRefund(pool, scenario, 2_000, 'rls')
    await reverse(scenario, refund.refundId, refund.completedAt)
    await expect(pool.query(`
      UPDATE mbox.loyalty_award_refund_applications SET reversed_points=0 WHERE refund_id=$1
    `, [refund.refundId])).rejects.toThrow(/append-only|change/i)

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SET LOCAL ROLE mbox_runtime')
      await client.query(`SELECT set_config('app.tenant_id',$1,true),set_config('app.store_id',$2,true)`,
        [base.tenant, randomUUID()])
      const hidden = await client.query(`
        SELECT count(*)::int AS count FROM mbox.loyalty_award_refund_applications WHERE refund_id=$1
      `, [refund.refundId])
      expect(hidden.rows[0]?.count).toBe(0)
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
  })

  async function requestSupplement(scenario: Scenario, suffix: string) {
    return service.requestLoyaltySupplement(staff(base.drafter), {
      orderPublicId: scenario.orderPublicId,
      reason: '付款成功但积分事实缺失',
      idempotencyKey: `loyalty-request-${suffix}-${scenario.orderId}`,
    })
  }

  async function approve(publicId: string, suffix: string) {
    return service.decideLoyaltySupplement(staff(base.approver), {
      publicId,
      decision: 'approve',
      reason: '复核权威付款、冻结规则和当前积分事实',
      idempotencyKey: `loyalty-approve-${suffix}-${publicId}`,
    })
  }

  async function accrue(scenario: Scenario) {
    return runner.run(scope(), (transaction) => new LoyaltyAccrualRepository(transaction).recordPaidOrder({
      orderId: scenario.orderId,
      paymentId: scenario.paymentId,
      occurredAt: '2026-08-16T06:00:00.000Z',
    }))
  }

  async function reverse(scenario: Scenario, refundId: string, occurredAt: string) {
    return runner.run(scope(), (transaction) => new LoyaltyAccrualRepository(transaction).reverseSucceededRefund({
      orderId: scenario.orderId,
      paymentId: scenario.paymentId,
      refundId,
      occurredAt,
    }))
  }
})

function scope() {
  return { tenantId: base.tenant, storeId: base.store }
}

function staff(employeeId: string) {
  return { scope: scope(), employeeId, businessDate: '2026-08-16' }
}

async function account(pool: Pool, scenario: Scenario) {
  const selected = await pool.query(`
    SELECT available_points,pending_recovery_points,growth_value,redemption_status
    FROM mbox.loyalty_accounts WHERE id=$1
  `, [scenario.accountId])
  return selected.rows[0]
}

async function createScenario(
  pool: Pool,
  options: Readonly<{ multiplierNumerator?: number; multiplierDenominator?: number }> = {},
): Promise<Scenario> {
  const scenario: Scenario = {
    customerId: randomUUID(), membershipId: randomUUID(), accountId: randomUUID(),
    orderId: randomUUID(), orderPublicId: '', orderItemId: randomUUID(), paymentId: randomUUID(),
  }
  scenario.orderPublicId = `loyalty-consistency-${scenario.orderId.slice(0, 12)}`
  const memberNo = `MBX${scenario.membershipId.replaceAll('-', '').slice(0, 16).toUpperCase()}`
  await pool.query(`
    INSERT INTO mbox.customers(id,tenant_id,store_id,public_id,status)
    VALUES($1,$2,$3,$4,'active')
  `, [scenario.customerId, base.tenant, base.store, `customer-${scenario.customerId.slice(0, 12)}`])
  await pool.query(`
    INSERT INTO mbox.customer_memberships(id,tenant_id,store_id,customer_id,member_no,level,status)
    VALUES($1,$2,$3,$4,$5,'member','active')
  `, [scenario.membershipId, base.tenant, base.store, scenario.customerId, memberNo])
  await pool.query(`
    INSERT INTO mbox.loyalty_accounts(id,tenant_id,store_id,membership_id,customer_id)
    VALUES($1,$2,$3,$4,$5)
  `, [scenario.accountId, base.tenant, base.store, scenario.membershipId, scenario.customerId])
  await pool.query(`
    INSERT INTO mbox.orders(
      id,tenant_id,store_id,table_session_id,public_id,channel,status,payment_status,
      subtotal_amount_minor,discount_amount_minor,total_amount_minor,currency,
      created_by_customer_id,submitted_at,settlement_mode,fulfillment_state,
      loyalty_policy_version_id,loyalty_points_multiplier_numerator,
      loyalty_points_multiplier_denominator
    ) VALUES($1,$2,$3,$4,$5,'guest_qr','submitted','paid',8000,0,8000,'CNY',$6,
      '2026-08-16T05:55:00Z','immediate_payment','active',$7,$8,$9)
  `, [
    scenario.orderId, base.tenant, base.store, base.session, scenario.orderPublicId,
    scenario.customerId, base.policy,
    options.multiplierNumerator ?? 1, options.multiplierDenominator ?? 1,
  ])
  await pool.query(`
    INSERT INTO mbox.order_items(
      id,tenant_id,store_id,order_id,product_id,quantity,unit_price_minor,
      discount_amount_minor,total_amount_minor,currency,fulfillment_station,
      product_snapshot,loyalty_eligible_at_submission,loyalty_eligibility_source,status
    ) VALUES($1,$2,$3,$4,$5,1,8000,0,8000,'CNY','bar','{}',true,'catalog_product','submitted')
  `, [scenario.orderItemId, base.tenant, base.store, scenario.orderId, base.product])
  await pool.query(`
    INSERT INTO mbox.payments(
      id,tenant_id,store_id,order_id,public_id,provider,provider_transaction_id,
      method,amount_minor,currency,status,succeeded_at
    ) VALUES($1,$2,$3,$4,$5,'cash',$6,'cash',8000,'CNY','succeeded','2026-08-16T06:00:00Z')
  `, [
    scenario.paymentId, base.tenant, base.store, scenario.orderId,
    `payment-${scenario.paymentId.slice(0, 12)}`, `cash-${scenario.paymentId}`,
  ])
  return scenario
}

async function insertRefund(
  pool: Pool,
  scenario: Scenario,
  amountMinor: number,
  suffix: string,
  status: 'succeeded' | 'failed' = 'succeeded',
): Promise<{ refundId: string; completedAt: string }> {
  const refundId = randomUUID()
  const refundItemId = randomUUID()
  const completedAt = `2026-08-16T0${suffix==='after' ? '8' : '7'}:00:00.000Z`
  await pool.query(`
    INSERT INTO mbox.refunds(
      id,tenant_id,store_id,payment_id,public_id,provider_refund_id,amount_minor,currency,
      status,reason,requested_by_employee_id,approved_by_employee_id,decision_reason,completed_at
    ) VALUES($1,$2,$3,$4,$5,$6,$7,'CNY',$8,'一致性测试退款',$9,$10,'收银复核通过',$11)
  `, [
    refundId, base.tenant, base.store, scenario.paymentId,
    `refund-${suffix}-${refundId.slice(0, 12)}`, `provider-refund-${refundId}`,
    amountMinor, status, base.drafter, base.approver, completedAt,
  ])
  await pool.query(`
    INSERT INTO mbox.refund_items(id,tenant_id,store_id,refund_id,order_item_id,amount_minor,currency)
    VALUES($1,$2,$3,$4,$5,$6,'CNY')
  `, [refundItemId, base.tenant, base.store, refundId, scenario.orderItemId, amountMinor])
  return { refundId, completedAt }
}

async function seedPartialAutomaticAward(pool: Pool, scenario: Scenario, amount: number) {
  const pointLedgerId = randomUUID()
  const lotId = randomUUID()
  await pool.query(`
    INSERT INTO mbox.loyalty_order_awards(
      tenant_id,store_id,membership_id,customer_id,order_id,payment_id,policy_version_id,
      eligible_amount_minor,awarded_points,awarded_growth,currency,awarded_at
    ) VALUES($1,$2,$3,$4,$5,$6,$7,8000,$8,$8,'CNY','2026-08-16T06:00:00Z')
  `, [
    base.tenant, base.store, scenario.membershipId, scenario.customerId,
    scenario.orderId, scenario.paymentId, base.policy, amount,
  ])
  await pool.query(`
    UPDATE mbox.loyalty_accounts SET available_points=$2,growth_value=$2 WHERE id=$1
  `, [scenario.accountId, amount])
  await pool.query(`
    UPDATE mbox.customer_memberships SET points_balance=$2,lifetime_points=$2 WHERE id=$1
  `, [scenario.membershipId, amount])
  await pool.query(`
    INSERT INTO mbox.loyalty_point_ledger(
      id,tenant_id,store_id,membership_id,customer_id,entry_type,points_delta,balance_after,
      source_type,source_id,reason,expires_at,policy_version_id,order_id,payment_id,
      idempotency_key,occurred_at
    ) VALUES($1,$2,$3,$4,$5,'earn',$6,$6,'order',$7::text,'部分自动积分测试事实',
      '2028-02-16T06:00:00Z',$8,$7::uuid,$9,$10,'2026-08-16T06:00:00Z')
  `, [
    pointLedgerId, base.tenant, base.store, scenario.membershipId, scenario.customerId,
    amount, scenario.orderId, base.policy, scenario.paymentId,
    `partial-auto-points-${scenario.orderId}`,
  ])
  await pool.query(`
    INSERT INTO mbox.loyalty_point_lots(
      id,tenant_id,store_id,membership_id,customer_id,source_ledger_entry_id,
      source_type,source_id,original_points,remaining_points,available_at,expires_at,status
    ) VALUES($1,$2,$3,$4,$5,$6,'order',$7,$8,$8,'2026-08-16T06:00:00Z',
      '2028-02-16T06:00:00Z','available')
  `, [
    lotId, base.tenant, base.store, scenario.membershipId, scenario.customerId,
    pointLedgerId, scenario.orderId, amount,
  ])
  await pool.query(`
    INSERT INTO mbox.loyalty_point_lot_movements(
      tenant_id,store_id,lot_id,movement_type,points_delta,balance_after,
      source_type,source_id,idempotency_key,occurred_at
    ) VALUES($1,$2,$3,'grant',$4,$4,'order',$5,$6,'2026-08-16T06:00:00Z')
  `, [base.tenant, base.store, lotId, amount, scenario.orderId, `partial-auto-lot-${lotId}`])
  await pool.query(`
    INSERT INTO mbox.loyalty_growth_ledger(
      tenant_id,store_id,membership_id,customer_id,entry_type,growth_delta,balance_after,
      policy_version_id,order_id,payment_id,source_id,reason,idempotency_key,occurred_at
    ) VALUES($1,$2,$3,$4,'earn',$5,$5,$6,$7::uuid,$8,$7::text,
      '部分自动成长值测试事实',$9,'2026-08-16T06:00:00Z')
  `, [
    base.tenant, base.store, scenario.membershipId, scenario.customerId,
    amount, base.policy, scenario.orderId, scenario.paymentId,
    `partial-auto-growth-${scenario.orderId}`,
  ])
}

async function seedBase(pool: Pool) {
  const suffix = base.tenant.replaceAll('-', '').slice(0, 10)
  await pool.query(`INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'Loyalty Consistency Tenant')`,
    [base.tenant, `lc-${suffix}`])
  await pool.query(`INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1,$2,$3,'Loyalty Consistency Store')`,
    [base.store, base.tenant, `lc-${suffix}`])
  await pool.query(`
    INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name,status) VALUES
      ($1,$4,$5,$6,'Consistency Drafter','active'),
      ($2,$4,$5,$7,'Consistency Approver','active'),
      ($3,$4,$5,$8,'Consistency Publisher','active')
  `, [
    base.drafter, base.approver, base.publisher, base.tenant, base.store,
    `LCD-${suffix}`, `LCA-${suffix}`, `LCP-${suffix}`,
  ])
  await pool.query(`
    INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type)
    VALUES($1,$2,$3,$4,'Consistency Area','bar')
  `, [base.area, base.tenant, base.store, `LCA-${suffix}`])
  await pool.query(`
    INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity,status)
    VALUES($1,$2,$3,$4,$5,'Consistency Table',4,'available')
  `, [base.table, base.tenant, base.store, base.area, `LCT-${suffix}`])
  await pool.query(`
    INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count,status)
    VALUES($1,$2,$3,$4,$5,'2026-08-16',2,'open')
  `, [base.session, base.tenant, base.store, base.table, `consistency-session-${suffix}`])
  await pool.query(`
    INSERT INTO mbox.loyalty_policy_versions(
      id,tenant_id,store_id,policy_code,version,status,
      points_numerator,points_denominator_minor,growth_numerator,growth_denominator_minor,
      rounding_mode,points_validity_months,effective_from,drafted_by_employee_id,
      approved_by_employee_id,approved_at,published_by_employee_id,published_at,
      publication_mode,reason
    ) VALUES($1,$2,$3,'BASE',1,'published',1,100,1,100,'floor',18,
      '2026-08-01T00:00:00Z',$4,$5,'2026-08-01T00:00:00Z',$6,'2026-08-01T00:01:00Z',
      'separated','退款与漏积分一致性测试规则')
  `, [base.policy, base.tenant, base.store, base.drafter, base.approver, base.publisher])
  await pool.query(`
    INSERT INTO mbox.products(
      id,tenant_id,store_id,code,name,category_code,fulfillment_station,status,loyalty_eligible
    ) VALUES($1,$2,$3,$4,'Consistency Product','drink','bar','active',true)
  `, [base.product, base.tenant, base.store, `LCP-${suffix}`])
}
