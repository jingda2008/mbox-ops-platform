import { describe, expect, it, vi } from 'vitest'
import type { WechatNotificationRecipientResolver } from '../src/shared/wechat-contracts.js'
import type { NotificationDispatchRequest } from './notification-dispatch.js'
import {
  createCustomerNotificationAdapters,
  type NotificationHttpClient,
  type NotificationRuntimeDiagnostic,
} from './notification-runtime.js'

const NOW = Date.parse('2026-07-14T12:00:00.000Z')

function request(channel: 'service_account' | 'wecom'): NotificationDispatchRequest {
  return {
    notificationId: `notification-${channel}`,
    idempotencyKey: `notification-${channel}`,
    channel,
    memberId: 'member-amy',
    benefitId: 'benefit-001',
    campaignId: null,
    templateCode: 'BENEFIT_GRANTED',
    content: '您的会员权益已到账',
  }
}

function recipientResolver(): WechatNotificationRecipientResolver {
  return {
    resolveRecipient: async (channel) => channel === 'service_account'
      ? { ok: true, value: { channel, openId: 'openid-amy' } }
      : { ok: true, value: { channel, userId: 'wecom-user-amy' } },
  }
}

function serviceAccountConfig() {
  return {
    enabled: true,
    appId: 'service-account-app-id',
    appSecret: 'service-account-app-secret-value',
    templates: { BENEFIT_GRANTED: { templateId: 'template-benefit', page: 'https://mbox.example/benefits' } },
  } as const
}

function wecomConfig() {
  return {
    enabled: true,
    corpId: 'wecom-corp-id',
    corpSecret: 'wecom-corp-secret-value',
    agentId: '1001',
  } as const
}

