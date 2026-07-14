import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type {
  MiniProgramAuthenticationInput,
  MiniProgramAuthenticationResult,
  MiniProgramCodeSessionProvider,
  WechatAuthenticatedPrincipal,
  WechatFailure,
  WechatIdentityRecord,
  WechatLoginChallenge,
  WechatLoginChallengeClaims,
  WechatProviderResult,
} from '../src/shared/wechat-contracts.js'
import { miniProgramAuthenticationSchema } from '../src/shared/wechat-contracts.js'

const DEFAULT_CHALLENGE_TTL_MS = 5 * 60_000
const DEFAULT_SESSION_TTL_MS = 2 * 60 * 60_000
const MAX_CLOCK_SKEW_MS = 60_000

export interface WechatLoginChallengeInput {
  tenantId: string
  storeId: string
  appId: string
}

export interface CreateWechatLoginChallengeOptions {
  ttlMs?: number
  now?: number
}

export interface WechatChallengeStore {
  consume(challengeId: string, expiresAt: number, now: number): Promise<boolean>
}

export interface WechatIdentityRepository {
  findByAppOpenId(tenantId: string, appId: string, openId: string): Promise<WechatIdentityRecord | null>
  findByUnionId(tenantId: string, unionId: string): Promise<WechatIdentityRecord[]>
  findByPrincipalId(tenantId: string, principalId: string): Promise<WechatIdentityRecord[]>
  save(identity: WechatIdentityRecord): Promise<void>
}

export interface WechatIdentityServiceOptions {
  provider: MiniProgramCodeSessionProvider
  repository: WechatIdentityRepository
  challengeStore: WechatChallengeStore
  stateSecret: string
  sessionTtlMs?: number
  now?: () => number
}

function failure(
  classification: WechatFailure['classification'],
  code: string,
  message: string,
  retryable: boolean,
): WechatFailure {
  return { classification, code, message, retryable }
}

function hash(value: string) {
  return createHash('sha256').update(value).digest('base64url')
}

