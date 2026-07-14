import { describe, expect, it, vi } from 'vitest'
import type {
  ServiceAccountSubscriptionMessageClient,
  WechatAccessTokenClient,
  WechatNotificationRecipientResolver,
  WechatProviderMessageReceipt,
  WechatProviderResult,
  WecomNotificationClient,
} from '../src/shared/wechat-contracts.js'
import type { NotificationDispatchRequest } from './notification-dispatch.js'
import {
  CachedWechatAccessTokenProvider,
  InMemoryWechatDeliveryIdempotencyStore,
  ServiceAccountNotificationAdapter,
  WecomNotificationAdapter,
} from './wechat-notification-adapter.js'

const NOW = Date.parse('2026-07-14T12:00:00.000Z')

function request(
  channel: 'service_account' | 'wecom' = 'service_account',
  overrides: Partial<NotificationDispatchRequest> = {},
): NotificationDispatchRequest {
  return {
    notificationId: 'notification-001',
    idempotencyKey: 'notification-001',
    channel,
    memberId: 'member-amy',
    benefitId: 'benefit-001',
    campaignId: null,
    templateCode: 'BENEFIT_GRANTED',
    content: '您的会员权益已到账',
    ...overrides,
  }
}

function tokenProvider(client?: WechatAccessTokenClient, now: () => number = () => NOW) {
  return new CachedWechatAccessTokenProvider(client ?? {
    refreshAccessToken: async () => ({ ok: true, value: { accessToken: 'access-token-1', expiresInSeconds: 7200 } }),
  }, { now })
}

function recipientResolver(): WechatNotificationRecipientResolver {
  return {
    resolveRecipient: async (channel) => channel === 'service_account'
      ? { ok: true, value: { channel, openId: 'openid-amy' } }
      : { ok: true, value: { channel, userId: 'wecom-user-amy' } },
  }
}

describe('wechat access token cache', () => {
  it('caches credentials, refreshes before expiry, and supports explicit invalidation', async () => {
    let now = NOW
    let sequence = 0
    const refreshAccessToken = vi.fn(async () => ({
      ok: true as const,
      value: { accessToken: `token-${++sequence}`, expiresInSeconds: 120 },
    }))
    const provider = tokenProvider({ refreshAccessToken }, () => now)

    await expect(provider.getAccessToken()).resolves.toEqual({ ok: true, value: { accessToken: 'token-1' } })
    await expect(provider.getAccessToken()).resolves.toEqual({ ok: true, value: { accessToken: 'token-1' } })
    now += 61_000
    await expect(provider.getAccessToken()).resolves.toEqual({ ok: true, value: { accessToken: 'token-2' } })
    provider.invalidate('token-2')
    await expect(provider.getAccessToken()).resolves.toEqual({ ok: true, value: { accessToken: 'token-3' } })
    expect(refreshAccessToken).toHaveBeenCalledTimes(3)
  })

  it('coalesces concurrent refreshes and classifies refresh exceptions as retryable', async () => {
    let release: ((value: WechatProviderResult<{ accessToken: string; expiresInSeconds: number }>) => void) | undefined
    const refreshAccessToken = vi.fn(() => new Promise<WechatProviderResult<{ accessToken: string; expiresInSeconds: number }>>((resolve) => {
      release = resolve
    }))
    const provider = tokenProvider({ refreshAccessToken })
    const first = provider.getAccessToken()
    const second = provider.getAccessToken()
    release?.({ ok: true, value: { accessToken: 'shared-token', expiresInSeconds: 7200 } })

    await expect(Promise.all([first, second])).resolves.toEqual([
      { ok: true, value: { accessToken: 'shared-token' } },
      { ok: true, value: { accessToken: 'shared-token' } },
    ])
    expect(refreshAccessToken).toHaveBeenCalledTimes(1)

    const failing = tokenProvider({ refreshAccessToken: async () => { throw new Error('credential network timeout') } })
    await expect(failing.getAccessToken()).resolves.toMatchObject({
      ok: false,
      failure: { classification: 'transient', code: 'CREDENTIAL_REFRESH_EXCEPTION', retryable: true },
    })
  })
})

