import type {
  JsonCodec,
  JsonObject,
  JsonValue,
  NormalizedCommandExecutor,
} from './command-executor.js'
import { StaffAccessRepository } from './staff-access-repository.js'
import type { ScopedTransaction, StoreScope } from './transaction-runner.js'

export interface AiExecutionContext {
  scope: Readonly<StoreScope>
  employeeId: string
  businessDate: string
}

export interface AiToolProposal {
  toolName: string
  arguments: JsonObject
  runAt?: string | null
}

export interface AiEntityCandidate {
  kind: 'table' | 'employee' | 'other'
  value: string
  label: string
}

export type AiEntityResolution =
  | { kind: 'resolved'; arguments: JsonObject }
  | { kind: 'ambiguous'; candidates: readonly AiEntityCandidate[] }
  | { kind: 'not_found'; candidates?: readonly AiEntityCandidate[] }

export interface AiCapabilityExecutionRequest {
  transaction: ScopedTransaction
  context: AiExecutionContext
  arguments: JsonObject
  executionRequestId: string
  idempotencyKey: string
}

export interface AiCapabilityDefinition {
  name: string
  description: string
  requiredPermissions: readonly string[]
  requiresHumanConfirmation: boolean
  validate(argumentsValue: JsonObject): JsonObject
  resolve?(
    transaction: ScopedTransaction,
    context: AiExecutionContext,
    argumentsValue: JsonObject,
  ): Promise<AiEntityResolution>
  execute(request: Readonly<AiCapabilityExecutionRequest>): Promise<JsonObject>
}

export interface AiExecutionRequestInput {
  context: AiExecutionContext
  proposal: AiToolProposal
  idempotencyKey: string
  requestFingerprint: string
}

export type AiExecutionStatus =
  | 'needs_clarification'
  | 'requires_confirmation'
  | 'scheduled'
  | 'succeeded'
  | 'failed'

export interface AiExecutionResult {
  requestId: string
  toolName: string
  status: AiExecutionStatus
  message: string
  requiresHumanConfirmation: boolean
  runAt: string
  candidates: readonly AiEntityCandidate[]
  result: JsonObject
  replayed?: boolean
}

export interface AiScheduledRequestRow {
  id: string
  requestedByEmployeeId: string
  toolName: string
  arguments: JsonObject
  runAt: string
  attemptCount: number
}

export interface AiScheduledExecutionPort {
  executeClaimedScheduled(
    transaction: ScopedTransaction,
    request: Readonly<AiScheduledRequestRow>,
    workerId: string,
  ): Promise<AiExecutionStatus>
}

interface AiRequestRow extends Record<string, unknown> {
  id: string
  tool_name: string
  status: AiExecutionStatus | 'processing'
  requires_human_confirmation: boolean
  run_at: string
  candidate_snapshot: AiEntityCandidate[]
  result_snapshot: JsonObject
}

export class AiCapabilityNotFoundError extends Error {
  constructor(name: string) {
    super(`AI capability is not registered: ${name}`)
    this.name = 'AiCapabilityNotFoundError'
  }
}

export class AiCapabilityValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AiCapabilityValidationError'
  }
}

export class AiCapabilityCenter implements AiScheduledExecutionPort {
  private readonly capabilities = new Map<string, AiCapabilityDefinition>()

  constructor(
    private readonly commands: Pick<NormalizedCommandExecutor, 'execute'>,
    definitions: readonly AiCapabilityDefinition[],
  ) {
    for (const definition of definitions) this.register(definition)
  }

  list(): readonly Pick<AiCapabilityDefinition, 'name' | 'description' | 'requiredPermissions' | 'requiresHumanConfirmation'>[] {
    return [...this.capabilities.values()]
      .map(({ name, description, requiredPermissions, requiresHumanConfirmation }) => ({
        name,
        description,
        requiredPermissions: [...requiredPermissions],
        requiresHumanConfirmation,
      }))
      .toSorted((left, right) => left.name.localeCompare(right.name))
  }

