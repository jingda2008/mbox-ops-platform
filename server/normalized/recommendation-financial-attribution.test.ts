import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { NormalizedCommandExecutor } from './command-executor.js'
import { PaymentCommandService } from './payment-command-service.js'
import type { PaymentCapabilityAuthorizationPort } from './payment-security-policy.js'
import {
  NormalizedProviderObservationAuthority,
  VerifiedProviderObservationService,
} from './provider-verification-observation.js'
import { RecommendationFinancialAttributionRepository } from './recommendation-financial-attribution-repository.js'
import {
  ScopedPostgresTransactionRunner,
  type PostgresPool,
} from './transaction-runner.js'

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip

const tenantId = randomUUID()
const storeId = randomUUID()
const otherStoreId = randomUUID()
const requesterId = randomUUID()
const approverId = randomUUID()
const customerId = randomUUID()
const areaId = randomUUID()
const recommendedProductId = randomUUID()
const otherProductId = randomUUID()
const policyId = randomUUID()
const fixtureSuffix = tenantId.replaceAll('-', '').slice(0, 12)

const orderIds = {
  paid: randomUUID(),
  pending: randomUUID(),
  failed: randomUUID(),
  upgrade: randomUUID(),
} as const

const recommendedItemIds = {
  paid: randomUUID(),
  pending: randomUUID(),
  failed: randomUUID(),
  upgrade: randomUUID(),
} as const

const otherItemIds = {
  paid: randomUUID(),
  pending: randomUUID(),
  failed: randomUUID(),
  upgrade: randomUUID(),
} as const

const authorization: PaymentCapabilityAuthorizationPort = {
  assertEmployeeCapability: async () => undefined,
  assertEmployeeOrderAccess: async () => undefined,
  assertRefundRequestLimit: async () => undefined,
  assertRefundApproval: async () => undefined,
}

