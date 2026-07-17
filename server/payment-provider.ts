import type { PaymentDomainState, PaymentIntent, Refund } from '../src/shared/payment-contracts.js'
import type {
  PaymentProviderAdapter,
  PaymentProviderSecretSource,
  ProviderCreatePaymentRequest,
  ProviderCreatePaymentResult,
  ProviderPaymentObservation,
  ProviderRefundObservation,
  RawPaymentProviderCallback,
} from '../src/shared/payment-provider-contracts.js'
import type { PostarEnvironment, PostarRefundTag } from '../src/shared/postar-contracts.js'
import {
  applyPaymentQueryResult,
  handlePaymentNotification,
  markRefundFailed,
  markRefundSucceeded,
  requestPaymentStatusQuery,
  startRefund,
} from './payment-domain.js'
import { PostarPaymentProviderAdapter } from './postar-adapter.js'

interface ProviderBoundaryDependencies {
  state: PaymentDomainState
  adapter: PaymentProviderAdapter
  secrets: PaymentProviderSecretSource
}

export interface ProcessPaymentCallbackInput extends ProviderBoundaryDependencies {
  callback: RawPaymentProviderCallback
}

export interface CreateProviderPaymentInput extends ProviderBoundaryDependencies {
  request: ProviderCreatePaymentRequest
}

export interface RequestProviderPaymentInput {
  intent: PaymentIntent
  adapter: PaymentProviderAdapter
  secrets: PaymentProviderSecretSource
  request: ProviderCreatePaymentRequest
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

export interface RequestProviderRefundInput {
  refund: Refund
  intent: PaymentIntent
  adapter: PaymentProviderAdapter
  secrets: PaymentProviderSecretSource
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

export async function requestPaymentThroughProvider(input: RequestProviderPaymentInput) {
  const { intent } = input
  assertProvider(intent.channel, input.adapter.provider)
  if (intent.status !== 'pending') throw new Error('只有待支付意图可以提交渠道下单')
  if (input.request.amount !== intent.amount || input.request.currency !== intent.currency) {
    throw new Error('渠道下单金额或币种与支付意图不一致')
  }
  if (input.request.merchantId !== intent.merchantId) throw new Error('渠道下单商户与支付意图不一致')
  const result = await input.adapter.createPayment(input.request, { secrets: input.secrets })
  if (result.paymentIntentId !== intent.id) throw new Error('渠道下单结果与支付意图不一致')
  if (result.status !== 'processing') throw new Error('渠道下单只能进入处理中状态')
  if (result.amount !== intent.amount || result.currency !== intent.currency || result.merchantId !== intent.merchantId) {
    throw new Error('渠道下单结果金额、币种或商户不一致')
  }
  if (result.providerTransactionId !== null && !result.providerTransactionId.trim()) throw new Error('渠道下单结果交易号无效')
  if (Number.isNaN(Date.parse(result.occurredAt)) || Date.parse(result.occurredAt) < Date.parse(intent.createdAt)) {
    throw new Error('渠道下单结果时间无效')
  }
  return result
}

export function applyProviderPaymentCreation(
  state: PaymentDomainState,
  adapterProvider: string,
  request: ProviderCreatePaymentRequest,
  result: ProviderCreatePaymentResult,
) {
  const intent = findIntent(state, request.paymentIntentId)
  assertProvider(intent.channel, adapterProvider)
  if (intent.status === 'succeeded') {
    if (result.providerTransactionId !== null && intent.channelTransactionId !== result.providerTransactionId) {
      throw new Error('已到账支付意图绑定了不同渠道交易号')
    }
    intent.providerPaymentPayload ??= result.paymentPayload
    intent.providerOrderCreatedAt ??= result.occurredAt
    return intent
  }
  if (intent.status === 'processing') {
    if (result.providerTransactionId !== null && intent.channelTransactionId !== result.providerTransactionId) {
      throw new Error('渠道支付意图已绑定不同交易号')
    }
    return intent
  }
  if (intent.status !== 'pending') throw new Error('只有待支付意图可以记录渠道下单结果')
  if (request.amount !== intent.amount || request.currency !== intent.currency || request.merchantId !== intent.merchantId) {
    throw new Error('渠道下单请求与支付意图不一致')
  }
  if (result.paymentIntentId !== intent.id) throw new Error('渠道下单结果与支付意图不一致')
  if (result.status !== 'processing') throw new Error('渠道下单只能进入处理中状态')
  if (result.amount !== intent.amount || result.currency !== intent.currency || result.merchantId !== intent.merchantId) {
    throw new Error('渠道下单结果金额、币种或商户不一致')
  }
  if (result.providerTransactionId !== null && !result.providerTransactionId.trim()) throw new Error('渠道下单结果交易号无效')
  const duplicate = result.providerTransactionId === null ? undefined : state.paymentIntents.find((item) => (
    item.id !== intent.id
    && item.channel === intent.channel
    && item.channelTransactionId === result.providerTransactionId
  ))
  if (duplicate) throw new Error('渠道交易号已绑定其他支付意图')
  intent.status = 'processing'
  intent.channelTransactionId = result.providerTransactionId
  intent.providerPaymentPayload = result.paymentPayload
  intent.providerOrderCreatedAt = result.occurredAt
  return intent
}

export async function createPaymentThroughProvider(input: CreateProviderPaymentInput) {
  const intent = findIntent(input.state, input.request.paymentIntentId)
  const result = await requestPaymentThroughProvider({
    intent,
    adapter: input.adapter,
    secrets: input.secrets,
    request: input.request,
  })
  return applyProviderPaymentCreation(input.state, input.adapter.provider, input.request, result)
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
    settlementChannel: observation.settlementChannel,
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
    settlementChannel: observation.settlementChannel,
    channelOccurredAt: observation.occurredAt,
    receivedAt: input.receivedAt,
    idempotencyKey: `${input.idempotencyKey}:result`,
  })
}

