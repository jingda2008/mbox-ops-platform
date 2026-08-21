import { randomUUID } from 'node:crypto'
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import type {
  AuditActor,
  CommandExecution,
  JsonCodec,
  JsonObject,
  JsonValue,
  NormalizedCommandExecutor,
} from './command-executor.js'
import {
  IdempotencyConflictError,
  IdempotencyInProgressError,
  IdempotencyRecordError,
} from './command-executor.js'
import type { OperationsQueryService } from './operations-query-service.js'
import { StaffNotFoundError } from './operations-query-service.js'
import type { ServiceTask, ServiceTaskRepository, ServiceTaskStatus } from './service-task-repository.js'
import {
  ServiceTaskNotFoundError,
  ServiceTaskSessionMismatchError,
  ServiceTaskTransitionError,
} from './service-task-repository.js'
import type {
  TableSession,
  TableSessionCommandService,
  TableSessionRepository,
} from './table-session-repository.js'
import {
  TableAlreadyOpenError,
  TableNotFoundError,
  TableSessionNotFoundError,
  TableSessionTransitionError,
  TableUnavailableError,
} from './table-session-repository.js'
import {
  StaffAccessDeniedError,
  StaffNotFoundError as AuthenticatedStaffNotFoundError,
} from './staff-access-repository.js'
import {
  NormalizedAuthenticationRequiredError,
  NormalizedStoreUnavailableError,
  TrustedStoreScopeError,
} from './normalized-request-context.js'
import { businessDayClosureCodec, closeAwaitingBusinessDays } from './business-day-closure.js'
import { StaffSessionNotFoundError } from './staff-session-repository.js'
import type { ScopedTransaction, StoreScope } from './transaction-runner.js'

export interface NormalizedOperationsRequestContext {
  scope: Readonly<StoreScope>
  employeeId: string
  businessDate: string
  capabilities: readonly string[]
}

type OperationsQueryPort = Pick<OperationsQueryService, 'getStaffView'>
type TableSessionCommandPort = Pick<TableSessionCommandService, 'open'>
type CommandExecutorPort = Pick<NormalizedCommandExecutor, 'execute'>
type TableSessionRepositoryPort = Pick<TableSessionRepository, 'beginClosing' | 'completeClosing'>
type ServiceTaskRepositoryPort = Pick<
  ServiceTaskRepository,
  'create' | 'findById' | 'acknowledge' | 'start' | 'complete' | 'cancel'
>

export interface NormalizedOperationsApiOptions {
  operationsQuery: OperationsQueryPort
  tableSessions: TableSessionCommandPort
  commandExecutor: CommandExecutorPort
  resolveContext(request: FastifyRequest): Promise<NormalizedOperationsRequestContext>
    | NormalizedOperationsRequestContext
  createTableSessionRepository(transaction: ScopedTransaction): TableSessionRepositoryPort
  createServiceTaskRepository(transaction: ScopedTransaction): ServiceTaskRepositoryPort
  createPublicId?: (kind: 'table-session' | 'service-task') => string
}

type TaskTransition = 'acknowledge' | 'start' | 'complete' | 'cancel'

interface ApiErrorBody {
  error: {
    code: string
    message: string
  }
}

class RequestValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RequestValidationError'
  }
}

class ActorBindingError extends Error {
  constructor() {
    super('请求中的员工身份与当前登录员工不一致')
    this.name = 'ActorBindingError'
  }
}

class CapabilityDeniedError extends Error {
  constructor(public readonly capability: string) {
    super(`当前员工缺少操作权限：${capability}`)
    this.name = 'CapabilityDeniedError'
  }
}

class UnsettledTableSessionError extends Error {
  constructor(
    public readonly orderCount: number,
    public readonly outstandingAmountMinor: number,
  ) {
    super(`本桌仍有${orderCount}笔未结订单（待收¥${(outstandingAmountMinor / 100).toFixed(2)}），请先完成收款再关台`)
    this.name = 'UnsettledTableSessionError'
  }
}

