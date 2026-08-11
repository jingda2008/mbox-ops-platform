import { createHash } from 'node:crypto'
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import {
  AiCapabilityCenter,
  AiCapabilityNotFoundError,
  AiCapabilityValidationError,
  type AiExecutionContext,
} from './ai-capability-center.js'
import {
  IdempotencyConflictError,
  IdempotencyInProgressError,
  IdempotencyRecordError,
  type JsonObject,
  type JsonValue,
} from './command-executor.js'
import {
  StaffAccessDeniedError,
  StaffNotFoundError,
} from './staff-access-repository.js'

export interface AiExecutionApiOptions {
  center: Pick<AiCapabilityCenter, 'execute' | 'list'>
  resolveContext(request: FastifyRequest): Promise<AiExecutionContext> | AiExecutionContext
}

interface ApiErrorBody {
  error: { code: string; message: string }
}

export const aiExecutionApiPlugin: FastifyPluginAsync<AiExecutionApiOptions> = async (app, options) => {
  app.get('/capabilities', async (request, reply) => handleRoute(reply, async () => {
    const context = await options.resolveContext(request)
    if (!context.scope.tenantId || !context.scope.storeId || !context.employeeId) {
      throw new StaffAccessDeniedError('Invalid staff context')
    }
    return reply.send({
      data: options.center.list().map((capability) => ({
        name: capability.name,
        description: capability.description,
        requiresHumanConfirmation: capability.requiresHumanConfirmation,
      })),
    })
  }))

  app.post('/executions', async (request, reply) => handleRoute(reply, async () => {
    const context = await options.resolveContext(request)
    const body = readObject(request.body)
    const toolName = readString(body.toolName, '请说明要执行的功能', 128)
    const argumentsValue = readObject(body.arguments ?? {})
    const runAt = readRunAt(body)
    const idempotencyKey = readIdempotencyKey(request)
    const result = await options.center.execute({
      context,
      proposal: { toolName, arguments: argumentsValue, runAt },
      idempotencyKey,
      requestFingerprint: fingerprint({
        employeeId: context.employeeId,
        toolName,
        arguments: argumentsValue,
        runAt,
      }),
    })
    const statusCode = result.replayed ? 200 : result.status === 'succeeded' ? 200 : 202
    return reply.code(statusCode).send({ data: result })
  }))
}

async function handleRoute(
  reply: FastifyReply,
  operation: () => Promise<FastifyReply>,
): Promise<FastifyReply> {
  try {
    return await operation()
  } catch (error) {
    const mapped = mapError(error)
    return reply.code(mapped.statusCode).send(mapped.body)
  }
}

function mapError(error: unknown): { statusCode: number; body: ApiErrorBody } {
  if (error instanceof StaffAccessDeniedError || error instanceof StaffNotFoundError) {
    return apiError(403, 'AI_EXECUTION_FORBIDDEN', '当前员工无权执行此命令')
  }
  if (error instanceof AiCapabilityNotFoundError) {
    return apiError(404, 'AI_CAPABILITY_NOT_FOUND', '没有找到可执行的功能，请换一种说法')
  }
  if (error instanceof AiCapabilityValidationError) {
    return apiError(400, 'AI_COMMAND_NEEDS_DETAILS', error.message)
  }
  if (error instanceof IdempotencyConflictError) {
    return apiError(409, 'AI_COMMAND_CONFLICT', '同一操作编号对应了不同命令，请重新发起')
  }
  if (error instanceof IdempotencyInProgressError) {
    return apiError(409, 'AI_COMMAND_IN_PROGRESS', '这条命令正在处理中，请稍候')
  }
  if (error instanceof IdempotencyRecordError) {
    return apiError(503, 'AI_COMMAND_UNAVAILABLE', '命令执行服务暂时不可用，请稍后再试')
  }
  return apiError(500, 'AI_EXECUTION_FAILED', '命令未执行成功，请稍后重试')
}

function readRunAt(body: JsonObject): string | null {
  if (body.runAt !== undefined && body.delaySeconds !== undefined) {
    throw new AiCapabilityValidationError('执行时间和延迟时间只能选择一种')
  }
  if (body.runAt !== undefined) return readString(body.runAt, '执行时间格式无效', 64)
  if (body.delaySeconds === undefined) return null
  const seconds = readInteger(body.delaySeconds, '延迟时间必须是1秒至30天', 1, 30 * 86_400)
  return new Date(Date.now() + seconds * 1_000).toISOString()
}

function readIdempotencyKey(request: FastifyRequest): string {
  const value = request.headers['idempotency-key']
  if (typeof value !== 'string' || value.length < 8 || value.length > 128) {
    throw new AiCapabilityValidationError('缺少有效的操作编号')
  }
  return value
}

function readObject(value: unknown): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AiCapabilityValidationError('命令内容格式无效')
  }
  return value as JsonObject
}

function readString(value: JsonValue | undefined, message: string, max: number): string {
  if (typeof value !== 'string' || value.trim().length < 1 || value.length > max) {
    throw new AiCapabilityValidationError(message)
  }
  return value.trim()
}

function readInteger(
  value: JsonValue | undefined,
  message: string,
  min: number,
  max: number,
): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new AiCapabilityValidationError(message)
  }
  return value
}

function fingerprint(value: JsonObject): string {
  return createHash('sha256').update(stableJson(value)).digest('hex')
}

function stableJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    return `{${Object.keys(value).toSorted().map((key) => `${JSON.stringify(key)}:${stableJson(value[key]!)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function apiError(statusCode: number, code: string, message: string) {
  return { statusCode, body: { error: { code, message } } }
}
