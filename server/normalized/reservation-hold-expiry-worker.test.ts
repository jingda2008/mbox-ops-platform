import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runNormalizedMigrations } from '../migrate-normalized.js'
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

  constructor(private readonly expiryKind: 'pending_hold' | 'arrival_grace' = 'pending_hold') {}

  async query<Row extends Record<string, unknown>>(
    sql: string,
  ): Promise<PostgresQueryResult<Row>> {
    const normalized = sql.replace(/\s+/g, ' ').trim()
    this.calls.push(normalized)
    if (normalized.startsWith('SELECT reservation.id')) {
      return result([{ id: reservationId, public_id: 'reservation-public-0001', expiry_kind: this.expiryKind }])
    }
    if (normalized.startsWith('UPDATE mbox.reservation_table_locks')) return result([{}])
    if (normalized.startsWith('UPDATE mbox.reservations')) {
      return result([{ aggregate_version: this.expiryKind === 'arrival_grace' ? 3 : 2 }])
    }
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
      noShowReservationIds: [],
    })
    expect(client.calls).toEqual(expect.arrayContaining([
      expect.stringContaining('FOR UPDATE OF reservation SKIP LOCKED LIMIT $3'),
      expect.stringContaining("SET status = 'expired', hold_expires_at = NULL"),
      expect.stringContaining("SET status = 'cancelled'"),
      expect.stringContaining('aggregate_version = aggregate_version + 1'),
      expect.stringContaining('INSERT INTO mbox.audit_events'),
      expect.stringContaining('INSERT INTO mbox.outbox_messages'),
    ]))
    expect(client.calls.at(-1)).toBe('COMMIT')
  })

  it('ends a confirmed reservation and records no-show after the arrival grace period', async () => {
    const client = new WorkerClient('arrival_grace')
    const worker = new ReservationHoldExpiryWorker(new ScopedPostgresTransactionRunner({
      connect: async () => client,
      end: async () => undefined,
    }))

    const batch = await worker.runBatch(scope, 'reservation-worker-1', 50)

    expect(batch).toEqual({
      workerId: 'reservation-worker-1',
      claimed: 1,
      expiredReservationIds: [],
      noShowReservationIds: [reservationId],
    })
    expect(client.calls).toEqual(expect.arrayContaining([
      expect.stringContaining("reservation.reservation_snapshot->>'arrivalGraceMinutes'"),
      expect.stringContaining("SET status = 'released', hold_expires_at = NULL"),
      expect.stringContaining("SET status = 'no_show', aggregate_version = aggregate_version + 1"),
      expect.stringContaining("'reservation.arrival_grace_expired'"),
      expect.stringContaining("'reservation.no_show.v1'"),
    ]))
    expect(client.calls.at(-1)).toBe('COMMIT')
  })

  it('does not treat an unassigned pending public request as an expired table hold', async () => {
    const client = new WorkerClient()
    const worker = new ReservationHoldExpiryWorker(new ScopedPostgresTransactionRunner({
      connect: async () => client,
      end: async () => undefined,
    }))

    const batch = await worker.runBatch(scope, 'reservation-worker-1', 50)

    expect(batch.claimed).toBe(1)
    expect(client.calls[1]).not.toContain("reservation.source = 'wechat'")
    expect(client.calls[1]).not.toContain("reservation.reservation_snapshot->>'requestHoldMinutes'")
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

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip

integration('ReservationHoldExpiryWorker with PostgreSQL', () => {
  let pool: Pool
  let worker: ReservationHoldExpiryWorker
  const tenantId = randomUUID()
  const storeId = randomUUID()
  const areaId = randomUUID()
  const tableId = randomUUID()
  const dueReservationId = randomUUID()
  const futureReservationId = randomUUID()
  const pendingPublicRequestId = randomUUID()
  const expiredHeldReservationId = randomUUID()

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    pool = new Pool({ connectionString: databaseUrl, max: 4 })
    worker = new ReservationHoldExpiryWorker(new ScopedPostgresTransactionRunner(pool))
    await pool.query(`INSERT INTO mbox.tenants (id, code, name) VALUES ($1, $2, 'Arrival grace tenant')`, [
      tenantId, `arrival-grace-${tenantId.slice(0, 8)}`,
    ])
    await pool.query(`
      INSERT INTO mbox.stores (id, tenant_id, code, name, timezone, business_day_cutoff)
      VALUES ($1, $2, $3, 'Arrival grace store', 'Asia/Shanghai', '06:00')
    `, [storeId, tenantId, `arrival-store-${storeId.slice(0, 8)}`])
    await pool.query(`
      INSERT INTO mbox.public_reservation_policies (tenant_id, store_id, arrival_grace_minutes)
      VALUES ($1, $2, 10)
    `, [tenantId, storeId])
    await pool.query(`
      INSERT INTO mbox.areas (id, tenant_id, store_id, code, name, area_type)
      VALUES ($1, $2, $3, 'TEST', 'Test area', 'indoor')
    `, [areaId, tenantId, storeId])
    await pool.query(`
      INSERT INTO mbox.tables (id, tenant_id, store_id, area_id, code, display_name, capacity)
      VALUES ($1, $2, $3, $4, 'T01', 'Test table', 4)
    `, [tableId, tenantId, storeId, areaId])
    await insertConfirmedReservation(pool, {
      tenantId, storeId, reservationId: dueReservationId,
      publicId: `reservation-due-${dueReservationId}`, arrivalOffsetMinutes: -11,
    })
    await insertConfirmedReservation(pool, {
      tenantId, storeId, reservationId: futureReservationId,
      publicId: `reservation-future-${futureReservationId}`, arrivalOffsetMinutes: 1,
    })
    await insertPendingPublicRequest(pool, {
      tenantId, storeId, reservationId: pendingPublicRequestId,
      publicId: `reservation-pending-${pendingPublicRequestId}`,
    })
    await insertExpiredHeldReservation(pool, {
      tenantId, storeId, tableId, reservationId: expiredHeldReservationId,
      publicId: `reservation-held-${expiredHeldReservationId}`,
    })
  })

  afterAll(async () => pool?.end())

  it('releases only the overdue confirmed reservation once with audit and outbox evidence', async () => {
    const batch = await worker.runBatch({ tenantId, storeId }, 'arrival-grace-integration', 50)
    expect(batch.noShowReservationIds).toEqual([dueReservationId])
    expect(batch.expiredReservationIds).toEqual([expiredHeldReservationId])

    const state = await pool.query<{
      due_status: string
      future_status: string
      pending_public_status: string
      expired_hold_status: string
      expired_hold_version: string
      expired_hold_outbox_version: string
      table_locks: string
      audits: string
      outbox: string
    }>(`
      SELECT
        (SELECT status FROM mbox.reservations WHERE id = $1::uuid) AS due_status,
        (SELECT status FROM mbox.reservations WHERE id = $2::uuid) AS future_status,
        (SELECT status FROM mbox.reservations WHERE id = $3::uuid) AS pending_public_status,
        (SELECT status FROM mbox.reservations WHERE id = $4::uuid) AS expired_hold_status,
        (SELECT aggregate_version::text FROM mbox.reservations WHERE id = $4::uuid) AS expired_hold_version,
        (SELECT aggregate_version::text FROM mbox.outbox_messages
          WHERE aggregate_id = $4::uuid AND message_type = 'reservation.hold_expired.v1') AS expired_hold_outbox_version,
        (SELECT count(*)::text FROM mbox.reservation_table_locks
          WHERE reservation_id IN ($1::uuid, $2::uuid) AND status IN ('held', 'confirmed')) AS table_locks,
        (SELECT count(*)::text FROM mbox.audit_events
          WHERE object_id = $1::text AND action = 'reservation.arrival_grace_expired') AS audits,
        (SELECT count(*)::text FROM mbox.outbox_messages
          WHERE aggregate_id = $1::uuid AND message_type = 'reservation.no_show.v1') AS outbox
    `, [dueReservationId, futureReservationId, pendingPublicRequestId, expiredHeldReservationId])
    expect(state.rows[0]).toEqual({
      due_status: 'no_show', future_status: 'confirmed', pending_public_status: 'pending',
      expired_hold_status: 'cancelled', expired_hold_version: '2', expired_hold_outbox_version: '2', table_locks: '0',
      audits: '1', outbox: '1',
    })

    const replay = await worker.runBatch({ tenantId, storeId }, 'arrival-grace-integration', 50)
    expect(replay.claimed).toBe(0)
  })
})

