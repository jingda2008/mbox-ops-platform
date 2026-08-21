import { describe, expect, it, vi } from 'vitest'
import type { ScopedTransaction } from './transaction-runner.js'
import { BusinessDayRolloverWorker } from './business-day-worker.js'

const scope = {
  tenantId: 'a1000000-0000-4000-8000-000000000001',
  storeId: 'a1000000-0000-4000-8000-000000000002',
}

describe('BusinessDayRolloverWorker', () => {
  it('derives the date in PostgreSQL, rolls the prior day to awaiting close, and opens today', async () => {
    const queries: string[] = []
    const transaction: ScopedTransaction = {
      scope,
      query: vi.fn(async (sql: string) => {
        queries.push(sql)
        if (sql.includes('business_day_cutoff::text')) {
          return { rows: [{ business_date: '2026-08-11', timezone: 'Asia/Shanghai', cutoff: '06:00:00' }], rowCount: 1 }
        }
        if (sql.includes('UPDATE mbox.business_days AS day')) {
          return { rows: [{ id: 'a1000000-0000-4000-8000-000000000010', business_date: '2026-08-10', status: 'awaiting_close' }], rowCount: 1 }
        }
        if (sql.includes('INSERT INTO mbox.business_days')) {
          return { rows: [{ id: 'a1000000-0000-4000-8000-000000000011', business_date: '2026-08-11', status: 'open' }], rowCount: 1 }
        }
        return { rows: [], rowCount: 1 }
      }),
    }
    const transactions = {
      run: vi.fn(async (_scope, operation) => operation(transaction)),
    }
    const worker = new BusinessDayRolloverWorker(transactions as never)
    const result = await worker.run(scope, 'worker:business-day')

    expect(result).toEqual({
      businessDate: '2026-08-11',
      timezone: 'Asia/Shanghai',
      cutoff: '06:00:00',
      created: true,
      rolledOverBusinessDayIds: ['a1000000-0000-4000-8000-000000000010'],
      closure: {
        businessDays: [],
        closedBusinessDayCount: 0,
        closedTableSessionCount: 0,
        blockedTableSessionCount: 0,
      },
    })
    expect(queries.some((sql) => sql.includes('FOR UPDATE SKIP LOCKED'))).toBe(true)
    expect(queries.filter((sql) => sql.includes('INSERT INTO mbox.audit_events'))).toHaveLength(2)
    expect(queries.filter((sql) => sql.includes('INSERT INTO mbox.outbox_messages'))).toHaveLength(2)
  })

  it('is a no-op when the current day already exists and no stale open day remains', async () => {
    const transaction: ScopedTransaction = {
      scope,
      query: vi.fn(async (sql: string) => {
        if (sql.includes('business_day_cutoff::text')) {
          return { rows: [{ business_date: '2026-08-11', timezone: 'Asia/Shanghai', cutoff: '06:00:00' }], rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
      }),
    }
    const worker = new BusinessDayRolloverWorker({
      run: async (_scope, operation) => operation(transaction),
    } as never)
    await expect(worker.run(scope, 'worker:business-day')).resolves.toMatchObject({
      created: false,
      rolledOverBusinessDayIds: [],
      closure: { closedBusinessDayCount: 0,closedTableSessionCount: 0,blockedTableSessionCount: 0 },
    })
  })
})
