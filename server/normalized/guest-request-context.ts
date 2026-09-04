import type { FastifyRequest } from 'fastify'
import type {
  GuestSessionRecord,
  GuestSessionService,
} from './guest-session-repository.js'
import type { StoreScope } from './transaction-runner.js'

export const GUEST_SESSION_COOKIE = '__Host-mbox_guest_session'
export const GUEST_DEVICE_HEADER = 'x-mbox-guest-device'
export const GUEST_SESSION_HEADER = 'x-mbox-guest-session'

export interface TrustedGuestStoreScopeResolver {
  resolve(request: FastifyRequest): Promise<Readonly<StoreScope>> | Readonly<StoreScope>
}

export interface GuestDeviceFingerprintResolver {
  resolve(request: FastifyRequest, suppliedDeviceKey?: string): string
}

export interface GuestRequestContext {
  scope: Readonly<StoreScope>
  sessionKind: GuestSessionRecord['kind']
  customerId: string
  tableSessionId: string | null
  reservationId: string | null
  tableCode: string | null
  tableDisplayName: string | null
  businessDate: string | null
  expiresAt: string
  capabilities: readonly string[]
  actorRef: string
}

type GuestAuthenticationPort = Pick<GuestSessionService, 'authenticate'>

export class GuestRequestContextResolver {
  constructor(
    private readonly scopeResolver: TrustedGuestStoreScopeResolver,
    private readonly devices: GuestDeviceFingerprintResolver,
    private readonly authentication: GuestAuthenticationPort,
  ) {}

  async resolve(request: FastifyRequest): Promise<GuestRequestContext> {
    const scope = await this.resolveTrustedScope(request)
    const session = await this.authentication.authenticate({
      scope,
      sessionToken: readGuestSessionToken(request),
      deviceFingerprint: this.devices.resolve(request),
    })
    return Object.freeze({
      scope,
      sessionKind: session.kind,
      customerId: session.customerId,
      tableSessionId: session.tableSessionId,
      reservationId: session.reservationId,
      tableCode: session.tableCode,
      tableDisplayName: session.tableDisplayName,
      businessDate: session.businessDate,
      expiresAt: session.expiresAt,
      capabilities: Object.freeze([...session.scopes]),
      actorRef: `guest-session:${session.id}`,
    })
  }

  async resolveTrustedScope(request: FastifyRequest): Promise<Readonly<StoreScope>> {
    const scope = await this.scopeResolver.resolve(request)
    if (!isUuid(scope.tenantId) || !isUuid(scope.storeId)) {
      throw new GuestStoreScopeError()
    }
    return Object.freeze({ tenantId: scope.tenantId, storeId: scope.storeId })
  }

  resolveDeviceFingerprint(request: FastifyRequest, suppliedDeviceKey?: string): string {
    return this.devices.resolve(request, suppliedDeviceKey)
  }
}

export class HeaderGuestDeviceFingerprintResolver implements GuestDeviceFingerprintResolver {
  resolve(request: FastifyRequest, suppliedDeviceKey?: string): string {
    const header = request.headers[GUEST_DEVICE_HEADER]
    if (Array.isArray(header)) throw new GuestDeviceBindingError()
    const headerValue = typeof header === 'string' ? header.trim() : ''
    const bodyValue = suppliedDeviceKey?.trim() ?? ''
    if (bodyValue && headerValue && bodyValue !== headerValue) {
      throw new GuestDeviceBindingError('设备信息不一致，请重新扫描桌面二维码')
    }
    const value = bodyValue || headerValue
    if (value.length < 8 || value.length > 256) throw new GuestDeviceBindingError()
    return value
  }
}

export class GuestAuthenticationRequiredError extends Error {
  constructor(message = '请重新扫描桌面二维码进入本桌服务') {
    super(message)
    this.name = 'GuestAuthenticationRequiredError'
  }
}

export class GuestDeviceBindingError extends Error {
  constructor(message = '设备会话信息不完整，请重新扫描桌面二维码') {
    super(message)
    this.name = 'GuestDeviceBindingError'
  }
}

export class GuestStoreScopeError extends Error {
  constructor() {
    super('当前门店访问入口无效')
    this.name = 'GuestStoreScopeError'
  }
}

export class GuestCapabilityDeniedError extends Error {
  constructor(capability: string) {
    super(`当前访客会话不允许执行此操作: ${capability}`)
    this.name = 'GuestCapabilityDeniedError'
  }
}

export function requireGuestCapability(
  context: Readonly<GuestRequestContext>,
  capability: string,
): void {
  if (!context.capabilities.includes(capability)) throw new GuestCapabilityDeniedError(capability)
}

export function readGuestSessionToken(request: FastifyRequest): string {
  const bearer = readBearer(request.headers.authorization)
  const headerToken = readOpaqueHeader(request.headers[GUEST_SESSION_HEADER])
  const cookie = readCookie(request.headers.cookie, GUEST_SESSION_COOKIE)
  const present = [bearer, headerToken, cookie].filter((value): value is string => value !== null)
  if (new Set(present).size > 1) {
    throw new GuestAuthenticationRequiredError('访客凭证不一致，请重新扫描桌面二维码')
  }
  const token = bearer ?? headerToken ?? cookie
  if (token === null || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) {
    throw new GuestAuthenticationRequiredError()
  }
  return token
}

function readBearer(authorization: string | undefined): string | null {
  if (authorization === undefined) return null
  const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(authorization)
  if (!match?.[1]) throw new GuestAuthenticationRequiredError('访客凭证格式无效')
  return match[1]
}

function readOpaqueHeader(value: string | string[] | undefined): string | null {
  if (value === undefined) return null
  if (Array.isArray(value)) {
    if (value.length === 0) return null
    if (value.length > 1) {
      throw new GuestAuthenticationRequiredError('访客凭证重复，请重新扫描桌面二维码')
    }
    return readOpaqueHeader(value[0])
  }
  const token = value.trim()
  if (!token) return null
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) {
    throw new GuestAuthenticationRequiredError('访客凭证格式无效')
  }
  return token
}

function readCookie(header: string | undefined, name: string): string | null {
  if (header === undefined) return null
  let found: string | null = null
  for (const part of header.split(';')) {
    const separator = part.indexOf('=')
    if (separator < 1 || part.slice(0, separator).trim() !== name) continue
    const value = part.slice(separator + 1).trim()
    if (found !== null && found !== value) {
      throw new GuestAuthenticationRequiredError('访客凭证重复，请重新扫描桌面二维码')
    }
    found = value
  }
  return found
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}