describe('customer notification runtime registration', () => {
  it('returns no adapters and emits observable reasons when channels are disabled', () => {
    const diagnostics: NotificationRuntimeDiagnostic[] = []

    const adapters = createCustomerNotificationAdapters({}, { observe: (event) => diagnostics.push(event) })

    expect(adapters).toEqual([])
    expect(diagnostics).toEqual([
      expect.objectContaining({ channel: 'service_account', code: 'CHANNEL_DISABLED', level: 'info' }),
      expect.objectContaining({ channel: 'wecom', code: 'CHANNEL_DISABLED', level: 'info' }),
    ])
  })

  it('does not register incomplete channels and never exposes configured secrets in diagnostics', () => {
    const diagnostics: NotificationRuntimeDiagnostic[] = []
    const serviceSecret = 'service-account-secret-must-not-leak'
    const wecomSecret = 'wecom-secret-must-not-leak'

    const adapters = createCustomerNotificationAdapters({
      serviceAccount: { enabled: true, appId: 'service-app', appSecret: serviceSecret },
      wecom: { enabled: true, corpId: 'wecom-corp', corpSecret: wecomSecret },
    }, {
      recipientResolver: recipientResolver(),
      observe: (event) => diagnostics.push(event),
    })

    expect(adapters).toEqual([])
    expect(diagnostics).toEqual([
      expect.objectContaining({ channel: 'service_account', code: 'CONFIG_INCOMPLETE', missing: ['templates'] }),
      expect.objectContaining({ channel: 'wecom', code: 'CONFIG_INCOMPLETE', missing: ['agentId'] }),
    ])
    expect(JSON.stringify(diagnostics)).not.toContain(serviceSecret)
    expect(JSON.stringify(diagnostics)).not.toContain(wecomSecret)
  })

  it('returns no adapters when an enabled channel has no recipient resolver', () => {
    const diagnostics: NotificationRuntimeDiagnostic[] = []

    const adapters = createCustomerNotificationAdapters({
      serviceAccount: serviceAccountConfig(),
      wecom: wecomConfig(),
    }, { observe: (event) => diagnostics.push(event) })

    expect(adapters).toEqual([])
    expect(diagnostics).toEqual([
      expect.objectContaining({ channel: 'service_account', code: 'DEPENDENCY_MISSING', missing: ['recipientResolver'] }),
      expect.objectContaining({ channel: 'wecom', code: 'DEPENDENCY_MISSING', missing: ['recipientResolver'] }),
    ])
  })

  it('registers both configured channels and dispatches through an injected HTTP client', async () => {
    const diagnostics: NotificationRuntimeDiagnostic[] = []
    const requestHttp = vi.fn<NotificationHttpClient['request']>(async (input) => {
      const url = new URL(input.url)
      if (url.pathname === '/cgi-bin/token') {
        return { status: 200, body: { access_token: 'service-access-token', expires_in: 7200 } }
      }
      if (url.pathname === '/cgi-bin/gettoken') {
        return { status: 200, body: { errcode: 0, access_token: 'wecom-access-token', expires_in: 7200 } }
      }
      if (url.pathname === '/cgi-bin/message/template/send') {
        expect(url.searchParams.get('access_token')).toBe('service-access-token')
        expect(JSON.parse(input.body ?? '{}')).toMatchObject({
          touser: 'openid-amy',
          template_id: 'template-benefit',
          url: 'https://mbox.example/benefits',
        })
        return { status: 200, body: { errcode: 0, msgid: 11001 } }
      }
      if (url.pathname === '/cgi-bin/message/send') {
        expect(url.searchParams.get('access_token')).toBe('wecom-access-token')
        expect(JSON.parse(input.body ?? '{}')).toMatchObject({
          touser: 'wecom-user-amy',
          msgtype: 'text',
          agentid: 1001,
          text: { content: '您的会员权益已到账' },
        })
        return { status: 200, body: { errcode: 0, msgid: 'wecom-message-001' } }
      }
      throw new Error(`unexpected notification URL path: ${url.pathname}`)
    })
    const httpClient = { request: requestHttp } satisfies NotificationHttpClient

    const adapters = createCustomerNotificationAdapters({
      serviceAccount: serviceAccountConfig(),
      wecom: wecomConfig(),
    }, {
      recipientResolver: recipientResolver(),
      httpClient,
      observe: (event) => diagnostics.push(event),
      now: () => NOW,
    })

    expect(adapters.map((adapter) => adapter.channel)).toEqual(['service_account', 'wecom'])
    await expect(adapters[0]!.dispatch(request('service_account'))).resolves.toEqual({
      outcome: 'sent',
      providerMessageId: '11001',
    })
    await expect(adapters[1]!.dispatch(request('wecom'))).resolves.toEqual({
      outcome: 'sent',
      providerMessageId: 'wecom-message-001',
    })
    expect(requestHttp).toHaveBeenCalledTimes(4)
    expect(diagnostics).toEqual([
      expect.objectContaining({ channel: 'service_account', code: 'ADAPTER_REGISTERED' }),
      expect.objectContaining({ channel: 'wecom', code: 'ADAPTER_REGISTERED' }),
    ])
  })

  it('preserves a retryable provider failure through a registered adapter', async () => {
    const requestHttp = vi.fn<NotificationHttpClient['request']>(async (input) => {
      const path = new URL(input.url).pathname
      return path === '/cgi-bin/token'
        ? { status: 200, body: { access_token: 'service-access-token', expires_in: 7200 } }
        : { status: 503, body: { error: 'temporarily unavailable' } }
    })
    const [adapter] = createCustomerNotificationAdapters({ serviceAccount: serviceAccountConfig() }, {
      recipientResolver: recipientResolver(),
      httpClient: { request: requestHttp },
      now: () => NOW,
    })

    await expect(adapter!.dispatch(request('service_account'))).resolves.toEqual({
      outcome: 'retryable_failure',
      reason: 'SERVICE_ACCOUNT服务暂时不可用',
      errorCode: 'SERVICE_ACCOUNT_HTTP_503',
    })
  })

  it('preserves a permanent provider rejection through a registered adapter', async () => {
    const requestHttp = vi.fn<NotificationHttpClient['request']>(async (input) => {
      const path = new URL(input.url).pathname
      return path === '/cgi-bin/gettoken'
        ? { status: 200, body: { errcode: 0, access_token: 'wecom-access-token', expires_in: 7200 } }
        : { status: 200, body: { errcode: 81013, errmsg: 'user does not exist' } }
    })
    const [adapter] = createCustomerNotificationAdapters({ wecom: wecomConfig() }, {
      recipientResolver: recipientResolver(),
      httpClient: { request: requestHttp },
      now: () => NOW,
    })

    await expect(adapter!.dispatch(request('wecom'))).resolves.toEqual({
      outcome: 'permanent_failure',
      reason: 'WECOM拒绝发送通知',
      errorCode: 'WECOM_81013',
    })
  })
})
