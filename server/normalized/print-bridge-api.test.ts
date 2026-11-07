import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import { printBridgeApiPlugin } from './print-bridge-api.js'
import type { PrintBridgeRepository } from './print-bridge-repository.js'
import { NormalizedAuthenticationRequiredError } from './normalized-request-context.js'
import type { ScopedTransaction } from './transaction-runner.js'

const scope = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  storeId: '22222222-2222-4222-8222-222222222222',
}
const employeeId = '33333333-3333-4333-8333-333333333333'

describe('print bridge API', () => {
  it('returns 401 instead of an internal error when the staff session is missing', async () => {
    const repository = { list: vi.fn() }
    const app = Fastify()
    await app.register(printBridgeApiPlugin, {
      ...options(repository, []),
      resolveStaffContext: async () => { throw new NormalizedAuthenticationRequiredError() },
      prefix: '/api',
    })

    const response = await app.inject({ method: 'GET', url: '/api/hardware/print-bridges' })

    expect(response.statusCode).toBe(401)
    expect(response.json()).toEqual({
      error: { code: 'AUTH_REQUIRED', message: '登录信息无效或已过期，请重新登录' },
    })
    expect(repository.list).not.toHaveBeenCalled()
    await app.close()
  })

  it('returns 403 to an authenticated employee without printer authority', async () => {
    const repository = { list: vi.fn() }
    const app = Fastify()
    await app.register(printBridgeApiPlugin, { ...options(repository, []), prefix: '/api' })
    const response = await app.inject({ method: 'GET', url: '/api/hardware/print-bridges' })
    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ error: { code: 'PRINT_BRIDGE_ACCESS_DENIED' } })
    expect(repository.list).not.toHaveBeenCalled()
    await app.close()
  })

  it('authenticates a paired device before returning bridge-pull work', async () => {
    const authenticate = vi.fn(async () => ({
      id: '44444444-4444-4444-8444-444444444444',
      publicId: 'print-bridge-1234567890abcdef',
    }))
    const claim = vi.fn(async () => ({ jobs: [], commands: [] }))
    const repository = { authenticate, claim }
    const app = Fastify()
    await app.register(printBridgeApiPlugin, { ...options(repository, ['printer.manage']), prefix: '/api' })
    const response = await app.inject({
      method: 'POST', url: '/api/print-bridge/work/claim',
      headers: {
        'x-mbox-print-bridge-id': 'print-bridge-1234567890abcdef',
        authorization: `Bearer ${'a'.repeat(43)}`,
      },
      payload: { limit: 5 },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ data: { jobs: [], commands: [] } })
    expect(authenticate).toHaveBeenCalledWith('print-bridge-1234567890abcdef', 'a'.repeat(43))
    expect(claim).toHaveBeenCalledWith(expect.objectContaining({ publicId: 'print-bridge-1234567890abcdef' }), 5)
    await app.close()
  })
})


const bridgeCases = [
  { name: 'heartbeat', url: '/print-bridge/heartbeat', method: 'heartbeat',
    payload: { hostname: 'isolated-host', softwareVersion: '1.0.0', queues: ['TEST_QUEUE'] }, result: { accepted: true } },
  { name: 'work claim', url: '/print-bridge/work/claim', method: 'claim',
    payload: { limit: 5 }, result: { jobs: [], commands: [] } },
  { name: 'print result', url: '/print-bridge/jobs/44444444-4444-4444-8444-444444444444/result', method: 'recordPrintResult',
    payload: { outcome: 'printed' }, result: { accepted: true } },
  { name: 'command result', url: '/print-bridge/commands/44444444-4444-4444-8444-444444444444/result', method: 'recordCommandResult',
    payload: { outcome: 'succeeded' }, result: { accepted: true } },
]

describe.each(bridgeCases)('print bridge transaction completion: $name', (fixture) => {
  it.each([false, true])('sends a response only after transaction completion (commit failure: %s)', async (failCommit) => {
    const operationFinished = Promise.withResolvers<void>()
    const releaseCommit = Promise.withResolvers<void>()
    let committed = false
    let sentBeforeCommit = false
    const repository = {
      authenticate: vi.fn(async () => ({ id: employeeId, publicId: 'print-bridge-test' })),
      [fixture.method]: vi.fn(async () => fixture.result),
    }
    const app = Fastify()
    app.addHook('onSend', async (_request, reply, payload) => {
      if (reply.statusCode === 200 && !committed) sentBeforeCommit = true
      return payload
    })
    await app.register(printBridgeApiPlugin, {
      ...options(repository, []),
      transactions: {
        run: async <Result>(_scope: typeof scope, operation: (tx: ScopedTransaction) => Promise<Result>) => {
          const result = await operation({ scope } as ScopedTransaction)
          operationFinished.resolve()
          await releaseCommit.promise
          if (failCommit) throw new Error('isolated commit failure')
          committed = true
          return result
        },
      },
    })
    const responsePromise = app.inject({ method: 'POST', url: fixture.url,
      headers: { 'x-mbox-print-bridge-id': 'print-bridge-test', authorization: `Bearer ${'a'.repeat(43)}` },
      payload: fixture.payload }).then(response => response)
    try {
      await operationFinished.promise
      const prematureSuccess = sentBeforeCommit
      releaseCommit.resolve()
      const response = await responsePromise
      expect(prematureSuccess, 'success must not precede COMMIT').toBe(false)
      expect(response.statusCode).toBe(failCommit ? 500 : 200)
      if (!failCommit) expect(response.json()).toEqual({ data: fixture.result })
      else expect(response.json()).not.toHaveProperty('data')
      expect(repository[fixture.method]).toHaveBeenCalledTimes(1)
    } finally {
      releaseCommit.resolve()
      await responsePromise
      await app.close()
    }
  })
})

function options(repository: Record<string, unknown>, capabilities: string[]) {
  const transaction = { scope } as ScopedTransaction
  return {
    scope,
    transactions: {
      run: async <Result>(_scope: typeof scope, operation: (value: ScopedTransaction) => Promise<Result>) => operation(transaction),
    },
    hashSecret: 'unit-test-secret-value',
    requireHttps: false,
    resolveStaffContext: async () => ({
      scope, actor: { type: 'employee' as const, employeeId }, employeeId,
      businessDate: '2026-08-24', capabilities,
    }),
    createRepository: () => repository as unknown as PrintBridgeRepository,
  }
}
