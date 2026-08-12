import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import {
  IdempotencyConflictError,
  IdempotencyInProgressError,
  IdempotencyRecordError,
  type JsonCodec,
  type NormalizedCommandExecutor,
} from './command-executor.js'
import type { NormalizedOperationsRequestContext } from './normalized-operations-api.js'
import type { NotificationQueryService } from './notification-query-service.js'
import {
  NotificationNotFoundError,
  NotificationPolicyError,
  NotificationRepository,
  NotificationRetryNotAllowedError,
  type NotificationRecipientType,
  type NotificationRecord,
  type NotificationStatus,
} from './notification-repository.js'
import type { ScopedTransaction } from './transaction-runner.js'

type CommandExecutorPort = Pick<NormalizedCommandExecutor, 'execute'>
type NotificationQueryPort = Pick<NotificationQueryService, 'list'>

export interface NormalizedNotificationApiOptions {
  commandExecutor: CommandExecutorPort
  notificationQuery: NotificationQueryPort
  resolveContext(request: FastifyRequest): Promise<NormalizedOperationsRequestContext>
    | NormalizedOperationsRequestContext
  createNotificationRepository(transaction: ScopedTransaction): Pick<NotificationRepository, 'retryFailed'>
}

interface RetryResult {
  id: string
  status: NotificationStatus
  availableAt: string
}

const retryResultCodec: JsonCodec<RetryResult> = {
  encode: (value) => ({
    id: value.id,
    status: value.status,
    availableAt: value.availableAt,
  }),
  decode: (value) => {
    const record = readObject(value)
    return {
      id: readString(record.id, 'notificationId', 36),
      status: readStatus(record.status),
      availableAt: readString(record.availableAt, 'availableAt', 64),
    }
  },
}

export const normalizedNotificationApiPlugin: FastifyPluginAsync<NormalizedNotificationApiOptions> = async (
  app,
  options,
) => {
  app.get('/notifications', async (request, reply) => handleRoute(reply, async () => {
    const context = await options.resolveContext(request)
    requireCapability(context, 'notification.view')
    const query = applyNotificationReadScope(context, readQuery(request.query))
    const notifications = await options.notificationQuery.list(context.scope, query)
    return reply.send({ data: notifications.map(toStaffNotification) })
  }))

  app.post<{ Params: { notificationId: string } }>(
    '/notifications/:notificationId/retry',
    async (request, reply) => handleRoute(reply, async () => {
      const context = await options.resolveContext(request)
      requireCapability(context, 'notification.retry')
      const notificationId = readUuid(request.params.notificationId, 'notificationId')
      const body = readObject(request.body)
      const reason = readString(body.reason, '重试原因', 200, 3)
      const idempotencyKey = readIdempotencyKey(request)
      const execution = await options.commandExecutor.execute({
        scope: context.scope,
        operationScope: 'notification.retry',
        idempotencyKey,
        requestFingerprint: JSON.stringify({ notificationId, reason, employeeId: context.employeeId }),
        resultCodec: retryResultCodec,
      }, async (transaction) => {
        const notification = await options.createNotificationRepository(transaction).retryFailed(notificationId)
        const result: RetryResult = {
          id: notification.id,
          status: notification.status,
          availableAt: notification.availableAt,
        }
        return {
          result,
          auditEvents: [{
            actor: { type: 'employee', employeeId: context.employeeId },
            action: 'notification.manual_retry.v1',
            objectType: 'notification',
            objectId: notification.id,
            businessDate: context.businessDate,
            reason,
            afterData: {
              status: notification.status,
              channel: notification.channel,
              attempts: notification.attempts,
            },
          }],
          outboxMessages: [],
        }
      })
      return reply.send({ data: execution.value, replayed: execution.replayed })
    }),
  )
}

function applyNotificationReadScope(
  context: NormalizedOperationsRequestContext,
  query: ReturnType<typeof readQuery>,
): ReturnType<typeof readQuery> {
  if (context.capabilities.includes('notification.view_all')) return query
  if (query.recipient === undefined) {
    return { ...query, recipient: { type: 'employee', id: context.employeeId } }
  }
  if (query.recipient.type !== 'employee' || query.recipient.id !== context.employeeId) {
    throw new NotificationCapabilityDeniedError()
  }
  return query
}

