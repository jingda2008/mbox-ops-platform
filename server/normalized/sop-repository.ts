import type {
  AuditActor,
  JsonCodec,
  JsonObject,
  JsonValue,
  NormalizedCommandExecutor,
} from './command-executor.js'
import { StaffAccessRepository } from './staff-access-repository.js'
import type { ScopedTransaction, StoreScope } from './transaction-runner.js'

export type SopRuleStatus = 'active' | 'inactive'
export type SopVersionStatus = 'draft' | 'published' | 'retired'
export type SopInstanceStatus = 'active' | 'completed' | 'cancelled' | 'failed'
export type SopStepExecutionStatus =
  | 'pending'
  | 'processing'
  | 'waiting'
  | 'completed'
  | 'skipped'
  | 'failed'
  | 'cancelled'

export interface SopRule {
  id: string
  code: string
  name: string
  description: string | null
  status: SopRuleStatus
}

export interface SopRuleVersion {
  id: string
  ruleId: string
  versionNumber: number
  status: SopVersionStatus
  triggerEvent: string
  triggerDelayMs: number
  triggerCondition: JsonObject
  endCondition: JsonObject
  aggregateVersion: number
}

export interface SopRuleStep {
  id: string
  versionId: string
  stepKey: string
  stepOrder: number
  name: string
  delayMs: number
  condition: JsonObject
  actionName: string
  actionInput: JsonObject
  requestedRoleCode: string | null
  assignedEmployeeId: string | null
  escalationAfterMs: number | null
  escalationRoleCode: string | null
  escalationEmployeeId: string | null
  endCondition: JsonObject
  maxAttempts: number
}

export interface SopInstance {
  id: string
  ruleId: string
  versionId: string
  triggerEvent: string
  triggerReference: string
  businessDate: string
  context: JsonObject
  status: SopInstanceStatus
  currentStepOrder: number
  aggregateVersion: number
}

export interface SopStepExecution {
  id: string
  instanceId: string
  stepId: string
  status: SopStepExecutionStatus
  scheduledAt: string
  nextAttemptAt: string
  attemptCount: number
  externalReference: string | null
  output: JsonObject
}

export interface CreateSopRuleInput {
  code: string
  name: string
  description?: string | null
  createdByEmployeeId: string
}

export interface CreateSopVersionInput {
  ruleId: string
  versionNumber: number
  triggerEvent: string
  triggerDelayMs?: number
  triggerCondition?: JsonObject
  endCondition?: JsonObject
  createdByEmployeeId: string
}

export interface AddSopStepInput {
  versionId: string
  stepKey: string
  stepOrder: number
  name: string
  delayMs?: number
  condition?: JsonObject
  actionName: string
  actionInput?: JsonObject
  requestedRoleCode?: string | null
  assignedEmployeeId?: string | null
  escalationAfterMs?: number | null
  escalationRoleCode?: string | null
  escalationEmployeeId?: string | null
  endCondition?: JsonObject
  maxAttempts?: number
}

export interface TriggerSopInput {
  triggerEvent: string
  triggerReference: string
  businessDate: string
  context: JsonObject
}

interface RuleRow extends Record<string, unknown> {
  id: string
  code: string
  name: string
  description: string | null
  status: SopRuleStatus
}

interface VersionRow extends Record<string, unknown> {
  id: string
  sop_rule_id: string
  version_number: number
  status: SopVersionStatus
  trigger_event: string
  trigger_delay_ms: string | number
  trigger_condition: JsonObject
  end_condition: JsonObject
  aggregate_version: string | number
}

interface StepRow extends Record<string, unknown> {
  id: string
  sop_rule_version_id: string
  step_key: string
  step_order: number
  name: string
  delay_ms: string | number
  condition_snapshot: JsonObject
  action_name: string
  action_input: JsonObject
  requested_role_code: string | null
  assigned_employee_id: string | null
  escalation_after_ms: string | number | null
  escalation_role_code: string | null
  escalation_employee_id: string | null
  end_condition: JsonObject
  max_attempts: number
}

interface InstanceRow extends Record<string, unknown> {
  id: string
  sop_rule_id: string
  sop_rule_version_id: string
  trigger_event: string
  trigger_reference: string
  business_date: string
  context_snapshot: JsonObject
  status: SopInstanceStatus
  current_step_order: number
  aggregate_version: string | number
}

interface ExecutionRow extends Record<string, unknown> {
  id: string
  sop_instance_id: string
  sop_rule_step_id: string
  status: SopStepExecutionStatus
  scheduled_at: string
  next_attempt_at: string
  attempt_count: number
  external_reference: string | null
  output_snapshot: JsonObject
}