export const normalizedOperationsApiPlugin: FastifyPluginAsync<NormalizedOperationsApiOptions> = async (
  app,
  options,
) => {
  const createPublicId = options.createPublicId ?? defaultPublicId

  app.get('/operations', async (request, reply) => handleRoute(reply, async () => {
    const context = await resolveAndValidateContext(options, request)
    requireCapability(context, 'dashboard.view')
    const view = await options.operationsQuery.getStaffView(
      context.scope,
      context.employeeId,
    )
    return reply.send({ data: view })
  }))

  app.post('/table-sessions', async (request, reply) => handleRoute(reply, async () => {
    const context = await resolveAndValidateContext(options, request)
    requireCapability(context, 'table.open')
    const body = readObject(request.body, '请求正文')
    assertActorBinding(body, context.employeeId)
    const idempotencyKey = readIdempotencyKey(request)
    const input = readOpenTableInput(body)
    const publicId = input.publicId ?? createPublicId('table-session')
    const execution = await options.tableSessions.open({
      scope: context.scope,
      actor: employeeActor(context.employeeId),
      idempotencyKey,
      requestFingerprint: fingerprint(request, context, {
        table: input.table,
        guestCount: input.guestCount,
        capacityOverrideReason: input.capacityOverrideReason,
        guestProfileSnapshot: input.guestProfileSnapshot,
        publicId: input.publicId ?? null,
      }),
      table: input.table,
      publicId,
      businessDate: context.businessDate,
      guestCount: input.guestCount,
      capacityOverrideReason: input.capacityOverrideReason,
      guestProfileSnapshot: input.guestProfileSnapshot,
      openedByEmployeeId: context.employeeId,
    })
    return reply.code(execution.replayed ? 200 : 201).send(executionResponse(execution))
  }))

  app.post<{ Params: { sessionId: string } }>(
    '/table-sessions/:sessionId/begin-closing',
    async (request, reply) => handleRoute(reply, async () => {
      const context = await resolveAndValidateContext(options, request)
      requireCapability(context, 'table.close')
      const body = readOptionalObject(request.body)
      assertActorBinding(body, context.employeeId)
      const sessionId = readUuid(request.params.sessionId, 'sessionId')
      const idempotencyKey = readIdempotencyKey(request)
      const execution = await executeTableTransition(
        options,
        context,
        sessionId,
        'begin-closing',
        idempotencyKey,
        fingerprint(request, context, { sessionId }),
      )
      return reply.send(executionResponse(execution))
    }),
  )

  app.post<{ Params: { sessionId: string } }>(
    '/table-sessions/:sessionId/close',
    async (request, reply) => handleRoute(reply, async () => {
      const context = await resolveAndValidateContext(options, request)
      requireCapability(context, 'table.close')
      const body = readOptionalObject(request.body)
      assertActorBinding(body, context.employeeId)
      const sessionId = readUuid(request.params.sessionId, 'sessionId')
      const idempotencyKey = readIdempotencyKey(request)
      const execution = await executeTableTransition(
        options,
        context,
        sessionId,
        'close',
        idempotencyKey,
        fingerprint(request, context, { sessionId }),
      )
      return reply.send(executionResponse(execution))
    }),
  )

  app.post('/business-days/close-pending', async (request, reply) => handleRoute(reply, async () => {
    const context = await resolveAndValidateContext(options, request)
    requireCapability(context, 'business_day.close')
    const body = readOptionalObject(request.body)
    assertActorBinding(body, context.employeeId)
    const idempotencyKey = readIdempotencyKey(request)
    const execution = await options.commandExecutor.execute({
      scope: context.scope,
      operationScope: 'business-day.close-pending',
      idempotencyKey,
      requestFingerprint: fingerprint(request, context, {}),
      resultCodec: businessDayClosureCodec,
    }, async (transaction) => closeAwaitingBusinessDays(
      transaction,
      employeeActor(context.employeeId),
      'manual_pending_business_day_close',
    ))
    return reply.send(executionResponse(execution))
  }))

  app.post('/service-tasks', async (request, reply) => handleRoute(reply, async () => {
    const context = await resolveAndValidateContext(options, request)
    requireCapability(context, 'service.execute')
    const body = readObject(request.body, '请求正文')
    assertActorBinding(body, context.employeeId)
    const idempotencyKey = readIdempotencyKey(request)
    const input = readCreateTaskInput(body, context.employeeId)
    const publicId = input.publicId ?? createPublicId('service-task')
    const execution = await options.commandExecutor.execute({
      scope: context.scope,
      operationScope: 'service-task.create',
      idempotencyKey,
      requestFingerprint: fingerprint(request, context, {
        ...input,
        publicId: input.publicId ?? null,
      }),
      resultCodec: serviceTaskCodec,
    }, async (transaction) => {
      const task = await options.createServiceTaskRepository(transaction).create({
        ...input,
        publicId,
        source: 'employee',
        createdByEmployeeId: context.employeeId,
        actor: { type: 'employee', employeeId: context.employeeId },
        eventIdempotencyKey: `${idempotencyKey}:created`,
      })
      return {
        result: task,
        auditEvents: [{
          actor: employeeActor(context.employeeId),
          action: 'service_task.created',
          objectType: 'service_task',
          objectId: task.id,
          businessDate: context.businessDate,
          afterData: serviceTaskToJson(task),
        }],
        outboxMessages: [{
          aggregateType: 'service_task',
          aggregateId: task.id,
          aggregateVersion: 1,
          eventType: 'service_task.created.v1',
          payload: serviceTaskToJson(task),
        }],
      }
    })
    return reply.code(execution.replayed ? 200 : 201).send(executionResponse(execution))
  }))

  const transitions: readonly TaskTransition[] = ['acknowledge', 'start', 'complete', 'cancel']
  for (const transition of transitions) {
    app.post<{ Params: { taskId: string } }>(
      `/service-tasks/:taskId/${transition}`,
      async (request, reply) => handleRoute(reply, async () => {
        const context = await resolveAndValidateContext(options, request)
        requireCapability(context, 'service.execute')
        const body = readOptionalObject(request.body)
        assertActorBinding(body, context.employeeId)
        const taskId = readUuid(request.params.taskId, 'taskId')
        const note = readOptionalString(body.note, 'note', 1_000)
        const idempotencyKey = readIdempotencyKey(request)
        const execution = await executeTaskTransition(
          options,
          context,
          taskId,
          transition,
          note,
          idempotencyKey,
          fingerprint(request, context, { taskId, transition, note }),
        )
        return reply.send(executionResponse(execution))
      }),
    )
  }
}

