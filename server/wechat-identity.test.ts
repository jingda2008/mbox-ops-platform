import { describe, expect, it, vi } from 'vitest'
import type {
  MiniProgramCodeSession,
  MiniProgramCodeSessionProvider,
  WechatFailure,
  WechatProviderResult,
} from '../src/shared/wechat-contracts.js'
import {
  createWechatLoginChallenge,
  InMemoryWechatIdentityStore,
  verifyWechatLoginChallenge,
  WechatIdentityService,
} from './wechat-identity.js'

const SECRET = 'mbox-wechat-state-secret-with-32-characters'
const NOW = Date.parse('2026-07-14T12:00:00.000Z')
const SCOPE = { tenantId: 'tenant-mbox', storeId: 'mbox-lujiazui', appId: 'wx-mini-app' }

function providerWith(results: WechatProviderResult<MiniProgramCodeSession>[]) {
  const exchangeCode = vi.fn(async () => {
    const result = results.shift()
    if (!result) throw new Error('provider result exhausted')
    return result
  })
  return { exchangeCode } satisfies MiniProgramCodeSessionProvider
}

function success(openId: string, unionId: string | null): WechatProviderResult<MiniProgramCodeSession> {
  return { ok: true, value: { openId, unionId, sessionKey: `session-for-${openId}`, providerRequestId: `req-${openId}` } }
}

function loginInput(appId = SCOPE.appId, now = NOW) {
  const challenge = createWechatLoginChallenge({ ...SCOPE, appId }, SECRET, { now })
  return { ...SCOPE, appId, code: `code-${appId}`, state: challenge.state, nonce: challenge.nonce }
}

describe('wechat login challenge', () => {
  it('binds state to nonce and rejects tampering or expiry with explicit classes', () => {
    const challenge = createWechatLoginChallenge(SCOPE, SECRET, { now: NOW, ttlMs: 1_000 })

    expect(verifyWechatLoginChallenge(challenge.state, challenge.nonce, SECRET, NOW)).toMatchObject({
      ok: true,
      value: SCOPE,
    })
    expect(verifyWechatLoginChallenge(challenge.state, `${challenge.nonce}x`, SECRET, NOW)).toMatchObject({
      ok: false,
      failure: { classification: 'authentication', code: 'NONCE_MISMATCH', retryable: false },
    })
    expect(verifyWechatLoginChallenge(`${challenge.state}x`, challenge.nonce, SECRET, NOW)).toMatchObject({
      ok: false,
      failure: { classification: 'authentication', code: 'STATE_SIGNATURE_INVALID' },
    })
    expect(verifyWechatLoginChallenge(challenge.state, challenge.nonce, SECRET, NOW + 1_000)).toMatchObject({
      ok: false,
      failure: { classification: 'expired', code: 'STATE_EXPIRED' },
    })
  })

  it('requires a production-grade state secret', () => {
    expect(() => createWechatLoginChallenge(SCOPE, 'short', { now: NOW })).toThrow('微信登录state密钥至少需要32个字符')
  })
})

describe('mini program identity service', () => {
  it('exchanges a code once, stores no session key in identity, and rejects challenge replay', async () => {
    const provider = providerWith([success('openid-amy', 'unionid-amy')])
    const store = new InMemoryWechatIdentityStore()
    const service = new WechatIdentityService({ provider, repository: store, challengeStore: store, stateSecret: SECRET, now: () => NOW })
    const input = loginInput()

    const authenticated = await service.authenticateMiniProgram(input)
    const replayed = await service.authenticateMiniProgram(input)

    expect(authenticated).toMatchObject({
      outcome: 'authenticated',
      principal: { tenantId: SCOPE.tenantId, storeId: SCOPE.storeId, appId: SCOPE.appId, memberId: null, hasUnionId: true },
      sessionKey: 'session-for-openid-amy',
      sessionExpiresAt: '2026-07-14T14:00:00.000Z',
      providerRequestId: 'req-openid-amy',
    })
    expect(replayed).toMatchObject({
      outcome: 'failed',
      failure: { classification: 'replay', code: 'LOGIN_CHALLENGE_REPLAYED', retryable: false },
    })
    expect(provider.exchangeCode).toHaveBeenCalledTimes(1)
    const records = await store.findByUnionId(SCOPE.tenantId, 'unionid-amy')
    expect(records).toHaveLength(1)
    expect(records[0]).not.toHaveProperty('sessionKey')
  })

  it('uses UnionID to associate OpenIDs from different apps with one member principal', async () => {
    const provider = providerWith([
      success('openid-mini', 'unionid-shared'),
      success('openid-service-account', 'unionid-shared'),
    ])
    const store = new InMemoryWechatIdentityStore()
    const service = new WechatIdentityService({ provider, repository: store, challengeStore: store, stateSecret: SECRET, now: () => NOW })

    const first = await service.authenticateMiniProgram(loginInput('wx-mini-app'))
    expect(first.outcome).toBe('authenticated')
    if (first.outcome !== 'authenticated') throw new Error('expected authentication')
    const associated = await service.associateMember(SCOPE.tenantId, first.principal.principalId, 'member-amy')
    const second = await service.authenticateMiniProgram(loginInput('wx-service-app'))

    expect(associated).toMatchObject({ ok: true, value: { memberId: 'member-amy' } })
    expect(second).toMatchObject({
      outcome: 'authenticated',
      principal: { principalId: first.principal.principalId, memberId: 'member-amy' },
    })
    expect(await store.findByUnionId(SCOPE.tenantId, 'unionid-shared')).toHaveLength(2)
  })

  it('does not overwrite an existing member association', async () => {
    const provider = providerWith([success('openid-amy', 'unionid-amy')])
    const store = new InMemoryWechatIdentityStore()
    const service = new WechatIdentityService({ provider, repository: store, challengeStore: store, stateSecret: SECRET, now: () => NOW })
    const authenticated = await service.authenticateMiniProgram(loginInput())
    if (authenticated.outcome !== 'authenticated') throw new Error('expected authentication')

    await service.associateMember(SCOPE.tenantId, authenticated.principal.principalId, 'member-amy')
    const conflict = await service.associateMember(SCOPE.tenantId, authenticated.principal.principalId, 'member-bob')

    expect(conflict).toMatchObject({
      ok: false,
      failure: { classification: 'identity_conflict', code: 'WECHAT_IDENTITY_CONFLICT', retryable: false },
    })
  })

  it('preserves supplier failure classification and never fabricates a session', async () => {
    const supplierFailure: WechatFailure = {
      classification: 'rate_limit',
      code: 'WECHAT_RATE_LIMIT',
      message: '微信接口限流',
      retryable: true,
    }
    const provider = providerWith([{ ok: false, failure: supplierFailure }])
    const store = new InMemoryWechatIdentityStore()
    const service = new WechatIdentityService({ provider, repository: store, challengeStore: store, stateSecret: SECRET, now: () => NOW })

    await expect(service.authenticateMiniProgram(loginInput())).resolves.toEqual({ outcome: 'failed', failure: supplierFailure })
  })
})
