import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto'
import type {
  MiniProgramCodeSession,
  MiniProgramCodeSessionProvider,
  MiniProgramCodeSessionRequest,
  WechatAuthenticatedPrincipal,
  WechatFailure,
  WechatIdentityRecord,
  WechatChannel,
  WechatNotificationRecipient,
  WechatNotificationRecipientResolver,
  WechatProviderResult,
} from '../src/shared/wechat-contracts.js'
import type {
  WechatApiChallengeRepository,
  WechatApiIdentityRepository,
  WechatApiSessionRecord,
  WechatApplicationScope,
  WechatAuthenticationCommitResult,
  WechatAuthenticationReplayRecord,
  WechatChallengeIssueResult,
  WechatCodeAuthenticationResponse,
  WechatIdentityMutationInput,
  WechatIssuedChallengeRecord,
} from './wechat-api.js'
import type {
  PostgresPool,
  PostgresPoolClient,
  PostgresQueryResult,
} from './postgres-repository.js'

const DEFAULT_WECHAT_ENDPOINT = 'https://api.weixin.qq.com/sns/jscode2session'
const DEFAULT_HTTP_TIMEOUT_MS = 5_000
const DEFAULT_MUTATION_REPLAY_TTL_MS = 24 * 60 * 60_000
const DEFAULT_REVOKED_SESSION_RETENTION_MS = 7 * 24 * 60 * 60_000
const DEFAULT_CLEANUP_BATCH_SIZE = 500
const SHA256_BASE64URL_PATTERN = /^[A-Za-z0-9_-]{43}$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function failure(
  classification: WechatFailure['classification'],
  code: string,
  message: string,
  retryable = false,
  providerRequestId?: string,
): WechatFailure {
  return { classification, code, message, retryable, ...(providerRequestId ? { providerRequestId } : {}) }
}

