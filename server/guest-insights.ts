import { createHash, randomUUID } from 'node:crypto'
import type { GuestBehaviorEventType, GuestBehaviorValue } from '../src/shared/guest-insight-contracts.js'
import type { PostgresPool } from './postgres-repository.js'

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

  async linkIdentity(anonymousId: string, input: { memberId?: string | null; wechatPrincipalId?: string | null }, occurredAt: string) {
    const profile = this.profiles.get(anonymousId) ?? newProfile(anonymousId, occurredAt)
    profile.memberId = input.memberId === undefined ? profile.memberId : input.memberId
    profile.wechatPrincipalId = input.wechatPrincipalId === undefined ? profile.wechatPrincipalId : input.wechatPrincipalId
    profile.lastSeenAt = occurredAt
    this.profiles.set(anonymousId, profile)
    return structuredClone(profile)
  }
}

const SCHEMA_SQL = `
CREATE SCHEMA IF NOT EXISTS mbox;
CREATE TABLE IF NOT EXISTS mbox.guest_profiles (
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  anonymous_id uuid NOT NULL,
  member_id text,
  wechat_principal_id text,
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  visit_count integer NOT NULL DEFAULT 0 CHECK (visit_count >= 0),
  PRIMARY KEY (tenant_id, store_id, anonymous_id)
);
CREATE TABLE IF NOT EXISTS mbox.guest_behavior_events (
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  event_id uuid NOT NULL,
  anonymous_id uuid NOT NULL,
  table_session_id text NOT NULL,
  table_code text NOT NULL,
  business_date date NOT NULL,
  event_type text NOT NULL,
  source text NOT NULL,
  occurred_at timestamptz NOT NULL,
  metadata jsonb NOT NULL CHECK (jsonb_typeof(metadata) = 'object'),
  idempotency_key text NOT NULL,
  PRIMARY KEY (tenant_id, store_id, event_id),
  UNIQUE (tenant_id, store_id, idempotency_key),
  FOREIGN KEY (tenant_id, store_id, anonymous_id)
    REFERENCES mbox.guest_profiles (tenant_id, store_id, anonymous_id)
);
CREATE INDEX IF NOT EXISTS guest_behavior_events_profile_time_idx
  ON mbox.guest_behavior_events (tenant_id, store_id, anonymous_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS guest_behavior_events_type_time_idx
  ON mbox.guest_behavior_events (tenant_id, store_id, event_type, occurred_at DESC);
CREATE INDEX IF NOT EXISTS guest_behavior_events_visit_idx
  ON mbox.guest_behavior_events (tenant_id, store_id, table_session_id, occurred_at);
`

interface PostgresGuestInsightsOptions {
  pool: PostgresPool
  tenantId: string
  storeId: string
}

export class PostgresGuestInsightsStore implements GuestInsightsStore {
  constructor(private readonly options: PostgresGuestInsightsOptions) {}

  async init() {
    const client = await this.options.pool.connect()
    try {
      await client.query(SCHEMA_SQL)
    } finally {
      client.release()
    }
  }

  async recordEvent(input: RecordGuestBehaviorInput) {
    const client = await this.options.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`
        INSERT INTO mbox.guest_profiles (
          tenant_id, store_id, anonymous_id, first_seen_at, last_seen_at, visit_count
        ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::timestamptz, $4::timestamptz, 0)
        ON CONFLICT (tenant_id, store_id, anonymous_id)
        DO UPDATE SET last_seen_at = GREATEST(mbox.guest_profiles.last_seen_at, EXCLUDED.last_seen_at)
      `, [this.options.tenantId, this.options.storeId, input.anonymousId, input.occurredAt])
      const eventId = input.id ?? randomUUID()
      const inserted = await client.query<{ event_id: string }>(`
        INSERT INTO mbox.guest_behavior_events (
          tenant_id, store_id, event_id, anonymous_id, table_session_id, table_code,
          business_date, event_type, source, occurred_at, metadata, idempotency_key
        ) VALUES (
          $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7::date, $8, $9,
          $10::timestamptz, $11::jsonb, $12
        )
        ON CONFLICT (tenant_id, store_id, idempotency_key) DO NOTHING
        RETURNING event_id::text
      `, [
        this.options.tenantId, this.options.storeId, eventId, input.anonymousId,
        input.tableSessionId, input.tableCode, input.businessDate, input.eventType,
        input.source, input.occurredAt, JSON.stringify(input.metadata), input.idempotencyKey,
      ])
      if (inserted.rowCount === 1 && input.eventType === 'session_started') {
        await client.query(`
          UPDATE mbox.guest_profiles SET visit_count = visit_count + 1
          WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND anonymous_id = $3::uuid
        `, [this.options.tenantId, this.options.storeId, input.anonymousId])
      }
      await client.query('COMMIT')
      return { ...structuredClone(input), id: inserted.rows[0]?.event_id ?? eventId }
    } catch (error) {
      try { await client.query('ROLLBACK') } catch {}
      throw error
    } finally {
      client.release()
    }
  }

  async linkIdentity(anonymousId: string, input: { memberId?: string | null; wechatPrincipalId?: string | null }, occurredAt: string) {
    const client = await this.options.pool.connect()
    try {
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
    } finally {
      client.release()
    }
  }
}
