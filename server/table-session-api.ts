import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import {
  closeTableSessionSchema,
  transferTableSessionSchema,
  type RuntimeState,
  type TableTransferRecord,
} from '../src/shared/contracts.js'
import { requireConfiguredOperation, requireTableDataScope } from './authorization.js'
import type { RuntimeRepository } from './repository.js'
import { currentOpenTableSession } from './table-sessions.js'
import { stopAwaitingOrder } from './proactive-service.js'

const openTaskStatuses = new Set(['pending', 'accepted', 'arrived', 'completed', 'reopened', 'escalated'])
const confirmedPaymentStatuses = new Set(['succeeded', 'reported_pending_reconciliation'])
const pendingRefundStatuses = new Set(['requested', 'approved', 'processing'])
const openServiceTaskStatuses = new Set(['pending', 'accepted', 'arrived', 'completed', 'reopened', 'escalated'])
const activeSongStatuses = new Set(['pending_payment', 'paid', 'accepted', 'performing', 'refund_required'])

function activeShiftForTable(state: RuntimeState, employeeId: string, areaId: string) {
  return state.shiftAssignments.some((shift) =>
    shift.employeeId === employeeId &&
    shift.businessDate === state.store.businessDate &&
    shift.status === 'active' &&
    shift.areaIds.includes(areaId),
  )
}

function targetResponsibilityChain(state: RuntimeState, tableId: string) {
  const table = state.tables.find((item) => item.id === tableId)
  if (!table) return []
  return [table.primaryEmployeeId, ...table.backupEmployeeIds].filter((employeeId, index, values) =>
    values.indexOf(employeeId) === index && state.employees.some((employee) =>
      employee.id === employeeId && employee.status === 'active' && employee.online && !employee.paused,
    ),
  )
}

