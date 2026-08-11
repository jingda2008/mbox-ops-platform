import { describe, expect, it } from 'vitest'
import type { ScopedTransaction } from './transaction-runner.js'
import {
  buildDailyPerformanceView,
  ScheduleConflictError,
  ScheduleRepository,
  type PerformanceSchedule,
} from './schedule-repository.js'

const tenantId = '20000000-0000-4000-8000-000000000001'
const storeId = '20000000-0000-4000-8000-000000000002'
const performerId = '20000000-0000-4000-8000-000000000003'
const scheduleId = '20000000-0000-4000-8000-000000000004'

class ScriptedTransaction implements ScopedTransaction {
  readonly scope = { tenantId, storeId }
  readonly calls: Array<{ sql: string; values: readonly unknown[] }> = []
  constructor(private readonly responses: Array<{ rows: Record<string, unknown>[]; rowCount?: number }>) {}
  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ) {
    this.calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), values })
    const response = this.responses.shift()
    if (response === undefined) throw new Error('Unexpected query')
    return { rows: response.rows as Row[], rowCount: response.rowCount ?? response.rows.length }
  }
}

describe('ScheduleRepository', () => {
  it('serializes stage timeline edits and rejects an overlap', async () => {
    const transaction = new ScriptedTransaction([
      { rows: [{}], rowCount: 1 },
      { rows: [{ id: performerId }], rowCount: 1 },
      { rows: [{ id: scheduleId }], rowCount: 1 },
    ])
    await expect(new ScheduleRepository(transaction).create({
      performerId,
      startsAt: '2026-08-11T12:30:00.000Z',
      endsAt: '2026-08-11T13:15:00.000Z',
    })).rejects.toBeInstanceOf(ScheduleConflictError)
    expect(transaction.calls[0]?.sql).toContain('pg_advisory_xact_lock')
    expect(transaction.calls[2]?.sql).toContain('starts_at < $4::timestamptz')
  })

  it('derives upcoming, live and next-performer countdown from absolute instants', () => {
    const first = schedule('schedule-one', '2026-08-11T12:30:00.000Z', '2026-08-11T13:15:00.000Z')
    const second = schedule('schedule-two', '2026-08-11T13:35:00.000Z', '2026-08-11T14:20:00.000Z')

    const upcoming = buildDailyPerformanceView(
      'Asia/Shanghai', '2026-08-11', '2026-08-11T12:00:00.000Z', [first, second],
    )
    expect(upcoming).toMatchObject({ phase: 'upcoming', current: null, next: { id: 'schedule-one' }, startsInSeconds: 1800 })

    const live = buildDailyPerformanceView(
      'Asia/Shanghai', '2026-08-11', '2026-08-11T13:00:00.000Z', [first, second],
    )
    expect(live).toMatchObject({
      phase: 'live',
      current: { id: 'schedule-one' },
      next: { id: 'schedule-two' },
      remainingSeconds: 900,
      startsInSeconds: 2100,
    })
  })

  it('queries the supplied business day using the store 06:00 cutoff window', async () => {
    const transaction = new ScriptedTransaction([
      { rows: [{
        timezone: 'Asia/Shanghai',
        business_date: '2026-08-11',
        window_start: '2026-08-10T22:00:00.000Z',
        window_end: '2026-08-11T22:00:00.000Z',
      }] },
      { rows: [] },
    ])
    const view = await new ScheduleRepository(transaction).getDailyView(
      '2026-08-11',
      '2026-08-11T17:30:00.000Z',
    )
    expect(view).toMatchObject({ timezone: 'Asia/Shanghai', localDate: '2026-08-11', phase: 'no_schedule' })
    expect(transaction.calls[0]?.sql).toContain('business_day_cutoff')
    expect(transaction.calls[0]?.values[2]).toBe('2026-08-11')
    expect(transaction.calls[1]?.values.slice(2)).toEqual([
      '2026-08-10T22:00:00.000Z',
      '2026-08-11T22:00:00.000Z',
    ])
  })
})

function schedule(id: string, startsAt: string, endsAt: string): PerformanceSchedule {
  return {
    id,
    performerId,
    performerCode: id,
    performerStageName: id,
    performerProfileSnapshot: {},
    startsAt,
    endsAt,
    status: 'scheduled',
    sortOrder: 0,
    createdAt: startsAt,
    updatedAt: startsAt,
  }
}
