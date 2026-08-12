import { describe, expect, it } from 'vitest'
import { ReservationHoldExpiryWorker } from './reservation-hold-expiry-worker.js'
import type { PostgresPoolClient, PostgresQueryResult } from './transaction-runner.js'
import { ScopedPostgresTransactionRunner } from './transaction-runner.js'

const scope = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  storeId: '22222222-2222-4222-8222-222222222222',
}
const reservationId = '33333333-3333-4333-8333-333333333333'

class WorkerClient implements PostgresPoolClient {
  readonly calls: string[] = []

  async query<Row extends Record<string, unknown>>(
    sql: string,
  ): Promise<PostgresQueryResult<Row>> {
    const normalized = sql.replace(/\s+/g, ' ').trim()
    this.calls.push(normalized)
    if (normalized.startsWith('SELECT reservation.id')) {
      return result([{ id: reservationId, public_id: 'reservation-public-0001' }])
    }
    if (normalized.startsWith('UPDATE mbox.reservation_table_locks')) return result([{}])
    if (normalized.startsWith('UPDATE mbox.reservations')) return result([{}])
    if (normalized.startsWith('INSERT INTO mbox.audit_events')) return result([{}])
    if (normalized.startsWith('INSERT INTO mbox.outbox_messages')) return result([{}])
    return result([])
  }

  release(): void {}
}

describe('ReservationHoldExpiryWorker', () => {
  it('claims bounded work without blocking and records state, audit and outbox atomically', async () => {
    const client = new WorkerClient()
    const worker = new ReservationHoldExpiryWorker(new ScopedPostgresTransactionRunner({
      connect: async () => client,
      end: async () => undefined,
    }))

    const batch = await worker.runBatch(scope, 'reservation-worker-1', 50)

    expect(batch).toEqual({
      workerId: 'reservation-worker-1',
      claimed: 1,
      expiredReservationIds: [reservationId],
    })
    expect(client.calls).toEqual(expect.arrayContaining([
      expect.stringContaining('FOR UPDATE OF reservation SKIP LOCKED LIMIT $3'),
      expect.stringContaining("SET status = 'expired', hold_expires_at = NULL"),
      expect.stringContaining("SET status = 'cancelled'"),
      expect.stringContaining('INSERT INTO mbox.audit_events'),
      expect.stringContaining('INSERT INTO mbox.outbox_messages'),
    ]))
    expect(client.calls.at(-1)).toBe('COMMIT')
  })

  it('rejects a batch above the SKIP LOCKED safety limit', async () => {
    const worker = new ReservationHoldExpiryWorker(new ScopedPostgresTransactionRunner({
      connect: async () => new WorkerClient(),
      end: async () => undefined,
    }))

    expect(() => worker.runBatch(scope, 'reservation-worker-1', 51))
      .toThrow('batchSize must be an integer between 1 and 50')
  })
})

function result<Row extends Record<string, unknown>>(rows: Row[]): PostgresQueryResult<Row> {
  return { rows, rowCount: rows.length }
}
