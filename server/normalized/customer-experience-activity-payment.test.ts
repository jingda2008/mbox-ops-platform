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
import { ActivityRecollectionAuthorizationRepository } from './activity-recollection-authorization-repository.js'
import { NormalizedCommandExecutor } from './command-executor.js'
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
        return rows<Row>([{ id: '82000000-0000-4000-8000-000000000004', public_id: 'community-activity-test-0001', status: 'published' }])
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

  it('requires an M-BOX membership before an activity can be viewed or registered', async () => {
    const transaction = activityTransaction('none', 'per_registration', 0, 0, false, false)
    const repository = new CustomerExperienceRepository(transaction)
    await expect(repository.publicActivity(customerId, 'community-activity-test-0001')).rejects.toMatchObject({
      code: 'ACTIVITY_MEMBERSHIP_REQUIRED', statusCode: 403,
    })
    await expect(repository.registerActivity({
      activityPublicId: 'community-activity-test-0001', customerId, partySize: 1,
      protectedContact, termsAcknowledged: true,
      acknowledgedSafetyPolicyVersion: 'safety-2026-08',
      acknowledgedRefundPolicyVersion: 'refund-v1', paymentChoice: 'none',
      paymentMethod: 'native_qr', paymentPublicId: 'activity-payment-nonmember-0001',
      publicId: 'activity-registration-nonmember-0001',
      idempotencyKey: 'activity-registration-nonmember-key-0001',
    })).rejects.toMatchObject({ code: 'ACTIVITY_MEMBERSHIP_REQUIRED', statusCode: 403 })
    expect(transaction.lastActivityRegistrationValues).toBeUndefined()
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
    await expect(protectActivityRegistrationContact({
      channel: 'miniprogram', contact: '12121',
    }, () => ({ hash: 'b'.repeat(64), encryptedBase64: 'x'.repeat(32), keyId: 'key-v1', masked: '微***号' })))
      .rejects.toMatchObject({ code: 'ACTIVITY_CONTACT_INVALID' })
  })
})

