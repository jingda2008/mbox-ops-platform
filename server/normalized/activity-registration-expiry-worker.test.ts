import { describe, expect, it } from 'vitest'
import { ActivityRegistrationExpiryWorker } from './activity-registration-expiry-worker.js'
import type { PostgresPoolClient, PostgresQueryResult } from './transaction-runner.js'
import { ScopedPostgresTransactionRunner } from './transaction-runner.js'

const scope = {
  tenantId: '81000000-0000-4000-8000-000000000001',
  storeId: '81000000-0000-4000-8000-000000000002',
}
const registrationId = '81000000-0000-4000-8000-000000000003'

class ActivityExpiryClient implements PostgresPoolClient {
  readonly calls: string[] = []

  constructor(private readonly state: 'none' | 'unknown' | 'captured' | 'amount_mismatch' | 'terminal') {}

  async query<Row extends Record<string, unknown>>(sql: string): Promise<PostgresQueryResult<Row>> {
    const normalized = sql.replace(/\s+/g, ' ').trim()
    this.calls.push(normalized)
    if (normalized.startsWith('SELECT registration.id')) {
      return result([{
        id: registrationId,
        public_id: 'activity-registration-test-0001',
        payment_id: this.state === 'none' ? null : '81000000-0000-4000-8000-000000000004',
        payment_state: this.state,
        captured_amount_minor: this.state === 'captured' ? '10000' : null,
      }])
    }
    if (normalized.startsWith('UPDATE mbox.community_activity_registrations')) return result([{}])
    if (normalized.startsWith('INSERT INTO mbox.audit_events')) return result([{}])
    if (normalized.startsWith('INSERT INTO mbox.outbox_messages')) return result([{}])
    return result([])
  }

  release(): void {}
}

describe('ActivityRegistrationExpiryWorker', () => {
  it('releases an unpaid seat hold and records auditable evidence', async () => {
    const client = new ActivityExpiryClient('none')
    await expect(workerFor(client).runBatch(scope, 'activity-expiry-test')).resolves.toEqual({
      workerId: 'activity-expiry-test',
      claimed: 1,
      releasedRegistrationIds: [registrationId],
      confirmedRegistrationIds: [],
      reviewRegistrationIds: [],
    })
    expect(client.calls).toEqual(expect.arrayContaining([
      expect.stringContaining('FOR UPDATE OF registration SKIP LOCKED'),
      expect.stringContaining("SET status = 'cancelled', payment_status = 'expired'"),
      expect.stringContaining('INSERT INTO mbox.audit_events'),
      expect.stringContaining('INSERT INTO mbox.outbox_messages'),
    ]))
  })

  it('does not release a seat while the provider payment result is unknown', async () => {
    const client = new ActivityExpiryClient('unknown')
    const batch = await workerFor(client).runBatch(scope, 'activity-expiry-test')
    expect(batch.reviewRegistrationIds).toEqual([registrationId])
    expect(client.calls).toEqual(expect.arrayContaining([
      expect.stringContaining("SET seat_hold_expires_at = clock_timestamp() + interval '15 minutes'"),
      expect.stringContaining('community.activity.payment_review_required'),
    ]))
  })

  it('requires manual review instead of confirming an underpaid deposit', async () => {
    const client = new ActivityExpiryClient('amount_mismatch')
    const batch = await workerFor(client).runBatch(scope, 'activity-expiry-test')
    expect(batch.reviewRegistrationIds).toEqual([registrationId])
    expect(client.calls.some((sql) => sql.includes("SET status = 'confirmed'"))).toBe(false)
  })

  it('releases the hold when the linked payment has been refunded', async () => {
    const client = new ActivityExpiryClient('terminal')
    const batch = await workerFor(client).runBatch(scope, 'activity-expiry-test')
    expect(batch.releasedRegistrationIds).toEqual([registrationId])
    expect(client.calls).toEqual(expect.arrayContaining([
      expect.stringContaining("SET status = 'cancelled', payment_status = 'expired'"),
    ]))
  })

  it('confirms a captured registration instead of expiring it', async () => {
    const client = new ActivityExpiryClient('captured')
    const batch = await workerFor(client).runBatch(scope, 'activity-expiry-test')
    expect(batch.confirmedRegistrationIds).toEqual([registrationId])
    expect(client.calls).toEqual(expect.arrayContaining([
      expect.stringContaining("SET status = 'confirmed', payment_status = 'paid'"),
    ]))
  })
})

function workerFor(client: PostgresPoolClient) {
  return new ActivityRegistrationExpiryWorker(new ScopedPostgresTransactionRunner({
    connect: async () => client,
    end: async () => undefined,
  }))
}

function result<Row extends Record<string, unknown>>(rows: Row[]): PostgresQueryResult<Row> {
  return { rows, rowCount: rows.length }
}
