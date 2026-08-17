import { describe, expect, it } from 'vitest'
import { CustomerExperienceRepository } from './customer-experience-repository.js'
import type { ScopedTransaction } from './transaction-runner.js'

const scope = {
  tenantId: '89000000-0000-4000-8000-000000000001',
  storeId: '89000000-0000-4000-8000-000000000002',
}
const customerId = '89000000-0000-4000-8000-000000000003'
const membershipId = '89000000-0000-4000-8000-000000000004'

describe('public loyalty projection', () => {
  it('uses typed sources and progress while redacting internal reasons and worker details', async () => {
    const statements: Array<{ sql: string; values: readonly unknown[] }> = []
    const transaction: ScopedTransaction = {
      scope,
      async query<Row extends Record<string, unknown>>(sql: string, values: readonly unknown[] = []) {
        statements.push({ sql, values })
        if (sql.includes('SELECT membership.id, membership.member_no')) {
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
})

function result<Row extends Record<string, unknown>>(rows: Row[]) {
  return { rows, rowCount: rows.length }
}
