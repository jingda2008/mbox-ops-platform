import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CommandOutcome, IdempotentCommand } from './command-executor.js'
import {
  normalizedNotificationApiPlugin,
  type NormalizedNotificationApiOptions,
} from './notification-api.js'
import type { NotificationRecord } from './notification-repository.js'
import type { ScopedTransaction } from './transaction-runner.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const storeId = '22222222-2222-4222-8222-222222222222'
const employeeId = '33333333-3333-4333-8333-333333333333'
const notificationId = '44444444-4444-4444-8444-444444444444'

const notification: NotificationRecord = {
  id: notificationId,
  businessKey: 'service:vip1:ready:server',
  sourceOutboxMessageId: null,
  channel: 'in_app',
  recipient: { type: 'employee', id: employeeId },
  templateCode: 'service.ready',
  payload: { tableCode: 'VIP1' },
  status: 'failed',
  availableAt: '2026-08-11T12:00:00.000Z',
  deliveredAt: null,
  attempts: 1,
  maxAttempts: 5,
  failureCode: 'delivery_failed:timeout',
  deadAt: null,
  cancelledAt: null,
  createdAt: '2026-08-11T11:59:00.000Z',
  updatedAt: '2026-08-11T12:00:00.000Z',
}

const transaction: ScopedTransaction = {
  scope: { tenantId, storeId },
  query: async () => ({ rows: [], rowCount: 0 }),
}

const apps: FastifyInstance[] = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

function fixture(overrides: Partial<NormalizedNotificationApiOptions> = {}) {
  const notificationQuery = { list: vi.fn(async () => [notification]) }
  const repository = { retryFailed: vi.fn(async () => ({ ...notification, failureCode: null })) }
  const outcomes: CommandOutcome<unknown>[] = []
  const commandExecutor = {
    execute: vi.fn(async <Result>(
      _command: Readonly<IdempotentCommand<Result>>,
      handler: (value: ScopedTransaction) => Promise<CommandOutcome<Result>>,
    ) => {
      const outcome = await handler(transaction)
      outcomes.push(outcome as CommandOutcome<unknown>)
      return { value: outcome.result, replayed: false }
    }),
  }
  const options: NormalizedNotificationApiOptions = {
    commandExecutor,
    notificationQuery,
    resolveContext: () => ({
      scope: { tenantId, storeId },
      employeeId,
      businessDate: '2026-08-11',
      capabilities: ['notification.view', 'notification.view_all', 'notification.retry'],
    }),
    createNotificationRepository: () => repository,
    ...overrides,
  }
  const app = Fastify()
  apps.push(app)
  app.register(normalizedNotificationApiPlugin, { ...options, prefix: '/api' })
  return { app, notificationQuery, repository, commandExecutor, outcomes }
}

describe('normalizedNotificationApiPlugin', () => {
  it('returns operational metadata without exposing notification payload content', async () => {
    const value = fixture()
    const response = await value.app.inject({
      method: 'GET',
      url: `/api/notifications?status=failed,pending&recipientType=employee&recipientId=${employeeId}`,
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ data: [{ id: notificationId, status: 'failed' }] })
    expect(response.body).not.toContain('tableCode')
    expect(value.notificationQuery.list).toHaveBeenCalledWith(
      { tenantId, storeId },
      expect.objectContaining({
        statuses: ['failed', 'pending'],
        recipient: { type: 'employee', id: employeeId },
      }),
    )
  })

  it('requires permission and a human reason before retrying', async () => {
    const denied = fixture({
      resolveContext: () => ({
        scope: { tenantId, storeId },
        employeeId,
        businessDate: '2026-08-11',
        capabilities: ['notification.view'],
      }),
    })
    const deniedResponse = await denied.app.inject({
      method: 'POST',
      url: `/api/notifications/${notificationId}/retry`,
      headers: { 'idempotency-key': 'notification-retry-0001' },
      payload: { reason: '再次发送' },
    })
    expect(deniedResponse.statusCode).toBe(403)
    expect(denied.repository.retryFailed).not.toHaveBeenCalled()

    const allowed = fixture()
    const missingReason = await allowed.app.inject({
      method: 'POST',
      url: `/api/notifications/${notificationId}/retry`,
      headers: { 'idempotency-key': 'notification-retry-0002' },
      payload: {},
    })
    expect(missingReason.statusCode).toBe(400)
  })

  it('defaults ordinary employees to their own notifications and rejects wider reads', async () => {
    const value = fixture({
      resolveContext: () => ({
        scope: { tenantId, storeId },
        employeeId,
        businessDate: '2026-08-11',
        capabilities: ['notification.view'],
      }),
    })
    const own = await value.app.inject({ method: 'GET', url: '/api/notifications' })
    expect(own.statusCode).toBe(200)
    expect(value.notificationQuery.list).toHaveBeenCalledWith(
      { tenantId, storeId },
      expect.objectContaining({ recipient: { type: 'employee', id: employeeId } }),
    )

    const wider = await value.app.inject({
      method: 'GET',
      url: '/api/notifications?recipientType=role&recipientId=55555555-5555-4555-8555-555555555555',
    })
    expect(wider.statusCode).toBe(403)
  })

  it('retries idempotently and writes a privacy-safe audit event', async () => {
    const value = fixture()
    const response = await value.app.inject({
      method: 'POST',
      url: `/api/notifications/${notificationId}/retry`,
      headers: { 'idempotency-key': 'notification-retry-0003' },
      payload: { reason: '现场网络恢复后重新发送' },
    })

    expect(response.statusCode).toBe(200)
    expect(value.repository.retryFailed).toHaveBeenCalledWith(notificationId)
    expect(value.outcomes[0]?.auditEvents[0]).toMatchObject({
      actor: { type: 'employee', employeeId },
      action: 'notification.manual_retry.v1',
      reason: '现场网络恢复后重新发送',
      afterData: { status: 'failed', channel: 'in_app', attempts: 1 },
    })
    expect(JSON.stringify(value.outcomes[0])).not.toContain('tableCode')
  })
})
