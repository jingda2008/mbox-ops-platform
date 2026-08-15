import { describe, expect, it } from 'vitest'
import type { PostgresQueryResult, ScopedTransaction } from './transaction-runner.js'
import {
  StoreCommercePolicyConflictError,
  StoreCommercePolicyRepository,
} from './store-commerce-policy.js'

const employeeId = '33333333-3333-4333-8333-333333333333'

describe('StoreCommercePolicyRepository', () => {
  it('fails closed until a manager explicitly enables a configured provider', async () => {
    const fixture = transactionFixture()
    const repository = new StoreCommercePolicyRepository(fixture.transaction)

    await expect(repository.get(true, 'postar')).resolves.toMatchObject({
      configured: false,
      policyOnlinePaymentEnabled: false,
      onlinePaymentEnabled: false,
      providerConfigured: true,
      paymentReservationMinutes: 10,
      policyVersion: 0,
    })

    await expect(repository.set({
      enabled: false,
      expectedVersion: 0,
      employeeId,
      reason: '渠道维护期间关闭线上支付',
      providerConfigured: true,
      provider: 'postar',
      paymentReservationMinutes: 8,
    })).resolves.toMatchObject({
      configured: true,
      onlinePaymentEnabled: false,
      policyVersion: 1,
      reason: '渠道维护期间关闭线上支付',
      paymentReservationMinutes: 8,
    })
  })

  it('rejects stale manager writes and cannot open payment without a provider', async () => {
    const fixture = transactionFixture({
      online_payment_enabled: false,
      payment_reservation_minutes: 10,
      policy_version: 2,
      reason: '渠道维护',
      updated_by_employee_id: employeeId,
      updated_at: '2026-08-15T08:00:00.000Z',
    })
    const repository = new StoreCommercePolicyRepository(fixture.transaction)

    await expect(repository.set({
      enabled: true,
      expectedVersion: 1,
      employeeId,
      reason: '恢复线上支付',
      providerConfigured: true,
      provider: 'postar',
    })).rejects.toBeInstanceOf(StoreCommercePolicyConflictError)

    await expect(repository.set({
      enabled: true,
      expectedVersion: 2,
      employeeId,
      reason: '恢复线上支付',
      providerConfigured: false,
      provider: null,
    })).rejects.toThrow('支付渠道尚未配置完成')
  })

  it('still lets a manager close an open policy while the provider is unavailable', async () => {
    const fixture = transactionFixture({
      online_payment_enabled: true,
      payment_reservation_minutes: 10,
      policy_version: 3,
      reason: '营业时段开放线上支付',
      updated_by_employee_id: employeeId,
      updated_at: '2026-08-15T08:00:00.000Z',
    })
    const repository = new StoreCommercePolicyRepository(fixture.transaction)

    await expect(repository.set({
      enabled: false,
      expectedVersion: 3,
      employeeId,
      reason: '渠道异常，防止恢复后自动开放',
      providerConfigured: false,
      provider: null,
    })).resolves.toMatchObject({
      configured: true,
      policyOnlinePaymentEnabled: false,
      onlinePaymentEnabled: false,
      providerConfigured: false,
      policyVersion: 4,
    })
  })
})

interface MutablePolicyRow extends Record<string, unknown> {
  online_payment_enabled: boolean
  payment_reservation_minutes: number
  policy_version: number
  reason: string
  updated_by_employee_id: string
  updated_at: string
}

function transactionFixture(initial?: MutablePolicyRow) {
  let row = initial
  const transaction = {
    scope: {
      tenantId: '11111111-1111-4111-8111-111111111111',
      storeId: '22222222-2222-4222-8222-222222222222',
    },
    query: async <ResultRow extends Record<string, unknown>>(text: string, values: readonly unknown[] = []): Promise<PostgresQueryResult<ResultRow>> => {
      const sql = text.replace(/\s+/g, ' ').trim()
      if (sql.startsWith('SELECT online_payment_enabled')) {
        return { rows: row === undefined ? [] : [row as ResultRow], rowCount: row === undefined ? 0 : 1 }
      }
      if (sql.startsWith('INSERT INTO mbox.store_commerce_policies')) {
        row = {
          online_payment_enabled: Boolean(values[0]),
          payment_reservation_minutes: values[3] === null || values[3] === undefined
            ? row?.payment_reservation_minutes ?? 10
            : Number(values[3]),
          policy_version: row === undefined ? 1 : row.policy_version + 1,
          reason: String(values[1]),
          updated_by_employee_id: String(values[2]),
          updated_at: '2026-08-15T09:00:00.000Z',
        }
        return { rows: [], rowCount: 1 }
      }
      throw new Error(`Unexpected query: ${sql}`)
    },
  } as ScopedTransaction
  return { transaction }
}
