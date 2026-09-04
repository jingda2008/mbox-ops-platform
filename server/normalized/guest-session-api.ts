import { createHash } from 'node:crypto'
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import {
  GuestSessionInvalidError,
  GuestCustomerAtAnotherTableError,
  GuestSessionRateLimitError,
  GuestSessionService,
  GuestTableSessionEndedError,
} from './guest-session-repository.js'
import {
  GUEST_SESSION_COOKIE,
  GuestAuthenticationRequiredError,
  GuestDeviceBindingError,
  GuestRequestContextResolver,
  GuestStoreScopeError,
} from './guest-request-context.js'
import type { StoreScope } from './transaction-runner.js'

type GuestSessionPort = Pick<GuestSessionService, 'scanTable'>

export interface GuestBusinessClock {
  current(scope: Readonly<StoreScope>): Promise<{ businessDate: string }>
}

export interface GuestSessionApiOptions {
  sessions: GuestSessionPort
  requestContext: GuestRequestContextResolver
  businessClock: GuestBusinessClock
  loadTableOverview(
    scope: Readonly<StoreScope>,
    tableSessionId: string,
  ): Promise<{ guestCount: number; primaryServiceName: string | null; cartProtocolVersion: 1 | 2 }>
  /** Resolves an optional, trusted WeChat identity only for table scanning. */
  resolveWechatCustomer?(
    request: FastifyRequest,
    scope: Readonly<StoreScope>,
  ): Promise<string | null>
}

interface ApiErrorBody {
  error: { code: string; message: string; retryAt?: string }
}

class GuestSessionRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GuestSessionRequestError'
  }
}

export const guestSessionApiPlugin: FastifyPluginAsync<GuestSessionApiOptions> = async (app, options) => {
  app.post('/session/scan', async (request, reply) => handleRoute(reply, async () => {
    const body = readObject(request.body)
    const scope = await options.requestContext.resolveTrustedScope(request)
    const businessClock = await options.businessClock.current(scope)
    const customerId = await options.resolveWechatCustomer?.(request, scope) ?? null
    const result = await options.sessions.scanTable({
      scope,
      tableQrToken: readString(body.tableQrToken, '桌面二维码', 256, 32),
      deviceFingerprint: options.requestContext.resolveDeviceFingerprint(
        request,
        readString(body.deviceKey, '设备标识', 256, 8),
      ),
      businessDate: businessClock.businessDate,
      ...(customerId === null ? {} : { customerId }),
    })
    reply.header('cache-control', 'no-store')

    if (result.status === 'active') {
      const overview = await options.loadTableOverview(scope, result.session.tableSessionId!)
      setGuestCookie(reply, result.sessionToken, result.session.expiresAt)
      return reply.send({
        data: {
          status: 'active',
          message: '已经找到您的桌位，今晚由我们继续照顾您。',
          sessionToken: result.sessionToken,
          table: {
            code: result.session.tableCode,
            displayName: result.session.tableDisplayName,
          },
          businessDate: result.session.businessDate,
          expiresAt: result.session.expiresAt,
          cartScope: cartScope(result.session.tableSessionId),
          guestCount: overview.guestCount,
          primaryServiceName: overview.primaryServiceName,
          cartProtocolVersion: overview.cartProtocolVersion,
          capabilities: result.session.scopes,
        },
      })
    }
    if (result.status === 'already_active') {
      const overview = await options.loadTableOverview(scope, result.session.tableSessionId!)
      return reply.send({
        data: {
          status: 'already_active',
          message: '已经连接到您的桌位，请继续使用当前页面。',
          table: {
            code: result.session.tableCode,
            displayName: result.session.tableDisplayName,
          },
          businessDate: result.session.businessDate,
          expiresAt: result.session.expiresAt,
          cartScope: cartScope(result.session.tableSessionId),
          guestCount: overview.guestCount,
          primaryServiceName: overview.primaryServiceName,
          cartProtocolVersion: overview.cartProtocolVersion,
          capabilities: result.session.scopes,
        },
      })
    }
    if (result.status === 'waiting_for_table') {
      clearGuestCookie(reply)
      return reply.send({
        data: {
          status: 'waiting_for_table',
          message: '桌位已识别，请告知身边的服务人员为本桌开台。开台后菜单会自动出现。',
          table: { code: result.tableCode, displayName: result.tableDisplayName },
        },
      })
    }
    if (result.status === 'rate_limited') {
      return reply.code(429).send({
        error: {
          code: 'GUEST_SCAN_RATE_LIMITED',
          message: '操作有点快，请稍后再试。',
          retryAt: result.retryAt,
        },
      })
    }
    clearGuestCookie(reply)
    return reply.code(404).send({
      error: {
        code: 'TABLE_QR_INVALID',
        message: '没有识别到本店有效桌码，请重新扫描桌面上的固定二维码。',
      },
    })
  }))

  app.get('/session', async (request, reply) => handleRoute(reply, async () => {
    const context = await options.requestContext.resolve(request)
    const overview = context.tableSessionId === null
      ? { guestCount: null, primaryServiceName: null, cartProtocolVersion: null }
      : await options.loadTableOverview(context.scope, context.tableSessionId)
    reply.header('cache-control', 'no-store')
    return reply.send({
      data: {
        status: 'active',
        sessionKind: context.sessionKind,
        table: context.tableCode === null ? null : {
          code: context.tableCode,
          displayName: context.tableDisplayName,
        },
        businessDate: context.businessDate,
        expiresAt: context.expiresAt,
        cartScope: cartScope(context.tableSessionId),
        guestCount: overview.guestCount,
        primaryServiceName: overview.primaryServiceName,
        cartProtocolVersion: overview.cartProtocolVersion,
        capabilities: context.capabilities,
      },
    })
  }))
}

