import { describe, expect, it } from 'vitest'
import {
  CustomerExperienceRepository,
  CustomerExperienceRequestError,
  resolveActivityRegistrationPayment,
  type ActivityPaymentMode,
} from './customer-experience-repository.js'
import { validateActivityPaymentConfiguration } from './customer-experience-service.js'
import type { ScopedTransaction } from './transaction-runner.js'

const scope = {
  tenantId: '82000000-0000-4000-8000-000000000001',
  storeId: '82000000-0000-4000-8000-000000000002',
}
const customerId = '82000000-0000-4000-8000-000000000003'

describe('activity payment configuration', () => {
  it('supports an organizer choosing no prepayment', () => {
    expect(resolveActivityRegistrationPayment('none', 'none', {
      totalFeeAmountMinor: 22_800,
      depositAmountMinor: 0,
    })).toEqual({ choice: 'none', amountDueMinor: 0 })
    expect(() => validateActivityPaymentConfiguration({
      feeAmountMinor: 22_800,
      depositAmountMinor: 0,
      paymentMode: 'none',
    })).not.toThrow()
  })

  it('supports required deposit, optional deposit and full prepayment without silently changing the rule', () => {
    expect(resolveActivityRegistrationPayment('deposit_required', 'deposit', {
      totalFeeAmountMinor: 30_000,
      depositAmountMinor: 6_000,
    })).toEqual({ choice: 'deposit', amountDueMinor: 6_000 })
    expect(resolveActivityRegistrationPayment('deposit_optional', 'none', {
      totalFeeAmountMinor: 30_000,
      depositAmountMinor: 6_000,
    })).toEqual({ choice: 'none', amountDueMinor: 0 })
    expect(resolveActivityRegistrationPayment('full_required', 'full', {
      totalFeeAmountMinor: 30_000,
      depositAmountMinor: 0,
    })).toEqual({ choice: 'full', amountDueMinor: 30_000 })
  })

  it('rejects a customer bypassing a required deposit and invalid organizer configurations', () => {
    expect(() => resolveActivityRegistrationPayment('deposit_required', 'none', {
      totalFeeAmountMinor: 30_000,
      depositAmountMinor: 6_000,
    })).toThrowError(CustomerExperienceRequestError)
    expect(() => validateActivityPaymentConfiguration({
      feeAmountMinor: 20_000,
      depositAmountMinor: 5_000,
      paymentMode: 'none',
    })).toThrow('无需预付的活动，订金必须为0')
    expect(() => validateActivityPaymentConfiguration({
      feeAmountMinor: 20_000,
      depositAmountMinor: 25_000,
      paymentMode: 'deposit_required',
    })).toThrow('活动订金不能高于活动总费用')
  })

  it('calculates a required deposit per person and creates a temporary payment hold', async () => {
    const transaction = activityTransaction('deposit_required', 'per_person')
    const result = await new CustomerExperienceRepository(transaction).registerActivity({
      activityPublicId: 'community-activity-test-0001',
      customerId,
      partySize: 3,
      contactSnapshot: { channel: 'miniprogram' },
      safetyAcknowledgement: { acknowledged: true },
      paymentChoice: 'deposit',
      publicId: 'activity-registration-test-0001',
      idempotencyKey: 'activity-payment-test-0001',
    })
    expect(result).toMatchObject({
      status: 'payment_pending',
      paymentRequired: true,
      totalFeeAmountMinor: 30_000,
      amountDueMinor: 6_000,
      remainingAmountMinor: 24_000,
    })
  })

  it('confirms an activity configured without prepayment immediately', async () => {
    const transaction = activityTransaction('none', 'per_registration')
    const result = await new CustomerExperienceRepository(transaction).registerActivity({
      activityPublicId: 'community-activity-test-0001',
      customerId,
      partySize: 2,
      contactSnapshot: { channel: 'miniprogram' },
      safetyAcknowledgement: { acknowledged: true },
      paymentChoice: 'none',
      publicId: 'activity-registration-test-0002',
      idempotencyKey: 'activity-payment-test-0002',
    })
    expect(result).toMatchObject({
      status: 'confirmed',
      paymentRequired: false,
      totalFeeAmountMinor: 10_000,
      amountDueMinor: 0,
      remainingAmountMinor: 10_000,
    })
  })

  it('lets an optional-deposit activity confirm without collecting a deposit', async () => {
    const transaction = activityTransaction('deposit_optional', 'per_registration')
    const result = await new CustomerExperienceRepository(transaction).registerActivity({
      activityPublicId: 'community-activity-test-0001',
      customerId,
      partySize: 2,
      contactSnapshot: { channel: 'miniprogram' },
      safetyAcknowledgement: { acknowledged: true },
      paymentChoice: 'none',
      publicId: 'activity-registration-test-0003',
      idempotencyKey: 'activity-payment-test-0003',
    })
    expect(result).toMatchObject({
      status: 'confirmed',
      paymentRequired: false,
      amountDueMinor: 0,
      remainingAmountMinor: 10_000,
    })
  })
})

function activityTransaction(mode: ActivityPaymentMode, basis: 'per_person' | 'per_registration'): ScopedTransaction {
  return {
    scope,
    async query<Row extends Record<string, unknown>>(sql: string, values: readonly unknown[] = []) {
      if (sql.includes('FROM mbox.community_activities AS activity')) {
        return rows<Row>([{
          id: '82000000-0000-4000-8000-000000000004',
          public_id: 'community-activity-test-0001', activity_kind: 'member_night', title: '音乐会员夜',
          summary: '测试活动', cover_url: null, starts_at: '2026-09-01T12:00:00.000Z', ends_at: '2026-09-01T15:00:00.000Z',
          assembly_location: 'M-BOX', capacity: 20, fee_amount_minor: '10000', deposit_amount_minor: '2000',
          fee_basis: basis, registration_payment_mode: mode, payment_deadline_minutes: 15,
          payment_rule_text: '报名后15分钟内支付订金', refund_policy_snapshot: { summary: '按活动规则退款' },
          currency: 'CNY', points_reward: 0, status: 'published', visibility: 'public', audience_rule: {},
          safety_snapshot: {}, registration_status: null, registered_count: '0',
        }])
      }
      if (sql.includes('FROM mbox.customer_memberships')) return rows<Row>([])
      if (sql.includes('INSERT INTO mbox.community_activity_registrations')) {
        const amountDue = Number(values[11] ?? 0)
        return rows<Row>([{
          public_id: values[2], status: values[7],
          payment_due_at: amountDue > 0 ? '2026-08-15T12:15:00.000Z' : null,
          seat_hold_expires_at: amountDue > 0 ? '2026-08-15T12:15:00.000Z' : null,
        }])
      }
      throw new Error(`Unexpected activity payment query: ${sql}`)
    },
  }
}

function rows<Row extends Record<string, unknown>>(values: Record<string, unknown>[]) {
  return { rows: values as Row[], rowCount: values.length }
}
