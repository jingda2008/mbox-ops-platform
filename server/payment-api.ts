import { createHash, randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply } from 'fastify'
import {
  cashPaymentConfirmationSchema,
  completeRefundSchema,
  createTablePaymentIntentSchema,
  itemRefundRequestSchema,
  physicalPosRefundCompletionSchema,
  physicalPosReportSchema,
  providerPaymentQuerySchema,
  providerRefundQuerySchema,
  providerRefundSubmissionSchema,
  simulatePaymentSuccessSchema,
  type PaymentAllocationInput,
} from '../src/shared/payment-api.js'
import type { PaymentIntentStatus, PaymentLineAllocationInput } from '../src/shared/payment-contracts.js'
import type { RuntimeMode } from '../src/shared/auth-contracts.js'
import {
  approveRefund,
  confirmCashPayment,
  createPaymentIntent,
  handlePaymentNotification,
  markRefundSucceeded,
  reportPhysicalPosPayment,
  requestRefund,
  startRefund,
} from './payment-domain.js'
import { AuthenticationError, requireRequestActor } from './auth-context.js'
import { requireApprovalAmount, requireConfiguredOperation, requireTableDataScope } from './authorization.js'
import type { RuntimeRepository } from './repository.js'
import {
  applyProviderPaymentCreation,
  applyProviderRefundSubmission,
  createEnvironmentPaymentProviderResolver,
  PaymentProviderUnavailableError,
  processPaymentProviderCallback,
  queryPaymentThroughProvider,
  queryRefundThroughProvider,
  requestPaymentThroughProvider,
  requestRefundThroughProvider,
  type PaymentProviderResolver,
} from './payment-provider.js'
import { PostgresOptimisticConcurrencyError } from './postgres-repository.js'
import { submitOrder } from './order-domain.js'
import { consumeManagedInventoryForSubmittedOrder } from './inventory-order-integration.js'
import { completeAwaitingOrderOnOrder } from './proactive-service.js'

const ACTIVE_ALLOCATION_STATUSES = new Set<PaymentIntentStatus>([
  'pending',
  'processing',
  'succeeded',
  'reported_pending_reconciliation',
])

function deterministicId(prefix: string, key: string) {
  return `${prefix}_${createHash('sha256').update(key).digest('hex').slice(0, 32)}`
}

function paymentSelectionFingerprint(
  allocation: PaymentAllocationInput,
  providerPayment: ReturnType<typeof createTablePaymentIntentSchema.parse>['providerPayment'],
) {
  const safeProviderPayment = providerPayment?.presentation === 'barcode'
    ? {
        presentation: providerPayment.presentation,
        customerAuthCodeSha256: createHash('sha256').update(providerPayment.customerAuthCode).digest('hex'),
      }
    : providerPayment ?? null
  return JSON.stringify({ allocation, providerPayment: safeProviderPayment })
}

function deterministicProviderId(prefix: string, key: string) {
  return `${prefix}${createHash('sha256').update(key).digest('hex').slice(0, 32)}`
}

export interface PaymentRouteOptions {
  providerResolver?: PaymentProviderResolver
  allowPilotSimulation?: boolean
}

function providerUnavailable(reply: FastifyReply, error: unknown) {
  if (!(error instanceof PaymentProviderUnavailableError)) return null
  return reply.status(503).send({ code: 'PAYMENT_PROVIDER_UNAVAILABLE', message: error.message })
}

function requireTableSessionDataScope(
  request: Parameters<typeof requireTableDataScope>[0],
  state: Awaited<ReturnType<RuntimeRepository['read']>>,
  tableSessionId: string,
  operation: string,
) {
  const session = state.songState.tableSessions.find((item) => item.id === tableSessionId)
  if (!session) throw new Error('桌次不存在')
  return requireTableDataScope(request, state, session.tableId, operation)
}

function simulationAllowed(runtimeMode: RuntimeMode, allowPilotSimulation: boolean) {
  return runtimeMode === 'local' || runtimeMode === 'test' || (runtimeMode === 'staging' && allowPilotSimulation)
}

function requireSimulationActor(
  request: Parameters<typeof requireRequestActor>[0],
  allowPilotSimulation: boolean,
) {
  const actor = requireRequestActor(request)
  if (!simulationAllowed(actor.runtimeMode, allowPilotSimulation)) {
    throw new AuthenticationError('当前环境未启用支付模拟接口', 404, 'DEVELOPMENT_ENDPOINT_DISABLED')
  }
  return actor
}

