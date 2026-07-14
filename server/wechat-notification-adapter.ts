import { createHash, randomUUID } from 'node:crypto'
import type {
  ServiceAccountSubscriptionMessageClient,
  WechatAccessTokenClient,
  WechatChannel,
  WechatFailure,
  WechatNotificationRecipient,
  WechatNotificationRecipientResolver,
  WechatProviderMessageReceipt,
  WechatProviderResult,
  WecomNotificationClient,
} from '../src/shared/wechat-contracts.js'
import type {
  NotificationDispatchRequest,
  NotificationDispatchResult,
  NotificationProviderAdapter,
} from './notification-dispatch.js'

interface CachedToken {
  accessToken: string
  expiresAt: number
}

export interface WechatAccessTokenProvider {
  getAccessToken(): Promise<WechatProviderResult<{ accessToken: string }>>
  invalidate(accessToken?: string): void
}

export interface CachedWechatAccessTokenOptions {
  refreshSkewMs?: number
  now?: () => number
}

export class CachedWechatAccessTokenProvider implements WechatAccessTokenProvider {
  private readonly now: () => number
  private readonly refreshSkewMs: number
  private cached: CachedToken | null = null
  private refreshInFlight: Promise<WechatProviderResult<{ accessToken: string }>> | null = null

  constructor(
    private readonly client: WechatAccessTokenClient,
    options: CachedWechatAccessTokenOptions = {},
  ) {
    this.now = options.now ?? Date.now
    this.refreshSkewMs = options.refreshSkewMs ?? 60_000
    if (!Number.isSafeInteger(this.refreshSkewMs) || this.refreshSkewMs < 0) {
      throw new Error('微信凭证刷新提前量必须是非负整数')
    }
  }

  async getAccessToken(): Promise<WechatProviderResult<{ accessToken: string }>> {
    const now = this.now()
    if (this.cached && this.cached.expiresAt - this.refreshSkewMs > now) {
      return { ok: true, value: { accessToken: this.cached.accessToken } }
    }
    if (this.refreshInFlight) return this.refreshInFlight
    this.refreshInFlight = this.refresh(now)
    try {
      return await this.refreshInFlight
    } finally {
      this.refreshInFlight = null
    }
  }

  invalidate(accessToken?: string) {
    if (!accessToken || this.cached?.accessToken === accessToken) this.cached = null
  }

  private async refresh(startedAt: number): Promise<WechatProviderResult<{ accessToken: string }>> {
    let result
    try {
      result = await this.client.refreshAccessToken()
    } catch (error) {
      return {
        ok: false,
        failure: {
          classification: 'transient',
          code: 'CREDENTIAL_REFRESH_EXCEPTION',
          message: error instanceof Error ? error.message : '微信凭证刷新发生未知异常',
          retryable: true,
        },
      }
    }
    if (!result.ok) return result
    const token = result.value
    if (!token.accessToken.trim() || !Number.isSafeInteger(token.expiresInSeconds) || token.expiresInSeconds < 1) {
      return {
        ok: false,
        failure: {
          classification: 'provider_rejection',
          code: 'INVALID_ACCESS_TOKEN_RESPONSE',
          message: '微信供应商未返回有效凭证和有效期',
          retryable: false,
        },
      }
    }
    this.cached = { accessToken: token.accessToken, expiresAt: startedAt + token.expiresInSeconds * 1000 }
    return { ok: true, value: { accessToken: token.accessToken } }
  }
}

export interface WechatDeliveryClaimInput {
  channel: WechatChannel
  idempotencyKey: string
  fingerprint: string
  claimedAt: string
  leaseUntil: string
}

export type WechatDeliveryClaimResult =
  | { outcome: 'claimed'; claimId: string }
  | { outcome: 'sent'; providerMessageId: string }
  | { outcome: 'failed'; failure: WechatFailure }
  | { outcome: 'in_progress' }
  | { outcome: 'outcome_unknown' }
  | { outcome: 'conflict' }

