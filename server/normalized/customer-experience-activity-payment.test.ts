import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import {
  CustomerExperienceRepository,
  CustomerExperienceRequestError,
  publicActivityPaymentAvailability,
  publicActivityRegistrationPaymentAvailability,
  publicActivitySalesCopy,
  serverActivityTermsAcknowledgement,
  resolveActivityRegistrationPayment,
  type ActivityPaymentMode,
} from './customer-experience-repository.js'
import {
  CustomerExperienceService,
  normalizeActivityAudienceRule,
  validateActivityPaymentConfiguration,
} from './customer-experience-service.js'
import { protectActivityRegistrationContact } from './customer-experience-api.js'
import { PaymentRepository } from './payment-repository.js'
import { RefundRepository } from './refund-repository.js'
import {
  ScopedPostgresTransactionRunner,
  type PostgresPool,
  type ScopedTransaction,
} from './transaction-runner.js'

const scope = {
  tenantId: '82000000-0000-4000-8000-000000000001',
  storeId: '82000000-0000-4000-8000-000000000002',
}
const customerId = '82000000-0000-4000-8000-000000000003'
const protectedContact = {
  contactType: 'phone',
  contactHash: 'a'.repeat(64),
  encryptedContact: 'AQcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=',
  encryptionKeyId: 'test-contact-v1',
  maskedContact: '138****8000',
  source: 'mini_program',
}

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

  it('keeps optional no-prepayment usable while blocking only unavailable payment choices', () => {
    expect(publicActivityPaymentAvailability('deposit_optional')).toEqual({
      availability: 'available',
      blockedReason: null,
      availableChoices: ['none'],
      blockedChoices: ['deposit'],
    })
    expect(publicActivityPaymentAvailability('deposit_required')).toMatchObject({
      availability: 'blocked',
      availableChoices: [],
      blockedChoices: ['deposit'],
    })
    expect(publicActivityPaymentAvailability('deposit_optional', 10_000, 2_000, true)).toEqual({
      availability: 'available', blockedReason: null,
      availableChoices: ['none', 'deposit'], blockedChoices: [],
    })
    expect(publicActivityPaymentAvailability('none', 10_000, 0)).toEqual({
      availability: 'blocked',
      blockedReason: 'ACTIVITY_PAYMENT_AUTHORITY_NOT_CONFIGURED',
      availableChoices: [],
      blockedChoices: ['none'],
    })
  })

  it('reports unpaid registration availability from current payment authority instead of payment progress', () => {
    expect(publicActivityRegistrationPaymentAvailability('pending', true)).toEqual({
      availability: 'available', blockedReason: null,
    })
    expect(publicActivityRegistrationPaymentAvailability('pending', false)).toEqual({
      availability: 'blocked', blockedReason: 'ACTIVITY_PAYMENT_AUTHORITY_NOT_CONFIGURED',
    })
    expect(publicActivityRegistrationPaymentAvailability('not_required', false)).toEqual({
      availability: 'not_required', blockedReason: null,
    })
    expect(publicActivityRegistrationPaymentAvailability('paid', false)).toEqual({
      availability: 'available', blockedReason: null,
    })
  })

  it('returns only approved public activity copy fields', () => {
    expect(publicActivitySalesCopy({
      details: '公开详情',
      includedItems: ['饮品'],
      participationRequirements: '年满18岁',
      memberBenefitText: '会员可领取纪念品',
      contactInstructions: '报名后联系活动负责人',
      internalMarginNote: '不可对客',
      createdByEmployeeId: '不可对客',
    })).toEqual({
      details: '公开详情',
      includedItems: ['饮品'],
      participationRequirements: '年满18岁',
      memberBenefitText: '会员可领取纪念品',
      contactInstructions: '报名后联系活动负责人',
    })
  })

  it('requires both published policy versions and creates server-owned evidence', () => {
    expect(() => serverActivityTermsAcknowledgement(
      'safety-2026-08', 'refund-2026-08', 'old-version', 'refund-2026-08', true,
    )).toThrow('请阅读并确认当前版本')
    expect(() => serverActivityTermsAcknowledgement(
      'safety-2026-08', 'refund-2026-08', 'safety-2026-08', 'old-refund', true,
    )).toThrow('请阅读并确认当前版本')
    const acknowledgement = serverActivityTermsAcknowledgement(
      'safety-2026-08', 'refund-2026-08', 'safety-2026-08', 'refund-2026-08', true,
    )
    expect(acknowledgement.evidence).toMatchObject({
      acknowledged: true,
      safetyPolicyVersion: 'safety-2026-08',
      refundPolicyVersion: 'refund-2026-08',
      source: 'mini_program',
    })
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

  it('normalizes the supported activity audience instead of trusting free JSON keys', () => {
    expect(normalizeActivityAudienceRule('public', {})).toEqual({})
    expect(normalizeActivityAudienceRule('member', {})).toEqual({})
    expect(normalizeActivityAudienceRule('segment', { memberLevels: ['gold', 'gold'] }))
      .toEqual({ memberLevels: ['gold'] })
    expect(() => normalizeActivityAudienceRule('member', { memberLevels: ['gold'] }))
      .toThrow('不能附带分群条件')
    expect(() => normalizeActivityAudienceRule('segment', { memberLevels: ['VIP'] }))
      .toThrow('必须从已支持等级中选择')
    expect(() => normalizeActivityAudienceRule('segment', { arbitrary: true }))
      .toThrow('未支持字段')
  })

  it('keeps an activity unpublished unless public details, versioned rules and required-payment policy are valid', async () => {
    let publishSql = ''
    const transaction = {
      scope,
      async query<Row extends Record<string, unknown>>(sql: string) {
        publishSql = sql
        return rows<Row>([{ public_id: 'community-activity-test-0001', status: 'published' }])
      },
    } as unknown as ScopedTransaction
    const commands = {
      async execute<Result>(_command: unknown, handler: (current: ScopedTransaction) => Promise<{ result: Result }>) {
        const outcome = await handler(transaction)
        return { value: outcome.result, replayed: false }
      },
    }
    const service = new CustomerExperienceService(
      { run: async () => { throw new Error('not used') } },
      commands,
      { updateProfile: async () => { throw new Error('not used') } },
    )
    await expect(service.publishActivity({
      scope,
      employeeId: '82000000-0000-4000-8000-000000000099',
      businessDate: '2026-08-15',
    }, {
      publicId: 'community-activity-test-0001',
      idempotencyKey: 'publish-activity-test-0001',
    })).resolves.toMatchObject({ value: { status: 'published' } })
    expect(publishSql).toContain('safety_policy_version IS NOT NULL')
    expect(publishSql).toContain('refund_policy_version IS NOT NULL')
    expect(publishSql).toContain('activity_details IS NOT NULL')
    expect(publishSql).not.toContain("safety_snapshot->'policyVersion'")
    expect(publishSql).toContain('fee_amount_minor = 0')
    expect(publishSql).toContain('deposit_amount_minor = 0')
    expect(publishSql).toContain("registration_payment_mode = 'none'")
    expect(publishSql).toContain('store_commerce_policies')
    expect(publishSql).toContain("feature_code='community.activity.payment'")
    expect(publishSql).toContain('$5::boolean')
  })

  it('blocks a paid registration without creating a hold when no authoritative payment object exists', async () => {
    const transaction = activityTransaction('deposit_required', 'per_person')
    await expect(new CustomerExperienceRepository(transaction).registerActivity({
      activityPublicId: 'community-activity-test-0001',
      customerId,
      partySize: 3,
      protectedContact,
      termsAcknowledged: true,
      acknowledgedSafetyPolicyVersion: 'safety-2026-08',
      acknowledgedRefundPolicyVersion: 'refund-v1',
      paymentChoice: 'deposit',
      paymentMethod: 'native_qr',
      paymentPublicId: 'activity-payment-test-public-0001',
      publicId: 'activity-registration-test-0001',
      idempotencyKey: 'activity-payment-test-0001',
    })).rejects.toMatchObject({
      code: 'ACTIVITY_PAYMENT_AUTHORITY_NOT_CONFIGURED',
      statusCode: 503,
    })
  })

  it('allows a paid-mode waitlist without creating payment while preserving the requested payment intent', async () => {
    const transaction = activityTransaction('deposit_required', 'per_person', 10_000, 2_000, true)
    await expect(new CustomerExperienceRepository(transaction).registerActivity({
      activityPublicId: 'community-activity-test-0001', customerId, partySize: 2,
      protectedContact, termsAcknowledged: true,
      acknowledgedSafetyPolicyVersion: 'safety-2026-08',
      acknowledgedRefundPolicyVersion: 'refund-v1', paymentChoice: 'deposit',
      paymentMethod: 'native_qr', paymentPublicId: 'activity-payment-waitlist-0001',
      publicId: 'activity-registration-waitlist-0001',
      idempotencyKey: 'activity-payment-waitlist-key-0001',
    })).resolves.toMatchObject({
      status: 'waitlisted', paymentRequired: false, paymentChoice: 'none',
      amountDueMinor: 0, paymentPublicId: null,
    })
    expect(transaction.lastActivityRegistrationValues?.slice(19,22)).toEqual(['deposit','native_qr',4_000])
  })

  it('confirms a genuinely free activity immediately', async () => {
    const transaction = activityTransaction('none', 'per_registration', 0, 0)
    const result = await new CustomerExperienceRepository(transaction).registerActivity({
      activityPublicId: 'community-activity-test-0001',
      customerId,
      partySize: 2,
      protectedContact,
      termsAcknowledged: true,
      acknowledgedSafetyPolicyVersion: 'safety-2026-08',
      acknowledgedRefundPolicyVersion: 'refund-v1',
      paymentChoice: 'none',
      paymentMethod: 'native_qr',
      paymentPublicId: 'activity-payment-test-public-0002',
      publicId: 'activity-registration-test-0002',
      idempotencyKey: 'activity-payment-test-0002',
    })
    expect(result).toMatchObject({
      status: 'confirmed',
      paymentRequired: false,
      totalFeeAmountMinor: 0,
      amountDueMinor: 0,
      remainingAmountMinor: 0,
    })
  })

  it('allows optional-deposit registration without payment when the guest chooses none', async () => {
    const transaction = activityTransaction('deposit_optional', 'per_registration')
    await expect(new CustomerExperienceRepository(transaction).registerActivity({
      activityPublicId: 'community-activity-test-0001',
      customerId,
      partySize: 2,
      protectedContact,
      termsAcknowledged: true,
      acknowledgedSafetyPolicyVersion: 'safety-2026-08',
      acknowledgedRefundPolicyVersion: 'refund-v1',
      paymentChoice: 'none',
      paymentMethod: 'native_qr',
      paymentPublicId: 'activity-payment-test-public-0003',
      publicId: 'activity-registration-test-0003',
      idempotencyKey: 'activity-payment-test-0003',
    })).resolves.toMatchObject({ status: 'confirmed', paymentRequired: false, paymentPublicId: null })
  })

  it('protects the current mini-program contact contract and rejects arbitrary keys', async () => {
    const raw = '13800138000'
    const snapshot = await protectActivityRegistrationContact({ channel: 'miniprogram', contact: raw }, () => ({
      hash: 'b'.repeat(64),
      encryptedBase64: Buffer.from(`protected:${raw}`).toString('base64'),
      keyId: 'activity-contact-v1',
      masked: '138****8000',
    }))
    expect(snapshot).toMatchObject({
      contactType: 'phone', contactHash: 'b'.repeat(64), maskedContact: '138****8000', source: 'mini_program',
    })
    expect(JSON.stringify(snapshot)).not.toContain(raw)
    await expect(protectActivityRegistrationContact({
      channel: 'miniprogram', contact: raw, internalNote: '不允许',
    }, () => ({ hash: 'b'.repeat(64), encryptedBase64: 'x'.repeat(32), keyId: 'key-v1', masked: '138****8000' })))
      .rejects.toMatchObject({ code: 'ACTIVITY_CONTACT_INVALID' })
  })
})

