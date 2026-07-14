import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { awaitingOrderActionSchema } from '../src/shared/contracts.js'
import type { AwaitingOrderIntent, RuntimeState } from '../src/shared/contracts.js'
import { applyTaskAction, createServiceTask, isOpenTask } from './domain.js'
import type { RuntimeRepository } from './repository.js'

function tableSessionId(state: RuntimeState, tableId: string) {
  return `session:${tableId}:${state.store.businessDate}`
}

function audit(
  state: RuntimeState,
  actorId: string,
  action: string,
  intent: AwaitingOrderIntent,
  details: Record<string, unknown>,
) {
  state.auditEntries.push({
    id: `audit_${randomUUID()}`,
    actorId,
    action,
    objectType: 'awaitingOrderIntent',
    objectId: intent.id,
    occurredAt: new Date().toISOString(),
    details,
  })
  state.revision += 1
}

function activeIntent(state: RuntimeState, tableId: string) {
  return state.awaitingOrderIntents.find((intent) => intent.tableId === tableId && intent.status === 'active')
}

function closeTriggeredTasks(state: RuntimeState, intentId: string, actorId: string, reason: string) {
  for (const task of state.tasks.filter(
    (item) => item.triggerId === intentId && ['pending', 'accepted', 'escalated', 'reopened'].includes(item.status),
  )) {
    applyTaskAction(state, task.id, {
      action: 'cancel',
      actorId,
      note: reason,
      idempotencyKey: `awaiting-order-cancel-${intentId}-${task.id}`,
    })
  }
}

export function startAwaitingOrder(
  state: RuntimeState,
  tableId: string,
  actorId: string,
  idempotencyKey: string,
  now = new Date(),
) {
  const previous = state.auditEntries.find(
    (entry) => entry.action === 'awaiting_order.started.v1' && entry.details.idempotencyKey === idempotencyKey,
  )
  if (previous) {
    const existing = state.awaitingOrderIntents.find((intent) => intent.id === previous.objectId)
    if (existing) return existing
  }

  const table = state.tables.find((item) => item.id === tableId)
  if (!table || table.status !== 'occupied') throw new Error('只能为已开台桌台标记暂未点单')
  if (!state.config.proactiveOrderCare.enabled) throw new Error('待点单主动服务当前未启用')
  if (activeIntent(state, tableId)) throw new Error('该桌台已经处于待点单提醒中')
  if (state.orderDomain.orders.some(
    (order) => order.tableSessionId === tableSessionId(state, tableId) && order.status !== 'draft',
  )) {
    throw new Error('该桌台当前桌次已经产生订单')
  }

  const intent: AwaitingOrderIntent = {
    id: `awaiting_order_${randomUUID()}`,
    tableId,
    status: 'active',
    startedBy: actorId,
    startedAt: now.toISOString(),
    nextReminderAt: new Date(now.getTime() + state.config.proactiveOrderCare.firstReminderSeconds * 1000).toISOString(),
    reminderCount: 0,
    lastReminderAt: null,
    stoppedAt: null,
    stoppedBy: null,
    stopReason: null,
    configVersion: state.config.version,
  }
  state.awaitingOrderIntents.unshift(intent)
  audit(state, actorId, 'awaiting_order.started.v1', intent, {
    tableId,
    idempotencyKey,
    firstReminderSeconds: state.config.proactiveOrderCare.firstReminderSeconds,
  })
  return intent
}

export function stopAwaitingOrder(
  state: RuntimeState,
  tableId: string,
  actorId: string,
  reason: string,
  status: 'completed' | 'cancelled' = 'cancelled',
  now = new Date(),
) {
  const intent = activeIntent(state, tableId)
  if (!intent) throw new Error('该桌台没有进行中的待点单提醒')
  intent.status = status
  intent.stoppedAt = now.toISOString()
  intent.stoppedBy = actorId
  intent.stopReason = reason || (status === 'completed' ? 'order_submitted' : 'employee_cancelled')
  intent.nextReminderAt = null
  closeTriggeredTasks(state, intent.id, actorId, status === 'completed' ? '该桌已下单，自动关闭提醒' : '员工取消待点单提醒')
  audit(state, actorId, `awaiting_order.${status}.v1`, intent, { tableId, reason: intent.stopReason })
  return intent
}

