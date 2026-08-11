import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EffectiveStaffAccess } from './staff-access-repository.js'
import type { AuthenticatedStaffSession } from './staff-auth-command-service.js'
import {
  NormalizedAuthenticationRequiredError,
  NormalizedRequestContextResolver,
  PostgresNormalizedBusinessClock,
  STAFF_SESSION_COOKIE,
  fixedStoreScopeResolver,
} from './normalized-request-context.js'
import { normalizedOperationsApiPlugin } from './normalized-operations-api.js'
import type { StaffSession } from './staff-session-repository.js'
import type { ScopedPostgresTransactionRunner, ScopedTransaction } from './transaction-runner.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const storeId = '22222222-2222-4222-8222-222222222222'
const employeeId = '33333333-3333-4333-8333-333333333333'
const token = 'a'.repeat(43)

const session: StaffSession = {
  id: '44444444-4444-4444-8444-444444444444',
  employeeId,
  deviceAccessLeaseId: '55555555-5555-4555-8555-555555555555',
  issuedAt: '2026-08-11T04:00:00.000Z',
  expiresAt: '2026-08-11T10:00:00.000Z',
  lastHeartbeatAt: '2026-08-11T04:00:00.000Z',
  onlineLeaseUntil: '2026-08-11T04:01:30.000Z',
  isOnline: true,
  revokedAt: null,
}

const apps: FastifyInstance[] = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

