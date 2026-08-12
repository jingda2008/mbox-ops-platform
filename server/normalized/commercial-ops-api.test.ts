import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { commercialOpsApiPlugin, type CommercialOpsApiOptions } from './commercial-ops-api.js'
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
  const redeemVoucher = vi.fn(async () => ({
    id: voucherId, publicId: 'voucher-api-public-0001', platform: '美团', campaignName: '双人组合',
    voucherCodeMasked: 'MT********99', faceValueMinor: 20_000, settlementAmountMinor: 18_800,
    currency: 'CNY', orderId: null, tableSessionId: null, reconciliationEntryId: null,
    redeemedByEmployeeId: employeeId, redeemedBusinessDate: '2026-08-11',
    redeemedAt: '2026-08-11T12:00:00.000Z',
  } as const))
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
    } as never),
    createPublicId: (kind) => `${kind}-api-generated-0001`,
  })
  return { app, commands, outcomes, assertPermission, createCost, listEmployeeSales }
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