async function executeTableTransition(
  options: NormalizedOperationsApiOptions,
  context: NormalizedOperationsRequestContext,
  sessionId: string,
  transition: 'begin-closing' | 'close',
  idempotencyKey: string,
  requestFingerprint: string,
): Promise<CommandExecution<TableSession>> {
  return options.commandExecutor.execute({
    scope: context.scope,
    operationScope: `table-session.${transition}`,
    idempotencyKey,
    requestFingerprint,
    resultCodec: tableSessionCodec,
  }, async (transaction) => {
    const repository = options.createTableSessionRepository(transaction)
    if (transition === 'close') await assertTableSessionSettled(transaction, sessionId)
    const session = transition === 'begin-closing'
      ? await repository.beginClosing(sessionId, context.employeeId)
      : await repository.completeClosing(sessionId, context.employeeId)
    const action = transition === 'begin-closing'
      ? 'table_session.closing_started'
      : 'table_session.closed'
    const eventType = transition === 'begin-closing'
      ? 'table_session.closing_started.v1'
      : 'table_session.closed.v1'
    return {
      result: session,
      auditEvents: [{
        actor: employeeActor(context.employeeId),
        action,
        objectType: 'table_session',
        objectId: session.id,
        businessDate: session.businessDate,
        afterData: tableSessionToJson(session),
      }],
      outboxMessages: [{
        aggregateType: 'table_session',
        aggregateId: session.id,
        aggregateVersion: transition === 'begin-closing' ? 2 : 3,
        eventType,
        payload: tableSessionToJson(session),
      }],
    }
  })
}

