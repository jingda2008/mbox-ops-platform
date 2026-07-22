import { createHash, randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import {
  assistedPaymentLinkSchema,
  authorizationDecisionSchema,
  authorizationRequestSchema,
  cartOrderSchema,
  complimentaryOrderSchema,
  kdsActionSchema,
  kdsExceptionDecisionSchema,
  kdsExceptionReportSchema,
  managerKdsCancellationSchema,
  quickOrderSchema,
} from '../src/shared/commerce-api.js'
import type { ManagerKdsCancellationResult } from '../src/shared/commerce-api.js'
import type { RuntimeState } from '../src/shared/contracts.js'
import type { KdsTask } from '../src/shared/order-contracts.js'
import { productAvailability } from '../src/shared/product-availability.js'
import {
  addOrderItem,
  completeKdsTask,
  createOrderDraft,
  decideKdsException,
  decideOrderAuthorization,
  deliverKdsTask,
  pickUpKdsTask,
  reportKdsException,
  requestOrderAuthorization,
  startKdsTask,
  submitOrder,
} from './order-domain.js'
import type { RuntimeRepository } from './repository.js'
import { completeAwaitingOrderOnOrder } from './proactive-service.js'
import { consumeManagedInventoryForSubmittedOrder } from './inventory-order-integration.js'
import {
  AuthorizationError,
  requireApprovalAmount,
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
import { currentOpenTableSession, tableSessionBusinessDate } from './table-sessions.js'
import { signGuestSessionToken } from './table-access.js'
import { anonymousVisitId, type GuestInsightsStore } from './guest-insights.js'
import { queuePrintJobsForOrder } from './commercial-ops.js'

interface CommerceApiOptions {
  guestTokenSecret: string
  assistedPaymentTtlMs?: number
  now?: () => number
  guestInsights?: GuestInsightsStore
}

export class CommerceRequestError extends Error {
  constructor(message: string, readonly code: string, readonly statusCode = 409) {
    super(message)
    this.name = 'CommerceRequestError'
  }
}

const DEFAULT_COMMERCE_API_OPTIONS: CommerceApiOptions = {
  guestTokenSecret: 'local-development-qr-secret-change-me',
}

function deterministicId(prefix: string, key: string) {
  return `${prefix}_${createHash('sha256').update(key).digest('hex').slice(0, 32)}`
}

function cancellationAccountingSnapshot(state: RuntimeState, task: KdsTask): ManagerKdsCancellationResult['accounting'] {
  const order = state.orderDomain.orders.find((candidate) => candidate.id === task.orderId)
  const item = order?.items.find((candidate) => candidate.id === task.orderItemId)
  if (!order || !item) throw new Error('KDS任务缺少对应订单明细')
  const paidAmount = state.paymentDomain.paymentIntents
    .filter((intent) => ['succeeded', 'reported_pending_reconciliation'].includes(intent.status))
    .flatMap((intent) => intent.lineAllocations)
    .filter((allocation) => allocation.orderId === order.id && allocation.orderItemId === item.id)
    .reduce((sum, allocation) => sum + allocation.paidAmount, 0)
  const refundedAmount = state.paymentDomain.refunds
    .filter((refund) => refund.status === 'succeeded')
    .flatMap((refund) => refund.items)
    .filter((refundItem) => refundItem.orderId === order.id && refundItem.orderItemId === item.id)
    .reduce((sum, refundItem) => sum + refundItem.amount, 0)
  const payableAmount = item.unitSalePriceAmount * item.quantity
  const netPaidAmount = Math.max(0, paidAmount - refundedAmount)
  const recommendation = payableAmount === 0
    ? 'no_financial_action'
    : netPaidAmount > 0 ? 'review_refund' : 'review_receivable'
  return {
    policy: 'manual_confirmation_required',
    mutationApplied: false,
    recommendation,
    payableAmount,
    paidAmount,
    refundedAmount,
    suggestedAmount: recommendation === 'review_refund' ? Math.min(netPaidAmount, payableAmount) : payableAmount,
  }
}

function requireKdsTaskActor(
  request: FastifyRequest,
  state: RuntimeState,
  task: KdsTask,
  phase: 'production' | 'delivery',
) {
  const operation = phase === 'production' ? 'commerce.kds.prepare' : 'commerce.kds.deliver'
  const actionName = phase === 'production' ? '执行该工作站出品操作' : '执行该工作站取送操作'
  requireConfiguredOperation(request, state, operation)
  const actor = requireAnyRole(
    request,
    state,
    allowedFulfillmentRoleIds(state, task, phase === 'production' ? 'start' : 'deliver'),
    operation,
    actionName,
  )

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
  if (activeShift.stationIds?.length && !activeShift.stationIds.includes(task.stationId)) {
    throw new AuthorizationError('当前工作站不在本班次责任范围内', operation)
  }
  if (phase === 'production') {
    const workstation = state.config.workstations.find((item) => item.id === task.stationId) ?? task.workstation
    const requiredSkillIds = workstation?.requiredSkillIds ?? []
    if (requiredSkillIds.some((skillId) => !employee.skillIds?.includes(skillId))) {
      throw new AuthorizationError('当前员工缺少该工作站要求的出品技能', operation)
    }
  }
  return actor
}

export function registerCommerceRoutes(
  app: FastifyInstance,
  repository: RuntimeRepository,
  options: CommerceApiOptions = DEFAULT_COMMERCE_API_OPTIONS,
) {
  app.post('/api/commerce/orders', async (request, reply) => {
    const input = cartOrderSchema.parse(request.body)
    let insightContext: { tableSessionId: string; tableCode: string; businessDate: string } | null = null
    const order = await repository.mutate((state) => {
      const actor = requireOrderCreationRole(request, state)
      requireTableDataScope(request, state, input.tableId, 'commerce.order.create')
      const previous = state.auditEntries.find(
        (entry) => entry.action === 'commerce.cart_order.v1' && entry.details.idempotencyKey === input.idempotencyKey,
      )
      if (previous) {
        const existingOrder = state.orderDomain.orders.find((item) => item.id === previous.objectId)
        if (!existingOrder) throw new Error('购物车订单幂等记录异常')
        const previousTableId = typeof previous.details.tableId === 'string' ? previous.details.tableId : ''
        const previousItems = Array.isArray(previous.details.items)
          ? previous.details.items
              .map((item) => item as { productId?: unknown; quantity?: unknown })
              .map((item) => `${String(item.productId)}:${String(item.quantity)}`)
              .toSorted()
          : []
        const requestedItems = input.items.map((item) => `${item.productId}:${item.quantity}`).toSorted()
        if (previousTableId !== input.tableId || JSON.stringify(previousItems) !== JSON.stringify(requestedItems)) {
          throw new CommerceRequestError('同一个提交标识不能用于不同桌台或不同购物车内容', 'COMMERCE_ORDER_IDEMPOTENCY_CONFLICT')
        }
        return existingOrder
      }
      if (new Set(input.items.map((item) => item.productId)).size !== input.items.length) {
        throw new CommerceRequestError('购物车中有重复商品，请返回购物车核对数量', 'COMMERCE_CART_DUPLICATE_PRODUCT', 400)
      }
      const table = state.tables.find((item) => item.id === input.tableId)
      if (!table || table.status !== 'occupied') {
        throw new CommerceRequestError('桌台尚未开台或已经翻台，请先开台后再下单', 'COMMERCE_TABLE_NOT_OPEN')
      }
      const products = input.items.map((item) => {
        const product = state.products.find((candidate) => candidate.id === item.productId && candidate.enabled)
        if (!product) throw new CommerceRequestError('购物车中有商品已下架，请移除后重新提交', 'COMMERCE_PRODUCT_UNAVAILABLE')
        const availability = productAvailability(product, new Date(), state.store.timezone)
        if (!availability.orderable) {
          throw new CommerceRequestError(`${product.name}当前不可下单：${availability.label}`, 'COMMERCE_PRODUCT_NOT_ORDERABLE')
        }
        return { product, quantity: item.quantity }
      })
      syncOrderFulfillmentWorkstations(state)
      const now = new Date().toISOString()
      const orderId = deterministicId('order', input.idempotencyKey)
      const tableSession = currentOpenTableSession(state, table.id)
      insightContext = { tableSessionId: tableSession.id, tableCode: table.code, businessDate: tableSessionBusinessDate(state, tableSession) }
      createOrderDraft(state.orderDomain, {
        orderId,
        tableSessionId: tableSession.id,
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
      queuePrintJobsForOrder(state, submitted, now)
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
    if (options.guestInsights && insightContext) {
      const context = insightContext as { tableSessionId: string; tableCode: string; businessDate: string }
      try {
        await options.guestInsights.recordEvent({
          anonymousId: anonymousVisitId(context.tableSessionId),
          ...context,
          eventType: 'order_created',
          source: 'staff_assisted',
          occurredAt: order.createdAt,
          metadata: {
            orderId: order.id,
            itemCount: input.items.reduce((sum, item) => sum + item.quantity, 0),
            payableAmount: order.amounts.payableAmount,
          },
          idempotencyKey: `staff-order-created:${input.idempotencyKey}`,
        })
      } catch (error) {
        request.log.error({ err: error, orderId: order.id }, 'staff assisted guest insight persistence failed')
      }
    }
    return reply.status(201).send(order)
  })

  app.post<{ Params: { orderId: string } }>('/api/commerce/orders/:orderId/payment-link', async (request, reply) => {
    const input = assistedPaymentLinkSchema.parse(request.body)
    const result = await repository.mutate((state) => {
      const actor = requireOrderCreationRole(request, state)
      const order = state.orderDomain.orders.find((candidate) => candidate.id === request.params.orderId)
      if (!order) throw new Error('订单不存在')
      const tableSession = state.songState.tableSessions.find((candidate) => candidate.id === order.tableSessionId)
      if (!tableSession || tableSession.status !== 'open') throw new Error('订单所属桌次已经结束')
      requireTableDataScope(request, state, tableSession.tableId, 'commerce.order.payment_link')
      const table = state.tables.find((candidate) => candidate.id === tableSession.tableId)
      if (!table || table.status !== 'occupied') throw new Error('订单所属桌台未开台')
      if (order.amounts.payableAmount <= 0) throw new Error('该订单无需支付，请核对赠送或折扣记录')
      if (state.paymentDomain.paymentIntents.some((intent) => (
        intent.orderIds.includes(order.id) && intent.status === 'succeeded'
      ))) {
        throw new Error('该订单已经支付，无需再次生成支付二维码')
      }

      const now = options.now?.() ?? Date.now()
      const ttl = options.assistedPaymentTtlMs ?? 15 * 60_000
      if (!Number.isSafeInteger(ttl) || ttl < 60_000 || ttl > 60 * 60_000) {
        throw new Error('协助支付链接有效期必须在1分钟到60分钟之间')
      }
      const expiresAt = now + ttl
      const configuredTokenVersion = (table as typeof table & { qrTokenVersion?: number }).qrTokenVersion
      const tokenVersion = Number.isSafeInteger(configuredTokenVersion) && Number(configuredTokenVersion) > 0
        ? Number(configuredTokenVersion)
        : 1
      const tableToken = signGuestSessionToken({
        storeId: state.store.id,
        tableCode: table.code,
        tableSessionId: tableSession.id,
        tokenVersion,
        issuedAt: now,
        expiresAt,
      }, options.guestTokenSecret)
      const previous = state.auditEntries.find((entry) => (
        entry.action === 'commerce.guest_payment_link_issued.v1'
        && entry.details.idempotencyKey === input.idempotencyKey
      ))
      if (previous && previous.objectId !== order.id) throw new Error('幂等键已用于其他订单的支付链接')
      if (!previous) {
        state.auditEntries.push({
          id: deterministicId('audit_payment_link', input.idempotencyKey),
          actorId: actor.actorId,
          action: 'commerce.guest_payment_link_issued.v1',
          objectType: 'order',
          objectId: order.id,
          occurredAt: new Date(now).toISOString(),
          details: { tableId: table.id, tableSessionId: tableSession.id, idempotencyKey: input.idempotencyKey },
        })
        state.revision += 1
      }
      return {
        orderId: order.id,
        tableCode: table.code,
        amount: order.amounts.payableAmount,
        tableToken,
        expiresAt: new Date(expiresAt).toISOString(),
      }
    })
    return reply.status(201).send(result)
  })

  app.post('/api/commerce/complimentary-orders', async (request, reply) => {
    const input = complimentaryOrderSchema.parse(request.body)
    const order = await repository.mutate((state) => {
      const actor = requireOrderCreationRole(request, state)
      requireConfiguredOperation(request, state, 'commerce.authorization.request')
      requireTableDataScope(request, state, input.tableId, 'commerce.complimentary_order.create')
      const previous = state.auditEntries.find((entry) => (
        entry.action === 'commerce.complimentary_order.v1'
        && entry.details.idempotencyKey === input.idempotencyKey
      ))
      if (previous) {
        if (previous.details.tableId !== input.tableId) throw new Error('幂等键已用于其他桌台的赠送订单')
        const existing = state.orderDomain.orders.find((candidate) => candidate.id === previous.objectId)
        if (!existing) throw new Error('赠送订单幂等记录异常')
        return existing
      }
      if (new Set(input.items.map((item) => item.productId)).size !== input.items.length) {
        throw new Error('赠送商品不能重复，请合并数量')
      }
      const table = state.tables.find((candidate) => candidate.id === input.tableId)
      if (!table || table.status !== 'occupied') throw new Error('只能向已开台桌台赠送商品')
      const products = input.items.map((item) => {
        const product = state.products.find((candidate) => candidate.id === item.productId && candidate.enabled)
        if (!product) throw new Error('赠送清单包含不存在或已停用商品')
        const availability = productAvailability(product, new Date(), state.store.timezone)
        if (!availability.orderable) throw new Error(`${product.name}当前不可赠送：${availability.label}`)
        return { product, quantity: item.quantity }
      })
      const giftAmount = products.reduce((total, { product, quantity }) => {
        const amount = product.listPriceAmount * quantity
        if (!Number.isSafeInteger(amount) || !Number.isSafeInteger(total + amount)) throw new Error('赠送金额超出安全范围')
        return total + amount
      }, 0)
      requireApprovalAmount(request, state, 'gift', giftAmount, 'commerce.complimentary_order.create')
      syncOrderFulfillmentWorkstations(state)
      const now = new Date().toISOString()
      const orderId = deterministicId('gift_order', input.idempotencyKey)
      const tableSession = currentOpenTableSession(state, table.id)
      createOrderDraft(state.orderDomain, {
        orderId,
        tableSessionId: tableSession.id,
        createdBy: actor.actorId,
        occurredAt: now,
        idempotencyKey: `${input.idempotencyKey}:draft`,
      })
      const lineIds = products.map(({ product, quantity }, index) => {
        const workstation = routeProductToEnabledWorkstation(state, product.stationId)
        const lineId = deterministicId('gift_line', `${input.idempotencyKey}:item:${index}`)
        addOrderItem(state.orderDomain, {
          orderId,
          item: {
            id: lineId,
            skuId: product.id,
            name: product.name,
            specification: product.specification,
            quantity,
            unitListPriceAmount: product.listPriceAmount,
            unitSalePriceAmount: 0,
            unitCostAmount: product.costAmount,
            stationId: workstation.id,
            configVersion: product.configVersion,
          },
          actorId: actor.actorId,
          occurredAt: now,
          idempotencyKey: `${input.idempotencyKey}:item:${index}`,
        })
        return lineId
      })
      const authorization = requestOrderAuthorization(state.orderDomain, {
        authorizationId: deterministicId('gift_authorization', input.idempotencyKey),
        orderId,
        kind: 'gift',
        lineIds,
        requestedBy: actor.actorId,
        occurredAt: now,
        idempotencyKey: `${input.idempotencyKey}:authorization`,
      })
      decideOrderAuthorization(state.orderDomain, {
        authorizationId: authorization.id,
        decision: 'granted',
        decidedBy: actor.actorId,
        reason: input.reason,
        occurredAt: now,
        idempotencyKey: `${input.idempotencyKey}:authorization-decision`,
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
      queuePrintJobsForOrder(state, submitted, now)
      state.auditEntries.push({
        id: deterministicId('audit_gift_order', input.idempotencyKey),
        actorId: actor.actorId,
        action: 'commerce.complimentary_order.v1',
        objectType: 'order',
        objectId: orderId,
        occurredAt: now,
        details: {
          tableId: table.id,
          tableSessionId: tableSession.id,
          items: input.items,
          giftAmount,
          reason: input.reason,
          sourceKdsTaskId: input.sourceKdsTaskId,
          idempotencyKey: input.idempotencyKey,
        },
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
      const availability = productAvailability(product, new Date(), state.store.timezone)
      if (!availability.orderable) throw new Error(`${product.name}当前不可下单：${availability.label}`)
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
      queuePrintJobsForOrder(state, submitted, now)
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
      const actor = requireKdsTaskActor(
        request,
        state,
        currentTask,
        ['start', 'complete'].includes(input.action) ? 'production' : 'delivery',
      )
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

  app.post<{ Params: { taskId: string } }>('/api/commerce/kds/:taskId/manager-cancel', async (request) => {
    const input = managerKdsCancellationSchema.parse(request.body)
    return repository.mutate((state): ManagerKdsCancellationResult => {
      const replay = state.auditEntries.find((entry) => (
        entry.action === 'kds.manager_cancelled.v1'
        && entry.details.idempotencyKey === input.idempotencyKey
      ))
      if (replay) {
        if (replay.objectId !== request.params.taskId) throw new Error('幂等键已用于其他KDS任务')
        return replay.details.result as unknown as ManagerKdsCancellationResult
      }
      const task = state.orderDomain.kdsTasks.find((candidate) => candidate.id === request.params.taskId)
      if (!task) throw new Error('KDS任务不存在')
      if (task.status === 'delivered') throw new Error('已经送达的商品不能取消制作，请走退菜或退款流程')
      const tableSession = state.songState.tableSessions.find((candidate) => candidate.id === task.tableSessionId)
      if (!tableSession || tableSession.status !== 'open') throw new Error('KDS任务所属桌次已经结束')
      requireConfiguredOperation(request, state, 'table.close')
      requireTableDataScope(request, state, tableSession.tableId, 'commerce.kds.manager_cancel')
      const actor = requireAnyRole(
        request,
        state,
        ['supervisor', 'manager', 'operations_director', 'owner'],
        'commerce.kds.manager_cancel',
        '取消未送达商品',
      )
      const existingDisposition = task.exceptionEvents?.find((event) => event.type === 'manager_disposition')
      if (existingDisposition) throw new Error('该KDS任务已经完成异常处置')
      const existingReport = task.exceptionEvents?.find((event) => event.type === 'reported')
      const now = new Date().toISOString()
      const report = existingReport ?? reportKdsException(state.orderDomain, {
        exceptionId: deterministicId('manager_cancel_exception', input.idempotencyKey),
        eventId: deterministicId('manager_cancel_report', input.idempotencyKey),
        taskId: task.id,
        exceptionKind: ['queued', 'preparing'].includes(task.status) ? 'production_rejection' : 'wrong_item',
        reasonCode: 'other',
        reasonNote: input.reasonNote,
        actorId: actor.actorId,
        actorRoleId: actor.roleId,
        occurredAt: now,
        idempotencyKey: `${input.idempotencyKey}:report`,
      })
      const disposition = decideKdsException(state.orderDomain, {
        eventId: deterministicId('manager_cancel_decision', input.idempotencyKey),
        exceptionId: report.exceptionId,
        disposition: 'cancelled',
        reasonCode: input.reasonCode,
        reasonNote: input.reasonNote,
        remakeTaskId: null,
        actorId: actor.actorId,
        actorRoleId: actor.roleId,
        occurredAt: now,
        idempotencyKey: `${input.idempotencyKey}:decision`,
      })
      const order = state.orderDomain.orders.find((candidate) => candidate.id === task.orderId)
      const item = order?.items.find((candidate) => candidate.id === task.orderItemId)
      if (!order || !item) throw new Error('KDS任务缺少对应订单明细')
      const result: ManagerKdsCancellationResult = {
        cancellationEventId: disposition.id,
        taskId: task.id,
        orderId: task.orderId,
        orderItemId: task.orderItemId,
        itemName: task.itemName,
        quantity: task.quantity,
        accounting: cancellationAccountingSnapshot(state, task),
      }
      state.auditEntries.push({
        id: deterministicId('audit_manager_cancel', input.idempotencyKey),
        actorId: actor.actorId,
        action: 'kds.manager_cancelled.v1',
        objectType: 'kdsTask',
        objectId: task.id,
        occurredAt: now,
        details: {
          tableId: tableSession.tableId,
          tableSessionId: tableSession.id,
          reasonCode: input.reasonCode,
          reasonNote: input.reasonNote,
          accountingPolicy: 'manual_confirmation_required',
          accountingMutationApplied: false,
          result,
          idempotencyKey: input.idempotencyKey,
        },
      })
      state.revision += 1
      return result
    })
  })

  app.post<{ Params: { taskId: string } }>('/api/commerce/kds/:taskId/exceptions', async (request, reply) => {
    const input = kdsExceptionReportSchema.parse(request.body)
    const event = await repository.mutate((state) => {
      syncOrderFulfillmentWorkstations(state)
      const currentTask = state.orderDomain.kdsTasks.find((item) => item.id === request.params.taskId)
      if (!currentTask) throw new Error('KDS任务不存在')
      const phase = input.exceptionKind === 'wrong_item' && ['completed', 'picked_up', 'delivered'].includes(currentTask.status)
        ? 'delivery'
        : 'production'
      const actor = requireKdsTaskActor(request, state, currentTask, phase)
      const idempotencyCount = state.orderDomain.idempotencyRecords.length
      const occurredAt = new Date().toISOString()
      const result = reportKdsException(state.orderDomain, {
        exceptionId: deterministicId('kds_exception', input.idempotencyKey),
        eventId: deterministicId('kds_exception_report', input.idempotencyKey),
        taskId: currentTask.id,
        exceptionKind: input.exceptionKind,
        reasonCode: input.reasonCode,
        reasonNote: input.reasonNote,
        actorId: actor.actorId,
        actorRoleId: actor.roleId,
        occurredAt,
        idempotencyKey: input.idempotencyKey,
      })
      if (state.orderDomain.idempotencyRecords.length !== idempotencyCount) {
        state.auditEntries.push({
          id: deterministicId('audit_kds_exception', input.idempotencyKey),
          actorId: actor.actorId,
          action: 'kds.exception.reported.v1',
          objectType: 'kdsTask',
          objectId: currentTask.id,
          occurredAt,
          details: {
            exceptionId: result.exceptionId,
            exceptionKind: result.exceptionKind,
            reasonCode: result.reasonCode,
            reasonNote: result.reasonNote,
            orderId: result.orderId,
            orderItemId: result.originalOrderItemId,
            kdsTaskId: result.originalKdsTaskId,
          },
        })
        state.revision += 1
      }
      return result
    })
    return reply.status(201).send(event)
  })

  app.post<{ Params: { exceptionId: string } }>('/api/commerce/kds/exceptions/:exceptionId/decision', async (request) => {
    const input = kdsExceptionDecisionSchema.parse(request.body)
    return repository.mutate((state) => {
      syncOrderFulfillmentWorkstations(state)
      const reportedTask = state.orderDomain.kdsTasks.find((task) => task.exceptionEvents?.some((event) => (
        event.exceptionId === request.params.exceptionId && event.type === 'reported'
      )))
      if (!reportedTask) throw new Error('KDS异常不存在')
      requireConfiguredOperation(request, state, 'commerce.kds.prepare')
      const actor = requireAnyRole(
        request,
        state,
        ['supervisor', 'manager', 'operations_director', 'owner'],
        'commerce.kds.prepare',
        '处置KDS异常',
      )
      const idempotencyCount = state.orderDomain.idempotencyRecords.length
      const occurredAt = new Date().toISOString()
      const result = decideKdsException(state.orderDomain, {
        eventId: deterministicId('kds_exception_decision', input.idempotencyKey),
        exceptionId: request.params.exceptionId,
        disposition: input.disposition,
        reasonCode: input.reasonCode,
        reasonNote: input.reasonNote,
        remakeTaskId: input.disposition === 'remake'
          ? deterministicId('kds_remake', input.idempotencyKey)
          : null,
        actorId: actor.actorId,
        actorRoleId: actor.roleId,
        occurredAt,
        idempotencyKey: input.idempotencyKey,
      })
      if (state.orderDomain.idempotencyRecords.length !== idempotencyCount) {
        state.auditEntries.push({
          id: deterministicId('audit_kds_exception_decision', input.idempotencyKey),
          actorId: actor.actorId,
          action: `kds.exception.${input.disposition}.v1`,
          objectType: 'kdsTask',
          objectId: reportedTask.id,
          occurredAt,
          details: {
            exceptionId: result.exceptionId,
            disposition: result.managerDisposition,
            reasonCode: result.reasonCode,
            reasonNote: result.reasonNote,
            orderId: result.orderId,
            orderItemId: result.originalOrderItemId,
            kdsTaskId: result.originalKdsTaskId,
            remakeKdsTaskId: result.remakeKdsTaskId,
          },
        })
        state.revision += 1
      }
      return result
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