  async execute(input: Readonly<AiExecutionRequestInput>): Promise<AiExecutionResult> {
    validateProposal(input.proposal)
    const capability = this.requiredCapability(input.proposal.toolName)
    const runAt = validateRunAt(input.proposal.runAt)
    const execution = await this.commands.execute({
      scope: input.context.scope,
      operationScope: 'ai.capability.execute',
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: input.requestFingerprint,
      resultCodec: aiExecutionResultCodec,
    }, async (transaction) => {
      await assertCapabilityAccess(transaction, input.context, capability, runAt)
      const result = await this.prepareAndExecute(
        transaction,
        input.context,
        capability,
        input.proposal.arguments,
        runAt,
        input.idempotencyKey,
      )
      return {
        result,
        auditEvents: [{
          actor: { type: 'employee', employeeId: input.context.employeeId },
          action: `ai.execution.${result.status}`,
          objectType: 'ai_execution_request',
          objectId: result.requestId,
          businessDate: input.context.businessDate,
          afterData: safeResultJson(result),
        }],
        outboxMessages: [{
          aggregateType: 'ai_execution_request',
          aggregateId: result.requestId,
          aggregateVersion: 1,
          eventType: `ai.execution.${result.status}.v1`,
          payload: safeResultJson(result),
          availableAt: result.status === 'scheduled' ? result.runAt : undefined,
        }],
      }
    })
    return { ...execution.value, replayed: execution.replayed }
  }

  async executeClaimedScheduled(
    transaction: ScopedTransaction,
    request: Readonly<AiScheduledRequestRow>,
    workerId: string,
  ): Promise<AiExecutionStatus> {
    const capability = this.requiredCapability(request.toolName)
    const context = await businessContext(transaction, request.requestedByEmployeeId)
    try {
      await assertCapabilityAccess(transaction, context, capability, request.runAt)
      if (capability.requiresHumanConfirmation) {
        await transitionScheduledRequest(transaction, request.id, 'requires_confirmation', {
          candidates: [], result: {}, errorCode: null,
        })
        await appendScheduledEvidence(transaction, request, workerId, 'requires_confirmation', {})
        return 'requires_confirmation'
      }
      const validated = capability.validate(request.arguments)
      const resolution = capability.resolve === undefined
        ? { kind: 'resolved', arguments: validated } as const
        : await capability.resolve(transaction, context, validated)
      if (resolution.kind !== 'resolved') {
        const candidates = [...(resolution.candidates ?? [])]
        await transitionScheduledRequest(transaction, request.id, 'needs_clarification', {
          candidates, result: {}, errorCode: resolution.kind === 'not_found' ? 'ENTITY_NOT_FOUND' : null,
        })
        await appendScheduledEvidence(transaction, request, workerId, 'needs_clarification', {
          candidateCount: candidates.length,
        })
        return 'needs_clarification'
      }
      const result = await capability.execute({
        transaction,
        context,
        arguments: resolution.arguments,
        executionRequestId: request.id,
        idempotencyKey: `ai-scheduled:${request.id}`,
      })
      await transitionScheduledRequest(transaction, request.id, 'succeeded', {
        candidates: [], result, errorCode: null,
      })
      await appendScheduledEvidence(transaction, request, workerId, 'succeeded', result)
      return 'succeeded'
    } catch (error) {
      await transitionScheduledRequest(transaction, request.id, 'failed', {
        candidates: [], result: {}, errorCode: safeErrorCode(error),
      })
      await appendScheduledEvidence(transaction, request, workerId, 'failed', {
        errorCode: safeErrorCode(error),
      })
      return 'failed'
    }
  }

  private register(definition: AiCapabilityDefinition): void {
    if (!/^[a-z][a-z0-9_.-]{2,127}$/.test(definition.name)) {
      throw new TypeError(`Invalid AI capability name: ${definition.name}`)
    }
    if (this.capabilities.has(definition.name)) {
      throw new TypeError(`Duplicate AI capability name: ${definition.name}`)
    }
    if (definition.requiredPermissions.length < 1) {
      throw new TypeError(`AI capability requires at least one permission: ${definition.name}`)
    }
    this.capabilities.set(definition.name, Object.freeze({
      ...definition,
      requiredPermissions: Object.freeze([...definition.requiredPermissions]),
    }))
  }

  private requiredCapability(name: string): AiCapabilityDefinition {
    const capability = this.capabilities.get(name)
    if (capability === undefined) throw new AiCapabilityNotFoundError(name)
    return capability
  }