async function assertTableSessionSettled(transaction: ScopedTransaction, sessionId: string): Promise<void> {
  const result = await transaction.query<{ order_count: string; outstanding_amount_minor: string }>(`
    SELECT count(*)::text AS order_count,
      COALESCE(sum(total_amount_minor), 0)::text AS outstanding_amount_minor
    FROM mbox.orders
    WHERE tenant_id = $1::uuid AND store_id = $2::uuid
      AND table_session_id = $3::uuid
      AND total_amount_minor > 0
      AND payment_status IN ('unpaid', 'pending')
  `, [transaction.scope.tenantId, transaction.scope.storeId, sessionId])
  const row = result.rows[0]
  const orderCount = Number(row?.order_count ?? 0)
  const outstandingAmountMinor = Number(row?.outstanding_amount_minor ?? 0)
  if (orderCount > 0 || outstandingAmountMinor > 0) {
    throw new UnsettledTableSessionError(orderCount, outstandingAmountMinor)
  }
}

async function executeTaskTransition(
  options: NormalizedOperationsApiOptions,
  context: NormalizedOperationsRequestContext,
  taskId: string,
  transition: TaskTransition,
  note: string | null,
  idempotencyKey: string,
  requestFingerprint: string,
): Promise<CommandExecution<ServiceTask>> {
  return options.commandExecutor.execute({
    scope: context.scope,
    operationScope: `service-task.${transition}`,
    idempotencyKey,
    requestFingerprint,
    resultCodec: serviceTaskCodec,
  }, async (transaction) => {
    const repository = options.createServiceTaskRepository(transaction)
    const currentTask = await repository.findById(taskId)
    if (currentTask === null) throw new ServiceTaskNotFoundError(taskId)
    if (currentTask.taskType === 'guest.complaint') {
      requireCapability(context, 'service.manage')
      if ((transition === 'complete' || transition === 'cancel') && (note?.trim().length ?? 0) < 4) {
        throw new RequestValidationError('投诉处理结果至少需要4个字')
      }
    }
    const transitionInput = {
      taskId,
      actor: { type: 'employee' as const, employeeId: context.employeeId },
      note,
      eventIdempotencyKey: `${idempotencyKey}:${transition}`,
    }
    const task = await repository[transition](transitionInput)
    return {
      result: task,
      auditEvents: [{
        actor: employeeActor(context.employeeId),
        action: `service_task.${task.status}`,
        objectType: 'service_task',
        objectId: task.id,
        businessDate: context.businessDate,
        afterData: serviceTaskToJson(task),
        reason: note,
      }],
      outboxMessages: [{
        aggregateType: 'service_task',
        aggregateId: task.id,
        aggregateVersion: taskVersion(task.status),
        eventType: `service_task.${task.status}.v1`,
        payload: serviceTaskToJson(task),
      }],
    }
  })
}

function readOpenTableInput(body: JsonObject) {
  const tableId = readOptionalString(body.tableId, 'tableId', 80)
  const tableCode = readOptionalString(body.tableCode, 'tableCode', 64)
  if ((tableId === null) === (tableCode === null)) {
    throw new RequestValidationError('tableId和tableCode必须且只能提供一个')
  }
  return {
    table: tableId === null
      ? { kind: 'code' as const, value: tableCode! }
      : { kind: 'id' as const, value: readUuid(tableId, 'tableId') },
    guestCount: readInteger(body.guestCount, 'guestCount', 1, 200),
    capacityOverrideReason: readOptionalString(body.capacityOverrideReason, 'capacityOverrideReason', 1_000),
    guestProfileSnapshot: readOptionalJsonObject(body.guestProfileSnapshot, 'guestProfileSnapshot'),
    publicId: readOptionalString(body.publicId, 'publicId', 128, 8),
  }
}

