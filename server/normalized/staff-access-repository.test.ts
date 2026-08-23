import { describe, expect, it } from 'vitest'
import {
  StaffAccessDeniedError,
  StaffAccessRepository,
} from './staff-access-repository.js'
import type { ScopedTransaction } from './transaction-runner.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const storeId = '22222222-2222-4222-8222-222222222222'
const employeeId = '33333333-3333-4333-8333-333333333333'

describe('StaffAccessRepository', () => {
  it('applies an active employee deny override before role and employee grants', async () => {
    const transaction = new AccessFixtureTransaction()
    const access = await new StaffAccessRepository(transaction).resolve(
      employeeId,
      '2026-08-11T10:00:00.000Z',
    )

    expect(access.roleCodes).toEqual(['SERVER'])
    expect(access.roleNames).toEqual(['服务员'])
    expect(access.permissions).toEqual(['service.execute'])
    expect(access.deniedPermissions).toEqual(['order.create'])
    expect(access.navigation).toEqual([expect.objectContaining({ code: 'tasks', route: '/staff/tasks' })])
    expect(access.approvalLimits).toEqual([
      expect.objectContaining({ code: 'order.gift', amountMinor: 8800, currency: 'CNY' }),
    ])
    expect(access.dataScopes).toEqual([
      { key: 'area.ids', effect: 'include', value: ['lounge'] },
    ])
  })

  it('fails closed for inactive employees and missing permission', async () => {
    const inactive = new AccessFixtureTransaction('suspended')
    await expect(new StaffAccessRepository(inactive).resolve(employeeId))
      .rejects.toBeInstanceOf(StaffAccessDeniedError)

    const active = new AccessFixtureTransaction()
    await expect(new StaffAccessRepository(active).assertPermission(employeeId, 'refund.approve'))
      .rejects.toBeInstanceOf(StaffAccessDeniedError)
  })

  it('resolves the server-only approval authority id for pricing enforcement', async () => {
    const repository = new StaffAccessRepository(new AccessFixtureTransaction())
    await expect(repository.resolveApprovalAuthority(
      employeeId,
      'order.gift',
      '2026-08-11T10:00:00.000Z',
    )).resolves.toEqual(expect.objectContaining({
      id: '44444444-4444-4444-8444-444444444444',
      code: 'order.gift',
      amountMinor: 8800,
    }))
  })
})

class AccessFixtureTransaction implements ScopedTransaction {
  readonly scope = { tenantId, storeId }

  constructor(private readonly status: 'active' | 'suspended' = 'active') {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(text: string) {
    const sql = text.replace(/\s+/g, ' ').trim()
    if (sql.includes('FROM mbox.employees') && sql.includes('employee_code')) {
      return result<Row>([{
        id: employeeId,
        employee_code: 'tom',
        display_name: 'Tom',
        status: this.status,
      }])
    }
    if (sql.includes('SELECT DISTINCT r.code')) return result<Row>([{ code: 'SERVER', name: '服务员' }])
    if (sql.includes('permission_facts')) {
      return result<Row>([
        { code: 'order.create', role_granted: true, override_granted: true, override_denied: true },
        { code: 'service.execute', role_granted: true, override_granted: false, override_denied: false },
      ])
    }
    if (sql.includes('FROM mbox.role_data_scopes')) {
      return result<Row>([{
        scope_key: 'area.ids', effect: 'include', value_kind: 'text_set',
        boolean_value: null, text_value: null, text_values: ['lounge'],
      }])
    }
    if (sql.includes('FROM mbox.role_approval_limits')) {
      return result<Row>([{
        id: '44444444-4444-4444-8444-444444444444',
        approval_code: 'order.gift',
        amount_minor: '8800',
        currency: 'CNY',
        calculation_mode: 'amount_limit', fixed_amount_minor: null,
        discount_basis_points: null, allow_full_gift: false,
        requires_reason: true, requires_second_actor: false,
      }])
    }
    if (sql.includes('FROM mbox.role_navigation_items')) {
      return result<Row>([{
        navigation_code: 'tasks',
        label: '任务',
        route: '/tasks',
        icon: 'list-checks',
        sort_order: 1,
        display_config: {},
      }])
    }
    throw new Error(`Unexpected SQL: ${sql}`)
  }
}

function result<Row extends Record<string, unknown>>(rows: Record<string, unknown>[]) {
  return Promise.resolve({ rows: rows as Row[], rowCount: rows.length })
}