export function transferOpenTableSession(
  state: RuntimeState,
  sourceTableId: string,
  input: ReturnType<typeof transferTableSessionSchema.parse>,
  actorId: string,
  occurredAt: string,
) {
  state.tableTransfers ??= []
  const replay = state.tableTransfers.find((record) => record.idempotencyKey === input.idempotencyKey)
  if (replay) {
    if (
      replay.sourceTableId !== sourceTableId || replay.targetTableId !== input.targetTableId ||
      replay.kind !== input.kind || replay.reason !== input.reason
    ) throw new Error('幂等键已用于不同转桌请求')
    return replay
  }

  if (sourceTableId === input.targetTableId) throw new Error('目标桌不能与原桌相同')
  const source = state.tables.find((table) => table.id === sourceTableId)
  const target = state.tables.find((table) => table.id === input.targetTableId)
  if (!source || source.status !== 'occupied' || !source.openedAt) throw new Error('只有营业中的桌台可以转桌')
  if (!target) throw new Error('目标桌台不存在')
  if (target.status === 'occupied') throw new Error('目标桌已有客人；合台需要使用专用合台流程，不能直接转桌')
  if (target.status === 'reserved') throw new Error('目标桌已被预约锁定，请先由门迎或店长处理预约后再转桌')
  if (target.status === 'paused') throw new Error('目标桌已暂停使用')
  if (target.capacity < source.guestCount) throw new Error(`目标桌容量不足：${source.guestCount}/${target.capacity}`)
  const targetPrimary = state.employees.find((employee) =>
    employee.id === target.primaryEmployeeId && employee.status === 'active',
  )
  if (!targetPrimary || !targetPrimary.online || targetPrimary.paused || !activeShiftForTable(state, targetPrimary.id, target.areaId)) {
    throw new Error('目标桌主服务员当前不可接待，请先完成员工调度')
  }
  if (state.songState.tableSessions.some((session) => session.tableId === target.id && session.status === 'open')) {
    throw new Error('目标桌存在开放桌次，不能转入')
  }

  const session = currentOpenTableSession(state, source.id)
  const guestCount = source.guestCount
  const movedServiceTasks = state.tasks.filter((task) => task.tableId === source.id && openServiceTaskStatuses.has(task.status))
  const movedAwaitingOrderIntents = state.awaitingOrderIntents.filter((intent) =>
    intent.tableId === source.id && intent.status === 'active',
  )
  const movedReservations = state.reservationState?.reservations.filter((reservation) =>
    reservation.tableSessionId === session.id && reservation.status === 'seated',
  ) ?? []
  const movedSongRequests = state.songState.requests.filter((request) =>
    request.tableSessionId === session.id && activeSongStatuses.has(request.status),
  )
  const movedBenefitRedemptions = state.benefitRedemptions.filter((redemption) =>
    redemption.tableSessionId === session.id && redemption.status === 'locked',
  )
  const notifiedEmployeeIds = targetResponsibilityChain(state, target.id)

  session.tableId = target.id
  session.tableCode = target.code
  source.status = 'available'
  source.guestCount = 0
  source.openedAt = null
  target.status = 'occupied'
  target.guestCount = guestCount
  target.openedAt = session.openedAt

  for (const task of movedServiceTasks) {
    task.tableId = target.id
    task.notifiedEmployeeIds = [...new Set([...task.notifiedEmployeeIds, ...notifiedEmployeeIds])]
    task.updatedAt = occurredAt
    state.taskEvents.push({
      id: `event_${randomUUID()}`,
      taskId: task.id,
      type: 'task.table_transferred.v1',
      actorId,
      occurredAt,
      payload: { sourceTableId: source.id, targetTableId: target.id, tableSessionId: session.id },
    })
  }
  for (const intent of movedAwaitingOrderIntents) intent.tableId = target.id
  for (const reservation of movedReservations) {
    reservation.tableId = target.id
    reservation.tableCode = target.code
    reservation.updatedAt = occurredAt
    reservation.revision += 1
  }
  for (const request of movedSongRequests) {
    request.tableId = target.id
    request.tableCode = target.code
    request.updatedAt = occurredAt
    request.revision += 1
  }
  for (const redemption of movedBenefitRedemptions) {
    redemption.tableId = target.id
    redemption.tableOpenedAt = session.openedAt
  }

  const record: TableTransferRecord = {
    id: `table-transfer:${randomUUID()}`,
    tableSessionId: session.id,
    kind: input.kind,
    sourceTableId: source.id,
    sourceTableCode: source.code,
    targetTableId: target.id,
    targetTableCode: target.code,
    guestCount: target.guestCount,
    actorId,
    reason: input.reason,
    occurredAt,
    idempotencyKey: input.idempotencyKey,
    movedServiceTaskIds: movedServiceTasks.map((task) => task.id),
    movedAwaitingOrderIntentIds: movedAwaitingOrderIntents.map((intent) => intent.id),
    movedReservationIds: movedReservations.map((reservation) => reservation.id),
    movedSongRequestIds: movedSongRequests.map((request) => request.id),
    movedBenefitRedemptionIds: movedBenefitRedemptions.map((redemption) => redemption.id),
  }
  state.tableTransfers.push(record)
  state.auditEntries.push({
    id: `audit_${randomUUID()}`,
    actorId,
    action: 'table.transferred.v1',
    objectType: 'tableTransfer',
    objectId: record.id,
    occurredAt,
    details: { ...structuredClone(record) },
  })
  state.revision += 1
  return record
}

