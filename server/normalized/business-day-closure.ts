import type { AuditActor, AuditEvent, JsonCodec, JsonObject, OutboxMessage } from './command-executor.js'
import type { ScopedTransaction } from './transaction-runner.js'
import { assertEmployeeEffectivePermission } from './employee-table-access.js'
import type {
  BusinessDayBlockerCode,
  BusinessDayBlockerTarget,
  BusinessDayClosureItem,
  BusinessDayClosureResult,
  BusinessDayTableBlocker,
} from '../../src/shared/business-day-closure-contracts.js'
import { readBusinessDayBlockerFacts } from './business-day-blocker-facts.js'
import {
  readTableSessionClosureState,
} from './table-session-closure-blockers.js'

export type {
  BusinessDayBlockerCode,
  BusinessDayBlockerTarget,
  BusinessDayClosureItem,
  BusinessDayClosureResult,
  BusinessDayTableBlocker,
  ClosedBusinessDayTable,
} from '../../src/shared/business-day-closure-contracts.js'

export interface BusinessDayClosureOutcome {
  result: BusinessDayClosureResult
  auditEvents: AuditEvent[]
  outboxMessages: OutboxMessage[]
}

interface BusinessDayRow extends Record<string, unknown> {
  id: string
  business_date: string
}

interface ActiveSessionRow extends Record<string, unknown> {
  id: string
  table_code: string
  status: 'open' | 'closing'
}

interface ClosedSessionRow extends Record<string, unknown> {
  id: string
  closed_at: string
}

export async function closeAwaitingBusinessDays(
  transaction: ScopedTransaction,
  actor: AuditActor,
  closeReason: string,
): Promise<BusinessDayClosureOutcome> {
  if (actor.type === 'employee') {
    await assertEmployeeEffectivePermission(transaction, actor.employeeId, 'business_day.close')
  }
  const businessDays = await lockAwaitingBusinessDays(transaction)
  const items: BusinessDayClosureItem[] = []
  const auditEvents: AuditEvent[] = []
  const outboxMessages: OutboxMessage[] = []

  for (const day of businessDays) {
    const sessions = await lockActiveSessions(transaction, day.business_date)
    const blockers: BusinessDayTableBlocker[] = []
    const safeSessions: ActiveSessionRow[] = []

    for (const session of sessions) {
      const sessionBlockers = await readSessionBlockers(transaction, session)
      blockers.push(...sessionBlockers)
      if (sessionBlockers.length === 0) safeSessions.push(session)
    }

    const closedSessions = await closeSafeSessions(transaction, safeSessions, actor)
    for (const session of closedSessions) {
      const before = safeSessions.find((candidate) => candidate.id === session.id)!
      auditEvents.push({
        actor,
        action: 'table_session.closed_by_business_day',
        objectType: 'table_session',
        objectId: session.id,
        businessDate: day.business_date,
        beforeData: { status: before.status, tableCode: before.table_code },
        afterData: { status: 'closed', tableCode: before.table_code, closedAt: session.closed_at },
        reason: closeReason,
      })
      outboxMessages.push({
        businessEventKey: `business-day-table-closed:${session.id}`,
        aggregateType: 'table_session',
        aggregateId: session.id,
        aggregateVersion: 3,
        eventType: 'table_session.closed.v1',
        payload: {
          tableSessionId: session.id,
          tableCode: before.table_code,
          businessDate: day.business_date,
          status: 'closed',
          closedAt: session.closed_at,
          closeReason,
        },
      })
    }

    const status = blockers.length === 0 ? 'closed' as const : 'awaiting_close' as const
    const item: BusinessDayClosureItem = {
      businessDayId: day.id,
      businessDate: day.business_date,
      status,
      closedTableSessions: closedSessions.map((session) => {
        const before = safeSessions.find((candidate) => candidate.id === session.id)!
        return {
          tableSessionId: session.id,
          tableCode: before.table_code,
          previousStatus: before.status,
          closedAt: session.closed_at,
        }
      }),
      blockers,
    }
    items.push(item)

    if (status === 'closed') {
      const closedAt = await closeBusinessDay(transaction, day.id, actor, closeReason)
      auditEvents.push({
        actor,
        action: 'business_day.closed',
        objectType: 'business_day',
        objectId: day.id,
        businessDate: day.business_date,
        beforeData: { status: 'awaiting_close' },
        afterData: { status: 'closed', closedAt },
        reason: closeReason,
      })
      outboxMessages.push({
        businessEventKey: `business-day-closed:${day.id}`,
        aggregateType: 'business_day',
        aggregateId: day.id,
        aggregateVersion: 2,
        eventType: 'business_day.closed.v1',
        payload: {
          businessDayId: day.id,
          businessDate: day.business_date,
          status: 'closed',
          closedAt,
          closeReason,
        },
      })
    }
  }

  return {
    result: summarize(items),
    auditEvents,
    outboxMessages,
  }
}

async function lockAwaitingBusinessDays(transaction: ScopedTransaction): Promise<BusinessDayRow[]> {
  const result = await transaction.query<BusinessDayRow>(`
    SELECT id, business_date::text
    FROM mbox.business_days
    WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND status='awaiting_close'
    ORDER BY business_date,id
    FOR UPDATE
    LIMIT 50
  `, [transaction.scope.tenantId, transaction.scope.storeId])
  return result.rows
}