export function completeAwaitingOrderOnOrder(
  state: RuntimeState,
  tableId: string,
  orderId: string,
  actorId: string,
  now = new Date(),
) {
  const intent = activeIntent(state, tableId)
  if (!intent) return null
  return stopAwaitingOrder(state, tableId, actorId, `order_submitted:${orderId}`, 'completed', now)
}

export function processAwaitingOrderReminders(state: RuntimeState, now = new Date()) {
  let changed = false
  for (const intent of state.awaitingOrderIntents.filter((item) => item.status === 'active')) {
    const submittedOrder = state.orderDomain.orders.find(
      (order) => order.tableSessionId === tableSessionId(state, intent.tableId) && order.submittedAt && order.submittedAt >= intent.startedAt,
    )
    if (submittedOrder) {
      stopAwaitingOrder(state, intent.tableId, 'system', `order_submitted:${submittedOrder.id}`, 'completed', now)
      changed = true
      continue
    }
    if (!intent.nextReminderAt || now < new Date(intent.nextReminderAt)) continue
    if (intent.reminderCount >= state.config.proactiveOrderCare.maxReminders) {
      intent.nextReminderAt = null
      state.revision += 1
      changed = true
      continue
    }

    const openTask = state.tasks.find((task) => task.triggerId === intent.id && isOpenTask(task))
    if (openTask) {
      intent.nextReminderAt = new Date(now.getTime() + state.config.proactiveOrderCare.repeatReminderSeconds * 1000).toISOString()
      state.revision += 1
      changed = true
      continue
    }

    const table = state.tables.find((item) => item.id === intent.tableId)
    if (!table || table.status !== 'occupied') {
      stopAwaitingOrder(state, intent.tableId, 'system', 'table_no_longer_occupied', 'cancelled', now)
      changed = true
      continue
    }
    const waitingMinutes = Math.max(1, Math.floor((now.getTime() - new Date(intent.startedAt).getTime()) / 60_000))
    const reminderNumber = intent.reminderCount + 1
    createServiceTask(state, {
      tableCode: table.code,
      serviceTypeId: state.config.proactiveOrderCare.serviceTypeId,
      source: 'system',
      note: `${table.code}已标记暂未点单，等待约${waitingMinutes}分钟。请主动到桌了解需求，不要催促消费。`,
      idempotencyKey: `${intent.id}:reminder:${reminderNumber}`,
      triggerId: intent.id,
    })
    intent.reminderCount = reminderNumber
    intent.lastReminderAt = now.toISOString()
    intent.nextReminderAt = reminderNumber < state.config.proactiveOrderCare.maxReminders
      ? new Date(now.getTime() + state.config.proactiveOrderCare.repeatReminderSeconds * 1000).toISOString()
      : null
    audit(state, 'system', 'awaiting_order.reminder_created.v1', intent, {
      tableId: intent.tableId,
      reminderNumber,
      waitingMinutes,
    })
    changed = true
  }
  return changed
}

export function registerProactiveServiceRoutes(app: FastifyInstance, repository: RuntimeRepository) {
  app.post<{ Params: { tableId: string } }>('/api/tables/:tableId/awaiting-order/start', async (request, reply) => {
    const input = awaitingOrderActionSchema.parse(request.body)
    const intent = await repository.mutate((state) => startAwaitingOrder(
      state,
      request.params.tableId,
      input.actorId,
      input.idempotencyKey,
    ))
    return reply.status(201).send(intent)
  })

  app.post<{ Params: { tableId: string } }>('/api/tables/:tableId/awaiting-order/stop', async (request) => {
    const input = awaitingOrderActionSchema.parse(request.body)
    return repository.mutate((state) => stopAwaitingOrder(
      state,
      request.params.tableId,
      input.actorId,
      input.reason || 'employee_cancelled',
    ))
  })
}