function assertSessionCanClose(state: RuntimeState, tableId: string, tableSessionId: string) {
  const openKds = state.orderDomain.kdsTasks.filter((task) =>
    task.tableSessionId === tableSessionId && task.status !== 'delivered',
  )
  if (openKds.length > 0) throw new Error(`仍有${openKds.length}项商品未送达，不能结台`)

  const openTasks = state.tasks.filter((task) => task.tableId === tableId && openTaskStatuses.has(task.status))
  if (openTasks.length > 0) throw new Error(`仍有${openTasks.length}项服务任务未关闭，不能结台`)

  const lockedBenefits = state.benefitRedemptions.filter((item) =>
    item.tableSessionId === tableSessionId && item.status === 'locked',
  )
  if (lockedBenefits.length > 0) throw new Error(`仍有${lockedBenefits.length}项权益锁定未处理，不能结台`)

  const pendingRefunds = state.paymentDomain.refunds.filter((refund) =>
    refund.tableSessionId === tableSessionId && pendingRefundStatuses.has(refund.status),
  )
  if (pendingRefunds.length > 0) throw new Error(`仍有${pendingRefunds.length}笔退款处理中，不能结台`)

  const orders = state.orderDomain.orders.filter((order) => order.tableSessionId === tableSessionId)
  if (orders.some((order) => ['draft', 'authorization_pending'].includes(order.status))) {
    throw new Error('桌次仍有草稿或待授权订单，不能结台')
  }
  const confirmedIntents = state.paymentDomain.paymentIntents.filter((intent) =>
    intent.tableSessionId === tableSessionId && confirmedPaymentStatuses.has(intent.status),
  )
  const completedRefunds = state.paymentDomain.refunds.filter((refund) =>
    refund.tableSessionId === tableSessionId && refund.status === 'succeeded',
  )
  for (const order of orders) {
    for (const item of order.items) {
      const paidQuantity = confirmedIntents.flatMap((intent) => intent.lineAllocations)
        .filter((allocation) => allocation.orderId === order.id && allocation.orderItemId === item.id)
        .reduce((sum, allocation) => sum + allocation.quantity, 0)
      const refundedQuantity = completedRefunds.flatMap((refund) => refund.items)
        .filter((refundItem) => refundItem.orderId === order.id && refundItem.orderItemId === item.id)
        .reduce((sum, refundItem) => sum + refundItem.quantity, 0)
      if (paidQuantity < item.quantity - refundedQuantity) {
        throw new Error(`商品“${item.name}”尚未完成收款，不能结台`)
      }
    }
  }
}

export function registerTableSessionRoutes(app: FastifyInstance, repository: RuntimeRepository) {
  app.post<{ Params: { tableId: string } }>('/api/tables/:tableId/transfer', async (request) => {
    const input = transferTableSessionSchema.parse(request.body)
    return repository.mutate((state) => {
      const actor = requireConfiguredOperation(request, state, 'table.write')
      requireTableDataScope(request, state, request.params.tableId, 'table.write')
      requireTableDataScope(request, state, input.targetTableId, 'table.write')
      return transferOpenTableSession(state, request.params.tableId, input, actor.actorId, new Date().toISOString())
    })
  })

  app.post<{ Params: { tableId: string } }>('/api/tables/:tableId/close', async (request) => {
    const input = closeTableSessionSchema.parse(request.body)
    return repository.mutate((state) => {
      const actor = requireConfiguredOperation(request, state, 'table.close')
      requireTableDataScope(request, state, request.params.tableId, 'table.close')
      const replay = state.auditEntries.find((entry) =>
        entry.action === 'table.closed.v1' && entry.details.idempotencyKey === input.idempotencyKey,
      )
      if (replay) {
        if (replay.objectId !== request.params.tableId) throw new Error('幂等键已用于其他桌台')
        return state.tables.find((table) => table.id === request.params.tableId)
      }
      const table = state.tables.find((item) => item.id === request.params.tableId)
      if (!table || table.status !== 'occupied') throw new Error('只有营业中的桌台可以结台')
      const session = currentOpenTableSession(state, table.id)
      assertSessionCanClose(state, table.id, session.id)
      const activeCare = state.awaitingOrderIntents.find((intent) => intent.tableId === table.id && intent.status === 'active')
      if (activeCare) stopAwaitingOrder(state, table.id, actor.actorId, 'table_closed')
      const closedAt = new Date().toISOString()
      session.status = 'closed'
      session.closedAt = closedAt
      table.status = 'available'
      table.guestCount = 0
      table.openedAt = null
      state.auditEntries.push({
        id: `audit_${randomUUID()}`,
        actorId: actor.actorId,
        action: 'table.closed.v1',
        objectType: 'table',
        objectId: table.id,
        occurredAt: closedAt,
        details: { tableSessionId: session.id, reason: input.reason, idempotencyKey: input.idempotencyKey },
      })
      state.revision += 1
      return table
    })
  })
}