function activityTransaction(
  mode: ActivityPaymentMode,
  basis: 'per_person' | 'per_registration',
  feeAmountMinor = 10_000,
  depositAmountMinor = 2_000,
  full = false,
  withMembership = true,
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
      if (sql.includes('FROM mbox.customer_memberships')) return rows<Row>(withMembership ? [membershipRow()] : [])
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

function membershipRow() {
  return {
    id: '82000000-0000-4000-8000-000000000005', member_no: 'MBX-ACTIVITY-TEST', level: 'member',
    lifecycle_stage: 'new', points_balance: 0, growth_value: 0, pending_recovery_points: 0,
    redemption_status: 'active', visit_count: 0, joined_at: '2026-08-15T00:00:00.000Z',
    evaluation_window_months: null, silver_upgrade_growth: null, silver_retain_growth: null,
    gold_upgrade_growth: null, gold_retain_growth: null, rolling_growth: null,
    period_status: null, period_ends_at: null, grace_ends_at: null,
    expiring_points_30_days: null, next_expiry_at: null,
  }
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
  const manualCollectionCustomerId = randomUUID()
  const requiredPackageCustomerId = randomUUID()
  const perPersonLimitCustomerId = randomUUID()
  const concurrentPackageLimitCustomerId = randomUUID()
  const unavailableStockCustomerId = randomUUID()
  const availableStockCustomerId = randomUUID()
  const capacityOccupyingCustomerId = randomUUID()
  const capacityWaitlistCustomerId = randomUUID()
  const freeActivityId = randomUUID()
  const paidActivityId = randomUUID()
  const packageRequiredActivityId = randomUUID()
  const packageLimitActivityId = randomUUID()
  const packageIsolationActivityId = randomUUID()
  const unavailableStockItemId = randomUUID()
  const availableStockItemId = randomUUID()
  const paidActivityStockItemId = randomUUID()
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
    await pool.query(`
      WITH memberships AS (
        INSERT INTO mbox.customer_memberships (tenant_id, store_id, customer_id, member_no)
        VALUES
          ($1, $2, $3, 'MBX-ACTIVITY-FREE'),
          ($1, $2, $4, 'MBX-ACTIVITY-PAID'),
          ($1, $2, $5, 'MBX-ACTIVITY-CONCURRENT')
        RETURNING id, tenant_id, store_id, customer_id
      )
      INSERT INTO mbox.loyalty_accounts (tenant_id, store_id, membership_id, customer_id)
      SELECT tenant_id, store_id, id, customer_id FROM memberships
    `, [tenantId, storeId, customerId, paidCustomerId, concurrentCustomerId])
    const packageScenarioCustomers = [
      requiredPackageCustomerId,
      perPersonLimitCustomerId,
      concurrentPackageLimitCustomerId,
      unavailableStockCustomerId,
      availableStockCustomerId,
      capacityOccupyingCustomerId,
      capacityWaitlistCustomerId,
      manualCollectionCustomerId,
    ]
    for (const [index, scenarioCustomerId] of packageScenarioCustomers.entries()) {
      await pool.query(`
        WITH membership AS (
          INSERT INTO mbox.customers(id,tenant_id,store_id,public_id)
          VALUES($1::uuid,$2::uuid,$3::uuid,$4)
          RETURNING id,tenant_id,store_id
        ), created_membership AS (
          INSERT INTO mbox.customer_memberships(tenant_id,store_id,customer_id,member_no)
          SELECT tenant_id,store_id,id,$5 FROM membership
          RETURNING id,tenant_id,store_id,customer_id
        )
        INSERT INTO mbox.loyalty_accounts(tenant_id,store_id,membership_id,customer_id)
        SELECT tenant_id,store_id,id,customer_id FROM created_membership
      `, [
        scenarioCustomerId, tenantId, storeId,
        `customer-package-scenario-${scenarioCustomerId}`,
        `MBX-ACT-PACKAGE-${String(index + 1).padStart(2, '0')}`,
      ])
    }
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

    await seedPackageRegistrationScenarios()
  })

  afterAll(async () => {
    await pool?.end()
  })

  it('publishes a public activity id while writing only the internal UUID to its outbox aggregate', async () => {
    const service = new CustomerExperienceService(
      transactions,
      new NormalizedCommandExecutor(transactions),
      { updateProfile: async () => { throw new Error('not used') } },
      false,
    )
    const created = await service.createActivity({
      scope: dbScope, employeeId, businessDate: '2026-08-26',
    }, {
      kind: 'member_night',
      title: '出站 UUID 发布回归',
      summary: '验证公开活动编号不会写入 UUID 出站聚合键。',
      coverUrl: null,
      startsAt: '2099-08-30T12:00:00.000Z',
      endsAt: '2099-08-30T15:00:00.000Z',
      assemblyLocation: 'M-BOX',
      capacity: 8,
      feeAmountMinor: 0,
      depositAmountMinor: 0,
      feeBasis: 'per_registration',
      paymentMode: 'none',
      paymentDeadlineMinutes: 15,
      paymentRuleText: '本活动无需预付。',
      refundPolicySnapshot: { policyVersion: 'refund-v1', summary: '免费活动无退款' },
      pointsReward: 0,
      visibility: 'public',
      audienceRule: {},
      safetySnapshot: {
        policyVersion: 'safety-v1', acknowledgementText: '我已阅读并同意安全要求', requirements: ['遵守现场安全要求'],
      },
      salesCopy: {
        details: '用于验证活动发布出站记录的完整活动详情。', includedItems: [],
        participationRequirements: [], contactInstructions: '报名后将由活动负责人联系。',
      },
      idempotencyKey: `activity-outbox-uuid-create-${randomUUID()}`,
    })
    expect(created.value.publicId).toMatch(/^community-activity-/)

    const published = await service.publishActivity({
      scope: dbScope, employeeId: approverEmployeeId, businessDate: '2026-08-26',
    }, {
      publicId: created.value.publicId,
      idempotencyKey: `activity-outbox-uuid-publish-${randomUUID()}`,
    })
    expect(published.value).toEqual({ publicId: created.value.publicId, status: 'published' })

    const evidence = await pool.query<{
      activity_id: string
      activity_public_id: string
      aggregate_id: string
      message_type: string
      audit_object_id: string
    }>(`
      SELECT activity.id AS activity_id,activity.public_id AS activity_public_id,
        outbox.aggregate_id,outbox.message_type,audit.object_id AS audit_object_id
      FROM mbox.community_activities activity
      JOIN mbox.outbox_messages outbox
        ON outbox.tenant_id=activity.tenant_id AND outbox.store_id=activity.store_id
       AND outbox.aggregate_type='community_activity' AND outbox.aggregate_id=activity.id
      JOIN mbox.audit_events audit
        ON audit.tenant_id=activity.tenant_id AND audit.store_id=activity.store_id
       AND audit.object_type='community_activity' AND audit.object_id=activity.public_id
       AND audit.action=replace(outbox.message_type,'.v1','')
      WHERE activity.tenant_id=$1::uuid AND activity.store_id=$2::uuid
        AND activity.public_id=$3
      ORDER BY outbox.message_type
    `, [tenantId, storeId, created.value.publicId])
    expect(evidence.rows.map((row) => row.message_type)).toEqual([
      'community.activity.created.v1', 'community.activity.published.v1',
    ])
    for (const row of evidence.rows) {
      expect(row.aggregate_id).toBe(row.activity_id)
      expect(row.aggregate_id).not.toBe(row.activity_public_id)
      expect(row.audit_object_id).toBe(row.activity_public_id)
    }
  })

  async function seedPackageRegistrationScenarios() {
    const activities = [
      {
        id: packageRequiredActivityId,
        publicId: 'community-package-required-db',
        title: '套餐必选活动',
        packageSelectionRequired: true,
      },
      {
        id: packageLimitActivityId,
        publicId: 'community-package-limit-db',
        title: '套餐限购活动',
        packageSelectionRequired: false,
      },
      {
        id: packageIsolationActivityId,
        publicId: 'community-package-isolation-db',
        title: '套餐库存隔离活动',
        packageSelectionRequired: false,
      },
    ]
    for (const activity of activities) {
      await pool.query(`
        INSERT INTO mbox.community_activities (
          id,tenant_id,store_id,public_id,activity_kind,title,summary,
          starts_at,ends_at,assembly_location,capacity,fee_amount_minor,
          deposit_amount_minor,registration_payment_mode,refund_policy_snapshot,
          safety_snapshot,sales_copy,safety_policy_version,
          safety_acknowledgement_text,safety_requirements,
          refund_policy_version,refund_policy_summary,activity_details,
          included_items,participation_requirements,contact_instructions,
          package_selection_required,status,published_at,created_by_employee_id
        ) VALUES (
          $1::uuid,$2::uuid,$3::uuid,$4,'member_night',$5,'套餐报名服务端门禁测试',
          clock_timestamp()+interval '3 days',clock_timestamp()+interval '3 days 2 hours',
          'M-BOX',20,0,0,'none',
          '{"policyVersion":"refund-v1","summary":"免费活动无退款"}'::jsonb,
          '{"policyVersion":"safety-v1","acknowledgementText":"我已阅读并同意安全要求","requirements":["遵守现场安全要求"]}'::jsonb,
          '{"details":"套餐报名服务端门禁测试"}'::jsonb,
          'safety-v1','我已阅读并同意安全要求',ARRAY['遵守现场安全要求']::text[],
          'refund-v1','免费活动无退款','套餐报名服务端门禁测试。',
          '{}'::text[],'{}'::text[],'报名后将由活动负责人联系',
          $6,'published',clock_timestamp(),$7::uuid
        )
      `, [
        activity.id, tenantId, storeId, activity.publicId, activity.title,
        activity.packageSelectionRequired, employeeId,
      ])
    }

    await createPackage({
      activityId: packageRequiredActivityId,
      publicId: 'package-required-paused',
      name: '暂停中的必选套餐',
      status: 'paused',
    })
    await createPackage({
      activityId: packageLimitActivityId,
      publicId: 'package-limit-per-person',
      name: '按人数限购套餐',
      feeBasis: 'per_person',
      memberPurchaseLimit: 1,
    })
    await createPackage({
      activityId: packageLimitActivityId,
      publicId: 'package-limit-per-registration',
      name: '按报名限购套餐',
      feeBasis: 'per_registration',
      memberPurchaseLimit: 1,
    })

    await pool.query(`
      INSERT INTO mbox.inventory_items(id,tenant_id,store_id,sku,name,item_type,base_unit)
      VALUES
        ($1::uuid,$2::uuid,$3::uuid,'ACTIVITY-PACKAGE-EMPTY','库存为零的套餐物料','consumable','portion'),
        ($4::uuid,$2::uuid,$3::uuid,'ACTIVITY-PACKAGE-AVAILABLE','有库存的套餐物料','consumable','portion'),
        ($5::uuid,$2::uuid,$3::uuid,'ACTIVITY-PAID-HOLD','收费活动套餐物料','consumable','portion')
    `, [unavailableStockItemId, tenantId, storeId, availableStockItemId, paidActivityStockItemId])
    await pool.query(`
      INSERT INTO mbox.inventory_balances(tenant_id,store_id,inventory_item_id,on_hand_quantity,reserved_quantity)
      VALUES
        ($1::uuid,$2::uuid,$3::uuid,0,0),
        ($1::uuid,$2::uuid,$4::uuid,2,0),
        ($1::uuid,$2::uuid,$5::uuid,10,0)
    `, [tenantId, storeId, unavailableStockItemId, availableStockItemId, paidActivityStockItemId])
    await createPackage({
      activityId: paidActivityId,
      publicId: 'package-paid-hold-expiry',
      name: '收费活动履约暂留套餐',
      inventoryItemId: paidActivityStockItemId,
    })
    await createPackage({
      activityId: packageIsolationActivityId,
      publicId: 'package-stock-unavailable',
      name: '缺货套餐',
      inventoryItemId: unavailableStockItemId,
    })
    await createPackage({
      activityId: packageIsolationActivityId,
      publicId: 'package-stock-available',
      name: '可售套餐',
      inventoryItemId: availableStockItemId,
    })
    await createPackage({
      activityId: packageIsolationActivityId,
      publicId: 'package-capacity-full',
      name: '独立容量套餐',
      capacity: 1,
    })
  }

  async function createPackage(input: Readonly<{
    activityId: string
    publicId: string
    name: string
    status?: 'paused' | 'published'
    capacity?: number
    memberPurchaseLimit?: number
    feeBasis?: 'per_person' | 'per_registration'
    inventoryItemId?: string
  }>) {
    const packageId = randomUUID()
    const status = input.status ?? 'published'
    await pool.query(`
      INSERT INTO mbox.community_activity_packages(
        id,tenant_id,store_id,activity_id,public_id,name,capacity,member_purchase_limit,
        fee_amount_minor,deposit_amount_minor,fee_basis,payment_mode,payment_deadline_minutes,
        payment_rule_text,status
      ) VALUES(
        $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7,$8,
        0,0,$9,'none',15,'本套餐无需预付',$10
      )
    `, [
      packageId, tenantId, storeId, input.activityId, input.publicId, input.name,
      input.capacity ?? 10, input.memberPurchaseLimit ?? 1,
      input.feeBasis ?? 'per_registration', input.inventoryItemId === undefined ? status : 'draft',
    ])
    if (input.inventoryItemId !== undefined) {
      await pool.query(`
        INSERT INTO mbox.community_activity_package_components(
          tenant_id,store_id,activity_package_id,inventory_item_id,quantity,per_participant
        ) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,1,true)
      `, [tenantId, storeId, packageId, input.inventoryItemId])
      await pool.query(`
        UPDATE mbox.community_activity_packages SET status=$4
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
      `, [tenantId, storeId, packageId, status])
    }
    return packageId
  }

  function registerPackageActivity(input: Readonly<{
    activityPublicId: string
    activityPackagePublicId: string | null
    customerId: string
    partySize?: number
    suffix: string
  }>) {
    return transactions.run(dbScope, (transaction) => (
      new CustomerExperienceRepository(transaction).registerActivity({
        activityPublicId: input.activityPublicId,
        activityPackagePublicId: input.activityPackagePublicId,
        customerId: input.customerId,
        partySize: input.partySize ?? 1,
        protectedContact: dbContact,
        termsAcknowledged: true,
        acknowledgedSafetyPolicyVersion: 'safety-v1',
        acknowledgedRefundPolicyVersion: 'refund-v1',
        paymentChoice: 'none',
        paymentMethod: 'native_qr',
        publicId: `registration-package-${input.suffix}`,
        paymentPublicId: `payment-package-${input.suffix}`,
        idempotencyKey: `registration-package-key-${input.suffix}`,
      })
    ))
  }

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

  it('keeps outbox events distinct when a cancelled free registration is opened for a new cycle', async () => {
    const cycleCustomerId = randomUUID()
    await pool.query(`
      WITH customer AS (
        INSERT INTO mbox.customers(id,tenant_id,store_id,public_id)
        VALUES($1::uuid,$2::uuid,$3::uuid,$4)
        RETURNING id,tenant_id,store_id
      ), membership AS (
        INSERT INTO mbox.customer_memberships(tenant_id,store_id,customer_id,member_no)
        SELECT tenant_id,store_id,id,$5 FROM customer
        RETURNING id,tenant_id,store_id,customer_id
      )
      INSERT INTO mbox.loyalty_accounts(tenant_id,store_id,membership_id,customer_id)
      SELECT tenant_id,store_id,id,customer_id FROM membership
    `, [cycleCustomerId, tenantId, storeId, `customer-${cycleCustomerId}`, `MBX-CYC-${cycleCustomerId.slice(0, 8).toUpperCase()}`])

    const service = new CustomerExperienceService(
      transactions,
      new NormalizedCommandExecutor(transactions),
      { updateProfile: async () => { throw new Error('not used') } },
      false,
    )
    const context = {
      scope: dbScope,
      customerId: cycleCustomerId,
      actorRef: `activity-cycle-test-${cycleCustomerId}`,
      businessDate: '2026-08-25',
    }
    const registrationInput = {
      activityPublicId: 'community-free-db-test',
      activityPackagePublicId: null,
      partySize: 1,
      protectedContact: dbContact,
      termsAcknowledged: true,
      acknowledgedSafetyPolicyVersion: 'safety-v1',
      acknowledgedRefundPolicyVersion: 'refund-v1',
      paymentChoice: 'none' as const,
      paymentMethod: 'native_qr' as const,
    }
    const first = await service.registerActivity(context, {
      ...registrationInput,
      idempotencyKey: `activity-cycle-register-${cycleCustomerId}-1`,
    })
    expect(first.value.status).toBe('confirmed')

    const cancelled = await service.cancelActivity(context, {
      registrationPublicId: first.value.publicId,
      reason: '周期事件测试取消',
      idempotencyKey: `activity-cycle-cancel-${cycleCustomerId}-1`,
    })
    expect(cancelled.value.status).toBe('cancelled')

    const second = await service.registerActivity(context, {
      ...registrationInput,
      idempotencyKey: `activity-cycle-register-${cycleCustomerId}-2`,
    })
    expect(second.value).toMatchObject({ publicId: first.value.publicId, status: 'confirmed' })

    const outbox = await pool.query<{
      message_key: string
      aggregate_version: string
      message_type: string
    }>(`
      SELECT message_key,aggregate_version::text,message_type
      FROM mbox.outbox_messages
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid
        AND aggregate_id=(SELECT id FROM mbox.community_activity_registrations
          WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND public_id=$3)
      ORDER BY created_at,id
    `, [tenantId, storeId, first.value.publicId])
    expect(outbox.rows).toEqual([
      { message_key: expect.stringContaining('community.activity.registered:'), aggregate_version: '1', message_type: 'community.activity.registered.v1' },
      { message_key: expect.stringContaining('community.activity.registration.cancelled:'), aggregate_version: '1', message_type: 'community.activity.registration.cancelled.v1' },
      { message_key: expect.stringMatching(/community\.activity\.registered:[^:]+:2$/), aggregate_version: '2', message_type: 'community.activity.registered.v1' },
    ])
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

  it('rejects a package-required activity when every package is paused instead of silently accepting a ticket-only registration', async () => {
    await expect(registerPackageActivity({
      activityPublicId: 'community-package-required-db',
      activityPackagePublicId: null,
      customerId: requiredPackageCustomerId,
      suffix: 'required-no-selectable-package',
    })).rejects.toMatchObject({
      code: 'ACTIVITY_PACKAGE_SELECTION_REQUIRED',
      statusCode: 409,
    })
    const registrations = await pool.query<{ count: string }>(`
      SELECT count(*)::text AS count
      FROM mbox.community_activity_registrations
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid
        AND activity_id=$3::uuid AND customer_id=$4::uuid
    `, [tenantId, storeId, packageRequiredActivityId, requiredPackageCustomerId])
    expect(registrations.rows[0]).toEqual({ count: '0' })
  })

  it('enforces package member limits at the command boundary for per-person and concurrent per-registration attempts', async () => {
    await expect(registerPackageActivity({
      activityPublicId: 'community-package-limit-db',
      activityPackagePublicId: 'package-limit-per-person',
      customerId: perPersonLimitCustomerId,
      partySize: 2,
      suffix: 'per-person-over-limit',
    })).rejects.toMatchObject({
      code: 'ACTIVITY_PACKAGE_PURCHASE_LIMIT',
      statusCode: 409,
    })

    const concurrentAttempts = await Promise.allSettled([
      registerPackageActivity({
        activityPublicId: 'community-package-limit-db',
        activityPackagePublicId: 'package-limit-per-registration',
        customerId: concurrentPackageLimitCustomerId,
        suffix: 'per-registration-concurrent-a',
      }),
      registerPackageActivity({
        activityPublicId: 'community-package-limit-db',
        activityPackagePublicId: 'package-limit-per-registration',
        customerId: concurrentPackageLimitCustomerId,
        suffix: 'per-registration-concurrent-b',
      }),
    ])
    expect(concurrentAttempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejection = concurrentAttempts.find((result) => result.status === 'rejected')
    expect(rejection).toMatchObject({
      status: 'rejected',
      reason: { code: 'ACTIVITY_PACKAGE_PURCHASE_LIMIT', statusCode: 409 },
    })
    const committed = await pool.query<{ registrations: string; committed_units: string }>(`
      SELECT count(*)::text AS registrations,
        COALESCE(sum(CASE WHEN activity_package_snapshot->>'feeBasis'='per_person'
          THEN party_size ELSE 1 END),0)::text AS committed_units
      FROM mbox.community_activity_registrations
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid
        AND activity_id=$3::uuid AND customer_id=$4::uuid
        AND activity_package_id=(
          SELECT id FROM mbox.community_activity_packages
          WHERE tenant_id=$1::uuid AND store_id=$2::uuid
            AND public_id='package-limit-per-registration'
        )
        AND status IN ('reserved','payment_pending','confirmed','checked_in')
    `, [tenantId, storeId, packageLimitActivityId, concurrentPackageLimitCustomerId])
    expect(committed.rows[0]).toEqual({ registrations: '1', committed_units: '1' })
  })

  it('keeps package capacity and stock scoped to the selected package: a full or out-of-stock package does not block another package', async () => {
    const unavailableError = await registerPackageActivity({
      activityPublicId: 'community-package-isolation-db',
      activityPackagePublicId: 'package-stock-unavailable',
      customerId: unavailableStockCustomerId,
      suffix: 'stock-unavailable',
    }).then(() => null, (error: unknown) => error as Record<string, unknown>)
    expect(unavailableError).toMatchObject({
      code: 'ACTIVITY_PACKAGE_INVENTORY_INSUFFICIENT',
      statusCode: 409,
    })
    const occupied = await registerPackageActivity({
      activityPublicId: 'community-package-isolation-db',
      activityPackagePublicId: 'package-capacity-full',
      customerId: capacityOccupyingCustomerId,
      suffix: 'capacity-occupied',
    })
    expect(occupied).toMatchObject({ status: 'confirmed' })
    const waitlisted = await registerPackageActivity({
      activityPublicId: 'community-package-isolation-db',
      activityPackagePublicId: 'package-capacity-full',
      customerId: capacityWaitlistCustomerId,
      suffix: 'capacity-waitlisted',
    })
    expect(waitlisted).toMatchObject({ status: 'waitlisted' })

    const independentlyAvailable = await registerPackageActivity({
      activityPublicId: 'community-package-isolation-db',
      activityPackagePublicId: 'package-stock-available',
      customerId: availableStockCustomerId,
      suffix: 'stock-available',
    })
    expect(independentlyAvailable).toMatchObject({ status: 'confirmed' })
    const scopedResults = await pool.query<{
      customer_id: string
      package_public_id: string
      status: string
    }>(`
      SELECT registration.customer_id::text,package.public_id AS package_public_id,registration.status
      FROM mbox.community_activity_registrations registration
      JOIN mbox.community_activity_packages package
        ON package.tenant_id=registration.tenant_id AND package.store_id=registration.store_id
       AND package.id=registration.activity_package_id
      WHERE registration.tenant_id=$1::uuid AND registration.store_id=$2::uuid
        AND registration.activity_id=$3::uuid
        AND registration.customer_id=ANY($4::uuid[])
      ORDER BY package.public_id,registration.customer_id
    `, [
      tenantId, storeId, packageIsolationActivityId,
      [capacityOccupyingCustomerId, capacityWaitlistCustomerId, availableStockCustomerId],
    ])
    expect(scopedResults.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ customer_id: capacityOccupyingCustomerId, package_public_id: 'package-capacity-full', status: 'confirmed' }),
      expect.objectContaining({ customer_id: capacityWaitlistCustomerId, package_public_id: 'package-capacity-full', status: 'waitlisted' }),
      expect.objectContaining({ customer_id: availableStockCustomerId, package_public_id: 'package-stock-available', status: 'confirmed' }),
    ]))
    const balances = await pool.query<{ sku: string; on_hand_quantity: number; reserved_quantity: number }>(`
      SELECT item.sku,balance.on_hand_quantity::float8,balance.reserved_quantity::float8
      FROM mbox.inventory_balances balance
      JOIN mbox.inventory_items item
        ON item.tenant_id=balance.tenant_id AND item.store_id=balance.store_id
       AND item.id=balance.inventory_item_id
      WHERE balance.tenant_id=$1::uuid AND balance.store_id=$2::uuid
        AND item.id=ANY($3::uuid[])
      ORDER BY item.sku
    `, [tenantId, storeId, [unavailableStockItemId, availableStockItemId]])
    expect(balances.rows).toEqual([
      { sku: 'ACTIVITY-PACKAGE-AVAILABLE', on_hand_quantity: 2, reserved_quantity: 1 },
      { sku: 'ACTIVITY-PACKAGE-EMPTY', on_hand_quantity: 0, reserved_quantity: 0 },
    ])
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
        activityPackagePublicId: 'package-paid-hold-expiry',
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
    const beforeOnlinePayment = await pool.query<{ reservation_expires_at: string; activity_ends_at: string }>(`
      SELECT reservation.expires_at::text AS reservation_expires_at,activity.ends_at::text AS activity_ends_at
      FROM mbox.community_activity_package_inventory_reservations reservation
      JOIN mbox.community_activity_registrations registration
        ON registration.tenant_id=reservation.tenant_id AND registration.store_id=reservation.store_id
       AND registration.id=reservation.registration_id AND registration.registration_cycle=reservation.registration_cycle
      JOIN mbox.community_activities activity
        ON activity.tenant_id=registration.tenant_id AND activity.store_id=registration.store_id
       AND activity.id=registration.activity_id
      WHERE registration.tenant_id=$1::uuid AND registration.store_id=$2::uuid
        AND registration.public_id=$3 AND reservation.status='reserved'
    `, [tenantId, storeId, registered.publicId])
    expect(Date.parse(beforeOnlinePayment.rows[0]!.reservation_expires_at))
      .toBeLessThan(Date.parse(beforeOnlinePayment.rows[0]!.activity_ends_at))

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
    const onlineFulfilmentHold = await pool.query<{ status: string; expires_at: string; activity_ends_at: string }>(`
      SELECT reservation.status,reservation.expires_at::text,activity.ends_at::text AS activity_ends_at
      FROM mbox.community_activity_package_inventory_reservations reservation
      JOIN mbox.community_activity_registrations registration
        ON registration.tenant_id=reservation.tenant_id AND registration.store_id=reservation.store_id
       AND registration.id=reservation.registration_id AND registration.registration_cycle=reservation.registration_cycle
      JOIN mbox.community_activities activity
        ON activity.tenant_id=registration.tenant_id AND activity.store_id=registration.store_id
       AND activity.id=registration.activity_id
      WHERE registration.tenant_id=$1::uuid AND registration.store_id=$2::uuid
        AND registration.public_id=$3
    `, [tenantId, storeId, registered.publicId])
    expect(onlineFulfilmentHold.rows[0]).toEqual({
      status: 'reserved', expires_at: onlineFulfilmentHold.rows[0]?.activity_ends_at,
      activity_ends_at: onlineFulfilmentHold.rows[0]?.activity_ends_at,
    })

    const manualRegistration = await transactions.run(dbScope, (transaction) => (
      new CustomerExperienceRepository(transaction, true).registerActivity({
        activityPublicId: 'community-paid-db-test', activityPackagePublicId: 'package-paid-hold-expiry',
        customerId: manualCollectionCustomerId, partySize: 1, protectedContact: dbContact,
        termsAcknowledged: true, acknowledgedSafetyPolicyVersion: 'safety-v1',
        acknowledgedRefundPolicyVersion: 'refund-v1', paymentChoice: 'deposit',
        paymentMethod: 'native_qr', publicId: 'registration-paid-manual-hold-db-test',
        paymentPublicId: 'payment-paid-manual-hold-db-test',
        idempotencyKey: 'registration-paid-manual-hold-key-0001',
      })
    ))
    const manualCollection = await transactions.run(dbScope, (transaction) => (
      new PaymentRepository(transaction).recordManualForActivityRegistration({
        registrationPublicId: manualRegistration.publicId,
        publicId: 'activity-manual-paid-hold-db-0001', provider: 'cash', method: 'cash',
        collectedByEmployeeId: approverEmployeeId,
        evidence: { collectedByEmployeeId: approverEmployeeId, receiptReference: 'ACT-CASH-PAID-HOLD-0001' },
      })
    ))
    expect(manualCollection.payment).toMatchObject({ provider: 'cash', status: 'succeeded', amountMinor: 2_000 })
    const manualFulfilmentHold = await pool.query<{ status: string; expires_at: string; activity_ends_at: string }>(`
      SELECT reservation.status,reservation.expires_at::text,activity.ends_at::text AS activity_ends_at
      FROM mbox.community_activity_package_inventory_reservations reservation
      JOIN mbox.community_activity_registrations registration
        ON registration.tenant_id=reservation.tenant_id AND registration.store_id=reservation.store_id
       AND registration.id=reservation.registration_id AND registration.registration_cycle=reservation.registration_cycle
      JOIN mbox.community_activities activity
        ON activity.tenant_id=registration.tenant_id AND activity.store_id=registration.store_id
       AND activity.id=registration.activity_id
      WHERE registration.tenant_id=$1::uuid AND registration.store_id=$2::uuid
        AND registration.public_id=$3
    `, [tenantId, storeId, manualRegistration.publicId])
    expect(manualFulfilmentHold.rows[0]).toEqual({
      status: 'reserved', expires_at: manualFulfilmentHold.rows[0]?.activity_ends_at,
      activity_ends_at: manualFulfilmentHold.rows[0]?.activity_ends_at,
    })

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

    // Public registration IDs are the only identifier the cashier UI has.
    // This is a PostgreSQL regression test for the public-id/uuid boundary,
    // including the one-time authorization consumed by manual recollection.
    const authorization = await transactions.run(dbScope, (transaction) => (
      new ActivityRecollectionAuthorizationRepository(transaction).authorize({
        activityRegistrationPublicId: registered.publicId,
        employeeId: approverEmployeeId,
        reason: '顾客到店确认改用现金付款',
      })
    ))
    expect(authorization.activityRegistrationId).toBe(captured.activityRegistrationId)
    const recollected = await transactions.run(dbScope, (transaction) => (
      new PaymentRepository(transaction).recordManualForActivityRegistration({
        registrationPublicId: registered.publicId,
        publicId: 'activity-manual-recollection-db-0001',
        provider: 'cash', method: 'cash', collectedByEmployeeId: approverEmployeeId,
        evidence: {
          collectedByEmployeeId: approverEmployeeId,
          receiptReference: 'ACT-CASH-RECOLLECT-0001',
        },
      })
    ))
    expect(recollected.payment).toMatchObject({ provider: 'cash', status: 'succeeded', amountMinor: 2_000 })
    const recovered = await pool.query<{
      status: string; payment_status: string; registration_cycle: number; authorization_status: string
      contact_status: string; contact_version: number
    }>(`
      SELECT registration.status,registration.payment_status,registration.registration_cycle,
        recollection.status AS authorization_status,contact.status AS contact_status,
        contact.version AS contact_version
      FROM mbox.community_activity_registrations registration
      JOIN mbox.activity_registration_recollection_authorizations recollection
        ON recollection.tenant_id=registration.tenant_id AND recollection.store_id=registration.store_id
       AND recollection.id=$4::uuid
      JOIN mbox.community_activity_registration_contact_versions contact
        ON contact.tenant_id=registration.tenant_id AND contact.store_id=registration.store_id
       AND contact.registration_id=registration.id AND contact.registration_cycle=registration.registration_cycle
      WHERE registration.tenant_id=$1 AND registration.store_id=$2 AND registration.public_id=$3
    `, [tenantId, storeId, registered.publicId, authorization.id])
    expect(recovered.rows[0]).toEqual({
      status: 'confirmed', payment_status: 'paid', registration_cycle: 1, authorization_status: 'consumed',
      contact_status: 'active', contact_version: 2,
    })
    // Promotion facts are append-only source evidence of the original activity
    // payment. Recollection corrects the same attendance rather than mutating
    // that fact's registration cycle or silently issuing a second promotion.
    const promotion = await pool.query<{ count: string; payment_id: string }>(`
      SELECT count(*)::text AS count, max(payment_id::text) AS payment_id
      FROM mbox.loyalty_promotion_trigger_facts
      WHERE tenant_id=$1 AND store_id=$2 AND trigger_kind='activity_payment'
        AND registration_id=$3::uuid AND registration_cycle=1
    `, [tenantId, storeId, captured.activityRegistrationId])
    expect(promotion.rows[0]).toEqual({ count: '1', payment_id: captured.id })
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