export interface WechatDeliveryIdempotencyStore {
  claim(input: WechatDeliveryClaimInput): Promise<WechatDeliveryClaimResult>
  complete(claimId: string, providerMessageId: string, completedAt: string): Promise<void>
  fail(claimId: string, failure: WechatFailure, failedAt: string): Promise<void>
}

type DeliveryRecord =
  | {
      status: 'pending'
      channel: WechatChannel
      idempotencyKey: string
      fingerprint: string
      claimId: string
      leaseUntil: string
    }
  | {
      status: 'sent'
      channel: WechatChannel
      idempotencyKey: string
      fingerprint: string
      providerMessageId: string
      completedAt: string
    }
  | {
      status: 'failed'
      channel: WechatChannel
      idempotencyKey: string
      fingerprint: string
      failure: WechatFailure
      failedAt: string
    }

export class InMemoryWechatDeliveryIdempotencyStore implements WechatDeliveryIdempotencyStore {
  private readonly records = new Map<string, DeliveryRecord>()

  async claim(input: WechatDeliveryClaimInput): Promise<WechatDeliveryClaimResult> {
    const key = `${input.channel}:${input.idempotencyKey}`
    const existing = this.records.get(key)
    if (existing) {
      if (existing.fingerprint !== input.fingerprint) return { outcome: 'conflict' }
      if (existing.status === 'sent') return { outcome: 'sent', providerMessageId: existing.providerMessageId }
      if (existing.status === 'failed') return { outcome: 'failed', failure: existing.failure }
      if (existing.leaseUntil <= input.claimedAt) return { outcome: 'outcome_unknown' }
      return { outcome: 'in_progress' }
    }
    const claimId = `wechat_delivery_claim_${randomUUID()}`
    this.records.set(key, { status: 'pending', ...input, claimId })
    return { outcome: 'claimed', claimId }
  }

  async complete(claimId: string, providerMessageId: string, completedAt: string) {
    if (!providerMessageId.trim()) throw new Error('微信投递完成必须包含服务商消息ID')
    const entry = [...this.records.entries()].find(([, record]) => record.status === 'pending' && record.claimId === claimId)
    if (!entry) throw new Error('微信投递claim不存在或已终结')
    const [key, record] = entry
    this.records.set(key, {
      status: 'sent',
      channel: record.channel,
      idempotencyKey: record.idempotencyKey,
      fingerprint: record.fingerprint,
      providerMessageId,
      completedAt,
    })
  }

  async fail(claimId: string, failure: WechatFailure, failedAt: string) {
    const entry = [...this.records.entries()].find(([, record]) => record.status === 'pending' && record.claimId === claimId)
    if (!entry) throw new Error('微信投递claim不存在或已终结')
    const [key, record] = entry
    if (failure.retryable) {
      this.records.delete(key)
      return
    }
    this.records.set(key, {
      status: 'failed',
      channel: record.channel,
      idempotencyKey: record.idempotencyKey,
      fingerprint: record.fingerprint,
      failure,
      failedAt,
    })
  }
}

export interface CommonWechatNotificationAdapterOptions {
  tokenProvider: WechatAccessTokenProvider
  recipientResolver: WechatNotificationRecipientResolver
  deliveryStore: WechatDeliveryIdempotencyStore
  leaseMs?: number
  now?: () => number
}

export interface ServiceAccountNotificationAdapterOptions extends CommonWechatNotificationAdapterOptions {
  client: ServiceAccountSubscriptionMessageClient
  templates: Readonly<Record<string, { templateId: string; page?: string }>>
}

export interface WecomNotificationAdapterOptions extends CommonWechatNotificationAdapterOptions {
  client: WecomNotificationClient
  agentId: string
}

function fingerprint(request: NotificationDispatchRequest) {
  return createHash('sha256').update(JSON.stringify({
    notificationId: request.notificationId,
    channel: request.channel,
    memberId: request.memberId,
    benefitId: request.benefitId,
    campaignId: request.campaignId,
    templateCode: request.templateCode,
    content: request.content,
  })).digest('base64url')
}

