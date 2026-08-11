import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import {
  AiCapabilityNotFoundError,
  AiCapabilityValidationError,
  type AiCapabilityCenter,
} from './ai-capability-center.js'
import { aiExecutionApiPlugin } from './ai-execution-api.js'
import { StaffAccessDeniedError } from './staff-access-repository.js'

const context = {
  scope: {
    tenantId: '92600000-0000-4000-8000-000000000001',
    storeId: '92600000-0000-4000-8000-000000000002',
  },
  employeeId: '92600000-0000-4000-8000-000000000003',
  businessDate: '2026-08-11',
}

describe('AI execution API', () => {
  it('passes only trusted employee context and structured proposal to the center', async () => {
    const execute = vi.fn(async (input) => ({
      requestId: '92600000-0000-4000-8000-000000000004',
      toolName: input.proposal.toolName,
      status: 'succeeded' as const,
      message: '已执行',
      requiresHumanConfirmation: false,
      runAt: new Date().toISOString(),
      candidates: [],
      result: { tableCode: 'L01', guestCount: 3 },
      replayed: false,
    }))
    const app = await buildApp(execute)
    const response = await app.inject({
      method: 'POST',
      url: '/ai/executions',
      headers: { 'idempotency-key': 'api-open-table-0001' },
      payload: {
        employeeId: 'attacker-controlled',
        tenantId: 'attacker-controlled',
        toolName: 'table.open',
        arguments: { tableCode: 'L01', guestCount: 3 },
      },
    })
    expect(response.statusCode).toBe(200)
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      context,
      proposal: {
        toolName: 'table.open',
        arguments: { tableCode: 'L01', guestCount: 3 },
        runAt: null,
      },
      idempotencyKey: 'api-open-table-0001',
    }))
    await app.close()
  })

  it('converts delay seconds to an absolute server time', async () => {
    const execute = vi.fn(async (input) => ({
      requestId: '92600000-0000-4000-8000-000000000004',
      toolName: input.proposal.toolName,
      status: 'scheduled' as const,
      message: '已安排',
      requiresHumanConfirmation: false,
      runAt: input.proposal.runAt!,
      candidates: [],
      result: {},
      replayed: false,
    }))
    const app = await buildApp(execute)
    const before = Date.now()
    const response = await app.inject({
      method: 'POST',
      url: '/ai/executions',
      headers: { 'idempotency-key': 'api-delay-water-0001' },
      payload: {
        toolName: 'service.water.assign',
        arguments: { tableCode: 'K2', employeeName: 'Tom', quantity: 2 },
        delaySeconds: 300,
      },
    })
    expect(response.statusCode).toBe(202)
    const runAt = new Date(execute.mock.calls[0]![0].proposal.runAt!).getTime()
    expect(runAt).toBeGreaterThanOrEqual(before + 299_000)
    expect(runAt).toBeLessThanOrEqual(Date.now() + 301_000)
    await app.close()
  })

  it('returns actionable detail requests instead of internal errors', async () => {
    const app = await buildApp(vi.fn(async () => {
      throw new AiCapabilityValidationError('开台前请说明人数，系统不会默认2人')
    }))
    const response = await app.inject({
      method: 'POST',
      url: '/ai/executions',
      headers: { 'idempotency-key': 'api-missing-count-0001' },
      payload: { toolName: 'table.open', arguments: { tableCode: 'L01' } },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({
      error: {
        code: 'AI_COMMAND_NEEDS_DETAILS',
        message: '开台前请说明人数，系统不会默认2人',
      },
    })
    await app.close()
  })

  it.each([
    [new StaffAccessDeniedError('internal employee detail'), 403, 'AI_EXECUTION_FORBIDDEN'],
    [new AiCapabilityNotFoundError('unknown.tool'), 404, 'AI_CAPABILITY_NOT_FOUND'],
  ] as const)('maps expected failures without leaking internal details', async (error, status, code) => {
    const app = await buildApp(vi.fn(async () => { throw error }))
    const response = await app.inject({
      method: 'POST',
      url: '/ai/executions',
      headers: { 'idempotency-key': 'api-error-case-0001' },
      payload: { toolName: 'unknown.tool', arguments: {} },
    })
    expect(response.statusCode).toBe(status)
    expect(response.json().error.code).toBe(code)
    expect(response.body).not.toContain('internal employee detail')
    await app.close()
  })
})

async function buildApp(execute: ReturnType<typeof vi.fn>) {
  const app = Fastify()
  await app.register(async (scoped) => {
    await scoped.register(aiExecutionApiPlugin, {
      center: {
        execute,
        list: () => [{
          name: 'table.open',
          description: '开台',
          requiredPermissions: ['table.open'],
          requiresHumanConfirmation: false,
        }],
      } as Pick<AiCapabilityCenter, 'execute' | 'list'>,
      resolveContext: () => context,
    })
  }, { prefix: '/ai' })
  return app
}
