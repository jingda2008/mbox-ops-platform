import { createHmac, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { RequestActorContext, RuntimeMode, StaffSessionClaims } from '../src/shared/auth-contracts.js'
import type { RuntimeState } from '../src/shared/contracts.js'

declare module 'fastify' {
  interface FastifyRequest {
    mboxActor: RequestActorContext | null
  }
}

export class AuthenticationError extends Error {
  constructor(message: string, public readonly statusCode = 401, public readonly code = 'AUTHENTICATION_REQUIRED') {
    super(message)
    this.name = 'AuthenticationError'
  }
}

interface AuthContextOptions {
  runtimeMode: RuntimeMode
  sessionSecret?: string
  readState: () => Promise<RuntimeState>
}

const PUBLIC_PATHS = new Set(['/api/health', '/api/live', '/api/ready', '/api/metrics', '/api/auth/pilot-login'])

function encode(value: object) {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function signature(payload: string, secret: string) {
  return createHmac('sha256', secret).update(payload).digest('base64url')
}

export function signStaffSession(
  claims: Omit<StaffSessionClaims, 'version'>,
  secret: string,
) {
  if (secret.length < 32) throw new Error('会话密钥至少需要32个字符')
  const payload = encode({ version: 1, ...claims })
  return `${payload}.${signature(payload, secret)}`
}

export function verifyStaffSession(token: string, secret: string, now = Date.now()): StaffSessionClaims {
  const [payload, suppliedSignature, extra] = token.split('.')
  if (!payload || !suppliedSignature || extra) throw new AuthenticationError('员工会话格式无效')
  const expected = Buffer.from(signature(payload, secret))
  const supplied = Buffer.from(suppliedSignature)
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    throw new AuthenticationError('员工会话签名无效')
  }
  let claims: StaffSessionClaims
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as StaffSessionClaims
  } catch {
    throw new AuthenticationError('员工会话载荷无效')
  }
  if (claims.version !== 1 || !claims.sessionId || !claims.actorId || !claims.storeId) {
    throw new AuthenticationError('员工会话声明无效')
  }
  if (!Number.isSafeInteger(claims.issuedAt) || !Number.isSafeInteger(claims.expiresAt)) {
    throw new AuthenticationError('员工会话时间无效')
  }
  if (claims.issuedAt > now + 60_000) throw new AuthenticationError('员工会话签发时间异常')
  if (claims.expiresAt <= now) throw new AuthenticationError('员工会话已过期')
  return claims
}

function isDevelopmentPath(path: string) {
  return path === '/api/dev' || path.startsWith('/api/dev/')
}

function isAnonymousGuestRequest(request: FastifyRequest) {
  return request.url === '/api/guest' || request.url.startsWith('/api/guest/') || request.url.startsWith('/api/guest?') ||
    request.url === '/api/wechat' || request.url.startsWith('/api/wechat/') || request.url.startsWith('/api/wechat?') ||
    request.url === '/api/public/reservation-session' || request.url === '/api/public/reservations' ||
    request.url.startsWith('/api/public/reservations?')
}

function assertActorBinding(request: FastifyRequest, actorId: string, runtimeMode: RuntimeMode) {
  if (!['staging', 'production'].includes(runtimeMode) || !request.body || typeof request.body !== 'object') return
  const body = request.body as Record<string, unknown>
  for (const field of ['actorId', 'createdBy', 'submittedBy', 'requestedBy', 'decidedBy']) {
    const claimedActor = body[field]
    if (typeof claimedActor === 'string' && claimedActor !== actorId) {
      throw new AuthenticationError(`请求中的${field}不能冒用其他员工`, 403, 'ACTOR_IMPERSONATION_FORBIDDEN')
    }
  }
}

export async function registerAuthContext(app: FastifyInstance, options: AuthContextOptions) {
  const requiresSignedSession = ['staging', 'production'].includes(options.runtimeMode)
  if (requiresSignedSession && (!options.sessionSecret || options.sessionSecret.length < 32)) {
    throw new Error('预发布和生产环境必须配置至少32字符的MBOX_SESSION_SECRET')
  }
  app.decorateRequest('mboxActor', null)
  app.addHook('preHandler', async (request) => {
    const path = request.url.split('?')[0] ?? request.url
    if (!path.startsWith('/api/') || PUBLIC_PATHS.has(path) || isAnonymousGuestRequest(request)) return
    if (isDevelopmentPath(path)) {
      if (requiresSignedSession) {
        throw new AuthenticationError('当前环境未启用开发接口', 404, 'DEVELOPMENT_ENDPOINT_DISABLED')
      }
      return
    }

    let actorId: string
    let storeId: string
    let authenticatedBy: RequestActorContext['authenticatedBy']
    let sessionId: string | null = null
    let sessionExpiresAt: number | null = null
    if (requiresSignedSession || request.headers.authorization) {
      const authorization = request.headers.authorization
      if (!authorization?.startsWith('Bearer ') || !options.sessionSecret) {
        throw new AuthenticationError('缺少有效员工会话')
      }
      const claims = verifyStaffSession(authorization.slice(7), options.sessionSecret)
      actorId = claims.actorId
      storeId = claims.storeId
      authenticatedBy = 'signed_session'
      sessionId = claims.sessionId
      sessionExpiresAt = claims.expiresAt
    } else {
      actorId = String(request.headers['x-mbox-actor-id'] ?? '')
      storeId = String(request.headers['x-mbox-store-id'] ?? '')
      authenticatedBy = 'local_header'
      if (!actorId || !storeId) throw new AuthenticationError('本地请求缺少员工和门店上下文')
    }

    const state = await options.readState()
    if (storeId !== state.store.id) throw new AuthenticationError('员工会话不属于当前门店', 403, 'STORE_ACCESS_FORBIDDEN')
    const employee = state.employees.find((item) => item.id === actorId && item.status === 'active')
    if (!employee) throw new AuthenticationError('员工不存在或已停用', 403, 'ACTOR_NOT_ACTIVE')
    assertActorBinding(request, actorId, options.runtimeMode)
    request.mboxActor = {
      actorId,
      storeId,
      roleId: employee.roleId,
      runtimeMode: options.runtimeMode,
      authenticatedBy,
      sessionId,
      sessionExpiresAt,
    }
  })
}

export function requireRequestActor(request: FastifyRequest) {
  if (!request.mboxActor) throw new AuthenticationError('该操作需要员工身份')
  return request.mboxActor
}
