import type { PaymentDomainState, Refund } from '../src/shared/payment-contracts.js'
import type {
  PaymentProviderAdapter,
  PaymentProviderSecretSource,
  ProviderPaymentObservation,
  ProviderRefundObservation,
  RawPaymentProviderCallback,
} from '../src/shared/payment-provider-contracts.js'
import {
  applyPaymentQueryResult,
  handlePaymentNotification,
  markRefundFailed,
  markRefundSucceeded,
  requestPaymentStatusQuery,
  startRefund,
} from './payment-domain.js'

interface ProviderBoundaryDependencies {
  state: PaymentDomainState
  adapter: PaymentProviderAdapter
  secrets: PaymentProviderSecretSource
}

export interface ProcessPaymentCallbackInput extends ProviderBoundaryDependencies {
  callback: RawPaymentProviderCallback
}

export interface QueryProviderPaymentInput extends ProviderBoundaryDependencies {
  paymentIntentId: string
  queryId: string
  requestedBy: string
  occurredAt: string
  receivedAt: string
  idempotencyKey: string
}

export interface SubmitProviderRefundInput extends ProviderBoundaryDependencies {
  refundId: string
  actorId: string
  idempotencyKey: string
}

export interface QueryProviderRefundInput extends ProviderBoundaryDependencies {
  refundId: string
  requestedBy: string
  idempotencyKey: string
}

function findIntent(state: PaymentDomainState, paymentIntentId: string) {
  const intent = state.paymentIntents.find((item) => item.id === paymentIntentId)
  if (!intent) throw new Error('支付意图不存在')
  return intent
}

function findRefund(state: PaymentDomainState, refundId: string) {
  const refund = state.refunds.find((item) => item.id === refundId)
  if (!refund) throw new Error('退款申请不存在')
  return refund
}

function assertProvider(expected: string, actual: string) {
  if (expected !== actual) throw new Error('支付适配器与支付意图渠道不一致')
}

function assertPaymentObservation(
  observation: ProviderPaymentObservation,
  paymentIntentId: string,
) {
  if (observation.paymentIntentId !== paymentIntentId) {
    throw new Error('渠道支付结果与请求的支付意图不一致')
  }
}

function assertRefundObservation(observation: ProviderRefundObservation, refund: Refund) {
  if (observation.refundId !== refund.id) throw new Error('渠道退款结果与退款申请不一致')
  if (observation.providerRefundId.trim().length === 0) throw new Error('渠道退款单号不能为空')
  if (observation.amount !== refund.amount) throw new Error('渠道退款金额与商品退款金额不一致')
  if (observation.currency !== refund.currency) throw new Error('渠道退款币种不一致')
  if (Number.isNaN(Date.parse(observation.occurredAt))) throw new Error('渠道退款时间无效')
}

function applyRefundObservation(
  state: PaymentDomainState,
  refund: Refund,
  observation: ProviderRefundObservation,
  idempotencyKey: string,
) {
  assertRefundObservation(observation, refund)
  if (refund.channelRefundId && refund.channelRefundId !== observation.providerRefundId) {
    throw new Error('渠道退款单号与已记录结果不一致')
  }

  if (refund.status === 'succeeded') {
    if (
      observation.status !== 'succeeded' ||
      refund.channelRefundTransactionId !== observation.providerRefundTransactionId
    ) {
      throw new Error('已成功退款不能被渠道结果覆盖')
    }
    return refund
  }
  if (refund.status === 'failed') {
    if (observation.status !== 'failed') throw new Error('已失败退款不能被渠道结果覆盖')
    return refund
  }
  if (refund.status !== 'processing') throw new Error('只有渠道处理中的退款可以接收渠道结果')

  switch (observation.status) {
    case 'processing':
      return refund
    case 'succeeded':
      if (!observation.providerRefundTransactionId?.trim()) throw new Error('退款成功缺少渠道退款交易号')
      return markRefundSucceeded(state, {
        refundId: refund.id,
        channelRefundTransactionId: observation.providerRefundTransactionId,
        refundedAmount: observation.amount,
        currency: observation.currency,
        occurredAt: observation.occurredAt,
        idempotencyKey: `${idempotencyKey}:succeeded`,
      })
    case 'failed':
      if (!observation.failureReason?.trim()) throw new Error('退款失败缺少渠道失败原因')
      return markRefundFailed(state, {
        refundId: refund.id,
        reason: observation.failureReason,
        occurredAt: observation.occurredAt,
        idempotencyKey: `${idempotencyKey}:failed`,
      })
  }
}