function readQuery(value: unknown) {
  const query = readObject(value ?? {})
  const statusValues = typeof query.status === 'string'
    ? query.status.split(',').map((status) => readStatus(status.trim()))
    : undefined
  const recipientType = query.recipientType === undefined
    ? undefined
    : readRecipientType(query.recipientType)
  const recipientId = query.recipientId === undefined
    ? undefined
    : readString(query.recipientId, 'recipientId', 96)
  if ((recipientType === undefined) !== (recipientId === undefined)) {
    throw new NotificationApiRequestError('recipientType与recipientId必须同时提供')
  }
  const parsedLimit = query.limit === undefined ? undefined : Number(query.limit)
  return {
    statuses: statusValues,
    recipient: recipientType && recipientId ? { type: recipientType, id: recipientId } : undefined,
    limit: parsedLimit,
  }
}

function toStaffNotification(notification: NotificationRecord) {
  return {
    id: notification.id,
    channel: notification.channel,
    recipient: notification.recipient,
    templateCode: notification.templateCode,
    status: notification.status,
    availableAt: notification.availableAt,
    deliveredAt: notification.deliveredAt,
    attempts: notification.attempts,
    maxAttempts: notification.maxAttempts,
    failureCode: notification.failureCode,
    createdAt: notification.createdAt,
    updatedAt: notification.updatedAt,
  }
}

class NotificationApiRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotificationApiRequestError'
  }
}

class NotificationCapabilityDeniedError extends Error {
  constructor() {
    super('当前员工无权查看或重试通知')
    this.name = 'NotificationCapabilityDeniedError'
  }
}

function requireCapability(context: NormalizedOperationsRequestContext, capability: string): void {
  if (!context.capabilities.includes(capability)) throw new NotificationCapabilityDeniedError()
}

function readIdempotencyKey(request: FastifyRequest): string {
  const value = request.headers['idempotency-key'] ?? request.headers['x-idempotency-key']
  if (Array.isArray(value) || typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{8,128}$/.test(value)) {
    throw new NotificationApiRequestError('缺少有效的幂等键')
  }
  return value
}

function readObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new NotificationApiRequestError('请求数据格式无效')
  }
  return value as Record<string, unknown>
}

function readString(value: unknown, label: string, maximum: number, minimum = 1): string {
  if (typeof value !== 'string') throw new NotificationApiRequestError(`${label}格式无效`)
  const normalized = value.trim()
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new NotificationApiRequestError(`${label}格式无效`)
  }
  return normalized
}

function readUuid(value: unknown, label: string): string {
  const result = readString(value, label, 36, 36)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(result)) {
    throw new NotificationApiRequestError(`${label}格式无效`)
  }
  return result
}

const STATUSES: readonly NotificationStatus[] = [
  'pending', 'sending', 'delivered', 'failed', 'dead', 'cancelled',
]

function readStatus(value: unknown): NotificationStatus {
  const status = readString(value, 'status', 16)
  if (!STATUSES.includes(status as NotificationStatus)) {
    throw new NotificationApiRequestError('通知状态无效')
  }
  return status as NotificationStatus
}

const RECIPIENT_TYPES: readonly NotificationRecipientType[] = [
  'employee', 'customer', 'role', 'table', 'integration',
]

function readRecipientType(value: unknown): NotificationRecipientType {
  const type = readString(value, 'recipientType', 16)
  if (!RECIPIENT_TYPES.includes(type as NotificationRecipientType)) {
    throw new NotificationApiRequestError('通知接收对象类型无效')
  }
  return type as NotificationRecipientType
}

async function handleRoute(reply: FastifyReply, operation: () => Promise<FastifyReply>) {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof NotificationCapabilityDeniedError) {
      return reply.code(403).send({ error: { code: 'NOTIFICATION_FORBIDDEN', message: error.message } })
    }
    if (error instanceof NotificationNotFoundError) {
      return reply.code(404).send({ error: { code: 'NOTIFICATION_NOT_FOUND', message: '通知不存在' } })
    }
    if (error instanceof NotificationRetryNotAllowedError) {
      return reply.code(409).send({ error: { code: 'NOTIFICATION_RETRY_NOT_ALLOWED', message: '只有发送失败的通知可以重试' } })
    }
    if (error instanceof IdempotencyConflictError || error instanceof IdempotencyInProgressError) {
      return reply.code(409).send({ error: { code: 'NOTIFICATION_IDEMPOTENCY_CONFLICT', message: '该操作正在处理或幂等键已被其他请求使用' } })
    }
    if (error instanceof NotificationApiRequestError || error instanceof NotificationPolicyError) {
      return reply.code(400).send({ error: { code: 'NOTIFICATION_REQUEST_INVALID', message: error.message } })
    }
    if (error instanceof IdempotencyRecordError) {
      return reply.code(503).send({ error: { code: 'NOTIFICATION_RETRY_UNAVAILABLE', message: '通知重试服务暂时不可用' } })
    }
    return reply.code(500).send({ error: { code: 'NOTIFICATION_INTERNAL_ERROR', message: '通知服务暂时不可用' } })
  }
}
