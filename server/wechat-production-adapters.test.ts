import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import type { WechatAuthenticatedPrincipal, WechatIdentityRecord } from '../src/shared/wechat-contracts.js'
import type { WechatAuthenticationReplayRecord } from './wechat-api.js'
import { createWechatLoginChallenge } from './wechat-identity.js'
import type {
  PostgresPool,
  PostgresPoolClient,
  PostgresQueryResult,
} from './postgres-repository.js'
import {
  OfficialWechatCodeSessionProvider,
  PostgresWechatChallengeRepository,
  PostgresWechatIdentityRepository,
  type WechatHttpClient,
  type WechatHttpResponse,
} from './wechat-production-adapters.js'

const TENANT_ID = '11111111-1111-4111-8111-111111111111'
const STORE_ID = '22222222-2222-4222-8222-222222222222'
const MEMBER_ID = '33333333-3333-4333-8333-333333333333'
const APP_ID = 'wx-test-app'
const TEST_KEY = Buffer.alloc(32, 7)
const NOW = Date.parse('2026-07-14T10:00:00.000Z')

function digest(value: string) {
  return createHash('sha256').update(value).digest('base64url')
}

function result<Row extends Record<string, unknown>>(rows: Row[] = [], rowCount = rows.length): PostgresQueryResult<Row> {
  return { rows, rowCount }
}

interface QueryRecord {
  sql: string
  values: unknown[]
}

class FakePostgres implements PostgresPool, PostgresPoolClient {
  readonly queries: QueryRecord[] = []
  readonly challenges = new Map<string, Record<string, unknown>>()
  readonly identities: Record<string, unknown>[] = []
  readonly authenticationReplays = new Map<string, Record<string, unknown>>()
  readonly sessions = new Map<string, Record<string, unknown>>()
  readonly mutationReplays = new Map<string, Record<string, unknown>>()
  releases = 0

  async connect() {
    return this
  }

  async end() {}

