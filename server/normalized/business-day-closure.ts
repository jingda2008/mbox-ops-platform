import type { AuditActor, AuditEvent, JsonCodec, JsonObject, OutboxMessage } from './command-executor.js'
import type { ScopedTransaction } from './transaction-runner.js'

export type BusinessDayBlockerCode =
  | 'ORDER_UNSETTLED'
  | 'ORDER_ITEM_UNRESOLVED'
  | 'KDS_ACTIVE'
  | 'PAYMENT_PENDING'
  | 'REFUND_PENDING'
  | 'SERVICE_ACTIVE'
  | 'PRICING_RESERVED'
  | 'SONG_ACTIVE'
  | 'BENEFIT_RESERVED'
  | 'EXPERIENCE_ACTIVE'
  | 'REDEMPTION_PENDING'
  | 'CHECKOUT_OFFER_ACTIVE'

export interface BusinessDayTableBlocker {
  tableSessionId: string
  tableCode: string
  code: BusinessDayBlockerCode
  count: number
  label: string
  resolution: string
}

export interface ClosedBusinessDayTable {
  tableSessionId: string
  tableCode: string
  previousStatus: 'open' | 'closing'
  closedAt: string
}

export interface BusinessDayClosureItem {
  businessDayId: string
  businessDate: string
  status: 'closed' | 'awaiting_close'
  closedTableSessions: ClosedBusinessDayTable[]
  blockers: BusinessDayTableBlocker[]
}

export interface BusinessDayClosureResult {
  businessDays: BusinessDayClosureItem[]
  closedBusinessDayCount: number
  closedTableSessionCount: number
  blockedTableSessionCount: number
}

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

interface BlockerCountRow extends Record<string, unknown> {
  order_unsettled: string
  order_item_unresolved: string
  kds_active: string
  payment_pending: string
  refund_pending: string
  service_active: string
  pricing_reserved: string
  song_active: string
  benefit_reserved: string
  experience_active: string
  redemption_pending: string
  checkout_offer_active: string
}

const blockerDefinitions = [
  ['ORDER_UNSETTLED', 'order_unsettled', '仍有未结订单', '请先完成付款、退款或取消订单'],
  ['ORDER_ITEM_UNRESOLVED', 'order_item_unresolved', '仍有未完成出品', '请先完成或取消相关订单行'],
  ['KDS_ACTIVE', 'kds_active', '仍有进行中的出品任务', '请先完成或取消相关出品任务'],
  ['PAYMENT_PENDING', 'payment_pending', '仍有待确认付款', '请先确认付款终态'],
  ['REFUND_PENDING', 'refund_pending', '仍有处理中退款', '请先完成退款流程'],
  ['SERVICE_ACTIVE', 'service_active', '仍有进行中的服务任务', '请先完成或取消服务任务'],
  ['PRICING_RESERVED', 'pricing_reserved', '仍有占用中的定价授权', '请先完成或释放定价授权'],
  ['SONG_ACTIVE', 'song_active', '仍有进行中的点歌请求', '请先完成或取消点歌请求'],
  ['BENEFIT_RESERVED', 'benefit_reserved', '仍有占用中的权益', '请先完成或释放权益'],
  ['EXPERIENCE_ACTIVE', 'experience_active', '仍有进行中的体验计划', '请先完成或结束体验计划'],
  ['REDEMPTION_PENDING', 'redemption_pending', '仍有待履约兑换', '请先完成或取消兑换'],
  ['CHECKOUT_OFFER_ACTIVE', 'checkout_offer_active', '仍有待处理加单报价', '请先接受、拒绝或失效报价'],
] as const satisfies ReadonlyArray<readonly [BusinessDayBlockerCode, keyof BlockerCountRow, string, string]>

