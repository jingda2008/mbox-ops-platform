import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import {
  IdempotencyConflictError,
  IdempotencyInProgressError,
  IdempotencyRecordError,
  OutboxMessageConflictError,
} from './command-executor.js'
import {
  ReservationPerformanceRevisionError,
  type PerformanceImpactDecision,
  type PerformanceRevisionKind,
} from './reservation-performance-revision-repository.js'
import {
  ReservationPerformanceRevisionService,
  type ReservationPerformanceCustomerContext,
  type ReservationPerformanceStaffContext,
} from './reservation-performance-revision-service.js'
import { isStaffAuthenticationRequiredError, STAFF_AUTHENTICATION_REQUIRED_ERROR } from './staff-api-authentication.js'
import { StaffAccessDeniedError, StaffAccessRepository } from './staff-access-repository.js'
import type { ScopedPostgresTransactionRunner, ScopedTransaction } from './transaction-runner.js'

export interface ReservationPerformanceRevisionApiOptions {
  transactions: Pick<ScopedPostgresTransactionRunner, 'run'>
  service: ReservationPerformanceRevisionService
  resolveCustomerContext(request: FastifyRequest):
    | ReservationPerformanceCustomerContext
    | Promise<ReservationPerformanceCustomerContext>
  resolveStaffContext(request: FastifyRequest):
    | ReservationPerformanceStaffContext
    | Promise<ReservationPerformanceStaffContext>
  createStaffAccessRepository?(transaction: ScopedTransaction): Pick<StaffAccessRepository, 'assertPermission'>
}

export const reservationPerformanceRevisionApiPlugin:
FastifyPluginAsync<ReservationPerformanceRevisionApiOptions> = async (app, options) => {
  app.post('/staff/performance-revisions', async (request, reply) => handle(reply, async () => {
    const context = await authorizedStaff(options, request, 'performance.schedule.revise')
    const body = object(request.body, '演出调整')
    rejectClaims(body, ['employeeId','actor','scope','createdByEmployeeId'])
    const kind = enumeration(body.kind, '调整类型', ['rescheduled','cancelled','replaced'] as const)
    const startsAt = optionalTimestamp(body.startsAt, '新的开始时间')
    const endsAt = optionalTimestamp(body.endsAt, '新的结束时间')
    const replacementScheduleId = optionalUuid(body.replacementScheduleId, '替代场次')
    const result = await options.service.revise(context, {
      scheduleId: uuid(body.scheduleId, '演出场次'),
      kind,
      startsAt,
      endsAt,
      replacementScheduleId,
      reason: text(body.reason, '调整原因', 2, 500),
      idempotencyKey: idempotencyKey(request),
    })
    return reply.code(result.replayed ? 200 : 201).send({
      data: result.value,
      meta: { replayed: result.replayed },
    })
  }))

  app.get<{ Params: { publicId: string } }>(
    '/staff/performance-revisions/:publicId/impacts',
    async (request, reply) => handle(reply, async () => {
      const context = await authorizedStaff(options, request, 'reservation.view')
      const impacts = await options.service.listRevisionImpacts(
        context,
        publicId(request.params.publicId, '修订编号'),
      )
      return reply.send({ data: { impacts } })
    }),
  )

  app.get('/public/reservation/performance-impacts', async (request, reply) => handle(reply, async () => {
    const context = await options.resolveCustomerContext(request)
    const impacts = await options.service.listCustomerImpacts(context)
    return reply.send({ data: { impacts } })
  }))

  app.post<{ Params: { publicId: string } }>(
    '/public/reservation/performance-impacts/:publicId/acknowledgements',
    async (request, reply) => handle(reply, async () => {
      const context = await options.resolveCustomerContext(request)
      const body = object(request.body, '演出调整确认')
      rejectClaims(body, ['customerId','canonicalCustomerId','reservationId','actor','scope'])
      const decision: PerformanceImpactDecision = enumeration(
        body.decision,
        '确认选择',
        ['keep','reselect','clear'] as const,
      )
      const result = await options.service.acknowledge(context, {
        impactPublicId: publicId(request.params.publicId, '受影响预约编号'),
        decision,
        selectedScheduleId: optionalUuid(body.selectedScheduleId, '重新选择的演出'),
        idempotencyKey: idempotencyKey(request),
      })
      return reply.send({ data: result.value, meta: { replayed: result.replayed } })
    }),
  )
}