async function lockActiveSessions(
  transaction: ScopedTransaction,
  businessDate: string,
): Promise<ActiveSessionRow[]> {
  const result = await transaction.query<ActiveSessionRow>(`
    SELECT session.id, venue_table.code AS table_code, session.status
    FROM mbox.table_sessions session
    JOIN mbox.tables venue_table ON venue_table.tenant_id=session.tenant_id
      AND venue_table.store_id=session.store_id AND venue_table.id=session.table_id
    WHERE session.tenant_id=$1::uuid AND session.store_id=$2::uuid
      AND session.business_date=$3::date AND session.status IN ('open','closing')
    ORDER BY session.id
    FOR UPDATE OF session
  `, [transaction.scope.tenantId, transaction.scope.storeId, businessDate])
  return result.rows
}

async function readSessionBlockers(
  transaction: ScopedTransaction,
  session: ActiveSessionRow,
): Promise<BusinessDayTableBlocker[]> {
  const state = await readTableSessionClosureState(transaction, session.id)
  const blockers: BusinessDayTableBlocker[] = []
  for (const { code, count, label, resolution } of state.blockers) {
    blockers.push({
      tableSessionId: session.id,
      tableCode: session.table_code,
      code,
      count,
      label,
      resolution,
      target: businessDayBlockerTarget(code, session),
      facts: await readBusinessDayBlockerFacts(transaction, session.id, code),
    })
  }
  return blockers
}

function businessDayBlockerTarget(
  code: BusinessDayBlockerCode,
  session: ActiveSessionRow,
): BusinessDayBlockerTarget {
  const focus = code === 'ORDER_ITEM_UNRESOLVED' || code === 'KDS_ACTIVE'
    ? 'fulfillment'
    : code === 'PAYMENT_PENDING'
      ? 'payments'
      : code === 'REFUND_PENDING'
        ? 'refunds'
        : code === 'INVENTORY_RESERVED'
          ? 'inventory'
          : code === 'ORDER_UNSETTLED'
            ? 'orders'
            : 'table_exception'
  return {
    route: focus === 'table_exception' ? '/staff/live' : '/staff/payments',
    focus,
    tableSessionId: session.id,
    tableCode: session.table_code,
    query: session.table_code,
  }
}

async function closeSafeSessions(
  transaction: ScopedTransaction,
  sessions: readonly ActiveSessionRow[],
  actor: AuditActor,
): Promise<ClosedSessionRow[]> {
  if (sessions.length === 0) return []
  const employeeId = actor.type === 'employee' ? actor.employeeId : null
  const result = await transaction.query<ClosedSessionRow>(`
    UPDATE mbox.table_sessions
    SET status='closed',closed_by_employee_id=$4::uuid,closed_at=clock_timestamp()
    WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=ANY($3::uuid[])
      AND status IN ('open','closing')
    RETURNING id,closed_at::text
  `, [
    transaction.scope.tenantId,
    transaction.scope.storeId,
    sessions.map((session) => session.id),
    employeeId,
  ])
  if (result.rowCount !== sessions.length) throw new Error('营业日安全关台数量发生变化，请重试')
  return result.rows
}

async function closeBusinessDay(
  transaction: ScopedTransaction,
  businessDayId: string,
  actor: AuditActor,
  closeReason: string,
): Promise<string> {
  const employeeId = actor.type === 'employee' ? actor.employeeId : null
  const result = await transaction.query<{ closed_at: string }>(`
    UPDATE mbox.business_days
    SET status='closed',closed_at=clock_timestamp(),closed_by_employee_id=$4::uuid,close_reason=$5
    WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid AND status='awaiting_close'
    RETURNING closed_at::text
  `, [
    transaction.scope.tenantId,
    transaction.scope.storeId,
    businessDayId,
    employeeId,
    closeReason,
  ])
  const row = result.rows[0]
  if (result.rowCount !== 1 || !row) throw new Error('营业日状态已变化，请刷新后重试')
  return row.closed_at
}

function summarize(items: BusinessDayClosureItem[]): BusinessDayClosureResult {
  return {
    businessDays: items,
    closedBusinessDayCount: items.filter((item) => item.status === 'closed').length,
    closedTableSessionCount: items.reduce((sum, item) => sum + item.closedTableSessions.length, 0),
    blockedTableSessionCount: new Set(
      items.flatMap((item) => item.blockers.map((blocker) => blocker.tableSessionId)),
    ).size,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export const businessDayClosureCodec: JsonCodec<BusinessDayClosureResult> = {
  encode: (value) => value as unknown as JsonObject,
  decode: (value) => {
    if (!isRecord(value) || !Array.isArray(value.businessDays)
      || typeof value.closedBusinessDayCount !== 'number'
      || typeof value.closedTableSessionCount !== 'number'
      || typeof value.blockedTableSessionCount !== 'number') {
      throw new TypeError('Stored business-day closure result is invalid')
    }
    return value as unknown as BusinessDayClosureResult
  },
}
