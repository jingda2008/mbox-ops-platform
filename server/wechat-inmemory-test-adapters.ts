import { createHash, randomBytes } from 'node:crypto'
import type {
  MiniProgramCodeSession,
  MiniProgramCodeSessionProvider,
  MiniProgramCodeSessionRequest,
  WechatAuthenticatedPrincipal,
  WechatFailure,
  WechatIdentityRecord,
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
  WechatIdentityMutationInput,
  WechatIssuedChallengeRecord,
} from './wechat-api.js'

function failure(
  classification: WechatFailure['classification'],
  code: string,
  message: string,
  retryable = false,
): WechatFailure {
  return { classification, code, message, retryable }
}

function scopeKey(scope: WechatApplicationScope) {
  return `${scope.tenantId}\u0000${scope.storeId}\u0000${scope.appId}`
}

function challengeKey(record: Pick<WechatIssuedChallengeRecord, 'tenantId' | 'storeId' | 'appId' | 'idempotencyKey'>) {
  return `${scopeKey(record)}\u0000${record.idempotencyKey}`
}

function replayKey(scope: WechatApplicationScope, idempotencyKey: string) {
  return `${scopeKey(scope)}\u0000${idempotencyKey}`
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

export class InMemoryWechatChallengeRepository implements WechatApiChallengeRepository {
  private readonly issued = new Map<string, WechatIssuedChallengeRecord>()
  private readonly consumed = new Map<string, number>()

  async issue(record: WechatIssuedChallengeRecord): Promise<WechatChallengeIssueResult> {
    const key = challengeKey(record)
    const existing = this.issued.get(key)
    if (existing) {
      if (existing.requestFingerprint !== record.requestFingerprint) return { outcome: 'conflict' }
      return { outcome: 'replayed', record: structuredClone(existing) }
    }
    this.issued.set(key, structuredClone(record))
    return { outcome: 'created', record: structuredClone(record) }
  }

  async consume(challengeId: string, expiresAt: number, now: number) {
    for (const [id, expiry] of this.consumed) {
      if (expiry <= now) this.consumed.delete(id)
    }
    if (expiresAt <= now || this.consumed.has(challengeId)) return false
    this.consumed.set(challengeId, expiresAt)
    return true
  }
}

interface MemberBindingGrant {
  tokenHash: string
  tenantId: string
  storeId: string
  memberId: string
  expiresAt: number
  consumedAt: number | null
}

interface StoredMutation<T extends object> {
  fingerprint: string
  result: WechatProviderResult<T>
}

export class InMemoryWechatApiIdentityRepository implements WechatApiIdentityRepository {
  private readonly identities = new Map<string, WechatIdentityRecord>()
  private readonly sessions = new Map<string, WechatApiSessionRecord>()
  private readonly authenticationReplays = new Map<string, WechatAuthenticationReplayRecord>()
  private readonly bindingGrants = new Map<string, MemberBindingGrant>()
  private readonly mutations = new Map<string, StoredMutation<object>>()

  issueMemberBindingGrant(input: { tenantId: string; storeId: string; memberId: string; expiresAt: number }) {
    const token = randomBytes(24).toString('base64url')
    const tokenHash = this.hash(token)
    this.bindingGrants.set(tokenHash, { tokenHash, ...input, consumedAt: null })
    return token
  }

  async findByAppOpenId(tenantId: string, appId: string, openId: string) {
    const identity = [...this.identities.values()].find((candidate) => (
      candidate.tenantId === tenantId && candidate.appId === appId && candidate.openId === openId
    ))
    return identity ? structuredClone(identity) : null
  }

  async findByUnionId(tenantId: string, unionId: string) {
    return [...this.identities.values()]
      .filter((identity) => identity.tenantId === tenantId && identity.unionId === unionId)
      .map((identity) => structuredClone(identity))
  }

  async findByPrincipalId(tenantId: string, principalId: string) {
    return [...this.identities.values()]
      .filter((identity) => identity.tenantId === tenantId && identity.principalId === principalId)
      .map((identity) => structuredClone(identity))
  }

  async save(identity: WechatIdentityRecord) {
    const duplicate = await this.findByAppOpenId(identity.tenantId, identity.appId, identity.openId)
    if (duplicate && duplicate.id !== identity.id) throw new Error('微信OpenID唯一约束冲突')
    this.identities.set(identity.id, structuredClone(identity))
  }

  async findAuthenticationReplay(scope: WechatApplicationScope, idempotencyKey: string) {
    const replay = this.authenticationReplays.get(replayKey(scope, idempotencyKey))
    return replay ? structuredClone(replay) : null
  }

  async completeAuthentication(input: {
    replay: WechatAuthenticationReplayRecord
    session: WechatApiSessionRecord
  }): Promise<WechatAuthenticationCommitResult> {
    const key = replayKey(input.replay, input.replay.idempotencyKey)
    const existing = this.authenticationReplays.get(key)
    if (existing) {
      if (existing.requestFingerprint !== input.replay.requestFingerprint) return { outcome: 'conflict' }
      return { outcome: 'replayed', record: structuredClone(existing) }
    }
    this.sessions.set(input.session.accessTokenHash, structuredClone(input.session))
    this.authenticationReplays.set(key, structuredClone(input.replay))
    return { outcome: 'created', record: structuredClone(input.replay) }
  }

  async findSession(accessTokenHash: string) {
    const session = this.sessions.get(accessTokenHash)
    return session ? structuredClone(session) : null
  }

  async bindMemberWithGrant(input: {
    tenantId: string
    storeId: string
    principalId: string
    memberId: string
    grantTokenHash: string
    now: number
  }): Promise<WechatProviderResult<WechatAuthenticatedPrincipal>> {
    const grant = this.bindingGrants.get(input.grantTokenHash)
    if (!grant || grant.consumedAt !== null) {
      return { ok: false, failure: failure('authentication', 'MEMBER_BINDING_GRANT_INVALID', '会员绑定凭证无效或已使用') }
    }
    if (grant.expiresAt <= input.now) {
      return { ok: false, failure: failure('expired', 'MEMBER_BINDING_GRANT_EXPIRED', '会员绑定凭证已过期') }
    }
    if (grant.tenantId !== input.tenantId || grant.storeId !== input.storeId || grant.memberId !== input.memberId) {
      return { ok: false, failure: failure('authorization', 'MEMBER_BINDING_SCOPE_MISMATCH', '会员绑定凭证不属于当前租户、门店或会员') }
    }
    const identities = this.scopedIdentities(input)
    if (!identities.length) {
      return { ok: false, failure: failure('provider_rejection', 'WECHAT_PRINCIPAL_NOT_FOUND', '微信主体不存在') }
    }
    if (identities.some((identity) => identity.memberId && identity.memberId !== input.memberId)) {
      return { ok: false, failure: failure('identity_conflict', 'WECHAT_IDENTITY_CONFLICT', '微信主体已关联其他会员') }
    }
    const timestamp = new Date(input.now).toISOString()
    for (const identity of identities) {
      this.identities.set(identity.id, { ...identity, memberId: input.memberId, lastAuthenticatedAt: timestamp })
    }
    grant.consumedAt = input.now
    return { ok: true, value: { ...toPrincipal(identities[0]!), memberId: input.memberId } }
  }

  async logoutSession(input: WechatIdentityMutationInput & { accessTokenHash: string }) {
    return this.mutateIdempotently<{ replayed: boolean }>('logout', input, () => {
      const session = this.sessions.get(input.accessTokenHash)
      if (!session || session.principal.principalId !== input.principalId || session.principal.storeId !== input.storeId) {
        return { ok: false, failure: failure('authentication', 'WECHAT_SESSION_INVALID', '微信身份会话无效') }
      }
      if (session.revokedAt !== null) {
        return { ok: false, failure: failure('authentication', 'WECHAT_SESSION_INVALID', '微信身份会话无效或已退出') }
      }
      this.sessions.set(input.accessTokenHash, { ...session, revokedAt: input.now })
      return { ok: true, value: { replayed: false } }
    })
  }

  async unbindMember(input: WechatIdentityMutationInput) {
    return this.mutateIdempotently<{ principal: WechatAuthenticatedPrincipal; replayed: boolean }>('unbind', input, () => {
      const identities = this.scopedIdentities(input)
      if (!identities.length) {
        return { ok: false, failure: failure('provider_rejection', 'WECHAT_PRINCIPAL_NOT_FOUND', '微信主体不存在') }
      }
      for (const identity of identities) this.identities.set(identity.id, { ...identity, memberId: null })
      for (const [key, session] of this.sessions) {
        if (session.principal.tenantId === input.tenantId && session.principal.storeId === input.storeId && session.principal.principalId === input.principalId) {
          this.sessions.set(key, { ...session, principal: { ...session.principal, memberId: null } })
        }
      }
      return { ok: true, value: { principal: { ...toPrincipal(identities[0]!), memberId: null }, replayed: false } }
    })
  }

  async revokeAuthorization(input: WechatIdentityMutationInput) {
    return this.mutateIdempotently<{ replayed: boolean }>('revoke', input, () => {
      const identities = this.scopedIdentities(input)
      if (!identities.length) {
        return { ok: false, failure: failure('provider_rejection', 'WECHAT_PRINCIPAL_NOT_FOUND', '微信主体不存在') }
      }
      for (const identity of identities) this.identities.delete(identity.id)
      for (const [key, session] of this.sessions) {
        if (session.principal.tenantId === input.tenantId && session.principal.storeId === input.storeId && session.principal.principalId === input.principalId) {
          this.sessions.set(key, { ...session, revokedAt: input.now })
        }
      }
      for (const [key, replay] of this.authenticationReplays) {
        if (replay.response.principal.tenantId === input.tenantId && replay.response.principal.storeId === input.storeId && replay.response.principal.principalId === input.principalId) {
          this.authenticationReplays.delete(key)
        }
      }
      return { ok: true, value: { replayed: false } }
    })
  }

  identityRecords() {
    return [...this.identities.values()].map((identity) => structuredClone(identity))
  }

  activeSessionCount() {
    return [...this.sessions.values()].filter((session) => session.revokedAt === null).length
  }

  private scopedIdentities(input: { tenantId: string; storeId: string; principalId: string }) {
    return [...this.identities.values()].filter((identity) => (
      identity.tenantId === input.tenantId
      && identity.storeId === input.storeId
      && identity.principalId === input.principalId
    ))
  }

  private async mutateIdempotently<T extends object>(
    operation: string,
    input: WechatIdentityMutationInput,
    mutation: () => WechatProviderResult<T>,
  ): Promise<WechatProviderResult<T>> {
    const key = `${operation}\u0000${input.tenantId}\u0000${input.storeId}\u0000${input.principalId}\u0000${input.idempotencyKey}`
    const previous = this.mutations.get(key) as StoredMutation<T> | undefined
    if (previous) {
      if (previous.fingerprint !== input.requestFingerprint) {
        return { ok: false, failure: failure('replay', 'IDEMPOTENCY_KEY_REUSED', '幂等键已用于不同请求') }
      }
      if (!previous.result.ok) return structuredClone(previous.result)
      return { ok: true, value: { ...structuredClone(previous.result.value), replayed: true } }
    }
    const result = mutation()
    this.mutations.set(key, { fingerprint: input.requestFingerprint, result: structuredClone(result) })
    return result
  }

  private hash(value: string) {
    return createHash('sha256').update(value).digest('base64url')
  }
}

export class ScriptedMiniProgramCodeSessionProvider implements MiniProgramCodeSessionProvider {
  readonly requests: MiniProgramCodeSessionRequest[] = []

  constructor(private readonly results: WechatProviderResult<MiniProgramCodeSession>[]) {}

  async exchangeCode(request: MiniProgramCodeSessionRequest) {
    this.requests.push(structuredClone(request))
    const result = this.results.shift()
    if (!result) throw new Error('未配置更多微信provider测试结果')
    return structuredClone(result)
  }
}
