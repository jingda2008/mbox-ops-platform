import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import {
  InvalidStaffCredentialsError,
  StaffAuthCommandService,
  StaffCredentialConfigurationError,
  StoreCredentialVerificationError,
} from './staff-auth-command-service.js'
import { StaffAccessDeniedError, StaffNotFoundError } from './staff-access-repository.js'
import {
  DeviceAccessDeniedError,
  StaffSessionNotFoundError,
  type StaffSession,
} from './staff-session-repository.js'
import {
  DEVICE_ACCESS_COOKIE,
  NormalizedAuthenticationRequiredError,
  NormalizedRequestContextResolver,
  NormalizedStoreUnavailableError,
  STAFF_SESSION_COOKIE,
  TrustedStoreScopeError,
  readRequestToken,
  type NormalizedBusinessClock,
} from './normalized-request-context.js'

type StaffAuthPort = Pick<
  StaffAuthCommandService,
  | 'verifyDailyStoreCredential'
  | 'login'
  | 'switchEmployee'
  | 'authenticateSession'
  | 'heartbeat'
  | 'revokeSession'
>

export interface StaffAuthApiOptions {
  auth: StaffAuthPort
  requestContext: NormalizedRequestContextResolver
  businessClock: NormalizedBusinessClock
}

interface ApiErrorBody {
  error: { code: string; message: string }
}

export class StaffAuthTooManyAttemptsError extends Error {
  constructor() {
    super('尝试次数过多，请稍后再试')
    this.name = 'StaffAuthTooManyAttemptsError'
  }
}

class StaffAuthRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StaffAuthRequestError'
  }
}

export const staffAuthApiPlugin: FastifyPluginAsync<StaffAuthApiOptions> = async (app, options) => {
  app.post('/device-access', async (request, reply) => handleRoute(reply, async () => {
    const body = readObject(request.body)
    const scope = await options.requestContext.resolveTrustedScope(request)
    const businessDay = await options.businessClock.current(scope)
    const grant = await options.auth.verifyDailyStoreCredential({
      scope,
      businessDate: businessDay.businessDate,
      credential: readString(body.credential, '门店口令', 128, 6),
      deviceKey: readString(body.deviceKey, '设备标识', 256, 8),
    })
    setSecureCookie(reply, DEVICE_ACCESS_COOKIE, grant.leaseToken, grant.expiresAt)
    return reply.send({
      data: {
        businessDate: grant.businessDate,
        expiresAt: grant.expiresAt,
      },
    })
  }))

  app.post('/login', async (request, reply) => handleRoute(reply, async () => {
    const body = readObject(request.body)
    const scope = await options.requestContext.resolveTrustedScope(request)
    const result = await options.auth.login({
      scope,
      deviceAccessToken: readRequestToken(request, DEVICE_ACCESS_COOKIE),
      employeeCode: readString(body.employeeCode, '员工账号', 64),
      pin: readString(body.pin, '员工PIN', 4, 4),
    })
    setSecureCookie(reply, STAFF_SESSION_COOKIE, result.sessionToken, result.session.expiresAt)
    return reply.send({ data: staffLoginResponse(result.session, result.access) })
  }))

  app.post('/switch', async (request, reply) => handleRoute(reply, async () => {
    const body = readObject(request.body)
    const scope = await options.requestContext.resolveTrustedScope(request)
    const result = await options.auth.switchEmployee({
      scope,
      currentSessionToken: readRequestToken(request, STAFF_SESSION_COOKIE),
      employeeCode: readString(body.employeeCode, '员工账号', 64),
      pin: readString(body.pin, '员工PIN', 4, 4),
    })
    setSecureCookie(reply, STAFF_SESSION_COOKIE, result.sessionToken, result.session.expiresAt)
    return reply.send({ data: staffLoginResponse(result.session, result.access) })
  }))

  app.get('/session', async (request, reply) => handleRoute(reply, async () => {
    const scope = await options.requestContext.resolveTrustedScope(request)
    const authenticated = await options.auth.authenticateSession(
      scope,
      readRequestToken(request, STAFF_SESSION_COOKIE),
    )
    const businessDay = await options.businessClock.current(scope)
    return reply.send({
      data: {
        ...staffLoginResponse(authenticated.session, authenticated.access),
        businessDate: businessDay.businessDate,
        timezone: businessDay.timezone,
      },
    })
  }))

  app.post('/heartbeat', async (request, reply) => handleRoute(reply, async () => {
    const scope = await options.requestContext.resolveTrustedScope(request)
    const result = await options.auth.heartbeat(
      scope,
      readRequestToken(request, STAFF_SESSION_COOKIE),
    )
    return reply.send({ data: staffLoginResponse(result.session, result.access) })
  }))

  app.post('/logout', async (request, reply) => handleRoute(reply, async () => {
    const scope = await options.requestContext.resolveTrustedScope(request)
    const sessionToken = readRequestToken(request, STAFF_SESSION_COOKIE)
    const context = await options.requestContext.resolve(request)
    await options.auth.revokeSession({
      scope,
      sessionToken,
      actorEmployeeId: context.employeeId,
      businessDate: context.businessDate,
      reason: '员工主动退出',
    })
    clearSecureCookie(reply, STAFF_SESSION_COOKIE)
    return reply.code(204).send()
  }))
}

