import type { PresenceLease } from '../src/shared/contracts.js'
import type { PostgresPool, PostgresPoolClient } from './postgres-repository.js'

export interface PresenceLeaseKey {
  sessionId: string
  actorId: string
}

export interface PresenceLeaseProbe extends PresenceLeaseKey {
  businessDate: string
  now: number
}

export interface PresenceLeaseHeartbeat extends PresenceLeaseProbe {
  leaseTtlMs: number
}

export interface PresenceLeaseStore {
  upsert(lease: PresenceLease): Promise<void>
  upsertMany(leases: PresenceLease[]): Promise<void>
  findActive(input: PresenceLeaseProbe): Promise<PresenceLease | null>
  heartbeat(input: PresenceLeaseHeartbeat): Promise<PresenceLease | null>
  revoke(input: PresenceLeaseKey & { now: number }): Promise<void>
  isRevoked(input: PresenceLeaseKey): Promise<boolean>
  remove(input: PresenceLeaseKey): Promise<void>
  listActive(businessDate: string, now: number): Promise<PresenceLease[]>
  removeExpired(businessDate: string, now: number): Promise<string[]>
}

interface PostgresPresenceLeaseStoreOptions {
  pool: PostgresPool
  tenantId: string
  storeId: string
}

interface PresenceLeaseRow extends Record<string, unknown> {
  session_id: string
  actor_id: string
  venue_store_code: string
  business_date: Date | string
  established_at: Date | string
  last_seen_at: Date | string
  expires_at: Date | string
  session_expires_at: Date | string
  revoked_at?: Date | string | null
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const SQL = {
  begin: 'BEGIN ISOLATION LEVEL READ COMMITTED',
  commit: 'COMMIT',
  rollback: 'ROLLBACK',
  setContext: `
    SELECT
      set_config('app.tenant_id', $1, true) AS tenant_id,
      set_config('app.store_id', $2, true) AS store_id
  `,
  upsert: `
    INSERT INTO mbox.staff_presence_leases (
      tenant_id, store_id, session_id, actor_id, venue_store_code, business_date,
      established_at, last_seen_at, expires_at, session_expires_at, updated_at
    ) VALUES (
      $1::uuid, $2::uuid, $3, $4, $5, $6::date,
      $7::timestamptz, $8::timestamptz, $9::timestamptz, $10::timestamptz, clock_timestamp()
    )
    ON CONFLICT (tenant_id, store_id, session_id) DO UPDATE SET
      established_at = LEAST(mbox.staff_presence_leases.established_at, EXCLUDED.established_at),
      last_seen_at = GREATEST(mbox.staff_presence_leases.last_seen_at, EXCLUDED.last_seen_at),
      expires_at = LEAST(
        GREATEST(mbox.staff_presence_leases.expires_at, EXCLUDED.expires_at),
        mbox.staff_presence_leases.session_expires_at
      ),
      updated_at = clock_timestamp()
    WHERE mbox.staff_presence_leases.actor_id = EXCLUDED.actor_id
      AND mbox.staff_presence_leases.venue_store_code = EXCLUDED.venue_store_code
      AND mbox.staff_presence_leases.business_date = EXCLUDED.business_date
      AND mbox.staff_presence_leases.session_expires_at = EXCLUDED.session_expires_at
      AND mbox.staff_presence_leases.revoked_at IS NULL
    RETURNING session_id
  `,
  findActive: `
    SELECT session_id, actor_id, venue_store_code, to_char(business_date, 'YYYY-MM-DD') AS business_date,
      established_at, last_seen_at, expires_at, session_expires_at
    FROM mbox.staff_presence_leases
    WHERE tenant_id = $1::uuid
      AND store_id = $2::uuid
      AND session_id = $3
      AND actor_id = $4
      AND business_date = $5::date
      AND expires_at > $6::timestamptz
      AND session_expires_at > $6::timestamptz
      AND revoked_at IS NULL
  `,
  heartbeat: `
    UPDATE mbox.staff_presence_leases
    SET last_seen_at = GREATEST(last_seen_at, $6::timestamptz),
        expires_at = LEAST(GREATEST(expires_at, $7::timestamptz), session_expires_at),
        updated_at = clock_timestamp()
    WHERE tenant_id = $1::uuid
      AND store_id = $2::uuid
      AND session_id = $3
      AND actor_id = $4
      AND business_date = $5::date
      AND expires_at > $6::timestamptz
      AND session_expires_at > $6::timestamptz
      AND revoked_at IS NULL
    RETURNING session_id, actor_id, venue_store_code, to_char(business_date, 'YYYY-MM-DD') AS business_date,
      established_at, last_seen_at, expires_at, session_expires_at
  `,
  remove: `
    DELETE FROM mbox.staff_presence_leases
    WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND session_id = $3 AND actor_id = $4
  `,
  revoke: `
    UPDATE mbox.staff_presence_leases
    SET revoked_at = COALESCE(revoked_at, $5::timestamptz),
        expires_at = LEAST(expires_at, GREATEST(last_seen_at, $5::timestamptz)),
        updated_at = clock_timestamp()
    WHERE tenant_id = $1::uuid
      AND store_id = $2::uuid
      AND session_id = $3
      AND actor_id = $4
    RETURNING session_id
  `,
  isRevoked: `
    SELECT session_id
    FROM mbox.staff_presence_leases
    WHERE tenant_id = $1::uuid
      AND store_id = $2::uuid
      AND session_id = $3
      AND actor_id = $4
      AND revoked_at IS NOT NULL
  `,
  conflictState: `
    SELECT actor_id, revoked_at
    FROM mbox.staff_presence_leases
    WHERE tenant_id = $1::uuid
      AND store_id = $2::uuid
      AND session_id = $3
  `,
  listActive: `
    SELECT session_id, actor_id, venue_store_code, to_char(business_date, 'YYYY-MM-DD') AS business_date,
      established_at, last_seen_at, expires_at, session_expires_at
    FROM mbox.staff_presence_leases
    WHERE tenant_id = $1::uuid
      AND store_id = $2::uuid
      AND business_date = $3::date
      AND expires_at > $4::timestamptz
      AND session_expires_at > $4::timestamptz
      AND revoked_at IS NULL
    ORDER BY actor_id, session_id
  `,
  removeExpired: `
    DELETE FROM mbox.staff_presence_leases
    WHERE tenant_id = $1::uuid
      AND store_id = $2::uuid
      AND (
        (revoked_at IS NULL AND (business_date <> $3::date OR expires_at <= $4::timestamptz OR session_expires_at <= $4::timestamptz))
        OR (revoked_at IS NOT NULL AND session_expires_at <= $4::timestamptz)
      )
    RETURNING session_id
  `,
} as const

function validateLease(lease: PresenceLease) {
  if (!lease.sessionId || !lease.actorId || !lease.storeId || !/^\d{4}-\d{2}-\d{2}$/.test(lease.businessDate)) {
    throw new Error('presence lease identity is invalid')
  }
  if (![lease.establishedAt, lease.lastSeenAt, lease.expiresAt, lease.sessionExpiresAt].every(Number.isSafeInteger)) {
    throw new Error('presence lease timestamps are invalid')
  }
}

function timestamp(value: Date | string) {
  const parsed = new Date(value).getTime()
  if (!Number.isSafeInteger(parsed)) throw new Error('presence lease timestamp is invalid')
  return parsed
}

function businessDate(value: Date | string) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime())) throw new Error('presence lease business date is invalid')
  return parsed.toISOString().slice(0, 10)
}