  private async prepareAndExecute(
    transaction: ScopedTransaction,
    context: AiExecutionContext,
    capability: AiCapabilityDefinition,
    argumentsValue: JsonObject,
    runAt: string,
    idempotencyKey: string,
  ): Promise<AiExecutionResult> {
    const validated = capability.validate(argumentsValue)
    const resolution = capability.resolve === undefined
      ? { kind: 'resolved', arguments: validated } as const
      : await capability.resolve(transaction, context, validated)
    const isFuture = new Date(runAt).getTime() > Date.now() + 1_000

    if (resolution.kind !== 'resolved') {
      const candidates = [...(resolution.candidates ?? [])]
      const row = await insertRequest(transaction, {
        employeeId: context.employeeId,
        toolName: capability.name,
        arguments: validated,
        status: 'needs_clarification',
        requiresHumanConfirmation: capability.requiresHumanConfirmation,
        runAt,
        candidates,
      })
      return resultFromRow(row, resolution.kind === 'not_found'
        ? '没有找到明确对象，请重新说明'
        : '找到多个相似对象，请选择后再执行')
    }

    if (capability.requiresHumanConfirmation) {
      const row = await insertRequest(transaction, {
        employeeId: context.employeeId,
        toolName: capability.name,
        arguments: resolution.arguments,
        status: 'requires_confirmation',
        requiresHumanConfirmation: true,
        runAt,
        candidates: [],
      })
      return resultFromRow(row, '该操作必须由有权人员在原业务页面人工确认，AI不会自动执行')
    }

    if (isFuture) {
      const row = await insertRequest(transaction, {
        employeeId: context.employeeId,
        toolName: capability.name,
        arguments: resolution.arguments,
        status: 'scheduled',
        requiresHumanConfirmation: false,
        runAt,
        candidates: [],
      })
      return resultFromRow(row, '命令已安排，到时会再次校验权限和现场对象')
    }

    const row = await insertRequest(transaction, {
      employeeId: context.employeeId,
      toolName: capability.name,
      arguments: resolution.arguments,
      status: 'processing',
      requiresHumanConfirmation: false,
      runAt,
      candidates: [],
    })
    try {
      const result = await capability.execute({
        transaction,
        context,
        arguments: resolution.arguments,
        executionRequestId: row.id,
        idempotencyKey,
      })
      const updated = await transitionScheduledRequest(transaction, row.id, 'succeeded', {
        candidates: [], result, errorCode: null,
      })
      return resultFromRow(updated, '已执行')
    } catch (error) {
      const updated = await transitionScheduledRequest(transaction, row.id, 'failed', {
        candidates: [], result: {}, errorCode: safeErrorCode(error),
      })
      return resultFromRow(updated, '执行失败，未产生已完成反馈')
    }
  }
}

export interface CoreAiOperationsPort {
  resolveTable(
    transaction: ScopedTransaction,
    tableCode: string,
  ): Promise<{ kind: 'exact'; tableId: string; tableCode: string } | {
    kind: 'ambiguous' | 'not_found'; candidates: readonly string[]
  }>
  resolveEmployee(
    transaction: ScopedTransaction,
    employeeName: string,
  ): Promise<{ kind: 'exact'; employeeId: string; displayName: string } | {
    kind: 'ambiguous' | 'not_found'; candidates: readonly string[]
  }>
  openTable(input: {
    transaction: ScopedTransaction
    context: AiExecutionContext
    tableId: string
    tableCode: string
    guestCount: number
    idempotencyKey: string
  }): Promise<JsonObject>
  createWaterServiceTask(input: {
    transaction: ScopedTransaction
    context: AiExecutionContext
    tableId: string
    tableCode: string
    assignedEmployeeId: string
    assignedEmployeeName: string
    quantity: number
    idempotencyKey: string
  }): Promise<JsonObject>
}