  release() {
    this.releases += 1
  }

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values: unknown[] = [],
  ): Promise<PostgresQueryResult<Row>> {
    this.queries.push({ sql, values })
    if (sql.startsWith('BEGIN') || sql === 'COMMIT' || sql === 'ROLLBACK' || sql.includes('wechat:set-context')) {
      return result() as PostgresQueryResult<Row>
    }

    if (sql.includes('wechat:challenge-insert')) {
      const key = String(values[7])
      if (this.challenges.has(key)) return result([], 0) as PostgresQueryResult<Row>
      this.challenges.set(key, {
        request_fingerprint: values[8],
        response_ciphertext: values[9],
        response_key_version: values[10],
        consumed: false,
      })
      return result([], 1) as PostgresQueryResult<Row>
    }
    if (sql.includes('wechat:challenge-replay-select')) {
      const row = this.challenges.get(String(values[3]))
      return result(row ? [row] : []) as PostgresQueryResult<Row>
    }
    if (sql.includes('wechat:challenge-consume')) {
      const row = [...this.challenges.values()][0]
      if (!row || row.consumed) return result([], 0) as PostgresQueryResult<Row>
      row.consumed = true
      return result([], 1) as PostgresQueryResult<Row>
    }

    if (sql.includes('wechat:identity-save')) {
      const existing = this.identities.find((row) => row.openid_sha256 === values[6])
      const identity = existing ?? {}
      Object.assign(identity, {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        tenant_id: values[0],
        store_id: values[1],
        external_identity_id: existing?.external_identity_id ?? values[2],
        principal_id: values[4],
        app_id: values[5],
        openid_sha256: values[6],
        openid_ciphertext: values[7],
        openid_key_version: values[8],
        unionid_sha256: values[9],
        unionid_ciphertext: values[10],
        unionid_key_version: values[11],
        member_id: values[12],
        created_at: existing?.created_at ?? values[14],
        updated_at: values[14],
        last_authenticated_at: values[14],
        revoked_at: null,
      })
      if (!existing) this.identities.push(identity)
      return result() as PostgresQueryResult<Row>
    }
    if (sql.includes('wechat:identity-by-openid')) {
      const row = this.identities.find((candidate) => candidate.openid_sha256 === values[3])
      return result(row ? [row] : []) as PostgresQueryResult<Row>
    }
    if (sql.includes('wechat:identity-principal-for-update')) {
      const rows = this.identities.filter((candidate) => candidate.principal_id === values[2])
      return result(rows) as PostgresQueryResult<Row>
    }

    if (sql.includes('wechat:authentication-replay-insert')) {
      const key = String(values[3])
      if (this.authenticationReplays.has(key)) return result([], 0) as PostgresQueryResult<Row>
      this.authenticationReplays.set(key, {
        request_fingerprint: values[4],
        response_ciphertext: values[7],
        response_key_version: values[8],
        principal_id: values[6],
      })
      return result([], 1) as PostgresQueryResult<Row>
    }
    if (sql.includes('wechat:authentication-replay-select')) {
      const row = this.authenticationReplays.get(String(values[3]))
      return result(row ? [row] : []) as PostgresQueryResult<Row>
    }
    if (sql.includes('wechat:session-insert')) {
      this.sessions.set(String(values[5]), {
        access_token_sha256: values[5],
        principal_ciphertext: values[6],
        principal_key_version: values[7],
        issued_at: values[8],
        expires_at: values[9],
        revoked_at: values[10],
        principal_id: values[4],
      })
      return result([], 1) as PostgresQueryResult<Row>
    }
    if (sql.includes('wechat:session-find')) {
      const row = this.sessions.get(String(values[2]))
      return result(row ? [row] : []) as PostgresQueryResult<Row>
    }

    if (sql.includes('wechat:mutation-advisory-lock')) return result() as PostgresQueryResult<Row>
    if (sql.includes('wechat:mutation-replay-select')) {
      const key = `${values[2]}:${values[3]}:${values[4]}`
      const row = this.mutationReplays.get(key)
      return result(row ? [row] : []) as PostgresQueryResult<Row>
    }
    if (sql.includes('wechat:mutation-replay-insert')) {
      const key = `${values[2]}:${values[3]}:${values[4]}`
      this.mutationReplays.set(key, {
        request_fingerprint: values[5],
        result_ciphertext: values[6],
        result_key_version: values[7],
      })
      return result([], 1) as PostgresQueryResult<Row>
    }
    if (sql.includes('wechat:identity-revoke')) {
      for (const identity of this.identities) {
        if (identity.principal_id === values[2]) identity.revoked_at = values[3]
      }
      return result([], this.identities.length) as PostgresQueryResult<Row>
    }
    if (sql.includes('wechat:sessions-revoke-all')) {
      let count = 0
      for (const session of this.sessions.values()) {
        if (session.principal_id === values[2] && session.revoked_at === null) {
          session.revoked_at = values[3]
          count += 1
        }
      }
      return result([], count) as PostgresQueryResult<Row>
    }
    if (sql.includes('wechat:authentication-replay-delete-principal')) {
      for (const [key, replay] of this.authenticationReplays) {
        if (replay.principal_id === values[2]) this.authenticationReplays.delete(key)
      }
      return result() as PostgresQueryResult<Row>
    }

    return result() as PostgresQueryResult<Row>
  }
}

class FakeHttpClient implements WechatHttpClient {
  calls: string[] = []

  constructor(private readonly handler: (url: string, signal: AbortSignal) => Promise<WechatHttpResponse>) {}

  async get(url: string, options: { signal: AbortSignal }) {
    this.calls.push(url)
    return this.handler(url, options.signal)
  }
}

function repositoryOptions(pool: PostgresPool) {
  return {
    pool,
    tenantId: TENANT_ID,
    storeId: STORE_ID,
    appId: APP_ID,
    activeKeyVersion: 7,
    encryptionKeys: new Map([[7, TEST_KEY]]),
    randomBytes: (size: number) => Buffer.alloc(size, 9),
  }
}

