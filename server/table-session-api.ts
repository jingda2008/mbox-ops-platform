import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { closeTableSessionSchema, type RuntimeState } from '../src/shared/contracts.js'
import { requireConfiguredOperation, requireTableDataScope } from './authorization.js'
import type { RuntimeRepository } from './repository.js'
import { currentOpenTableSession } from './table-sessions.js'
import { stopAwaitingOrder } from './proactive-service.js'

const openTaskStatuses = new Set(['pending', 'accepted', 'arrived', 'reopened', 'escalated'])
const confirmedPaymentStatuses = new Set(['succeeded', 'reported_pending_reconciliation'])
const pendingRefundStatuses = new Set(['requested', 'approved', 'processing'])

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
