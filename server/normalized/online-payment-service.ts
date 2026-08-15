import type {
  PaymentProviderSecretSource,
  ProviderPaymentObservation,
} from '../../src/shared/payment-provider-contracts.js'
import type { OnlinePaymentAction } from '../../src/shared/online-payment-contracts.js'
import type { PostarHttpClient, PostarTransactionMetadataSource, PostarSftpBillSource } from '../../src/shared/postar-contracts.js'
import { PostarPaymentProviderAdapter, PostarPaymentRejectedError } from '../postar-adapter.js'
import type { NormalizedPaymentRuntimeConfig } from './normalized-runtime-config.js'
import {
  PaymentProviderActionRepository,
  type PaymentPrincipal,
  type ProviderPaymentContext,
  type ProviderPresentation,
} from './payment-provider-action-repository.js'
import type { ScopedPostgresTransactionRunner, StoreScope } from './transaction-runner.js'

export type { OnlinePaymentAction } from '../../src/shared/online-payment-contracts.js'

export interface CreateOnlinePaymentInput {
  scope: Readonly<StoreScope>
  paymentId: string
  principal: Readonly<PaymentPrincipal>
  clientIp: string
  operatorId: string
  customerAuthCode?: string
}

export interface ActiveOnlinePaymentInput {
  scope: Readonly<StoreScope>
  orderId: string
  principal: Readonly<PaymentPrincipal>
}

export interface QueryOnlinePaymentInput {
  scope: Readonly<StoreScope>
  paymentId: string
  principal: Readonly<PaymentPrincipal>
}

export interface OnlinePaymentQueryResult {
  context: ProviderPaymentContext
  observation: ProviderPaymentObservation
}

export class OnlinePaymentUnavailableError extends Error {
  constructor(message = '线上支付尚未配置，请改用其他收款方式') {
    super(message)
    this.name = 'OnlinePaymentUnavailableError'
  }
}

export class OnlinePaymentUnknownError extends Error {
  constructor() {
    super('支付结果暂时无法确认，请先查单，不要重复收款')
    this.name = 'OnlinePaymentUnknownError'
  }
}

export class OnlinePaymentService {
  private readonly adapter: PostarPaymentProviderAdapter | null
  private readonly secrets: PaymentProviderSecretSource | null

  constructor(
    private readonly transactions: Pick<ScopedPostgresTransactionRunner, 'run'>,
    private readonly secret: string,
    private readonly config: Readonly<NormalizedPaymentRuntimeConfig> | null,
  ) {
    if (config === null) {
      this.adapter = null
      this.secrets = null
      return
    }
    this.secrets = environmentSecrets(config)
    this.adapter = new PostarPaymentProviderAdapter({
      environment: config.environment,
      httpClient: fetchHttpClient(config.timeoutMs),
      metadataSource: unsupportedMetadataSource(),
      billSource: unsupportedBillSource(),
    })
  }

  assertAvailable(provider: 'postar' | 'simulation'): void {
    if (provider === 'simulation') return
    if (this.adapter === null || this.secrets === null || this.config === null) {
      throw new OnlinePaymentUnavailableError()
    }
  }

  async resolveActivePayment(input: Readonly<ActiveOnlinePaymentInput>): Promise<ProviderPaymentContext | null> {
    return this.transactions.run(input.scope, async (transaction) => (
      new PaymentProviderActionRepository(transaction, this.secret)
        .resolveActivePaymentForOrder(input.orderId, input.principal)
    ), { readOnly: true })
  }

  async resolveGuestMethod(
    scope: Readonly<StoreScope>,
    customerId: string,
  ): Promise<'jsapi' | 'native_qr'> {
    if (this.config?.wechat === null || this.config?.wechat === undefined) return 'native_qr'
    try {
      await this.transactions.run(scope, async (transaction) => {
        await new PaymentProviderActionRepository(transaction, this.secret).resolveWechatPayerId(
          customerId,
          this.config!.wechat!.appId,
          this.config!.wechat!.tradeType === '8' ? 'mini_program' : 'official_account',
        )
      }, { readOnly: true })
      return 'jsapi'
    } catch {
      return 'native_qr'
    }
  }