describe('service account notification adapter', () => {
  it('requires provider delivery evidence and returns the same receipt for an idempotent repeat', async () => {
    const sendSubscriptionMessage = vi.fn(async () => ({
      ok: true as const,
      value: { providerMessageId: 'wx-msg-001', providerRequestId: 'wx-req-001' },
    }))
    const client = { sendSubscriptionMessage } satisfies ServiceAccountSubscriptionMessageClient
    const adapter = new ServiceAccountNotificationAdapter({
      client,
      tokenProvider: tokenProvider(),
      recipientResolver: recipientResolver(),
      deliveryStore: new InMemoryWechatDeliveryIdempotencyStore(),
      templates: { BENEFIT_GRANTED: { templateId: 'template-benefit', page: '/pages/benefits' } },
      now: () => NOW,
    })

    await expect(adapter.dispatch(request())).resolves.toEqual({ outcome: 'sent', providerMessageId: 'wx-msg-001' })
    await expect(adapter.dispatch(request())).resolves.toEqual({ outcome: 'sent', providerMessageId: 'wx-msg-001' })

    expect(sendSubscriptionMessage).toHaveBeenCalledTimes(1)
    expect(sendSubscriptionMessage).toHaveBeenCalledWith({
      accessToken: 'access-token-1',
      toOpenId: 'openid-amy',
      templateId: 'template-benefit',
      page: '/pages/benefits',
      data: { content: { value: '您的会员权益已到账' } },
      clientRequestId: 'notification-001',
    })
  })

  it('does not claim delivery without a provider message id or retry an unknown outcome', async () => {
    const results: WechatProviderResult<WechatProviderMessageReceipt>[] = [
      { ok: true, value: { providerMessageId: '' } },
    ]
    const sendSubscriptionMessage = vi.fn(async () => results.shift()!)
    const adapter = new ServiceAccountNotificationAdapter({
      client: { sendSubscriptionMessage },
      tokenProvider: tokenProvider(),
      recipientResolver: recipientResolver(),
      deliveryStore: new InMemoryWechatDeliveryIdempotencyStore(),
      templates: { BENEFIT_GRANTED: { templateId: 'template-benefit' } },
      now: () => NOW,
    })

    await expect(adapter.dispatch(request())).resolves.toMatchObject({
      outcome: 'permanent_failure',
      errorCode: 'DELIVERY_OUTCOME_UNKNOWN',
    })
    await expect(adapter.dispatch(request())).resolves.toMatchObject({
      outcome: 'permanent_failure',
      errorCode: 'DELIVERY_OUTCOME_UNKNOWN',
    })
    expect(sendSubscriptionMessage).toHaveBeenCalledTimes(1)
  })

  it('refreshes an invalid credential once before classifying the delivery result', async () => {
    let tokenSequence = 0
    const refreshAccessToken = vi.fn(async () => ({
      ok: true as const,
      value: { accessToken: `token-${++tokenSequence}`, expiresInSeconds: 7200 },
    }))
    const sendSubscriptionMessage = vi.fn(async (message) => message.accessToken === 'token-1'
      ? {
          ok: false as const,
          failure: { classification: 'authentication' as const, code: 'ACCESS_TOKEN_EXPIRED', message: 'access token expired', retryable: true },
        }
      : { ok: true as const, value: { providerMessageId: 'wx-msg-refreshed' } })
    const adapter = new ServiceAccountNotificationAdapter({
      client: { sendSubscriptionMessage },
      tokenProvider: tokenProvider({ refreshAccessToken }),
      recipientResolver: recipientResolver(),
      deliveryStore: new InMemoryWechatDeliveryIdempotencyStore(),
      templates: { BENEFIT_GRANTED: { templateId: 'template-benefit' } },
      now: () => NOW,
    })

    await expect(adapter.dispatch(request())).resolves.toEqual({ outcome: 'sent', providerMessageId: 'wx-msg-refreshed' })
    expect(refreshAccessToken).toHaveBeenCalledTimes(2)
    expect(sendSubscriptionMessage).toHaveBeenCalledTimes(2)
  })

  it('classifies missing binding and template configuration as permanent failures', async () => {
    const sendSubscriptionMessage = vi.fn()
    const unboundResolver: WechatNotificationRecipientResolver = {
      resolveRecipient: async () => ({
        ok: false,
        failure: { classification: 'authorization', code: 'RECIPIENT_NOT_BOUND', message: '会员未绑定服务号', retryable: false },
      }),
    }
    const unboundAdapter = new ServiceAccountNotificationAdapter({
      client: { sendSubscriptionMessage },
      tokenProvider: tokenProvider(),
      recipientResolver: unboundResolver,
      deliveryStore: new InMemoryWechatDeliveryIdempotencyStore(),
      templates: { BENEFIT_GRANTED: { templateId: 'template-benefit' } },
    })
    await expect(unboundAdapter.dispatch(request())).resolves.toMatchObject({
      outcome: 'permanent_failure',
      errorCode: 'RECIPIENT_NOT_BOUND',
    })

    const missingTemplateAdapter = new ServiceAccountNotificationAdapter({
      client: { sendSubscriptionMessage },
      tokenProvider: tokenProvider(),
      recipientResolver: recipientResolver(),
      deliveryStore: new InMemoryWechatDeliveryIdempotencyStore(),
      templates: {},
    })
    await expect(missingTemplateAdapter.dispatch(request())).resolves.toMatchObject({
      outcome: 'permanent_failure',
      errorCode: 'TEMPLATE_NOT_CONFIGURED',
    })
    expect(sendSubscriptionMessage).not.toHaveBeenCalled()
  })

  it('prevents concurrent duplicate delivery while the first request is in flight', async () => {
    let release: ((value: WechatProviderResult<WechatProviderMessageReceipt>) => void) | undefined
    let started: (() => void) | undefined
    const providerStarted = new Promise<void>((resolve) => { started = resolve })
    const sendSubscriptionMessage = vi.fn(() => {
      started?.()
      return new Promise<WechatProviderResult<WechatProviderMessageReceipt>>((resolve) => { release = resolve })
    })
    const adapter = new ServiceAccountNotificationAdapter({
      client: { sendSubscriptionMessage },
      tokenProvider: tokenProvider(),
      recipientResolver: recipientResolver(),
      deliveryStore: new InMemoryWechatDeliveryIdempotencyStore(),
      templates: { BENEFIT_GRANTED: { templateId: 'template-benefit' } },
      now: () => NOW,
    })

    const first = adapter.dispatch(request())
    await providerStarted
    const duplicate = await adapter.dispatch(request())
    release?.({ ok: true, value: { providerMessageId: 'wx-msg-concurrent' } })

    expect(duplicate).toMatchObject({ outcome: 'retryable_failure', errorCode: 'IDEMPOTENCY_IN_PROGRESS' })
    await expect(first).resolves.toEqual({ outcome: 'sent', providerMessageId: 'wx-msg-concurrent' })
    expect(sendSubscriptionMessage).toHaveBeenCalledTimes(1)
  })

  it('holds an ambiguous transport exception for reconciliation instead of resending', async () => {
    const sendSubscriptionMessage = vi.fn(async () => { throw new Error('socket closed after request write') })
    const adapter = new ServiceAccountNotificationAdapter({
      client: { sendSubscriptionMessage },
      tokenProvider: tokenProvider(),
      recipientResolver: recipientResolver(),
      deliveryStore: new InMemoryWechatDeliveryIdempotencyStore(),
      templates: { BENEFIT_GRANTED: { templateId: 'template-benefit' } },
    })

    await expect(adapter.dispatch(request())).resolves.toMatchObject({
      outcome: 'permanent_failure',
      errorCode: 'DELIVERY_OUTCOME_UNKNOWN',
    })
    await expect(adapter.dispatch(request())).resolves.toMatchObject({
      outcome: 'permanent_failure',
      errorCode: 'DELIVERY_OUTCOME_UNKNOWN',
    })
    expect(sendSubscriptionMessage).toHaveBeenCalledTimes(1)
  })

  it('does not resend when provider acceptance evidence cannot be committed locally', async () => {
    const baseStore = new InMemoryWechatDeliveryIdempotencyStore()
    const deliveryStore = {
      claim: baseStore.claim.bind(baseStore),
      fail: baseStore.fail.bind(baseStore),
      complete: vi.fn(async () => { throw new Error('database unavailable') }),
    }
    const sendSubscriptionMessage = vi.fn(async () => ({ ok: true as const, value: { providerMessageId: 'wx-msg-uncommitted' } }))
    const adapter = new ServiceAccountNotificationAdapter({
      client: { sendSubscriptionMessage },
      tokenProvider: tokenProvider(),
      recipientResolver: recipientResolver(),
      deliveryStore,
      templates: { BENEFIT_GRANTED: { templateId: 'template-benefit' } },
      now: () => NOW,
    })

    await expect(adapter.dispatch(request())).resolves.toMatchObject({
      outcome: 'permanent_failure',
      errorCode: 'DELIVERY_OUTCOME_UNKNOWN',
    })
    await expect(adapter.dispatch(request())).resolves.toMatchObject({
      outcome: 'retryable_failure',
      errorCode: 'IDEMPOTENCY_IN_PROGRESS',
    })
    expect(sendSubscriptionMessage).toHaveBeenCalledTimes(1)
  })
})

