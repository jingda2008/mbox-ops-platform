import Fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { MiniProgramCodeSession, WechatLoginChallenge, WechatProviderResult } from '../src/shared/wechat-contracts.js'
import { wechatApiPlugin, type WechatApiOptions } from './wechat-api.js'
import {
  InMemoryWechatApiIdentityRepository,
  InMemoryWechatChallengeRepository,
  ScriptedMiniProgramCodeSessionProvider,
} from './wechat-inmemory-test-adapters.js'

const STATE_SECRET = 'test-only-wechat-state-signing-secret-32-plus'
const NOW = Date.parse('2026-07-14T12:00:00.000Z')
const LUJIAZUI = { tenantId: 'tenant-mbox', storeId: 'mbox-lujiazui', appId: 'wx-test-mini' }
const XINTIANDI = { tenantId: 'tenant-mbox', storeId: 'mbox-xintiandi', appId: 'wx-test-mini' }
const apps: FastifyInstance[] = []

function providerSuccess(openId = 'openid-test-amy'): WechatProviderResult<MiniProgramCodeSession> {
  return {
    ok: true,
    value: {
      openId,
      unionId: 'unionid-test-amy',
      sessionKey: 'provider-session-evidence-not-returned-by-api',
      providerRequestId: 'provider-request-test-1',
    },
  }
}

async function buildApp(overrides: Partial<WechatApiOptions> = {}, providerResults = [providerSuccess()]) {
  const app = Fastify()
  apps.push(app)
  const challengeRepository = new InMemoryWechatChallengeRepository()
  const identityRepository = new InMemoryWechatApiIdentityRepository()
  const provider = new ScriptedMiniProgramCodeSessionProvider(providerResults)
  await app.register(wechatApiPlugin, {
    runtimeMode: 'test',
    stateSecret: STATE_SECRET,
    provider,
    challengeRepository,
    identityRepository,
    applications: [LUJIAZUI, XINTIANDI],
    now: () => NOW,
    ...overrides,
  })
  await app.ready()
  return { app, challengeRepository, identityRepository, provider }
}

async function issueChallenge(app: FastifyInstance, scope = LUJIAZUI, idempotencyKey = 'challenge-request-0001') {
  const response = await app.inject({
    method: 'POST',
    url: '/api/wechat/challenges',
    payload: { ...scope, idempotencyKey },
  })
  expect(response.statusCode).toBe(201)
  return response.json<WechatLoginChallenge>()
}

function authenticationPayload(
  challenge: WechatLoginChallenge,
  scope = LUJIAZUI,
  idempotencyKey = 'code-auth-request-0001',
) {
  return {
    ...scope,
    code: 'one-time-code-from-client',
    state: challenge.state,
    nonce: challenge.nonce,
    idempotencyKey,
  }
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

describe('wechat Fastify API registration and anonymous boundary', () => {
  it('refuses production registration when provider or repositories are absent', async () => {
    const app = Fastify()
    apps.push(app)
    app.register(wechatApiPlugin, { runtimeMode: 'production' })
    await expect(app.ready()).rejects.toThrow('生产环境拒绝注册微信身份API')
  })

  it('allowlists exact application scope and rejects a cross-store state before provider exchange', async () => {
    const { app, provider } = await buildApp()
    const challenge = await issueChallenge(app, LUJIAZUI)
    const response = await app.inject({
      method: 'POST',
      url: '/api/wechat/code-authentication',
      payload: authenticationPayload(challenge, XINTIANDI),
    })

    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ code: 'STATE_SCOPE_MISMATCH', classification: 'authorization' })
    expect(provider.requests).toHaveLength(0)
  })

  it('rejects an expired challenge before provider exchange', async () => {
    let currentTime = NOW
    const { app, provider } = await buildApp({ now: () => currentTime, challengeTtlMs: 1_000 })
    const challenge = await issueChallenge(app)
    currentTime += 1_000

    const response = await app.inject({
      method: 'POST',
      url: '/api/wechat/code-authentication',
      payload: authenticationPayload(challenge),
    })

    expect(response.statusCode).toBe(410)
    expect(response.json()).toMatchObject({ code: 'STATE_EXPIRED', classification: 'expired', retryable: false })
    expect(provider.requests).toHaveLength(0)
  })
})

