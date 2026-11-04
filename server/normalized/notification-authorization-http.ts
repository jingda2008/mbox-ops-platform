import type { FastifyReply } from 'fastify'
import { IdempotencyConflictError, IdempotencyInProgressError, IdempotencyRecordError } from './command-executor.js'

export class NotificationChannelUnavailableError extends Error {
  constructor(readonly code: string) { super('正式微信通知通道尚未完整配置，不能新增授权') }
}

// Domain errors keep their existing response contracts. These command/transport
// boundaries must not turn an unresolved receipt into an apparent server crash.
export function notificationAuthorizationErrorReply(error: unknown, reply: FastifyReply) {
  if (error instanceof NotificationChannelUnavailableError) return reply.code(503).send(error.code === 'WECHAT_MEMBER_SERVICE_NOTIFICATION_NOT_CONFIGURED'
    ? { error: { code: error.code, message: error.message } } : { code: error.code, message: error.message })
  if (error instanceof TypeError) return reply.code(400).send({ code: 'NOTIFICATION_AUTHORIZATION_INPUT_INVALID', message: error.message })
  if (error instanceof IdempotencyConflictError) return reply.code(409).send({ code: 'NOTIFICATION_AUTHORIZATION_CONFLICT', message: '原请求内容不一致，请核对授权状态；不要更换请求键重试' })
  if (error instanceof IdempotencyInProgressError) return reply.code(425).send({ code: 'NOTIFICATION_AUTHORIZATION_IN_PROGRESS', message: '原授权请求仍在处理，请保留原请求稍后恢复' })
  if (error instanceof IdempotencyRecordError) return reply.code(503).send({ code: 'NOTIFICATION_AUTHORIZATION_UNAVAILABLE', message: '暂时无法确认授权结果，请保留原请求稍后恢复' })
  return undefined
}
