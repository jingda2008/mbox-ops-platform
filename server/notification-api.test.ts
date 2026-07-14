import { describe, expect, it } from 'vitest'
import Fastify from 'fastify'
import { registerNotificationRoutes, retryCustomerNotification } from './notification-api.js'
import { createSeedState } from './seed.js'
import { JsonRepository } from './repository.js'
import { AuthorizationError } from './authorization.js'

describe('notification manual retry', () => {
  it('moves a failed notification back to the due queue with audit', () => {
    const state = createSeedState()
    state.customerNotifications.push({
      id: 'notification-failed', memberId: 'member-amy', benefitId: 'benefit-instance', campaignId: null,
      channel: 'service_account', status: 'failed', templateCode: 'BENEFIT_GRANTED', content: 'test',
      queuedAt: '2026-07-14T10:00:00.000Z', sentAt: null, failureReason: 'provider rejected', adapter: 'service_account',
      attemptCount: 5, lastAttemptAt: '2026-07-14T10:05:00.000Z', nextAttemptAt: null,
      providerMessageId: null, lastErrorCode: 'PROVIDER_REJECTED',
    })
    const retried = retryCustomerNotification(state, 'notification-failed', 'emp-chen', new Date('2026-07-14T11:00:00.000Z'))
    expect(retried).toMatchObject({ status: 'queued', nextAttemptAt: '2026-07-14T11:00:00.000Z', failureReason: null })
    expect(state.auditEntries.at(-1)?.action).toBe('customer.notification_manual_retry.v1')
  })

  it('does not requeue sent or skipped notifications', () => {
    const state = createSeedState()
    state.customerNotifications.push({
      id: 'notification-sent', memberId: 'member-amy', benefitId: 'benefit-instance', campaignId: null,
      channel: 'wecom', status: 'sent', templateCode: 'BENEFIT_GRANTED', content: 'test',
      queuedAt: '2026-07-14T10:00:00.000Z', sentAt: '2026-07-14T10:01:00.000Z', failureReason: null, adapter: 'wecom',
      attemptCount: 1, lastAttemptAt: '2026-07-14T10:01:00.000Z', nextAttemptAt: null,
      providerMessageId: 'provider-1', lastErrorCode: null,
    })
    expect(() => retryCustomerNotification(state, 'notification-sent', 'emp-chen')).toThrow('只有发送失败的通知可以人工重试')
  })

  it('lets supervisors retry failed notifications and rejects service roles with a structured 403', async () => {
    const repository = new JsonRepository(`/tmp/mbox-notification-rbac-${crypto.randomUUID()}.json`)
    await repository.init()
    await repository.mutate((state) => {
      state.customerNotifications.push({
        id: 'notification-route-failed', memberId: 'member-amy', benefitId: 'benefit-instance', campaignId: null,
        channel: 'service_account', status: 'failed', templateCode: 'BENEFIT_GRANTED', content: 'test',
        queuedAt: '2026-07-14T10:00:00.000Z', sentAt: null, failureReason: 'provider rejected', adapter: 'service_account',
        attemptCount: 1, lastAttemptAt: '2026-07-14T10:05:00.000Z', nextAttemptAt: null,
        providerMessageId: null, lastErrorCode: 'PROVIDER_REJECTED',
      })
      state.revision += 1
    })
    const app = Fastify()
    app.decorateRequest('mboxActor', null)
    app.addHook('preHandler', async (request) => {
      const supervisor = request.headers['x-test-role'] === 'supervisor'
      request.mboxActor = {
        actorId: supervisor ? 'emp-mia' : 'emp-lin',
        storeId: 'mbox-lujiazui',
        roleId: supervisor ? 'supervisor' : 'server',
        runtimeMode: 'test',
        authenticatedBy: 'local_header',
      }
    })
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof AuthorizationError) {
        return reply.status(error.statusCode).send({ code: error.code, operation: error.operation })
      }
      throw error
    })
    registerNotificationRoutes(app, repository)

    const denied = await app.inject({ method: 'POST', url: '/api/notifications/notification-route-failed/retry' })
    expect(denied.statusCode).toBe(403)
    expect(denied.json()).toEqual({ code: 'AUTHORIZATION_DENIED', operation: 'notification.retry' })
    expect((await repository.read()).customerNotifications.find((item) => item.id === 'notification-route-failed')?.status)
      .toBe('failed')

    const allowed = await app.inject({
      method: 'POST',
      url: '/api/notifications/notification-route-failed/retry',
      headers: { 'x-test-role': 'supervisor' },
    })
    expect(allowed.statusCode).toBe(200)
    expect(allowed.json().status).toBe('queued')

    await app.close()
    await repository.close()
  })
})