export async function processPaymentProviderCallback(input: ProcessPaymentCallbackInput) {
  const observation = await input.adapter.verifyPaymentCallback(input.callback, {
    secrets: input.secrets,
  })
  assertPaymentObservation(observation, observation.paymentIntentId)
  if (!observation.providerEventId.trim()) throw new Error('渠道事件ID不能为空')
  const intent = findIntent(input.state, observation.paymentIntentId)
  assertProvider(intent.channel, input.adapter.provider)

  return handlePaymentNotification(input.state, {
    channel: input.adapter.provider,
    notificationId: observation.providerEventId,
    paymentIntentId: observation.paymentIntentId,
    channelTransactionId: observation.providerTransactionId,
    status: observation.status,
    amount: observation.amount,
    currency: observation.currency,
    merchantId: observation.merchantId,
    signatureVerified: true,
    channelOccurredAt: observation.occurredAt,
    receivedAt: input.callback.receivedAt,
  })
}

export async function queryPaymentThroughProvider(input: QueryProviderPaymentInput) {
  const intent = findIntent(input.state, input.paymentIntentId)
  assertProvider(intent.channel, input.adapter.provider)
  const query = requestPaymentStatusQuery(input.state, {
    queryId: input.queryId,
    paymentIntentId: intent.id,
    requestedBy: input.requestedBy,
    occurredAt: input.occurredAt,
    idempotencyKey: `${input.idempotencyKey}:request`,
  })
  if (query.status === 'completed') return query

  const observation = await input.adapter.queryPayment(
    {
      paymentIntentId: intent.id,
      merchantId: intent.merchantId,
      providerTransactionId: intent.channelTransactionId,
    },
    { secrets: input.secrets },
  )
  assertPaymentObservation(observation, intent.id)

  return applyPaymentQueryResult(input.state, {
    queryId: query.id,
    channelTransactionId: observation.providerTransactionId,
    status: observation.status,
    amount: observation.amount,
    currency: observation.currency,
    merchantId: observation.merchantId,
    channelOccurredAt: observation.occurredAt,
    receivedAt: input.receivedAt,
    idempotencyKey: `${input.idempotencyKey}:result`,
  })
}

export async function submitRefundThroughProvider(input: SubmitProviderRefundInput) {
  const refund = findRefund(input.state, input.refundId)
  const intent = findIntent(input.state, refund.paymentIntentId)
  assertProvider(intent.channel, input.adapter.provider)
  if (refund.status !== 'approved') {
    if (['processing', 'succeeded', 'failed'].includes(refund.status)) return refund
    throw new Error('只有已批准退款可以提交渠道')
  }
  if (!intent.channelTransactionId) throw new Error('原支付缺少渠道交易号，不能提交退款')

  const observation = await input.adapter.requestRefund(
    {
      refundId: refund.id,
      paymentIntentId: intent.id,
      providerTransactionId: intent.channelTransactionId,
      amount: refund.amount,
      currency: refund.currency,
      items: refund.items,
      idempotencyKey: input.idempotencyKey,
    },
    { secrets: input.secrets },
  )
  assertRefundObservation(observation, refund)
  startRefund(input.state, {
    refundId: refund.id,
    channelRefundId: observation.providerRefundId,
    actorId: input.actorId,
    occurredAt: observation.occurredAt,
    idempotencyKey: `${input.idempotencyKey}:start`,
  })
  return applyRefundObservation(input.state, refund, observation, `${input.idempotencyKey}:result`)
}

export async function queryRefundThroughProvider(input: QueryProviderRefundInput) {
  const refund = findRefund(input.state, input.refundId)
  const intent = findIntent(input.state, refund.paymentIntentId)
  assertProvider(intent.channel, input.adapter.provider)
  if (!input.requestedBy.trim()) throw new Error('退款查询发起人不能为空')
  if (!refund.channelRefundId) throw new Error('退款尚未提交渠道')

  const observation = await input.adapter.queryRefund(
    {
      refundId: refund.id,
      providerRefundId: refund.channelRefundId,
      merchantId: intent.merchantId,
    },
    { secrets: input.secrets },
  )
  return applyRefundObservation(input.state, refund, observation, input.idempotencyKey)
}
