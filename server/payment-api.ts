import { createHash, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import {
  completeRefundSchema,
  createTablePaymentIntentSchema,
  itemRefundRequestSchema,
  physicalPosRefundCompletionSchema,
  physicalPosReportSchema,
  simulatePaymentSuccessSchema,
} from '../src/shared/payment-api.js'
import type { PaymentIntentStatus } from '../src/shared/payment-contracts.js'
import {
  approveRefund,
  createPaymentIntent,
  handlePaymentNotification,
  markRefundSucceeded,
  reportPhysicalPosPayment,
  requestRefund,
  startRefund,
} from './payment-domain.js'
import { AuthenticationError, requireRequestActor } from './auth-context.js'
import { requireOperation } from './authorization.js'
import type { RuntimeRepository } from './repository.js'

const ACTIVE_ALLOCATION_STATUSES = new Set<PaymentIntentStatus>([
  'pending',
  'processing',
  'succeeded',
  'reported_pending_reconciliation',
])

function deterministicId(prefix: string, key: string) {
  return `${prefix}_${createHash('sha256').update(key).digest('hex').slice(0, 32)}`
}

function requireDevelopmentActor(request: Parameters<typeof requireRequestActor>[0]) {
  const actor = requireRequestActor(request)
  if (actor.runtimeMode !== 'local' && actor.runtimeMode !== 'test') {
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

function remainingAllocations(
  state: Awaited<ReturnType<RuntimeRepository['read']>>,
  tableSessionId: string,
) {
  const allocatedQuantities = new Map<string, number>()
  for (const intent of state.paymentDomain.paymentIntents) {
    if (intent.tableSessionId !== tableSessionId || !ACTIVE_ALLOCATION_STATUSES.has(intent.status)) continue
    for (const allocation of intent.lineAllocations) {
      allocatedQuantities.set(
        allocation.orderItemId,
        (allocatedQuantities.get(allocation.orderItemId) ?? 0) + allocation.quantity,
      )
    }
  }

  return state.orderDomain.orders
    .filter((order) => order.tableSessionId === tableSessionId && order.status !== 'draft')
    .flatMap((order) => order.items.map((item) => ({ order, item })))
    .map(({ order, item }) => ({
      orderId: order.id,
      orderItemId: item.id,
      quantity: item.quantity - (allocatedQuantities.get(item.id) ?? 0),
      unitPaidAmount: item.unitSalePriceAmount,
    }))
    .filter((allocation) => allocation.quantity > 0)
}

export function registerPaymentRoutes(app: FastifyInstance, repository: RuntimeRepository) {
  app.post('/api/payments/table-intents', async (request, reply) => {
    const input = createTablePaymentIntentSchema.parse(request.body)
    const actor = requireOperation(request, 'payment.intent.create')
    if (input.channel === 'wechat_mock' && actor.runtimeMode !== 'local' && actor.runtimeMode !== 'test') {
      throw new AuthenticationError('当前环境未启用模拟支付渠道', 404, 'DEVELOPMENT_CHANNEL_DISABLED')
    }
    const intent = await repository.mutate((state) => {
      const existingRecord = state.paymentDomain.idempotencyRecords.find((record) => record.key === input.idempotencyKey)
      if (existingRecord) {
        if (existingRecord.operation !== 'payment.create_intent.v1' || existingRecord.resultType !== 'payment_intent') {
          throw new Error('幂等键已用于不同请求')
        }
        const existingIntent = state.paymentDomain.paymentIntents.find((item) => item.id === existingRecord.resultId)
        if (!existingIntent) throw new Error('支付幂等记录指向的支付意图不存在')
        if (
          existingIntent.tableSessionId !== input.tableSessionId ||
          existingIntent.channel !== input.channel ||
          existingIntent.createdBy !== actor.actorId ||
          existingIntent.deviceId !== input.deviceId
        ) {
          throw new Error('幂等键已用于不同请求')
        }
        return existingIntent
      }
      const idempotencyCount = state.paymentDomain.idempotencyRecords.length
      const allocations = remainingAllocations(state, input.tableSessionId)
      if (allocations.length === 0) throw new Error('该桌台没有可支付的订单商品')
      const amount = allocations.reduce(
        (sum, allocation) => sum + allocation.quantity * allocation.unitPaidAmount,
        0,
      )
      const now = new Date()
      const result = createPaymentIntent(state.paymentDomain, {
        paymentIntentId: deterministicId('payment', input.idempotencyKey),
        tableSessionId: input.tableSessionId,
        lineAllocations: allocations,
        amount,
        currency: 'CNY',
        channel: input.channel,
        merchantId: 'mbox-lujiazui-demo',
        createdBy: actor.actorId,
        deviceId: input.deviceId,
        occurredAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 15 * 60 * 1000).toISOString(),
        idempotencyKey: input.idempotencyKey,
      })
      if (state.paymentDomain.idempotencyRecords.length !== idempotencyCount) {
        audit(state, actor.actorId, 'payment.intent.created.v1', 'paymentIntent', result.id, {
          tableSessionId: input.tableSessionId,
          channel: input.channel,
          amount,
          orderIds: result.orderIds,
        })
      }
      return result
    })
    return reply.status(201).send(intent)
  })

  // Development-only channel simulator. Production adapters must verify provider signatures.
  app.post<{ Params: { paymentIntentId: string } }>(
    '/api/payments/:paymentIntentId/dev-simulate-success',
    async (request) => {
      const actor = requireDevelopmentActor(request)
      const input = simulatePaymentSuccessSchema.parse(request.body)
      return repository.mutate((state) => {
        const intent = state.paymentDomain.paymentIntents.find((item) => item.id === request.params.paymentIntentId)
        if (!intent) throw new Error('支付意图不存在')
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
    '/api/payments/:paymentIntentId/physical-pos-reports',
    async (request, reply) => {
      const input = physicalPosReportSchema.parse(request.body)
      const actor = requireOperation(request, 'payment.pos.report')
      const report = await repository.mutate((state) => {
        const idempotencyCount = state.paymentDomain.idempotencyRecords.length
        const intent = state.paymentDomain.paymentIntents.find((item) => item.id === request.params.paymentIntentId)
        if (!intent) throw new Error('支付意图不存在')
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
      const actor = requireOperation(request, 'payment.refund.request')
      const refund = await repository.mutate((state) => {
        const idempotencyCount = state.paymentDomain.idempotencyRecords.length
        const result = requestRefund(state.paymentDomain, {
          refundId: deterministicId('refund', input.idempotencyKey),
          paymentIntentId: request.params.paymentIntentId,
          items: [{ orderId: input.orderId, orderItemId: input.orderItemId, quantity: input.quantity }],
          reason: input.reason,
          requestedBy: actor.actorId,
          occurredAt: new Date().toISOString(),
          idempotencyKey: input.idempotencyKey,
        })
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

  // Development-only approval/channel completion; production uses RBAC plus provider refund callbacks.
  app.post<{ Params: { refundId: string } }>(
    '/api/payments/refunds/:refundId/physical-pos-complete',
    async (request) => {
      const actor = requireOperation(request, 'payment.refund.approve')
      const input = physicalPosRefundCompletionSchema.parse(request.body)
      return repository.mutate((state) => {
        const refund = state.paymentDomain.refunds.find((item) => item.id === request.params.refundId)
        if (!refund) throw new Error('退款申请不存在')
        if (refund.requestedBy === actor.actorId) throw new Error('退款申请人与审批确认人必须为不同员工')
        const intent = state.paymentDomain.paymentIntents.find((item) => item.id === refund.paymentIntentId)
        if (!intent || intent.channel !== 'physical_pos') throw new Error('该退款不属于物理POS交易')
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
      const actor = requireDevelopmentActor(request)
      const input = completeRefundSchema.parse(request.body)
      return repository.mutate((state) => {
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