export async function closeAwaitingBusinessDays(
  transaction: ScopedTransaction,
  actor: AuditActor,
  closeReason: string,
): Promise<BusinessDayClosureOutcome> {
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
  const result = await transaction.query<BlockerCountRow>(`
    WITH scoped_orders AS (
      SELECT id,status,payment_status
      FROM mbox.orders
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND table_session_id=$3::uuid
    ) SELECT
      (SELECT count(*)::text FROM scoped_orders order_row
        WHERE NOT ((order_row.status='completed'
            AND order_row.payment_status IN ('paid','partially_refunded','refunded'))
          OR (order_row.status='cancelled' AND order_row.payment_status IN ('unpaid','refunded')))) AS order_unsettled,
      (SELECT count(*)::text FROM mbox.order_items item
        WHERE item.tenant_id=$1::uuid AND item.store_id=$2::uuid
          AND item.order_id=ANY(SELECT id FROM scoped_orders)
          AND item.status NOT IN ('delivered','cancelled')) AS order_item_unresolved,
      (SELECT count(*)::text FROM mbox.kds_tasks task
        JOIN mbox.order_items item ON item.tenant_id=task.tenant_id
          AND item.store_id=task.store_id AND item.id=task.order_item_id
        WHERE task.tenant_id=$1::uuid AND task.store_id=$2::uuid
          AND item.order_id=ANY(SELECT id FROM scoped_orders)
          AND (task.status IN ('pending','accepted','preparing')
            OR (task.status='ready' AND item.status<>'delivered')
            OR (task.status='failed' AND item.status<>'cancelled'))) AS kds_active,
      (SELECT count(*)::text FROM mbox.payments payment
        WHERE payment.tenant_id=$1::uuid AND payment.store_id=$2::uuid
          AND payment.order_id=ANY(SELECT id FROM scoped_orders)
          AND payment.status IN ('created','pending')) AS payment_pending,
      (SELECT count(*)::text FROM mbox.refunds refund
        JOIN mbox.payments payment ON payment.tenant_id=refund.tenant_id
          AND payment.store_id=refund.store_id AND payment.id=refund.payment_id
        WHERE refund.tenant_id=$1::uuid AND refund.store_id=$2::uuid
          AND payment.order_id=ANY(SELECT id FROM scoped_orders)
          AND refund.status IN ('requested','approved','processing')) AS refund_pending,
      (SELECT count(*)::text FROM mbox.service_tasks task
        WHERE task.tenant_id=$1::uuid AND task.store_id=$2::uuid
          AND task.table_session_id=$3::uuid
          AND task.status IN ('pending','acknowledged','in_progress')) AS service_active,
      (SELECT count(*)::text FROM mbox.pricing_authorizations pricing_auth
        WHERE pricing_auth.tenant_id=$1::uuid AND pricing_auth.store_id=$2::uuid
          AND pricing_auth.table_session_id=$3::uuid AND pricing_auth.status='reserved') AS pricing_reserved,
      (SELECT count(*)::text FROM mbox.song_requests song
        WHERE song.tenant_id=$1::uuid AND song.store_id=$2::uuid
          AND song.table_session_id=$3::uuid
          AND song.status IN ('requested','confirming','accepted','paid')) AS song_active,
      (SELECT count(*)::text FROM mbox.benefit_reservations reservation
        WHERE reservation.tenant_id=$1::uuid AND reservation.store_id=$2::uuid
          AND reservation.table_session_id=$3::uuid AND reservation.status='reserved') AS benefit_reserved,
      (SELECT count(*)::text FROM mbox.customer_experience_plans plan
        WHERE plan.tenant_id=$1::uuid AND plan.store_id=$2::uuid
          AND plan.table_session_id=$3::uuid
          AND plan.plan_state IN ('planned','active','paused')) AS experience_active,
      (SELECT count(*)::text FROM mbox.member_redemptions redemption
        WHERE redemption.tenant_id=$1::uuid AND redemption.store_id=$2::uuid
          AND redemption.table_session_id=$3::uuid
          AND redemption.status IN ('authorizing','awaiting_fulfillment')) AS redemption_pending,
      (SELECT count(*)::text FROM mbox.checkout_upgrade_offers offer
        WHERE offer.tenant_id=$1::uuid AND offer.store_id=$2::uuid
          AND offer.table_session_id=$3::uuid AND offer.status IN ('offered','selected')) AS checkout_offer_active
  `, [transaction.scope.tenantId, transaction.scope.storeId, session.id])
  const row = result.rows[0]
  if (!row) throw new Error('营业日关台校验未返回结果')
  return blockerDefinitions.flatMap(([code, key, label, resolution]) => {
    const count = Number(row[key])
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('营业日关台校验返回无效计数')
    return count === 0 ? [] : [{
      tableSessionId: session.id,
      tableCode: session.table_code,
      code,
      count,
      label,
      resolution,
    }]
  })
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