function activityTransaction(
  mode: ActivityPaymentMode,
  basis: 'per_person' | 'per_registration',
  feeAmountMinor = 10_000,
  depositAmountMinor = 2_000,
  full = false,
): ScopedTransaction & { lastActivityRegistrationValues?: readonly unknown[] } {
  const transaction: ScopedTransaction & { lastActivityRegistrationValues?: readonly unknown[] } = {
    scope,
    async query<Row extends Record<string, unknown>>(sql: string, values: readonly unknown[] = []) {
      if (sql.includes('FROM mbox.community_activities AS activity')) {
        return rows<Row>([{
          id: '82000000-0000-4000-8000-000000000004',
          public_id: 'community-activity-test-0001', activity_kind: 'member_night', title: '音乐会员夜',
          summary: '测试活动', cover_url: null, starts_at: '2026-09-01T12:00:00.000Z', ends_at: '2026-09-01T15:00:00.000Z',
          assembly_location: 'M-BOX', capacity: 20,
          fee_amount_minor: String(feeAmountMinor), deposit_amount_minor: String(depositAmountMinor),
          fee_basis: basis, registration_payment_mode: mode, payment_deadline_minutes: 15,
          payment_rule_text: '报名后15分钟内支付订金', refund_policy_snapshot: { summary: '按活动规则退款' },
          refund_policy_version: 'refund-v1', refund_policy_summary: '按活动规则退款',
          currency: 'CNY', points_reward: 0, status: full ? 'full' : 'published', visibility: 'public',
          audience_member_levels: [], audience_lifecycle_stages: [],
          safety_snapshot: {
            policyVersion: 'safety-2026-08',
            acknowledgementText: '我已阅读并同意安全要求',
          },
          safety_policy_version: 'safety-2026-08',
          safety_acknowledgement_text: '我已阅读并同意安全要求', safety_requirements: ['年满18岁'],
          sales_copy: {}, activity_details: '这是完整活动详情说明', included_items: [],
          participation_requirements: [], contact_instructions: '报名后联系负责人', member_benefit_text: null,
          registration_status: null, registered_count: full ? '20' : '0',
        }])
      }
      if (sql.includes('FROM mbox.customer_memberships')) return rows<Row>([])
      if (sql.includes('SELECT id FROM ancestry WHERE merged_into_customer_id IS NULL')) {
        return rows<Row>([{ id: customerId }])
      }
      if (sql.includes('FROM mbox.community_activity_registrations') && sql.includes('FOR UPDATE')) return rows<Row>([])
      if (sql.includes('INSERT INTO mbox.community_activity_registrations')) {
        transaction.lastActivityRegistrationValues = values
        const amountDue = Number(values[10] ?? 0)
        return rows<Row>([{
          id: values[2],
          public_id: values[2], status: values[6],
          registration_cycle: 1,
          payment_due_at: amountDue > 0 ? '2026-08-15T12:15:00.000Z' : null,
          seat_hold_expires_at: amountDue > 0 ? '2026-08-15T12:15:00.000Z' : null,
        }])
      }
      if (sql.includes('UPDATE mbox.community_activity_registration_contact_versions')) return rows<Row>([])
      if (sql.includes('INSERT INTO mbox.community_activity_registration_contact_versions')) return rows<Row>([])
      throw new Error(`Unexpected activity payment query: ${sql}`)
    },
  }
  return transaction
}

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip

