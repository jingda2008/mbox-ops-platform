import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { commercialOpsApiPlugin, type CommercialOpsApiOptions } from './commercial-ops-api.js'
import { createGroupVoucherPlatformRegistry } from './group-voucher-platforms.js'
import { StaffAccessDeniedError, type EffectiveStaffAccess } from './staff-access-repository.js'
import type { ScopedTransaction } from './transaction-runner.js'

const tenantId = randomUUID()
const storeId = randomUUID()
const employeeId = randomUUID()
const scopedEmployeeId = randomUUID()
const outsideEmployeeId = randomUUID()
const costId = randomUUID()
const voucherId = randomUUID()
const apps: FastifyInstance[] = []

afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())))

describe('commercialOpsApiPlugin', () => {
  it('checks live database permission and never returns source, supplier or payroll snapshots', async () => {
    const fixture = buildFixture()
    const response = await fixture.app.inject({
      method: 'POST', url: '/api/commercial-ops/costs',
      headers: { 'idempotency-key': 'commercial-cost-api-0001' },
      payload: {
        category: 'personnel', recognitionState: 'actual', allocationPeriod: 'month',
        serviceStartDate: '2026-08-01', serviceEndDate: '2026-08-31', cashPaidOn: '2026-08-31',
        netAmountMinor: 30_000, taxAmountMinor: 0, currency: 'CNY', sourceType: 'payroll',
        employeeId: scopedEmployeeId,
        sourceSnapshot: { salaryAccount: 'private-account', supplierPhone: '13800000000' },
      },
    })
    expect(response.statusCode).toBe(201)
    expect(fixture.assertPermission).toHaveBeenCalledWith(employeeId, 'commercial.cost.manage')
    expect(JSON.stringify(response.json())).not.toMatch(/salaryAccount|supplierPhone|13800000000|sourceSnapshot/)
    expect(JSON.stringify(fixture.outcomes)).not.toMatch(/salaryAccount|supplierPhone|13800000000/)
  })

  it('hashes the voucher in the idempotency fingerprint and emits only a mask', async () => {
    const fixture = buildFixture()
    const rawCode = 'MT-SECRET-778899'
    const response = await fixture.app.inject({
      method: 'POST', url: '/api/commercial-ops/vouchers/redeem',
      headers: { 'idempotency-key': 'commercial-voucher-api-0001' },
      payload: {
        platform: '美团', campaignName: '双人组合', voucherCode: rawCode,
        faceValueMinor: 20_000, settlementAmountMinor: 18_800, currency: 'CNY',
      },
    })
    expect(response.statusCode).toBe(201)
    expect(JSON.stringify(fixture.commands)).not.toContain(rawCode)
    expect(JSON.stringify(fixture.outcomes)).not.toContain(rawCode)
    expect(response.json()).toMatchObject({ data: { voucherCodeMasked: 'MT********99' } })
  })

  it('prepares then consumes a simulated platform voucher and never returns the raw code', async () => {
    const fixture = buildFixture({ voucherVerification: simulationVerification() })
    const prepared = await fixture.app.inject({
      method: 'POST', url: '/api/commercial-ops/vouchers/prepare',
      payload: { platform: 'meituan', voucherCode: 'MT-OK-778899' },
    })
    expect(prepared.statusCode).toBe(200)
    expect(JSON.stringify(prepared.json())).not.toContain('MT-OK-778899')
    expect(prepared.json()).toMatchObject({
      data: { platform: 'meituan', platformLabel: '美团', campaignName: '美团门店团购券' },
    })
    const handle = prepared.json().data.prepareHandle as string
    expect(handle.length).toBeGreaterThan(16)

    const redeemed = await fixture.app.inject({
      method: 'POST', url: '/api/commercial-ops/vouchers/redeem',
      headers: { 'idempotency-key': 'commercial-voucher-api-0002' },
      payload: { platform: 'meituan', voucherCode: 'MT-OK-778899', prepareHandle: handle },
    })
    expect(redeemed.statusCode).toBe(201)
    expect(JSON.stringify(redeemed.json())).not.toContain('MT-OK-778899')
    expect(redeemed.json()).toMatchObject({
      data: { platform: '美团', platformCode: 'meituan', voucherCodeMasked: 'MT********99' },
    })
    expect(fixture.recordAttempt).toHaveBeenCalled()
  })

  it('rejects already used, missing and mismatched prepare handles before consuming', async () => {
    const fixture = buildFixture({ voucherVerification: simulationVerification() })
    const used = await fixture.app.inject({
      method: 'POST', url: '/api/commercial-ops/vouchers/prepare',
      payload: { platform: 'dianping', voucherCode: 'USED-123456' },
    })
    expect(used.statusCode).toBe(409)
    expect(used.json()).toMatchObject({ error: { code: 'VOUCHER_ALREADY_USED' } })

    const missing = await fixture.app.inject({
      method: 'POST', url: '/api/commercial-ops/vouchers/prepare',
      payload: { platform: 'douyin', voucherCode: 'MISS-000001' },
    })
    expect(missing.statusCode).toBe(400)
    expect(missing.json()).toMatchObject({ error: { code: 'VOUCHER_NOT_FOUND' } })

    const prepared = await fixture.app.inject({
      method: 'POST', url: '/api/commercial-ops/vouchers/prepare',
      payload: { platform: 'kuaishou', voucherCode: 'KS-OK-123456' },
    })
    const mismatched = await fixture.app.inject({
      method: 'POST', url: '/api/commercial-ops/vouchers/redeem',
      headers: { 'idempotency-key': 'commercial-voucher-api-0003' },
      payload: {
        platform: 'kuaishou', voucherCode: 'OTHER-CODE-99',
        prepareHandle: prepared.json().data.prepareHandle,
      },
    })
    expect(mismatched.statusCode).toBe(400)
    expect(mismatched.json().error.message).toMatch(/券码与查询结果不一致/)
  })

  it('lists only the four platforms and refuses prepare when verification is not wired', async () => {
    const listed = await buildFixture({ voucherVerification: simulationVerification() }).app.inject({
      method: 'GET', url: '/api/commercial-ops/vouchers/platforms',
    })
    expect(listed.json().data).toEqual([
      expect.objectContaining({ code: 'dianping', label: '大众点评', enabled: true, mode: 'test' }),
      expect.objectContaining({ code: 'meituan', label: '美团', enabled: true, mode: 'test' }),
      expect.objectContaining({ code: 'douyin', label: '抖音', enabled: true, mode: 'test' }),
      expect.objectContaining({ code: 'kuaishou', label: '快手', enabled: true, mode: 'test' }),
    ])
    const disabled = await buildFixture().app.inject({
      method: 'POST', url: '/api/commercial-ops/vouchers/prepare',
      payload: { platform: 'meituan', voucherCode: 'MT-OK-778899' },
    })
    expect(disabled.statusCode).toBe(503)
    expect(disabled.json()).toMatchObject({ error: { code: 'VOUCHER_UNAVAILABLE' } })
  })

  it('limits employee statistics to live own/data-scope access and removes internal employee ids', async () => {
    const fixture = buildFixture({
      access: effectiveAccess({
        permissions: ['commercial.sales.view'],
        dataScopes: [{ key: 'commercial.employee_ids', effect: 'include', value: [scopedEmployeeId] }],
      }),
    })
    const response = await fixture.app.inject({
      method: 'GET',
      url: `/api/commercial-ops/employee-sales?startDate=2026-08-01&endDate=2026-08-31&employeeId=${scopedEmployeeId}`,
    })
    expect(response.statusCode).toBe(200)
    expect(fixture.listEmployeeSales).toHaveBeenCalledWith({ tenantId, storeId }, expect.objectContaining({
      employeeIds: [scopedEmployeeId],
    }))
    expect(JSON.stringify(response.json())).not.toContain(scopedEmployeeId)

    const denied = await fixture.app.inject({
      method: 'GET',
      url: `/api/commercial-ops/employee-sales?startDate=2026-08-01&endDate=2026-08-31&employeeId=${outsideEmployeeId}`,
    })
    expect(denied.statusCode).toBe(403)
  })

  it('rejects a mutation when current database permission is denied even if token capabilities claim it', async () => {
    const fixture = buildFixture({ denyPermission: true })
    const response = await fixture.app.inject({
      method: 'POST', url: '/api/commercial-ops/costs',
      headers: { 'idempotency-key': 'commercial-cost-denied-0001' },
      payload: {
        category: 'rent', recognitionState: 'known', allocationPeriod: 'month',
        serviceStartDate: '2026-08-01', serviceEndDate: '2026-08-31',
        netAmountMinor: 30_000, currency: 'CNY', sourceType: 'lease',
      },
    })
    expect(response.statusCode).toBe(403)
    expect(fixture.createCost).not.toHaveBeenCalled()
  })
})