function fromRow(row: PresenceLeaseRow): PresenceLease {
  return {
    sessionId: row.session_id,
    actorId: row.actor_id,
    storeId: row.venue_store_code,
    businessDate: businessDate(row.business_date),
    establishedAt: timestamp(row.established_at),
    lastSeenAt: timestamp(row.last_seen_at),
    expiresAt: timestamp(row.expires_at),
    sessionExpiresAt: timestamp(row.session_expires_at),
  }
}

export class PostgresPresenceLeaseStore implements PresenceLeaseStore {
  constructor(private readonly options: PostgresPresenceLeaseStoreOptions) {
    if (!UUID_PATTERN.test(options.tenantId) || !UUID_PATTERN.test(options.storeId)) {
      throw new Error('presence store tenant and store ids must be UUIDs')
    }
  }

  async upsert(lease: PresenceLease) {
    validateLease(lease)
    await this.withTransaction(async (client) => {
      await this.upsertWithClient(client, lease, false)
    })
  }

  async upsertMany(leases: PresenceLease[]) {
    leases.forEach(validateLease)
    if (leases.length === 0) return
    await this.withTransaction(async (client) => {
      for (const lease of leases) await this.upsertWithClient(client, lease, true)
    })
  }

  async findActive(input: PresenceLeaseProbe) {
    return this.withTransaction(async (client) => {
      const result = await client.query<PresenceLeaseRow>(SQL.findActive, [
        this.options.tenantId,
        this.options.storeId,
        input.sessionId,
        input.actorId,
        input.businessDate,
        new Date(input.now),
      ])
      return result.rows[0] ? fromRow(result.rows[0]) : null
    })
  }