function audit(
  state: Awaited<ReturnType<RuntimeRepository['read']>>,
  actorId: string,
  action: string,
  objectType: string,
  objectId: string,
  details: Record<string, unknown>,
) {
  state.auditEntries.push({
    id: `audit_${randomUUID()}`,
    actorId,
    action,
    objectType,
    objectId,
    occurredAt: new Date().toISOString(),
    details,
  })
  state.revision += 1
}

function remainingAllocationLines(
  state: Awaited<ReturnType<RuntimeRepository['read']>>,
  tableSessionId: string,
) {
  const allocatedAmounts = new Map<string, number>()
  for (const intent of state.paymentDomain.paymentIntents) {
    if (intent.tableSessionId !== tableSessionId || !ACTIVE_ALLOCATION_STATUSES.has(intent.status)) continue
    for (const allocation of intent.lineAllocations) {
      const key = `${allocation.orderId}\u0000${allocation.orderItemId}`
      allocatedAmounts.set(
        key,
        (allocatedAmounts.get(key) ?? 0) + allocation.paidAmount,
      )
    }
  }

  return state.orderDomain.orders
    .filter((order) => order.tableSessionId === tableSessionId && !['draft', 'authorization_pending'].includes(order.status))
    .flatMap((order) => order.items.map((item) => ({ order, item })))
    .map(({ order, item }) => {
      const payableAmount = item.quantity * item.unitSalePriceAmount
      const allocatedAmount = allocatedAmounts.get(`${order.id}\u0000${item.id}`) ?? 0
      if (!Number.isSafeInteger(payableAmount) || !Number.isSafeInteger(allocatedAmount)) {
        throw new Error('商品可收金额超出安全整数范围')
      }
      return {
        orderId: order.id,
        orderItemId: item.id,
        sourceUnitPriceAmount: item.unitSalePriceAmount,
        remainingAmount: payableAmount - allocatedAmount,
      }
    })
    .filter((line) => line.remainingAmount > 0)
}

function buildRequestedAllocations(
  state: Awaited<ReturnType<RuntimeRepository['read']>>,
  tableSessionId: string,
  selection: PaymentAllocationInput,
) {
  const remaining = remainingAllocationLines(state, tableSessionId)
  if (remaining.length === 0) throw new Error('该桌台没有可支付的订单商品')
  const allocations: PaymentLineAllocationInput[] = []

  if (selection.mode === 'items') {
    const selectedKeys = new Set<string>()
    for (const selected of selection.items) {
      const key = `${selected.orderId}\u0000${selected.orderItemId}`
      if (selectedKeys.has(key)) throw new Error('同一商品不能重复选择')
      selectedKeys.add(key)
      const line = remaining.find((item) => item.orderId === selected.orderId && item.orderItemId === selected.orderItemId)
      if (!line) throw new Error('所选商品没有剩余可收金额')
      const amount = selected.quantity * line.sourceUnitPriceAmount
      if (!Number.isSafeInteger(amount)) throw new Error('所选商品金额超出安全整数范围')
      if (amount > line.remainingAmount) throw new Error('所选商品数量超过剩余可收数量')
      allocations.push({
        orderId: line.orderId,
        orderItemId: line.orderItemId,
        quantity: selected.quantity,
        unitPaidAmount: line.sourceUnitPriceAmount,
        sourceUnitPriceAmount: line.sourceUnitPriceAmount,
        allocationMode: 'items',
      })
    }
  } else {
    let amountLeft = selection.mode === 'amount'
      ? selection.amount
      : remaining.reduce((sum, line) => sum + line.remainingAmount, 0)
    const totalRemaining = remaining.reduce((sum, line) => sum + line.remainingAmount, 0)
    if (!Number.isSafeInteger(totalRemaining)) throw new Error('桌账剩余应收超出安全整数范围')
    if (amountLeft > totalRemaining) throw new Error('指定金额超过桌账剩余应收')

    for (const line of remaining) {
      if (amountLeft <= 0) break
      const allocatedAmount = Math.min(amountLeft, line.remainingAmount)
      const isWholeQuantity = allocatedAmount % line.sourceUnitPriceAmount === 0
      allocations.push({
        orderId: line.orderId,
        orderItemId: line.orderItemId,
        quantity: isWholeQuantity ? allocatedAmount / line.sourceUnitPriceAmount : 1,
        unitPaidAmount: isWholeQuantity ? line.sourceUnitPriceAmount : allocatedAmount,
        sourceUnitPriceAmount: line.sourceUnitPriceAmount,
        allocationMode: selection.mode,
      })
      amountLeft -= allocatedAmount
    }
    if (amountLeft !== 0) throw new Error('指定金额无法分配到剩余商品')
  }

  const amount = allocations.reduce((sum, allocation) => sum + allocation.quantity * allocation.unitPaidAmount, 0)
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('支付金额必须是正安全整数')
  return { allocations, amount }
}