integration('recommendation financial attribution PostgreSQL integration', () => {
  let pool: Pool
  let service: PaymentCommandService
  let runner: ScopedPostgresTransactionRunner
  let providerObservations: VerifiedProviderObservationService

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    pool = new Pool({ connectionString: databaseUrl, max: 6 })
    runner = new ScopedPostgresTransactionRunner(asPool(pool))
    providerObservations = new VerifiedProviderObservationService(runner)
    service = new PaymentCommandService(
      new NormalizedCommandExecutor(runner),
      authorization,
      new NormalizedProviderObservationAuthority(),
    )
    await seed(pool)
  })

  afterAll(async () => {
    await pool?.end()
  })

  it('records only authoritative paid and item-matched refunded events with strong amounts', async () => {
    const paidPayment = await initiate('paid', 'recommendation-payment-paid')
    const paidCallback = await verifiedCallback(callback(
      paidPayment.value.publicId,
      paidPayment.value.amountMinor,
      'recommendation-payment-paid-callback',
      'recommendation-provider-payment-paid',
    ))
    await service.recordSucceededCallback(paidCallback)
    await service.recordSucceededCallback(paidCallback)
    await service.recordSucceededCallback(await verifiedCallback({
      ...paidCallback,
      idempotencyKey: 'recommendation-payment-paid-provider-replay',
      requestFingerprint: '{"delivery":2,"payment":"paid"}',
    }))

    const pendingPayment = await initiate('pending', 'recommendation-payment-pending')
    await service.recordProviderQueryResult(await verifiedQuery(queryResult(
      pendingPayment.value.publicId,
      pendingPayment.value.amountMinor,
      'recommendation-payment-pending-query',
      'recommendation-provider-payment-pending',
      'unknown',
    )))

    const failedPayment = await initiate('failed', 'recommendation-payment-failed')
    await service.recordProviderQueryResult(await verifiedQuery(queryResult(
      failedPayment.value.publicId,
      failedPayment.value.amountMinor,
      'recommendation-payment-failed-query',
      'recommendation-provider-payment-failed',
      'failed',
    )))

    const upgradePayment = await initiate('upgrade', 'recommendation-payment-upgrade')
    await service.recordSucceededCallback(await verifiedCallback(callback(
      upgradePayment.value.publicId,
      upgradePayment.value.amountMinor,
      'recommendation-payment-upgrade-callback',
      'recommendation-provider-payment-upgrade',
    )))

    const initialEvidence = await financialEvents(pool)
    expect(initialEvidence).toEqual([
      {
        event_type: 'paid',
        order_id: orderIds.paid,
        order_item_id: recommendedItemIds.paid,
        payment_id: paidPayment.value.id,
        refund_id: null,
        attributed_amount_minor: '6000',
        attributed_currency: 'CNY',
      },
    ])

    const unrelatedRefund = await succeedRefund({
      paymentId: paidPayment.value.id,
      paymentProviderTransactionId: paidCallback.providerTransactionId,
      code: 'unrelated',
      orderItemId: otherItemIds.paid,
      amountMinor: 1000,
    })
    const partialRefund = await succeedRefund({
      paymentId: paidPayment.value.id,
      paymentProviderTransactionId: paidCallback.providerTransactionId,
      code: 'recommended-partial',
      orderItemId: recommendedItemIds.paid,
      amountMinor: 1000,
    })
    const fullRecommendedRefund = await succeedRefund({
      paymentId: paidPayment.value.id,
      paymentProviderTransactionId: paidCallback.providerTransactionId,
      code: 'recommended-remainder',
      orderItemId: recommendedItemIds.paid,
      amountMinor: 5000,
    })
    await service.recordProviderRefundResult(await verifiedRefund({
      ...refundResult(
        fullRecommendedRefund.value.publicId,
        fullRecommendedRefund.value.amountMinor,
        paidCallback.providerTransactionId,
        'recommendation-refund-remainder-provider-replay',
        'recommendation-provider-refund-recommended-remainder',
      ),
      requestFingerprint: '{"delivery":2,"refund":"recommended-remainder"}',
    }))

    const finalEvidence = await financialEvents(pool)
    expect(finalEvidence).toEqual([
      {
        event_type: 'paid',
        order_id: orderIds.paid,
        order_item_id: recommendedItemIds.paid,
        payment_id: paidPayment.value.id,
        refund_id: null,
        attributed_amount_minor: '6000',
        attributed_currency: 'CNY',
      },
      {
        event_type: 'refunded',
        order_id: orderIds.paid,
        order_item_id: recommendedItemIds.paid,
        payment_id: paidPayment.value.id,
        refund_id: partialRefund.value.id,
        attributed_amount_minor: '1000',
        attributed_currency: 'CNY',
      },
      {
        event_type: 'refunded',
        order_id: orderIds.paid,
        order_item_id: recommendedItemIds.paid,
        payment_id: paidPayment.value.id,
        refund_id: fullRecommendedRefund.value.id,
        attributed_amount_minor: '5000',
        attributed_currency: 'CNY',
      },
    ])
    expect(finalEvidence.some((event) => event.refund_id === unrelatedRefund.value.id)).toBe(false)

    const crossOrder = await runner.run({ tenantId, storeId }, async (transaction) => (
      new RecommendationFinancialAttributionRepository(transaction).recordPaidForOrder({
        paymentId: upgradePayment.value.id,
        orderId: orderIds.paid,
        actorRef: 'cross-order-test',
      })
    ))
    expect(crossOrder.recorded).toBe(0)
    const crossStore = await runner.run({ tenantId, storeId: otherStoreId }, async (transaction) => (
      new RecommendationFinancialAttributionRepository(transaction).recordPaidForOrder({
        paymentId: paidPayment.value.id,
        orderId: orderIds.paid,
        actorRef: 'cross-store-test',
      })
    ))
    expect(crossStore.recorded).toBe(0)

    await expect(pool.query(`
      INSERT INTO mbox.recommendation_behavior_events (
        tenant_id, store_id, recommendation_session_id, recommendation_option_id,
        customer_id, table_session_id, order_id, order_item_id, payment_id, refund_id,
        attributed_amount_minor, attributed_currency,
        event_type, actor_type, actor_ref, evidence_snapshot
      )
      SELECT event.tenant_id, event.store_id, event.recommendation_session_id,
        event.recommendation_option_id, event.customer_id, event.table_session_id,
        event.order_id, event.order_item_id, event.payment_id, $1::uuid,
        1000, 'CNY', 'refunded', 'system', 'forged-unrelated-refund', '{}'::jsonb
      FROM mbox.recommendation_behavior_events event
      WHERE event.tenant_id=$2::uuid AND event.store_id=$3::uuid
        AND event.order_id=$4::uuid AND event.event_type='paid'
    `, [unrelatedRefund.value.id, tenantId, storeId, orderIds.paid]))
      .rejects.toThrow(/recommendation_behavior_events_refund_item_fk/)
  })

  async function initiate(order: keyof typeof orderIds, publicId: string) {
    return service.initiate({
      ...metadata(`${publicId}-init`, JSON.stringify({ order: orderIds[order] })),
      actor: { type: 'employee', employeeId: requesterId },
      orderId: orderIds[order],
      publicId,
      provider: 'postar',
      method: 'native_qr',
      principal: { type: 'employee', employeeId: requesterId },
    })
  }

  async function succeedRefund(input: Readonly<{
    paymentId: string
    paymentProviderTransactionId: string
    code: string
    orderItemId: string
    amountMinor: number
  }>) {
    const requested = await service.requestRefund({
      ...metadata(`recommendation-refund-${input.code}-request`, JSON.stringify(input)),
      actor: { type: 'employee', employeeId: requesterId },
      paymentId: input.paymentId,
      publicId: `recommendation-refund-${input.code}`,
      reason: `recommendation attribution ${input.code}`,
      allocations: [{ orderItemId: input.orderItemId, amountMinor: input.amountMinor }],
    })
    await service.approveRefund({
      ...metadata(`recommendation-refund-${input.code}-approve`, `{"approve":"${input.code}"}`),
      actor: { type: 'employee', employeeId: approverId },
      refundId: requested.value.id,
      decisionReason: `approved ${input.code}`,
    })
    await service.beginRefundExecution({
      ...metadata(`recommendation-refund-${input.code}-execute`, `{"execute":"${input.code}"}`),
      actor: { type: 'employee', employeeId: approverId },
      refundId: requested.value.id,
    })
    await service.recordProviderRefundResult(await verifiedRefund(refundResult(
      requested.value.publicId,
      requested.value.amountMinor,
      input.paymentProviderTransactionId,
      `recommendation-refund-${input.code}-result`,
      `recommendation-provider-refund-${input.code}`,
    )))
    return requested
  }

  async function verifiedCallback(input: ReturnType<typeof callback>) {
    const verifiedObservationId = await providerObservations.recordPayment({
      scope: input.scope,
      provider: input.provider,
      verificationKind: 'callback_signature',
      providerEventId: `recommendation-callback-${randomUUID()}`,
      integrationRef: input.actor.ref,
      paymentPublicId: input.paymentPublicId,
      providerTransactionId: input.providerTransactionId,
      reportedAmountMinor: input.reportedAmountMinor,
      reportedCurrency: input.reportedCurrency,
      status: 'succeeded',
      settlementChannel: input.settlementChannel,
      occurredAt: input.occurredAt,
      evidence: input.providerSnapshot,
    })
    return { ...input, verifiedObservationId }
  }

  async function verifiedQuery(input: ReturnType<typeof queryResult>) {
    const verifiedObservationId = await providerObservations.recordPayment({
      scope: input.scope,
      provider: input.provider,
      verificationKind: 'active_query_binding',
      providerEventId: `recommendation-query-${randomUUID()}`,
      integrationRef: input.actor.ref,
      paymentPublicId: input.paymentPublicId,
      providerTransactionId: input.providerTransactionId,
      reportedAmountMinor: input.reportedAmountMinor,
      reportedCurrency: input.reportedCurrency,
      status: input.status,
      occurredAt: input.occurredAt,
      evidence: input.providerSnapshot,
    })
    return { ...input, verifiedObservationId }
  }

  async function verifiedRefund(input: ReturnType<typeof refundResult>) {
    const verifiedObservationId = await providerObservations.recordRefund({
      scope: input.scope,
      provider: input.provider,
      verificationKind: 'callback_signature',
      providerEventId: `recommendation-refund-${randomUUID()}`,
      integrationRef: input.actor.ref,
      refundPublicId: input.refundPublicId,
      providerTransactionId: input.providerRefundId,
      originalProviderTransactionId: input.originalProviderTransactionId,
      reportedAmountMinor: input.reportedAmountMinor,
      reportedCurrency: input.reportedCurrency,
      status: input.succeeded ? 'succeeded' : 'failed',
      occurredAt: input.occurredAt,
      evidence: input.providerSnapshot,
    })
    return { ...input, verifiedObservationId }
  }
})