integration('activity registration state and contact privacy with PostgreSQL', () => {
  let pool: Pool
  let transactions: ScopedPostgresTransactionRunner
  const tenantId = randomUUID()
  const storeId = randomUUID()
  const employeeId = randomUUID()
  const approverEmployeeId = randomUUID()
  const customerId = randomUUID()
  const paidCustomerId = randomUUID()
  const concurrentCustomerId = randomUUID()
  const freeActivityId = randomUUID()
  const paidActivityId = randomUUID()
  const dbScope = { tenantId, storeId }
  const dbContact = {
    contactType: 'phone', contactHash: 'c'.repeat(64),
    encryptedContact: 'AQcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=',
    encryptionKeyId: 'activity-test-v1', maskedContact: '138****8000', source: 'mini_program',
  }

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    pool = new Pool({ connectionString: databaseUrl, max: 4 })
    transactions = new ScopedPostgresTransactionRunner(asPool(pool))
    await pool.query(`INSERT INTO mbox.tenants (id, code, name) VALUES ($1, $2, 'Activity privacy tenant')`, [
      tenantId, `activity-${tenantId.slice(0, 8)}`,
    ])
    await pool.query(`
      INSERT INTO mbox.stores (id, tenant_id, code, name)
      VALUES ($1, $2, $3, 'Activity privacy store')
    `, [storeId, tenantId, `activity-store-${storeId.slice(0, 8)}`])
    await pool.query(`
      INSERT INTO mbox.employees (id, tenant_id, store_id, employee_code, display_name)
      VALUES ($1, $2, $3, 'ACTIVITY_TEST', 'Activity Test'),
        ($4, $2, $3, 'ACTIVITY_CASHIER', 'Activity Cashier')
    `, [employeeId, tenantId, storeId, approverEmployeeId])
    await pool.query(`
      INSERT INTO mbox.customers (id, tenant_id, store_id, public_id)
      VALUES ($1, $2, $3, $4), ($5, $2, $3, $6), ($7, $2, $3, $8)
    `, [
      customerId, tenantId, storeId, `customer-${customerId}`,
      paidCustomerId, `customer-${paidCustomerId}`,
      concurrentCustomerId, `customer-${concurrentCustomerId}`,
    ])
    const common = [
      tenantId, storeId, employeeId,
      JSON.stringify({
        policyVersion: 'safety-v1', acknowledgementText: '我已阅读并同意安全要求', requirements: ['遵守现场安全要求'],
      }),
      JSON.stringify({ policyVersion: 'refund-v1', summary: '免费活动无退款' }),
      JSON.stringify({
        details: '这是用于测试报名隐私和状态机的活动完整详情。', includedItems: [],
        participationRequirements: [], contactInstructions: '报名后将由活动负责人联系',
      }),
    ]
    await pool.query(`
      INSERT INTO mbox.community_activities (
        id, tenant_id, store_id, public_id, activity_kind, title, summary,
        starts_at, ends_at, assembly_location, capacity, fee_amount_minor,
        deposit_amount_minor, registration_payment_mode, refund_policy_snapshot,
        safety_snapshot, sales_copy, safety_policy_version,
        safety_acknowledgement_text, safety_requirements,
        refund_policy_version, refund_policy_summary, activity_details,
        included_items, participation_requirements, contact_instructions,
        status, published_at, created_by_employee_id
      ) VALUES (
        $7, $1, $2, $8, 'member_night', '免费会员夜', '免费活动测试',
        clock_timestamp() + interval '1 day', clock_timestamp() + interval '1 day 2 hours',
        'M-BOX', 8, 0, 0, 'none', $5::jsonb, $4::jsonb, $6::jsonb,
        'safety-v1', '我已阅读并同意安全要求', ARRAY['遵守现场安全要求']::text[],
        'refund-v1', '免费活动无退款', '这是用于测试报名隐私和状态机的活动完整详情。',
        '{}'::text[], '{}'::text[], '报名后将由活动负责人联系',
        'published', clock_timestamp(), $3
      ), (
        $9, $1, $2, $10, 'member_night', '收费会员夜', '收费活动安全阻断测试',
        clock_timestamp() + interval '2 days', clock_timestamp() + interval '2 days 2 hours',
        'M-BOX', 8, 10000, 2000, 'deposit_optional', $5::jsonb, $4::jsonb, $6::jsonb,
        'safety-v1', '我已阅读并同意安全要求', ARRAY['遵守现场安全要求']::text[],
        'refund-v1', '免费活动无退款', '这是用于测试报名隐私和状态机的活动完整详情。',
        '{}'::text[], '{}'::text[], '报名后将由活动负责人联系',
        'published', clock_timestamp(), $3
      )
    `, [...common, freeActivityId, 'community-free-db-test', paidActivityId, 'community-paid-db-test'])
  })

  afterAll(async () => {
    await pool?.end()
  })

  it('enforces protected contact shape, supports idempotent cancel and safely re-registers a cancelled free activity', async () => {
    await expect(pool.query(`
      INSERT INTO mbox.community_activity_registrations (
        tenant_id, store_id, public_id, activity_id, customer_id, party_size,
        status, fee_amount_minor, currency, contact_snapshot, safety_acknowledgement, idempotency_key,
        requested_payment_choice,requested_amount_due_minor
      ) VALUES ($1, $2, 'registration-invalid-contact', $3, $4, 1,
        'confirmed', 0, 'CNY', '{"contact":"13800138000"}'::jsonb,
        '{"acknowledged":true}'::jsonb, 'invalid-contact-db-test','none',0)
    `, [tenantId, storeId, freeActivityId, customerId])).rejects.toMatchObject({ code: '23514' })

    await expect(pool.query(`
      INSERT INTO mbox.community_activity_registrations (
        tenant_id, store_id, public_id, activity_id, customer_id, party_size,
        status, fee_amount_minor, currency, contact_snapshot, safety_acknowledgement,
        refund_policy_snapshot, idempotency_key,requested_payment_choice,requested_amount_due_minor
      ) VALUES ($1, $2, 'registration-missing-strong-terms', $3, $4, 1,
        'confirmed', 0, 'CNY', $5::jsonb, '{"acknowledged":true}'::jsonb,
        '{"policyVersion":"refund-v1"}'::jsonb, 'missing-strong-terms-db-test','none',0)
    `, [tenantId, storeId, freeActivityId, customerId, JSON.stringify(dbContact)]))
      .rejects.toMatchObject({ code: '23514' })

    const first = await transactions.run(dbScope, (transaction) => (
      new CustomerExperienceRepository(transaction).registerActivity({
        activityPublicId: 'community-free-db-test', customerId, partySize: 2,
        protectedContact: dbContact,
        termsAcknowledged: true,
        acknowledgedSafetyPolicyVersion: 'safety-v1',
        acknowledgedRefundPolicyVersion: 'refund-v1',
        paymentChoice: 'none', publicId: 'registration-free-db-test',
        paymentMethod: 'native_qr', paymentPublicId: 'payment-free-db-test-0001',
        idempotencyKey: 'registration-free-db-key-0001',
      })
    ))
    expect(first).toMatchObject({ status: 'confirmed', totalFeeAmountMinor: 0 })
    const stored = await pool.query<{
      contact_snapshot: Record<string, unknown>
      acknowledged_safety_policy_version: string
      acknowledged_refund_policy_version: string
      terms_acknowledgement_source: string
    }>(`
      SELECT contact_snapshot, acknowledged_safety_policy_version,
        acknowledged_refund_policy_version, terms_acknowledgement_source
      FROM mbox.community_activity_registrations
      WHERE tenant_id=$1 AND store_id=$2 AND public_id=$3
    `, [tenantId, storeId, first.publicId])
    expect(stored.rows[0]?.contact_snapshot).toEqual(dbContact)
    expect(JSON.stringify(stored.rows[0]?.contact_snapshot)).not.toContain('13800138000')
    expect(stored.rows[0]).toMatchObject({
      acknowledged_safety_policy_version: 'safety-v1',
      acknowledged_refund_policy_version: 'refund-v1',
      terms_acknowledgement_source: 'mini_program',
    })

    const cancelled = await transactions.run(dbScope, (transaction) => (
      new CustomerExperienceRepository(transaction).cancelActivityRegistration({
        registrationPublicId: first.publicId, customerId, reason: '顾客改变计划',
      })
    ))
    expect(cancelled.status).toBe('cancelled')
    const cancelledContact = await pool.query<{ contact_snapshot: Record<string, unknown> }>(`
      SELECT contact_snapshot FROM mbox.community_activity_registrations
      WHERE tenant_id=$1 AND store_id=$2 AND public_id=$3
    `, [tenantId, storeId, first.publicId])
    expect(cancelledContact.rows[0]?.contact_snapshot).toEqual(dbContact)
    expect(cancelledContact.rows[0]?.contact_snapshot).not.toHaveProperty('cancellationReason')
    await expect(transactions.run(dbScope, (transaction) => (
      new CustomerExperienceRepository(transaction).cancelActivityRegistration({
        registrationPublicId: first.publicId, customerId, reason: '重复取消',
      })
    ))).resolves.toEqual(cancelled)

    const again = await transactions.run(dbScope, (transaction) => (
      new CustomerExperienceRepository(transaction).registerActivity({
        activityPublicId: 'community-free-db-test', customerId, partySize: 1,
        protectedContact: dbContact,
        termsAcknowledged: true,
        acknowledgedSafetyPolicyVersion: 'safety-v1',
        acknowledgedRefundPolicyVersion: 'refund-v1',
        paymentChoice: 'none', publicId: 'registration-free-db-again',
        paymentMethod: 'native_qr', paymentPublicId: 'payment-free-db-test-0002',
        idempotencyKey: 'registration-free-db-key-0002',
      })
    ))
    expect(again).toMatchObject({ publicId: first.publicId, status: 'confirmed' })
    const count = await pool.query<{ count: string }>(`
      SELECT count(*)::text AS count FROM mbox.community_activity_registrations
      WHERE tenant_id=$1 AND store_id=$2 AND activity_id=$3 AND customer_id=$4
    `, [tenantId, storeId, freeActivityId, customerId])
    expect(count.rows[0]?.count).toBe('1')
  })

  it('allows a legacy optional-deposit activity to register without selecting prepayment', async () => {
    await expect(transactions.run(dbScope, (transaction) => (
      new CustomerExperienceRepository(transaction).registerActivity({
        activityPublicId: 'community-paid-db-test', customerId, partySize: 1,
        protectedContact: dbContact,
        termsAcknowledged: true,
        acknowledgedSafetyPolicyVersion: 'safety-v1',
        acknowledgedRefundPolicyVersion: 'refund-v1',
        paymentChoice: 'none', publicId: 'registration-paid-db-test',
        paymentMethod: 'native_qr', paymentPublicId: 'payment-paid-db-test-0001',
        idempotencyKey: 'registration-paid-db-key-0001',
      })
    ))).resolves.toMatchObject({ status: 'confirmed', paymentRequired: false, paymentPublicId: null })
    const count = await pool.query<{ count: string }>(`
      SELECT count(*)::text AS count FROM mbox.community_activity_registrations
      WHERE tenant_id=$1 AND store_id=$2 AND activity_id=$3
    `, [tenantId, storeId, paidActivityId])
    expect(count.rows[0]?.count).toBe('1')
  })

  it('atomically creates a paid seat hold and authoritative activity payment, then rejects a forged amount', async () => {
    await pool.query(`
      INSERT INTO mbox.store_commerce_policies (
        tenant_id, store_id, online_payment_enabled, reason, updated_by_employee_id
      ) VALUES ($1, $2, true, '本地收费活动支付数据库测试', $3)
      ON CONFLICT (tenant_id, store_id) DO UPDATE SET
        online_payment_enabled=true, reason=EXCLUDED.reason, updated_by_employee_id=EXCLUDED.updated_by_employee_id
    `, [tenantId, storeId, employeeId])
    await pool.query(`
      UPDATE mbox.customer_experience_features
      SET rollout_state='pilot', reason='本地收费活动支付数据库测试', updated_at=clock_timestamp()
      WHERE tenant_id=$1 AND store_id=$2 AND feature_code='community.activity.payment'
    `, [tenantId, storeId])

    const registered = await transactions.run(dbScope, (transaction) => (
      new CustomerExperienceRepository(transaction, true).registerActivity({
        activityPublicId: 'community-paid-db-test', customerId: paidCustomerId, partySize: 2,
        protectedContact: dbContact,
        termsAcknowledged: true,
        acknowledgedSafetyPolicyVersion: 'safety-v1',
        acknowledgedRefundPolicyVersion: 'refund-v1',
        paymentChoice: 'deposit', publicId: 'registration-paid-authority-db-test',
        paymentMethod: 'native_qr', paymentPublicId: 'payment-paid-authority-db-test',
        idempotencyKey: 'registration-paid-authority-key-0001',
      })
    ))
    expect(registered).toMatchObject({
      status: 'payment_pending', paymentRequired: true, paymentChoice: 'deposit',
      totalFeeAmountMinor: 10_000, amountDueMinor: 2_000,
      paymentPublicId: 'payment-paid-authority-db-test',
    })
    const stored = await pool.query<{
      registration_status: string; payment_status: string; payable_kind: string;
      order_id: string | null; activity_registration_id: string; amount_minor: string;
    }>(`
      SELECT registration.status AS registration_status, registration.payment_status,
        payment.payable_kind, payment.order_id, payment.activity_registration_id,
        payment.amount_minor::text
      FROM mbox.community_activity_registrations registration
      JOIN mbox.payments payment ON payment.tenant_id=registration.tenant_id
        AND payment.store_id=registration.store_id AND payment.id=registration.payment_id
      WHERE registration.tenant_id=$1 AND registration.store_id=$2 AND registration.public_id=$3
    `, [tenantId, storeId, registered.publicId])
    expect(stored.rows[0]).toMatchObject({
      registration_status: 'payment_pending', payment_status: 'pending',
      payable_kind: 'activity_registration', order_id: null, amount_minor: '2000',
    })
    expect(stored.rows[0]?.activity_registration_id).toBeTruthy()

    const payableRegistrations = await transactions.run(dbScope, (transaction) => (
      new CustomerExperienceRepository(transaction, true).publicActivityRegistrations(paidCustomerId)
    ), { readOnly: true })
    expect(payableRegistrations).toEqual([
      expect.objectContaining({
        publicId: registered.publicId,
        paymentStatus: 'pending',
        paymentAvailability: 'available',
        paymentBlockedReason: null,
      }),
    ])
    await pool.query(`
      UPDATE mbox.customer_experience_features
      SET rollout_state='disabled', reason='验证报名列表按当前支付授权降级', updated_at=clock_timestamp()
      WHERE tenant_id=$1 AND store_id=$2 AND feature_code='community.activity.payment'
    `, [tenantId, storeId])
    const blockedRegistrations = await transactions.run(dbScope, (transaction) => (
      new CustomerExperienceRepository(transaction, true).publicActivityRegistrations(paidCustomerId)
    ), { readOnly: true })
    expect(blockedRegistrations[0]).toMatchObject({
      publicId: registered.publicId,
      paymentStatus: 'pending',
      paymentAvailability: 'blocked',
      paymentBlockedReason: 'ACTIVITY_PAYMENT_AUTHORITY_NOT_CONFIGURED',
    })
    await pool.query(`
      UPDATE mbox.customer_experience_features
      SET rollout_state='pilot', reason='恢复收费活动支付数据库测试', updated_at=clock_timestamp()
      WHERE tenant_id=$1 AND store_id=$2 AND feature_code='community.activity.payment'
    `, [tenantId, storeId])

    await expect(transactions.run(dbScope, (transaction) => (
      new PaymentRepository(transaction).applySucceededCallback({
        paymentPublicId: registered.paymentPublicId!, provider: 'postar',
        providerTransactionId: 'provider-activity-forged-amount',
        reportedAmountMinor: 1, reportedCurrency: 'CNY',
        providerSnapshot: { signatureVerified: true },
      })
    ))).rejects.toMatchObject({ name: 'PaymentCallbackMismatchError' })
    const afterForged = await pool.query<{ status: string; payment_status: string }>(`
      SELECT status, payment_status FROM mbox.community_activity_registrations
      WHERE tenant_id=$1 AND store_id=$2 AND public_id=$3
    `, [tenantId, storeId, registered.publicId])
    expect(afterForged.rows[0]).toEqual({ status: 'payment_pending', payment_status: 'pending' })

    const captured = await transactions.run(dbScope, async (transaction) => {
      const payments = new PaymentRepository(transaction)
      const applied = await payments.applySucceededCallback({
        paymentPublicId: registered.paymentPublicId!, provider: 'postar',
        providerTransactionId: 'POSTAR-ACTIVITY-PAYMENT-001',
        reportedAmountMinor: 2_000, reportedCurrency: 'CNY',
        providerSnapshot: { signatureVerified: true, channel: 'wechat' },
      })
      await payments.syncActivityRegistrationPaymentStatus(applied.payment)
      return applied.payment
    })
    expect(captured).toMatchObject({ payableKind: 'activity_registration', status: 'succeeded' })
    const confirmed = await pool.query<{ status: string; payment_status: string }>(`
      SELECT status, payment_status FROM mbox.community_activity_registrations
      WHERE tenant_id=$1 AND store_id=$2 AND public_id=$3
    `, [tenantId, storeId, registered.publicId])
    expect(confirmed.rows[0]).toEqual({ status: 'confirmed', payment_status: 'paid' })

    const requested = await transactions.run(dbScope, (transaction) => (
      new RefundRepository(transaction).requestActivity({
        paymentId: captured.id, publicId: 'activityRefundProviderDb0001',
        reason: '顾客取消收费活动', requestedByEmployeeId: employeeId,
      })
    ))
    const approved = await transactions.run(dbScope, (transaction) => (
      new RefundRepository(transaction).approve(requested.id, approverEmployeeId, '收银复核同意退款')
    ))
    expect(approved).toMatchObject({
      orderId: null, activityRegistrationId: captured.activityRegistrationId,
      requestedByEmployeeId: employeeId, approvedByEmployeeId: approverEmployeeId,
      status: 'approved',
    })
    await transactions.run(dbScope, (transaction) => new RefundRepository(transaction).beginExecution(requested.id))
    const providerRefundOrderId = requested.id.replaceAll('-', '')
    await pool.query(`
      UPDATE mbox.refunds
      SET merchant_refund_id=$4,
        provider_submission_started_at=clock_timestamp(),
        provider_submission_state='submitted'
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
        AND status='processing' AND provider_submission_state='not_started'
    `, [tenantId, storeId, requested.id, providerRefundOrderId])
    const terminal = await transactions.run(dbScope, async (transaction) => {
      const refunds = new RefundRepository(transaction)
      const applied = await refunds.completeProviderExecution({
        refundPublicId: providerRefundOrderId, provider: 'postar', succeeded: true,
        providerRefundId: 'POSTAR-ACTIVITY-REFUND-001',
        originalProviderTransactionId: 'POSTAR-ACTIVITY-PAYMENT-001',
        reportedAmountMinor: 2_000, reportedCurrency: 'CNY',
        providerSnapshot: { signatureVerified: true },
      })
      await refunds.syncPaymentRefundStatus(captured.id)
      await new PaymentRepository(transaction).syncActivityRegistrationRefundStatus(captured.id)
      return applied
    })
    expect(terminal).toMatchObject({ applied: true, refund: { status: 'succeeded' } })
    const refunded = await pool.query<{ status: string; payment_status: string }>(`
      SELECT status, payment_status FROM mbox.community_activity_registrations
      WHERE tenant_id=$1 AND store_id=$2 AND public_id=$3
    `, [tenantId, storeId, registered.publicId])
    expect(refunded.rows[0]).toEqual({ status: 'refunded', payment_status: 'refunded' })
  })

  it('serializes duplicate paid registration attempts so only one hold and one payment survive', async () => {
    const attempt = (suffix: string) => transactions.run(dbScope, (transaction) => (
      new CustomerExperienceRepository(transaction, true).registerActivity({
        activityPublicId: 'community-paid-db-test', customerId: concurrentCustomerId, partySize: 1,
        protectedContact: dbContact,
        termsAcknowledged: true,
        acknowledgedSafetyPolicyVersion: 'safety-v1',
        acknowledgedRefundPolicyVersion: 'refund-v1',
        paymentChoice: 'deposit', publicId: `registration-paid-concurrent-${suffix}`,
        paymentMethod: 'native_qr', paymentPublicId: `payment-paid-concurrent-${suffix}`,
        idempotencyKey: `registration-paid-concurrent-key-${suffix}`,
      })
    ))
    const results = await Promise.allSettled([attempt('0001'), attempt('0002')])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    const count = await pool.query<{ registrations: string; payments: string }>(`
      SELECT count(DISTINCT registration.id)::text AS registrations,
        count(payment.id)::text AS payments
      FROM mbox.community_activity_registrations registration
      LEFT JOIN mbox.payments payment ON payment.tenant_id=registration.tenant_id
        AND payment.store_id=registration.store_id AND payment.activity_registration_id=registration.id
      WHERE registration.tenant_id=$1 AND registration.store_id=$2
        AND registration.activity_id=$3 AND registration.customer_id=$4
    `, [tenantId, storeId, paidActivityId, concurrentCustomerId])
    expect(count.rows[0]).toEqual({ registrations: '1', payments: '1' })
  })
})

function asPool(pool: Pool): PostgresPool {
  return { connect: async () => pool.connect(), end: async () => pool.end() }
}

function rows<Row extends Record<string, unknown>>(values: Record<string, unknown>[]) {
  return { rows: values as Row[], rowCount: values.length }
}
