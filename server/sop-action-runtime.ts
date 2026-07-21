import type { RuntimeConfig } from './runtime-config.js'
import type {
  SopActionAdapter,
  SopActionDispatchRequest,
  SopActionDispatchResult,
} from './sop-action-dispatch.js'
import { OfficialWecomHttpClient } from './notification-runtime.js'
import { CachedWechatAccessTokenProvider } from './wechat-notification-adapter.js'

interface WebhookResponse {
  ok?: boolean
  verified?: boolean
  providerReference?: string
  evidenceReference?: string
  reason?: string
  retryable?: boolean
}

class SignedSopWebhookAdapter implements SopActionAdapter {
  constructor(
    readonly type: 'headset_notification' | 'camera_snapshot',
    private readonly url: string,
    private readonly token: string,
    private readonly timeoutMs: number,
  ) {}

  async dispatch(request: SopActionDispatchRequest): Promise<SopActionDispatchResult> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await fetch(this.url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/json',
          'idempotency-key': request.idempotencyKey,
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      })
      let body: WebhookResponse = {}
      try {
        body = await response.json() as WebhookResponse
      } catch {
        body = {}
      }
      if (!response.ok) {
        return response.status >= 500 || response.status === 429
          ? { outcome: 'retryable_failure', reason: body.reason ?? `外部通道HTTP ${response.status}` }
          : { outcome: 'permanent_failure', reason: body.reason ?? `外部通道HTTP ${response.status}` }
      }
      if (!body.ok || !body.providerReference?.trim()) {
        return { outcome: 'permanent_failure', reason: body.reason ?? '外部通道没有返回可审计凭证' }
      }
      if (this.type === 'camera_snapshot' && body.verified !== true) {
        return {
          outcome: 'rejected',
          reason: body.reason ?? '摄像头证据未通过验证',
          providerReference: body.providerReference,
          evidenceReference: body.evidenceReference,
        }
      }
      return {
        outcome: 'completed',
        providerReference: body.providerReference,
        evidenceReference: body.evidenceReference,
      }
    } catch (error) {
      return {
        outcome: 'retryable_failure',
        reason: error instanceof Error ? error.message : '外部通道请求异常',
      }
    } finally {
      clearTimeout(timer)
    }
  }
}

class StaffWecomSopActionAdapter implements SopActionAdapter {
  readonly type = 'wecom_notification' as const
  private readonly tokenProvider: CachedWechatAccessTokenProvider

  constructor(
    private readonly client: OfficialWecomHttpClient,
    private readonly agentId: string,
    private readonly employeeUserIds: Record<string, string>,
  ) {
    this.tokenProvider = new CachedWechatAccessTokenProvider(client)
  }

  async dispatch(request: SopActionDispatchRequest): Promise<SopActionDispatchResult> {
    const missing = request.recipientEmployeeIds.filter((employeeId) => !this.employeeUserIds[employeeId])
    if (missing.length > 0) {
      return { outcome: 'permanent_failure', reason: `以下员工尚未绑定企业微信：${missing.join('、')}` }
    }
    const userIds = [...new Set(request.recipientEmployeeIds.map((employeeId) => this.employeeUserIds[employeeId]!))]
    if (userIds.length === 0) return { outcome: 'permanent_failure', reason: 'SOP没有可通知的企业微信员工' }
    const token = await this.tokenProvider.getAccessToken()
    if (!token.ok) {
      return token.failure.retryable
        ? { outcome: 'retryable_failure', reason: token.failure.message }
        : { outcome: 'permanent_failure', reason: token.failure.message }
    }
    const result = await this.client.sendNotification({
      accessToken: token.value.accessToken,
      toUserId: userIds.join('|'),
      agentId: this.agentId,
      content: request.content,
      clientRequestId: request.idempotencyKey,
    })
    if (!result.ok) {
      return result.failure.retryable
        ? { outcome: 'retryable_failure', reason: result.failure.message }
        : { outcome: 'permanent_failure', reason: result.failure.message }
    }
    return { outcome: 'completed', providerReference: result.value.providerMessageId }
  }
}

export function createSopActionAdapters(config: RuntimeConfig): SopActionAdapter[] {
  const adapters: SopActionAdapter[] = []
  if (config.sopHeadsetWebhookUrl && config.sopHeadsetWebhookToken) {
    adapters.push(new SignedSopWebhookAdapter(
      'headset_notification', config.sopHeadsetWebhookUrl, config.sopHeadsetWebhookToken, config.notificationHttpTimeoutMs,
    ))
  }
  if (config.sopCameraWebhookUrl && config.sopCameraWebhookToken) {
    adapters.push(new SignedSopWebhookAdapter(
      'camera_snapshot', config.sopCameraWebhookUrl, config.sopCameraWebhookToken, config.notificationHttpTimeoutMs,
    ))
  }
  if (
    config.wecomNotificationsEnabled
    && config.wecomCorpId
    && config.wecomCorpSecret
    && config.wecomAgentId
    && config.sopWecomEmployeeUserIds
  ) {
    const client = new OfficialWecomHttpClient({
      corpId: config.wecomCorpId,
      corpSecret: config.wecomCorpSecret,
      timeoutMs: config.notificationHttpTimeoutMs,
    })
    adapters.push(new StaffWecomSopActionAdapter(client, config.wecomAgentId, config.sopWecomEmployeeUserIds))
  }
  return adapters
}
