import { createHash, randomBytes } from 'node:crypto'
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { RuntimeMode } from '../src/shared/auth-contracts.js'
import type {
  MiniProgramCodeSessionProvider,
  WechatAuthenticatedPrincipal,
  WechatFailure,
  WechatIdentityRecord,
  WechatLoginChallenge,
  WechatProviderResult,
} from '../src/shared/wechat-contracts.js'
import {
  createWechatLoginChallenge,
  WechatIdentityService,
  type WechatChallengeStore,
  type WechatIdentityRepository,
} from './wechat-identity.js'

const idempotencyKeySchema = z.string().trim().min(8).max(128)
const scopeSchema = z.object({
  tenantId: z.string().trim().min(1).max(128),
  storeId: z.string().trim().min(1).max(128),
  appId: z.string().trim().min(1).max(128),
}).strict()
const challengeSchema = scopeSchema.extend({ idempotencyKey: idempotencyKeySchema }).strict()
const codeAuthenticationSchema = scopeSchema.extend({
  code: z.string().trim().min(1).max(512),
  state: z.string().trim().min(16).max(4096),
  nonce: z.string().trim().min(16).max(512),
  idempotencyKey: idempotencyKeySchema,
  memberBinding: z.object({
    memberId: z.string().trim().min(1).max(128),
    grantToken: z.string().trim().min(24).max(512),
  }).strict().optional(),
}).strict()
const mutationSchema = z.object({ idempotencyKey: idempotencyKeySchema }).strict()

export interface WechatApplicationScope {
  tenantId: string
  storeId: string
  appId: string
}

export interface WechatIssuedChallengeRecord extends WechatApplicationScope {
  idempotencyKey: string
  requestFingerprint: string
  challenge: WechatLoginChallenge
}

export type WechatChallengeIssueResult =
  | { outcome: 'created' | 'replayed'; record: WechatIssuedChallengeRecord }
  | { outcome: 'conflict' }

export interface WechatApiChallengeRepository extends WechatChallengeStore {
  issue(record: WechatIssuedChallengeRecord): Promise<WechatChallengeIssueResult>
}

export interface WechatApiSessionRecord {
  accessTokenHash: string
  principal: WechatAuthenticatedPrincipal
  issuedAt: number
  expiresAt: number
  revokedAt: number | null
}

export interface WechatCodeAuthenticationResponse {
  tokenType: 'Bearer'
  accessToken: string
  expiresAt: string
  principal: WechatAuthenticatedPrincipal
}

export interface WechatAuthenticationReplayRecord extends WechatApplicationScope {
  idempotencyKey: string
  requestFingerprint: string
  response: WechatCodeAuthenticationResponse
}

export type WechatAuthenticationCommitResult =
  | { outcome: 'created' | 'replayed'; record: WechatAuthenticationReplayRecord }
  | { outcome: 'conflict' }

export interface WechatIdentityMutationInput {
  tenantId: string
  storeId: string
  principalId: string
  idempotencyKey: string
  requestFingerprint: string
  now: number
}

export interface WechatApiIdentityRepository extends WechatIdentityRepository {
  findAuthenticationReplay(
    scope: WechatApplicationScope,
    idempotencyKey: string,
  ): Promise<WechatAuthenticationReplayRecord | null>
  completeAuthentication(input: {
    replay: WechatAuthenticationReplayRecord
    session: WechatApiSessionRecord
  }): Promise<WechatAuthenticationCommitResult>
  findSession(accessTokenHash: string): Promise<WechatApiSessionRecord | null>
  bindMemberWithGrant(input: {
    tenantId: string
    storeId: string
    principalId: string
    memberId: string
    grantTokenHash: string
    now: number
  }): Promise<WechatProviderResult<WechatAuthenticatedPrincipal>>
  logoutSession(input: WechatIdentityMutationInput & { accessTokenHash: string }): Promise<WechatProviderResult<{ replayed: boolean }>>
  unbindMember(input: WechatIdentityMutationInput): Promise<WechatProviderResult<{ principal: WechatAuthenticatedPrincipal; replayed: boolean }>>
  revokeAuthorization(input: WechatIdentityMutationInput): Promise<WechatProviderResult<{ replayed: boolean }>>
}