function resultFromFailure(providerFailure: WechatFailure): NotificationDispatchResult {
  return providerFailure.retryable
    ? { outcome: 'retryable_failure', reason: providerFailure.message, errorCode: providerFailure.code }
    : { outcome: 'permanent_failure', reason: providerFailure.message, errorCode: providerFailure.code }
}

function localFailure(code: string, message: string, retryable: boolean): WechatFailure {
  return {
    classification: retryable ? 'transient' : 'configuration',
    code,
    message,
    retryable,
  }
}

abstract class BaseWechatNotificationAdapter implements NotificationProviderAdapter {
  abstract readonly channel: WechatChannel
  protected readonly now: () => number
  private readonly leaseMs: number

  constructor(protected readonly common: CommonWechatNotificationAdapterOptions) {
    this.now = common.now ?? Date.now
    this.leaseMs = common.leaseMs ?? 30_000
    if (!Number.isSafeInteger(this.leaseMs) || this.leaseMs < 1) throw new Error('微信投递租约必须是正整数')
  }

  async dispatch(request: NotificationDispatchRequest): Promise<NotificationDispatchResult> {
    if (request.channel !== this.channel) {
      return { outcome: 'permanent_failure', reason: '通知渠道与微信适配器不匹配', errorCode: 'CHANNEL_MISMATCH' }
    }
    const now = this.now()
    const claim = await this.common.deliveryStore.claim({
      channel: this.channel,
      idempotencyKey: request.idempotencyKey,
      fingerprint: fingerprint(request),
      claimedAt: new Date(now).toISOString(),
      leaseUntil: new Date(now + this.leaseMs).toISOString(),
    })
    if (claim.outcome === 'sent') return { outcome: 'sent', providerMessageId: claim.providerMessageId }
    if (claim.outcome === 'failed') return resultFromFailure(claim.failure)
    if (claim.outcome === 'conflict') {
      return { outcome: 'permanent_failure', reason: '同一微信投递幂等键对应不同业务参数', errorCode: 'IDEMPOTENCY_CONFLICT' }
    }
    if (claim.outcome === 'in_progress') {
      return { outcome: 'retryable_failure', reason: '同一微信通知正在投递', errorCode: 'IDEMPOTENCY_IN_PROGRESS' }
    }
    if (claim.outcome === 'outcome_unknown') {
      return { outcome: 'permanent_failure', reason: '上次微信投递结果未知，必须查证后人工重放', errorCode: 'DELIVERY_OUTCOME_UNKNOWN' }
    }

    try {
      const recipient = await this.common.recipientResolver.resolveRecipient(this.channel, request.memberId, request.templateCode)
      if (!recipient.ok) return await this.finishFailure(claim.claimId, recipient.failure)
      if (recipient.value.channel !== this.channel) {
        return await this.finishFailure(claim.claimId, localFailure('RECIPIENT_CHANNEL_MISMATCH', '会员通知身份与通道不匹配', false))
      }
      const sent = await this.sendWithCredential(request, recipient.value)
      if (!sent.ok) return await this.finishFailure(claim.claimId, sent.failure)
      if (!sent.value.providerMessageId.trim()) {
        return await this.finishFailure(claim.claimId, {
          classification: 'transient',
          code: 'DELIVERY_OUTCOME_UNKNOWN',
          message: '微信供应商未返回消息ID，必须查证后人工重放',
          retryable: false,
        })
      }
      try {
        await this.common.deliveryStore.complete(claim.claimId, sent.value.providerMessageId, new Date(this.now()).toISOString())
      } catch {
        return {
          outcome: 'permanent_failure',
          reason: '微信供应商已受理，但本地投递证据保存失败，必须查证后人工重放',
          errorCode: 'DELIVERY_OUTCOME_UNKNOWN',
        }
      }
      return { outcome: 'sent', providerMessageId: sent.value.providerMessageId }
    } catch (error) {
      return this.finishFailure(claim.claimId, {
        classification: 'transient',
        code: 'WECHAT_ADAPTER_EXCEPTION',
        message: error instanceof Error ? error.message : '微信通知适配器发生未知异常',
        retryable: true,
      })
    }
  }

