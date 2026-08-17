import { describe, expect, it } from 'vitest'
import {
  NormalizedPaymentCapabilityAuthorization,
  paymentBusinessEventKey,
  sanitizeClientPaymentHints,
  sanitizeClientRefundEvidence,
  sanitizeProviderSnapshot,
} from './payment-security-policy.js'
import type { ScopedTransaction } from './transaction-runner.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const storeId = '22222222-2222-4222-8222-222222222222'
const employeeId = '33333333-3333-4333-8333-333333333333'
const refundId = '44444444-4444-4444-8444-444444444444'

describe('NormalizedPaymentCapabilityAuthorization', () => {
  it('requires an active employee with the exact capability', async () => {
    const policy = new NormalizedPaymentCapabilityAuthorization()
    await expect(policy.assertEmployeeCapability({
      transaction: transaction([{ employee_status: 'departed', allowed: true }]),
      employeeId,
      capability: 'payment.manual.cash.record',
    })).rejects.toThrow('not active')
    await expect(policy.assertEmployeeCapability({
      transaction: transaction([{ employee_status: 'active', allowed: false }]),
      employeeId,
      capability: 'payment.manual.pos.record',
    })).rejects.toThrow('lacks financial capability')
    await expect(policy.assertEmployeeCapability({
      transaction: transaction([{ employee_status: 'active', allowed: true }]),
      employeeId,
      capability: 'refund.execute',
    })).resolves.toBeUndefined()
  })

  it('enforces refund approval separation and configured currency limit', async () => {
    const policy = new NormalizedPaymentCapabilityAuthorization()
    const approval = (overrides: Record<string, unknown> = {}) => ({
      employee_status: 'active',
      allowed: true,
      requested_by_employee_id: '55555555-5555-4555-8555-555555555555',
      amount_minor: '5000',
      currency: 'CNY',
      approval_limit_minor: '5000',
      ...overrides,
    })

    await expect(policy.assertRefundApproval({
      transaction: transaction([approval({ requested_by_employee_id: employeeId })]),
      employeeId,
      refundId,
    })).rejects.toThrow('cannot approve or reject')
    await expect(policy.assertRefundApproval({
      transaction: transaction([approval({ amount_minor: '5001' })]),
      employeeId,
      refundId,
    })).rejects.toThrow('exceeds employee approval limit')
    await expect(policy.assertRefundApproval({
      transaction: transaction([approval({ approval_limit_minor: null })]),
      employeeId,
      refundId,
    })).rejects.toThrow('limit is not configured')
    await expect(policy.assertRefundApproval({
      transaction: transaction([approval()]),
      employeeId,
      refundId,
    })).resolves.toBeUndefined()
  })

  it('requires a configurable request limit for the acting refund requester', async () => {
    const policy = new NormalizedPaymentCapabilityAuthorization()
    const request = (overrides: Record<string, unknown> = {}) => ({
      employee_status: 'active',
      allowed: true,
      requested_by_employee_id: employeeId,
      amount_minor: '5000',
      currency: 'CNY',
      approval_limit_minor: '5000',
      ...overrides,
    })

    await expect(policy.assertRefundRequestLimit({
      transaction: transaction([request({ requested_by_employee_id: '55555555-5555-4555-8555-555555555555' })]),
      employeeId,
      refundId,
    })).rejects.toThrow('identity does not match')
    await expect(policy.assertRefundRequestLimit({
      transaction: transaction([request({ approval_limit_minor: null })]),
      employeeId,
      refundId,
    })).rejects.toThrow('request limit is not configured')
    await expect(policy.assertRefundRequestLimit({
      transaction: transaction([request({ amount_minor: '5001' })]),
      employeeId,
      refundId,
    })).rejects.toThrow('exceeds employee request limit')
    await expect(policy.assertRefundRequestLimit({
      transaction: transaction([request()]),
      employeeId,
      refundId,
    })).resolves.toBeUndefined()
  })

  it('uses a strict evidence allowlist and stable opaque business event keys', () => {
    const sanitized = sanitizeProviderSnapshot({
      signatureVerified: true,
      tradeState: 'SUCCESS',
      signature: 'do-not-copy',
      token: 'do-not-copy',
      header: 'do-not-copy',
      openid: 'do-not-copy',
      payer: { phone: '13800000000' },
    })
    expect(sanitized).toEqual({ tradeState: 'SUCCESS' })
    const first = paymentBusinessEventKey('succeeded', 'postar', 'provider-transaction-001')
    const second = paymentBusinessEventKey('succeeded', 'postar', 'provider-transaction-001')
    expect(first).toBe(second)
    expect(first).not.toContain('provider-transaction-001')
  })

  it('never promotes client payment hints into trusted provider evidence', () => {
    expect(sanitizeClientPaymentHints({
      channel: 'QR',
      signatureVerified: true,
      providerStatus: 'SUCCESS',
      eventId: 'forged-event',
      merchantId: 'forged-merchant',
    })).toEqual({ channel: 'QR' })
    expect(sanitizeClientRefundEvidence({
      reasonCode: 'NOT_PRODUCED',
      signatureVerified: true,
      providerStatus: 'SUCCESS',
      receiptReference: 'forged-receipt',
    })).toEqual({ reasonCode: 'NOT_PRODUCED' })
  })
})

function transaction(rows: Record<string, unknown>[]): ScopedTransaction {
  return {
    scope: { tenantId, storeId },
    query: async <Row extends Record<string, unknown>>() => ({
      rows: rows as Row[],
      rowCount: rows.length,
    }),
  }
}