  async heartbeat(input: PresenceLeaseHeartbeat) {
    if (!Number.isSafeInteger(input.leaseTtlMs) || input.leaseTtlMs <= 0) throw new Error('presence lease TTL is invalid')
    return this.withTransaction(async (client) => {
      const result = await client.query<PresenceLeaseRow>(SQL.heartbeat, [
        this.options.tenantId,
        this.options.storeId,
        input.sessionId,
        input.actorId,
        input.businessDate,
        new Date(input.now),
        new Date(input.now + input.leaseTtlMs),
      ])
      return result.rows[0] ? fromRow(result.rows[0]) : null
    })
  }

  async revoke(input: PresenceLeaseKey & { now: number }) {
    if (!Number.isSafeInteger(input.now)) throw new Error('presence revocation time is invalid')
    await this.withTransaction(async (client) => {
      const result = await client.query<{ session_id: string }>(SQL.revoke, [
        this.options.tenantId,
        this.options.storeId,
        input.sessionId,
        input.actorId,
        new Date(input.now),
      ])
      if (result.rowCount !== 1) throw new Error('presence lease revocation target is missing')
    })
  }

  async isRevoked(input: PresenceLeaseKey) {
    return this.withTransaction(async (client) => {
      const result = await client.query<{ session_id: string }>(SQL.isRevoked, [
        this.options.tenantId,
        this.options.storeId,
        input.sessionId,
        input.actorId,
      ])
      return result.rowCount === 1
    })
  }

  async remove(input: PresenceLeaseKey) {
    await this.withTransaction(async (client) => {
      await client.query(SQL.remove, [this.options.tenantId, this.options.storeId, input.sessionId, input.actorId])
    })
  }

  async listActive(targetBusinessDate: string, now: number) {
    return this.withTransaction(async (client) => {
      const result = await client.query<PresenceLeaseRow>(SQL.listActive, [
        this.options.tenantId,
        this.options.storeId,
        targetBusinessDate,
        new Date(now),
      ])
      return result.rows.map(fromRow)
    })
  }

  async removeExpired(targetBusinessDate: string, now: number) {
    return this.withTransaction(async (client) => {
      const result = await client.query<{ session_id: string }>(SQL.removeExpired, [
        this.options.tenantId,
        this.options.storeId,
        targetBusinessDate,
        new Date(now),
      ])
      return result.rows.map((row) => row.session_id)
    })
  }

  private async withTransaction<T>(operation: (client: PostgresPoolClient) => Promise<T>) {
    const client = await this.options.pool.connect()
    let transactionStarted = false
    let releaseError: Error | boolean | undefined
    try {
      await client.query(SQL.begin)
      transactionStarted = true
      await client.query(SQL.setContext, [this.options.tenantId, this.options.storeId])
      const result = await operation(client)
      await client.query(SQL.commit)
      return result
    } catch (error) {
      if (transactionStarted) {
        try {
          await client.query(SQL.rollback)
        } catch (rollbackError) {
          releaseError = rollbackError instanceof Error ? rollbackError : true
          throw new AggregateError([error, rollbackError], 'Presence transaction and rollback both failed')
        }
      }
      throw error
    } finally {
      client.release(releaseError)
    }
  }

  private async upsertWithClient(client: PostgresPoolClient, lease: PresenceLease, ignoreMatchingRevocation: boolean) {
    const result = await client.query<{ session_id: string }>(SQL.upsert, [
      this.options.tenantId,
      this.options.storeId,
      lease.sessionId,
      lease.actorId,
      lease.storeId,
      lease.businessDate,
      new Date(lease.establishedAt),
      new Date(lease.lastSeenAt),
      new Date(lease.expiresAt),
      new Date(lease.sessionExpiresAt),
    ])
    if (result.rowCount !== 1) {
      if (ignoreMatchingRevocation) {
        const conflict = await client.query<{ actor_id: string; revoked_at: Date | string | null }>(SQL.conflictState, [
          this.options.tenantId,
          this.options.storeId,
          lease.sessionId,
        ])
        if (conflict.rows[0]?.actor_id === lease.actorId && conflict.rows[0].revoked_at) return
      }
      throw new Error('presence lease identity changed or session was revoked')
    }
  }
}

