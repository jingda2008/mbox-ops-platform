import { createHash, randomUUID } from 'node:crypto'
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import type { NormalizedOperationsRequestContext } from './normalized-operations-api.js'
import type { JsonObject } from './command-executor.js'
import {
  NormalizedAuthenticationRequiredError,
  NormalizedStoreUnavailableError,
  TrustedStoreScopeError,
} from './normalized-request-context.js'
import {
  StaffAccessDeniedError,
  StaffAccessRepository,
  StaffNotFoundError,
} from './staff-access-repository.js'
import {
  CapacityOverrideReasonRequiredError,
  TableManagementCommandService,
  TableManagementConflictError,
  TableManagementNotFoundError,
  TableManagementRepository,
  type AreaStatus,
  type ManagedArea,
  type ManagedTable,
  type TableStatus,
} from './table-management-repository.js'
import type { ScopedPostgresTransactionRunner } from './transaction-runner.js'
import {
  IdempotencyConflictError,
  IdempotencyInProgressError,
  IdempotencyRecordError,
  OutboxMessageConflictError,
} from './command-executor.js'

type TransactionRunnerPort = Pick<ScopedPostgresTransactionRunner, 'run'>
type TableManagementCommandPort = Pick<TableManagementCommandService,
  'createArea' | 'updateArea' | 'createTable' | 'updateTable' | 'assign' |
  'endAssignment' | 'open' | 'transfer'>

export interface TableManagementApiOptions {
  transactions: TransactionRunnerPort
  commands: TableManagementCommandPort
  resolveContext(request: FastifyRequest): Promise<NormalizedOperationsRequestContext> | NormalizedOperationsRequestContext
}

interface ApiErrorBody {
  error: { code: string; message: string }
}

class TableManagementRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TableManagementRequestError'
  }
}

export const tableManagementApiPlugin: FastifyPluginAsync<TableManagementApiOptions> = async (app, options) => {
  app.get('/table-management/areas', async (request, reply) => handle(reply, async () => {
    const context = await authorizedContext(options, request)
    const data = await options.transactions.run(context.scope, async (transaction) => {
      const access = await new StaffAccessRepository(transaction).resolve(context.employeeId)
      return new TableManagementRepository(transaction).listAreas(access)
    }, { readOnly: true })
    return reply.send({ data })
  }))

  app.get('/table-management/tables', async (request, reply) => handle(reply, async () => {
    const context = await authorizedContext(options, request)
    const data = await options.transactions.run(context.scope, async (transaction) => {
      const access = await new StaffAccessRepository(transaction).resolve(context.employeeId)
      return new TableManagementRepository(transaction).listTables(access)
    }, { readOnly: true })
    return reply.send({ data })
  }))

  app.get('/table-management/assignments', async (request, reply) => handle(reply, async () => {
    const context = await authorizedContext(options, request)
    const data = await options.transactions.run(context.scope, async (transaction) => {
      const access = await new StaffAccessRepository(transaction).resolve(context.employeeId)
      return new TableManagementRepository(transaction).listAssignments(access)
    }, { readOnly: true })
    return reply.send({ data })
  }))

  app.post('/table-management/areas', async (request, reply) => handle(reply, async () => {
    const context = await authorizedContext(options, request)
    const body = readObject(request.body)
    const input = readArea(body, true)
    const execution = await options.commands.createArea(commandBase(request, context, body, '配置新区域', {
      ...input,
      code: requiredString(body.code, 'code', 32),
    }))
    return reply.code(201).send(commandResponse(execution))
  }))

  app.patch('/table-management/areas/:areaId', async (request, reply) => handle(reply, async () => {
    const context = await authorizedContext(options, request)
    const body = readObject(request.body)
    const input = readArea(body, false)
    const execution = await options.commands.updateArea(commandBase(request, context, body, '调整区域配置', {
      ...input,
      areaId: readUuid(readParams(request).areaId, 'areaId'),
    }))
    return reply.send(commandResponse(execution))
  }))

  app.post('/table-management/tables', async (request, reply) => handle(reply, async () => {
    const context = await authorizedContext(options, request)
    const body = readObject(request.body)
    const input = readTable(body, true)
    const execution = await options.commands.createTable(commandBase(request, context, body, '配置新桌台', {
      ...input,
      areaId: readUuid(body.areaId, 'areaId'),
      code: requiredString(body.code, 'code', 32),
    }))
    return reply.code(201).send(commandResponse(execution))
  }))

  app.patch('/table-management/tables/:tableId', async (request, reply) => handle(reply, async () => {
    const context = await authorizedContext(options, request)
    const body = readObject(request.body)
    const input = readTable(body, false)
    const execution = await options.commands.updateTable(commandBase(request, context, body, '调整桌台配置', {
      ...input,
      tableId: readUuid(readParams(request).tableId, 'tableId'),
      areaId: readUuid(body.areaId, 'areaId'),
      code: requiredString(body.code, 'code', 32),
    }))
    return reply.send(commandResponse(execution))
  }))

  app.post('/table-management/assignments', async (request, reply) => handle(reply, async () => {
    const context = await authorizedContext(options, request)
    const body = readObject(request.body)
    const execution = await options.commands.assign(commandBase(request, context, body, '分配桌台责任', {
      tableId: readUuid(body.tableId, 'tableId'),
      employeeId: readUuid(body.employeeId, 'employeeId'),
      roleId: readUuid(body.roleId, 'roleId'),
      assignmentType: readEnum(body.assignmentType, 'assignmentType', ['primary', 'backup', 'temporary']),
      startsAt: readTimestamp(body.startsAt, 'startsAt'),
      endsAt: optionalTimestamp(body.endsAt, 'endsAt'),
    }))
    return reply.code(201).send(commandResponse(execution))
  }))

  app.post('/table-management/assignments/:assignmentId/end', async (request, reply) => handle(reply, async () => {
    const context = await authorizedContext(options, request)
    const body = readObject(request.body)
    const execution = await options.commands.endAssignment(commandBase(request, context, body, '结束桌台责任', {
      assignmentId: readUuid(readParams(request).assignmentId, 'assignmentId'),
      endsAt: readTimestamp(body.endsAt, 'endsAt'),
    }))
    return reply.send(commandResponse(execution))
  }))

  app.post('/table-management/sessions/open', async (request, reply) => handle(reply, async () => {
    const context = await authorizedContext(options, request)
    const body = readObject(request.body)
    const execution = await options.commands.open(commandBase(request, context, body, '现场开台', {
      tableId: readUuid(body.tableId, 'tableId'),
      publicId: optionalString(body.publicId, 'publicId', 128) ?? `table-session-${randomUUID()}`,
      guestCount: readInteger(body.guestCount, 'guestCount', 1, 200),
      capacityOverrideReason: optionalString(body.capacityOverrideReason, 'capacityOverrideReason', 1000),
      guestProfileSnapshot: optionalObject(body.guestProfileSnapshot, 'guestProfileSnapshot'),
    }))
    return reply.code(201).send(commandResponse(execution))
  }))

  app.post('/table-management/sessions/:tableSessionId/transfer', async (request, reply) => handle(reply, async () => {
    const context = await authorizedContext(options, request)
    const body = readObject(request.body)
    const execution = await options.commands.transfer(commandBase(request, context, body, '现场转桌', {
      tableSessionId: readUuid(readParams(request).tableSessionId, 'tableSessionId'),
      targetTableId: readUuid(body.targetTableId, 'targetTableId'),
      capacityOverrideReason: optionalString(body.capacityOverrideReason, 'capacityOverrideReason', 1000),
    }))
    return reply.send(commandResponse(execution))
  }))
}

