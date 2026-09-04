import { createCipheriv } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  MiniProgramPhoneAuthorizationRouter,
  OfficialAlipayPhoneAuthorizationProvider,
  encryptAlipayPhoneFixture,
  looksLikeAlipayPhonePayload,
  shouldUseAlipayPhoneProvider,
} from './alipay-phone-authorization.js'

const customerId = '82000000-0000-4000-8000-000000000003'
const aesKey = 'alipay-aes-key16'
const appId = '2021006196615276'

describe('official Alipay phone authorization provider', () => {
  it('decrypts the AES phone payload and never returns the ciphertext', async () => {
    const ciphertext = encryptAlipayPhoneFixture('13800138000', aesKey)
    const provider = new OfficialAlipayPhoneAuthorizationProvider({ appId, aesKey })
    const verified = await provider.verify({ authorizationCode: ciphertext, customerId })
    expect(verified).toMatchObject({ e164Phone: '+8613800138000' })
    expect(verified.providerReference).toMatch(/^alipay-phone:[0-9a-f]{64}$/)
    expect(JSON.stringify(verified)).not.toContain(ciphertext)
  })

  it('accepts the mini-program JSON wrapper around the ciphertext', async () => {
    const ciphertext = encryptAlipayPhoneFixture('13912345678', aesKey)
    const provider = new OfficialAlipayPhoneAuthorizationProvider({ appId, aesKey })
    const verified = await provider.verify({
      authorizationCode: JSON.stringify({ response: ciphertext }),
      customerId,
    })
    expect(verified.e164Phone).toBe('+8613912345678')
  })

  it('accepts the official response+sign wrapper', async () => {
    const ciphertext = encryptAlipayPhoneFixture('13700001111', aesKey)
    const provider = new OfficialAlipayPhoneAuthorizationProvider({ appId, aesKey })
    const verified = await provider.verify({
      authorizationCode: JSON.stringify({ response: ciphertext, sign: 'rsa-sign-not-verified-here' }),
      customerId,
    })
    expect(verified.e164Phone).toBe('+8613700001111')
  })

  it('rejects tampered ciphertext', async () => {
    const provider = new OfficialAlipayPhoneAuthorizationProvider({ appId, aesKey })
    await expect(provider.verify({
      authorizationCode: 'not-valid-cipher',
      customerId,
    })).rejects.toMatchObject({ code: 'ALIPAY_PHONE_AUTHORIZATION_INVALID', statusCode: 400 })
  })

  it('rejects already-decrypted phone JSON instead of treating it as a member phone', async () => {
    const provider = new OfficialAlipayPhoneAuthorizationProvider({ appId, aesKey })
    await expect(provider.verify({
      authorizationCode: JSON.stringify({ code: '10000', msg: 'Success', mobile: '13800138000' }),
      customerId,
    })).rejects.toMatchObject({ code: 'ALIPAY_PHONE_PLAINTEXT_REJECTED', statusCode: 400 })
  })

  it('decrypts a URL-encoded official wrapper', async () => {
    const ciphertext = encryptAlipayPhoneFixture('13600002222', aesKey)
    const provider = new OfficialAlipayPhoneAuthorizationProvider({ appId, aesKey })
    const verified = await provider.verify({
      authorizationCode: encodeURIComponent(JSON.stringify({ response: ciphertext, sign: 'rsa-sign' })),
      customerId,
    })
    expect(verified.e164Phone).toBe('+8613600002222')
  })

  it('accepts +86 and nested double-encoded phone payloads', async () => {
    const key = Buffer.from(aesKey, 'utf8')
    const plaintext = JSON.stringify({
      code: '10000',
      msg: 'Success',
      response: JSON.stringify({ mobile: '+8613900012345' }),
    })
    const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0))
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]).toString('base64')
    const provider = new OfficialAlipayPhoneAuthorizationProvider({ appId, aesKey })
    const verified = await provider.verify({
      authorizationCode: JSON.stringify({ response: ciphertext }),
      customerId,
    })
    expect(verified.e164Phone).toBe('+8613900012345')
  })

  it('maps Alipay platform config errors instead of treating them as bad ciphertext', async () => {
    const key = Buffer.from(aesKey, 'utf8')
    const plaintext = JSON.stringify({
      code: '40001',
      msg: 'Missing Required Arguments',
      subCode: 'isv.missing-encrypt-key',
      subMsg: '缺少加密配置',
    })
    const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0))
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]).toString('base64')
    const provider = new OfficialAlipayPhoneAuthorizationProvider({ appId, aesKey })
    await expect(provider.verify({
      authorizationCode: JSON.stringify({ response: ciphertext }),
      customerId,
    })).rejects.toMatchObject({ code: 'ALIPAY_PHONE_PLATFORM_CONFIG', statusCode: 503 })
  })
})

describe('mini-program phone authorization router', () => {
  it('does not send Alipay payloads to WeChat and fails closed when AES is missing', async () => {
    const wechat = { verify: async () => { throw new Error('wechat must not run') } }
    const router = new MiniProgramPhoneAuthorizationRouter({ wechat })
    await expect(router.verify({
      authorizationCode: encryptAlipayPhoneFixture('13800138000', aesKey),
      customerId,
    })).rejects.toMatchObject({ code: 'ALIPAY_PHONE_NOT_CONFIGURED', statusCode: 503 })
  })

  it('routes short WeChat-style codes to the WeChat provider', async () => {
    const wechat = {
      verify: async () => ({
        e164Phone: '+8613800138000',
        providerReference: 'wechat-phone:abc',
        verifiedAt: '2026-09-03T00:00:00.000Z',
      }),
    }
    const router = new MiniProgramPhoneAuthorizationRouter({ wechat })
    const verified = await router.verify({
      authorizationCode: 'wechat-phone-one-use-code-0001',
      customerId,
    })
    expect(verified.providerReference).toBe('wechat-phone:abc')
  })

  it('honors an explicit alipay provider instead of sending a short code to WeChat', async () => {
    const wechat = { verify: async () => { throw new Error('wechat must not run') } }
    const alipay = {
      verify: async () => ({
        e164Phone: '+8613800138000',
        providerReference: 'alipay-phone:explicit',
        verifiedAt: '2026-09-04T00:00:00.000Z',
      }),
    }
    const router = new MiniProgramPhoneAuthorizationRouter({ wechat, alipay })
    const verified = await router.verify({
      authorizationCode: 'short-alipay-token',
      customerId,
      provider: 'alipay',
    })
    expect(verified.providerReference).toBe('alipay-phone:explicit')
    expect(shouldUseAlipayPhoneProvider('alipay', 'short-alipay-token')).toBe(true)
    expect(shouldUseAlipayPhoneProvider('wechat', encryptAlipayPhoneFixture('13800138000', aesKey))).toBe(false)
  })

  it('classifies long base64 as Alipay payload', () => {
    expect(looksLikeAlipayPhonePayload('wechat-phone-one-use-code-0001')).toBe(false)
    expect(looksLikeAlipayPhonePayload(encryptAlipayPhoneFixture('13800138000', aesKey))).toBe(true)
    expect(looksLikeAlipayPhonePayload(JSON.stringify({
      response: encryptAlipayPhoneFixture('13800138000', aesKey),
      sign: 'not-a-secret',
    }))).toBe(true)
  })
})