export async function requestRefundThroughProvider(input: RequestProviderRefundInput) {
  const { refund, intent } = input
  assertProvider(intent.channel, input.adapter.provider)
  if (!['approved', 'failed'].includes(refund.status)) {
    throw new Error('只有已批准或渠道失败的退款可以提交渠道')
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
      settlementChannel: intent.settlementChannel,
    },
    { secrets: input.secrets },
  )
  assertRefundObservation(observation, refund)
  return observation
}

export function applyProviderRefundSubmission(
  state: PaymentDomainState,
  adapterProvider: string,
  refundId: string,
  actorId: string,
  idempotencyKey: string,
  observation: ProviderRefundObservation,
) {
  const refund = findRefund(state, refundId)
  const intent = findIntent(state, refund.paymentIntentId)
  assertProvider(intent.channel, adapterProvider)
  if (['processing', 'succeeded'].includes(refund.status)) {
    if (refund.channelRefundId !== observation.providerRefundId) {
      throw new Error('渠道退款结果与已记录退款单号不一致')
    }
    return refund
  }
  if (!['approved', 'failed'].includes(refund.status)) throw new Error('只有已批准或渠道失败的退款可以记录渠道结果')
  assertRefundObservation(observation, refund)
  startRefund(state, {
    refundId: refund.id,
    channelRefundId: observation.providerRefundId,
    actorId,
    occurredAt: observation.occurredAt,
    idempotencyKey: `${idempotencyKey}:start`,
  })
  return applyRefundObservation(state, refund, observation, `${idempotencyKey}:result`)
}

export async function submitRefundThroughProvider(input: SubmitProviderRefundInput) {
  const refund = findRefund(input.state, input.refundId)
  if (['processing', 'succeeded'].includes(refund.status)) return refund
  const intent = findIntent(input.state, refund.paymentIntentId)
  const observation = await requestRefundThroughProvider({
    refund,
    intent,
    adapter: input.adapter,
    secrets: input.secrets,
    idempotencyKey: input.idempotencyKey,
  })
  return applyProviderRefundSubmission(
    input.state,
    input.adapter.provider,
    refund.id,
    input.actorId,
    input.idempotencyKey,
    observation,
  )
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

export class PaymentProviderUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PaymentProviderUnavailableError'
  }
}

export interface PaymentProviderRuntime {
  adapter: PaymentProviderAdapter
  secrets: PaymentProviderSecretSource
  merchantId: string
  callbackUrl: string
  callbackAcknowledgement: { rspCod: '' | '000000'; rspMsg: 'success' }
}

export type PaymentProviderResolver = (
  state: PaymentDomainState,
  provider: string,
) => PaymentProviderRuntime

function requireEnvironmentValue(environment: NodeJS.ProcessEnv, name: string) {
  const value = environment[name]?.trim()
  if (!value) throw new PaymentProviderUnavailableError(`支付渠道不可用：缺少环境变量 ${name}`)
  return value
}

function compactShanghaiDate(value: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(value))
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? ''
  return `${part('year')}${part('month')}${part('day')}`
}

