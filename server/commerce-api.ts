import { createHash, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import {
  authorizationDecisionSchema,
  authorizationRequestSchema,
  kdsActionSchema,
  quickOrderSchema,
} from '../src/shared/commerce-api.js'
import {
  addOrderItem,
  completeKdsTask,
  createOrderDraft,
  decideOrderAuthorization,
  deliverKdsTask,
  pickUpKdsTask,
  requestOrderAuthorization,
  startKdsTask,
  submitOrder,
} from './order-domain.js'
import type { RuntimeRepository } from './repository.js'
import { completeAwaitingOrderOnOrder } from './proactive-service.js'
import { consumeManagedInventoryForSubmittedOrder } from './inventory-order-integration.js'
import { requireCommerceDecisionAuthority, requireOperation, requireOrderCreationRole } from './authorization.js'

function tableSessionId(tableId: string, businessDate: string) {
  return `session:${tableId}:${businessDate}`
}

function deterministicId(prefix: string, key: string) {
  return `${prefix}_${createHash('sha256').update(key).digest('hex').slice(0, 32)}`
}

export function registerCommerceRoutes(app: FastifyInstance, repository: RuntimeRepository) {
  app.post('/api/commerce/quick-orders', async (request, reply) => {
    const input = quickOrderSchema.parse(request.body)
    const order = await repository.mutate((state) => {
      const actor = requireOrderCreationRole(request, state)
      const previous = state.auditEntries.find(
        (entry) => entry.action === 'commerce.quick_order.v1' && entry.details.idempotencyKey === input.idempotencyKey,
      )
      if (previous) {
        if (
          previous.details.tableId !== input.tableId ||
          previous.details.productId !== input.productId ||
          previous.details.quantity !== input.quantity
        ) {
          throw new Error('幂等键已用于不同的快捷订单')
        }
        const existingOrder = state.orderDomain.orders.find((item) => item.id === previous.objectId)
        if (!existingOrder) throw new Error('快捷订单幂等记录异常')
        return existingOrder
      }
      const table = state.tables.find((item) => item.id === input.tableId)
      if (!table || table.status !== 'occupied') throw new Error('只能向已开台桌台下单')
      const product = state.products.find((item) => item.id === input.productId && item.enabled)
      if (!product) throw new Error('商品不存在或已停用')
      const now = new Date().toISOString()
      const orderId = deterministicId('order', input.idempotencyKey)
      createOrderDraft(state.orderDomain, {
        orderId,
        tableSessionId: tableSessionId(table.id, state.store.businessDate),
        createdBy: actor.actorId,
        occurredAt: now,
        idempotencyKey: `${input.idempotencyKey}:draft`,
      })
      addOrderItem(state.orderDomain, {
        orderId,
        item: {
          id: deterministicId('line', `${input.idempotencyKey}:item:0`),
          skuId: product.id,
          name: product.name,
          specification: product.specification,
          quantity: input.quantity,
          unitListPriceAmount: product.listPriceAmount,
          unitSalePriceAmount: product.listPriceAmount,
          unitCostAmount: product.costAmount,
          stationId: product.stationId,
          configVersion: product.configVersion,
        },
        actorId: actor.actorId,
        occurredAt: now,
        idempotencyKey: `${input.idempotencyKey}:item`,
      })
      const submitted = submitOrder(state.orderDomain, {
        orderId,
        submittedBy: actor.actorId,
        occurredAt: now,
        idempotencyKey: `${input.idempotencyKey}:submit`,
      })
      consumeManagedInventoryForSubmittedOrder(state.inventoryDomain, submitted, {
        actorId: actor.actorId,
        businessDate: state.store.businessDate,
        occurredAt: now,
      })
      completeAwaitingOrderOnOrder(state, table.id, orderId, actor.actorId, new Date(now))
      state.auditEntries.push({
        id: `audit_${randomUUID()}`,
        actorId: actor.actorId,
        action: 'commerce.quick_order.v1',
        objectType: 'order',
        objectId: orderId,
        occurredAt: now,
        details: { tableId: table.id, productId: product.id, quantity: input.quantity, idempotencyKey: input.idempotencyKey },
      })
      state.revision += 1
      return submitted
    })
    return reply.status(201).send(order)
  })

  app.post<{ Params: { taskId: string } }>('/api/commerce/kds/:taskId/actions', async (request) => {
    const input = kdsActionSchema.parse(request.body)
    const actor = requireOperation(request, ['start', 'complete'].includes(input.action) ? 'commerce.kds.prepare' : 'commerce.kds.deliver')
    return repository.mutate((state) => {
      const idempotencyCount = state.orderDomain.idempotencyRecords.length
      const command = {
        taskId: request.params.taskId,
        actorId: actor.actorId,
        occurredAt: new Date().toISOString(),
        idempotencyKey: input.idempotencyKey,
      }
      const task = input.action === 'start'
        ? startKdsTask(state.orderDomain, command)
        : input.action === 'complete'
          ? completeKdsTask(state.orderDomain, command)
          : input.action === 'pickUp'
            ? pickUpKdsTask(state.orderDomain, command)
            : deliverKdsTask(state.orderDomain, command)
      if (state.orderDomain.idempotencyRecords.length !== idempotencyCount) {
        state.auditEntries.push({
          id: deterministicId('audit_kds', input.idempotencyKey),
          actorId: actor.actorId,
          action: `kds.${input.action}.v1`,
          objectType: 'kdsTask',
          objectId: task.id,
          occurredAt: command.occurredAt,
          details: { orderId: task.orderId, tableSessionId: task.tableSessionId, status: task.status },
        })
        state.revision += 1
      }
      return task
    })
  })

  app.post('/api/commerce/authorizations', async (request, reply) => {
    const input = authorizationRequestSchema.parse(request.body)
    const actor = requireOperation(request, 'commerce.authorization.request')
    const authorization = await repository.mutate((state) => {
      const idempotencyCount = state.orderDomain.idempotencyRecords.length
      const result = requestOrderAuthorization(state.orderDomain, {
        authorizationId: deterministicId('authorization', input.idempotencyKey),
        orderId: input.orderId,
        kind: input.kind,
        lineIds: input.lineIds,
        requestedBy: actor.actorId,
        occurredAt: new Date().toISOString(),
        idempotencyKey: input.idempotencyKey,
      })
      if (state.orderDomain.idempotencyRecords.length !== idempotencyCount) state.revision += 1
      return result
    })
    return reply.status(201).send(authorization)
  })

  app.post<{ Params: { authorizationId: string } }>('/api/commerce/authorizations/:authorizationId/decision', async (request) => {
    const input = authorizationDecisionSchema.parse(request.body)
    return repository.mutate((state) => {
      const now = new Date()
      const actor = requireCommerceDecisionAuthority(request, state, request.params.authorizationId, now)
      const idempotencyCount = state.orderDomain.idempotencyRecords.length
      const result = decideOrderAuthorization(state.orderDomain, {
        authorizationId: request.params.authorizationId,
        decision: input.decision,
        decidedBy: actor.actorId,
        reason: input.reason,
        occurredAt: now.toISOString(),
        idempotencyKey: input.idempotencyKey,
      })
      if (state.orderDomain.idempotencyRecords.length !== idempotencyCount) state.revision += 1
      return result
    })
  })
}
