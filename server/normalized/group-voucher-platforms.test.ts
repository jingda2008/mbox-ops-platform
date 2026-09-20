import { describe, expect, it, vi } from 'vitest'
import {
  DianpingGroupVoucherAdapter,
  DouyinGroupVoucherAdapter,
  GroupVoucherPlatformError,
  KuaishouGroupVoucherAdapter,
  MeituanGroupVoucherAdapter,
  SimulationGroupVoucherAdapter,
  createGroupVoucherPlatformRegistry,
  readGroupVoucherPrepareHandle,
  signGroupVoucherPrepareHandle,
  type GroupVoucherHttpClient,
  type GroupVoucherHttpResponse,
} from './group-voucher-platforms.js'

const now = () => Date.parse('2026-09-20T04:00:00.000Z')

describe('group voucher platform adapters', () => {
  it('simulates prepare and consume for every supported platform', async () => {
    const registry = createGroupVoucherPlatformRegistry({
      mode: 'test', timeoutMs: 8_000,
      platforms: { dianping: null, meituan: null, douyin: null, kuaishou: null },
    }, { now })
    expect(registry.status().every((item) => item.enabled && item.mode === 'test')).toBe(true)
    const adapter = registry.adapter('meituan')
    const prepared = await adapter.prepare({ voucherCode: 'MT-OK-889900' })
    expect(prepared).toMatchObject({
      platform: 'meituan', campaignName: '美团门店团购券', faceValueMinor: 10_000, quantity: 1,
    })
    const consumed = await adapter.consume({
      voucherCode: 'MT-OK-889900', prepareToken: prepared.prepareToken, requestId: 'idem-ok-0001',
    })
    expect(consumed.verifyId).toContain('idem-ok')
  })

  it('maps simulated failure codes without exposing the raw voucher', async () => {
    const adapter = new SimulationGroupVoucherAdapter('dianping', now)
    await expect(adapter.prepare({ voucherCode: 'USED-123456' })).rejects.toMatchObject({
      code: 'already_used', message: expect.stringContaining('已被核销'),
    })
    await expect(adapter.prepare({ voucherCode: 'EXPIRED1234' })).rejects.toMatchObject({ code: 'expired' })
    await expect(adapter.prepare({ voucherCode: 'REJECT-9999' })).rejects.toMatchObject({ code: 'rejected' })
    await expect(adapter.prepare({ voucherCode: 'MISS-000001' })).rejects.toMatchObject({ code: 'not_found' })
    const prepared = await adapter.prepare({ voucherCode: 'DP-OK-123456' })
    await expect(adapter.consume({
      voucherCode: 'DP-OK-123456', prepareToken: 'stale-token', requestId: 'idem-1',
    })).rejects.toMatchObject({ code: 'expired' })
    expect(prepared.prepareToken).not.toContain('DP-OK-123456')
  })

  it('keeps prepare handles HMAC-signed so platform tokens never go to the client', () => {
    const secret = '0123456789abcdef0123456789abcdef'
    const handle = signGroupVoucherPrepareHandle({
      platform: 'douyin', codeHash: 'a'.repeat(64), prepareToken: 'platform-secret-token',
      campaignName: '抖音团购', faceValueMinor: 9_900, settlementAmountMinor: 8_800,
      currency: 'CNY', certificateId: 'cert-1', expiresAtMs: now() + 60_000,
    }, secret)
    expect(handle).not.toContain('platform-secret-token')
    expect(readGroupVoucherPrepareHandle(handle, secret, now()).prepareToken).toBe('platform-secret-token')
    expect(() => readGroupVoucherPrepareHandle(`${handle}x`, secret, now())).toThrow(GroupVoucherPlatformError)
    expect(() => readGroupVoucherPrepareHandle(handle, secret, now() + 120_000)).toThrow(/过期/)
  })

  it('prepares and consumes a Meituan receipt through the signed catering API', async () => {
    const http = mockHttp(async (url) => {
      if (url.includes('/prepare')) {
        return ok({ code: 0, data: {
          dealTitle: '美团双人套餐', dealPrice: 188, dealPromoPrice: 168, count: 1,
          verifyToken: 'mt-token', receiptCode: 'MT123456',
        } })
      }
      return ok({ code: 0, data: {
        dealTitle: '美团双人套餐', dealPrice: 188, merchantAmount: 168,
        verifyId: 'mt-verify-1', receiptCode: 'MT123456',
      } })
    })
    const adapter = new MeituanGroupVoucherAdapter({
      appKey: 'mt-key', appSecret: 'mt-secret-value', shopId: 'shop-1',
      accessToken: 'mt-access', apiBase: 'https://api-open-cater.meituan.com',
    }, http, 8_000)
    const prepared = await adapter.prepare({ voucherCode: '123456789012' })
    expect(prepared).toMatchObject({
      platform: 'meituan', campaignName: '美团双人套餐', faceValueMinor: 18_800,
      settlementAmountMinor: 16_800, prepareToken: 'mt-token',
    })
    const consumed = await adapter.consume({
      voucherCode: '123456789012', prepareToken: 'mt-token', requestId: 'req-1',
    })
    expect(consumed.verifyId).toBe('mt-verify-1')
  })

  it('maps Dianping already-used and missing receipts', async () => {
    const http = mockHttp(async () => ok({ code: 'already_used', msg: '券已核销' }))
    const adapter = new DianpingGroupVoucherAdapter({
      appKey: 'dp-key', appSecret: 'dp-secret-value', session: 'dp-session',
      shopId: 'dp-shop', apiBase: 'https://openapi.dianping.com',
    }, http, 8_000)
    await expect(adapter.prepare({ voucherCode: 'DP12345678' })).rejects.toMatchObject({
      code: 'already_used', message: expect.stringContaining('大众点评'),
    })

    const missing = new DianpingGroupVoucherAdapter({
      appKey: 'dp-key', appSecret: 'dp-secret-value', session: 'dp-session',
      shopId: 'dp-shop', apiBase: 'https://openapi.dianping.com',
    }, mockHttp(async () => ok({ code: 'not_found', message: '券不存在' })), 8_000)
    await expect(missing.prepare({ voucherCode: 'DP00000000' })).rejects.toMatchObject({ code: 'not_found' })
  })

  it('prepares and verifies Douyin certificates after exchanging a client token', async () => {
    const http = mockHttp(async (url) => {
      if (url.includes('/oauth/client_token')) {
        return ok({ code: 0, data: { access_token: 'dy-token', expires_in: 7200 } })
      }
      if (url.includes('/prepare')) {
        return ok({ data: {
          verify_token: 'dy-prepare',
          certificates: [{ sku: { title: '抖音畅饮', market_price: 9900, settle_amount: 8800 } }],
        } })
      }
      return ok({ data: {
        verify_results: [{ title: '抖音畅饮', origin_amount: 9900, settle_amount: 8800, verify_id: 'dy-v1' }],
      } })
    })
    const adapter = new DouyinGroupVoucherAdapter({
      clientKey: 'dy-key', clientSecret: 'dy-secret-value', poiId: 'poi-1',
      accountId: 'acct-1', apiBase: 'https://open.douyin.com',
    }, http, 8_000, now)
    const prepared = await adapter.prepare({ voucherCode: 'DY-OK-555666' })
    expect(prepared.campaignName).toBe('抖音畅饮')
    expect(prepared.prepareToken).toBe('dy-prepare')
    const consumed = await adapter.consume({
      voucherCode: 'DY-OK-555666', prepareToken: 'dy-prepare', requestId: 'req-dy',
    })
    expect(consumed.verifyId).toBe('dy-v1')
  })

  it('prepares and verifies Kuaishou certificates and rejects expired receipts', async () => {
    const http = mockHttp(async (url) => {
      if (url.includes('/oauth2/access_token')) {
        return ok({ code: 0, data: { access_token: 'ks-token', expires_in: 7200 } })
      }
      if (url.includes('/prepare')) {
        return ok({ data: {
          verify_token: 'ks-prepare',
          certificate: { title: '快手套餐', market_price: 12800, settle_amount: 10800, certificate_id: 'ks-1' },
        } })
      }
      return ok({ data: { title: '快手套餐', market_price: 12800, settle_amount: 10800, verify_id: 'ks-v1' } })
    })
    const adapter = new KuaishouGroupVoucherAdapter({
      appId: 'ks-app', appSecret: 'ks-secret-value', merchantId: 'ks-m',
      poiId: 'ks-poi', apiBase: 'https://open.kuaishou.com',
    }, http, 8_000, now)
    const prepared = await adapter.prepare({ voucherCode: 'KS-OK-777888' })
    expect(prepared).toMatchObject({ platform: 'kuaishou', campaignName: '快手套餐', faceValueMinor: 12_800 })
    expect((await adapter.consume({
      voucherCode: 'KS-OK-777888', prepareToken: 'ks-prepare', requestId: 'req-ks',
    })).verifyId).toBe('ks-v1')

    const expired = new KuaishouGroupVoucherAdapter({
      appId: 'ks-app', appSecret: 'ks-secret-value', merchantId: 'ks-m',
      poiId: 'ks-poi', apiBase: 'https://open.kuaishou.com',
    }, mockHttp(async (url) => {
      if (url.includes('/oauth2/access_token')) {
        return ok({ code: 0, data: { access_token: 'ks-token', expires_in: 7200 } })
      }
      return ok({ code: 'expired', extra: { description: '券已过期' } })
    }), 8_000, now)
    await expect(expired.prepare({ voucherCode: 'KS-EXPIRED' })).rejects.toMatchObject({ code: 'expired' })
  })

  it('keeps unconfigured production platforms unavailable', () => {
    const registry = createGroupVoucherPlatformRegistry({
      mode: 'production', timeoutMs: 8_000,
      platforms: { dianping: null, meituan: null, douyin: null, kuaishou: null },
    })
    expect(registry.status().every((item) => !item.enabled)).toBe(true)
    expect(() => registry.adapter('meituan')).toThrow(/未配置/)
  })
})

function ok(body: unknown): GroupVoucherHttpResponse {
  return { status: 200, body }
}

function mockHttp(
  request: (url: string, options: Parameters<GroupVoucherHttpClient['request']>[1]) => Promise<GroupVoucherHttpResponse>,
): GroupVoucherHttpClient {
  return { request: vi.fn(request) }
}