async function authorizedContext(options: TableManagementApiOptions, request: FastifyRequest) {
  const context = await options.resolveContext(request)
  readUuid(context.scope.tenantId, 'tenantId')
  readUuid(context.scope.storeId, 'storeId')
  readUuid(context.employeeId, 'employeeId')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(context.businessDate)) throw new TableManagementRequestError('营业日格式无效')
  return context
}

function commandBase<Input extends Record<string, unknown>>(
  request: FastifyRequest,
  context: NormalizedOperationsRequestContext,
  body: Record<string, unknown>,
  defaultReason: string,
  input: Input,
) {
  const reason = optionalString(body.reason, 'reason', 1000) ?? defaultReason
  const idempotencyKey = readIdempotencyKey(request)
  return {
    ...input,
    scope: context.scope,
    actor: { type: 'employee' as const, employeeId: context.employeeId },
    businessDate: context.businessDate,
    reason,
    idempotencyKey,
    requestFingerprint: createHash('sha256').update(JSON.stringify({
      method: request.method,
      url: request.url,
      employeeId: context.employeeId,
      body,
    })).digest('hex'),
  }
}

function readArea(body: Record<string, unknown>, includeCode: boolean): Omit<ManagedArea,
  'id' | 'code' | 'createdAt' | 'updatedAt'> & { code?: string } {
  return {
    ...(includeCode ? { code: requiredString(body.code, 'code', 32) } : {}),
    name: requiredString(body.name, 'name', 120),
    areaType: readEnum(body.areaType, 'areaType', ['indoor', 'outdoor', 'bar', 'stage', 'vip', 'other']),
    sortOrder: readInteger(body.sortOrder, 'sortOrder', -100_000, 100_000),
    layoutSnapshot: optionalObject(body.layoutSnapshot, 'layoutSnapshot') ?? {},
    status: readEnum(body.status, 'status', ['active', 'paused', 'retired']) as AreaStatus,
  }
}

