import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { RuntimeState } from '../src/shared/contracts.js'
import type { RuntimeRepository } from './repository.js'
import { requireConfiguredOperation } from './authorization.js'

export function retryCustomerNotification(
  state: RuntimeState,
  notificationId: string,
  actorId: string,
  now = new Date(),
) {
  const notification = state.customerNotifications.find((item) => item.id === notificationId)
  if (!notification) throw new Error('通知记录不存在')
  if (notification.status !== 'failed') throw new Error('只有发送失败的通知可以人工重试')
  notification.status = 'queued'
  notification.failureReason = null
  notification.lastErrorCode = null
  notification.providerMessageId = null
  notification.leaseOwner = null
  notification.leaseExpiresAt = null
  notification.nextAttemptAt = now.toISOString()
  state.auditEntries.push({
    id: `audit_${randomUUID()}`,
    actorId,
    action: 'customer.notification_manual_retry.v1',
    objectType: 'customerNotification',
    objectId: notification.id,
    occurredAt: now.toISOString(),
    details: { channel: notification.channel, attemptCount: notification.attemptCount ?? 0 },
  })
  state.revision += 1
  return notification
}

export function registerNotificationRoutes(app: FastifyInstance, repository: RuntimeRepository) {
  app.post<{ Params: { notificationId: string } }>('/api/notifications/:notificationId/retry', async (request) => {
    return repository.mutate((state) => {
      const actor = requireConfiguredOperation(request, state, 'notification.retry')
      return retryCustomerNotification(state, request.params.notificationId, actor.actorId)
    })
  })
}