  async query(input: Readonly<QueryOnlinePaymentInput>): Promise<OnlinePaymentQueryResult> {
    if (this.adapter === null || this.secrets === null || this.config === null) {
      throw new OnlinePaymentUnavailableError()
    }
    const context = await this.transactions.run(input.scope, async (transaction) => (
      new PaymentProviderActionRepository(transaction, this.secret)
        .resolvePaymentContext(input.paymentId, input.principal, { lock: false })
    ), { readOnly: true })
    if (context.provider !== 'postar') {
      throw new OnlinePaymentUnavailableError('当前付款不支持星驿主动查单')
    }
    if (!['created', 'pending'].includes(context.status)) {
      throw new OnlinePaymentUnavailableError('这笔付款已有明确结果，无需重复查单')
    }
    const observation = await this.adapter.queryPayment({
      paymentIntentId: context.publicId,
      merchantId: this.config.merchantId,
      amount: context.amountMinor,
      currency: context.currency,
      providerTransactionId: context.providerTransactionId,
      orderDate: postarOrderDate(context.createdAt),
    }, { secrets: this.secrets })
    if (observation.amount !== context.amountMinor || observation.currency !== context.currency) {
      throw new OnlinePaymentUnknownError()
    }
    return { context, observation }
  }

  async create(input: Readonly<CreateOnlinePaymentInput>): Promise<OnlinePaymentAction> {
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString()
    const prepared = await this.transactions.run(input.scope, async (transaction) => {
      const repository = new PaymentProviderActionRepository(transaction, this.secret)
      const context = await repository.resolvePaymentContext(input.paymentId, input.principal)
      if (context.status !== 'pending' && context.status !== 'created') {
        throw new Error('这笔订单已经不处于待付款状态')
      }
      if (context.provider === 'simulation') {
        const presentation = providerPresentation(context.method)
        const claim = await repository.claim(input.paymentId, presentation, expiresAt, input.principal)
        if (!claim.claimed) return { context, payerId: null, cached: claim, simulated: true as const }
        const payload = { presentation: 'simulation' }
        await repository.complete(context.id, presentation, payload, expiresAt, null)
        return { context, payerId: null, cached: null, simulated: true as const }
      }
      if (context.provider !== 'postar') throw new OnlinePaymentUnavailableError()
      if (this.adapter === null || this.secrets === null || this.config === null) {
        throw new OnlinePaymentUnavailableError()
      }
      const presentation = providerPresentation(context.method)
      if (presentation === 'barcode' && !input.customerAuthCode?.trim()) {
        throw new OnlinePaymentUnavailableError('这笔订单正在由员工扫描付款码，请勿从桌码重复发起')
      }
      const claim = await repository.claim(input.paymentId, presentation, expiresAt, input.principal)
      if (!claim.claimed) {
        return { context, payerId: null, cached: claim, simulated: false as const }
      }
      const payerId = presentation === 'jsapi'
        ? await this.resolvePayerId(repository, input)
        : null
      return { context, payerId, cached: null, simulated: false as const }
    })
    const presentation = providerPresentation(prepared.context.method)
    if (prepared.simulated) {
      return {
        paymentId: prepared.context.id,
        paymentPublicId: prepared.context.publicId,
        orderPublicId: prepared.context.orderPublicId,
        status: 'pending',
        presentation,
        expiresAt: prepared.cached?.expiresAt ?? expiresAt,
        payload: prepared.cached?.payload ?? { presentation: 'simulation' },
      }
    }
    if (this.adapter === null || this.secrets === null || this.config === null) throw new OnlinePaymentUnavailableError()
    if (prepared.cached !== null) {
      return {
        paymentId: prepared.context.id,
        paymentPublicId: prepared.context.publicId,
        orderPublicId: prepared.context.orderPublicId,
        status: 'pending',
        presentation,
        expiresAt: prepared.cached.expiresAt,
        payload: prepared.cached.payload,
      }
    }

    try {
      const result = await this.adapter.createPayment({
        paymentIntentId: prepared.context.publicId,
        merchantId: this.config.merchantId,
        amount: prepared.context.amountMinor,
        currency: prepared.context.currency,
        expiresAt,
        presentation,
        payWay: presentation === 'jsapi' ? 'wechat' : undefined,
        payerId: prepared.payerId ?? undefined,
        customerAuthCode: presentation === 'barcode' ? input.customerAuthCode : undefined,
        clientIp: trustedIp(input.clientIp),
        callbackUrl: this.config.callbackUrl,
        operatorId: safeOperator(input.operatorId),
        remark: `MBOX ${prepared.context.tableCode} ${prepared.context.orderPublicId}`.slice(0, 60),
        wxAppid: presentation === 'jsapi' ? this.config.wechat?.appId : undefined,
        wechatTradeType: presentation === 'jsapi' ? this.config.wechat?.tradeType : undefined,
      }, { secrets: this.secrets })
      await this.transactions.run(input.scope, async (transaction) => {
        await new PaymentProviderActionRepository(transaction, this.secret).complete(
          prepared.context.id,
          presentation,
          result.paymentPayload,
          expiresAt,
          result.providerTransactionId,
        )
      })
      return {
        paymentId: prepared.context.id,
        paymentPublicId: prepared.context.publicId,
        orderPublicId: prepared.context.orderPublicId,
        status: 'pending',
        presentation,
        expiresAt,
        payload: result.paymentPayload,
      }
    } catch (error) {
      const code = safeErrorCode(error)
      try {
        await this.transactions.run(input.scope, async (transaction) => {
          const repository = new PaymentProviderActionRepository(transaction, this.secret)
          if (error instanceof PostarPaymentRejectedError) await repository.markFailed(prepared.context.id, code)
          else await repository.markUnknown(prepared.context.id, code)
        })
      } catch {
        throw new OnlinePaymentUnknownError()
      }
      if (error instanceof PostarPaymentRejectedError) throw error
      throw new OnlinePaymentUnknownError()
    }
  }

