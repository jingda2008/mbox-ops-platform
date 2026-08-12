import { createHash, randomUUID } from 'node:crypto'
import type { GuestBehaviorEventType, GuestBehaviorValue } from '../src/shared/guest-insight-contracts.js'
import type { PostgresPool, PostgresPoolClient } from './postgres-repository.js'

export interface GuestProfileRecord {
  anonymousId: string
  memberId: string | null
  wechatPrincipalId: string | null
  firstSeenAt: string
  lastSeenAt: string
  visitCount: number
}

export interface GuestBehaviorEventRecord {
  id: string
  anonymousId: string
  tableSessionId: string
  tableCode: string
  businessDate: string
  eventType: GuestBehaviorEventType
  source: 'guest_web' | 'miniprogram' | 'service_account' | 'staff_assisted'
  occurredAt: string
  metadata: Record<string, GuestBehaviorValue>
  idempotencyKey: string
}

export interface RecordGuestBehaviorInput extends Omit<GuestBehaviorEventRecord, 'id'> {
  id?: string
}

export interface GuestInsightsStore {
  init(): Promise<void>
  recordEvent(input: RecordGuestBehaviorInput): Promise<GuestBehaviorEventRecord>
  touchProfile(anonymousId: string, occurredAt: string): Promise<void>
  linkIdentity(anonymousId: string, input: { memberId?: string | null; wechatPrincipalId?: string | null }, occurredAt: string): Promise<GuestProfileRecord>
}