function cartScope(tableSessionId: string | null): string | null {
  if (tableSessionId === null) return null
  return createHash('sha256').update(`mbox-cart-v1:${tableSessionId}`, 'utf8').digest('base64url').slice(0, 32)
}

async function handleRoute(
  reply: FastifyReply,
  operation: () => Promise<FastifyReply>,
): Promise<FastifyReply> {
  try {
    return await operation()
  } catch (error) {
    const mapped = mapError(error)
    if (mapped.clearCookie) clearGuestCookie(reply)
    reply.header('cache-control', 'no-store')
    return reply.code(mapped.statusCode).send(mapped.body)
  }
}

function mapError(error: unknown): {
  statusCode: number
  body: ApiErrorBody
  clearCookie?: boolean
} {
  if (error instanceof GuestSessionRateLimitError) {
    return {
      statusCode: 429,
      body: {
        error: {
          code: 'GUEST_AUTH_RATE_LIMITED',
          message: error.message,
          retryAt: error.retryAt,
        },
      },
    }
  }
  if (error instanceof GuestTableSessionEndedError) {
    return {
      statusCode: 401,
      body: { error: { code: 'TABLE_SESSION_ENDED', message: error.message } },
      clearCookie: true,
    }
  }
  if (error instanceof GuestCustomerAtAnotherTableError) {
    return {
      statusCode:409,
      body:{ error:{ code:'CUSTOMER_AT_OTHER_TABLE',message:error.message } },
      clearCookie:true,
    }
  }
  if (
    error instanceof GuestSessionInvalidError
    || error instanceof GuestAuthenticationRequiredError
    || error instanceof GuestDeviceBindingError
  ) {
    return {
      statusCode: 401,
      body: { error: { code: 'GUEST_SESSION_INVALID', message: error.message } },
      clearCookie: true,
    }
  }
  if (error instanceof GuestStoreScopeError) {
    return {
      statusCode: 403,
      body: { error: { code: 'STORE_ACCESS_FORBIDDEN', message: error.message } },
    }
  }
  if (error instanceof GuestSessionRequestError) {
    return {
      statusCode: 400,
      body: { error: { code: 'GUEST_REQUEST_INVALID', message: error.message } },
    }
  }
  return {
    statusCode: 500,
    body: { error: { code: 'GUEST_SESSION_INTERNAL_ERROR', message: '桌边服务暂时繁忙，请稍后再试。' } },
  }
}

function setGuestCookie(reply: FastifyReply, token: string, expiresAt: string): void {
  const expires = new Date(expiresAt)
  const maxAge = Math.max(0, Math.floor((expires.getTime() - Date.now()) / 1_000))
  reply.header('set-cookie', [
    `${GUEST_SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Expires=${expires.toUTCString()}`,
    `Max-Age=${maxAge}`,
  ].join('; '))
}

function clearGuestCookie(reply: FastifyReply): void {
  reply.header(
    'set-cookie',
    `${GUEST_SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0`,
  )
}

function readObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new GuestSessionRequestError('请求正文必须是JSON对象')
  }
  return value as Record<string, unknown>
}

function readString(
  value: unknown,
  label: string,
  maximum: number,
  minimum: number,
): string {
  if (typeof value !== 'string') throw new GuestSessionRequestError(`${label}格式无效`)
  const normalized = value.trim()
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new GuestSessionRequestError(`${label}格式无效`)
  }
  return normalized
}