export interface WechatApiOptions {
  runtimeMode: RuntimeMode
  stateSecret?: string
  provider?: MiniProgramCodeSessionProvider
  challengeRepository?: WechatApiChallengeRepository
  identityRepository?: WechatApiIdentityRepository
  applications?: readonly WechatApplicationScope[]
  challengeTtlMs?: number
  sessionTtlMs?: number
  now?: () => number
  anonymousRequestGuard?: (request: FastifyRequest) => Promise<WechatProviderResult<void>>
}

function failure(
  classification: WechatFailure['classification'],
  code: string,
  message: string,
  retryable = false,
): WechatFailure {
  return { classification, code, message, retryable }
}

function hash(value: string) {
  return createHash('sha256').update(value).digest('base64url')
}

function fingerprint(value: unknown) {
  return hash(JSON.stringify(value))
}

function scopeKey(scope: WechatApplicationScope) {
  return `${scope.tenantId}\u0000${scope.storeId}\u0000${scope.appId}`
}

function statusForFailure(value: WechatFailure) {
  switch (value.classification) {
    case 'validation': return 400
    case 'authentication': return 401
    case 'authorization': return 403
    case 'expired': return 410
    case 'replay':
    case 'identity_conflict': return 409
    case 'rate_limit': return 429
    case 'configuration':
    case 'transient': return 503
    case 'provider_rejection': return 422
  }
}

function sendFailure(reply: FastifyReply, value: WechatFailure) {
  return reply.status(statusForFailure(value)).send({
    code: value.code,
    message: value.message,
    classification: value.classification,
    retryable: value.retryable,
    ...(value.providerRequestId ? { providerRequestId: value.providerRequestId } : {}),
  })
}

function validationFailure(error: z.ZodError) {
  return failure('validation', 'WECHAT_INPUT_INVALID', error.issues[0]?.message ?? '微信身份请求参数无效')
}

function parseBearer(request: FastifyRequest): WechatProviderResult<string> {
  const authorization = request.headers.authorization
  if (!authorization?.startsWith('Bearer ')) {
    return { ok: false, failure: failure('authentication', 'WECHAT_SESSION_REQUIRED', '缺少微信身份会话') }
  }
  const token = authorization.slice(7).trim()
  if (token.length < 32 || token.length > 512 || token.includes(' ')) {
    return { ok: false, failure: failure('authentication', 'WECHAT_SESSION_INVALID', '微信身份会话格式无效') }
  }
  return { ok: true, value: token }
}

async function requireSession(
  request: FastifyRequest,
  repository: WechatApiIdentityRepository,
  now: number,
  allowRevoked = false,
): Promise<WechatProviderResult<{ tokenHash: string; session: WechatApiSessionRecord }>> {
  const bearer = parseBearer(request)
  if (!bearer.ok) return bearer
  const tokenHash = hash(bearer.value)
  let session: WechatApiSessionRecord | null
  try {
    session = await repository.findSession(tokenHash)
  } catch (error) {
    return { ok: false, failure: failure('transient', 'IDENTITY_STORE_UNAVAILABLE', error instanceof Error ? error.message : '微信身份存储不可用', true) }
  }
  if (!session || (!allowRevoked && session.revokedAt !== null)) {
    return { ok: false, failure: failure('authentication', 'WECHAT_SESSION_INVALID', '微信身份会话无效或已退出') }
  }
  if (session.expiresAt <= now) {
    return { ok: false, failure: failure('expired', 'WECHAT_SESSION_EXPIRED', '微信身份会话已过期') }
  }
  return { ok: true, value: { tokenHash, session } }
}

function configurationFailure() {
  return failure('configuration', 'WECHAT_API_NOT_CONFIGURED', '微信身份API尚未完整配置', true)
}

