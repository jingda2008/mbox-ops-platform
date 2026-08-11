import { createHash } from 'node:crypto'
import type { JsonObject } from './command-executor.js'
import type { ScopedTransaction } from './transaction-runner.js'

export type GuestBehaviorType =
  | 'guest.mood.selected'
  | 'guest.service.requested'
  | 'guest.service.merged'
  | 'guest.service.rate_limited'

export interface GuestBehaviorEvent {
  id: string
  tableSessionId: string
  customerId: string
  behaviorType: GuestBehaviorType
  behaviorCode: string | null
  behaviorData: JsonObject
  occurredAt: string
}

export interface RecordGuestBehaviorInput {
  tableSessionId: string
  customerId: string
  behaviorType: GuestBehaviorType
  behaviorCode?: string | null
  behaviorData?: JsonObject
  actorRef: string
  deviceFingerprint: string
}

interface GuestBehaviorRow extends Record<string, unknown> {
  id: string
  table_session_id: string
  customer_id: string
  behavior_type: GuestBehaviorType
  behavior_code: string | null
  behavior_data: JsonObject
  occurred_at: string
}

export class GuestBehaviorSessionUnavailableError extends Error {
  constructor() {
    super('当前桌次已经结束，请重新扫描桌面二维码')
    this.name = 'GuestBehaviorSessionUnavailableError'
  }
}

export class GuestBehaviorRepository {
  constructor(private readonly transaction: ScopedTransaction) {}

  async record(input: Readonly<RecordGuestBehaviorInput>): Promise<GuestBehaviorEvent> {
    validateInput(input)
    const inserted = await this.transaction.query<GuestBehaviorRow>(`
      INSERT INTO mbox.guest_behavior_events (
        tenant_id, store_id, table_session_id, customer_id,
        behavior_type, behavior_code, behavior_data, actor_ref_hash, device_hash
      )
      SELECT
        $1::uuid, $2::uuid, session.id, membership.customer_id,
        $5, $6, $7::jsonb, $8, $9
      FROM mbox.table_sessions AS session
      JOIN mbox.table_session_customers AS membership
        ON membership.tenant_id = session.tenant_id
       AND membership.store_id = session.store_id
       AND membership.table_session_id = session.id
       AND membership.customer_id = $4::uuid
      WHERE session.tenant_id = $1::uuid
        AND session.store_id = $2::uuid
        AND session.id = $3::uuid
        AND session.status = 'open'
      RETURNING id, table_session_id, customer_id, behavior_type,
        behavior_code, behavior_data, occurred_at::text
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.tableSessionId,
      input.customerId,
      input.behaviorType,
      input.behaviorCode ?? null,
      JSON.stringify(input.behaviorData ?? {}),
      hashGuestBehaviorPrincipal(input.actorRef),
      hashGuestBehaviorPrincipal(input.deviceFingerprint),
    ])
    const row = inserted.rows[0]
    if (inserted.rowCount !== 1 || row === undefined) {
      throw new GuestBehaviorSessionUnavailableError()
    }
    return mapEvent(row)
  }

  async listForTableSession(tableSessionId: string, limit = 100): Promise<GuestBehaviorEvent[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new TypeError('limit must be an integer between 1 and 500')
    }
    const result = await this.transaction.query<GuestBehaviorRow>(`
      SELECT id, table_session_id, customer_id, behavior_type,
        behavior_code, behavior_data, occurred_at::text
      FROM mbox.guest_behavior_events
      WHERE tenant_id = $1::uuid
        AND store_id = $2::uuid
        AND table_session_id = $3::uuid
      ORDER BY occurred_at DESC, id DESC
      LIMIT $4
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      tableSessionId,
      limit,
    ])
    return result.rows.map(mapEvent)
  }
}

export function hashGuestBehaviorPrincipal(value: string): string {
  if (value.trim().length < 8 || value.length > 512) {
    throw new TypeError('Guest behavior principal must contain between 8 and 512 characters')
  }
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function validateInput(input: Readonly<RecordGuestBehaviorInput>): void {
  if (!/^guest\.[a-z0-9_.-]{2,96}$/.test(input.behaviorType)) {
    throw new TypeError('behaviorType has an invalid format')
  }
  if (input.behaviorCode !== undefined && input.behaviorCode !== null
    && !/^[a-z][a-z0-9_.-]{0,63}$/.test(input.behaviorCode)) {
    throw new TypeError('behaviorCode has an invalid format')
  }
  hashGuestBehaviorPrincipal(input.actorRef)
  hashGuestBehaviorPrincipal(input.deviceFingerprint)
}

function mapEvent(row: GuestBehaviorRow): GuestBehaviorEvent {
  return {
    id: row.id,
    tableSessionId: row.table_session_id,
    customerId: row.customer_id,
    behaviorType: row.behavior_type,
    behaviorCode: row.behavior_code,
    behaviorData: row.behavior_data,
    occurredAt: row.occurred_at,
  }
}