interface PublishedCandidateRow extends VersionRow {
  rule_id: string
}

export class SopDefinitionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SopDefinitionError'
  }
}

export class SopNotFoundError extends Error {
  constructor(kind: string, id: string) {
    super(`${kind} was not found: ${id}`)
    this.name = 'SopNotFoundError'
  }
}

export class SopRepository {
  constructor(private readonly transaction: ScopedTransaction) {}

  async createRule(input: Readonly<CreateSopRuleInput>): Promise<SopRule> {
    requirePattern(input.code, /^[a-z][a-z0-9_.-]{2,127}$/, 'SOP code')
    requireText(input.name, 'SOP name', 128)
    const result = await this.transaction.query<RuleRow>(`
      INSERT INTO mbox.sop_rules (
        tenant_id, store_id, code, name, description, created_by_employee_id
      ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::uuid)
      RETURNING id, code, name, description, status
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.code,
      input.name.trim(),
      input.description?.trim() || null,
      input.createdByEmployeeId,
    ])
    return mapRule(requiredRow(result, 'SOP rule'))
  }

  async createDraftVersion(input: Readonly<CreateSopVersionInput>): Promise<SopRuleVersion> {
    positiveInteger(input.versionNumber, 'versionNumber', 1_000_000)
    requirePattern(input.triggerEvent, /^[a-z][a-z0-9_.-]{2,127}$/, 'triggerEvent')
    nonNegativeInteger(input.triggerDelayMs ?? 0, 'triggerDelayMs', 2_592_000_000)
    const result = await this.transaction.query<VersionRow>(`
      INSERT INTO mbox.sop_rule_versions (
        tenant_id, store_id, sop_rule_id, version_number, trigger_event,
        trigger_delay_ms, trigger_condition, end_condition, created_by_employee_id
      ) SELECT $1::uuid, $2::uuid, rule.id, $4, $5, $6, $7::jsonb, $8::jsonb, $9::uuid
      FROM mbox.sop_rules AS rule
      WHERE rule.tenant_id = $1::uuid AND rule.store_id = $2::uuid
        AND rule.id = $3::uuid AND rule.status = 'active'
      RETURNING ${VERSION_COLUMNS}
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.ruleId,
      input.versionNumber,
      input.triggerEvent,
      input.triggerDelayMs ?? 0,
      JSON.stringify(input.triggerCondition ?? {}),
      JSON.stringify(input.endCondition ?? {}),
      input.createdByEmployeeId,
    ])
    if (result.rowCount !== 1) throw new SopNotFoundError('active SOP rule', input.ruleId)
    return mapVersion(requiredRow(result, 'SOP version'))
  }

  async addStep(input: Readonly<AddSopStepInput>): Promise<SopRuleStep> {
    requirePattern(input.stepKey, /^[a-z][a-z0-9_.-]{1,63}$/, 'stepKey')
    positiveInteger(input.stepOrder, 'stepOrder', 1_000)
    requireText(input.name, 'step name', 128)
    requirePattern(input.actionName, /^[a-z][a-z0-9_.-]{2,127}$/, 'actionName')
    nonNegativeInteger(input.delayMs ?? 0, 'delayMs', 2_592_000_000)
    if (input.escalationAfterMs !== undefined && input.escalationAfterMs !== null) {
      positiveInteger(input.escalationAfterMs, 'escalationAfterMs', 2_592_000_000)
    }
    positiveInteger(input.maxAttempts ?? 3, 'maxAttempts', 20)
    const result = await this.transaction.query<StepRow>(`
      INSERT INTO mbox.sop_rule_steps (
        tenant_id, store_id, sop_rule_version_id, step_key, step_order, name,
        delay_ms, condition_snapshot, action_name, action_input,
        requested_role_code, assigned_employee_id, escalation_after_ms,
        escalation_role_code, escalation_employee_id, end_condition, max_attempts
      ) VALUES (
        $1::uuid, $2::uuid, $3::uuid, $4, $5, $6,
        $7, $8::jsonb, $9, $10::jsonb,
        $11, $12::uuid, $13, $14, $15::uuid, $16::jsonb, $17
      ) RETURNING ${STEP_COLUMNS}
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.versionId,
      input.stepKey,
      input.stepOrder,
      input.name.trim(),
      input.delayMs ?? 0,
      JSON.stringify(input.condition ?? {}),
      input.actionName,
      JSON.stringify(input.actionInput ?? {}),
      input.requestedRoleCode ?? null,
      input.assignedEmployeeId ?? null,
      input.escalationAfterMs ?? null,
      input.escalationRoleCode ?? null,
      input.escalationEmployeeId ?? null,
      JSON.stringify(input.endCondition ?? {}),
      input.maxAttempts ?? 3,
    ])
    return mapStep(requiredRow(result, 'SOP step'))
  }

  async publishVersion(versionId: string, employeeId: string): Promise<SopRuleVersion> {
    const count = await this.transaction.query<{ step_count: string }>(`
      SELECT count(*)::text AS step_count
      FROM mbox.sop_rule_steps
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid
        AND sop_rule_version_id = $3::uuid
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, versionId])
    if (Number(count.rows[0]?.step_count ?? 0) < 1) {
      throw new SopDefinitionError('SOP version must contain at least one step before publication')
    }
    const retired = await this.transaction.query(`
      UPDATE mbox.sop_rule_versions AS current
      SET status = 'retired', retired_at = clock_timestamp(),
          aggregate_version = current.aggregate_version + 1
      FROM mbox.sop_rule_versions AS target
      WHERE target.tenant_id = $1::uuid AND target.store_id = $2::uuid
        AND target.id = $3::uuid AND target.status = 'draft'
        AND current.tenant_id = target.tenant_id AND current.store_id = target.store_id
        AND current.sop_rule_id = target.sop_rule_id AND current.status = 'published'
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, versionId])
    if (retired.rowCount !== null && retired.rowCount > 1) {
      throw new SopDefinitionError('More than one published SOP version was found')
    }
    const result = await this.transaction.query<VersionRow>(`
      UPDATE mbox.sop_rule_versions
      SET status = 'published', published_by_employee_id = $4::uuid,
          published_at = clock_timestamp(), aggregate_version = aggregate_version + 1
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid
        AND id = $3::uuid AND status = 'draft'
      RETURNING ${VERSION_COLUMNS}
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, versionId, employeeId])
    if (result.rowCount !== 1) throw new SopDefinitionError('Only a draft SOP version can be published')
    return mapVersion(requiredRow(result, 'published SOP version'))
  }

  async trigger(input: Readonly<TriggerSopInput>): Promise<SopInstance[]> {
    requirePattern(input.triggerEvent, /^[a-z][a-z0-9_.-]{2,127}$/, 'triggerEvent')
    requireText(input.triggerReference, 'triggerReference', 256)
    const candidates = await this.transaction.query<PublishedCandidateRow>(`
      SELECT version.*, version.sop_rule_id AS rule_id
      FROM mbox.sop_rule_versions AS version
      JOIN mbox.sop_rules AS rule
        ON rule.tenant_id = version.tenant_id AND rule.store_id = version.store_id
       AND rule.id = version.sop_rule_id
      WHERE version.tenant_id = $1::uuid AND version.store_id = $2::uuid
        AND version.status = 'published' AND rule.status = 'active'
        AND version.trigger_event = $3
      ORDER BY rule.code, version.version_number DESC
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, input.triggerEvent])
    const instances: SopInstance[] = []
    for (const candidate of candidates.rows) {
      if (!matchesSopCondition(candidate.trigger_condition, input.context)) continue
      const firstStep = await this.transaction.query<StepRow>(`
        SELECT ${STEP_COLUMNS}
        FROM mbox.sop_rule_steps
        WHERE tenant_id = $1::uuid AND store_id = $2::uuid
          AND sop_rule_version_id = $3::uuid
        ORDER BY step_order, id
        LIMIT 1
      `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, candidate.id])
      const step = firstStep.rows[0]
      if (step === undefined) throw new SopDefinitionError(`Published SOP version has no steps: ${candidate.id}`)
      const inserted = await this.transaction.query<InstanceRow>(`
        INSERT INTO mbox.sop_instances (
          tenant_id, store_id, sop_rule_id, sop_rule_version_id,
          trigger_event, trigger_reference, business_date, context_snapshot,
          current_step_order
        ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7::date, $8::jsonb, $9)
        ON CONFLICT (
          tenant_id, store_id, sop_rule_version_id, trigger_event, trigger_reference
        ) DO NOTHING
        RETURNING ${INSTANCE_COLUMNS}
      `, [
        this.transaction.scope.tenantId,
        this.transaction.scope.storeId,
        candidate.rule_id,
        candidate.id,
        input.triggerEvent,
        input.triggerReference,
        input.businessDate,
        JSON.stringify(input.context),
        step.step_order,
      ])
      const row = inserted.rows[0]
      if (row === undefined) continue
      const delayMs = Number(candidate.trigger_delay_ms) + Number(step.delay_ms)
      const execution = await this.transaction.query<ExecutionRow>(`
        INSERT INTO mbox.sop_step_executions (
          tenant_id, store_id, sop_instance_id, sop_rule_step_id,
          scheduled_at, next_attempt_at
        ) VALUES (
          $1::uuid, $2::uuid, $3::uuid, $4::uuid,
          clock_timestamp() + ($5::bigint * interval '1 millisecond'),
          clock_timestamp() + ($5::bigint * interval '1 millisecond')
        ) RETURNING ${EXECUTION_COLUMNS}
      `, [
        this.transaction.scope.tenantId,
        this.transaction.scope.storeId,
        row.id,
        step.id,
        delayMs,
      ])
      requiredRow(execution, 'SOP step execution')
      instances.push(mapInstance(row))
    }
    return instances
  }
}

export interface SopCommandInput {
  scope: Readonly<StoreScope>
  employeeId: string
  businessDate: string
  idempotencyKey: string
  requestFingerprint: string
  trigger: TriggerSopInput
}

export class SopCommandService {
  constructor(private readonly commands: Pick<NormalizedCommandExecutor, 'execute'>) {}

  trigger(input: Readonly<SopCommandInput>) {
    return this.commands.execute({
      scope: input.scope,
      operationScope: 'sop.trigger',
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: input.requestFingerprint,
      resultCodec: sopInstancesCodec,
    }, async (transaction) => {
      await new StaffAccessRepository(transaction).assertPermission(input.employeeId, 'sop.execute')
      const instances = await new SopRepository(transaction).trigger(input.trigger)
      return {
        result: instances,
        auditEvents: instances.map((instance) => ({
          actor: employeeActor(input.employeeId),
          action: 'sop.instance.started',
          objectType: 'sop_instance',
          objectId: instance.id,
          businessDate: input.businessDate,
          afterData: instanceToJson(instance),
        })),
        outboxMessages: instances.map((instance) => ({
          aggregateType: 'sop_instance',
          aggregateId: instance.id,
          aggregateVersion: instance.aggregateVersion,
          eventType: 'sop.instance.started.v1',
          payload: instanceToJson(instance),
        })),
      }
    })
  }
}

export function matchesSopCondition(condition: JsonObject, facts: JsonObject): boolean {
  if (Object.keys(condition).length === 0) return true
  if (Array.isArray(condition.all)) {
    return condition.all.every((entry) => isObject(entry) && matchesSopCondition(entry, facts))
  }
  if (Array.isArray(condition.any)) {
    return condition.any.some((entry) => isObject(entry) && matchesSopCondition(entry, facts))
  }
  if (isObject(condition.not)) return !matchesSopCondition(condition.not, facts)
  const factPath = condition.fact
  const operator = condition.operator
  if (typeof factPath !== 'string' || typeof operator !== 'string') return false
  const actual = readPath(facts, factPath)
  switch (operator) {
    case 'exists': return actual !== undefined
    case 'not_exists': return actual === undefined
    case 'eq': return stableJson(actual) === stableJson(condition.value)
    case 'neq': return stableJson(actual) !== stableJson(condition.value)
    case 'in': return Array.isArray(condition.value)
      && condition.value.some((value) => stableJson(value) === stableJson(actual))
    case 'gte': return typeof actual === 'number' && typeof condition.value === 'number'
      && actual >= condition.value
    case 'lte': return typeof actual === 'number' && typeof condition.value === 'number'
      && actual <= condition.value
    default: return false
  }
}

const sopInstancesCodec: JsonCodec<SopInstance[]> = {
  encode: (instances) => instances.map(instanceToJson),
  decode: (value) => {
    if (!Array.isArray(value)) throw new TypeError('Stored SOP result is invalid')
    return value.map((entry) => {
      if (!isObject(entry)) throw new TypeError('Stored SOP instance is invalid')
      return {
        id: readString(entry.id),
        ruleId: readString(entry.ruleId),
        versionId: readString(entry.versionId),
        triggerEvent: readString(entry.triggerEvent),
        triggerReference: readString(entry.triggerReference),
        businessDate: readString(entry.businessDate),
        context: isObject(entry.context) ? entry.context : {},
        status: readString(entry.status) as SopInstanceStatus,
        currentStepOrder: readNumber(entry.currentStepOrder),
        aggregateVersion: readNumber(entry.aggregateVersion),
      }
    })
  },
}

function employeeActor(employeeId: string): AuditActor {
  return { type: 'employee', employeeId }
}

function mapRule(row: RuleRow): SopRule {
  return { id: row.id, code: row.code, name: row.name, description: row.description, status: row.status }
}

function mapVersion(row: VersionRow): SopRuleVersion {
  return {
    id: row.id,
    ruleId: row.sop_rule_id,
    versionNumber: row.version_number,
    status: row.status,
    triggerEvent: row.trigger_event,
    triggerDelayMs: Number(row.trigger_delay_ms),
    triggerCondition: row.trigger_condition,
    endCondition: row.end_condition,
    aggregateVersion: Number(row.aggregate_version),
  }
}

function mapStep(row: StepRow): SopRuleStep {
  return {
    id: row.id,
    versionId: row.sop_rule_version_id,
    stepKey: row.step_key,
    stepOrder: row.step_order,
    name: row.name,
    delayMs: Number(row.delay_ms),
    condition: row.condition_snapshot,
    actionName: row.action_name,
    actionInput: row.action_input,
    requestedRoleCode: row.requested_role_code,
    assignedEmployeeId: row.assigned_employee_id,
    escalationAfterMs: row.escalation_after_ms === null ? null : Number(row.escalation_after_ms),
    escalationRoleCode: row.escalation_role_code,
    escalationEmployeeId: row.escalation_employee_id,
    endCondition: row.end_condition,
    maxAttempts: row.max_attempts,
  }
}

function mapInstance(row: InstanceRow): SopInstance {
  return {
    id: row.id,
    ruleId: row.sop_rule_id,
    versionId: row.sop_rule_version_id,
    triggerEvent: row.trigger_event,
    triggerReference: row.trigger_reference,
    businessDate: row.business_date,
    context: row.context_snapshot,
    status: row.status,
    currentStepOrder: row.current_step_order,
    aggregateVersion: Number(row.aggregate_version),
  }
}

function instanceToJson(instance: SopInstance): JsonObject {
  return {
    id: instance.id,
    ruleId: instance.ruleId,
    versionId: instance.versionId,
    triggerEvent: instance.triggerEvent,
    triggerReference: instance.triggerReference,
    businessDate: instance.businessDate,
    context: instance.context,
    status: instance.status,
    currentStepOrder: instance.currentStepOrder,
    aggregateVersion: instance.aggregateVersion,
  }
}

function readPath(value: JsonObject, path: string): JsonValue | undefined {
  let current: JsonValue | undefined = value
  for (const segment of path.split('.')) {
    if (!isObject(current) || !Object.hasOwn(current, segment)) return undefined
    current = current[segment]
  }
  return current
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (isObject(value)) {
    return `{${Object.keys(value).toSorted().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredRow<Row extends Record<string, unknown>>(
  result: { rows: Row[]; rowCount: number | null },
  label: string,
): Row {
  const row = result.rows[0]
  if (result.rowCount !== 1 || row === undefined) throw new Error(`${label} write did not affect one row`)
  return row
}

function requirePattern(value: string, pattern: RegExp, label: string): void {
  if (!pattern.test(value)) throw new TypeError(`${label} is invalid`)
}

function requireText(value: string, label: string, max: number): void {
  if (value.trim().length < 1 || value.length > max) throw new TypeError(`${label} is invalid`)
}

function positiveInteger(value: number, label: string, max: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new TypeError(`${label} is invalid`)
}

function nonNegativeInteger(value: number, label: string, max: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) throw new TypeError(`${label} is invalid`)
}

function readString(value: JsonValue | undefined): string {
  if (typeof value !== 'string') throw new TypeError('Stored string is invalid')
  return value
}

function readNumber(value: JsonValue | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError('Stored number is invalid')
  return value
}

export const VERSION_COLUMNS = `
  id, sop_rule_id, version_number, status, trigger_event, trigger_delay_ms,
  trigger_condition, end_condition, aggregate_version
`
export const STEP_COLUMNS = `
  id, sop_rule_version_id, step_key, step_order, name, delay_ms,
  condition_snapshot, action_name, action_input, requested_role_code,
  assigned_employee_id, escalation_after_ms, escalation_role_code,
  escalation_employee_id, end_condition, max_attempts
`
export const INSTANCE_COLUMNS = `
  id, sop_rule_id, sop_rule_version_id, trigger_event, trigger_reference,
  business_date::text, context_snapshot, status, current_step_order, aggregate_version
`
export const EXECUTION_COLUMNS = `
  id, sop_instance_id, sop_rule_step_id, status, scheduled_at::text,
  next_attempt_at::text, attempt_count, external_reference, output_snapshot
`