async function insertConfirmedReservation(pool: Pool, input: {
  tenantId: string
  storeId: string
  reservationId: string
  publicId: string
  arrivalOffsetMinutes: number
}): Promise<void> {
  await pool.query(`
    WITH timing AS (
      SELECT clock_timestamp() + make_interval(mins => $5::integer) AS arrival_at
    )
    INSERT INTO mbox.reservations (
      id, tenant_id, store_id, public_id, customer_name, contact_token,
      guest_count, arrival_at, expected_end_at, status, source, reservation_snapshot
    )
    SELECT $1, $2, $3, $4, 'Test guest', 'contact-token', 2,
      timing.arrival_at, timing.arrival_at + interval '4 hours', 'confirmed', 'wechat',
      jsonb_build_object('arrivalGraceMinutes', 10)
    FROM timing
  `, [
    input.reservationId, input.tenantId, input.storeId, input.publicId,
    input.arrivalOffsetMinutes,
  ])
}

async function insertPendingPublicRequest(pool: Pool, input: {
  tenantId: string
  storeId: string
  reservationId: string
  publicId: string
}): Promise<void> {
  await pool.query(`
    INSERT INTO mbox.reservations (
      id, tenant_id, store_id, public_id, customer_name, contact_token,
      guest_count, arrival_at, expected_end_at, status, source,
      reservation_snapshot, created_at
    ) VALUES (
      $1, $2, $3, $4, 'Pending guest', 'contact-token', 2,
      clock_timestamp() + interval '1 hour', clock_timestamp() + interval '5 hours',
      'pending', 'wechat', jsonb_build_object('requestHoldMinutes', 20),
      clock_timestamp() - interval '30 minutes'
    )
  `, [input.reservationId, input.tenantId, input.storeId, input.publicId])
}

async function insertExpiredHeldReservation(pool: Pool, input: {
  tenantId: string
  storeId: string
  tableId: string
  reservationId: string
  publicId: string
}): Promise<void> {
  await pool.query(`
    WITH timing AS (
      SELECT clock_timestamp() + interval '2 hours' AS arrival_at
    ), inserted AS (
      INSERT INTO mbox.reservations (
        id, tenant_id, store_id, public_id, customer_name, contact_token,
        guest_count, arrival_at, expected_end_at, status, source, reservation_snapshot
      )
      SELECT $1, $2, $3, $4, 'Held guest', 'contact-token', 2,
        timing.arrival_at, timing.arrival_at + interval '4 hours', 'pending', 'phone', '{}'::jsonb
      FROM timing
      RETURNING arrival_at, expected_end_at
    )
    INSERT INTO mbox.reservation_table_locks (
      tenant_id, store_id, reservation_id, table_id, reserved_during, status, hold_expires_at
    )
    SELECT $2, $3, $1, $5, tstzrange(arrival_at, expected_end_at, '[)'), 'held',
      clock_timestamp() - interval '1 minute'
    FROM inserted
  `, [input.reservationId, input.tenantId, input.storeId, input.publicId, input.tableId])
}
