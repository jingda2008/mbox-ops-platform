import { createHash, randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { NormalizedCommandExecutor } from './command-executor.js'
import {
  WaitlistCommandService,
  WaitlistRepository,
  type ProtectedContact,
} from './waitlist-repository.js'
import {
  ScopedPostgresTransactionRunner,
  type PostgresPool,
  type PostgresPoolClient,
} from './transaction-runner.js'

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip

describe('WaitlistRepository validation', () => {
  it('rejects malformed protected contact data before querying PostgreSQL', async () => {
    const repository = new WaitlistRepository({
      scope: { tenantId: randomUUID(), storeId: randomUUID() },
      query: async () => { throw new Error('query reached') },
    })
    await expect(repository.create({
      publicId: 'waitlist-invalid-contact',
      customerName: '王女士',
      contact: { hash: 'not-a-hash', encryptedBase64: 'short', keyId: 'k1', masked: '138****8000' },
      guestCount: 2,
      desiredArrivalAt: '2026-08-12T20:30:00+08:00',
      source: 'wechat',
    })).rejects.toThrow('contact hash is invalid')
  })
})

integration('normalized waitlist concurrency with PostgreSQL', () => {
  let pool: Pool
  let transactions: ScopedPostgresTransactionRunner
  let waitlists: WaitlistCommandService
  let tenantId: string
  let storeId: string
  let customerId: string

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    pool = new Pool({ connectionString: databaseUrl, max: 12 })
    transactions = new ScopedPostgresTransactionRunner(asPool(pool))
    waitlists = new WaitlistCommandService(new NormalizedCommandExecutor(transactions))
    tenantId = randomUUID()
    storeId = randomUUID()
    customerId = randomUUID()
    await pool.query(`
      INSERT INTO mbox.tenants (id, code, name)
      VALUES ($1::uuid, $2, 'Waitlist tenant')
    `, [tenantId, `waitlist-tenant-${tenantId.slice(0, 8)}`])
    await pool.query(`
      INSERT INTO mbox.stores (id, tenant_id, code, name, timezone, business_day_cutoff)
      VALUES ($1::uuid, $2::uuid, $3, 'Waitlist store', 'Asia/Shanghai', '06:00')
    `, [storeId, tenantId, `waitlist-store-${storeId.slice(0, 8)}`])
    await pool.query(`
      INSERT INTO mbox.public_reservation_policies (tenant_id, store_id)
      VALUES ($1::uuid, $2::uuid)
    `, [tenantId, storeId])
    await pool.query(`
      INSERT INTO mbox.customers (id, tenant_id, store_id, public_id)
      VALUES ($1::uuid, $2::uuid, $3::uuid, $4)
    `, [customerId, tenantId, storeId, `customer-${customerId}`])
  })

  afterAll(async () => {
    await pool?.end()
  })

  it('allows only one concurrent active waitlist row per store and contact hash', async () => {
    const contact = protectedContact('13800138000')
    const create = (suffix: string) => waitlists.create({
      scope: { tenantId, storeId },
      actor: { type: 'guest', ref: `guest-${suffix}` },
      businessDate: '2026-08-11',
      idempotencyKey: `waitlist-concurrent-${suffix}`,
      requestFingerprint: `waitlist-concurrent-fingerprint-${suffix}`,
      publicId: `候位-陆家嘴-${suffix}-20260811`,
      customerId,
      customerName: '王女士',
      contact,
      guestCount: 2,
      desiredArrivalAt: '2026-08-11T20:30:00+08:00',
      source: 'wechat',
    })

    const outcomes = await Promise.allSettled([create('A'), create('B')])
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1)

    const stored = await pool.query<{ active: string; audits: string; outbox: string }>(`
      SELECT
        (SELECT count(*)::text FROM mbox.waitlist_entries
          WHERE tenant_id = $1::uuid AND store_id = $2::uuid
            AND status IN ('waiting', 'notified', 'arrived')) AS active,
        (SELECT count(*)::text FROM mbox.audit_events
          WHERE tenant_id = $1::uuid AND store_id = $2::uuid
            AND action = 'waitlist.created') AS audits,
        (SELECT count(*)::text FROM mbox.outbox_messages
          WHERE tenant_id = $1::uuid AND store_id = $2::uuid
            AND message_type = 'waitlist.created.v1') AS outbox
    `, [tenantId, storeId])
    expect(stored.rows[0]).toEqual({ active: '1', audits: '1', outbox: '1' })

    const index = await pool.query<{ indexdef: string }>(`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'mbox' AND indexname = 'waitlist_entries_active_contact_uq'
    `)
    expect(index.rows[0]?.indexdef).toContain("WHERE (status = ANY (ARRAY['waiting'::text, 'notified'::text, 'arrived'::text]))")
  })

  it('permits a new waitlist row only after the earlier active row is closed', async () => {
    const current = await transactions.run({ tenantId, storeId }, async (transaction) => {
      const row = await transaction.query<{ id: string }>(`
        SELECT id FROM mbox.waitlist_entries
        WHERE tenant_id = $1::uuid AND store_id = $2::uuid
          AND status IN ('waiting', 'notified', 'arrived')
        LIMIT 1
      `, [tenantId, storeId])
      return row.rows[0]?.id
    }, { readOnly: true })
    expect(current).toBeTypeOf('string')
    await waitlists.transition({
      scope: { tenantId, storeId },
      actor: { type: 'guest', ref: 'guest-close' },
      businessDate: '2026-08-11',
      idempotencyKey: 'waitlist-cancel-active-0001',
      requestFingerprint: 'waitlist-cancel-active-fingerprint',
      entryId: current!,
      to: 'cancelled',
    })
    await expect(waitlists.create({
      scope: { tenantId, storeId },
      actor: { type: 'guest', ref: 'guest-new' },
      businessDate: '2026-08-11',
      idempotencyKey: 'waitlist-create-after-cancel-0001',
      requestFingerprint: 'waitlist-create-after-cancel-fingerprint',
      publicId: '候位-陆家嘴-C-20260811',
      customerId,
      customerName: '王女士',
      contact: protectedContact('13800138000'),
      guestCount: 3,
      desiredArrivalAt: '2026-08-11T21:30:00+08:00',
      source: 'wechat',
    })).resolves.toMatchObject({ replayed: false })
  })
})

function protectedContact(value: string): ProtectedContact {
  return {
    hash: createHash('sha256').update(value).digest('hex'),
    encryptedBase64: Buffer.from(`encrypted-contact:${value}`).toString('base64'),
    keyId: 'test-key-v1',
    masked: '138****8000',
  }
}

function asPool(pool: Pool): PostgresPool {
  return {
    connect: async () => asClient(await pool.connect()),
    end: () => pool.end(),
  }
}

function asClient(client: PoolClient): PostgresPoolClient {
  return {
    query: (text, values) => client.query(text, values),
    release: (error) => client.release(error),
  }
}