export function createCoreAiCapabilities(ports: CoreAiOperationsPort): readonly AiCapabilityDefinition[] {
  return [
    {
      name: 'table.open',
      description: '开台，必须明确桌号和人数',
      requiredPermissions: ['table.open'],
      requiresHumanConfirmation: false,
      validate: validateOpenTableArguments,
      resolve: async (transaction, _context, argumentsValue) => {
        const tableCode = requiredString(argumentsValue.tableCode, '请说明要开哪一桌')
        const resolution = await ports.resolveTable(transaction, tableCode)
        if (resolution.kind !== 'exact') return candidateResolution('table', resolution)
        return {
          kind: 'resolved',
          arguments: {
            ...argumentsValue,
            tableId: resolution.tableId,
            tableCode: resolution.tableCode,
          },
        }
      },
      execute: ({ transaction, context, arguments: args, idempotencyKey }) => ports.openTable({
        transaction,
        context,
        tableId: requiredString(args.tableId, '桌台未解析'),
        tableCode: requiredString(args.tableCode, '桌台未解析'),
        guestCount: requiredInteger(args.guestCount, '请说明就座人数', 1, 200),
        idempotencyKey,
      }),
    },
    {
      name: 'service.water.assign',
      description: '给指定桌安排员工送水，可立即或延迟执行',
      requiredPermissions: ['service.execute'],
      requiresHumanConfirmation: false,
      validate: validateWaterArguments,
      resolve: async (transaction, _context, argumentsValue) => {
        const tableCode = requiredString(argumentsValue.tableCode, '请说明服务哪一桌')
        const employeeName = requiredString(argumentsValue.employeeName, '请说明由哪位员工执行')
        const table = await ports.resolveTable(transaction, tableCode)
        if (table.kind !== 'exact') return candidateResolution('table', table)
        const employee = await ports.resolveEmployee(transaction, employeeName)
        if (employee.kind !== 'exact') return candidateResolution('employee', employee)
        return {
          kind: 'resolved',
          arguments: {
            ...argumentsValue,
            tableId: table.tableId,
            tableCode: table.tableCode,
            employeeId: employee.employeeId,
            employeeName: employee.displayName,
          },
        }
      },
      execute: ({ transaction, context, arguments: args, idempotencyKey }) => ports.createWaterServiceTask({
        transaction,
        context,
        tableId: requiredString(args.tableId, '桌台未解析'),
        tableCode: requiredString(args.tableCode, '桌台未解析'),
        assignedEmployeeId: requiredString(args.employeeId, '员工未解析'),
        assignedEmployeeName: requiredString(args.employeeName, '员工未解析'),
        quantity: requiredInteger(args.quantity, '请说明水的数量', 1, 20),
        idempotencyKey,
      }),
    },
    ...['refund.request', 'refund.approve', 'cash.confirm'].map((name): AiCapabilityDefinition => ({
      name,
      description: '财务敏感动作，只能转人工确认，AI不得自主执行',
      requiredPermissions: [name],
      requiresHumanConfirmation: true,
      validate: validatePlainObject,
      execute: async () => {
        throw new Error('Financial capability must never execute autonomously')
      },
    })),
  ]
}

async function assertCapabilityAccess(
  transaction: ScopedTransaction,
  context: AiExecutionContext,
  capability: AiCapabilityDefinition,
  runAt: string,
): Promise<void> {
  const access = new StaffAccessRepository(transaction)
  await access.assertPermission(context.employeeId, 'ai.execute')
  if (new Date(runAt).getTime() > Date.now() + 1_000) {
    await access.assertPermission(context.employeeId, 'ai.schedule')
  }
  for (const permission of capability.requiredPermissions) {
    await access.assertPermission(context.employeeId, permission)
  }
}

async function businessContext(
  transaction: ScopedTransaction,
  employeeId: string,
): Promise<AiExecutionContext> {
  const result = await transaction.query<{ business_date: string }>(`
    SELECT (((clock_timestamp() AT TIME ZONE timezone) - business_day_cutoff)::date)::text
      AS business_date
    FROM mbox.stores
    WHERE tenant_id = $1::uuid AND id = $2::uuid AND status = 'active'
  `, [transaction.scope.tenantId, transaction.scope.storeId])
  const businessDate = result.rows[0]?.business_date
  if (businessDate === undefined) throw new Error('STORE_NOT_AVAILABLE')
  return { scope: transaction.scope, employeeId, businessDate }
}

async function insertRequest(transaction: ScopedTransaction, input: {
  employeeId: string
  toolName: string
  arguments: JsonObject
  status: AiRequestRow['status']
  requiresHumanConfirmation: boolean
  runAt: string
  candidates: readonly AiEntityCandidate[]
}): Promise<AiRequestRow> {
  const result = await transaction.query<AiRequestRow>(`
    INSERT INTO mbox.ai_execution_requests (
      tenant_id, store_id, requested_by_employee_id, tool_name,
      arguments_snapshot, status, requires_human_confirmation, run_at, candidate_snapshot
    ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::jsonb, $6, $7, $8::timestamptz, $9::jsonb)
    RETURNING id, tool_name, status, requires_human_confirmation,
      run_at::text, candidate_snapshot, result_snapshot
  `, [
    transaction.scope.tenantId,
    transaction.scope.storeId,
    input.employeeId,
    input.toolName,
    JSON.stringify(input.arguments),
    input.status,
    input.requiresHumanConfirmation,
    input.runAt,
    JSON.stringify(input.candidates),
  ])
  return requiredRow(result, 'AI execution request')
}