function buildFixture(overrides: {
  access?: EffectiveStaffAccess
  denyPermission?: boolean
  voucherVerification?: CommercialOpsApiOptions['voucherVerification']
} = {}) {
  const transaction = {
    scope: { tenantId, storeId },
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  } as unknown as ScopedTransaction
  const commands: unknown[] = []
  const outcomes: unknown[] = []
  const transactions = {
    run: vi.fn(async (_scope, operation) => operation(transaction)),
  } as CommercialOpsApiOptions['transactions']
  const commandExecutor = {
    execute: vi.fn(async (command, handler) => {
      commands.push(command)
      const outcome = await handler(transaction)
      outcomes.push(outcome)
      return { value: outcome.result, replayed: false }
    }),
  } as CommercialOpsApiOptions['commandExecutor']
  const assertPermission = vi.fn(async () => {
    if (overrides.denyPermission) throw new StaffAccessDeniedError('denied')
    return overrides.access ?? effectiveAccess()
  })
  const resolve = vi.fn(async () => overrides.access ?? effectiveAccess())
  const createCost = vi.fn(async () => ({
    id: costId, publicId: 'cost-api-public-0001', category: 'personnel',
    recognitionState: 'actual', allocationPeriod: 'month',
    serviceStartDate: '2026-08-01', serviceEndDate: '2026-08-31', cashPaidOn: '2026-08-31',
    netAmountMinor: 30_000, taxAmountMinor: 0, grossAmountMinor: 30_000, currency: 'CNY',
    sourceType: 'payroll', purchaseReceiptLineId: null, employeeId: scopedEmployeeId,
    scheduleId: null, sourceReference: null,
    sourceSnapshot: { salaryAccount: 'private-account', supplierPhone: '13800000000' },
    correctsCostEntryId: null, correctionReason: null, recordedBusinessDate: '2026-08-11',
    recordedByEmployeeId: employeeId, recordedAt: '2026-08-11T12:00:00.000Z',
  } as const))
  const redeemVoucher = vi.fn(async (input: { platform: string; platformCode?: string | null }) => ({
    id: voucherId, publicId: 'voucher-api-public-0001', platform: input.platform,
    platformCode: input.platformCode ?? null, campaignName: '双人组合',
    voucherCodeMasked: 'MT********99', faceValueMinor: 20_000, settlementAmountMinor: 18_800,
    currency: 'CNY', orderId: null, tableSessionId: null, reconciliationEntryId: null,
    providerCertificateId: null, providerVerifyId: 'sim-verify', providerStatus: 'consumed',
    redeemedByEmployeeId: employeeId, redeemedBusinessDate: '2026-08-11',
    redeemedAt: '2026-08-11T12:00:00.000Z',
  }))
  const recordVoucherVerificationAttempt = vi.fn(async () => undefined)
  const listEmployeeSales = vi.fn(async () => [{
    employeeId: scopedEmployeeId, employeeCode: 'TOM', employeeDisplayName: 'Tom',
    productId: randomUUID(), productCode: 'BEER', productName: '啤酒', categoryCode: 'beer',
    quantity: '2.000000', salesAmountMinor: 13_600, costAmountMinor: 4_000,
    contributionProfitMinor: 9_600, refundReversalAmountMinor: 0,
    costCoverageComplete: true, currency: 'CNY',
  }])
  const queryService = {
    getProfitReport: vi.fn(), listEmployeeSales,
    listCosts: vi.fn(async () => []), listVouchers: vi.fn(async () => []),
  } as unknown as CommercialOpsApiOptions['queryService']
  const app = Fastify()
  apps.push(app)
  app.register(commercialOpsApiPlugin, {
    prefix: '/api', transactions, commandExecutor, queryService,
    resolveContext: () => ({
      scope: { tenantId, storeId }, employeeId, businessDate: '2026-08-11',
      capabilities: ['commercial.cost.manage', 'commercial.sales.view_all'],
    }),
    createStaffAccessRepository: () => ({ assertPermission, resolve } as never),
    createRepository: () => ({
      createCost, correctCost: vi.fn(), createSalesRule: vi.fn(),
      recordSaleAttribution: vi.fn(), reverseSalesForRefund: vi.fn(), redeemVoucher,
      recordVoucherVerificationAttempt,
    } as never),
    createPublicId: (kind) => `${kind}-api-generated-0001`,
    voucherVerification: overrides.voucherVerification,
  })
  return { app, commands, outcomes, assertPermission, createCost, listEmployeeSales, recordAttempt: recordVoucherVerificationAttempt }
}

function simulationVerification(): NonNullable<CommercialOpsApiOptions['voucherVerification']> {
  return {
    registry: createGroupVoucherPlatformRegistry({
      mode: 'test', timeoutMs: 8_000,
      platforms: { dianping: null, meituan: null, douyin: null, kuaishou: null },
    }, { now: () => Date.parse('2026-09-20T04:00:00.000Z') }),
    signingSecret: '0123456789abcdef0123456789abcdef',
    now: () => Date.parse('2026-09-20T04:00:00.000Z'),
  }
}

function effectiveAccess(overrides: Partial<EffectiveStaffAccess> = {}): EffectiveStaffAccess {
  return {
    employeeId, employeeCode: 'MANAGER', displayName: 'Manager', roleCodes: ['MANAGER'],
    roleNames: ['Manager'], permissions: [
      'commercial.cost.manage', 'commercial.cost.view', 'commercial.profit.view',
      'commercial.sales.view_all', 'commercial.voucher.redeem', 'commercial.voucher.view',
    ],
    deniedPermissions: [], dataScopes: [], approvalLimits: [], navigation: [],
    resolvedAt: '2026-08-11T12:00:00.000Z', ...overrides,
  }
}