function metadata(idempotencyKey: string, requestFingerprint: string) {
  return {
    scope: { tenantId, storeId },
    actor: { type: 'integration' as const, ref: 'recommendation-financial-test' },
    businessDate: '2026-08-11',
    idempotencyKey,
    requestFingerprint,
  }
}

function callback(
  paymentPublicId: string,
  amountMinor: number,
  idempotencyKey: string,
  providerTransactionId: string,
) {
  return {
    ...metadata(idempotencyKey, JSON.stringify({ paymentPublicId, providerTransactionId, amountMinor })),
    paymentPublicId,
    provider: 'postar' as const,
    providerTransactionId,
    reportedAmountMinor: amountMinor,
    reportedCurrency: 'CNY',
    settlementChannel: 'wechat' as const,
    providerSnapshot: { signatureVerified: true, tradeState: 'SUCCESS' },
    occurredAt: '2026-08-11T12:00:00.000Z',
  }
}

function queryResult(
  paymentPublicId: string,
  amountMinor: number,
  idempotencyKey: string,
  providerTransactionId: string,
  status: 'pending' | 'unknown' | 'failed',
) {
  return {
    ...metadata(idempotencyKey, JSON.stringify({ paymentPublicId, providerTransactionId, amountMinor, status })),
    paymentPublicId,
    provider: 'postar' as const,
    providerTransactionId,
    reportedAmountMinor: amountMinor,
    reportedCurrency: 'CNY',
    status,
    providerSnapshot: {
      signatureVerified: false,
      verificationAlgorithm: 'rsa-request+tls+response-binding',
      providerReportedAmountMinor: amountMinor,
    },
    occurredAt: '2026-08-11T12:01:00.000Z',
  }
}