describe('wecom notification adapter', () => {
  it('sends through the WeCom boundary and keeps rate limits retryable', async () => {
    const results: WechatProviderResult<WechatProviderMessageReceipt>[] = [
      { ok: false, failure: { classification: 'rate_limit', code: 'WECOM_RATE_LIMIT', message: '企业微信限流', retryable: true } },
      { ok: true, value: { providerMessageId: 'wecom-msg-001' } },
    ]
    const sendNotification = vi.fn(async () => results.shift()!)
    const client = { sendNotification } satisfies WecomNotificationClient
    const adapter = new WecomNotificationAdapter({
      client,
      tokenProvider: tokenProvider(),
      recipientResolver: recipientResolver(),
      deliveryStore: new InMemoryWechatDeliveryIdempotencyStore(),
      agentId: 'agent-1001',
      now: () => NOW,
    })

    await expect(adapter.dispatch(request('wecom'))).resolves.toMatchObject({
      outcome: 'retryable_failure',
      errorCode: 'WECOM_RATE_LIMIT',
    })
    await expect(adapter.dispatch(request('wecom'))).resolves.toEqual({ outcome: 'sent', providerMessageId: 'wecom-msg-001' })
    expect(sendNotification).toHaveBeenLastCalledWith({
      accessToken: 'access-token-1',
      toUserId: 'wecom-user-amy',
      agentId: 'agent-1001',
      content: '您的会员权益已到账',
      clientRequestId: 'notification-001',
    })
  })

  it('rejects reuse of one idempotency key with different notification content', async () => {
    const sendNotification = vi.fn(async () => ({ ok: true as const, value: { providerMessageId: 'wecom-msg-001' } }))
    const adapter = new WecomNotificationAdapter({
      client: { sendNotification },
      tokenProvider: tokenProvider(),
      recipientResolver: recipientResolver(),
      deliveryStore: new InMemoryWechatDeliveryIdempotencyStore(),
      agentId: 'agent-1001',
    })

    await expect(adapter.dispatch(request('wecom'))).resolves.toMatchObject({ outcome: 'sent' })
    await expect(adapter.dispatch(request('wecom', { content: '不同内容' }))).resolves.toMatchObject({
      outcome: 'permanent_failure',
      errorCode: 'IDEMPOTENCY_CONFLICT',
    })
    expect(sendNotification).toHaveBeenCalledTimes(1)
  })
})
