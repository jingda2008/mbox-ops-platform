import { createHash, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import {
  authorizationDecisionSchema,
  authorizationRequestSchema,
  cartOrderSchema,
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
import {
  AuthorizationError,
  requireAnyRole,
  requireCommerceDecisionAuthority,
  requireConfiguredOperation,
  requireOrderCreationRole,
  requireTableDataScope,
} from './authorization.js'
import {
  allowedFulfillmentRoleIds,
  routeProductToEnabledWorkstation,
  syncOrderFulfillmentWorkstations,
} from './fulfillment-workstations.js'
import {
  ensureDeliveryServiceTask,
  syncDeliveryServiceTaskForKdsAction,
} from './fulfillment-service.js'
import { currentOpenTableSession } from './table-sessions.js'

function deterministicId(prefix: string, key: string) {
  return `${prefix}_${createHash('sha256').update(key).digest('hex').slice(0, 32)}`
}

export function registerCommerceRoutes(app: FastifyInstance, repository: RuntimeRepository) {
  app.post('/api/commerce/orders', async (request, reply) => {
    const input = cartOrderSchema.parse(request.body)
    const order = await repository.mutate((state) => {
      const actor = requireOrderCreationRole(request, state)
      requireTableDataScope(request, state, input.tableId, 'commerce.order.create')
      const previous = state.auditEntries.find(
        (entry) => entry.action === 'commerce.cart_order.v1' && entry.details.idempotencyKey === input.idempotencyKey,
      )
      if (previous) {
        const existingOrder = state.orderDomain.orders.find((item) => item.id === previous.objectId)
        if (!existingOrder) throw new Error('购物车订单幂等记录异常')
        return existingOrder
      }
      if (new Set(input.items.map((item) => item.productId)).size !== input.items.length) {
        throw new Error('购物车商品不能重复，请合并数量')
      }
      const table = state.tables.find((item) => item.id === input.tableId)
      if (!table || table.status !== 'occupied') throw new Error('只能向已开台桌台下单')
      const products = input.items.map((item) => {
        const product = state.products.find((candidate) => candidate.id === item.productId && candidate.enabled)
        if (!product) throw new Error('购物车包含不存在或已停用商品')
        return { product, quantity: item.quantity }
      })
      syncOrderFulfillmentWorkstations(state)
      const now = new Date().toISOString()
      const orderId = deterministicId('order', input.idempotencyKey)
      createOrderDraft(state.orderDomain, {
        orderId,
        tableSessionId: currentOpenTableSession(state, table.id).id,
        createdBy: actor.actorId,
        occurredAt: now,
        idempotencyKey: `${input.idempotencyKey}:draft`,
      })
      products.forEach(({ product, quantity }, index) => {
        const workstation = routeProductToEnabledWorkstation(state, product.stationId)
        addOrderItem(state.orderDomain, {
          orderId,
          item: {
            id: deterministicId('line', `${input.idempotencyKey}:item:${index}`),
            skuId: product.id,
            name: product.name,
            specification: product.specification,
            quantity,
            unitListPriceAmount: product.listPriceAmount,
            unitSalePriceAmount: product.listPriceAmount,
            unitCostAmount: product.costAmount,
            stationId: workstation.id,
            configVersion: product.configVersion,
          },
          actorId: actor.actorId,
          occurredAt: now,
          idempotencyKey: `${input.idempotencyKey}:item:${index}`,
        })
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
        action: 'commerce.cart_order.v1',
        objectType: 'order',
        objectId: orderId,
        occurredAt: now,
        details: { tableId: table.id, items: input.items, idempotencyKey: input.idempotencyKey },
      })
      state.revision += 1
      return submitted
    })
    return reply.status(201).send(order)
  })

  app.post('/api/commerce/quick-orders', async (request, reply) => {
    const input = quickOrderSchema.parse(request.body)
    const order = await repository.mutate((state) => {
      const actor = requireOrderCreationRole(request, state)
      requireTableDataScope(request, state, input.tableId, 'commerce.order.create')
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
      syncOrderFulfillmentWorkstations(state)
      const workstation = routeProductToEnabledWorkstation(state, product.stationId)
      const now = new Date().toISOString()
      const orderId = deterministicId('order', input.idempotencyKey)
      createOrderDraft(state.orderDomain, {
        orderId,
        tableSessionId: currentOpenTableSession(state, table.id).id,
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
          stationId: workstation.id,
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
    return repository.mutate((state) => {
      syncOrderFulfillmentWorkstations(state)
      const currentTask = state.orderDomain.kdsTasks.find((item) => item.id === request.params.taskId)
      if (!currentTask) throw new Error('KDS任务不存在')
      const operation = ['start', 'complete'].includes(input.action) ? 'commerce.kds.prepare' : 'commerce.kds.deliver'
      const actionName = ['start', 'complete'].includes(input.action) ? '执行该工作站出品操作' : '执行该工作站取送操作'
      requireConfiguredOperation(request, state, operation)
      const actor = requireAnyRole(
        request,
        state,
        allowedFulfillmentRoleIds(state.orderDomain, currentTask, input.action),
        operation,
        actionName,
      )
      if (!['supervisor', 'manager'].includes(actor.roleId)) {
        const employee = state.employees.find((item) => item.id === actor.actorId)
        if (!employee || employee.status !== 'active' || !employee.online || employee.paused) {
          throw new AuthorizationError('当前员工不在可执行任务状态', operation)
        }
        const activeShift = state.shiftAssignments.find((shift) => (
          shift.employeeId === actor.actorId &&
          shift.businessDate === state.store.businessDate &&
          shift.status === 'active'
        ))
        if (!activeShift) throw new AuthorizationError('当前员工没有有效当班记录', operation)
        if (activeShift.stationIds?.length && !activeShift.stationIds.includes(currentTask.stationId)) {
          throw new AuthorizationError('当前工作站不在本班次责任范围内', operation)
        }
        if (['start', 'complete'].includes(input.action)) {
          const requiredSkillIds = currentTask.workstation?.requiredSkillIds ?? []
          if (requiredSkillIds.some((skillId) => !employee.skillIds?.includes(skillId))) {
            throw new AuthorizationError('当前员工缺少该工作站要求的出品技能', operation)
          }
        }
      }
      const idempotencyCount = state.orderDomain.idempotencyRecords.length
      const serviceTaskCount = state.tasks.length
      const taskEventCount = state.taskEvents.length
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
      if (input.action === 'complete') {
        ensureDeliveryServiceTask(state, task, command.occurredAt)
      } else if (input.action === 'pickUp' || input.action === 'deliver') {
        ensureDeliveryServiceTask(state, task, task.completedAt ?? command.occurredAt)
        syncDeliveryServiceTaskForKdsAction(
          state,
          task,
          input.action,
          actor.actorId,
          command.occurredAt,
          input.idempotencyKey,
        )
      }
      const changed = state.orderDomain.idempotencyRecords.length !== idempotencyCount ||
        state.tasks.length !== serviceTaskCount || state.taskEvents.length !== taskEventCount
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
      }
      if (changed) state.revision += 1
      return task
    })
  })

  app.post('/api/commerce/authorizations', async (request, reply) => {
    const input = authorizationRequestSchema.parse(request.body)
    const authorization = await repository.mutate((state) => {
      const actor = requireConfiguredOperation(request, state, 'commerce.authorization.request')
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
