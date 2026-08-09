import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { registerAuthContext } from './auth-context.js'
import { AuthorizationError } from './authorization.js'
import { registerCommercialOpsRoutes } from './commercial-ops-api.js'
import { JsonRepository } from './repository.js'

function headers(actorId: string) {
  return { 'x-mbox-actor-id': actorId, 'x-mbox-store-id': 'mbox-lujiazui' }
}

async function fixture() {
  const repository = new JsonRepository(`/tmp/mbox-commercial-ops-${crypto.randomUUID()}.json`)
  await repository.init()
  const app = Fastify()
  await registerAuthContext(app, { runtimeMode: 'test', readState: () => repository.read() })
  registerCommercialOpsRoutes(app, repository)
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AuthorizationError) {
      return reply.status(error.statusCode).send({ code: error.code, message: error.message, operation: error.operation })
    }
    return reply.status(400).send({ message: error.message })
  })
  return { app, repository }
}

describe('commercial operations API', () => {
  it('binds a goods code and records the actual procurement batch cost once', async () => {
    const { app, repository } = await fixture()
    const occurredAt = '2020-01-01T00:00:00.000Z'
    const binding = await app.inject({
      method: 'POST', url: '/api/commercial-ops/scan-bindings', headers: headers('emp-chen'),
      payload: {
        code: '6901234567890', symbology: 'ean13', targetType: 'product', targetId: 'product-beer',
        countMode: 'integer', enabled: true, reason: '绑定精酿商品条码', occurredAt,
        idempotencyKey: 'commercial-binding-beer-001',
      },
    })
    expect(binding.statusCode, binding.body).toBe(201)

    const payload = {
      targetType: 'product', targetId: 'product-beer', scanCode: '6901234567890', supplierName: '测试酒水供应商',
      supplierReference: 'PO-20260719-01', quantity: 24, unitCode: 'bottle', unitCostAmount: 1650,
      reason: '晚市营业前采购入库', occurredAt, idempotencyKey: 'commercial-procurement-beer-001',
    }
    const first = await app.inject({ method: 'POST', url: '/api/commercial-ops/procurement-batches', headers: headers('emp-chen'), payload })
    const replay = await app.inject({ method: 'POST', url: '/api/commercial-ops/procurement-batches', headers: headers('emp-chen'), payload })

    expect(first.statusCode, first.body).toBe(201)
    expect(first.json()).toMatchObject({ quantity: 24, unitCostAmount: 1650, totalCostAmount: 39_600 })
    expect(first.json().receivedAt).not.toBe(occurredAt)
    expect(Math.abs(Date.parse(first.json().receivedAt) - Date.now())).toBeLessThan(5_000)
    expect(replay.json().id).toBe(first.json().id)
    const state = await repository.read()
    expect(state.commercialOps?.procurementBatches).toHaveLength(1)
    expect(state.inventoryDomain?.movements.filter((item) => item.productId === 'product-beer')).toHaveLength(1)
    expect(state.inventoryDomain?.movements.find((item) => item.productId === 'product-beer')?.occurredAt).not.toBe(occurredAt)
    expect(state.products.find((product) => product.id === 'product-beer')?.costAmount).toBe(1650)
    expect(state.auditEntries.some((entry) => entry.action === 'product.weighted_cost_updated.v1')).toBe(true)
    await app.close()
    await repository.close()
  })

  it('prevents the same group-buy voucher from being redeemed twice', async () => {
    const { app, repository } = await fixture()
    const occurredAt = new Date().toISOString()
    const payload = {
      platform: '美团', campaignName: '双人畅饮套餐', voucherCode: 'MT-8899001122',
      faceValueAmount: 29_800, settlementAmount: 24_500, reason: '顾客现场出示团购券', occurredAt,
      idempotencyKey: 'commercial-voucher-first-001',
    }
    const first = await app.inject({ method: 'POST', url: '/api/commercial-ops/vouchers/redeem', headers: headers('emp-cashier'), payload })
    const duplicate = await app.inject({
      method: 'POST', url: '/api/commercial-ops/vouchers/redeem', headers: headers('emp-cashier'),
      payload: { ...payload, idempotencyKey: 'commercial-voucher-second-001' },
    })

    expect(first.statusCode, first.body).toBe(201)
    expect(first.json().voucherCodeMasked).not.toContain('8899001122')
    expect(duplicate.statusCode).toBe(400)
    expect(duplicate.json().message).toContain('已于')
    expect((await repository.read()).commercialOps?.voucherRedemptions).toHaveLength(1)
    await app.close()
    await repository.close()
  })

  it('lets an authorized operator inspect failed work and requeue it without inflating attempts', async () => {
    const { app, repository } = await fixture()
    const occurredAt = new Date().toISOString()
    await repository.mutate((state) => {
      const tableSessionId = state.songState.tableSessions[0]!.id
      state.orderDomain.orders.push({
        id: 'order-print-retry-001', tableSessionId, status: 'submitted', items: [],
        amounts: { grossAmount: 0, discountAmount: 0, giftAmount: 0, payableAmount: 0 }, revision: 1,
        createdBy: 'emp-chen', createdAt: occurredAt, submittedBy: 'emp-chen', submittedAt: occurredAt, fulfilledAt: null,
      })
      state.commercialOps!.printJobs.push({
        id: 'print-job-retry-001', orderId: 'order-print-retry-001', orderItemIds: ['item-print-retry-001'],
        printerId: 'printer-bar', routeId: 'route-bar', status: 'failed', attempts: 1,
        queuedAt: occurredAt, updatedAt: occurredAt, lastError: '打印机离线',
      })
      state.revision += 1
    })

    const unauthorized = await app.inject({
      method: 'POST', url: '/api/commercial-ops/print-jobs/print-job-retry-001/result', headers: headers('emp-cashier'),
      payload: { status: 'queued', error: '尝试越权重打', occurredAt, idempotencyKey: 'print-retry-unauthorized-001' },
    })
    expect(unauthorized.statusCode).toBe(403)

    const payload = {
      status: 'queued', error: '故障排除后重新排队', occurredAt,
      idempotencyKey: 'print-retry-authorized-001',
    }
    const first = await app.inject({
      method: 'POST', url: '/api/commercial-ops/print-jobs/print-job-retry-001/result', headers: headers('emp-chen'), payload,
    })
    const replay = await app.inject({
      method: 'POST', url: '/api/commercial-ops/print-jobs/print-job-retry-001/result', headers: headers('emp-chen'), payload,
    })

    expect(first.statusCode, first.body).toBe(200)
    expect(first.json()).toMatchObject({ status: 'queued', attempts: 1, lastError: null })
    expect(replay.json()).toMatchObject({ status: 'queued', attempts: 1, lastError: null })
    const state = await repository.read()
    expect(state.commercialOps?.auditEvents.at(-1)).toMatchObject({
      action: 'commercial.print_job.queued.v1', objectId: 'print-job-retry-001',
      details: { previousStatus: 'failed', status: 'queued', attempts: 1 },
    })
    await app.close()
    await repository.close()
  })

  it('separates finance viewing from cost management and recalculates a replaced estimate', async () => {
    const { app, repository } = await fixture()
    const occurredAt = '2026-08-10T10:00:00+08:00'
    const estimatePayload = {
      name: '7月房租预估',
      categoryId: 'rent',
      amount: 30_000,
      status: 'estimated',
      recognitionMode: 'spread_daily',
      recognitionStartDate: '2026-07-01',
      recognitionEndDate: '2026-07-31',
      counterparty: '场地方',
      reference: '',
      note: '营业前预估',
      reason: '建立7月经营预测',
      occurredAt,
      idempotencyKey: 'cost-estimate-rent-202607',
    }
    const cashierWrite = await app.inject({
      method: 'POST',
      url: '/api/commercial-ops/cost-entries',
      headers: headers('emp-cashier'),
      payload: estimatePayload,
    })
    expect(cashierWrite.statusCode).toBe(403)

    const estimate = await app.inject({
      method: 'POST',
      url: '/api/commercial-ops/cost-entries',
      headers: headers('emp-chen'),
      payload: estimatePayload,
    })
    expect(estimate.statusCode, estimate.body).toBe(201)
    const actual = await app.inject({
      method: 'POST',
      url: '/api/commercial-ops/cost-entries',
      headers: headers('emp-chen'),
      payload: {
        ...estimatePayload,
        name: '7月房租实际账单',
        amount: 36_000,
        status: 'actual',
        replacesEntryId: estimate.json().id,
        reference: 'RENT-202607',
        reason: '收到实际账单后替代预估',
        idempotencyKey: 'cost-actual-rent-202607',
      },
    })
    expect(actual.statusCode, actual.body).toBe(201)

    const cashierView = await app.inject({
      method: 'GET',
      url: '/api/commercial-ops/profit-center?period=month&anchor=2026-07-15',
      headers: headers('emp-cashier'),
    })
    expect(cashierView.statusCode, cashierView.body).toBe(200)
    expect(cashierView.json().report.costs).toMatchObject({
      actualOperatingExpenseAmount: 36_000,
      estimatedOperatingExpenseAmount: 0,
    })
    expect(cashierView.json().costEntries).toHaveLength(2)

    const nonFinanceWorkspace = await app.inject({
      method: 'GET',
      url: '/api/commercial-ops',
      headers: headers('emp-qing'),
    })
    expect(nonFinanceWorkspace.statusCode, nonFinanceWorkspace.body).toBe(200)
    expect(nonFinanceWorkspace.json().state.costEntries).toEqual([])
    await app.close()
    await repository.close()
  })

  it('creates auditable recurring cost templates and prevents duplicate actual periods', async () => {
    const { app, repository } = await fixture()
    const template = await app.inject({
      method: 'POST',
      url: '/api/commercial-ops/cost-templates',
      headers: headers('emp-chen'),
      payload: {
        name: '驻场乐队月费',
        categoryId: 'band',
        amount: 80_000,
        frequency: 'monthly',
        recognitionMode: 'spread_daily',
        startDate: '2026-07-01',
        endDate: null,
        counterparty: '驻场乐队',
        note: '',
        enabled: true,
        reason: '建立驻场合同成本',
        occurredAt: '2026-07-01T10:00:00+08:00',
        idempotencyKey: 'cost-template-band-monthly',
      },
    })
    expect(template.statusCode, template.body).toBe(201)
    const actualPayload = {
      name: '7月驻场乐队结算',
      categoryId: 'band',
      amount: 82_000,
      status: 'actual',
      recognitionMode: 'spread_daily',
      recognitionStartDate: '2026-07-01',
      recognitionEndDate: '2026-07-31',
      counterparty: '驻场乐队',
      reference: 'BAND-202607',
      note: '',
      sourceTemplateId: template.json().id,
      sourceOccurrenceDate: '2026-07-01',
      reason: '确认7月驻场费用',
      occurredAt: '2026-08-01T10:00:00+08:00',
      idempotencyKey: 'cost-band-actual-202607',
    }
    const actual = await app.inject({
      method: 'POST', url: '/api/commercial-ops/cost-entries', headers: headers('emp-chen'), payload: actualPayload,
    })
    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/commercial-ops/cost-entries',
      headers: headers('emp-chen'),
      payload: { ...actualPayload, idempotencyKey: 'cost-band-actual-202607-duplicate' },
    })
    const invalidOccurrence = await app.inject({
      method: 'POST',
      url: '/api/commercial-ops/cost-entries',
      headers: headers('emp-chen'),
      payload: {
        ...actualPayload,
        sourceOccurrenceDate: '2026-07-02',
        recognitionStartDate: '2026-07-02',
        recognitionEndDate: '2026-08-01',
        idempotencyKey: 'cost-band-invalid-occurrence',
      },
    })
    expect(actual.statusCode, actual.body).toBe(201)
    expect(duplicate.statusCode).toBe(400)
    expect(duplicate.json().message).toContain('已经录入实际账单')
    expect(invalidOccurrence.statusCode).toBe(400)
    expect(invalidOccurrence.json().message).toContain('不是这个周期费用的有效账期')
    const report = await app.inject({
      method: 'GET',
      url: '/api/commercial-ops/profit-center?period=month&anchor=2026-07-15',
      headers: headers('emp-chen'),
    })
    expect(report.json().report.categoryRows.find((row: { categoryId: string }) => row.categoryId === 'band')).toMatchObject({
      actualAmount: 82_000,
      estimatedAmount: 0,
    })
    expect((await repository.read()).commercialOps?.auditEvents.some((event) => (
      event.action === 'commercial.cost_template.created.v1'
    ))).toBe(true)
    await app.close()
    await repository.close()
  })
})