async function persistExternalResult<T>(repository: RuntimeRepository, mutation: Parameters<RuntimeRepository['mutate']>[0]) {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      return await repository.mutate(mutation) as T
    } catch (error) {
      if (!(error instanceof PostgresOptimisticConcurrencyError) || attempt === 5) throw error
    }
  }
  throw new Error('外部支付结果未能持久化')
}

function submitOrdersAfterVerifiedPayment(
  state: Awaited<ReturnType<RuntimeRepository['read']>>,
  paymentIntentId: string,
) {
  const intent = state.paymentDomain.paymentIntents.find((item) => item.id === paymentIntentId)
  if (!intent || intent.status !== 'succeeded' || !intent.paidAt) return
  const tableSession = state.songState.tableSessions.find((item) => item.id === intent.tableSessionId)
  for (const orderId of intent.orderIds) {
    const order = state.orderDomain.orders.find((item) => item.id === orderId)
    if (!order || order.status !== 'draft') continue
    const submitted = submitOrder(state.orderDomain, {
      orderId: order.id,
      submittedBy: intent.createdBy,
      occurredAt: intent.paidAt,
      idempotencyKey: `verified-payment-submit:${intent.id}:${order.id}`,
    })
    consumeManagedInventoryForSubmittedOrder(state.inventoryDomain, submitted, {
      actorId: intent.createdBy,
      businessDate: state.store.businessDate,
      occurredAt: intent.paidAt,
    })
    if (tableSession) {
      completeAwaitingOrderOnOrder(state, tableSession.tableId, order.id, intent.createdBy, new Date(intent.paidAt))
    }
    audit(state, intent.createdBy, 'order.submitted_after_verified_payment.v1', 'order', order.id, {
      paymentIntentId: intent.id,
      channel: intent.channel,
    })
  }
}