function sha256Hex(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

function sha256Base64Url(value: string) {
  return createHash('sha256').update(value).digest('base64url')
}

function asDate(value: Date | string | number) {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid persisted WeChat timestamp')
  return date
}

function assertPositiveInteger(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`)
}

function assertUuid(value: string, name: string) {
  if (!UUID_PATTERN.test(value)) throw new Error(`${name} must be a UUID`)
}

function assertSha256Base64Url(value: string, name: string) {
  if (!SHA256_BASE64URL_PATTERN.test(value)) throw new Error(`${name} must be a base64url SHA-256 digest`)
}

export interface WechatHttpResponse {
  status: number
  body: unknown
}

export interface WechatHttpClient {
  get(url: string, options: { signal: AbortSignal }): Promise<WechatHttpResponse>
}

export interface OfficialWechatCodeSessionProviderOptions {
  appSecrets: Readonly<Record<string, string>>
  endpoint?: string
  httpClient?: WechatHttpClient
  timeoutMs?: number
}

class FetchWechatHttpClient implements WechatHttpClient {
  async get(url: string, options: { signal: AbortSignal }): Promise<WechatHttpResponse> {
    const response = await fetch(url, {
      method: 'GET',
      signal: options.signal,
      headers: { accept: 'application/json' },
    })
    const text = await response.text()
    let body: unknown = null
    if (text) {
      try {
        body = JSON.parse(text)
      } catch {
        body = text
      }
    }
    return { status: response.status, body }
  }
}

interface WechatCodeSessionBody extends Record<string, unknown> {
  errcode?: number
  errmsg?: string
  openid?: string
  session_key?: string
  unionid?: string
  rid?: string
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function classifyProviderError(body: WechatCodeSessionBody): WechatFailure {
  const requestId = typeof body.rid === 'string' && body.rid.trim() ? body.rid.trim() : undefined
  switch (body.errcode) {
    case -1:
      return failure('transient', 'WECHAT_PROVIDER_BUSY', '微信登录服务暂时繁忙', true, requestId)
    case 40013:
      return failure('configuration', 'WECHAT_APP_ID_INVALID', '微信小程序AppID配置无效', false, requestId)
    case 40125:
      return failure('configuration', 'WECHAT_APP_SECRET_INVALID', '微信小程序AppSecret配置无效', false, requestId)
    case 40029:
      return failure('authentication', 'WECHAT_CODE_INVALID', '微信登录code无效或已过期', false, requestId)
    case 40163:
      return failure('replay', 'WECHAT_CODE_ALREADY_USED', '微信登录code已被使用', false, requestId)
    case 40226:
      return failure('provider_rejection', 'WECHAT_LOGIN_HIGH_RISK', '微信拒绝了高风险登录请求', false, requestId)
    case 45011:
      return failure('rate_limit', 'WECHAT_LOGIN_RATE_LIMITED', '微信登录请求过于频繁', true, requestId)
    default:
      return failure('provider_rejection', 'WECHAT_CODE_EXCHANGE_REJECTED', '微信拒绝了登录code交换', false, requestId)
  }
}

export class OfficialWechatCodeSessionProvider implements MiniProgramCodeSessionProvider {
  private readonly endpoint: string
  private readonly httpClient: WechatHttpClient
  private readonly timeoutMs: number

  constructor(private readonly options: OfficialWechatCodeSessionProviderOptions) {
    this.endpoint = options.endpoint ?? DEFAULT_WECHAT_ENDPOINT
    this.httpClient = options.httpClient ?? new FetchWechatHttpClient()
    this.timeoutMs = options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS
    assertPositiveInteger(this.timeoutMs, 'WeChat HTTP timeout')
    const endpoint = new URL(this.endpoint)
    if (endpoint.protocol !== 'https:' && endpoint.hostname !== 'localhost' && endpoint.hostname !== '127.0.0.1') {
      throw new Error('WeChat code-session endpoint must use HTTPS')
    }
  }

  async exchangeCode(request: MiniProgramCodeSessionRequest): Promise<WechatProviderResult<MiniProgramCodeSession>> {
    const appSecret = this.options.appSecrets[request.appId]
    if (!appSecret?.trim()) {
      return { ok: false, failure: failure('configuration', 'WECHAT_APP_SECRET_MISSING', '微信小程序AppSecret未配置') }
    }
    if (!request.code.trim()) {
      return { ok: false, failure: failure('validation', 'WECHAT_CODE_MISSING', '微信登录code不能为空') }
    }

    const url = new URL(this.endpoint)
    url.searchParams.set('appid', request.appId)
    url.searchParams.set('secret', appSecret)
    url.searchParams.set('js_code', request.code)
    url.searchParams.set('grant_type', 'authorization_code')
    const abortController = new AbortController()
    let timeout: ReturnType<typeof setTimeout> | undefined
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        abortController.abort()
        reject(new Error('WECHAT_HTTP_TIMEOUT'))
      }, this.timeoutMs)
    })

    let response: WechatHttpResponse
    try {
      response = await Promise.race([
        this.httpClient.get(url.toString(), { signal: abortController.signal }),
        timeoutPromise,
      ])
    } catch (error) {
      const timedOut = error instanceof Error && error.message === 'WECHAT_HTTP_TIMEOUT'
      return {
        ok: false,
        failure: failure(
          'transient',
          timedOut ? 'WECHAT_CODE_EXCHANGE_TIMEOUT' : 'WECHAT_PROVIDER_UNAVAILABLE',
          timedOut ? '微信登录code交换超时' : '微信登录服务暂时不可用',
          true,
        ),
      }
    } finally {
      if (timeout) clearTimeout(timeout)
    }

    if (response.status === 429) {
      return { ok: false, failure: failure('rate_limit', 'WECHAT_HTTP_RATE_LIMITED', '微信登录请求受到HTTP限流', true) }
    }
    if (response.status >= 500) {
      return { ok: false, failure: failure('transient', 'WECHAT_PROVIDER_UNAVAILABLE', '微信登录服务暂时不可用', true) }
    }
    if (response.status < 200 || response.status >= 300) {
      const classification = response.status === 401 || response.status === 403 ? 'configuration' : 'provider_rejection'
      return { ok: false, failure: failure(classification, 'WECHAT_CODE_EXCHANGE_HTTP_REJECTED', '微信登录服务拒绝了code交换') }
    }
    if (!isObject(response.body)) {
      return { ok: false, failure: failure('provider_rejection', 'WECHAT_CODE_SESSION_MALFORMED', '微信登录服务返回了无效响应') }
    }

    const body = response.body as WechatCodeSessionBody
    if (typeof body.errcode === 'number' && body.errcode !== 0) {
      return { ok: false, failure: classifyProviderError(body) }
    }
    if (typeof body.openid !== 'string' || !body.openid.trim() || typeof body.session_key !== 'string' || !body.session_key.trim()) {
      return { ok: false, failure: failure('provider_rejection', 'WECHAT_CODE_SESSION_MALFORMED', '微信登录服务未返回完整会话证据') }
    }
    return {
      ok: true,
      value: {
        openId: body.openid.trim(),
        unionId: typeof body.unionid === 'string' && body.unionid.trim() ? body.unionid.trim() : null,
        sessionKey: body.session_key,
        ...(typeof body.rid === 'string' && body.rid.trim() ? { providerRequestId: body.rid.trim() } : {}),
      },
    }
  }
}

export type WechatEncryptionKeys = ReadonlyMap<number, Buffer | string> | Readonly<Record<number, Buffer | string>>

export interface PostgresWechatRepositoryOptions extends WechatApplicationScope {
  pool: PostgresPool
  activeKeyVersion: number
  encryptionKeys: WechatEncryptionKeys
  consentVersion?: string
  mutationReplayTtlMs?: number
  revokedSessionRetentionMs?: number
  randomBytes?: (size: number) => Buffer
  notificationAppIds?: Partial<Record<WechatChannel, string>>
}

interface IdentityRow extends Record<string, unknown> {
  id: string
  external_identity_id: string
  principal_id: string
  tenant_id: string
  store_id: string
  app_id: string
  openid_sha256: string
  openid_ciphertext: Buffer
  openid_key_version: number | string
  unionid_sha256: string | null
  unionid_ciphertext: Buffer | null
  unionid_key_version: number | string | null
  member_id: string | null
  created_at: Date | string
  updated_at: Date | string
  last_authenticated_at: Date | string
}

interface ChallengeReplayRow extends Record<string, unknown> {
  request_fingerprint: string
  response_ciphertext: Buffer
  response_key_version: number | string
}

interface AuthenticationReplayRow extends Record<string, unknown> {
  request_fingerprint: string
  response_ciphertext: Buffer
  response_key_version: number | string
}

interface SessionRow extends Record<string, unknown> {
  access_token_sha256: string
  principal_ciphertext: Buffer
  principal_key_version: number | string
  issued_at: Date | string
  expires_at: Date | string
  revoked_at: Date | string | null
}

interface MutationReplayRow extends Record<string, unknown> {
  request_fingerprint: string
  result_ciphertext: Buffer
  result_key_version: number | string
}

interface GrantRow extends Record<string, unknown> {
  member_id: string
  expires_at: Date | string
  consumed_at: Date | string | null
}

function readKey(keys: WechatEncryptionKeys, version: number) {
  const source = typeof (keys as ReadonlyMap<number, Buffer | string>).get === 'function'
    ? (keys as ReadonlyMap<number, Buffer | string>).get(version)
    : (keys as Readonly<Record<number, Buffer | string>>)[version]
  if (source === undefined) throw new Error(`Missing WeChat encryption key version ${version}`)
  const key = Buffer.isBuffer(source) ? Buffer.from(source) : Buffer.from(source, 'base64')
  if (key.length !== 32) throw new Error(`WeChat encryption key version ${version} must decode to 32 bytes`)
  return key
}

function rowCount(result: PostgresQueryResult) {
  return result.rowCount ?? result.rows.length
}

abstract class ScopedWechatPostgresRepository {
  protected readonly tenantId: string
  protected readonly storeId: string
  protected readonly appId: string
  protected readonly activeKeyVersion: number
  protected readonly random: (size: number) => Buffer
  protected readonly mutationReplayTtlMs: number
  protected readonly revokedSessionRetentionMs: number
  protected readonly consentVersion: string

  constructor(protected readonly options: PostgresWechatRepositoryOptions) {
    assertUuid(options.tenantId, 'tenantId')
    assertUuid(options.storeId, 'storeId')
    if (!options.appId.trim()) throw new Error('appId must not be empty')
    assertPositiveInteger(options.activeKeyVersion, 'WeChat active encryption key version')
    readKey(options.encryptionKeys, options.activeKeyVersion)
    this.tenantId = options.tenantId
    this.storeId = options.storeId
    this.appId = options.appId
    this.activeKeyVersion = options.activeKeyVersion
    this.random = options.randomBytes ?? randomBytes
    this.mutationReplayTtlMs = options.mutationReplayTtlMs ?? DEFAULT_MUTATION_REPLAY_TTL_MS
    this.revokedSessionRetentionMs = options.revokedSessionRetentionMs ?? DEFAULT_REVOKED_SESSION_RETENTION_MS
    this.consentVersion = options.consentVersion ?? 'mini-program-login-v1'
    assertPositiveInteger(this.mutationReplayTtlMs, 'WeChat mutation replay TTL')
    assertPositiveInteger(this.revokedSessionRetentionMs, 'WeChat revoked session retention')
  }

  protected assertTenant(tenantId: string) {
    if (tenantId !== this.tenantId) throw new Error('Cross-tenant WeChat repository access rejected')
  }

  protected assertScope(scope: Pick<WechatApplicationScope, 'tenantId' | 'storeId'> & Partial<Pick<WechatApplicationScope, 'appId'>>) {
    if (scope.tenantId !== this.tenantId || scope.storeId !== this.storeId || (scope.appId !== undefined && scope.appId !== this.appId)) {
      throw new Error('Cross-scope WeChat repository access rejected')
    }
  }

  protected async transaction<T>(readOnly: boolean, operation: (client: PostgresPoolClient) => Promise<T>) {
    const client = await this.options.pool.connect()
    let started = false
    let releaseError: Error | boolean | undefined
    try {
      await client.query(readOnly ? 'BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY' : 'BEGIN ISOLATION LEVEL READ COMMITTED')
      started = true
      await client.query(
        `/* wechat:set-context */ SELECT set_config('app.tenant_id', $1, true), set_config('app.store_id', $2, true)`,
        [this.tenantId, this.storeId],
      )
      const value = await operation(client)
      await client.query('COMMIT')
      return value
    } catch (error) {
      if (started) {
        try {
          await client.query('ROLLBACK')
        } catch (rollbackError) {
          releaseError = rollbackError instanceof Error ? rollbackError : true
          throw new AggregateError([error, rollbackError], 'WeChat PostgreSQL transaction and rollback both failed')
        }
      }
      throw error
    } finally {
      client.release(releaseError)
    }
  }

  protected encryptJson(value: unknown, purpose: string, reference: string) {
    const key = readKey(this.options.encryptionKeys, this.activeKeyVersion)
    const iv = this.random(12)
    if (iv.length !== 12) throw new Error('WeChat encryption IV generator must return 12 bytes')
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(this.aad(purpose, reference, this.activeKeyVersion))
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
    return {
      ciphertext: Buffer.concat([iv, cipher.getAuthTag(), ciphertext]),
      keyVersion: this.activeKeyVersion,
    }
  }

  protected decryptJson<T>(envelope: Buffer, keyVersion: number | string, purpose: string, reference: string): T {
    const version = Number(keyVersion)
    const key = readKey(this.options.encryptionKeys, version)
    if (!Buffer.isBuffer(envelope) || envelope.length < 29) throw new Error('Invalid WeChat encrypted envelope')
    const decipher = createDecipheriv('aes-256-gcm', key, envelope.subarray(0, 12))
    decipher.setAAD(this.aad(purpose, reference, version))
    decipher.setAuthTag(envelope.subarray(12, 28))
    const plaintext = Buffer.concat([decipher.update(envelope.subarray(28)), decipher.final()]).toString('utf8')
    return JSON.parse(plaintext) as T
  }

  private aad(purpose: string, reference: string, keyVersion: number) {
    return Buffer.from(JSON.stringify(['mbox-wechat-v1', this.tenantId, this.storeId, purpose, reference, keyVersion]))
  }
}

function challengeIdFromState(state: string) {
  const payload = state.split('.')[0]
  if (!payload) throw new Error('WeChat challenge state payload is missing')
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    throw new Error('WeChat challenge state payload is invalid')
  }
  if (!isObject(value) || typeof value.challengeId !== 'string' || !UUID_PATTERN.test(value.challengeId)) {
    throw new Error('WeChat challenge state does not contain a valid challengeId')
  }
  return value.challengeId
}

export class PostgresWechatChallengeRepository
  extends ScopedWechatPostgresRepository
  implements WechatApiChallengeRepository {
  async issue(record: WechatIssuedChallengeRecord): Promise<WechatChallengeIssueResult> {
    this.assertScope(record)
    const challengeId = challengeIdFromState(record.challenge.state)
    const expiresAt = asDate(record.challenge.expiresAt)
    const idempotencyHash = sha256Hex(record.idempotencyKey)
    const encrypted = this.encryptJson(record.challenge, 'challenge-response', idempotencyHash)
    return this.transaction(false, async (client) => {
      const inserted = await client.query(
        `/* wechat:challenge-insert */
         INSERT INTO mbox.wechat_auth_challenges (
           id, tenant_id, store_id, app_id, channel, state_sha256, nonce_sha256,
           expires_at, idempotency_key_sha256, request_fingerprint,
           response_ciphertext, response_key_version
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'mini_program', $5, $6, $7::timestamptz, $8, $9, $10, $11)
         ON CONFLICT (tenant_id, store_id, app_id, idempotency_key_sha256)
           WHERE idempotency_key_sha256 IS NOT NULL DO NOTHING`,
        [
          challengeId,
          this.tenantId,
          this.storeId,
          this.appId,
          sha256Hex(record.challenge.state),
          sha256Hex(record.challenge.nonce),
          expiresAt,
          idempotencyHash,
          record.requestFingerprint,
          encrypted.ciphertext,
          encrypted.keyVersion,
        ],
      )
      const selected = await client.query<ChallengeReplayRow>(
        `/* wechat:challenge-replay-select */
         SELECT request_fingerprint, response_ciphertext, response_key_version
         FROM mbox.wechat_auth_challenges
         WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND app_id = $3
           AND idempotency_key_sha256 = $4
         FOR UPDATE`,
        [this.tenantId, this.storeId, this.appId, idempotencyHash],
      )
      const row = selected.rows[0]
      if (!row || row.request_fingerprint !== record.requestFingerprint) return { outcome: 'conflict' }
      const challenge = this.decryptJson<WechatIssuedChallengeRecord['challenge']>(
        row.response_ciphertext,
        row.response_key_version,
        'challenge-response',
        idempotencyHash,
      )
      return {
        outcome: rowCount(inserted) === 1 ? 'created' : 'replayed',
        record: { ...record, challenge },
      }
    })
  }

  async consume(challengeId: string, expiresAt: number, now: number) {
    if (!UUID_PATTERN.test(challengeId) || expiresAt <= now) return false
    return this.transaction(false, async (client) => {
      const result = await client.query(
        `/* wechat:challenge-consume */
         UPDATE mbox.wechat_auth_challenges
         SET consumed_at = $4::timestamptz
         WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
           AND consumed_at IS NULL AND expires_at > $4::timestamptz`,
        [this.tenantId, this.storeId, challengeId, new Date(now)],
      )
      return rowCount(result) === 1
    })
  }

  async cleanupExpired(now = new Date(), batchSize = DEFAULT_CLEANUP_BATCH_SIZE) {
    assertPositiveInteger(batchSize, 'WeChat cleanup batch size')
    return this.transaction(false, async (client) => {
      const result = await client.query(
        `/* wechat:challenge-cleanup */
         WITH expired AS (
           SELECT id FROM mbox.wechat_auth_challenges
           WHERE tenant_id = $1::uuid AND store_id = $2::uuid
             AND (expires_at <= $3::timestamptz OR consumed_at IS NOT NULL)
           ORDER BY expires_at LIMIT $4 FOR UPDATE SKIP LOCKED
         )
         DELETE FROM mbox.wechat_auth_challenges c USING expired
         WHERE c.tenant_id = $1::uuid AND c.store_id = $2::uuid AND c.id = expired.id`,
        [this.tenantId, this.storeId, now, batchSize],
      )
      return rowCount(result)
    })
  }
}

function toPrincipal(identity: WechatIdentityRecord): WechatAuthenticatedPrincipal {
  return {
    principalId: identity.principalId,
    identityId: identity.id,
    tenantId: identity.tenantId,
    storeId: identity.storeId,
    appId: identity.appId,
    memberId: identity.memberId,
    hasUnionId: identity.unionId !== null,
  }
}

export interface WechatMemberBindingGrantInput {
  memberId: string
  expiresAt: Date
  now?: Date
}

export interface WechatCleanupResult {
  sessions: number
  authenticationReplays: number
  mutationReplays: number
  memberBindingGrants: number
}

export class PostgresWechatIdentityRepository
  extends ScopedWechatPostgresRepository
  implements WechatApiIdentityRepository, WechatNotificationRecipientResolver {
  async resolveMiniProgramNotificationRecipient(
    customerId: string,
    identityExternalId: string,
  ): Promise<{ identityExternalId: string; openId: string } | null> {
    assertUuid(customerId, 'customerId')
    if (!identityExternalId.trim() || identityExternalId.length > 200) {
      throw new Error('identityExternalId is invalid')
    }
    return this.transaction(true, async (client) => {
      const result = await client.query<IdentityRow>(`
        SELECT identity.id,identity.external_identity_id,identity.principal_id,
          identity.tenant_id,identity.store_id,identity.app_id,
          identity.openid_sha256,identity.openid_ciphertext,identity.openid_key_version,
          identity.unionid_sha256,identity.unionid_ciphertext,identity.unionid_key_version,
          identity.member_id,identity.created_at,identity.updated_at,identity.last_authenticated_at
        FROM mbox.wechat_identities identity
        JOIN mbox.customer_identities customer_identity
          ON customer_identity.tenant_id=identity.tenant_id
         AND customer_identity.store_id=identity.store_id
         AND customer_identity.identity_kind='wechat'
         AND customer_identity.identity_hash=encode(digest('wechat:'||identity.principal_id,'sha256'),'hex')
         AND customer_identity.status='active'
        WHERE identity.tenant_id=$1::uuid AND identity.store_id=$2::uuid
          AND identity.app_id=$3 AND identity.channel='mini_program'
          AND identity.external_identity_id=$4 AND identity.revoked_at IS NULL
          AND customer_identity.customer_id=$5::uuid
        LIMIT 1
      `, [this.tenantId, this.storeId, this.appId, identityExternalId, customerId])
      const row = result.rows[0]
      if (!row) return null
      const identity = this.decodeIdentity(row)
      return { identityExternalId: identity.id, openId: identity.openId }
    })
  }

  async findByAppOpenId(tenantId: string, appId: string, openId: string) {
    this.assertTenant(tenantId)
    if (appId !== this.appId) throw new Error('Cross-application WeChat identity access rejected')
    const digest = sha256Hex(openId)
    return this.transaction(true, async (client) => {
      const result = await client.query<IdentityRow>(
        `/* wechat:identity-by-openid */ ${this.identitySelect()}
         WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND app_id = $3
           AND channel = 'mini_program' AND openid_sha256 = $4`,
        [this.tenantId, this.storeId, appId, digest],
      )
      return result.rows[0] ? this.decodeIdentity(result.rows[0]) : null
    })
  }

  async findByUnionId(tenantId: string, unionId: string) {
    this.assertTenant(tenantId)
    const digest = sha256Hex(unionId)
    return this.transaction(true, async (client) => {
      const result = await client.query<IdentityRow>(
        `/* wechat:identity-by-unionid */ ${this.identitySelect()}
         WHERE tenant_id = $1::uuid AND store_id = $2::uuid
           AND channel = 'mini_program' AND unionid_sha256 = $3`,
        [this.tenantId, this.storeId, digest],
      )
      return result.rows.map((row) => this.decodeIdentity(row))
    })
  }

  async findByPrincipalId(tenantId: string, principalId: string) {
    this.assertTenant(tenantId)
    return this.transaction(true, async (client) => {
      const result = await client.query<IdentityRow>(
        `/* wechat:identity-by-principal */ ${this.identitySelect()}
         WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND principal_id = $3
           AND channel = 'mini_program' AND revoked_at IS NULL`,
        [this.tenantId, this.storeId, principalId],
      )
      return result.rows.map((row) => this.decodeIdentity(row))
    })
  }

  async resolveRecipient(
    channel: WechatChannel,
    memberId: string,
    _templateCode: string,
  ): Promise<WechatProviderResult<WechatNotificationRecipient>> {
    const appId = this.options.notificationAppIds?.[channel]?.trim()
    if (!appId) {
      return {
        ok: false,
        failure: failure('configuration', 'NOTIFICATION_APP_ID_MISSING', '客户通知渠道缺少身份应用配置'),
      }
    }
    return this.transaction(true, async (client) => {
      const result = await client.query<IdentityRow>(
        `/* wechat:notification-recipient */
         SELECT identity.id, identity.external_identity_id, identity.principal_id,
                identity.tenant_id, identity.store_id, identity.app_id,
                identity.openid_sha256, identity.openid_ciphertext, identity.openid_key_version,
                identity.unionid_sha256, identity.unionid_ciphertext, identity.unionid_key_version,
                identity.member_id, identity.created_at, identity.updated_at, identity.last_authenticated_at
         FROM mbox.wechat_identities identity
         JOIN mbox.customer_members member
           ON member.tenant_id = identity.tenant_id
          AND member.store_id = identity.store_id
          AND member.id = identity.member_id
         WHERE identity.tenant_id = $1::uuid
           AND identity.store_id = $2::uuid
           AND identity.channel = $3
           AND identity.app_id = $4
           AND (member.id::text = $5 OR member.member_no = $5)
           AND member.status = 'active'
           AND member.notification_consent = true
           AND identity.revoked_at IS NULL
         ORDER BY identity.last_authenticated_at DESC
         LIMIT 1`,
        [this.tenantId, this.storeId, channel, appId, memberId],
      )
      const row = result.rows[0]
      if (!row) {
        return {
          ok: false,
          failure: failure('authorization', 'NOTIFICATION_RECIPIENT_NOT_BOUND', '会员未绑定可用通知身份或未授权通知'),
        }
      }
      const identity = this.decodeIdentity(row)
      return channel === 'service_account'
        ? { ok: true, value: { channel, openId: identity.openId } }
        : { ok: true, value: { channel, userId: identity.openId } }
    })
  }

  async save(identity: WechatIdentityRecord) {
    this.assertScope(identity)
    const openIdHash = sha256Hex(identity.openId)
    const unionIdHash = identity.unionId ? sha256Hex(identity.unionId) : null
    const openId = this.encryptJson(identity.openId, 'identity-openid', `${identity.appId}:${openIdHash}`)
    const unionId = identity.unionId && unionIdHash
      ? this.encryptJson(identity.unionId, 'identity-unionid', unionIdHash)
      : null
    await this.transaction(false, async (client) => {
      await client.query(
        `/* wechat:identity-save */
         INSERT INTO mbox.wechat_identities (
           tenant_id, store_id, external_identity_id, principal_type, principal_id,
           channel, app_id, openid_sha256, openid_ciphertext, openid_key_version,
           unionid_sha256, unionid_ciphertext, unionid_key_version, member_id,
           consent_version, consented_at, revoked_at, last_authenticated_at
         ) VALUES (
           $1::uuid, $2::uuid, $3, $4, $5, 'mini_program', $6, $7, $8, $9,
           $10, $11, $12, $13::uuid, $14, $15::timestamptz, NULL, $15::timestamptz
         )
         ON CONFLICT (tenant_id, store_id, channel, app_id, openid_sha256)
         DO UPDATE SET
           principal_type = EXCLUDED.principal_type,
           principal_id = EXCLUDED.principal_id,
           openid_ciphertext = EXCLUDED.openid_ciphertext,
           openid_key_version = EXCLUDED.openid_key_version,
           unionid_sha256 = EXCLUDED.unionid_sha256,
           unionid_ciphertext = EXCLUDED.unionid_ciphertext,
           unionid_key_version = EXCLUDED.unionid_key_version,
           member_id = EXCLUDED.member_id,
           consent_version = EXCLUDED.consent_version,
           consented_at = CASE WHEN mbox.wechat_identities.revoked_at IS NULL
             THEN mbox.wechat_identities.consented_at ELSE EXCLUDED.consented_at END,
           revoked_at = NULL,
           last_authenticated_at = EXCLUDED.last_authenticated_at,
           updated_at = clock_timestamp()`,
        [
          this.tenantId,
          this.storeId,
          identity.id,
          identity.memberId ? 'member' : 'guest',
          identity.principalId,
          identity.appId,
          openIdHash,
          openId.ciphertext,
          openId.keyVersion,
          unionIdHash,
          unionId?.ciphertext ?? null,
          unionId?.keyVersion ?? null,
          identity.memberId,
          this.consentVersion,
          asDate(identity.lastAuthenticatedAt),
        ],
      )
    })
  }

  async findAuthenticationReplay(scope: WechatApplicationScope, idempotencyKey: string) {
    this.assertScope(scope)
    const digest = sha256Hex(idempotencyKey)
    return this.transaction(true, async (client) => {
      const result = await client.query<AuthenticationReplayRow>(
        `/* wechat:authentication-replay-find */
         SELECT request_fingerprint, response_ciphertext, response_key_version
         FROM mbox.wechat_authentication_replays
         WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND app_id = $3
           AND idempotency_key_sha256 = $4 AND expires_at > clock_timestamp()`,
        [this.tenantId, this.storeId, this.appId, digest],
      )
      const row = result.rows[0]
      if (!row) return null
      const response = this.decryptJson<WechatCodeAuthenticationResponse>(
        row.response_ciphertext,
        row.response_key_version,
        'authentication-response',
        digest,
      )
      return { ...scope, idempotencyKey, requestFingerprint: row.request_fingerprint, response }
    })
  }

  async completeAuthentication(input: {
    replay: WechatAuthenticationReplayRecord
    session: WechatApiSessionRecord
  }): Promise<WechatAuthenticationCommitResult> {
    this.assertScope(input.replay)
    assertSha256Base64Url(input.session.accessTokenHash, 'accessTokenHash')
    const idempotencyHash = sha256Hex(input.replay.idempotencyKey)
    const response = this.encryptJson(input.replay.response, 'authentication-response', idempotencyHash)
    const principal = this.encryptJson(input.session.principal, 'session-principal', input.session.accessTokenHash)
    return this.transaction(false, async (client) => {
      const inserted = await client.query(
        `/* wechat:authentication-replay-insert */
         INSERT INTO mbox.wechat_authentication_replays (
           tenant_id, store_id, app_id, idempotency_key_sha256, request_fingerprint,
           identity_external_id, principal_id, response_ciphertext, response_key_version, expires_at
         ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz)
         ON CONFLICT (tenant_id, store_id, app_id, idempotency_key_sha256) DO NOTHING`,
        [
          this.tenantId,
          this.storeId,
          this.appId,
          idempotencyHash,
          input.replay.requestFingerprint,
          input.session.principal.identityId,
          input.session.principal.principalId,
          response.ciphertext,
          response.keyVersion,
          asDate(input.replay.response.expiresAt),
        ],
      )
      const selected = await client.query<AuthenticationReplayRow>(
        `/* wechat:authentication-replay-select */
         SELECT request_fingerprint, response_ciphertext, response_key_version
         FROM mbox.wechat_authentication_replays
         WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND app_id = $3
           AND idempotency_key_sha256 = $4 FOR UPDATE`,
        [this.tenantId, this.storeId, this.appId, idempotencyHash],
      )
      const row = selected.rows[0]
      if (!row || row.request_fingerprint !== input.replay.requestFingerprint) return { outcome: 'conflict' }
      if (rowCount(inserted) === 1) {
        await client.query(
          `/* wechat:session-insert */
           INSERT INTO mbox.wechat_identity_sessions (
             tenant_id, store_id, app_id, identity_external_id, principal_id,
             access_token_sha256, principal_ciphertext, principal_key_version,
             issued_at, expires_at, revoked_at
           ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10::timestamptz, $11::timestamptz)`,
          [
            this.tenantId,
            this.storeId,
            this.appId,
            input.session.principal.identityId,
            input.session.principal.principalId,
            input.session.accessTokenHash,
            principal.ciphertext,
            principal.keyVersion,
            new Date(input.session.issuedAt),
            new Date(input.session.expiresAt),
            input.session.revokedAt === null ? null : new Date(input.session.revokedAt),
          ],
        )
        return { outcome: 'created', record: input.replay }
      }
      const replayedResponse = this.decryptJson<WechatCodeAuthenticationResponse>(
        row.response_ciphertext,
        row.response_key_version,
        'authentication-response',
        idempotencyHash,
      )
      return { outcome: 'replayed', record: { ...input.replay, response: replayedResponse } }
    })
  }

  async findSession(accessTokenHash: string) {
    assertSha256Base64Url(accessTokenHash, 'accessTokenHash')
    return this.transaction(true, async (client) => {
      const result = await client.query<SessionRow>(
        `/* wechat:session-find */
         SELECT access_token_sha256, principal_ciphertext, principal_key_version,
                issued_at, expires_at, revoked_at
         FROM mbox.wechat_identity_sessions
         WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND access_token_sha256 = $3`,
        [this.tenantId, this.storeId, accessTokenHash],
      )
      return result.rows[0] ? this.decodeSession(result.rows[0]) : null
    })
  }

  async issueMemberBindingGrant(input: WechatMemberBindingGrantInput) {
    assertUuid(input.memberId, 'memberId')
    const now = input.now ?? new Date()
    if (input.expiresAt.getTime() <= now.getTime()) throw new Error('Member binding grant expiry must be in the future')
    const token = this.random(32).toString('base64url')
    const tokenHash = sha256Base64Url(token)
    await this.transaction(false, async (client) => {
      await client.query(
        `/* wechat:member-grant-insert */
         INSERT INTO mbox.wechat_member_binding_grants (
           tenant_id, store_id, member_id, grant_token_sha256, expires_at
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::timestamptz)`,
        [this.tenantId, this.storeId, input.memberId, tokenHash, input.expiresAt],
      )
    })
    return token
  }

  async bindMemberWithGrant(input: {
    tenantId: string
    storeId: string
    principalId: string
    memberId: string
    grantTokenHash: string
    now: number
  }): Promise<WechatProviderResult<WechatAuthenticatedPrincipal>> {
    this.assertScope(input)
    assertSha256Base64Url(input.grantTokenHash, 'grantTokenHash')
    return this.transaction(false, async (client) => {
      const grantResult = await client.query<GrantRow>(
        `/* wechat:member-grant-select */
         SELECT member_id, expires_at, consumed_at
         FROM mbox.wechat_member_binding_grants
         WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND grant_token_sha256 = $3
         FOR UPDATE`,
        [this.tenantId, this.storeId, input.grantTokenHash],
      )
      const grant = grantResult.rows[0]
      if (!grant || grant.consumed_at !== null) {
        return { ok: false, failure: failure('authentication', 'MEMBER_BINDING_GRANT_INVALID', '会员绑定凭证无效或已使用') }
      }
      if (asDate(grant.expires_at).getTime() <= input.now) {
        return { ok: false, failure: failure('expired', 'MEMBER_BINDING_GRANT_EXPIRED', '会员绑定凭证已过期') }
      }
      if (grant.member_id !== input.memberId) {
        return { ok: false, failure: failure('authorization', 'MEMBER_BINDING_SCOPE_MISMATCH', '会员绑定凭证不属于当前租户、门店或会员') }
      }
      const identities = await this.selectPrincipalIdentities(client, input.principalId, true)
      if (!identities.length) {
        return { ok: false, failure: failure('provider_rejection', 'WECHAT_PRINCIPAL_NOT_FOUND', '微信主体不存在') }
      }
      if (identities.some((identity) => identity.memberId && identity.memberId !== input.memberId)) {
        return { ok: false, failure: failure('identity_conflict', 'WECHAT_IDENTITY_CONFLICT', '微信主体已关联其他会员') }
      }
      await client.query(
        `/* wechat:identity-bind-member */
         UPDATE mbox.wechat_identities
         SET member_id = $4::uuid, principal_type = 'member', last_authenticated_at = $5::timestamptz
         WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND principal_id = $3 AND revoked_at IS NULL`,
        [this.tenantId, this.storeId, input.principalId, input.memberId, new Date(input.now)],
      )
      await this.updateSessionPrincipals(client, input.principalId, (principal) => ({ ...principal, memberId: input.memberId }))
      await client.query(
        `/* wechat:member-grant-consume */
         UPDATE mbox.wechat_member_binding_grants
         SET consumed_at = $4::timestamptz, consumed_by_principal_id = $5
         WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND grant_token_sha256 = $3`,
        [this.tenantId, this.storeId, input.grantTokenHash, new Date(input.now), input.principalId],
      )
      return { ok: true, value: { ...toPrincipal(identities[0]!), memberId: input.memberId } }
    })
  }

  async logoutSession(input: WechatIdentityMutationInput & { accessTokenHash: string }) {
    this.assertScope(input)
    assertSha256Base64Url(input.accessTokenHash, 'accessTokenHash')
    return this.mutateIdempotently<{ replayed: boolean }>('logout', input, async (client) => {
      const updated = await client.query(
        `/* wechat:session-logout */
         UPDATE mbox.wechat_identity_sessions
         SET revoked_at = $5::timestamptz, revocation_reason = 'logout'
         WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND principal_id = $3
           AND access_token_sha256 = $4 AND revoked_at IS NULL`,
        [this.tenantId, this.storeId, input.principalId, input.accessTokenHash, new Date(input.now)],
      )
      if (rowCount(updated) !== 1) {
        return { ok: false, failure: failure('authentication', 'WECHAT_SESSION_INVALID', '微信身份会话无效或已退出') }
      }
      return { ok: true, value: { replayed: false } }
    })
  }

  async unbindMember(input: WechatIdentityMutationInput) {
    this.assertScope(input)
    return this.mutateIdempotently<{ principal: WechatAuthenticatedPrincipal; replayed: boolean }>('unbind', input, async (client) => {
      const identities = await this.selectPrincipalIdentities(client, input.principalId, true)
      if (!identities.length) {
        return { ok: false, failure: failure('provider_rejection', 'WECHAT_PRINCIPAL_NOT_FOUND', '微信主体不存在') }
      }
      await client.query(
        `/* wechat:identity-unbind-member */
         UPDATE mbox.wechat_identities
         SET member_id = NULL, principal_type = 'guest'
         WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND principal_id = $3 AND revoked_at IS NULL`,
        [this.tenantId, this.storeId, input.principalId],
      )
      await this.updateSessionPrincipals(client, input.principalId, (principal) => ({ ...principal, memberId: null }))
      await this.deleteAuthenticationReplays(client, input.principalId)
      return { ok: true, value: { principal: { ...toPrincipal(identities[0]!), memberId: null }, replayed: false } }
    })
  }

  async revokeAuthorization(input: WechatIdentityMutationInput) {
    this.assertScope(input)
    return this.mutateIdempotently<{ replayed: boolean }>('revoke', input, async (client) => {
      const identities = await this.selectPrincipalIdentities(client, input.principalId, false)
      if (!identities.length) {
        return { ok: false, failure: failure('provider_rejection', 'WECHAT_PRINCIPAL_NOT_FOUND', '微信主体不存在') }
      }
      await client.query(
        `/* wechat:identity-revoke */
         UPDATE mbox.wechat_identities
         SET revoked_at = COALESCE(revoked_at, $4::timestamptz), member_id = NULL
         WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND principal_id = $3`,
        [this.tenantId, this.storeId, input.principalId, new Date(input.now)],
      )
      await client.query(
        `/* wechat:sessions-revoke-all */
         UPDATE mbox.wechat_identity_sessions
         SET revoked_at = $4::timestamptz, revocation_reason = 'authorization_revoked'
         WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND principal_id = $3 AND revoked_at IS NULL`,
        [this.tenantId, this.storeId, input.principalId, new Date(input.now)],
      )
      await this.deleteAuthenticationReplays(client, input.principalId)
      return { ok: true, value: { replayed: false } }
    })
  }

  async cleanupExpired(now = new Date(), batchSize = DEFAULT_CLEANUP_BATCH_SIZE): Promise<WechatCleanupResult> {
    assertPositiveInteger(batchSize, 'WeChat cleanup batch size')
    const revokedBefore = new Date(now.getTime() - this.revokedSessionRetentionMs)
    return this.transaction(false, async (client) => {
      const sessions = await client.query(
        `/* wechat:session-cleanup */
         WITH expired AS (
           SELECT id FROM mbox.wechat_identity_sessions
           WHERE tenant_id = $1::uuid AND store_id = $2::uuid
             AND (expires_at <= $3::timestamptz OR revoked_at <= $4::timestamptz)
           ORDER BY expires_at LIMIT $5 FOR UPDATE SKIP LOCKED
         ) DELETE FROM mbox.wechat_identity_sessions s USING expired
           WHERE s.tenant_id = $1::uuid AND s.store_id = $2::uuid AND s.id = expired.id`,
        [this.tenantId, this.storeId, now, revokedBefore, batchSize],
      )
      const authenticationReplays = await this.cleanupTable(client, 'wechat_authentication_replays', now, batchSize)
      const mutationReplays = await this.cleanupTable(client, 'wechat_identity_mutation_replays', now, batchSize)
      const memberBindingGrants = await this.cleanupTable(client, 'wechat_member_binding_grants', now, batchSize)
      return {
        sessions: rowCount(sessions),
        authenticationReplays,
        mutationReplays,
        memberBindingGrants,
      }
    })
  }

  private identitySelect() {
    return `SELECT id, external_identity_id, principal_id, tenant_id, store_id, app_id,
                   openid_sha256, openid_ciphertext, openid_key_version,
                   unionid_sha256, unionid_ciphertext, unionid_key_version,
                   member_id, created_at, updated_at, last_authenticated_at
            FROM mbox.wechat_identities`
  }

  private decodeIdentity(row: IdentityRow): WechatIdentityRecord {
    const openId = this.decryptJson<string>(
      row.openid_ciphertext,
      row.openid_key_version,
      'identity-openid',
      `${row.app_id}:${row.openid_sha256.trim()}`,
    )
    const unionId = row.unionid_sha256 && row.unionid_ciphertext && row.unionid_key_version !== null
      ? this.decryptJson<string>(row.unionid_ciphertext, row.unionid_key_version, 'identity-unionid', row.unionid_sha256.trim())
      : null
    return {
      id: row.external_identity_id,
      principalId: row.principal_id,
      tenantId: row.tenant_id,
      storeId: row.store_id,
      appId: row.app_id,
      openId,
      unionId,
      memberId: row.member_id,
      createdAt: asDate(row.created_at).toISOString(),
      lastAuthenticatedAt: asDate(row.last_authenticated_at ?? row.updated_at).toISOString(),
    }
  }

  private decodeSession(row: SessionRow): WechatApiSessionRecord {
    return {
      accessTokenHash: row.access_token_sha256,
      principal: this.decryptJson<WechatAuthenticatedPrincipal>(
        row.principal_ciphertext,
        row.principal_key_version,
        'session-principal',
        row.access_token_sha256,
      ),
      issuedAt: asDate(row.issued_at).getTime(),
      expiresAt: asDate(row.expires_at).getTime(),
      revokedAt: row.revoked_at === null ? null : asDate(row.revoked_at).getTime(),
    }
  }

  private async selectPrincipalIdentities(client: PostgresPoolClient, principalId: string, activeOnly: boolean) {
    const result = await client.query<IdentityRow>(
      `/* wechat:identity-principal-for-update */ ${this.identitySelect()}
       WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND principal_id = $3
         ${activeOnly ? 'AND revoked_at IS NULL' : ''}
       FOR UPDATE`,
      [this.tenantId, this.storeId, principalId],
    )
    return result.rows.map((row) => this.decodeIdentity(row))
  }

  private async updateSessionPrincipals(
    client: PostgresPoolClient,
    principalId: string,
    update: (principal: WechatAuthenticatedPrincipal) => WechatAuthenticatedPrincipal,
  ) {
    const sessions = await client.query<SessionRow>(
      `/* wechat:sessions-for-principal */
       SELECT access_token_sha256, principal_ciphertext, principal_key_version,
              issued_at, expires_at, revoked_at
       FROM mbox.wechat_identity_sessions
       WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND principal_id = $3 AND revoked_at IS NULL
       FOR UPDATE`,
      [this.tenantId, this.storeId, principalId],
    )
    for (const row of sessions.rows) {
      const principal = this.decodeSession(row).principal
      const encrypted = this.encryptJson(update(principal), 'session-principal', row.access_token_sha256)
      await client.query(
        `/* wechat:session-principal-update */
         UPDATE mbox.wechat_identity_sessions
         SET principal_ciphertext = $4, principal_key_version = $5
         WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND access_token_sha256 = $3`,
        [this.tenantId, this.storeId, row.access_token_sha256, encrypted.ciphertext, encrypted.keyVersion],
      )
    }
  }

  private async deleteAuthenticationReplays(client: PostgresPoolClient, principalId: string) {
    await client.query(
      `/* wechat:authentication-replay-delete-principal */
       DELETE FROM mbox.wechat_authentication_replays
       WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND principal_id = $3`,
      [this.tenantId, this.storeId, principalId],
    )
  }

  private async mutateIdempotently<T extends object>(
    operation: 'logout' | 'unbind' | 'revoke',
    input: WechatIdentityMutationInput,
    mutation: (client: PostgresPoolClient) => Promise<WechatProviderResult<T>>,
  ): Promise<WechatProviderResult<T>> {
    const idempotencyHash = sha256Hex(input.idempotencyKey)
    const reference = `${operation}:${input.principalId}:${idempotencyHash}`
    return this.transaction(false, async (client) => {
      await client.query(
        `/* wechat:mutation-advisory-lock */ SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [`${this.tenantId}:${this.storeId}:${reference}`],
      )
      const previous = await client.query<MutationReplayRow>(
        `/* wechat:mutation-replay-select */
         SELECT request_fingerprint, result_ciphertext, result_key_version
         FROM mbox.wechat_identity_mutation_replays
         WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND operation = $3
           AND principal_id = $4 AND idempotency_key_sha256 = $5
           AND expires_at > clock_timestamp()
         FOR UPDATE`,
        [this.tenantId, this.storeId, operation, input.principalId, idempotencyHash],
      )
      const row = previous.rows[0]
      if (row) {
        if (row.request_fingerprint !== input.requestFingerprint) {
          return { ok: false, failure: failure('replay', 'IDEMPOTENCY_KEY_REUSED', '幂等键已用于不同请求') }
        }
        const result = this.decryptJson<WechatProviderResult<T>>(
          row.result_ciphertext,
          row.result_key_version,
          'mutation-result',
          reference,
        )
        return result.ok ? { ok: true, value: { ...result.value, replayed: true } } : result
      }

      const result = await mutation(client)
      const encrypted = this.encryptJson(result, 'mutation-result', reference)
      await client.query(
        `/* wechat:mutation-replay-insert */
         INSERT INTO mbox.wechat_identity_mutation_replays (
           tenant_id, store_id, operation, principal_id, idempotency_key_sha256,
           request_fingerprint, result_ciphertext, result_key_version, expires_at
         ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9::timestamptz)`,
        [
          this.tenantId,
          this.storeId,
          operation,
          input.principalId,
          idempotencyHash,
          input.requestFingerprint,
          encrypted.ciphertext,
          encrypted.keyVersion,
          new Date(input.now + this.mutationReplayTtlMs),
        ],
      )
      return result
    })
  }

  private async cleanupTable(client: PostgresPoolClient, table: string, now: Date, batchSize: number) {
    const allowed = new Set([
      'wechat_authentication_replays',
      'wechat_identity_mutation_replays',
      'wechat_member_binding_grants',
    ])
    if (!allowed.has(table)) throw new Error('Invalid WeChat cleanup table')
    const result = await client.query(
      `/* wechat:${table}-cleanup */
       WITH expired AS (
         SELECT id FROM mbox.${table}
         WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND expires_at <= $3::timestamptz
         ORDER BY expires_at LIMIT $4 FOR UPDATE SKIP LOCKED
       ) DELETE FROM mbox.${table} target USING expired
         WHERE target.tenant_id = $1::uuid AND target.store_id = $2::uuid AND target.id = expired.id`,
      [this.tenantId, this.storeId, now, batchSize],
    )
    return rowCount(result)
  }
}