async function transitionScheduledRequest(
  transaction: ScopedTransaction,
  requestId: string,
  status: AiExecutionStatus,
  input: { candidates: readonly AiEntityCandidate[]; result: JsonObject; errorCode: string | null },
): Promise<AiRequestRow> {
  const terminal = status === 'succeeded' || status === 'failed'
  const result = await transaction.query<AiRequestRow>(`
    UPDATE mbox.ai_execution_requests
    SET status = $4, candidate_snapshot = $5::jsonb, result_snapshot = $6::jsonb,
        last_error_code = $7, worker_locked_by = NULL, worker_locked_at = NULL,
        completed_at = CASE WHEN $8::boolean THEN clock_timestamp() ELSE NULL END
    WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
      AND status = 'processing'
    RETURNING id, tool_name, status, requires_human_confirmation,
      run_at::text, candidate_snapshot, result_snapshot
  `, [
    transaction.scope.tenantId,
    transaction.scope.storeId,
    requestId,
    status,
    JSON.stringify(input.candidates),
    JSON.stringify(input.result),
    input.errorCode,
    terminal,
  ])
  return requiredRow(result, 'AI execution transition')
}

async function appendScheduledEvidence(
  transaction: ScopedTransaction,
  request: Readonly<AiScheduledRequestRow>,
  workerId: string,
  status: AiExecutionStatus,
  result: JsonObject,
): Promise<void> {
  const safePayload: JsonObject = {
    requestId: request.id,
    toolName: request.toolName,
    status,
    requiresHumanConfirmation: status === 'requires_confirmation',
  }
  const audit = await transaction.query(`
    INSERT INTO mbox.audit_events (
      tenant_id, store_id, actor_type, actor_ref, action,
      object_type, object_id, business_date, after_snapshot, metadata
    ) SELECT $1::uuid, $2::uuid, 'system', $3, $4,
      'ai_execution_request', $5,
      (((clock_timestamp() AT TIME ZONE store.timezone) - store.business_day_cutoff)::date),
      $6::jsonb, $7::jsonb
    FROM mbox.stores AS store
    WHERE store.tenant_id = $1::uuid AND store.id = $2::uuid
  `, [
    transaction.scope.tenantId,
    transaction.scope.storeId,
    workerId,
    `ai.execution.${status}`,
    request.id,
    JSON.stringify(safePayload),
    JSON.stringify({ resultKeys: Object.keys(result).toSorted() }),
  ])
  if (audit.rowCount !== 1) throw new Error(`AI audit could not be appended: ${request.id}`)
  const outbox = await transaction.query(`
    INSERT INTO mbox.outbox_messages (
      tenant_id, store_id, message_key, aggregate_type, aggregate_id,
      aggregate_version, message_type, payload
    ) VALUES ($1::uuid, $2::uuid, $3, 'ai_execution_request', $4::uuid, $5, $6, $7::jsonb)
  `, [
    transaction.scope.tenantId,
    transaction.scope.storeId,
    `ai.execution.${status}:${request.id}:${request.attemptCount}`,
    request.id,
    Math.max(1, request.attemptCount),
    `ai.execution.${status}.v1`,
    JSON.stringify(safePayload),
  ])
  if (outbox.rowCount !== 1) throw new Error(`AI outbox could not be appended: ${request.id}`)
}

function resultFromRow(row: AiRequestRow, message: string): AiExecutionResult {
  return {
    requestId: row.id,
    toolName: row.tool_name,
    status: row.status as AiExecutionStatus,
    message,
    requiresHumanConfirmation: row.requires_human_confirmation,
    runAt: row.run_at,
    candidates: row.candidate_snapshot,
    result: row.result_snapshot,
  }
}

function safeResultJson(result: AiExecutionResult): JsonObject {
  return {
    requestId: result.requestId,
    toolName: result.toolName,
    status: result.status,
    message: result.message,
    requiresHumanConfirmation: result.requiresHumanConfirmation,
    runAt: result.runAt,
    candidateCount: result.candidates.length,
    resultKeys: Object.keys(result.result).toSorted(),
  }
}