  private async resolvePayerId(
    repository: PaymentProviderActionRepository,
    input: Readonly<CreateOnlinePaymentInput>,
  ): Promise<string> {
    if (input.principal.type !== 'guest' || this.config?.wechat === null || this.config?.wechat === undefined) {
      throw new OnlinePaymentUnavailableError('当前入口不能发起微信内支付，请改用客人扫码支付')
    }
    return repository.resolveWechatPayerId(
      input.principal.customerId,
      this.config.wechat.appId,
      this.config.wechat.tradeType === '8' ? 'mini_program' : 'official_account',
    )
  }
}

function providerPresentation(method: string): ProviderPresentation {
  if (method === 'jsapi') return 'jsapi'
  if (method === 'native_qr') return 'qr'
  if (method === 'auth_code') return 'barcode'
  throw new OnlinePaymentUnavailableError('当前付款方式不是线上支付')
}

function environmentSecrets(config: Readonly<NormalizedPaymentRuntimeConfig>): PaymentProviderSecretSource {
  return {
    async getSecret(name) {
      if (name === 'postar.agencyId') return config.agencyId
      if (name === 'postar.publicKey') return config.publicKey
      throw new OnlinePaymentUnavailableError('支付安全配置不完整')
    },
  }
}

function fetchHttpClient(timeoutMs: number): PostarHttpClient {
  return {
    async post(request) {
      const response = await fetch(request.url, {
        method: 'POST',
        headers: request.headers,
        body: Buffer.from(request.body),
        signal: AbortSignal.timeout(timeoutMs),
      })
      const body = new Uint8Array(await response.arrayBuffer())
      if (body.byteLength > 1_048_576) throw new Error('星驿HTTP响应超过1MB限制')
      const headers: Record<string, string> = {}
      response.headers.forEach((value, key) => { headers[key] = value })
      return { status: response.status, headers, body }
    },
  }
}

function unsupportedMetadataSource(): PostarTransactionMetadataSource {
  const unavailable = async (): Promise<never> => { throw new Error('规范化支付查询尚未接入此适配器实例') }
  return {
    getPaymentMetadata: unavailable,
    getRefundMetadata: unavailable,
    getRefundQueryMetadata: unavailable,
  }
}

function postarOrderDate(value: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) throw new OnlinePaymentUnknownError()
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date)
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value
  const result = `${part('year') ?? ''}${part('month') ?? ''}${part('day') ?? ''}`
  if (!/^\d{8}$/.test(result)) throw new OnlinePaymentUnknownError()
  return result
}

function unsupportedBillSource(): PostarSftpBillSource {
  return { async downloadBill(): Promise<never> { throw new Error('星驿SFTP账单尚未配置') } }
}

function trustedIp(value: string): string {
  const normalized = value.trim().replace(/^::ffff:/, '')
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(normalized) || /^[0-9a-f:]+$/i.test(normalized)) return normalized
  throw new OnlinePaymentUnavailableError('无法确认支付终端网络地址')
}

function safeOperator(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9]/g, '').slice(0, 32)
  return normalized || 'MBOX'
}

function safeErrorCode(error: unknown): string {
  const name = error instanceof Error ? error.name : 'UnknownError'
  return name.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 128) || 'UnknownError'
}