async function authorizedStaff(
  options: ReservationPerformanceRevisionApiOptions,
  request: FastifyRequest,
  permission: string,
): Promise<ReservationPerformanceStaffContext> {
  const context = await options.resolveStaffContext(request)
  await options.transactions.run(context.scope, async (transaction) => {
    const access = options.createStaffAccessRepository?.(transaction) ?? new StaffAccessRepository(transaction)
    await access.assertPermission(context.employeeId, permission)
  }, { readOnly: true })
  return context
}

async function handle(reply: FastifyReply, execute: () => Promise<unknown>) {
  try {
    return await execute()
  } catch (error) {
    if (isStaffAuthenticationRequiredError(error)) {
      return reply.code(401).send({ error: STAFF_AUTHENTICATION_REQUIRED_ERROR })
    }
    if (error instanceof ReservationPerformanceApiInputError) {
      return reply.code(400).send({
        error: { code: 'RESERVATION_PERFORMANCE_INPUT_INVALID', message: error.message },
      })
    }
    if (error instanceof ReservationPerformanceRevisionError) {
      return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } })
    }
    if (error instanceof StaffAccessDeniedError) {
      return reply.code(403).send({
        error: { code: 'STAFF_ACCESS_DENIED', message: '没有调整演出及受影响预约的权限' },
      })
    }
    if (error instanceof IdempotencyConflictError || error instanceof OutboxMessageConflictError) {
      return reply.code(409).send({
        error: { code: 'IDEMPOTENCY_CONFLICT', message: '重复请求内容不一致，请刷新后重试' },
      })
    }
    if (error instanceof IdempotencyInProgressError) {
      return reply.code(425).send({
        error: { code: 'IDEMPOTENCY_IN_PROGRESS', message: '相同操作正在处理中，请稍后刷新' },
      })
    }
    if (error instanceof IdempotencyRecordError) {
      return reply.code(503).send({
        error: { code: 'IDEMPOTENCY_UNAVAILABLE', message: '暂时无法确认操作结果，请刷新后再试' },
      })
    }
    throw error
  }
}

class ReservationPerformanceApiInputError extends Error {}

function invalid(message: string) { return new ReservationPerformanceApiInputError(message) }

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid(`${label}格式不正确`)
  }
  return value as Record<string, unknown>
}

function text(value: unknown, label: string, minimum: number, maximum: number): string {
  if (typeof value !== 'string') throw invalid(`${label}必须填写`)
  const normalized = value.trim()
  if (normalized.length < minimum || normalized.length > maximum) {
    throw invalid(`${label}长度应为${minimum}至${maximum}个字符`)
  }
  return normalized
}

function publicId(value: unknown, label: string): string {
  const normalized = text(value, label, 8, 128)
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/.test(normalized)) throw invalid(`${label}格式不正确`)
  return normalized
}

function uuid(value: unknown, label: string): string {
  const normalized = text(value, label, 36, 36)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)) {
    throw invalid(`${label}格式不正确`)
  }
  return normalized
}

function optionalUuid(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === '') return null
  return uuid(value, label)
}

function optionalTimestamp(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === '') return null
  const normalized = text(value, label, 8, 64)
  if (!Number.isFinite(Date.parse(normalized))) throw invalid(`${label}格式不正确`)
  return new Date(normalized).toISOString()
}

function enumeration<const Values extends readonly string[]>(
  value: unknown,
  label: string,
  values: Values,
): Values[number] {
  if (typeof value !== 'string' || !values.includes(value)) throw invalid(`${label}不受支持`)
  return value as Values[number]
}

function idempotencyKey(request: FastifyRequest): string {
  const value = request.headers['idempotency-key']
  if (Array.isArray(value)) throw invalid('Idempotency-Key格式不正确')
  return publicId(value, 'Idempotency-Key')
}

function rejectClaims(body: Record<string, unknown>, fields: readonly string[]): void {
  const claimed = fields.find((field) => Object.hasOwn(body, field))
  if (claimed !== undefined) throw invalid(`${claimed}由登录身份和服务器上下文确定，客户端不能提交`)
}

export type { PerformanceRevisionKind }
