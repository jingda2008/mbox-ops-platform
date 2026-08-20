import { createHash } from 'node:crypto'
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import type { JsonCodec, NormalizedCommandExecutor } from './command-executor.js'
import {
  ReservationPerformanceNotificationAuthorizationError,
  ReservationPerformanceNotificationRepository,
} from './reservation-performance-notification-repository.js'
import type { ReservationPerformanceCustomerContext } from './reservation-performance-revision-service.js'
import type { ScopedPostgresTransactionRunner } from './transaction-runner.js'

interface ReservationPerformanceNotificationApiOptions {
  transactions: Pick<ScopedPostgresTransactionRunner, 'run'>
  commands: Pick<NormalizedCommandExecutor, 'execute'>
  channelConfigured: boolean
  resolveCustomerContext(request: FastifyRequest):
    | ReservationPerformanceCustomerContext
    | Promise<ReservationPerformanceCustomerContext>
}

interface AuthorizationResult {
  id: string
  reservationPublicId: string
  decision: 'granted' | 'denied' | 'revoked'
  authorizationVersion: number
  changedAt: string
}

export const reservationPerformanceNotificationApiPlugin:
FastifyPluginAsync<ReservationPerformanceNotificationApiOptions> = async (app, options) => {
  app.get('/public/reservation/performance-notification-authorizations', async (request, reply) => {
    const context = await options.resolveCustomerContext(request)
    const authorizations = await options.transactions.run(context.scope, (transaction) => (
      new ReservationPerformanceNotificationRepository(transaction).authorizationOptions(
        context.customerId,
        options.channelConfigured,
      )
    ), { readOnly: true })
    return reply.send({
      data: { available: options.channelConfigured && authorizations.length > 0, authorizations },
    })
  })

  app.post('/public/reservation/performance-notification-authorizations', async (request, reply) => handle(
    reply,
    async () => {
    if (!options.channelConfigured) return reply.status(503).send({
      code: 'RESERVATION_NOTIFICATION_NOT_CONFIGURED',
      message: '正式微信预约提醒尚未完整配置',
    })
    const context = await options.resolveCustomerContext(request)
    const body = object(request.body)
    rejectClaims(body, ['customerId','canonicalCustomerId','reservationId','identityExternalId','scope'])
    const input = {
      reservationPublicId: publicId(body.reservationPublicId, '预约编号'),
      policyId: uuid(body.policyId, '提醒政策'),
      policyVersion: integer(body.policyVersion, '政策版本', 1),
      templateId: text(body.templateId, '微信模板', 8, 128),
      expectedVersion: integer(body.expectedVersion, '授权版本', 0),
      platformResult: enumeration(
        body.platformResult,
        ['accept','reject','ban','revoke'] as const,
        '微信授权结果',
      ),
      platformEventReference: text(body.platformEventReference, '授权请求编号', 8, 200),
    }
    const idempotencyKey = text(request.headers['idempotency-key'], '幂等键', 8, 160)
    try {
      const execution = await options.commands.execute({
        scope: context.scope,
        operationScope: 'customer.reservation-performance-notification-authorization.record',
        idempotencyKey,
        requestFingerprint: fingerprint({ ...input, customerId: context.customerId }),
        resultCodec: authorizationCodec,
      }, async (transaction) => {
        const recorded = await new ReservationPerformanceNotificationRepository(transaction)
          .recordAuthorization({ customerId: context.customerId, ...input })
        const result: AuthorizationResult = {
          id: recorded.id,
          reservationPublicId: recorded.reservationPublicId,
          decision: recorded.decision!,
          authorizationVersion: recorded.authorizationVersion,
          changedAt: recorded.changedAt!,
        }
        return {
          result,
          auditEvents: [{
            actor: { type: 'guest', ref: context.actorRef },
            action: 'customer.reservation-performance-notification-authorization.recorded',
            objectType: 'reservation_performance_notification_authorization',
            objectId: recorded.id,
            businessDate: context.businessDate,
            metadata: {
              reservationPublicId: recorded.reservationPublicId,
              policyVersion: recorded.policyVersion,
              decision: recorded.decision,
            },
          }],
          outboxMessages: [],
        }
      })
      return reply.code(execution.replayed ? 200 : 201).send({
        data: execution.value,
        meta: { replayed: execution.replayed },
      })
    } catch (error) {
      if (error instanceof ReservationPerformanceNotificationAuthorizationError) {
        const status = error.code === 'RESERVATION_NOTIFICATION_IDENTITY_REQUIRED' ? 403
          : error.code === 'RESERVATION_NOTIFICATION_RESERVATION_NOT_FOUND' ? 404 : 409
        return reply.status(status).send({ code: error.code, message: error.message })
      }
      throw error
    }
    },
  ))
}

async function handle(reply: FastifyReply, execute: () => Promise<unknown>) {
  try {
    return await execute()
  } catch (error) {
    if (error instanceof TypeError) {
      return reply.status(400).send({
        code: 'RESERVATION_NOTIFICATION_INPUT_INVALID',
        message: error.message,
      })
    }
    throw error
  }
}

const authorizationCodec: JsonCodec<AuthorizationResult> = {
  encode: (value) => ({ ...value }),
  decode: (value) => {
    const row = object(value)
    return {
      id: uuid(row.id, '授权'),
      reservationPublicId: publicId(row.reservationPublicId, '预约编号'),
      decision: enumeration(row.decision, ['granted','denied','revoked'] as const, '授权决定'),
      authorizationVersion: integer(row.authorizationVersion, '授权版本', 1),
      changedAt: timestamp(row.changedAt, '授权时间'),
    }
  },
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('请求内容格式不正确')
  return value as Record<string, unknown>
}

function text(value: unknown, label: string, minimum: number, maximum: number): string {
  if (typeof value !== 'string') throw new TypeError(`${label}格式不正确`)
  const normalized = value.trim()
  if (normalized.length < minimum || normalized.length > maximum) throw new TypeError(`${label}格式不正确`)
  return normalized
}

function publicId(value: unknown, label: string): string {
  const normalized = text(value, label, 8, 128)
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/.test(normalized)) throw new TypeError(`${label}格式不正确`)
  return normalized
}

function uuid(value: unknown, label: string): string {
  const normalized = text(value, label, 36, 36)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)) {
    throw new TypeError(`${label}格式不正确`)
  }
  return normalized
}

function integer(value: unknown, label: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > 2_000_000_000) {
    throw new TypeError(`${label}格式不正确`)
  }
  return value as number
}

function enumeration<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  label: string,
): Values[number] {
  if (typeof value !== 'string' || !values.includes(value)) throw new TypeError(`${label}格式不正确`)
  return value as Values[number]
}

function timestamp(value: unknown, label: string): string {
  const normalized = text(value, label, 20, 40)
  if (!Number.isFinite(Date.parse(normalized))) throw new TypeError(`${label}格式不正确`)
  return normalized
}

function rejectClaims(body: Record<string, unknown>, fields: readonly string[]): void {
  const claimed = fields.find((field) => Object.hasOwn(body, field))
  if (claimed !== undefined) throw new TypeError(`${claimed}由登录身份和服务器上下文确定，客户端不能提交`)
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex')
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const row = value as Record<string, unknown>
    return `{${Object.keys(row).toSorted().map((key) => `${JSON.stringify(key)}:${stableJson(row[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}
