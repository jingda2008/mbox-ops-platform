import { describe, expect, it } from 'vitest'
import {
  CustomerExperienceRepository,
  minimumEligibleSpendMinorForGrowth,
} from './customer-experience-repository.js'
import type { ScopedTransaction } from './transaction-runner.js'

const scope = {
  tenantId: '89000000-0000-4000-8000-000000000001',
  storeId: '89000000-0000-4000-8000-000000000002',
}
const customerId = '89000000-0000-4000-8000-000000000003'
const membershipId = '89000000-0000-4000-8000-000000000004'

describe('public loyalty projection', () => {
  it('estimates only eligible spend with the published rounding rule and exact carry',()=>{
    expect(minimumEligibleSpendMinorForGrowth({remainingGrowth:10,numeratorPerMinor:2,denominator:100,
      roundingMode:'floor',carryDenominator:100,carryRemainder:0})).toBe(500)
    expect(minimumEligibleSpendMinorForGrowth({remainingGrowth:10,numeratorPerMinor:2,denominator:100,
      roundingMode:'nearest',carryDenominator:100,carryRemainder:0})).toBe(475)
    expect(minimumEligibleSpendMinorForGrowth({remainingGrowth:10,numeratorPerMinor:2,denominator:100,
      roundingMode:'floor',carryDenominator:100,carryRemainder:20})).toBe(490)
  })
  it('uses typed sources and progress while redacting internal reasons and worker details', async () => {
    const statements: Array<{ sql: string; values: readonly unknown[] }> = []
    const transaction: ScopedTransaction = {
      scope,
      async query<Row extends Record<string, unknown>>(sql: string, values: readonly unknown[] = []) {
        statements.push({ sql, values })
        if (sql.includes('FROM mbox.customer_memberships membership') && sql.includes('AS rolling_growth')) {
          return result<Row>([{
            id: membershipId, member_no: 'MBOX-TEST-001', level: 'member', lifecycle_stage: 'active',
            points_balance: 80, growth_value: 120, pending_recovery_points: 0,
            redemption_status: 'active', visit_count: 2, joined_at: '2026-08-01T00:00:00.000Z',
            evaluation_window_months: null, silver_upgrade_growth: null, silver_retain_growth: null,
            gold_upgrade_growth: null, gold_retain_growth: null, rolling_growth: null,
            period_status: null, period_ends_at: null, grace_ends_at: null,
            expiring_points_30_days: null, next_expiry_at: null,
          }])
        }
        if (sql.includes('FROM mbox.loyalty_point_ledger ledger')) {
          return result<Row>([{
            id: '89000000-0000-4000-8000-000000000005', entry_type: 'earn',
            points_delta: 80, balance_after: 80, source_type: 'order',
            source_reference: 'ORDER-PUBLIC-20260816-001',
            available_at: '2026-08-16T12:00:00.000Z', expires_at: '2028-02-16T12:00:00.000Z',
            policy_version: 3, occurred_at: '2026-08-16T12:00:00.000Z',
            reason: '内部原因含员工姓名和不应公开的客诉备注',
          }])
        }
        if (sql.includes('FROM mbox.loyalty_growth_ledger ledger')) {
          return result<Row>([{
            id: '89000000-0000-4000-8000-000000000006', entry_type: 'reverse',
            growth_delta: -10, balance_after: 110, source_kind: 'refund',
            source_reference: 'REFUND-PUBLIC-20260816-001',
            available_at: '2026-08-16T13:00:00.000Z', policy_version: 3,
            occurred_at: '2026-08-16T13:00:00.000Z',
            reason: '内部退款复核说明不得公开',
          }])
        }
        if (sql.includes('FROM mbox.loyalty_accrual_deferred_orders deferred')) {
          return result<Row>([
            {
              kind: 'accrual', source_reference: 'ORDER-PUBLIC-20260816-002',
              status: 'review_required', occurred_at: '2026-08-16T12:10:00.000Z',
              updated_at: '2026-08-16T12:20:00.000Z', worker_id: 'internal-worker',
              resolution_code: 'processing_failed',
            },
            {
              kind: 'supplement', source_reference: 'ORDER-PUBLIC-20260816-003',
              status: 'not_required', occurred_at: '2026-08-16T12:30:00.000Z',
              updated_at: '2026-08-16T12:40:00.000Z', reason: '员工内部判断',
            },
          ])
        }
        throw new Error(`unexpected query: ${sql}`)
      },
    }

    const loyalty = await new CustomerExperienceRepository(transaction).publicLoyalty(customerId)

    expect(loyalty.points[0]).toMatchObject({
      sourceKind: 'order', sourceReference: 'ORDER-PUBLIC-20260816-001', policyVersion: 3,
      description: '已按付款订单和锁定规则入账',
    })
    expect(loyalty.growth[0]).toMatchObject({
      sourceKind: 'refund', sourceReference: 'REFUND-PUBLIC-20260816-001',
      description: '权威退款确认后按原订单规则冲回成长值',
    })
    expect(loyalty.processing).toEqual([
      expect.objectContaining({
        kind: 'accrual', state: 'manual_review', active: true,
        sourceReference: 'ORDER-PUBLIC-20260816-002',
      }),
      expect.objectContaining({
        kind: 'supplement', state: 'no_action_needed', active: false,
        title: '系统已自动恢复', sourceReference: 'ORDER-PUBLIC-20260816-003',
      }),
    ])
    const serialized = JSON.stringify(loyalty)
    expect(serialized).not.toContain('内部原因')
    expect(serialized).not.toContain('内部退款')
    expect(serialized).not.toContain('internal-worker')
    expect(serialized).not.toContain('processing_failed')
    expect(serialized).not.toContain('员工内部判断')

    const pointSql = statements.find((entry) => entry.sql.includes('loyalty_point_ledger ledger'))!.sql
    const growthSql = statements.find((entry) => entry.sql.includes('loyalty_growth_ledger ledger'))!.sql
    const processingQuery = statements.find((entry) => entry.sql.includes('loyalty_accrual_deferred_orders'))!
    expect(pointSql).not.toContain('ledger.reason')
    expect(growthSql).not.toContain('ledger.reason')
    expect(processingQuery.sql).not.toContain('worker_id')
    expect(processingQuery.sql).not.toContain('resolution_code')
    expect(processingQuery.sql).not.toContain('request.reason')
    expect(processingQuery.values).toEqual([scope.tenantId, scope.storeId, customerId, membershipId])
  })

  it('returns authoritative growth fields and a cross-year annual calendar contract', async () => {
    const transaction: ScopedTransaction = {
      scope,
      async query<Row extends Record<string, unknown>>(sql: string) {
        if (sql.includes('FROM mbox.customer_memberships membership') && sql.includes('AS rolling_growth')) {
          return result<Row>([{
            id: membershipId, customer_id: customerId, member_no: 'MBOX-TEST-002', level: 'silver',
            lifecycle_stage: 'active', points_balance: 80, growth_value: 120,
            pending_recovery_points: 0, redemption_status: 'active', visit_count: 2,
            joined_at: '2026-08-01T00:00:00.000Z', updated_at: '2026-08-25T01:00:00.000Z',
            evaluation_window_months: 12, silver_upgrade_growth: 5000, silver_retain_growth: 3000,
            gold_upgrade_growth: 20000, gold_retain_growth: 12000, rolling_growth: 3680,
            period_status: 'active', period_ends_at: '2027-02-27T23:59:59.000Z', grace_ends_at: null,
            tier_qualification_growth: 3510, growth_numerator: 1, growth_denominator_minor: 100,
            growth_rounding_mode: 'floor', growth_carry_denominator: 100, growth_carry_remainder: 0,
            expiring_points_30_days: null, next_expiry_at: null,
          }])
        }
        if (sql.includes('FROM mbox.loyalty_annual_benefit_policy_versions policy')) {
          expect(sql).toContain('OR grant_row.id IS NOT NULL')
          expect(sql).not.toContain("definition.status='active'")
          const base = {
            policy_id: '89000000-0000-4000-8000-000000000101', policy_version: 7,
            timezone: 'Asia/Shanghai', store_code: 'L01', store_name: 'M-BOX陆家嘴',
            rule_id: '89000000-0000-4000-8000-000000000102', rule_code: 'FESTIVAL_GIFT',
            title: '情人节礼遇', rule_kind: 'festival', eligible_tier: 'silver',
            inherit_to_higher_tiers: true, window_before_days: 1, window_after_days: 1,
            requires_birthday_consent: false, on_site_only: true, requires_table_session: true,
            alcohol_handling: 'staff_compliance_required', stack_group: 'festival_gift', priority: 20,
            inventory_requirement: 'strict_recipe', revocation_policy: 'cancel_before_redeem', feb29_policy: null,
            definition_code: 'festival.gift', definition_name: '节日赠饮',
            definition_display_snapshot: { imageUrl: '/menu/benefits/festival.webp' },
            product_code: 'GIFT-001', product_name: '节日特调',
            substitutes: [{ code: 'NA-001', name: '无酒精特调', reason: '无酒精替代' }],
            consent_status: null, grant_id: null, grant_cycle_key: null,
            grant_window_starts_on: null,grant_window_ends_on: null,
            grant_status: null, benefit_id: null,
            benefit_status: null, benefit_valid_from: null, benefit_valid_until: null,
            daily_snack_claim_status: null, fulfillment_intent_status: null,
          }
          return result<Row>([
            { ...base, cycle_year: 2027, starts_on: '2027-02-14', ends_on: '2027-02-15' },
            { ...base, rule_id: '89000000-0000-4000-8000-000000000103', rule_code: 'BIRTHDAY_GIFT',
              title: '生日礼遇', rule_kind: 'birthday', priority: 10, cycle_year: 2027,
              starts_on: null, ends_on: null, requires_birthday_consent: true,
              consent_status: 'granted', feb29_policy: 'mar01' },
            { ...base, rule_id: '89000000-0000-4000-8000-000000000104', rule_code: 'GOLD_GIFT',
              title: '金卡礼遇', eligible_tier: 'gold', inherit_to_higher_tiers: false,
              cycle_year: 2027, starts_on: '2027-01-10', ends_on: '2027-01-10' },
            { ...base, policy_version: 6,rule_id: '89000000-0000-4000-8000-000000000105',
              rule_code: 'HISTORICAL_GIFT',title: '往期节日礼遇',cycle_year:2026,
              starts_on:'2026-12-25',ends_on:'2026-12-25',grant_id:'89000000-0000-4000-8000-000000000106',
              grant_cycle_key:'2026-12-25',grant_window_starts_on:'2026-12-24',
              grant_window_ends_on:'2026-12-26',grant_status:'fulfilled',
              benefit_id:'89000000-0000-4000-8000-000000000107',benefit_status:'redeemed' },
          ])
        }
        if (sql.includes('FROM mbox.customer_preferences preference')) {
          return result<Row>([{ preference_key: 'birthdayMonthDay', preference_value: '02-29' }])
        }
        return result<Row>([])
      },
    }

    const portal = await new CustomerExperienceRepository(transaction).publicPortal(customerId)
    expect(portal.membership).toMatchObject({
      lifetimeGrowth: 120, qualificationGrowth: 3680, tierQualificationGrowth: 3510,
      estimatedSpendToNextTierMinor: 1_632_000,
      annualBenefitCounts: { preview: 2, granted: 1, available: 0 },
      updatedAt: '2026-08-25T01:00:00.000Z',
    })
    expect(portal.membership?.responseVersion).toMatch(/^[0-9a-f]{24}$/)
    expect(portal.annualBenefitCalendar).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ruleCode: 'FESTIVAL_GIFT', date: '2027-02-14', windowStartsOn: '2027-02-13',
        windowEndsOn: '2027-02-16', status: 'pending', factState: 'preview', cycleKey: '2027:2027-02-14',
        timezone: 'Asia/Shanghai', store: { code: 'L01', name: 'M-BOX陆家嘴' },
        stackGroup: 'festival_gift', priority: 20,
        gift: { code: 'GIFT-001', name: '节日特调' },
        substitutes: [{ code: 'NA-001', name: '无酒精特调', reason: '无酒精替代' }],
        inventoryRequirement: 'strict_recipe', revocationPolicy: 'cancel_before_redeem',
        canApply: false,
      }),
      expect.objectContaining({
        ruleCode: 'BIRTHDAY_GIFT', date: '2027-03-01', status: 'renewal_unlock', factState: 'renewal_unlock',
        dateParser: 'birthday_month_day', canApplyReason: expect.stringContaining('续级后'),
      }),
      expect.objectContaining({
        ruleCode: 'GOLD_GIFT', status: 'tier_invalid', factState: 'tier_invalid',
        canApplyReason: expect.stringContaining('金卡'),
      }),
      expect.objectContaining({
        ruleCode:'HISTORICAL_GIFT',status:'redeemed',factState:'fulfilled',
        cycleKey:'2026-12-25',windowStartsOn:'2026-12-24',windowEndsOn:'2026-12-26',
      }),
    ]))
  })
})

function result<Row extends Record<string, unknown>>(rows: Row[]) {
  return { rows, rowCount: rows.length }
}