describe('OfficialWechatCodeSessionProvider', () => {
  it('calls the official shape through an injected client and classifies WeChat errors', async () => {
    const http = new FakeHttpClient(async () => ({
      status: 200,
      body: { openid: 'openid-secret', unionid: 'unionid-secret', session_key: 'session-key-secret', rid: 'rid-1' },
    }))
    const provider = new OfficialWechatCodeSessionProvider({
      appSecrets: { [APP_ID]: 'app-secret-value' },
      endpoint: 'https://api.weixin.qq.com/sns/jscode2session',
      httpClient: http,
      timeoutMs: 100,
    })

    await expect(provider.exchangeCode({ appId: APP_ID, code: 'one-time-code' })).resolves.toEqual({
      ok: true,
      value: {
        openId: 'openid-secret',
        unionId: 'unionid-secret',
        sessionKey: 'session-key-secret',
        providerRequestId: 'rid-1',
      },
    })
    const requestUrl = new URL(http.calls[0]!)
    expect(requestUrl.searchParams.get('appid')).toBe(APP_ID)
    expect(requestUrl.searchParams.get('secret')).toBe('app-secret-value')
    expect(requestUrl.searchParams.get('js_code')).toBe('one-time-code')

    const rejected = new OfficialWechatCodeSessionProvider({
      appSecrets: { [APP_ID]: 'app-secret-value' },
      httpClient: new FakeHttpClient(async () => ({ status: 200, body: { errcode: 40163, errmsg: 'code been used', rid: 'rid-2' } })),
    })
    await expect(rejected.exchangeCode({ appId: APP_ID, code: 'reused-code' })).resolves.toMatchObject({
      ok: false,
      failure: { classification: 'replay', code: 'WECHAT_CODE_ALREADY_USED', retryable: false, providerRequestId: 'rid-2' },
    })
  })

  it('times out an uncooperative client and never echoes secrets in failures', async () => {
    const provider = new OfficialWechatCodeSessionProvider({
      appSecrets: { [APP_ID]: 'do-not-echo-secret' },
      timeoutMs: 5,
      httpClient: new FakeHttpClient(async () => new Promise<WechatHttpResponse>(() => {})),
    })
    const response = await provider.exchangeCode({ appId: APP_ID, code: 'do-not-echo-code' })
    expect(response).toMatchObject({
      ok: false,
      failure: { classification: 'transient', code: 'WECHAT_CODE_EXCHANGE_TIMEOUT', retryable: true },
    })
    expect(JSON.stringify(response)).not.toContain('do-not-echo')
  })
})

