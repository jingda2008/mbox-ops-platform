import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { MemoryPresenceLeaseStore, PostgresPresenceLeaseStore } from './presence-store.js'
import type { PostgresPool, PostgresPoolClient, PostgresQueryResult } from './postgres-repository.js'

const lease = {
  sessionId: 'session-a',
  actorId: 'emp-chen',
  storeId: 'mbox-lujiazui',
  businessDate: '2026-08-09',
  establishedAt: 1_000,
  lastSeenAt: 1_000,
  expiresAt: 91_000,
  sessionExpiresAt: 3_601_000,
}

describe('presence lease store', () => {
  it('touches an active lease without changing its identity', async () => {
    const store = new MemoryPresenceLeaseStore()
    await store.upsert(lease)
    const touched = await store.heartbeat({
      sessionId: lease.sessionId,
      actorId: lease.actorId,
      businessDate: lease.businessDate,
      now: 46_000,
      leaseTtlMs: 90_000,
    })
    expect(touched).toMatchObject({ ...lease, lastSeenAt: 46_000, expiresAt: 136_000 })
    expect(await store.findActive({
      sessionId: lease.sessionId,
      actorId: lease.actorId,
      businessDate: lease.businessDate,
      now: 92_000,
    })).not.toBeNull()
  })

  it('rejects expired and wrong-actor leases and removes stale business days', async () => {
    const store = new MemoryPresenceLeaseStore()
    await store.upsert(lease)
    expect(await store.findActive({ ...lease, actorId: 'emp-other', now: 2_000 })).toBeNull()
    expect(await store.heartbeat({ ...lease, businessDate: '2026-08-10', now: 2_000, leaseTtlMs: 90_000 })).toBeNull()
    expect(await store.removeExpired('2026-08-10', 2_000)).toEqual(['session-a'])
    expect(await store.listActive('2026-08-09', 2_000)).toEqual([])
  })

  it('keeps startup hydration monotonic and rejects identity replacement', async () => {
    const store = new MemoryPresenceLeaseStore()
    await store.upsert({ ...lease, lastSeenAt: 40_000, expiresAt: 130_000 })
    await store.upsert({ ...lease, lastSeenAt: 1_000, expiresAt: 91_000 })

    expect(await store.findActive({ ...lease, now: 120_000 })).toMatchObject({
      actorId: lease.actorId,
      lastSeenAt: 40_000,
      expiresAt: 130_000,
    })
    await expect(store.upsert({ ...lease, actorId: 'emp-other' })).rejects.toThrow(/identity changed/)
  })

  it('persists revocation until the signed session expires and never resumes it', async () => {
    const store = new MemoryPresenceLeaseStore()
    await store.upsert(lease)
    await store.revoke({ sessionId: lease.sessionId, actorId: lease.actorId, now: 2_000 })

    expect(await store.isRevoked(lease)).toBe(true)
    expect(await store.findActive({ ...lease, now: 2_001 })).toBeNull()
    await expect(store.upsert({ ...lease, lastSeenAt: 3_000, expiresAt: 93_000 })).rejects.toThrow(/revoked/)
    await expect(store.upsertMany([{ ...lease, lastSeenAt: 3_000, expiresAt: 93_000 }])).resolves.toBeUndefined()
    expect(await store.isRevoked(lease)).toBe(true)
    expect(await store.removeExpired('2026-08-10', 2_001)).toEqual([])
    expect(await store.removeExpired('2026-08-10', lease.sessionExpiresAt + 1)).toEqual([lease.sessionId])
  })

  it('uses one tenant-scoped PostgreSQL transaction for startup lease hydration', async () => {
    const statements: string[] = []
    const client: PostgresPoolClient = {
      async query<Row extends Record<string, unknown>>(sql: string): Promise<PostgresQueryResult<Row>> {
        statements.push(sql.replace(/\s+/g, ' ').trim())
        return sql.includes('RETURNING session_id')
          ? { rows: [{ session_id: 'session-a' } as Row], rowCount: 1 }
          : { rows: [], rowCount: 0 }
      },
      release: () => undefined,
    }
    const pool: PostgresPool = { connect: async () => client, end: async () => undefined }
    const store = new PostgresPresenceLeaseStore({
      pool,
      tenantId: '00000000-0000-4000-8000-000000000001',
      storeId: '00000000-0000-4000-8000-000000000002',
    })

    await store.upsertMany([lease, { ...lease, sessionId: 'session-b' }])

    expect(statements.filter((sql) => sql.startsWith('BEGIN'))).toHaveLength(1)
    expect(statements.filter((sql) => sql.startsWith('INSERT INTO mbox.staff_presence_leases'))).toHaveLength(2)
    expect(statements.at(-1)).toBe('COMMIT')
  })

  it('defines forced tenant/store isolation and an active-lease index', async () => {
    const sql = await readFile(new URL('../database/migrations/023_staff_presence_leases.sql', import.meta.url), 'utf8')
    expect(sql).toContain('PRIMARY KEY (tenant_id, store_id, session_id)')
    expect(sql).toContain('staff_presence_leases_active_idx')
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY')
    expect(sql).toContain('FORCE ROW LEVEL SECURITY')
    expect(sql).toContain('tenant_id = mbox.current_tenant_id()')
    expect(sql).toContain('store_id = mbox.current_store_id()')
    expect(sql).toContain('revoked_at timestamptz')
  })

  it('uses immutable identity, monotonic timestamps and durable revocation in PostgreSQL', async () => {
    const source = await readFile(new URL('./presence-store.ts', import.meta.url), 'utf8')
    expect(source).toContain('GREATEST(mbox.staff_presence_leases.last_seen_at, EXCLUDED.last_seen_at)')
    expect(source).toContain('mbox.staff_presence_leases.actor_id = EXCLUDED.actor_id')
    expect(source).toContain('mbox.staff_presence_leases.revoked_at IS NULL')
    expect(source).toContain('SET revoked_at = COALESCE')
    expect(source).toContain("to_char(business_date, 'YYYY-MM-DD') AS business_date")
  })
})
