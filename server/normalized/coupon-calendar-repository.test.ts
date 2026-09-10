import { describe, expect, it, vi } from 'vitest'
import { CouponCalendarRepository } from './coupon-calendar-repository.js'
import type { ScopedTransaction } from './transaction-runner.js'

const scope = { tenantId: '11111111-1111-4111-8111-111111111111', storeId: '22222222-2222-4222-8222-222222222222' }
function setup(size: number) {
  const rows = Array.from({ length: size }, (_, index) => ({
    id: `33333333-3333-4333-8333-${String(index).padStart(12, '0')}`, code: `TEST_${index}`, version: 1,
    timezone: 'Asia/Shanghai', date_basis: 'natural', business_day_start_minute: 0,
    date_from: '2037-09-01', date_through: '2037-09-30', valid_from: '2037-08-31T16:00:00Z', valid_until: '2037-09-30T16:00:00Z',
    weekdays: [1, 2, 3, 4, 5, 6, 7], week_starts_on: 1,
    per_customer_day_limit: index + 1, per_customer_week_limit: null, per_customer_campaign_limit: null,
    created_by_employee_id: '44444444-4444-4444-8444-444444444444', request_fingerprint: 'a'.repeat(64),
  }))
  const query = vi.fn(async (sql: string, values?: readonly unknown[]) => {
    expect(values?.slice(0, 2)).toEqual([scope.tenantId, scope.storeId])
    let result: Record<string, unknown>[]
    if (sql.includes('FROM mbox.benefit_coupon_calendar_bindings')) result = rows.map(row => ({ benefit_id: `benefit-${row.code}`, version_id: row.id }))
    else if (sql.includes('FROM mbox.coupon_calendar_versions')) result = rows
    else if (sql.includes('FROM mbox.coupon_calendar_windows')) result = rows.map((row, index) => ({ version_id: row.id, start_minute: index, end_minute: 1440 }))
    else if (sql.includes('FROM mbox.coupon_calendar_exclusions')) result = rows.slice(0, 1).map(row => ({ version_id: row.id, excluded_date: '2037-09-09' }))
    else if (sql.includes('FROM mbox.coupon_calendar_decisions')) result = rows.slice(0, 1).map(row => ({ version_id: row.id, action: 'stop_issuing', employee_id: row.created_by_employee_id }))
    else throw new Error(`Unexpected query: ${sql}`)
    return { rows: result, rowCount: result.length }
  })
  return { query, repository: new CouponCalendarRepository({ scope, query } as ScopedTransaction), rows }
}

describe('coupon calendar bounded batch reads', () => {
  it('loads 30 versions in four scoped queries without mixing children or decisions', async () => {
    const { query, repository, rows } = setup(30)
    const result = await repository.list()
    expect(query).toHaveBeenCalledTimes(4)
    expect(query.mock.calls[0]![0]).toContain('LIMIT 30')
    expect(result.map(item => item.id)).toEqual(rows.map(row => row.id))
    expect(result[0]).toMatchObject({ status: 'stopped', rule: { excludedDates: ['2037-09-09'] } })
    expect(result[29]).toMatchObject({ status: 'draft', rule: { excludedDates: [], windows: [{ startMinute: 29, endMinute: 1440 }] }, limits: { perCustomerDay: 30 } })
  })

  it('projects 50 wallet rules in five queries with no internal approval data', async () => {
    const { query, repository, rows } = setup(50)
    const result = await repository.walletViews(rows.map(row => `benefit-${row.code}`), new Date('2037-09-09T04:00:00Z'))
    expect(query).toHaveBeenCalledTimes(5)
    expect(result.size).toBe(50)
    expect(result.get('benefit-TEST_0')).toMatchObject({ available: false, limits: { perCustomerDay: 1 } })
    expect(result.get('benefit-TEST_49')).toMatchObject({ available: true, limits: { perCustomerDay: 50 } })
    expect(JSON.stringify([...result.values()])).not.toContain('createdByEmployeeId')
    expect(JSON.stringify([...result.values()])).not.toContain('employee_id')
  })

  it('does not read child relations for an empty list or unbound wallet', async () => {
    const { query, repository } = setup(0)
    expect(await repository.list()).toEqual([])
    expect(query).toHaveBeenCalledTimes(1)
    expect(await repository.walletViews(['unbound'], new Date())).toEqual(new Map())
    expect(query).toHaveBeenCalledTimes(2)
    expect(await repository.walletViews([], new Date())).toEqual(new Map())
    expect(query).toHaveBeenCalledTimes(2)
  })
  it('does not share a calendar projection across coupons with different individual expiry',async()=>{
    const {query,repository,rows}=setup(1)
    query.mockImplementationOnce(async()=>({rows:[
      {benefit_id:'short',version_id:rows[0]!.id,valid_from:'2037-09-01T00:00:00Z',valid_until:'2037-09-08T00:00:00Z'},
      {benefit_id:'long',version_id:rows[0]!.id,valid_from:'2037-09-01T00:00:00Z',valid_until:'2037-09-20T00:00:00Z'},
    ],rowCount:2}))
    const views=await repository.walletViews(['short','long'],new Date('2037-09-10T04:00:00Z'))
    expect(views.get('short')).toMatchObject({available:false,nextAvailableAt:null})
    expect(views.get('long')).toMatchObject({available:true})
    expect(query).toHaveBeenCalledTimes(5)
  })
})