function readCreateTaskInput(body: JsonObject, employeeId: string) {
  if (body.source !== undefined && body.source !== 'employee') {
    throw new ActorBindingError()
  }
  return {
    tableId: readUuid(body.tableId, 'tableId'),
    tableSessionId: readUuid(body.tableSessionId, 'tableSessionId'),
    publicId: readOptionalString(body.publicId, 'publicId', 128, 8),
    taskType: readPatternString(body.taskType, 'taskType', /^[a-z][a-z0-9_.-]{1,63}$/),
    title: readString(body.title, 'title', 160),
    detail: readOptionalString(body.detail, 'detail', 2_000),
    priority: readPriority(body.priority),
    requestedRoleCode: readOptionalString(body.requestedRoleCode, 'requestedRoleCode', 64),
    assignedEmployeeId: readOptionalUuid(body.assignedEmployeeId, 'assignedEmployeeId'),
    backupEmployeeId: readOptionalUuid(body.backupEmployeeId, 'backupEmployeeId'),
    requestCount: body.requestCount === undefined
      ? 1
      : readInteger(body.requestCount, 'requestCount', 1, 100),
    requestSnapshot: readOptionalJsonObject(body.requestSnapshot, 'requestSnapshot'),
    dueAt: readOptionalTimestamp(body.dueAt, 'dueAt'),
    escalateAt: readOptionalTimestamp(body.escalateAt, 'escalateAt'),
    nextActionAt: readOptionalTimestamp(body.nextActionAt, 'nextActionAt'),
    createdByEmployeeId: employeeId,
  }
}

async function resolveAndValidateContext(
  options: NormalizedOperationsApiOptions,
  request: FastifyRequest,
): Promise<NormalizedOperationsRequestContext> {
  const context = await options.resolveContext(request)
  readUuid(context.scope.tenantId, 'tenantId')
  readUuid(context.scope.storeId, 'storeId')
  readUuid(context.employeeId, 'employeeId')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(context.businessDate)) {
    throw new RequestValidationError('businessDate必须使用YYYY-MM-DD格式')
  }
  if (!Array.isArray(context.capabilities) || context.capabilities.some((value) => typeof value !== 'string')) {
    throw new RequestValidationError('员工权限上下文无效')
  }
  return context
}

function requireCapability(context: NormalizedOperationsRequestContext, capability: string): void {
  if (!context.capabilities.includes(capability)) throw new CapabilityDeniedError(capability)
}

function assertActorBinding(body: JsonObject, employeeId: string): void {
  for (const field of ['actorId', 'employeeId', 'createdByEmployeeId', 'openedByEmployeeId']) {
    const claimed = body[field]
    if (claimed === undefined) continue
    if (typeof claimed !== 'string' || claimed !== employeeId) throw new ActorBindingError()
  }
}

function readIdempotencyKey(request: FastifyRequest): string {
  const raw = request.headers['idempotency-key']
  if (Array.isArray(raw)) throw new RequestValidationError('Idempotency-Key只能提供一个值')
  if (typeof raw !== 'string') throw new RequestValidationError('缺少Idempotency-Key请求头')
  const value = raw.trim()
  if (value.length < 8 || value.length > 160) {
    throw new RequestValidationError('Idempotency-Key长度必须为8到160个字符')
  }
  return value
}

function readObject(value: unknown, label: string): JsonObject {
  if (!isJsonObject(value)) throw new RequestValidationError(`${label}必须是JSON对象`)
  return value
}

function readOptionalObject(value: unknown): JsonObject {
  if (value === undefined || value === null || value === '') return {}
  return readObject(value, '请求正文')
}

function readOptionalJsonObject(value: JsonValue | undefined, label: string): JsonObject {
  if (value === undefined || value === null) return {}
  if (!isJsonObject(value)) throw new RequestValidationError(`${label}必须是JSON对象`)
  return value
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(value: JsonValue | undefined, label: string, maximum: number, minimum = 1): string {
  if (typeof value !== 'string') throw new RequestValidationError(`${label}必须是字符串`)
  const normalized = value.trim()
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new RequestValidationError(`${label}长度必须为${minimum}到${maximum}个字符`)
  }
  return normalized
}

function readOptionalString(
  value: JsonValue | undefined,
  label: string,
  maximum: number,
  minimum = 1,
): string | null {
  if (value === undefined || value === null) return null
  return readString(value, label, maximum, minimum)
}

function readPatternString(
  value: JsonValue | undefined,
  label: string,
  pattern: RegExp,
): string {
  const text = readString(value, label, 128)
  if (!pattern.test(text)) throw new RequestValidationError(`${label}格式无效`)
  return text
}