function validateProposal(proposal: AiToolProposal): void {
  if (!/^[a-z][a-z0-9_.-]{2,127}$/.test(proposal.toolName)) {
    throw new AiCapabilityValidationError('工具名称无效')
  }
  validatePlainObject(proposal.arguments)
}

function validateRunAt(value: string | null | undefined): string {
  if (value === undefined || value === null) return new Date().toISOString()
  const timestamp = new Date(value).getTime()
  const now = Date.now()
  if (!Number.isFinite(timestamp) || timestamp < now - 60_000 || timestamp > now + 30 * 86_400_000) {
    throw new AiCapabilityValidationError('执行时间必须在当前时间至未来30天内')
  }
  return new Date(timestamp).toISOString()
}

function validateOpenTableArguments(value: JsonObject): JsonObject {
  return {
    tableCode: requiredString(value.tableCode, '请说明要开哪一桌'),
    guestCount: requiredInteger(value.guestCount, '开台前请说明人数，系统不会默认2人', 1, 200),
  }
}

function validateWaterArguments(value: JsonObject): JsonObject {
  return {
    tableCode: requiredString(value.tableCode, '请说明服务哪一桌'),
    employeeName: requiredString(value.employeeName, '请说明由哪位员工执行'),
    quantity: value.quantity === undefined
      ? 2
      : requiredInteger(value.quantity, '水的数量必须是1至20', 1, 20),
  }
}

function validatePlainObject(value: JsonObject): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AiCapabilityValidationError('命令参数必须是对象')
  }
  return value
}

function requiredString(value: JsonValue | undefined, message: string): string {
  if (typeof value !== 'string' || value.trim().length < 1 || value.length > 256) {
    throw new AiCapabilityValidationError(message)
  }
  return value.trim()
}

function requiredInteger(
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

function candidateResolution(
  kind: AiEntityCandidate['kind'],
  resolution: { kind: 'ambiguous' | 'not_found'; candidates: readonly string[] },
): AiEntityResolution {
  return {
    kind: resolution.kind,
    candidates: resolution.candidates.map((value) => ({ kind, value, label: value })),
  }
}

function safeErrorCode(error: unknown): string {
  if (error instanceof AiCapabilityValidationError) return 'VALIDATION_FAILED'
  if (typeof error === 'object' && error !== null && 'code' in error
    && typeof error.code === 'string' && /^[A-Z0-9_]{2,64}$/.test(error.code)) {
    return error.code
  }
  return 'CAPABILITY_EXECUTION_FAILED'
}

function requiredRow<Row extends Record<string, unknown>>(
  result: { rows: Row[]; rowCount: number | null },
  label: string,
): Row {
  const row = result.rows[0]
  if (result.rowCount !== 1 || row === undefined) throw new Error(`${label} did not affect one row`)
  return row
}

const aiExecutionResultCodec: JsonCodec<AiExecutionResult> = {
  encode: (value) => ({
    requestId: value.requestId,
    toolName: value.toolName,
    status: value.status,
    message: value.message,
    requiresHumanConfirmation: value.requiresHumanConfirmation,
    runAt: value.runAt,
    candidates: value.candidates.map((candidate) => ({ ...candidate })),
    result: value.result,
  }),
  decode: (value) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new TypeError('Stored AI execution result is invalid')
    }
    const object = value as JsonObject
    const candidateValues = object.candidates
    if (!Array.isArray(candidateValues)) throw new TypeError('Stored candidates are invalid')
    return {
      requestId: requiredString(object.requestId, 'Stored request id is invalid'),
      toolName: requiredString(object.toolName, 'Stored tool name is invalid'),
      status: requiredString(object.status, 'Stored status is invalid') as AiExecutionStatus,
      message: requiredString(object.message, 'Stored message is invalid'),
      requiresHumanConfirmation: object.requiresHumanConfirmation === true,
      runAt: requiredString(object.runAt, 'Stored execution time is invalid'),
      candidates: candidateValues.map((candidate) => {
        if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
          throw new TypeError('Stored candidate is invalid')
        }
        return candidate as unknown as AiEntityCandidate
      }),
      result: typeof object.result === 'object' && object.result !== null && !Array.isArray(object.result)
        ? object.result : {},
    }
  },
}