function encode(value: object) {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function signature(payload: string, secret: string) {
  return createHmac('sha256', secret).update(payload).digest('base64url')
}

function assertSecret(secret: string) {
  if (secret.length < 32) throw new Error('微信登录state密钥至少需要32个字符')
}

function validPositiveInteger(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name}必须是正整数`)
}

export function createWechatLoginChallenge(
  input: WechatLoginChallengeInput,
  secret: string,
  options: CreateWechatLoginChallengeOptions = {},
): WechatLoginChallenge {
  assertSecret(secret)
  const now = options.now ?? Date.now()
  const ttlMs = options.ttlMs ?? DEFAULT_CHALLENGE_TTL_MS
  validPositiveInteger(ttlMs, '微信登录挑战有效期')
  if (!input.tenantId.trim() || !input.storeId.trim() || !input.appId.trim()) {
    throw new Error('微信登录挑战缺少租户、门店或应用标识')
  }
  const nonce = randomBytes(24).toString('base64url')
  const claims: WechatLoginChallengeClaims = {
    version: 1,
    challengeId: randomUUID(),
    tenantId: input.tenantId,
    storeId: input.storeId,
    appId: input.appId,
    nonceHash: hash(nonce),
    issuedAt: now,
    expiresAt: now + ttlMs,
  }
  const payload = encode(claims)
  return {
    state: `${payload}.${signature(payload, secret)}`,
    nonce,
    expiresAt: new Date(claims.expiresAt).toISOString(),
  }
}

function stateFailure(code: string, message: string, classification: WechatFailure['classification'] = 'validation') {
  return { ok: false, failure: failure(classification, code, message, false) } as const
}

export function verifyWechatLoginChallenge(
  state: string,
  nonce: string,
  secret: string,
  now = Date.now(),
): WechatProviderResult<WechatLoginChallengeClaims> {
  try {
    assertSecret(secret)
  } catch (error) {
    return stateFailure('STATE_SECRET_INVALID', error instanceof Error ? error.message : 'state密钥无效', 'configuration')
  }
  const [payload, suppliedSignature, extra] = state.split('.')
  if (!payload || !suppliedSignature || extra) return stateFailure('STATE_FORMAT_INVALID', '微信登录state格式无效')
  const expected = Buffer.from(signature(payload, secret))
  const supplied = Buffer.from(suppliedSignature)
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    return stateFailure('STATE_SIGNATURE_INVALID', '微信登录state签名无效', 'authentication')
  }

  let claims: WechatLoginChallengeClaims
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as WechatLoginChallengeClaims
  } catch {
    return stateFailure('STATE_PAYLOAD_INVALID', '微信登录state载荷无效')
  }
  if (
    claims.version !== 1
    || !claims.challengeId
    || !claims.tenantId
    || !claims.storeId
    || !claims.appId
    || !claims.nonceHash
    || !Number.isSafeInteger(claims.issuedAt)
    || !Number.isSafeInteger(claims.expiresAt)
  ) {
    return stateFailure('STATE_CLAIMS_INVALID', '微信登录state声明无效')
  }
  if (claims.issuedAt > now + MAX_CLOCK_SKEW_MS) {
    return stateFailure('STATE_ISSUED_AT_INVALID', '微信登录state签发时间异常', 'authentication')
  }
  if (claims.expiresAt <= now) return stateFailure('STATE_EXPIRED', '微信登录state已过期', 'expired')
  const expectedNonce = Buffer.from(claims.nonceHash)
  const suppliedNonce = Buffer.from(hash(nonce))
  if (expectedNonce.length !== suppliedNonce.length || !timingSafeEqual(expectedNonce, suppliedNonce)) {
    return stateFailure('NONCE_MISMATCH', '微信登录nonce不匹配', 'authentication')
  }
  return { ok: true, value: claims }
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

function identityConflict(message: string): WechatProviderResult<never> {
  return { ok: false, failure: failure('identity_conflict', 'WECHAT_IDENTITY_CONFLICT', message, false) }
}

export class WechatIdentityService {
  private readonly now: () => number
  private readonly sessionTtlMs: number

  constructor(private readonly options: WechatIdentityServiceOptions) {
    assertSecret(options.stateSecret)
    this.now = options.now ?? Date.now
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS
    validPositiveInteger(this.sessionTtlMs, '微信会话有效期')
  }

  async authenticateMiniProgram(rawInput: MiniProgramAuthenticationInput): Promise<MiniProgramAuthenticationResult> {
    const parsed = miniProgramAuthenticationSchema.safeParse(rawInput)
    if (!parsed.success) {
      return { outcome: 'failed', failure: failure('validation', 'LOGIN_INPUT_INVALID', parsed.error.issues[0]?.message ?? '微信登录参数无效', false) }
    }
    const input = parsed.data
    const now = this.now()
    const verified = verifyWechatLoginChallenge(input.state, input.nonce, this.options.stateSecret, now)
    if (!verified.ok) return { outcome: 'failed', failure: verified.failure }
    const claims = verified.value
    if (claims.tenantId !== input.tenantId || claims.storeId !== input.storeId || claims.appId !== input.appId) {
      return { outcome: 'failed', failure: failure('authorization', 'STATE_SCOPE_MISMATCH', '微信登录state不属于当前租户、门店或应用', false) }
    }
    let consumed
    try {
      consumed = await this.options.challengeStore.consume(claims.challengeId, claims.expiresAt, now)
    } catch (error) {
      return {
        outcome: 'failed',
        failure: failure('transient', 'CHALLENGE_STORE_UNAVAILABLE', error instanceof Error ? error.message : '微信挑战存储不可用', true),
      }
    }
    if (!consumed) {
      return { outcome: 'failed', failure: failure('replay', 'LOGIN_CHALLENGE_REPLAYED', '微信登录挑战已使用或失效', false) }
    }

    let exchanged
    try {
      exchanged = await this.options.provider.exchangeCode({ appId: input.appId, code: input.code })
    } catch (error) {
      return {
        outcome: 'failed',
        failure: failure('transient', 'CODE_EXCHANGE_EXCEPTION', error instanceof Error ? error.message : '微信code换取session发生未知异常', true),
      }
    }
    if (!exchanged.ok) return { outcome: 'failed', failure: exchanged.failure }
    const session = exchanged.value
    if (!session.openId.trim() || !session.sessionKey.trim()) {
      return { outcome: 'failed', failure: failure('provider_rejection', 'INVALID_CODE_SESSION', '微信供应商未返回完整会话证据', false) }
    }

    let resolved: WechatProviderResult<WechatIdentityRecord>
    try {
      resolved = await this.resolveIdentity(input, session.openId.trim(), session.unionId?.trim() || null, now)
    } catch (error) {
      return {
        outcome: 'failed',
        failure: failure('transient', 'IDENTITY_STORE_UNAVAILABLE', error instanceof Error ? error.message : '微信身份存储不可用', true),
      }
    }
    if (!resolved.ok) return { outcome: 'failed', failure: resolved.failure }
    return {
      outcome: 'authenticated',
      principal: toPrincipal(resolved.value),
      sessionKey: session.sessionKey,
      sessionExpiresAt: new Date(now + this.sessionTtlMs).toISOString(),
      ...(session.providerRequestId ? { providerRequestId: session.providerRequestId } : {}),
    }
  }

  async associateMember(
    tenantId: string,
    principalId: string,
    memberId: string,
    now = this.now(),
  ): Promise<WechatProviderResult<WechatAuthenticatedPrincipal>> {
    if (!tenantId.trim() || !principalId.trim() || !memberId.trim()) {
      return { ok: false, failure: failure('validation', 'MEMBER_ASSOCIATION_INVALID', '会员关联参数无效', false) }
    }
    let identities: WechatIdentityRecord[]
    try {
      identities = await this.options.repository.findByPrincipalId(tenantId, principalId)
    } catch (error) {
      return { ok: false, failure: failure('transient', 'IDENTITY_STORE_UNAVAILABLE', error instanceof Error ? error.message : '微信身份存储不可用', true) }
    }
    if (identities.length === 0) {
      return { ok: false, failure: failure('provider_rejection', 'WECHAT_PRINCIPAL_NOT_FOUND', '微信主体不存在', false) }
    }
    if (identities.some((identity) => identity.memberId && identity.memberId !== memberId)) {
      return identityConflict('微信主体已关联其他会员')
    }
    try {
      for (const identity of identities) {
        await this.options.repository.save({ ...identity, memberId, lastAuthenticatedAt: new Date(now).toISOString() })
      }
    } catch (error) {
      return { ok: false, failure: failure('transient', 'IDENTITY_STORE_UNAVAILABLE', error instanceof Error ? error.message : '微信身份存储不可用', true) }
    }
    return { ok: true, value: { ...toPrincipal(identities[0]!), memberId } }
  }

  private async resolveIdentity(
    input: Pick<MiniProgramAuthenticationInput, 'tenantId' | 'storeId' | 'appId'>,
    openId: string,
    unionId: string | null,
    now: number,
  ): Promise<WechatProviderResult<WechatIdentityRecord>> {
    const existing = await this.options.repository.findByAppOpenId(input.tenantId, input.appId, openId)
    if (existing?.unionId && unionId && existing.unionId !== unionId) {
      return identityConflict('同一OpenID返回了不同UnionID')
    }
    const effectiveUnionId = unionId ?? existing?.unionId ?? null
    const unionMatches = effectiveUnionId
      ? await this.options.repository.findByUnionId(input.tenantId, effectiveUnionId)
      : []
    const principalIds = new Set(unionMatches.map((identity) => identity.principalId))
    const memberIds = new Set(unionMatches.flatMap((identity) => identity.memberId ? [identity.memberId] : []))
    if (principalIds.size > 1 || memberIds.size > 1) return identityConflict('UnionID对应多个冲突主体或会员')
    if (existing && principalIds.size === 1 && !principalIds.has(existing.principalId)) {
      return identityConflict('OpenID主体与UnionID主体不一致')
    }

    const timestamp = new Date(now).toISOString()
    const identity: WechatIdentityRecord = existing
      ? { ...existing, unionId: effectiveUnionId, memberId: existing.memberId ?? unionMatches[0]?.memberId ?? null, lastAuthenticatedAt: timestamp }
      : {
          id: `wechat_identity_${randomUUID()}`,
          principalId: unionMatches[0]?.principalId ?? `wechat_principal_${randomUUID()}`,
          tenantId: input.tenantId,
          storeId: input.storeId,
          appId: input.appId,
          openId,
          unionId: effectiveUnionId,
          memberId: unionMatches[0]?.memberId ?? null,
          createdAt: timestamp,
          lastAuthenticatedAt: timestamp,
        }
    await this.options.repository.save(identity)
    return { ok: true, value: identity }
  }
}

export class InMemoryWechatIdentityStore implements WechatChallengeStore, WechatIdentityRepository {
  private readonly consumedChallenges = new Map<string, number>()
  private readonly identities = new Map<string, WechatIdentityRecord>()

  async consume(challengeId: string, expiresAt: number, now: number) {
    for (const [id, expiry] of this.consumedChallenges) {
      if (expiry <= now) this.consumedChallenges.delete(id)
    }
    if (expiresAt <= now || this.consumedChallenges.has(challengeId)) return false
    this.consumedChallenges.set(challengeId, expiresAt)
    return true
  }

  async findByAppOpenId(tenantId: string, appId: string, openId: string) {
    return [...this.identities.values()].find((identity) => (
      identity.tenantId === tenantId && identity.appId === appId && identity.openId === openId
    )) ?? null
  }

  async findByUnionId(tenantId: string, unionId: string) {
    return [...this.identities.values()].filter((identity) => identity.tenantId === tenantId && identity.unionId === unionId)
  }

  async findByPrincipalId(tenantId: string, principalId: string) {
    return [...this.identities.values()].filter((identity) => identity.tenantId === tenantId && identity.principalId === principalId)
  }

  async save(identity: WechatIdentityRecord) {
    const duplicate = await this.findByAppOpenId(identity.tenantId, identity.appId, identity.openId)
    if (duplicate && duplicate.id !== identity.id) throw new Error('微信OpenID唯一约束冲突')
    this.identities.set(identity.id, { ...identity })
  }
}