export class MemoryPresenceLeaseStore implements PresenceLeaseStore {
  private readonly leases = new Map<string, PresenceLease>()
  private readonly revokedSessions = new Set<string>()

  async upsert(lease: PresenceLease) {
    validateLease(lease)
    if (this.revokedSessions.has(lease.sessionId)) throw new Error('presence lease identity changed or session was revoked')
    const existing = this.leases.get(lease.sessionId)
    if (existing) {
      if (
        existing.actorId !== lease.actorId || existing.storeId !== lease.storeId
        || existing.businessDate !== lease.businessDate || existing.sessionExpiresAt !== lease.sessionExpiresAt
      ) {
        throw new Error('presence lease identity changed or session was revoked')
      }
      this.leases.set(lease.sessionId, {
        ...existing,
        establishedAt: Math.min(existing.establishedAt, lease.establishedAt),
        lastSeenAt: Math.max(existing.lastSeenAt, lease.lastSeenAt),
        expiresAt: Math.min(Math.max(existing.expiresAt, lease.expiresAt), existing.sessionExpiresAt),
      })
      return
    }
    this.leases.set(lease.sessionId, structuredClone(lease))
  }

  async upsertMany(leases: PresenceLease[]) {
    for (const lease of leases) {
      if (this.revokedSessions.has(lease.sessionId) && this.leases.get(lease.sessionId)?.actorId === lease.actorId) continue
      await this.upsert(lease)
    }
  }

  async findActive(input: PresenceLeaseProbe) {
    const lease = this.leases.get(input.sessionId)
    if (!lease || this.revokedSessions.has(input.sessionId) || lease.actorId !== input.actorId || lease.businessDate !== input.businessDate) return null
    if (lease.expiresAt <= input.now || lease.sessionExpiresAt <= input.now) return null
    return structuredClone(lease)
  }

  async heartbeat(input: PresenceLeaseHeartbeat) {
    const lease = await this.findActive(input)
    if (!lease) return null
    lease.lastSeenAt = Math.max(lease.lastSeenAt, input.now)
    lease.expiresAt = Math.min(Math.max(lease.expiresAt, input.now + input.leaseTtlMs), lease.sessionExpiresAt)
    this.leases.set(lease.sessionId, lease)
    return structuredClone(lease)
  }

  async revoke(input: PresenceLeaseKey & { now: number }) {
    if (!Number.isSafeInteger(input.now)) throw new Error('presence revocation time is invalid')
    const lease = this.leases.get(input.sessionId)
    if (!lease || lease.actorId !== input.actorId) throw new Error('presence lease revocation target is missing')
    this.revokedSessions.add(input.sessionId)
  }

  async isRevoked(input: PresenceLeaseKey) {
    const lease = this.leases.get(input.sessionId)
    return this.revokedSessions.has(input.sessionId) && lease?.actorId === input.actorId
  }

  async remove(input: PresenceLeaseKey) {
    const lease = this.leases.get(input.sessionId)
    if (lease?.actorId === input.actorId) {
      this.leases.delete(input.sessionId)
      this.revokedSessions.delete(input.sessionId)
    }
  }

  async listActive(targetBusinessDate: string, now: number) {
    return [...this.leases.values()]
      .filter((lease) => !this.revokedSessions.has(lease.sessionId) && lease.businessDate === targetBusinessDate && lease.expiresAt > now && lease.sessionExpiresAt > now)
      .sort((left, right) => `${left.actorId}:${left.sessionId}`.localeCompare(`${right.actorId}:${right.sessionId}`))
      .map((lease) => structuredClone(lease))
  }

  async removeExpired(targetBusinessDate: string, now: number) {
    const removed: string[] = []
    for (const [sessionId, lease] of this.leases) {
      const revoked = this.revokedSessions.has(sessionId)
      if (revoked && lease.sessionExpiresAt > now) continue
      if (!revoked && lease.businessDate === targetBusinessDate && lease.expiresAt > now && lease.sessionExpiresAt > now) continue
      this.leases.delete(sessionId)
      this.revokedSessions.delete(sessionId)
      removed.push(sessionId)
    }
    return removed
  }
}