export function anonymousVisitId(tableSessionId: string) {
  const hex = createHash('sha256').update(`staff-assisted:${tableSessionId}`).digest('hex').slice(0, 32).split('')
  hex[12] = '4'
  hex[16] = ['8', '9', 'a', 'b'][Number.parseInt(hex[16]!, 16) % 4]!
  return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`
}

function newProfile(anonymousId: string, occurredAt: string): GuestProfileRecord {
  return {
    anonymousId,
    memberId: null,
    wechatPrincipalId: null,
    firstSeenAt: occurredAt,
    lastSeenAt: occurredAt,
    visitCount: 0,
  }
}

export class MemoryGuestInsightsStore implements GuestInsightsStore {
  readonly profiles = new Map<string, GuestProfileRecord>()
  readonly events: GuestBehaviorEventRecord[] = []
  private readonly eventIdsByIdempotencyKey = new Map<string, string>()

  async init() {}

  async recordEvent(input: RecordGuestBehaviorInput) {
    const existingId = this.eventIdsByIdempotencyKey.get(input.idempotencyKey)
    const existing = existingId ? this.events.find((event) => event.id === existingId) : undefined
    if (existing) return structuredClone(existing)
    const profile = this.profiles.get(input.anonymousId) ?? newProfile(input.anonymousId, input.occurredAt)
    profile.lastSeenAt = input.occurredAt
    if (input.eventType === 'session_started') profile.visitCount += 1
    this.profiles.set(input.anonymousId, profile)
    const event: GuestBehaviorEventRecord = { ...structuredClone(input), id: input.id ?? randomUUID() }
    this.events.push(event)
    this.eventIdsByIdempotencyKey.set(input.idempotencyKey, event.id)
    return structuredClone(event)
  }

  async touchProfile(anonymousId: string, occurredAt: string) {
    const profile = this.profiles.get(anonymousId) ?? newProfile(anonymousId, occurredAt)
    if (Date.parse(occurredAt) > Date.parse(profile.lastSeenAt)) profile.lastSeenAt = occurredAt
    this.profiles.set(anonymousId, profile)
  }

  async linkIdentity(anonymousId: string, input: { memberId?: string | null; wechatPrincipalId?: string | null }, occurredAt: string) {
    const profile = this.profiles.get(anonymousId) ?? newProfile(anonymousId, occurredAt)
    profile.memberId = input.memberId === undefined ? profile.memberId : input.memberId
    profile.wechatPrincipalId = input.wechatPrincipalId === undefined ? profile.wechatPrincipalId : input.wechatPrincipalId
    profile.lastSeenAt = occurredAt
    this.profiles.set(anonymousId, profile)
    return structuredClone(profile)
  }
}

const SET_CONTEXT_SQL = `
  SELECT
    set_config('app.tenant_id', $1, true) AS tenant_id,
    set_config('app.store_id', $2, true) AS store_id
`

interface PostgresGuestInsightsOptions {
  pool: PostgresPool
  tenantId: string
  storeId: string
}

export class PostgresGuestInsightsStore implements GuestInsightsStore {
  constructor(private readonly options: PostgresGuestInsightsOptions) {}

  async init() {
    await this.withTransaction(async (client) => {
      await client.query('SELECT anonymous_id FROM mbox.guest_profiles LIMIT 0')
      await client.query('SELECT event_id FROM mbox.guest_behavior_events LIMIT 0')
    })
  }

  async recordEvent(input: RecordGuestBehaviorInput) {
    return this.withTransaction(async (client) => {
      await client.query(`
        INSERT INTO mbox.guest_profiles (
          tenant_id, store_id, anonymous_id, first_seen_at, last_seen_at, visit_count
        ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::timestamptz, $4::timestamptz, 0)
        ON CONFLICT (tenant_id, store_id, anonymous_id)
        DO UPDATE SET last_seen_at = GREATEST(mbox.guest_profiles.last_seen_at, EXCLUDED.last_seen_at)
      `, [this.options.tenantId, this.options.storeId, input.anonymousId, input.occurredAt])
      const eventId = input.id ?? randomUUID()
      const persisted = await client.query<{ event_id: string }>(`
        WITH inserted AS (
          INSERT INTO mbox.guest_behavior_events (
            tenant_id, store_id, event_id, anonymous_id, table_session_id, table_code,
            business_date, event_type, source, occurred_at, metadata, idempotency_key
          ) VALUES (
            $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7::date, $8, $9,
            $10::timestamptz, $11::jsonb, $12
          )
          ON CONFLICT (tenant_id, store_id, idempotency_key) DO NOTHING
          RETURNING event_id
        ), incremented AS (
          UPDATE mbox.guest_profiles
          SET visit_count = visit_count + 1
          WHERE tenant_id = $1::uuid
            AND store_id = $2::uuid
            AND anonymous_id = $4::uuid
            AND $8 = 'session_started'
            AND EXISTS (SELECT 1 FROM inserted)
          RETURNING anonymous_id
        )
        SELECT event_id::text
        FROM inserted
        UNION ALL
        SELECT existing.event_id::text
        FROM mbox.guest_behavior_events existing
        WHERE existing.tenant_id = $1::uuid
          AND existing.store_id = $2::uuid
          AND existing.idempotency_key = $12
          AND NOT EXISTS (SELECT 1 FROM inserted)
        LIMIT 1
      `, [
        this.options.tenantId, this.options.storeId, eventId, input.anonymousId,
        input.tableSessionId, input.tableCode, input.businessDate, input.eventType,
        input.source, input.occurredAt, JSON.stringify(input.metadata), input.idempotencyKey,
      ])
      const persistedEventId = persisted.rows[0]?.event_id
      if (!persistedEventId) throw new Error('客户行为事件写入后无法读取')
      return { ...structuredClone(input), id: persistedEventId }
    })
  }

  async touchProfile(anonymousId: string, occurredAt: string) {
    await this.withTransaction(async (client) => {
      await client.query(`
        INSERT INTO mbox.guest_profiles (
          tenant_id, store_id, anonymous_id, first_seen_at, last_seen_at, visit_count
        ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::timestamptz, $4::timestamptz, 0)
        ON CONFLICT (tenant_id, store_id, anonymous_id)
        DO UPDATE SET last_seen_at = GREATEST(mbox.guest_profiles.last_seen_at, EXCLUDED.last_seen_at)
      `, [this.options.tenantId, this.options.storeId, anonymousId, occurredAt])
    })
  }

  async linkIdentity(anonymousId: string, input: { memberId?: string | null; wechatPrincipalId?: string | null }, occurredAt: string) {
    return this.withTransaction(async (client) => {
      const result = await client.query<{
        anonymous_id: string
        member_id: string | null
        wechat_principal_id: string | null
        first_seen_at: Date | string
        last_seen_at: Date | string
        visit_count: number
      }>(`
        INSERT INTO mbox.guest_profiles (
          tenant_id, store_id, anonymous_id, member_id, wechat_principal_id,
          first_seen_at, last_seen_at, visit_count
        ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::timestamptz, $6::timestamptz, 0)
        ON CONFLICT (tenant_id, store_id, anonymous_id) DO UPDATE SET
          member_id = COALESCE(EXCLUDED.member_id, mbox.guest_profiles.member_id),
          wechat_principal_id = COALESCE(EXCLUDED.wechat_principal_id, mbox.guest_profiles.wechat_principal_id),
          last_seen_at = GREATEST(mbox.guest_profiles.last_seen_at, EXCLUDED.last_seen_at)
        RETURNING anonymous_id::text, member_id, wechat_principal_id, first_seen_at, last_seen_at, visit_count
      `, [this.options.tenantId, this.options.storeId, anonymousId, input.memberId ?? null, input.wechatPrincipalId ?? null, occurredAt])
      const row = result.rows[0]!
      return {
        anonymousId: row.anonymous_id,
        memberId: row.member_id,
        wechatPrincipalId: row.wechat_principal_id,
        firstSeenAt: new Date(row.first_seen_at).toISOString(),
        lastSeenAt: new Date(row.last_seen_at).toISOString(),
        visitCount: Number(row.visit_count),
      }
    })
  }

  private async withTransaction<T>(operation: (client: PostgresPoolClient) => Promise<T>) {
    const client = await this.options.pool.connect()
    let transactionStarted = false
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
      transactionStarted = true
      await client.query(SET_CONTEXT_SQL, [this.options.tenantId, this.options.storeId])
      const result = await operation(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      if (transactionStarted) await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }
}