function refundResult(
  refundPublicId: string,
  amountMinor: number,
  originalProviderTransactionId: string,
  idempotencyKey: string,
  providerRefundId: string,
) {
  return {
    ...metadata(idempotencyKey, JSON.stringify({ refundPublicId, providerRefundId, amountMinor })),
    actor: { type: 'integration' as const, ref: 'recommendation-refund-callback' },
    refundPublicId,
    provider: 'postar' as const,
    providerRefundId,
    originalProviderTransactionId,
    reportedAmountMinor: amountMinor,
    reportedCurrency: 'CNY',
    succeeded: true,
    providerSnapshot: { signatureVerified: true },
    occurredAt: '2026-08-11T13:00:00.000Z',
  }
}

async function financialEvents(pool: Pool) {
  const result = await pool.query<{
    event_type: string
    order_id: string
    order_item_id: string
    payment_id: string
    refund_id: string | null
    attributed_amount_minor: string
    attributed_currency: string
  }>(`
    SELECT event_type, order_id::text, order_item_id::text, payment_id::text,
      refund_id::text, attributed_amount_minor::text, attributed_currency
    FROM mbox.recommendation_behavior_events
    WHERE tenant_id=$1::uuid AND store_id=$2::uuid
      AND event_type IN ('paid','refunded')
    ORDER BY CASE event_type WHEN 'paid' THEN 0 ELSE 1 END,
      attributed_amount_minor, refund_id
  `, [tenantId, storeId])
  return result.rows
}

