import type { FastifyRequest } from 'fastify'
import type {
  AuthenticatedStaffSession,
  StaffAuthCommandService,
} from './staff-auth-command-service.js'
import type {
  NormalizedOperationsRequestContext,
} from './normalized-operations-api.js'
import type {
  ScopedPostgresTransactionRunner,
  StoreScope,
} from './transaction-runner.js'

export const STAFF_SESSION_COOKIE = '__Host-mbox_staff_session'
export const DEVICE_ACCESS_COOKIE = '__Host-mbox_device_lease'
export const RESERVATION_SESSION_HEADER = 'x-mbox-reservation-session'
export const GUEST_SESSION_HEADER = 'x-mbox-guest-session'

export interface CurrentBusinessDay {
  businessDate: string
  timezone: string
  cutoff: string
}

export interface NormalizedBusinessClock {
  current(scope: Readonly<StoreScope>): Promise<CurrentBusinessDay>
}

export interface TrustedStoreScopeResolver {
  resolve(request: FastifyRequest): Promise<Readonly<StoreScope>> | Readonly<StoreScope>
}

type StaffSessionAuthenticationPort = Pick<StaffAuthCommandService, 'authenticateSession'>

interface BusinessDayRow extends Record<string, unknown> {
  business_date: string
  timezone: string
  cutoff: string
}

export class NormalizedAuthenticationRequiredError extends Error {
  constructor(message = '请先登录员工账号') {
    super(message)
    this.name = 'NormalizedAuthenticationRequiredError'
  }
}

export class TrustedStoreScopeError extends Error {
  constructor() {
    super('当前设备未绑定有效门店')
    this.name = 'TrustedStoreScopeError'
  }
}

export class NormalizedStoreUnavailableError extends Error {
  constructor() {
    super('当前门店不可用')
    this.name = 'NormalizedStoreUnavailableError'
  }
}

export class PostgresNormalizedBusinessClock implements NormalizedBusinessClock {
  constructor(private readonly transactions: ScopedPostgresTransactionRunner) {}

  current(scope: Readonly<StoreScope>): Promise<CurrentBusinessDay> {
    return this.transactions.run(scope, async (transaction) => {
      const result = await transaction.query<BusinessDayRow>(`
        SELECT
          (((clock_timestamp() AT TIME ZONE timezone) - business_day_cutoff)::date)::text
            AS business_date,
          timezone,
          business_day_cutoff::text AS cutoff
        FROM mbox.stores
        WHERE tenant_id = $1::uuid AND id = $2::uuid AND status = 'active'
      `, [scope.tenantId, scope.storeId])
      const row = result.rows[0]
      if (result.rowCount !== 1 || row === undefined) throw new NormalizedStoreUnavailableError()
      return {
        businessDate: row.business_date,
        timezone: row.timezone,
        cutoff: row.cutoff,
      }
    }, { readOnly: true })
  }
}

export class NormalizedRequestContextResolver {
  constructor(
    private readonly scopeResolver: TrustedStoreScopeResolver,
    private readonly authentication: StaffSessionAuthenticationPort,
    private readonly businessClock: NormalizedBusinessClock,
  ) {}

  async resolve(request: FastifyRequest): Promise<NormalizedOperationsRequestContext> {
    const scope = await this.resolveTrustedScope(request)
    const token = readRequestToken(request, STAFF_SESSION_COOKIE)
    const [authenticated, businessDay] = await Promise.all([
      this.authentication.authenticateSession(scope, token),
      this.businessClock.current(scope),
    ])
    return toOperationsContext(scope, authenticated, businessDay.businessDate)
  }

  async resolveTrustedScope(request: FastifyRequest): Promise<Readonly<StoreScope>> {
    const scope = await this.scopeResolver.resolve(request)
    if (!isUuid(scope.tenantId) || !isUuid(scope.storeId)) throw new TrustedStoreScopeError()
    return Object.freeze({ tenantId: scope.tenantId, storeId: scope.storeId })
  }
}

export function fixedStoreScopeResolver(scope: Readonly<StoreScope>): TrustedStoreScopeResolver {
  if (!isUuid(scope.tenantId) || !isUuid(scope.storeId)) throw new TrustedStoreScopeError()
  const trusted = Object.freeze({ tenantId: scope.tenantId, storeId: scope.storeId })
  return { resolve: () => trusted }
}

export function readRequestToken(
  request: FastifyRequest,
  cookieName: string,
  headerName?: string,
): string {
  const bearer = readBearer(request.headers.authorization)
  const headerToken = headerName ? readOpaqueHeader(request.headers[headerName]) : null
  const cookie = readCookie(request.headers.cookie, cookieName)
  const present = [bearer, headerToken, cookie].filter((value): value is string => value !== null)
  if (new Set(present).size > 1) {
    throw new NormalizedAuthenticationRequiredError('登录凭证冲突，请重新登录')
  }
  const token = bearer ?? headerToken ?? cookie
  if (token === null || token.length < 32 || token.length > 256) {
    throw new NormalizedAuthenticationRequiredError()
  }
  return token
}

function toOperationsContext(
  scope: Readonly<StoreScope>,
  authenticated: AuthenticatedStaffSession,
  businessDate: string,
): NormalizedOperationsRequestContext {
  return {
    scope,
    employeeId: authenticated.session.employeeId,
    businessDate,
    capabilities: Object.freeze([...authenticated.access.permissions]),
  }
}

function readBearer(authorization: string | undefined): string | null {
  if (authorization === undefined) return null
  const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(authorization)
  if (!match?.[1]) throw new NormalizedAuthenticationRequiredError('登录凭证格式无效')
  return match[1]
}

function readOpaqueHeader(value: string | string[] | undefined): string | null {
  if (value === undefined) return null
  if (Array.isArray(value)) {
    if (value.length === 0) return null
    if (value.length > 1) throw new NormalizedAuthenticationRequiredError('登录凭证重复，请重新登录')
    return readOpaqueHeader(value[0])
  }
  const token = value.trim()
  if (!token) return null
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) {
    throw new NormalizedAuthenticationRequiredError('登录凭证格式无效')
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
      throw new NormalizedAuthenticationRequiredError('登录凭证重复，请重新登录')
    }
    found = value
  }
  return found
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}