function assertProductionConfiguration(options: WechatApiOptions) {
  if (options.runtimeMode !== 'production') return
  const missing: string[] = []
  if (!options.provider) missing.push('provider')
  if (!options.challengeRepository) missing.push('challengeRepository')
  if (!options.identityRepository) missing.push('identityRepository')
  if (!options.stateSecret || options.stateSecret.length < 32) missing.push('stateSecret')
  if (!options.applications?.length) missing.push('applications')
  if (missing.length) throw new Error(`生产环境拒绝注册微信身份API，缺少配置: ${missing.join(', ')}`)
}

async function guardAnonymousRequest(request: FastifyRequest, options: WechatApiOptions) {
  if (!options.anonymousRequestGuard) return { ok: true, value: undefined } as WechatProviderResult<void>
  try {
    return await options.anonymousRequestGuard(request)
  } catch (error) {
    return {
      ok: false,
      failure: failure('transient', 'ANONYMOUS_GUARD_UNAVAILABLE', error instanceof Error ? error.message : '匿名请求防护不可用', true),
    } as WechatProviderResult<void>
  }
}

async function installWechatApi(app: FastifyInstance, options: WechatApiOptions) {
  assertProductionConfiguration(options)
  const now = options.now ?? Date.now
  const allowedScopes = new Set((options.applications ?? []).map(scopeKey))
  const configured = Boolean(
    options.provider
    && options.challengeRepository
    && options.identityRepository
    && options.stateSecret
    && options.stateSecret.length >= 32
    && allowedScopes.size,
  )
  const service = configured
    ? new WechatIdentityService({
        provider: options.provider!,
        repository: options.identityRepository!,
        challengeStore: options.challengeRepository!,
        stateSecret: options.stateSecret!,
        sessionTtlMs: options.sessionTtlMs,
        now,
      })
    : null

  app.post('/api/wechat/challenges', async (request, reply) => {
    if (!configured) return sendFailure(reply, configurationFailure())
    const guarded = await guardAnonymousRequest(request, options)
    if (!guarded.ok) return sendFailure(reply, guarded.failure)
    const parsed = challengeSchema.safeParse(request.body)
    if (!parsed.success) return sendFailure(reply, validationFailure(parsed.error))
    const input = parsed.data
    if (!allowedScopes.has(scopeKey(input))) {
      return sendFailure(reply, failure('authorization', 'WECHAT_APP_SCOPE_FORBIDDEN', '该租户、门店或微信应用未启用'))
    }
    const requestFingerprint = fingerprint({ operation: 'challenge', ...input })
    const challenge = createWechatLoginChallenge(input, options.stateSecret!, {
      ttlMs: options.challengeTtlMs,
      now: now(),
    })
    let issued: WechatChallengeIssueResult
    try {
      issued = await options.challengeRepository!.issue({ ...input, requestFingerprint, challenge })
    } catch (error) {
      return sendFailure(reply, failure('transient', 'CHALLENGE_STORE_UNAVAILABLE', error instanceof Error ? error.message : '微信挑战存储不可用', true))
    }
    if (issued.outcome === 'conflict') {
      return sendFailure(reply, failure('replay', 'IDEMPOTENCY_KEY_REUSED', '幂等键已用于不同的微信挑战请求'))
    }
    if (issued.outcome === 'replayed') reply.header('Idempotent-Replayed', 'true')
    return reply.status(issued.outcome === 'created' ? 201 : 200).send(issued.record.challenge)
  })

  app.post('/api/wechat/code-authentication', async (request, reply) => {
    if (!configured || !service) return sendFailure(reply, configurationFailure())
    const guarded = await guardAnonymousRequest(request, options)
    if (!guarded.ok) return sendFailure(reply, guarded.failure)
    const parsed = codeAuthenticationSchema.safeParse(request.body)
    if (!parsed.success) return sendFailure(reply, validationFailure(parsed.error))
    const input = parsed.data
    const scope = { tenantId: input.tenantId, storeId: input.storeId, appId: input.appId }
    if (!allowedScopes.has(scopeKey(scope))) {
      return sendFailure(reply, failure('authorization', 'WECHAT_APP_SCOPE_FORBIDDEN', '该租户、门店或微信应用未启用'))
    }
    const requestFingerprint = fingerprint({ operation: 'code-authentication', ...input })
    let replay: WechatAuthenticationReplayRecord | null
    try {
      replay = await options.identityRepository!.findAuthenticationReplay(scope, input.idempotencyKey)
    } catch (error) {
      return sendFailure(reply, failure('transient', 'IDENTITY_STORE_UNAVAILABLE', error instanceof Error ? error.message : '微信身份存储不可用', true))
    }
    if (replay) {
      if (replay.requestFingerprint !== requestFingerprint) {
        return sendFailure(reply, failure('replay', 'IDEMPOTENCY_KEY_REUSED', '幂等键已用于不同的微信登录请求'))
      }
      reply.header('Idempotent-Replayed', 'true')
      return reply.send(replay.response)
    }

    const authenticated = await service.authenticateMiniProgram(input)
    if (authenticated.outcome === 'failed') return sendFailure(reply, authenticated.failure)
    if (
      authenticated.principal.tenantId !== input.tenantId
      || authenticated.principal.storeId !== input.storeId
      || authenticated.principal.appId !== input.appId
    ) {
      return sendFailure(reply, failure('authorization', 'WECHAT_IDENTITY_SCOPE_MISMATCH', '微信身份不属于当前租户、门店或应用'))
    }

    let principal = authenticated.principal
    if (input.memberBinding) {
      let bound: WechatProviderResult<WechatAuthenticatedPrincipal>
      try {
        bound = await options.identityRepository!.bindMemberWithGrant({
          tenantId: input.tenantId,
          storeId: input.storeId,
          principalId: principal.principalId,
          memberId: input.memberBinding.memberId,
          grantTokenHash: hash(input.memberBinding.grantToken),
          now: now(),
        })
      } catch (error) {
        return sendFailure(reply, failure('transient', 'IDENTITY_STORE_UNAVAILABLE', error instanceof Error ? error.message : '微信身份存储不可用', true))
      }
      if (!bound.ok) return sendFailure(reply, bound.failure)
      principal = bound.value
    }

    const accessToken = randomBytes(32).toString('base64url')
    const expiresAt = Date.parse(authenticated.sessionExpiresAt)
    const response: WechatCodeAuthenticationResponse = {
      tokenType: 'Bearer',
      accessToken,
      expiresAt: authenticated.sessionExpiresAt,
      principal,
    }
    const replayRecord: WechatAuthenticationReplayRecord = {
      ...scope,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint,
      response,
    }
    let committed: WechatAuthenticationCommitResult
    try {
      committed = await options.identityRepository!.completeAuthentication({
        replay: replayRecord,
        session: {
          accessTokenHash: hash(accessToken),
          principal,
          issuedAt: now(),
          expiresAt,
          revokedAt: null,
        },
      })
    } catch (error) {
      return sendFailure(reply, failure('transient', 'IDENTITY_STORE_UNAVAILABLE', error instanceof Error ? error.message : '微信身份存储不可用', true))
    }
    if (committed.outcome === 'conflict') {
      return sendFailure(reply, failure('replay', 'IDEMPOTENCY_KEY_REUSED', '幂等键已用于不同的微信登录请求'))
    }
    if (committed.outcome === 'replayed') reply.header('Idempotent-Replayed', 'true')
    return reply.send(committed.record.response)
  })

  app.post('/api/wechat/logout', async (request, reply) => {
    if (!configured) return sendFailure(reply, configurationFailure())
    const parsed = mutationSchema.safeParse(request.body)
    if (!parsed.success) return sendFailure(reply, validationFailure(parsed.error))
    const authenticated = await requireSession(request, options.identityRepository!, now(), true)
    if (!authenticated.ok) return sendFailure(reply, authenticated.failure)
    const { session, tokenHash } = authenticated.value
    let result: WechatProviderResult<{ replayed: boolean }>
    try {
      result = await options.identityRepository!.logoutSession({
        tenantId: session.principal.tenantId,
        storeId: session.principal.storeId,
        principalId: session.principal.principalId,
        accessTokenHash: tokenHash,
        idempotencyKey: parsed.data.idempotencyKey,
        requestFingerprint: fingerprint({ operation: 'logout', principalId: session.principal.principalId }),
        now: now(),
      })
    } catch (error) {
      return sendFailure(reply, failure('transient', 'IDENTITY_STORE_UNAVAILABLE', error instanceof Error ? error.message : '微信身份存储不可用', true))
    }
    if (!result.ok) return sendFailure(reply, result.failure)
    if (result.value.replayed) reply.header('Idempotent-Replayed', 'true')
    return reply.send({ status: 'logged_out' })
  })

  app.delete('/api/wechat/member-binding', async (request, reply) => {
    if (!configured) return sendFailure(reply, configurationFailure())
    const parsed = mutationSchema.safeParse(request.body)
    if (!parsed.success) return sendFailure(reply, validationFailure(parsed.error))
    const authenticated = await requireSession(request, options.identityRepository!, now())
    if (!authenticated.ok) return sendFailure(reply, authenticated.failure)
    const { session } = authenticated.value
    let result: WechatProviderResult<{ principal: WechatAuthenticatedPrincipal; replayed: boolean }>
    try {
      result = await options.identityRepository!.unbindMember({
        tenantId: session.principal.tenantId,
        storeId: session.principal.storeId,
        principalId: session.principal.principalId,
        idempotencyKey: parsed.data.idempotencyKey,
        requestFingerprint: fingerprint({ operation: 'unbind-member', principalId: session.principal.principalId }),
        now: now(),
      })
    } catch (error) {
      return sendFailure(reply, failure('transient', 'IDENTITY_STORE_UNAVAILABLE', error instanceof Error ? error.message : '微信身份存储不可用', true))
    }
    if (!result.ok) return sendFailure(reply, result.failure)
    if (result.value.replayed) reply.header('Idempotent-Replayed', 'true')
    return reply.send({ principal: result.value.principal })
  })

  app.post('/api/wechat/authorization/revoke', async (request, reply) => {
    if (!configured) return sendFailure(reply, configurationFailure())
    const parsed = mutationSchema.safeParse(request.body)
    if (!parsed.success) return sendFailure(reply, validationFailure(parsed.error))
    const authenticated = await requireSession(request, options.identityRepository!, now(), true)
    if (!authenticated.ok) return sendFailure(reply, authenticated.failure)
    const { session } = authenticated.value
    let result: WechatProviderResult<{ replayed: boolean }>
    try {
      result = await options.identityRepository!.revokeAuthorization({
        tenantId: session.principal.tenantId,
        storeId: session.principal.storeId,
        principalId: session.principal.principalId,
        idempotencyKey: parsed.data.idempotencyKey,
        requestFingerprint: fingerprint({ operation: 'revoke-authorization', principalId: session.principal.principalId }),
        now: now(),
      })
    } catch (error) {
      return sendFailure(reply, failure('transient', 'IDENTITY_STORE_UNAVAILABLE', error instanceof Error ? error.message : '微信身份存储不可用', true))
    }
    if (!result.ok) return sendFailure(reply, result.failure)
    if (result.value.replayed) reply.header('Idempotent-Replayed', 'true')
    return reply.send({ status: 'authorization_revoked' })
  })
}

export const wechatApiPlugin: FastifyPluginAsync<WechatApiOptions> = async (app, options) => {
  await installWechatApi(app, options)
}

export async function registerWechatApiRoutes(app: FastifyInstance, options: WechatApiOptions) {
  await installWechatApi(app, options)
}

export type { WechatIdentityRecord }