export function createEnvironmentPaymentProviderResolver(
  environment: NodeJS.ProcessEnv = process.env,
): PaymentProviderResolver {
  return (state, provider) => {
    if (provider !== 'postar') throw new PaymentProviderUnavailableError(`支付渠道不可用：未配置 ${provider} 适配器`)
    if (environment.MBOX_POSTAR_ENABLED !== 'true') {
      throw new PaymentProviderUnavailableError('星驿支付不可用：MBOX_POSTAR_ENABLED 未设置为 true')
    }
    const postarEnvironment = requireEnvironmentValue(environment, 'MBOX_POSTAR_ENVIRONMENT')
    if (!['test', 'uat', 'production'].includes(postarEnvironment)) {
      throw new PaymentProviderUnavailableError('星驿支付不可用：MBOX_POSTAR_ENVIRONMENT 必须为 test、uat 或 production')
    }
    const merchantId = requireEnvironmentValue(environment, 'MBOX_POSTAR_MERCHANT_ID')
    const agencyId = requireEnvironmentValue(environment, 'MBOX_POSTAR_AGENCY_ID')
    const publicKey = requireEnvironmentValue(environment, 'MBOX_POSTAR_PUBLIC_KEY')
    const callbackUrl = requireEnvironmentValue(environment, 'MBOX_POSTAR_CALLBACK_URL')
    const refundTag = requireEnvironmentValue(environment, 'MBOX_POSTAR_REFUND_TAG')
    if (!['1', '2', '9', '11', '12', '30'].includes(refundTag)) {
      throw new PaymentProviderUnavailableError('星驿支付不可用：MBOX_POSTAR_REFUND_TAG 无效')
    }
    const callbackCode = environment.MBOX_POSTAR_CALLBACK_SUCCESS_CODE
    if (callbackCode !== '' && callbackCode !== '000000') {
      throw new PaymentProviderUnavailableError('星驿支付不可用：必须明确配置 MBOX_POSTAR_CALLBACK_SUCCESS_CODE 为空串或 000000')
    }
    const timeoutMs = Number(environment.MBOX_POSTAR_HTTP_TIMEOUT_MS ?? '10000')
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30000) {
      throw new PaymentProviderUnavailableError('星驿支付不可用：MBOX_POSTAR_HTTP_TIMEOUT_MS 必须为1000至30000毫秒')
    }
    const secrets: PaymentProviderSecretSource = {
      async getSecret(name) {
        if (name === 'postar.agencyId') return agencyId
        if (name === 'postar.publicKey') return publicKey
        throw new PaymentProviderUnavailableError(`星驿支付不可用：未知密钥 ${name}`)
      },
    }
    const adapter = new PostarPaymentProviderAdapter({
      environment: postarEnvironment as PostarEnvironment,
      httpClient: {
        async post(request) {
          let response: Response
          try {
            response = await fetch(request.url, {
              method: 'POST',
              headers: request.headers,
              body: Buffer.from(request.body),
              signal: AbortSignal.timeout(timeoutMs),
            })
          } catch (error) {
            throw new Error(`星驿网络请求失败: ${error instanceof Error ? error.message : '未知错误'}`)
          }
          const body = new Uint8Array(await response.arrayBuffer())
          if (body.byteLength > 1_048_576) throw new Error('星驿HTTP响应超过1MB限制')
          const headers: Record<string, string> = {}
          response.headers.forEach((value, key) => { headers[key] = value })
          return { status: response.status, headers, body }
        },
      },
      metadataSource: {
        async getPaymentMetadata(request) {
          const intent = state.paymentIntents.find((item) => item.id === request.paymentIntentId)
          if (!intent) throw new Error('支付意图不存在，无法读取星驿支付日期')
          return { orderDate: compactShanghaiDate(intent.providerOrderCreatedAt ?? intent.createdAt) }
        },
        async getRefundMetadata(request) {
          const refund = state.refunds.find((item) => item.id === request.refundId)
          if (!refund) throw new Error('退款申请不存在，无法读取星驿退款元数据')
          return { merchantId, tag: refundTag as PostarRefundTag }
        },
        async getRefundQueryMetadata(request) {
          const refund = state.refunds.find((item) => item.id === request.refundId)
          if (!refund) throw new Error('退款申请不存在，无法读取星驿退款日期')
          return { refundDate: compactShanghaiDate(refund.processingAt ?? refund.requestedAt) }
        },
      },
      billSource: {
        async downloadBill() {
          throw new PaymentProviderUnavailableError('星驿SFTP账单源尚未配置，不能返回空账单或伪对账成功')
        },
      },
    })
    return {
      adapter,
      secrets,
      merchantId,
      callbackUrl,
      callbackAcknowledgement: { rspCod: callbackCode, rspMsg: 'success' },
    }
  }
}