describe('wechat code authentication idempotency and failures', () => {
  it('replays a completed idempotency key without exchanging code twice and rejects challenge replay under a new key', async () => {
    const { app, identityRepository, provider } = await buildApp()
    const challenge = await issueChallenge(app)
    const payload = authenticationPayload(challenge)

    const first = await app.inject({ method: 'POST', url: '/api/wechat/code-authentication', payload })
    const idempotentReplay = await app.inject({ method: 'POST', url: '/api/wechat/code-authentication', payload })
    const challengeReplay = await app.inject({
      method: 'POST',
      url: '/api/wechat/code-authentication',
      payload: { ...payload, idempotencyKey: 'code-auth-request-0002' },
    })

    expect(first.statusCode).toBe(200)
    expect(first.json()).toMatchObject({ tokenType: 'Bearer', principal: { ...LUJIAZUI, memberId: null } })
    expect(first.json()).not.toHaveProperty('sessionKey')
    expect(idempotentReplay.statusCode).toBe(200)
    expect(idempotentReplay.headers['idempotent-replayed']).toBe('true')
    expect(idempotentReplay.json()).toEqual(first.json())
    expect(challengeReplay.statusCode).toBe(409)
    expect(challengeReplay.json()).toMatchObject({ code: 'LOGIN_CHALLENGE_REPLAYED', classification: 'replay' })
    expect(provider.requests).toHaveLength(1)
    expect(identityRepository.identityRecords()[0]).not.toHaveProperty('sessionKey')
  })

  it('preserves provider failure classification and creates no local session', async () => {
    const providerFailure = {
      ok: false,
      failure: {
        classification: 'transient',
        code: 'WECHAT_PROVIDER_UNAVAILABLE',
        message: '微信provider暂不可用',
        retryable: true,
        providerRequestId: 'provider-failure-request-1',
      },
    } satisfies WechatProviderResult<MiniProgramCodeSession>
    const { app, identityRepository, provider } = await buildApp({}, [providerFailure])
    const challenge = await issueChallenge(app)

    const failed = await app.inject({
      method: 'POST',
      url: '/api/wechat/code-authentication',
      payload: authenticationPayload(challenge),
    })
    const replayed = await app.inject({
      method: 'POST',
      url: '/api/wechat/code-authentication',
      payload: authenticationPayload(challenge, LUJIAZUI, 'code-auth-after-failure'),
    })

    expect(failed.statusCode).toBe(503)
    expect(failed.json()).toEqual({
      code: 'WECHAT_PROVIDER_UNAVAILABLE',
      message: '微信provider暂不可用',
      classification: 'transient',
      retryable: true,
      providerRequestId: 'provider-failure-request-1',
    })
    expect(replayed.statusCode).toBe(409)
    expect(replayed.json()).toMatchObject({ code: 'LOGIN_CHALLENGE_REPLAYED' })
    expect(provider.requests).toHaveLength(1)
    expect(identityRepository.activeSessionCount()).toBe(0)
  })
})

describe('wechat member binding and authorization lifecycle', () => {
  it('requires a scoped one-time grant, supports unbind, and revokes identity plus sessions', async () => {
    const { app, identityRepository } = await buildApp()
    const grantToken = identityRepository.issueMemberBindingGrant({
      tenantId: LUJIAZUI.tenantId,
      storeId: LUJIAZUI.storeId,
      memberId: 'member-amy',
      expiresAt: NOW + 60_000,
    })
    const challenge = await issueChallenge(app)
    const login = await app.inject({
      method: 'POST',
      url: '/api/wechat/code-authentication',
      payload: {
        ...authenticationPayload(challenge),
        memberBinding: { memberId: 'member-amy', grantToken },
      },
    })
    const accessToken = login.json<{ accessToken: string }>().accessToken
    expect(login.statusCode).toBe(200)
    expect(login.json()).toMatchObject({ principal: { memberId: 'member-amy' } })

    const unbound = await app.inject({
      method: 'DELETE',
      url: '/api/wechat/member-binding',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { idempotencyKey: 'unbind-member-request-1' },
    })
    expect(unbound.statusCode).toBe(200)
    expect(unbound.json()).toMatchObject({ principal: { memberId: null } })

    const revoked = await app.inject({
      method: 'POST',
      url: '/api/wechat/authorization/revoke',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { idempotencyKey: 'revoke-authorization-1' },
    })
    expect(revoked.statusCode).toBe(200)
    expect(revoked.json()).toEqual({ status: 'authorization_revoked' })
    expect(identityRepository.identityRecords()).toHaveLength(0)
    expect(identityRepository.activeSessionCount()).toBe(0)

    const afterRevocation = await app.inject({
      method: 'POST',
      url: '/api/wechat/logout',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { idempotencyKey: 'logout-after-revoke-1' },
    })
    expect(afterRevocation.statusCode).toBe(401)
    expect(afterRevocation.json()).toMatchObject({ code: 'WECHAT_SESSION_INVALID' })
  })

  it('rejects a member grant scoped to another store', async () => {
    const { app, identityRepository } = await buildApp()
    const grantToken = identityRepository.issueMemberBindingGrant({
      tenantId: XINTIANDI.tenantId,
      storeId: XINTIANDI.storeId,
      memberId: 'member-amy',
      expiresAt: NOW + 60_000,
    })
    const challenge = await issueChallenge(app)
    const response = await app.inject({
      method: 'POST',
      url: '/api/wechat/code-authentication',
      payload: {
        ...authenticationPayload(challenge),
        memberBinding: { memberId: 'member-amy', grantToken },
      },
    })

    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ code: 'MEMBER_BINDING_SCOPE_MISMATCH' })
    expect(identityRepository.activeSessionCount()).toBe(0)
  })
})