function readInteger(
  value: JsonValue | undefined,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isInteger(value) || typeof value !== 'number' || value < minimum || value > maximum) {
    throw new RequestValidationError(`${label}必须是${minimum}到${maximum}之间的整数`)
  }
  return value
}

function readUuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new RequestValidationError(`${label}必须是有效UUID`)
  }
  return value
}

function readOptionalUuid(value: JsonValue | undefined, label: string): string | null {
  if (value === undefined || value === null) return null
  return readUuid(value, label)
}

function readOptionalTimestamp(value: JsonValue | undefined, label: string): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new RequestValidationError(`${label}必须是有效ISO时间`)
  }
  return value
}

function readPriority(value: JsonValue | undefined): 'low' | 'normal' | 'high' | 'urgent' {
  if (value === undefined) return 'normal'
  if (value === 'low' || value === 'normal' || value === 'high' || value === 'urgent') return value
  throw new RequestValidationError('priority必须是low、normal、high或urgent')
}

function fingerprint(
  request: FastifyRequest,
  context: NormalizedOperationsRequestContext,
  payload: JsonObject,
): string {
  return stableStringify({
    method: request.method,
    path: request.routeOptions.url ?? request.url.split('?')[0] ?? request.url,
    tenantId: context.scope.tenantId,
    storeId: context.scope.storeId,
    employeeId: context.employeeId,
    payload,
  })
}

function stableStringify(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (isJsonObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key]!)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function employeeActor(employeeId: string): AuditActor {
  return { type: 'employee', employeeId }
}

function executionResponse<Value>(execution: CommandExecution<Value>) {
  return {
    data: execution.value,
    meta: { replayed: execution.replayed },
  }
}

function defaultPublicId(kind: 'table-session' | 'service-task'): string {
  return `${kind}-${randomUUID()}`
}

function taskVersion(status: ServiceTaskStatus): number {
  if (status === 'pending') return 1
  if (status === 'acknowledged') return 2
  if (status === 'in_progress') return 3
  return 4
}

const tableSessionCodec: JsonCodec<TableSession> = {
  encode: tableSessionToJson,
  decode: (value) => decodeRecord<TableSession>(value, ['id', 'tableId', 'tableCode', 'status']),
}

const serviceTaskCodec: JsonCodec<ServiceTask> = {
  encode: serviceTaskToJson,
  decode: (value) => decodeRecord<ServiceTask>(value, ['id', 'tableId', 'tableSessionId', 'status']),
}

function decodeRecord<Value>(value: unknown, required: readonly string[]): Value {
  if (!isJsonObject(value) || required.some((field) => typeof value[field] !== 'string')) {
    throw new TypeError('Stored command result is invalid')
  }
  return value as unknown as Value
}

function tableSessionToJson(session: TableSession): JsonObject {
  return {
    id: session.id,
    tableId: session.tableId,
    tableCode: session.tableCode,
    publicId: session.publicId,
    businessDate: session.businessDate,
    guestCount: session.guestCount,
    capacityAtOpen: session.capacityAtOpen,
    capacityOverrideReason: session.capacityOverrideReason,
    capacityOverriddenByEmployeeId: session.capacityOverriddenByEmployeeId,
    guestProfileSnapshot: session.guestProfileSnapshot,
    status: session.status,
    openedByEmployeeId: session.openedByEmployeeId,
    closedByEmployeeId: session.closedByEmployeeId,
    openedAt: session.openedAt,
    closedAt: session.closedAt,
  }
}

function serviceTaskToJson(task: ServiceTask): JsonObject {
  return {
    id: task.id,
    tableId: task.tableId,
    tableSessionId: task.tableSessionId,
    publicId: task.publicId,
    taskType: task.taskType,
    title: task.title,
    detail: task.detail,
    priority: task.priority,
    status: task.status,
    source: task.source,
    requestedRoleCode: task.requestedRoleCode,
    assignedEmployeeId: task.assignedEmployeeId,
    backupEmployeeId: task.backupEmployeeId,
    requestCount: task.requestCount,
    requestSnapshot: task.requestSnapshot,
    dueAt: task.dueAt,
    escalateAt: task.escalateAt,
    nextActionAt: task.nextActionAt,
    acknowledgedAt: task.acknowledgedAt,
    completedAt: task.completedAt,
    cancelledAt: task.cancelledAt,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  }
}