  protected abstract send(
    request: NotificationDispatchRequest,
    recipient: WechatNotificationRecipient,
    accessToken: string,
  ): Promise<WechatProviderResult<WechatProviderMessageReceipt>>

  private async sendWithCredential(
    request: NotificationDispatchRequest,
    recipient: WechatNotificationRecipient,
  ): Promise<WechatProviderResult<WechatProviderMessageReceipt>> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = await this.common.tokenProvider.getAccessToken()
      if (!token.ok) return token
      let sent: WechatProviderResult<WechatProviderMessageReceipt>
      try {
        sent = await this.send(request, recipient, token.value.accessToken)
      } catch {
        return {
          ok: false,
          failure: {
            classification: 'transient',
            code: 'DELIVERY_OUTCOME_UNKNOWN',
            message: '微信发送请求结果未知，必须查证后人工重放',
            retryable: false,
          },
        }
      }
      if (sent.ok || sent.failure.classification !== 'authentication' || attempt === 1) return sent
      this.common.tokenProvider.invalidate(token.value.accessToken)
    }
    return { ok: false, failure: localFailure('TOKEN_REFRESH_FAILED', '微信凭证刷新后仍无法投递', true) }
  }

  private async finishFailure(claimId: string, providerFailure: WechatFailure) {
    try {
      await this.common.deliveryStore.fail(claimId, providerFailure, new Date(this.now()).toISOString())
    } catch {
      return {
        outcome: 'permanent_failure' as const,
        reason: '微信投递状态保存失败，必须查证后人工重放',
        errorCode: 'DELIVERY_STATE_WRITE_FAILED',
      }
    }
    return resultFromFailure(providerFailure)
  }
}

export class ServiceAccountNotificationAdapter extends BaseWechatNotificationAdapter {
  readonly channel = 'service_account' as const

  constructor(private readonly options: ServiceAccountNotificationAdapterOptions) {
    super(options)
  }

  protected async send(
    request: NotificationDispatchRequest,
    recipient: WechatNotificationRecipient,
    accessToken: string,
  ): Promise<WechatProviderResult<WechatProviderMessageReceipt>> {
    if (recipient.channel !== 'service_account') {
      return { ok: false, failure: localFailure('RECIPIENT_CHANNEL_MISMATCH', '服务号通知缺少OpenID', false) }
    }
    const template = this.options.templates[request.templateCode]
    if (!template?.templateId.trim()) {
      return { ok: false, failure: localFailure('TEMPLATE_NOT_CONFIGURED', '服务号订阅消息模板未配置', false) }
    }
    return this.options.client.sendSubscriptionMessage({
      accessToken,
      toOpenId: recipient.openId,
      templateId: template.templateId,
      ...(template.page ? { page: template.page } : {}),
      data: { content: { value: request.content } },
      clientRequestId: request.idempotencyKey,
    })
  }
}

export class WecomNotificationAdapter extends BaseWechatNotificationAdapter {
  readonly channel = 'wecom' as const

  constructor(private readonly options: WecomNotificationAdapterOptions) {
    super(options)
    if (!options.agentId.trim()) throw new Error('企业微信通知必须配置agentId')
  }

  protected async send(
    request: NotificationDispatchRequest,
    recipient: WechatNotificationRecipient,
    accessToken: string,
  ): Promise<WechatProviderResult<WechatProviderMessageReceipt>> {
    if (recipient.channel !== 'wecom') {
      return { ok: false, failure: localFailure('RECIPIENT_CHANNEL_MISMATCH', '企业微信通知缺少用户ID', false) }
    }
    return this.options.client.sendNotification({
      accessToken,
      toUserId: recipient.userId,
      agentId: this.options.agentId,
      content: request.content,
      clientRequestId: request.idempotencyKey,
    })
  }
}