function readTable(body: Record<string, unknown>, includeCode: boolean): Omit<ManagedTable,
  'id' | 'areaId' | 'areaCode' | 'areaName' | 'code' | 'assignedToActor' | 'activeSessionId' |
  'activeGuestCount' | 'createdAt' | 'updatedAt'> & { code?: string } {
  return {
    ...(includeCode ? { code: requiredString(body.code, 'code', 32) } : {}),
    displayName: requiredString(body.displayName, 'displayName', 120),
    capacity: readInteger(body.capacity, 'capacity', 1, 200),
    minimumSpendMinor: optionalInteger(body.minimumSpendMinor, 'minimumSpendMinor', 0, Number.MAX_SAFE_INTEGER),
    currency: optionalString(body.currency, 'currency', 3) ?? 'CNY',
    layoutSnapshot: optionalObject(body.layoutSnapshot, 'layoutSnapshot') ?? {},
    status: readEnum(body.status, 'status', ['available', 'paused', 'retired']) as TableStatus,
  }
}

function readIdempotencyKey(request: FastifyRequest): string {
  const value = request.headers['x-idempotency-key']
  if (typeof value !== 'string' || value.trim().length < 8 || value.length > 160) {
    throw new TableManagementRequestError('请提供有效的X-Idempotency-Key')
  }
  return value.trim()
}

function readObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TableManagementRequestError('请求正文必须是对象')
  return value as Record<string, unknown>
}

function optionalObject(value: unknown, field: string): JsonObject | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TableManagementRequestError(`${field}必须是对象`)
  return value as JsonObject
}

function readParams(request: FastifyRequest): Record<string, unknown> {
  return readObject(request.params)
}

function requiredString(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > max) throw new TableManagementRequestError(`${field}无效`)
  return value.trim()
}

function optionalString(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null || value === '') return null
  return requiredString(value, field, max)
}

function readInteger(value: unknown, field: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new TableManagementRequestError(`${field}无效`)
  return value as number
}

function optionalInteger(value: unknown, field: string, min: number, max: number): number | null {
  if (value === undefined || value === null) return null
  return readInteger(value, field, min, max)
}

function readTimestamp(value: unknown, field: string): string {
  const timestamp = requiredString(value, field, 64)
  if (!Number.isFinite(Date.parse(timestamp))) throw new TableManagementRequestError(`${field}时间格式无效`)
  return timestamp
}

function optionalTimestamp(value: unknown, field: string): string | null {
  return value === undefined || value === null || value === '' ? null : readTimestamp(value, field)
}

function readUuid(value: unknown, field: string): string {
  const uuid = requiredString(value, field, 64)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid)) {
    throw new TableManagementRequestError(`${field}格式无效`)
  }
  return uuid
}

function readEnum<const Value extends string>(value: unknown, field: string, allowed: readonly Value[]): Value {
  if (typeof value !== 'string' || !allowed.includes(value as Value)) throw new TableManagementRequestError(`${field}无效`)
  return value as Value
}

function commandResponse<Result>(execution: { value: Result; replayed: boolean }) {
  return { data: execution.value, meta: { replayed: execution.replayed } }
}

async function handle(reply: FastifyReply, operation: () => Promise<unknown>) {
  try {
    return await operation()
  } catch (error) {
    const mapped = mapError(error)
    return reply.code(mapped.status).send({ error: { code: mapped.code, message: mapped.message } } satisfies ApiErrorBody)
  }
}

function mapError(error: unknown): { status: number; code: string; message: string } {
  if (error instanceof TableManagementRequestError || error instanceof TypeError) {
    return { status: 400, code: 'TABLE_REQUEST_INVALID', message: error.message }
  }
  if (error instanceof NormalizedAuthenticationRequiredError) return { status: 401, code: 'AUTH_REQUIRED', message: error.message }
  if (error instanceof StaffAccessDeniedError) return { status: 403, code: 'TABLE_PERMISSION_DENIED', message: '当前岗位无权执行该桌台操作' }
  if (error instanceof StaffNotFoundError) return { status: 401, code: 'STAFF_NOT_FOUND', message: '员工账号不可用，请重新登录' }
  if (error instanceof TableManagementNotFoundError) return { status: 404, code: 'TABLE_RESOURCE_NOT_FOUND', message: error.message }
  if (error instanceof CapacityOverrideReasonRequiredError) return { status: 422, code: 'CAPACITY_OVERRIDE_REASON_REQUIRED', message: error.message }
  if (error instanceof TableManagementConflictError || error instanceof IdempotencyConflictError
    || error instanceof IdempotencyInProgressError || error instanceof OutboxMessageConflictError) {
    return { status: 409, code: 'TABLE_OPERATION_CONFLICT', message: error.message }
  }
  if (error instanceof IdempotencyRecordError) return { status: 503, code: 'IDEMPOTENCY_UNAVAILABLE', message: '操作暂时无法确认，请稍后重试' }
  if (error instanceof TrustedStoreScopeError || error instanceof NormalizedStoreUnavailableError) {
    return { status: 503, code: 'STORE_UNAVAILABLE', message: error.message }
  }
  throw error
}