async function handleRoute(
  reply: FastifyReply,
  operation: () => Promise<FastifyReply>,
): Promise<FastifyReply> {
  try {
    return await operation()
  } catch (error) {
    const mapped = mapError(error)
    if (mapped.statusCode >= 500) {
      reply.request.log.error({ errorCode: safeErrorCode(error) }, 'normalized operations request failed')
    }
    return reply.code(mapped.statusCode).send(mapped.body)
  }
}

function safeErrorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    return error.code.slice(0, 64)
  }
  return error instanceof Error ? error.name.slice(0, 64) : 'UNKNOWN_ERROR'
}

function mapError(error: unknown): { statusCode: number; body: ApiErrorBody } {
  if (error instanceof NormalizedAuthenticationRequiredError || error instanceof StaffSessionNotFoundError) {
    return apiError(401, 'AUTH_REQUIRED', '登录信息无效或已过期，请重新登录')
  }
  if (error instanceof StaffAccessDeniedError) {
    return apiError(403, 'STAFF_ACCESS_FORBIDDEN', '当前员工无权执行此操作')
  }
  if (error instanceof AuthenticatedStaffNotFoundError) {
    return apiError(403, 'STAFF_ACCESS_FORBIDDEN', '当前员工无权执行此操作')
  }
  if (error instanceof TrustedStoreScopeError || error instanceof NormalizedStoreUnavailableError) {
    return apiError(403, 'STORE_ACCESS_FORBIDDEN', error.message)
  }
  if (error instanceof ActorBindingError) return apiError(403, 'ACTOR_BINDING_FORBIDDEN', error.message)
  if (error instanceof CapabilityDeniedError) {
    return apiError(403, 'CAPABILITY_FORBIDDEN', error.message)
  }
  if (error instanceof RequestValidationError || error instanceof TypeError) {
    return apiError(400, 'REQUEST_INVALID', error.message)
  }
  if (error instanceof StaffNotFoundError) return apiError(404, 'STAFF_NOT_FOUND', error.message)
  if (error instanceof TableNotFoundError) return apiError(404, 'TABLE_NOT_FOUND', error.message)
  if (error instanceof TableSessionNotFoundError) {
    return apiError(404, 'TABLE_SESSION_NOT_FOUND', error.message)
  }
  if (error instanceof ServiceTaskNotFoundError) {
    return apiError(404, 'SERVICE_TASK_NOT_FOUND', error.message)
  }
  if (error instanceof ServiceTaskSessionMismatchError) {
    return apiError(409, 'SERVICE_TASK_SESSION_MISMATCH', '桌台当前营业桌次已变化，请刷新后重试')
  }
  if (error instanceof TableUnavailableError) return apiError(409, 'TABLE_UNAVAILABLE', error.message)
  if (error instanceof TableAlreadyOpenError) return apiError(409, 'TABLE_ALREADY_OPEN', error.message)
  if (error instanceof TableSessionTransitionError) {
    return apiError(409, 'TABLE_SESSION_TRANSITION_CONFLICT', error.message)
  }
  if (error instanceof UnsettledTableSessionError) {
    return apiError(409, 'TABLE_SESSION_UNSETTLED', error.message)
  }
  if (error instanceof ServiceTaskTransitionError) {
    return apiError(409, 'SERVICE_TASK_TRANSITION_CONFLICT', error.message)
  }
  if (error instanceof IdempotencyConflictError) {
    return apiError(409, 'IDEMPOTENCY_CONFLICT', error.message)
  }
  if (error instanceof IdempotencyInProgressError) {
    return apiError(409, 'IDEMPOTENCY_IN_PROGRESS', error.message)
  }
  if (error instanceof IdempotencyRecordError) {
    return apiError(500, 'IDEMPOTENCY_STORAGE_ERROR', '请求处理记录异常，请稍后重试')
  }
  return apiError(500, 'INTERNAL_ERROR', '服务暂时不可用，请稍后重试')
}

function apiError(statusCode: number, code: string, message: string) {
  return { statusCode, body: { error: { code, message } } }
}