async function seed(pool: Pool): Promise<void> {
  await pool.query(`
    INSERT INTO mbox.tenants(id, code, name)
    VALUES ($1::uuid, $2, 'Recommendation Financial')
  `, [tenantId, `recommendation_financial_${fixtureSuffix}`])
  await pool.query(`
    INSERT INTO mbox.stores(id, tenant_id, code, name) VALUES
      ($1::uuid, $3::uuid, 'recommendation_store', 'Recommendation Store'),
      ($2::uuid, $3::uuid, 'recommendation_other_store', 'Recommendation Other Store')
  `, [storeId, otherStoreId, tenantId])
  await pool.query(`
    INSERT INTO mbox.employees(id, tenant_id, store_id, employee_code, display_name) VALUES
      ($1::uuid, $3::uuid, $4::uuid, 'REC_REQUESTER', 'Recommendation Requester'),
      ($2::uuid, $3::uuid, $4::uuid, 'REC_APPROVER', 'Recommendation Approver')
  `, [requesterId, approverId, tenantId, storeId])
  await pool.query(`
    INSERT INTO mbox.customers(id, tenant_id, store_id, public_id)
    VALUES ($1::uuid, $2::uuid, $3::uuid, 'recommendation-financial-customer')
  `, [customerId, tenantId, storeId])
  await pool.query(`
    INSERT INTO mbox.areas(id, tenant_id, store_id, code, name, area_type)
    VALUES ($1::uuid, $2::uuid, $3::uuid, 'REC_FIN', 'Recommendation Financial', 'indoor')
  `, [areaId, tenantId, storeId])
  await pool.query(`
    INSERT INTO mbox.products(
      id, tenant_id, store_id, code, name, category_code,
      fulfillment_station, product_kind, cost_amount_minor
    ) VALUES
      ($1::uuid, $3::uuid, $4::uuid, 'REC_PRODUCT', 'Recommended Product', 'test', 'none', 'single', 2000),
      ($2::uuid, $3::uuid, $4::uuid, 'OTHER_PRODUCT', 'Other Product', 'test', 'none', 'single', 1000)
  `, [recommendedProductId, otherProductId, tenantId, storeId])
  await pool.query(`
    INSERT INTO mbox.recommendation_policy_versions(
      id, tenant_id, store_id, public_id, policy_code, version, status,
      created_by_employee_id, draft_reason, explanation_template
    ) VALUES (
      $1::uuid, $2::uuid, $3::uuid, 'recommendation-financial-policy',
      'RECOMMENDATION_FINANCIAL', 1, 'draft',
      $4::uuid, '仅作为资金归因外键测试，不进入运行推荐', '推荐资金归因测试'
    )
  `, [policyId, tenantId, storeId, requesterId])

  const keys = Object.keys(orderIds) as Array<keyof typeof orderIds>
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]!
    const tableId = randomUUID()
    const tableSessionId = randomUUID()
    const recommendationSessionId = randomUUID()
    const recommendationOptionId = randomUUID()
    await pool.query(`
      INSERT INTO mbox.tables(id, tenant_id, store_id, area_id, code, display_name, capacity)
      VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $5, 4)
    `, [tableId, tenantId, storeId, areaId, `RF${index + 1}`])
    await pool.query(`
      INSERT INTO mbox.table_sessions(
        id, tenant_id, store_id, table_id, public_id, business_date, guest_count, status
      ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, '2026-08-11', 2, 'open')
    `, [tableSessionId, tenantId, storeId, tableId, `recommendation-financial-session-${key}`])
    await pool.query(`
      INSERT INTO mbox.table_session_customers(
        tenant_id, store_id, table_session_id, customer_id, relationship
      ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'primary')
    `, [tenantId, storeId, tableSessionId, customerId])
    await pool.query(`
      INSERT INTO mbox.orders(
        id, tenant_id, store_id, table_session_id, public_id, channel,
        settlement_mode, status, payment_status,
        subtotal_amount_minor, discount_amount_minor, total_amount_minor,
        currency, created_by_customer_id
      ) VALUES (
        $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, 'guest_qr',
        'table_tab', 'submitted', 'unpaid', 10000, 0, 10000, 'CNY', $6::uuid
      )
    `, [orderIds[key], tenantId, storeId, tableSessionId, `recommendation-order-${key}`, customerId])
    await pool.query(`
      INSERT INTO mbox.order_items(
        id, tenant_id, store_id, order_id, product_id, quantity,
        unit_price_minor, discount_amount_minor, total_amount_minor,
        currency, fulfillment_station, product_snapshot, status
      ) VALUES
        ($1::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, 1,
          6000, 0, 6000, 'CNY', 'none', '{"name":"Recommended Product"}'::jsonb, 'submitted'),
        ($2::uuid, $3::uuid, $4::uuid, $5::uuid, $7::uuid, 1,
          4000, 0, 4000, 'CNY', 'none', '{"name":"Other Product"}'::jsonb, 'submitted')
    `, [recommendedItemIds[key], otherItemIds[key], tenantId, storeId, orderIds[key], recommendedProductId, otherProductId])
    await pool.query(`
      INSERT INTO mbox.recommendation_sessions(
        id, tenant_id, store_id, public_id, customer_id, table_session_id,
        business_date, source, party_size, occasion, alcohol_preference,
        experience_level, service_intensity, answers_snapshot, recommendation_snapshot
      ) VALUES (
        $1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $6::uuid,
        '2026-08-11', 'miniprogram', 2, 'friends', 'undecided',
        'enhanced', 'balanced', '{}'::jsonb, '[]'::jsonb
      )
    `, [recommendationSessionId, tenantId, storeId, `recommendation-financial-${key}`, customerId, tableSessionId])
    await pool.query(`
      INSERT INTO mbox.recommendation_options(
        id, tenant_id, store_id, recommendation_session_id, policy_version_id,
        product_id, rank, tier, amount_minor, cost_amount_minor, currency,
        total_score, explanation, display_snapshot
      ) VALUES (
        $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
        $6::uuid, 1, 'enhanced', 6000, 2000, 'CNY',
        100, '推荐资金归因测试', '{}'::jsonb
      )
    `, [recommendationOptionId, tenantId, storeId, recommendationSessionId, policyId, recommendedProductId])
    await pool.query(`
      INSERT INTO mbox.recommendation_behavior_events(
        tenant_id, store_id, recommendation_session_id, recommendation_option_id,
        customer_id, table_session_id, order_id, order_item_id,
        event_type, actor_type, actor_ref, evidence_snapshot
      ) VALUES (
        $1::uuid, $2::uuid, $3::uuid, $4::uuid,
        $5::uuid, $6::uuid, $7::uuid, $8::uuid,
        $9, 'guest', $10, '{}'::jsonb
      )
    `, [
      tenantId,
      storeId,
      recommendationSessionId,
      recommendationOptionId,
      customerId,
      tableSessionId,
      key === 'upgrade' ? null : orderIds[key],
      key === 'upgrade' ? null : recommendedItemIds[key],
      key === 'upgrade' ? 'selected' : 'ordered',
      `recommendation-financial-${key}`,
    ])
  }
}

function asPool(pool: Pool): PostgresPool {
  return { connect: async () => pool.connect(), end: async () => pool.end() }
}
