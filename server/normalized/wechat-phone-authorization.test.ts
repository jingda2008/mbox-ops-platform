import { describe, expect, it, vi } from 'vitest'
import { OfficialWechatPhoneAuthorizationProvider } from './wechat-phone-authorization.js'

const now = new Date('2026-08-16T12:00:00.000Z')
const customerId = '82000000-0000-4000-8000-000000000003'

describe('official WeChat phone authorization provider', () => {
  it('exchanges the one-use code, validates watermark AppID and does not return the code', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(response({ access_token: 'provider-access-token', expires_in: 7200 }))
      .mockResolvedValueOnce(response({
        errcode: 0,
        phone_info: {
          purePhoneNumber: '13800138000', countryCode: '86',
          watermark: { appid: 'wxMboxRecovery01', timestamp: Math.floor(now.getTime() / 1_000) },
        },
      }))
    const provider = new OfficialWechatPhoneAuthorizationProvider({
      appId: 'wxMboxRecovery01', appSecret: 'test-secret-not-production', fetch: request,
      now: () => now,
    })
    const verified = await provider.verify({
      authorizationCode: 'wechat-phone-one-use-code-0001', customerId,
    })
    expect(verified).toMatchObject({
      e164Phone: '+8613800138000', verifiedAt: now.toISOString(),
    })
    expect(verified.providerReference).toMatch(/^wechat-phone:[0-9a-f]{64}$/)
    expect(JSON.stringify(verified)).not.toContain('wechat-phone-one-use-code-0001')
    expect(request.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({ code: 'wechat-phone-one-use-code-0001' }))
  })

  it('caches access tokens but rejects AppID mismatch and replayed/invalid authorization codes', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(response({ access_token: 'provider-access-token', expires_in: 7200 }))
      .mockResolvedValueOnce(response({
        errcode: 0,
        phone_info: {
          purePhoneNumber: '13800138000', countryCode: '86',
          watermark: { appid: 'wxDifferentApp', timestamp: Math.floor(now.getTime() / 1_000) },
        },
      }))
      .mockResolvedValueOnce(response({ errcode: 40163, errmsg: 'code been used' }))
    const provider = new OfficialWechatPhoneAuthorizationProvider({
      appId: 'wxMboxRecovery01', appSecret: 'test-secret-not-production', fetch: request,
      now: () => now,
    })
    await expect(provider.verify({
      authorizationCode: 'wechat-phone-one-use-code-0002', customerId,
    })).rejects.toMatchObject({ code: 'WECHAT_PHONE_AUTHORIZATION_INVALID', statusCode: 400 })
    await expect(provider.verify({
      authorizationCode: 'wechat-phone-one-use-code-0003', customerId,
    })).rejects.toMatchObject({ code: 'WECHAT_PHONE_AUTHORIZATION_INVALID', statusCode: 400 })
    expect(request).toHaveBeenCalledTimes(3)
  })

  it('does not send Alipay ciphertext to WeChat', async () => {
    const request = vi.fn()
    const provider = new OfficialWechatPhoneAuthorizationProvider({
      appId: 'wxMboxRecovery01', appSecret: 'test-secret-not-production', fetch: request,
      now: () => now,
    })
    await expect(provider.verify({
      authorizationCode: JSON.stringify({ response: 'alipay-encrypted-phone-payload' }),
      customerId,
    })).rejects.toMatchObject({ code: 'ALIPAY_PHONE_AUTHORIZATION_INVALID', statusCode: 400 })
    await expect(provider.verify({
      authorizationCode: 'short-code', customerId, provider: 'alipay',
    })).rejects.toMatchObject({ code: 'ALIPAY_PHONE_AUTHORIZATION_INVALID', statusCode: 400 })
    expect(request).not.toHaveBeenCalled()
  })

  it('fails closed on provider timeout or malformed phone data', async () => {
    const unavailable = new OfficialWechatPhoneAuthorizationProvider({
      appId: 'wxMboxRecovery01', appSecret: 'test-secret-not-production',
      fetch: vi.fn(async () => { throw new Error('network') }), now: () => now,
    })
    await expect(unavailable.verify({
      authorizationCode: 'wechat-phone-one-use-code-0004', customerId,
    })).rejects.toMatchObject({ code: 'WECHAT_PHONE_PROVIDER_UNAVAILABLE', statusCode: 503 })

    const malformedRequest = vi.fn()
      .mockResolvedValueOnce(response({ access_token: 'provider-access-token', expires_in: 7200 }))
      .mockResolvedValueOnce(response({
        errcode: 0,
        phone_info: {
          purePhoneNumber: 'not-a-phone', countryCode: '86',
          watermark: { appid: 'wxMboxRecovery01', timestamp: Math.floor(now.getTime() / 1_000) },
        },
      }))
    const malformed = new OfficialWechatPhoneAuthorizationProvider({
      appId: 'wxMboxRecovery01', appSecret: 'test-secret-not-production',
      fetch: malformedRequest, now: () => now,
    })
    await expect(malformed.verify({
      authorizationCode: 'wechat-phone-one-use-code-0005', customerId,
    })).rejects.toMatchObject({ code: 'WECHAT_PHONE_AUTHORIZATION_INVALID', statusCode: 400 })
  })
})

function response(body: unknown) {
  return { ok: true, status: 200, json: async () => body }
}