describe('NormalizedRequestContextResolver', () => {
  it('uses only the trusted server scope and database business date', async () => {
    const authenticateSession = vi.fn(async (): Promise<AuthenticatedStaffSession> => ({
      session,
      access: access(['dashboard.view']),
    }))
    const businessClock = {
      current: vi.fn(async () => ({
        businessDate: '2026-08-10',
        timezone: 'Asia/Shanghai',
        cutoff: '06:00:00',
      })),
    }
    const resolver = new NormalizedRequestContextResolver(
      fixedStoreScopeResolver({ tenantId, storeId }),
      { authenticateSession },
      businessClock,
    )
    const app = Fastify()
    apps.push(app)
    app.get('/context', async (request, reply) => {
      try {
        return await resolver.resolve(request)
      } catch (error) {
        if (error instanceof NormalizedAuthenticationRequiredError) {
          return reply.code(401).send({ error: { code: 'AUTH_REQUIRED' } })
        }
        throw error
      }
    })

    const response = await app.inject({
      method: 'GET',
      url: '/context?tenantId=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa&businessDate=2099-01-01',
      headers: {
        authorization: `Bearer ${token}`,
        'x-tenant-id': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'x-store-id': 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        'x-employee-id': 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        'x-capabilities': '*',
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      scope: { tenantId, storeId },
      employeeId,
      businessDate: '2026-08-10',
      capabilities: ['dashboard.view'],
    })
    expect(authenticateSession).toHaveBeenCalledWith({ tenantId, storeId }, token)
    expect(businessClock.current).toHaveBeenCalledWith({ tenantId, storeId })
  })

  it('accepts the secure session cookie and rejects conflicting credentials', async () => {
    const resolver = new NormalizedRequestContextResolver(
      fixedStoreScopeResolver({ tenantId, storeId }),
      { authenticateSession: async () => ({ session, access: access(['dashboard.view']) }) },
      {
        current: async () => ({
          businessDate: '2026-08-11',
          timezone: 'Asia/Shanghai',
          cutoff: '06:00:00',
        }),
      },
    )
    const app = Fastify()
    apps.push(app)
    app.get('/context', async (request, reply) => {
      try {
        return await resolver.resolve(request)
      } catch (error) {
        if (error instanceof NormalizedAuthenticationRequiredError) {
          return reply.code(401).send({ error: { code: 'AUTH_REQUIRED' } })
        }
        throw error
      }
    })

    const cookieResponse = await app.inject({
      method: 'GET',
      url: '/context',
      headers: { cookie: `${STAFF_SESSION_COOKIE}=${token}` },
    })
    expect(cookieResponse.statusCode).toBe(200)

    const conflict = await app.inject({
      method: 'GET',
      url: '/context',
      headers: {
        authorization: `Bearer ${'b'.repeat(43)}`,
        cookie: `${STAFF_SESSION_COOKIE}=${token}`,
      },
    })
    expect(conflict.statusCode).toBe(401)
    expect(conflict.json()).toEqual({ error: { code: 'AUTH_REQUIRED' } })
  })

  it('re-resolves live permissions on every operation request', async () => {
    let permissions = ['dashboard.view']
    const authenticateSession = vi.fn(async (): Promise<AuthenticatedStaffSession> => ({
      session,
      access: access(permissions),
    }))
    const resolver = new NormalizedRequestContextResolver(
      fixedStoreScopeResolver({ tenantId, storeId }),
      { authenticateSession },
      {
        current: async () => ({
          businessDate: '2026-08-11',
          timezone: 'Asia/Shanghai',
          cutoff: '06:00:00',
        }),
      },
    )
    const app = Fastify()
    apps.push(app)
    const getStaffView = vi.fn(async () => ({
      store: {
        id: storeId,
        code: 'lujiazui',
        name: 'M-BOX',
        timezone: 'Asia/Shanghai',
        businessDayCutoff: '06:00:00',
      },
      actor: {
        id: employeeId,
        employeeCode: 'LIYAN',
        displayName: '李艳',
        roleCodes: ['MANAGER'],
        roleNames: ['店长'],
        capabilities: permissions,
      },
      tables: [],
      tasks: [],
    }))
    app.register(normalizedOperationsApiPlugin, {
      prefix: '/api',
      operationsQuery: { getStaffView },
      resolveContext: (request) => resolver.resolve(request),
      tableSessions: { open: async () => { throw new Error('not used') } },
      commandExecutor: { execute: async () => { throw new Error('not used') } },
      createTableSessionRepository: () => ({
        beginClosing: async () => { throw new Error('not used') },
        completeClosing: async () => { throw new Error('not used') },
      }),
      createServiceTaskRepository: () => ({
        create: async () => { throw new Error('not used') },
        acknowledge: async () => { throw new Error('not used') },
        start: async () => { throw new Error('not used') },
        complete: async () => { throw new Error('not used') },
        cancel: async () => { throw new Error('not used') },
      }),
    })

    const first = await app.inject({
      method: 'GET',
      url: '/api/operations',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(first.statusCode).toBe(200)

    permissions = []
    const afterRevocation = await app.inject({
      method: 'GET',
      url: '/api/operations',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(afterRevocation.statusCode).toBe(403)
    expect(afterRevocation.json()).toMatchObject({
      error: { code: 'CAPABILITY_FORBIDDEN' },
    })
    expect(authenticateSession).toHaveBeenCalledTimes(2)
    expect(getStaffView).toHaveBeenCalledTimes(1)
  })
})

describe('PostgresNormalizedBusinessClock', () => {
  it('derives the business date in PostgreSQL using store timezone and cutoff', async () => {
    const query = vi.fn(async () => ({
      rows: [{ business_date: '2026-08-10', timezone: 'Asia/Shanghai', cutoff: '06:00:00' }],
      rowCount: 1,
    }))
    const transaction: ScopedTransaction = {
      scope: { tenantId, storeId },
      query,
    }
    const transactions = {
      run: async (_scope: unknown, operation: (value: ScopedTransaction) => Promise<unknown>) => operation(transaction),
    } as unknown as ScopedPostgresTransactionRunner
    const clock = new PostgresNormalizedBusinessClock(transactions)

    await expect(clock.current({ tenantId, storeId })).resolves.toEqual({
      businessDate: '2026-08-10',
      timezone: 'Asia/Shanghai',
      cutoff: '06:00:00',
    })
    expect(query.mock.calls[0]?.[0]).toContain('clock_timestamp() AT TIME ZONE timezone')
    expect(query.mock.calls[0]?.[0]).toContain('business_day_cutoff')
  })
})

function access(permissions: string[]): EffectiveStaffAccess {
  return {
    employeeId,
    employeeCode: 'LIYAN',
    displayName: '李艳',
    roleCodes: ['MANAGER'],
    permissions,
    deniedPermissions: [],
    dataScopes: [],
    approvalLimits: [],
    navigation: [],
    resolvedAt: '2026-08-11T04:00:00.000Z',
  }
}