describe('PostgreSQL WeChat repositories', () => {
  it('persists challenge replay data encrypted while setting scoped RLS context', async () => {
    const pool = new FakePostgres()
    const repository = new PostgresWechatChallengeRepository(repositoryOptions(pool))
    const challenge = createWechatLoginChallenge(
      { tenantId: TENANT_ID, storeId: STORE_ID, appId: APP_ID },
      'fixed-test-state-secret-with-more-than-32-characters',
      { now: NOW },
    )
    const record = {
      tenantId: TENANT_ID,
      storeId: STORE_ID,
      appId: APP_ID,
      idempotencyKey: 'challenge-idempotency-key',
      requestFingerprint: digest('challenge-request'),
      challenge,
    }

    await expect(repository.issue(record)).resolves.toMatchObject({ outcome: 'created', record: { challenge } })
    await expect(repository.issue(record)).resolves.toMatchObject({ outcome: 'replayed', record: { challenge } })

    const insert = pool.queries.find(({ sql }) => sql.includes('wechat:challenge-insert'))!
    const stringParameters = insert.values.filter((value): value is string => typeof value === 'string')
    expect(stringParameters).not.toContain(challenge.state)
    expect(stringParameters).not.toContain(challenge.nonce)
    expect(insert.values[9]).toBeInstanceOf(Buffer)
    expect((insert.values[9] as Buffer).toString('utf8')).not.toContain(challenge.nonce)
    expect(pool.queries.filter(({ sql }) => sql.includes('wechat:set-context'))).toHaveLength(2)
    expect(pool.queries.every(({ sql }) => !sql.includes(challenge.state) && !sql.includes(challenge.nonce))).toBe(true)
  })

  it('encrypts identities and sessions, atomically commits auth, and revokes every principal session', async () => {
    const pool = new FakePostgres()
    const repository = new PostgresWechatIdentityRepository(repositoryOptions(pool))
    const identity: WechatIdentityRecord = {
      id: 'wechat_identity_external_1',
      principalId: 'wechat_principal_1',
      tenantId: TENANT_ID,
      storeId: STORE_ID,
      appId: APP_ID,
      openId: 'openid-must-be-encrypted',
      unionId: 'unionid-must-be-encrypted',
      memberId: null,
      createdAt: new Date(NOW).toISOString(),
      lastAuthenticatedAt: new Date(NOW).toISOString(),
    }
    await repository.save(identity)
    await expect(repository.findByAppOpenId(TENANT_ID, APP_ID, identity.openId)).resolves.toEqual(identity)

    const save = pool.queries.find(({ sql }) => sql.includes('wechat:identity-save'))!
    expect(save.values).not.toContain(identity.openId)
    expect(save.values).not.toContain(identity.unionId)
    expect(save.values[7]).toBeInstanceOf(Buffer)
    expect(save.values[10]).toBeInstanceOf(Buffer)

    const principal: WechatAuthenticatedPrincipal = {
      principalId: identity.principalId,
      identityId: identity.id,
      tenantId: TENANT_ID,
      storeId: STORE_ID,
      appId: APP_ID,
      memberId: null,
      hasUnionId: true,
    }
    const commit = async (suffix: string) => {
      const accessToken = `raw-access-token-${suffix}`
      const accessTokenHash = digest(accessToken)
      const replay: WechatAuthenticationReplayRecord = {
        tenantId: TENANT_ID,
        storeId: STORE_ID,
        appId: APP_ID,
        idempotencyKey: `authentication-idempotency-${suffix}`,
        requestFingerprint: digest(`request-${suffix}`),
        response: {
          tokenType: 'Bearer',
          accessToken,
          expiresAt: new Date(NOW + 60_000).toISOString(),
          principal,
        },
      }
      await expect(repository.completeAuthentication({
        replay,
        session: { accessTokenHash, principal, issuedAt: NOW, expiresAt: NOW + 60_000, revokedAt: null },
      })).resolves.toMatchObject({ outcome: 'created' })
      return accessTokenHash
    }

    const firstTokenHash = await commit('one')
    const secondTokenHash = await commit('two')
    expect(pool.queries.find(({ sql }) => sql.includes('wechat:session-insert'))!.values).not.toContain('raw-access-token-one')

    const mutation = {
      tenantId: TENANT_ID,
      storeId: STORE_ID,
      principalId: principal.principalId,
      idempotencyKey: 'revoke-idempotency-key',
      requestFingerprint: digest('revoke-request'),
      now: NOW + 1_000,
    }
    await expect(repository.revokeAuthorization(mutation)).resolves.toEqual({ ok: true, value: { replayed: false } })
    await expect(repository.revokeAuthorization(mutation)).resolves.toEqual({ ok: true, value: { replayed: true } })

    const first = await repository.findSession(firstTokenHash)
    const second = await repository.findSession(secondTokenHash)
    expect(first?.revokedAt).toBe(NOW + 1_000)
    expect(second?.revokedAt).toBe(NOW + 1_000)
    const revokeAll = pool.queries.find(({ sql }) => sql.includes('wechat:sessions-revoke-all'))!
    expect(revokeAll.sql).toContain('principal_id = $3')
    expect(revokeAll.sql).not.toContain('access_token_sha256')
    expect(pool.queries.filter(({ sql }) => sql.includes('wechat:sessions-revoke-all'))).toHaveLength(1)
  })

  it('issues a raw member grant once but persists only its SHA-256 digest', async () => {
    const pool = new FakePostgres()
    const repository = new PostgresWechatIdentityRepository(repositoryOptions(pool))
    const token = await repository.issueMemberBindingGrant({
      memberId: MEMBER_ID,
      expiresAt: new Date(NOW + 60_000),
      now: new Date(NOW),
    })
    const insert = pool.queries.find(({ sql }) => sql.includes('wechat:member-grant-insert'))!
    expect(token).toHaveLength(43)
    expect(insert.values).not.toContain(token)
    expect(insert.values[3]).toBe(digest(token))
  })
})

describe('010 WeChat migration', () => {
  it('uses composite foreign keys and forces RLS for every new persistence table', async () => {
    const sql = await readFile(new URL('../database/migrations/010_wechat_identity_sessions.sql', import.meta.url), 'utf8')
    for (const table of [
      'wechat_identity_sessions',
      'wechat_authentication_replays',
      'wechat_identity_mutation_replays',
      'wechat_member_binding_grants',
    ]) {
      expect(sql).toContain(`'${table}'`)
    }
    expect(sql).toContain("EXECUTE format('ALTER TABLE mbox.%I FORCE ROW LEVEL SECURITY'")
    expect(sql).toContain('FOREIGN KEY (tenant_id, store_id, identity_external_id)')
    expect(sql).toContain('FOREIGN KEY (tenant_id, store_id, member_id)')
    expect(sql).not.toMatch(/FOREIGN KEY \((identity_external_id|member_id)\)/)
    expect(sql.trim().startsWith('BEGIN;')).toBe(true)
    expect(sql.trim().endsWith('COMMIT;')).toBe(true)
  })
})