export function registerPaymentRoutes(
  app: FastifyInstance,
  repository: RuntimeRepository,
  options: PaymentRouteOptions = {},
) {
  const resolveProvider = options.providerResolver ?? createEnvironmentPaymentProviderResolver()
  const allowPilotSimulation = options.allowPilotSimulation === true

  app.post('/api/payments/table-intents', async (request, reply) => {
    const input = createTablePaymentIntentSchema.parse(request.body)
    const requestActor = requireRequestActor(request)
    if (input.channel === 'wechat_mock' && !simulationAllowed(requestActor.runtimeMode, allowPilotSimulation)) {
      throw new AuthenticationError('当前环境未启用模拟支付渠道', 404, 'DEVELOPMENT_CHANNEL_DISABLED')
    }
    let intent
    try {
      const prepared = await repository.mutate((state) => {
        const actor = requireConfiguredOperation(request, state, 'payment.intent.create')
        requireTableSessionDataScope(request, state, input.tableSessionId, 'payment.intent.create')
        const selectionFingerprint = paymentSelectionFingerprint(input.allocation, input.providerPayment)
        const existingRecord = state.paymentDomain.idempotencyRecords.find((record) => record.key === input.idempotencyKey)
        let result
        if (existingRecord) {
          if (existingRecord.operation !== 'payment.create_intent.v1' || existingRecord.resultType !== 'payment_intent') {
            throw new Error('幂等键已用于不同请求')
          }
          result = state.paymentDomain.paymentIntents.find((item) => item.id === existingRecord.resultId)
          if (!result) throw new Error('支付幂等记录指向的支付意图不存在')
          if (
            result.tableSessionId !== input.tableSessionId ||
            result.channel !== input.channel ||
            result.createdBy !== actor.actorId ||
            result.deviceId !== input.deviceId ||
            result.requestSelectionFingerprint !== selectionFingerprint
          ) {
            throw new Error('幂等键已用于不同请求')
          }
        } else {
          const idempotencyCount = state.paymentDomain.idempotencyRecords.length
          const { allocations, amount } = buildRequestedAllocations(state, input.tableSessionId, input.allocation)
          const now = new Date()
          const providerRuntime = input.channel === 'postar' ? resolveProvider(state.paymentDomain, input.channel) : null
          result = createPaymentIntent(state.paymentDomain, {
            paymentIntentId: input.channel === 'postar'
              ? deterministicProviderId('Payment', input.idempotencyKey)
              : deterministicId('payment', input.idempotencyKey),
            tableSessionId: input.tableSessionId,
            lineAllocations: allocations,
            amount,
            currency: 'CNY',
            channel: input.channel,
            settlementChannel: input.channel === 'postar' && input.providerPayment?.presentation === 'jsapi'
              ? input.providerPayment.payWay
              : undefined,
            merchantId: providerRuntime?.merchantId ?? 'mbox-lujiazui-demo',
            createdBy: actor.actorId,
            deviceId: input.deviceId,
            occurredAt: now.toISOString(),
            expiresAt: new Date(now.getTime() + 15 * 60 * 1000).toISOString(),
            idempotencyKey: input.idempotencyKey,
            businessDate: state.store.businessDate,
            allocationMode: input.allocation.mode,
            requestSelectionFingerprint: selectionFingerprint,
          })
          if (state.paymentDomain.idempotencyRecords.length !== idempotencyCount) {
            audit(state, actor.actorId, 'payment.intent.created.v1', 'paymentIntent', result.id, {
              tableSessionId: input.tableSessionId,
              channel: input.channel,
              amount,
              orderIds: result.orderIds,
              allocation: input.allocation,
            })
          }
        }

        const providerRuntime = result.channel === 'postar' && result.status === 'pending'
          ? resolveProvider(state.paymentDomain, result.channel)
          : null
        const providerPayment = input.providerPayment
        return {
          intent: result,
          actorId: actor.actorId,
          providerRuntime,
          providerRequest: providerRuntime && providerPayment ? {
            paymentIntentId: result.id,
            merchantId: result.merchantId,
            amount: result.amount,
            currency: result.currency,
            expiresAt: result.expiresAt,
            presentation: providerPayment.presentation,
            payWay: providerPayment.presentation === 'jsapi' ? providerPayment.payWay : undefined,
            payerId: providerPayment.presentation === 'jsapi' ? providerPayment.payerId : undefined,
            customerAuthCode: providerPayment.presentation === 'barcode' ? providerPayment.customerAuthCode : undefined,
            clientIp: request.ip,
            callbackUrl: providerRuntime.callbackUrl,
            operatorId: actor.actorId,
            remark: `MBOX桌次${input.tableSessionId}`.slice(0, 120),
            wxAppid: providerPayment.presentation === 'jsapi' ? providerPayment.wxAppid : undefined,
          } : null,
        }
      })
      intent = prepared.intent
      if (prepared.providerRuntime && prepared.providerRequest) {
        const observation = await requestPaymentThroughProvider({
          intent: prepared.intent,
          adapter: prepared.providerRuntime.adapter,
          secrets: prepared.providerRuntime.secrets,
          request: prepared.providerRequest,
        })
        intent = await persistExternalResult(repository, (state) => {
          const result = applyProviderPaymentCreation(
            state.paymentDomain,
            prepared.providerRuntime!.adapter.provider,
            prepared.providerRequest!,
            observation,
          )
          audit(state, prepared.actorId, 'payment.provider.order_created.v1', 'paymentIntent', result.id, {
            providerTransactionId: result.channelTransactionId,
            status: result.status,
          })
          return result
        })
      }
    } catch (error) {
      const unavailable = providerUnavailable(reply, error)
      if (unavailable) return unavailable
      throw error
    }
    return reply.status(201).send(intent)
  })

  app.post<{ Params: { provider: string } }>('/api/payments/providers/:provider/callback', async (request, reply) => {
    const rawBody = request.body instanceof Uint8Array
      ? request.body
      : new TextEncoder().encode(typeof request.body === 'string' ? request.body : JSON.stringify(request.body))
    const headers = Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key, value]))
    try {
      const acknowledgement = await repository.mutate(async (state) => {
        const runtime = resolveProvider(state.paymentDomain, request.params.provider)
        const notificationCount = state.paymentDomain.paymentNotifications.length
        const notification = await processPaymentProviderCallback({
          state: state.paymentDomain,
          adapter: runtime.adapter,
          secrets: runtime.secrets,
          callback: { rawBody, headers, receivedAt: new Date().toISOString() },
        })
        submitOrdersAfterVerifiedPayment(state, notification.paymentIntentId)
        if (state.paymentDomain.paymentNotifications.length !== notificationCount) {
          audit(state, `provider:${request.params.provider}`, 'payment.provider.callback_verified.v1', 'paymentNotification', notification.id, {
            paymentIntentId: notification.paymentIntentId,
            providerTransactionId: notification.channelTransactionId,
            status: notification.status,
          })
        }
        return runtime.callbackAcknowledgement
      })
      return reply.send(acknowledgement)
    } catch (error) {
      const unavailable = providerUnavailable(reply, error)
      if (unavailable) return unavailable
      return reply.status(400).send({
        code: 'PAYMENT_PROVIDER_CALLBACK_REJECTED',
        message: error instanceof Error ? error.message : '支付渠道回调被拒绝',
      })
    }
  })

  app.post<{ Params: { paymentIntentId: string } }>(
    '/api/payments/:paymentIntentId/provider-query',
    async (request, reply) => {
      const input = providerPaymentQuerySchema.parse(request.body)
      try {
        return await repository.mutate(async (state) => {
          const actor = requireConfiguredOperation(request, state, 'payment.pos.report')
          const intent = state.paymentDomain.paymentIntents.find((item) => item.id === request.params.paymentIntentId)
          if (!intent) throw new Error('支付意图不存在')
          requireTableSessionDataScope(request, state, intent.tableSessionId, 'payment.pos.report')
          const runtime = resolveProvider(state.paymentDomain, intent.channel)
          const before = state.paymentDomain.idempotencyRecords.length
          const occurredAt = new Date().toISOString()
          const query = await queryPaymentThroughProvider({
            state: state.paymentDomain,
            adapter: runtime.adapter,
            secrets: runtime.secrets,
            paymentIntentId: intent.id,
            queryId: deterministicProviderId('Query', input.idempotencyKey),
            requestedBy: actor.actorId,
            occurredAt,
            receivedAt: new Date().toISOString(),
            idempotencyKey: input.idempotencyKey,
          })
          submitOrdersAfterVerifiedPayment(state, intent.id)
          if (state.paymentDomain.idempotencyRecords.length !== before) {
            audit(state, actor.actorId, 'payment.provider.queried.v1', 'paymentQuery', query.id, {
              paymentIntentId: intent.id,
              resultStatus: query.resultStatus,
            })
          }
          return query
        })
      } catch (error) {
        const unavailable = providerUnavailable(reply, error)
        if (unavailable) return unavailable
        throw error
      }
    },
  )

  // Development-only channel simulator. Production adapters must verify provider signatures.
  app.post<{ Params: { paymentIntentId: string } }>(
    '/api/payments/:paymentIntentId/dev-simulate-success',
    async (request) => {
      const actor = requireSimulationActor(request, allowPilotSimulation)
      const input = simulatePaymentSuccessSchema.parse(request.body)
      return repository.mutate((state) => {
        const intent = state.paymentDomain.paymentIntents.find((item) => item.id === request.params.paymentIntentId)
        if (!intent) throw new Error('支付意图不存在')
        requireTableSessionDataScope(request, state, intent.tableSessionId, 'payment.pos.report')
        if (intent.channel !== 'wechat_mock') throw new Error('只有联调模拟渠道可以执行此操作')
        const now = new Date().toISOString()
        const notificationCount = state.paymentDomain.paymentNotifications.length
        handlePaymentNotification(state.paymentDomain, {
          channel: intent.channel,
          notificationId: `mock_notice_${input.idempotencyKey}`,
          paymentIntentId: intent.id,
          channelTransactionId: deterministicId('mock_txn', input.idempotencyKey),
          status: 'succeeded',
          amount: intent.amount,
          currency: intent.currency,
          merchantId: intent.merchantId,
          signatureVerified: true,
          channelOccurredAt: now,
          receivedAt: now,
        })
        if (state.paymentDomain.paymentNotifications.length !== notificationCount) {
          audit(state, actor.actorId, 'payment.mock.succeeded.v1', 'paymentIntent', intent.id, {
            warning: 'development simulator only',
          })
        }
        return intent
      })
    },
  )

  app.post<{ Params: { paymentIntentId: string } }>(
    '/api/payments/:paymentIntentId/cash-confirmations',
    async (request, reply) => {
      const input = cashPaymentConfirmationSchema.parse(request.body)
      const confirmation = await repository.mutate((state) => {
        const actor = requireConfiguredOperation(request, state, 'payment.pos.report')
        const intent = state.paymentDomain.paymentIntents.find((item) => item.id === request.params.paymentIntentId)
        if (!intent) throw new Error('支付意图不存在')
        requireTableSessionDataScope(request, state, intent.tableSessionId, 'payment.pos.report')
        const idempotencyCount = state.paymentDomain.idempotencyRecords.length
        const now = new Date().toISOString()
        const result = confirmCashPayment(state.paymentDomain, {
          confirmationId: deterministicId('cash_confirmation', input.idempotencyKey),
          paymentIntentId: intent.id,
          amount: intent.amount,
          currency: intent.currency,
          confirmedBy: actor.actorId,
          deviceId: input.deviceId,
          occurredAt: now,
          idempotencyKey: input.idempotencyKey,
        })
        if (state.paymentDomain.idempotencyRecords.length !== idempotencyCount) {
          audit(state, actor.actorId, 'payment.cash.confirmed.v1', 'cashPaymentConfirmation', result.id, {
            paymentIntentId: intent.id,
            tableSessionId: intent.tableSessionId,
            amount: intent.amount,
          })
        }
        return result
      })
      return reply.status(201).send(confirmation)
    },
  )

  app.post<{ Params: { paymentIntentId: string } }>(
    '/api/payments/:paymentIntentId/physical-pos-reports',
    async (request, reply) => {
      const input = physicalPosReportSchema.parse(request.body)
      const report = await repository.mutate((state) => {
        const actor = requireConfiguredOperation(request, state, 'payment.pos.report')
        const idempotencyCount = state.paymentDomain.idempotencyRecords.length
        const intent = state.paymentDomain.paymentIntents.find((item) => item.id === request.params.paymentIntentId)
        if (!intent) throw new Error('支付意图不存在')
        requireTableSessionDataScope(request, state, intent.tableSessionId, 'payment.pos.report')
        const now = new Date().toISOString()
        const result = reportPhysicalPosPayment(state.paymentDomain, {
          reportId: deterministicId('pos_report', input.idempotencyKey),
          paymentIntentId: intent.id,
          terminalId: input.terminalId,
          terminalTransactionId: input.terminalTransactionId,
          paymentMethod: input.paymentMethod,
          amount: intent.amount,
          currency: intent.currency,
          paidAt: now,
          reportedBy: actor.actorId,
          deviceId: input.deviceId,
          receiptReference: input.receiptReference,
          occurredAt: now,
          idempotencyKey: input.idempotencyKey,
        })
        if (state.paymentDomain.idempotencyRecords.length !== idempotencyCount) {
          audit(state, actor.actorId, 'payment.physical_pos.reported.v1', 'physicalPosReport', result.id, {
            paymentIntentId: intent.id,
            amount: intent.amount,
            terminalId: input.terminalId,
          })
        }
        return result
      })
      return reply.status(201).send(report)
    },
  )

  app.post<{ Params: { paymentIntentId: string } }>(
    '/api/payments/:paymentIntentId/refunds',
    async (request, reply) => {
      const input = itemRefundRequestSchema.parse(request.body)
      const refund = await repository.mutate((state) => {
        const actor = requireConfiguredOperation(request, state, 'payment.refund.request')
        const intent = state.paymentDomain.paymentIntents.find((item) => item.id === request.params.paymentIntentId)
        if (!intent) throw new Error('支付意图不存在')
        requireTableSessionDataScope(request, state, intent.tableSessionId, 'payment.refund.request')
        const idempotencyCount = state.paymentDomain.idempotencyRecords.length
        const result = requestRefund(state.paymentDomain, {
          refundId: intent.channel === 'postar'
            ? deterministicProviderId('Refund', input.idempotencyKey)
            : deterministicId('refund', input.idempotencyKey),
          paymentIntentId: request.params.paymentIntentId,
          items: [{ orderId: input.orderId, orderItemId: input.orderItemId, quantity: input.quantity }],
          reason: input.reason,
          requestedBy: actor.actorId,
          occurredAt: new Date().toISOString(),
          idempotencyKey: input.idempotencyKey,
        })
        requireApprovalAmount(request, state, 'refundRequest', result.amount, 'payment.refund.request')
        if (state.paymentDomain.idempotencyRecords.length !== idempotencyCount) {
          audit(state, actor.actorId, 'refund.requested.v1', 'refund', result.id, {
            paymentIntentId: request.params.paymentIntentId,
            amount: result.amount,
            items: result.items,
          })
        }
        return result
      })
      return reply.status(201).send(refund)
    },
  )

  app.post<{ Params: { refundId: string } }>(
    '/api/payments/refunds/:refundId/provider-submit',
    async (request, reply) => {
      const input = providerRefundSubmissionSchema.parse(request.body)
      try {
        const prepared = await repository.mutate((state) => {
          const actor = requireConfiguredOperation(request, state, 'payment.refund.approve')
          const refund = state.paymentDomain.refunds.find((item) => item.id === request.params.refundId)
          if (!refund) throw new Error('退款申请不存在')
          if (refund.requestedBy === actor.actorId) throw new Error('退款申请人与审批确认人必须为不同员工')
          const intent = state.paymentDomain.paymentIntents.find((item) => item.id === refund.paymentIntentId)
          if (!intent) throw new Error('原支付意图不存在')
          requireTableSessionDataScope(request, state, intent.tableSessionId, 'payment.refund.approve')
          requireApprovalAmount(request, state, 'refundApprove', refund.amount, 'payment.refund.approve')
          if (refund.status === 'requested') {
            approveRefund(state.paymentDomain, {
              refundId: refund.id,
              approvedBy: actor.actorId,
              reason: input.reason,
              occurredAt: new Date().toISOString(),
              idempotencyKey: `${input.idempotencyKey}:approve`,
            })
            audit(state, actor.actorId, 'refund.provider.approved.v1', 'refund', refund.id, {
              paymentIntentId: intent.id,
              amount: refund.amount,
            })
          }
          const runtime = refund.status === 'approved' ? resolveProvider(state.paymentDomain, intent.channel) : null
          return { actorId: actor.actorId, refund, intent, runtime }
        })
        if (!prepared.runtime) return prepared.refund
        const providerKey = `${input.idempotencyKey}:provider`
        const observation = await requestRefundThroughProvider({
          refund: prepared.refund,
          intent: prepared.intent,
          adapter: prepared.runtime.adapter,
          secrets: prepared.runtime.secrets,
          idempotencyKey: providerKey,
        })
        return await persistExternalResult(repository, (state) => {
          const result = applyProviderRefundSubmission(
            state.paymentDomain,
            prepared.runtime!.adapter.provider,
            prepared.refund.id,
            prepared.actorId,
            providerKey,
            observation,
          )
          audit(state, prepared.actorId, 'refund.provider.submitted.v1', 'refund', result.id, {
            paymentIntentId: prepared.intent.id,
            amount: result.amount,
            status: result.status,
            channelRefundId: result.channelRefundId,
          })
          return result
        })
      } catch (error) {
        const unavailable = providerUnavailable(reply, error)
        if (unavailable) return unavailable
        throw error
      }
    },
  )

  app.post<{ Params: { refundId: string } }>(
    '/api/payments/refunds/:refundId/provider-query',
    async (request, reply) => {
      const input = providerRefundQuerySchema.parse(request.body)
      try {
        return await repository.mutate(async (state) => {
          const actor = requireConfiguredOperation(request, state, 'payment.refund.approve')
          const refund = state.paymentDomain.refunds.find((item) => item.id === request.params.refundId)
          if (!refund) throw new Error('退款申请不存在')
          const intent = state.paymentDomain.paymentIntents.find((item) => item.id === refund.paymentIntentId)
          if (!intent) throw new Error('原支付意图不存在')
          requireTableSessionDataScope(request, state, intent.tableSessionId, 'payment.refund.approve')
          const runtime = resolveProvider(state.paymentDomain, intent.channel)
          const before = state.paymentDomain.idempotencyRecords.length
          const result = await queryRefundThroughProvider({
            state: state.paymentDomain,
            adapter: runtime.adapter,
            secrets: runtime.secrets,
            refundId: refund.id,
            requestedBy: actor.actorId,
            idempotencyKey: input.idempotencyKey,
          })
          if (state.paymentDomain.idempotencyRecords.length !== before) {
            audit(state, actor.actorId, 'refund.provider.queried.v1', 'refund', result.id, {
              paymentIntentId: intent.id,
              status: result.status,
            })
          }
          return result
        })
      } catch (error) {
        const unavailable = providerUnavailable(reply, error)
        if (unavailable) return unavailable
        throw error
      }
    },
  )

  // Development-only approval/channel completion; production uses RBAC plus provider refund callbacks.
  app.post<{ Params: { refundId: string } }>(
    '/api/payments/refunds/:refundId/physical-pos-complete',
    async (request) => {
      const input = physicalPosRefundCompletionSchema.parse(request.body)
      return repository.mutate((state) => {
        const actor = requireConfiguredOperation(request, state, 'payment.refund.approve')
        const refund = state.paymentDomain.refunds.find((item) => item.id === request.params.refundId)
        if (!refund) throw new Error('退款申请不存在')
        requireApprovalAmount(request, state, 'refundApprove', refund.amount, 'payment.refund.approve')
        if (refund.requestedBy === actor.actorId) throw new Error('退款申请人与审批确认人必须为不同员工')
        const intent = state.paymentDomain.paymentIntents.find((item) => item.id === refund.paymentIntentId)
        if (!intent || intent.channel !== 'physical_pos') throw new Error('该退款不属于物理POS交易')
        requireTableSessionDataScope(request, state, intent.tableSessionId, 'payment.refund.approve')
        const idempotencyCount = state.paymentDomain.idempotencyRecords.length
        const now = new Date().toISOString()
        const approved = approveRefund(state.paymentDomain, {
          refundId: refund.id,
          approvedBy: actor.actorId,
          reason: input.reason,
          occurredAt: now,
          idempotencyKey: `${input.idempotencyKey}:approve`,
        })
        startRefund(state.paymentDomain, {
          refundId: approved.id,
          channelRefundId: deterministicId('pos_refund', input.terminalRefundTransactionId),
          actorId: actor.actorId,
          occurredAt: now,
          idempotencyKey: `${input.idempotencyKey}:start`,
        })
        const completed = markRefundSucceeded(state.paymentDomain, {
          refundId: approved.id,
          channelRefundTransactionId: input.terminalRefundTransactionId,
          refundedAmount: approved.amount,
          currency: approved.currency,
          occurredAt: now,
          idempotencyKey: `${input.idempotencyKey}:success`,
        })
        if (state.paymentDomain.idempotencyRecords.length !== idempotencyCount) {
          audit(state, actor.actorId, 'refund.physical_pos.completed.v1', 'refund', completed.id, {
            paymentIntentId: intent.id,
            amount: completed.amount,
            terminalRefundTransactionId: input.terminalRefundTransactionId,
          })
        }
        return completed
      })
    },
  )

  app.post<{ Params: { refundId: string } }>(
    '/api/payments/refunds/:refundId/dev-approve-complete',
    async (request) => {
      const actor = requireSimulationActor(request, allowPilotSimulation)
      const input = completeRefundSchema.parse(request.body)
      return repository.mutate((state) => {
        requireConfiguredOperation(request, state, 'payment.refund.approve')
        const refund = state.paymentDomain.refunds.find((item) => item.id === request.params.refundId)
        if (!refund) throw new Error('退款申请不存在')
        const intent = state.paymentDomain.paymentIntents.find((item) => item.id === refund.paymentIntentId)
        if (!intent) throw new Error('支付意图不存在')
        requireTableSessionDataScope(request, state, intent.tableSessionId, 'payment.refund.approve')
        requireApprovalAmount(request, state, 'refundApprove', refund.amount, 'payment.refund.approve')
        const idempotencyCount = state.paymentDomain.idempotencyRecords.length
        const now = new Date().toISOString()
        const approved = approveRefund(state.paymentDomain, {
          refundId: request.params.refundId,
          approvedBy: actor.actorId,
          reason: '开发环境退款审批联调',
          occurredAt: now,
          idempotencyKey: `${input.idempotencyKey}:approve`,
        })
        startRefund(state.paymentDomain, {
          refundId: approved.id,
          channelRefundId: deterministicId('mock_channel_refund', input.idempotencyKey),
          actorId: actor.actorId,
          occurredAt: now,
          idempotencyKey: `${input.idempotencyKey}:start`,
        })
        const completed = markRefundSucceeded(state.paymentDomain, {
          refundId: approved.id,
          channelRefundTransactionId: deterministicId('mock_refund_txn', input.idempotencyKey),
          refundedAmount: approved.amount,
          currency: approved.currency,
          occurredAt: now,
          idempotencyKey: `${input.idempotencyKey}:success`,
        })
        if (state.paymentDomain.idempotencyRecords.length !== idempotencyCount) {
          audit(state, actor.actorId, 'refund.mock.succeeded.v1', 'refund', completed.id, {
            warning: 'development simulator only',
            amount: completed.amount,
          })
        }
        return completed
      })
    },
  )
}