function staffLoginResponse(
  session: StaffSession,
  access: Awaited<ReturnType<StaffAuthCommandService['authenticateSession']>>['access'],
) {
  return {
    session: {
      id: session.id,
      employeeId: session.employeeId,
      issuedAt: session.issuedAt,
      expiresAt: session.expiresAt,
      onlineLeaseUntil: session.onlineLeaseUntil,
      isOnline: session.isOnline,
    },
    employee: {
      id: access.employeeId,
      code: access.employeeCode,
      displayName: access.displayName,
      roleCodes: access.roleCodes,
    },
    permissions: access.permissions,
    deniedPermissions: access.deniedPermissions,
    dataScopes: access.dataScopes,
    approvalLimits: access.approvalLimits,
    navigation: access.navigation,
    resolvedAt: access.resolvedAt,
  }
}

async function handleRoute(
  reply: FastifyReply,
  operation: () => Promise<FastifyReply>,
): Promise<FastifyReply> {
  try {
    return await operation()
  } catch (error) {
    const mapped = mapError(error)
    return reply.code(mapped.statusCode).send(mapped.body)
  }
}

function mapError(error: unknown): { statusCode: number; body: ApiErrorBody } {
  if (isRateLimitError(error)) {
    return apiError(429, 'AUTH_RATE_LIMITED', '尝试次数过多，请稍后再试')
  }
  if (
    error instanceof InvalidStaffCredentialsError
    || error instanceof StoreCredentialVerificationError
    || error instanceof DeviceAccessDeniedError
    || error instanceof StaffSessionNotFoundError
    || error instanceof NormalizedAuthenticationRequiredError
  ) {
    return apiError(401, 'AUTH_REQUIRED', '登录信息无效或已过期，请重新登录')
  }
  if (error instanceof StaffAccessDeniedError) {
    return apiError(403, 'STAFF_ACCESS_FORBIDDEN', '当前员工无权执行此操作')
  }
  if (error instanceof StaffNotFoundError) {
    return apiError(403, 'STAFF_ACCESS_FORBIDDEN', '当前员工无权执行此操作')
  }
  if (error instanceof TrustedStoreScopeError || error instanceof NormalizedStoreUnavailableError) {
    return apiError(403, 'STORE_ACCESS_FORBIDDEN', error.message)
  }
  if (error instanceof StaffCredentialConfigurationError || error instanceof StaffAuthRequestError) {
    return apiError(400, 'AUTH_REQUEST_INVALID', error.message)
  }
  return apiError(500, 'AUTH_INTERNAL_ERROR', '登录服务暂时不可用，请稍后重试')
}

function isRateLimitError(error: unknown): boolean {
  return error instanceof StaffAuthTooManyAttemptsError
    || (error instanceof Error && (
      error.name === 'StaffLoginRateLimitError'
      || error.name === 'RateLimitExceededError'
    ))
}

function apiError(statusCode: number, code: string, message: string) {
  return { statusCode, body: { error: { code, message } } }
}

function setSecureCookie(reply: FastifyReply, name: string, value: string, expiresAt: string): void {
  const expires = new Date(expiresAt)
  const maxAge = Math.max(0, Math.floor((expires.getTime() - Date.now()) / 1_000))
  reply.header('set-cookie', [
    `${name}=${value}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    `Expires=${expires.toUTCString()}`,
    `Max-Age=${maxAge}`,
  ].join('; '))
}

function clearSecureCookie(reply: FastifyReply, name: string): void {
  reply.header(
    'set-cookie',
    `${name}=; Path=/; HttpOnly; Secure; SameSite=Strict; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0`,
  )
}

function readObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new StaffAuthRequestError('请求正文必须是JSON对象')
  }
  return value as Record<string, unknown>
}

function readString(
  value: unknown,
  label: string,
  maximum: number,
  minimum = 1,
): string {
  if (typeof value !== 'string') throw new StaffAuthRequestError(`${label}格式无效`)
  const normalized = value.trim()
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new StaffAuthRequestError(`${label}格式无效`)
  }
  return normalized
}
