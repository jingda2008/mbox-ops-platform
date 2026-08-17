import { describe, expect, it, vi } from 'vitest'
import {
  OfficialWechatSubscriptionMessageAdapter,
  type WechatSubscriptionHttpClient,
} from './wechat-subscription-message-adapter.js'

describe('OfficialWechatSubscriptionMessageAdapter', () => {
  it('constructs a formal subscription message only from typed fields and caches the token', async () => {
    const requests: Array<{ url: string; method: string; body?: string }> = []
    const http: WechatSubscriptionHttpClient = {
      request: vi.fn(async (url, options) => {
        requests.push({ url, method: options.method, ...(options.body === undefined ? {} : { body: options.body }) })
        return options.method === 'GET'
          ? { status: 200, body: { access_token: 'provider-token', expires_in: 7200 } }
          : { status: 200, body: { errcode: 0, errmsg: 'ok', rid: 'provider-request-001' } }
      }),
    }
    const adapter = new OfficialWechatSubscriptionMessageAdapter({
      appId: 'wxMboxNotification01',
      appSecret: '0123456789abcdef0123456789abcdef',
      httpClient: http,
      now: () => Date.parse('2026-08-16T02:00:00.000Z'),
    })

    await adapter.preflight()
    const result = await adapter.send({
      jobId: '83000000-0000-4000-8000-000000000001',
      recipientOpenId: 'openid-customer-self',
      notificationType: 'loyalty_points_credited',
      templateId: 'wechat-template-points-credited',
      pagePath: 'pages/profile/index',
      pointsDataKey: 'thing1',
      balanceDataKey: 'number2',
      occurredAtDataKey: 'time3',
      expiresAtDataKey: null,
      pointsChange: 18,
      pointsAtRisk: 0,
      balanceAfter: 218,
      eventOccurredAt: '2026-08-16T02:01:00.000Z',
      expiresAt: null,
    })

    expect(result).toEqual({ outcome: 'accepted', providerReference: 'provider-request-001' })
    expect(requests.filter((request) => request.method === 'GET')).toHaveLength(1)
    const sent = JSON.parse(requests.find((request) => request.method === 'POST')!.body!)
    expect(sent).toEqual({
      touser: 'openid-customer-self',
      template_id: 'wechat-template-points-credited',
      page: 'pages/profile/index',
      miniprogram_state: 'formal',
      lang: 'zh_CN',
      data: {
        thing1: { value: '+18积分' },
        number2: { value: '218' },
        time3: { value: '2026-08-16 02:01' },
      },
    })
  })

  it('classifies explicit provider refusal separately from an unknown network outcome', async () => {
    const rejected = new OfficialWechatSubscriptionMessageAdapter({
      appId: 'wxMboxNotification01', appSecret: '0123456789abcdef0123456789abcdef',
      httpClient: client([
        { status: 200, body: { access_token: 'token', expires_in: 7200 } },
        { status: 200, body: { errcode: 43101, errmsg: 'user refuse', rid: 'rid-refuse' } },
      ]),
    })
    const request = expiryRequest()
    await expect(rejected.send(request)).resolves.toEqual({
      outcome: 'provider_rejected', providerReference: 'rid-refuse', errorCode: 'wechat_43101',
    })

    const unknown = new OfficialWechatSubscriptionMessageAdapter({
      appId: 'wxMboxNotification01', appSecret: '0123456789abcdef0123456789abcdef',
      httpClient: {
        request: vi.fn()
          .mockResolvedValueOnce({ status: 200, body: { access_token: 'token', expires_in: 7200 } })
          .mockRejectedValueOnce(new Error('connection reset')),
      },
    })
    await expect(unknown.send(request)).resolves.toEqual({
      outcome: 'unknown', providerReference: null, errorCode: 'provider_outcome_unknown',
    })
  })

  it('sends reservation-context template data without routing through loyalty fields', async () => {
    const requests: Array<{ method: string; body?: string }> = []
    const adapter = new OfficialWechatSubscriptionMessageAdapter({
      appId: 'wxMboxNotification01', appSecret: '0123456789abcdef0123456789abcdef',
      httpClient: {
        request: vi.fn(async (_url, options) => {
          requests.push({ method: options.method, ...(options.body === undefined ? {} : { body: options.body }) })
          return options.method === 'GET'
            ? { status: 200, body: { access_token: 'token', expires_in: 7200 } }
            : { status: 200, body: { errcode: 0, rid: 'reservation-rid' } }
        }),
      },
    })

    await expect(adapter.sendTemplate({
      jobId: '83000000-0000-4000-8000-000000000003',
      recipientOpenId: 'openid-reservation-self',
      templateId: 'wechat-template-reservation-revised',
      pagePath: 'pages/reservations/index',
      data: {
        thing1: '演出改期',
        time2: '2026-08-20 20:30',
        time3: '2026-08-20 19:30',
      },
    })).resolves.toEqual({ outcome: 'accepted', providerReference: 'reservation-rid' })

    expect(JSON.parse(requests.find((request) => request.method === 'POST')!.body!)).toEqual({
      touser: 'openid-reservation-self',
      template_id: 'wechat-template-reservation-revised',
      page: 'pages/reservations/index',
      miniprogram_state: 'formal',
      lang: 'zh_CN',
      data: {
        thing1: { value: '演出改期' },
        time2: { value: '2026-08-20 20:30' },
        time3: { value: '2026-08-20 19:30' },
      },
    })
  })

  it('fails closed before networking when formal credentials are missing', () => {
    expect(() => new OfficialWechatSubscriptionMessageAdapter({
      appId: 'wxMboxNotification01', appSecret: '', httpClient: client([]),
    })).toThrow(/appSecret/)
  })
})

function expiryRequest() {
  return {
    jobId: '83000000-0000-4000-8000-000000000002',
    recipientOpenId: 'openid-customer-self',
    notificationType: 'loyalty_points_expiring' as const,
    templateId: 'wechat-template-points-expiring',
    pagePath: 'pages/profile/index',
    pointsDataKey: 'thing1',
    balanceDataKey: null,
    occurredAtDataKey: 'time2',
    expiresAtDataKey: 'date3',
    pointsChange: 0,
    pointsAtRisk: 88,
    balanceAfter: null,
    eventOccurredAt: '2026-08-16T02:01:00.000Z',
    expiresAt: '2026-08-20T15:59:59.000Z',
  }
}

function client(responses: Array<{ status: number; body: unknown }>): WechatSubscriptionHttpClient {
  return { request: vi.fn(async () => responses.shift()!) }
}
