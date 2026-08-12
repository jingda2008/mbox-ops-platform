import type { JsonObject } from './command-executor.js'
import {
  StaffAccessDeniedError,
  StaffAccessRepository,
  StaffNotFoundError as AccessStaffNotFoundError,
} from './staff-access-repository.js'
import {
  ScopedPostgresTransactionRunner,
  type ScopedTransaction,
  type StoreScope,
} from './transaction-runner.js'

export interface StaffAccessView {
  id: string
  employeeCode: string
  displayName: string
  roleCodes: string[]
  roleNames: string[]
  capabilities: string[]
}

export interface OperationsTableView {
  id: string
  code: string
  displayName: string
  areaId: string
  areaName: string
  capacity: number
  status: 'available' | 'paused' | 'retired'
  assignedToActor: boolean
  activeSession: null | {
    id: string
    publicId: string
    businessDate: string
    guestCount: number
    guestProfileSnapshot: JsonObject
    latestMood: null | {
      code: string
      occurredAt: string
    }
    status: 'open' | 'closing'
    openedAt: string
  }
}

export interface OperationsTaskView {
  id: string
  publicId: string
  tableId: string
  tableCode: string
  tableSessionId: string
  taskType: string
  title: string
  detail: string | null
  priority: 'low' | 'normal' | 'high' | 'urgent'
  status: 'pending' | 'acknowledged' | 'in_progress'
  source: 'guest' | 'employee' | 'sop' | 'ai' | 'system'
  requestedRoleCode: string | null
  assignedEmployeeId: string | null
  backupEmployeeId: string | null
  assignedToActor: boolean
  interactionMode: 'quick_complete' | 'manager_resolution'
  dueAt: string | null
  escalateAt: string | null
  createdAt: string
}

export interface StaffOperationsView {
  store: {
    id: string
    code: string
    name: string
    timezone: string
    businessDayCutoff: string
  }
  actor: StaffAccessView
  tables: OperationsTableView[]
  tasks: OperationsTaskView[]
}

interface StoreRow extends Record<string, unknown> {
  id: string
  code: string
  name: string
  timezone: string
  business_day_cutoff: string
}

interface TableRow extends Record<string, unknown> {
  id: string
  code: string
  display_name: string
  area_id: string
  area_name: string
  capacity: number
  status: OperationsTableView['status']
  assigned_to_actor: boolean
  session_id: string | null
  session_public_id: string | null
  business_date: string | null
  guest_count: number | null
  guest_profile_snapshot: JsonObject | null
  mood_code: string | null
  mood_occurred_at: string | null
  session_status: 'open' | 'closing' | null
  opened_at: string | null
}

interface TaskRow extends Record<string, unknown> {
  id: string
  public_id: string
  table_id: string
  table_code: string
  table_session_id: string
  task_type: string
  title: string
  detail: string | null
  priority: OperationsTaskView['priority']
  status: OperationsTaskView['status']
  source: OperationsTaskView['source']
  requested_role_code: string | null
  assigned_employee_id: string | null
  backup_employee_id: string | null
  assigned_to_actor: boolean
  interaction_mode: OperationsTaskView['interactionMode']
  due_at: string | null
  escalate_at: string | null
  created_at: string
}

export class StaffNotFoundError extends Error {
  constructor(employeeId: string) {
    super(`Active employee was not found: ${employeeId}`)
    this.name = 'StaffNotFoundError'
  }
}

export class OperationsQueryService {
  constructor(private readonly transactions: ScopedPostgresTransactionRunner) {}

  getStaffView(
    scope: Readonly<StoreScope>,
    employeeId: string,
  ): Promise<StaffOperationsView> {
    if (employeeId.trim().length === 0) throw new TypeError('employeeId must not be blank')
    return this.transactions.run(scope, async (transaction) => {
      const store = await readStore(transaction)
      const actor = await readStaffAccess(transaction, employeeId)
      if (actor === null) throw new StaffNotFoundError(employeeId)
      const includeAllTables = actor.capabilities.includes('table.view_all')
      const tables = await readTables(transaction, employeeId, includeAllTables)
      const tasks = await readTasks(
        transaction,
        employeeId,
        actor.roleCodes,
        includeAllTables,
        actor.capabilities.includes('service.manage'),
      )
      return { store, actor, tables, tasks }
    }, { isolation: 'repeatable-read', readOnly: true })
  }
}

async function readStore(transaction: ScopedTransaction): Promise<StaffOperationsView['store']> {
  const result = await transaction.query<StoreRow>(`
    SELECT id, code, name, timezone, business_day_cutoff::text
    FROM mbox.stores
    WHERE tenant_id = $1::uuid AND id = $2::uuid AND status = 'active'
  `, [transaction.scope.tenantId, transaction.scope.storeId])
  const row = result.rows[0]
  if (result.rowCount !== 1 || row === undefined) throw new Error('Active store was not found')
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    timezone: row.timezone,
    businessDayCutoff: row.business_day_cutoff,
  }
}

async function readStaffAccess(
  transaction: ScopedTransaction,
  employeeId: string,
): Promise<StaffAccessView | null> {
  try {
    const access = await new StaffAccessRepository(transaction).resolve(employeeId)
    return {
      id: access.employeeId,
      employeeCode: access.employeeCode,
      displayName: access.displayName,
      roleCodes: access.roleCodes,
      roleNames: access.roleNames,
      capabilities: access.permissions,
    }
  } catch (error) {
    if (error instanceof AccessStaffNotFoundError || error instanceof StaffAccessDeniedError) return null
    throw error
  }
}

async function readTables(
  transaction: ScopedTransaction,
  employeeId: string,
  includeAllTables: boolean,
): Promise<OperationsTableView[]> {
  const result = await transaction.query<TableRow>(`
    SELECT venue_table.id, venue_table.code, venue_table.display_name,
      venue_table.area_id, area.name AS area_name, venue_table.capacity, venue_table.status,
      EXISTS (
        SELECT 1 FROM mbox.table_assignments assignment
        WHERE assignment.tenant_id = venue_table.tenant_id
          AND assignment.store_id = venue_table.store_id
          AND assignment.table_id = venue_table.id
          AND assignment.employee_id = $3::uuid
          AND assignment.starts_at <= clock_timestamp()
          AND (assignment.ends_at IS NULL OR assignment.ends_at > clock_timestamp())
      ) AS assigned_to_actor,
      session.id AS session_id, session.public_id AS session_public_id,
      session.business_date::text, session.guest_count, session.guest_profile_snapshot,
      latest_mood.mood_code, latest_mood.mood_occurred_at,
      session.status AS session_status, session.opened_at::text
    FROM mbox.tables venue_table
    JOIN mbox.areas area
      ON area.tenant_id = venue_table.tenant_id
      AND area.store_id = venue_table.store_id
      AND area.id = venue_table.area_id
    LEFT JOIN mbox.table_sessions session
      ON session.tenant_id = venue_table.tenant_id
      AND session.store_id = venue_table.store_id
      AND session.table_id = venue_table.id
      AND session.status IN ('open', 'closing')
    LEFT JOIN LATERAL (
      SELECT behavior.behavior_code AS mood_code,
        behavior.occurred_at::text AS mood_occurred_at
      FROM mbox.guest_behavior_events behavior
      WHERE behavior.tenant_id = venue_table.tenant_id
        AND behavior.store_id = venue_table.store_id
        AND behavior.table_session_id = session.id
        AND behavior.behavior_type = 'guest.mood.selected'
        AND behavior.behavior_code IS NOT NULL
      ORDER BY behavior.occurred_at DESC, behavior.id DESC
      LIMIT 1
    ) latest_mood ON session.id IS NOT NULL
    WHERE venue_table.tenant_id = $1::uuid
      AND venue_table.store_id = $2::uuid
      AND venue_table.status <> 'retired'
      AND ($4::boolean OR EXISTS (
        SELECT 1 FROM mbox.table_assignments visible_assignment
        WHERE visible_assignment.tenant_id = venue_table.tenant_id
          AND visible_assignment.store_id = venue_table.store_id
          AND visible_assignment.table_id = venue_table.id
          AND visible_assignment.employee_id = $3::uuid
          AND visible_assignment.starts_at <= clock_timestamp()
          AND (visible_assignment.ends_at IS NULL OR visible_assignment.ends_at > clock_timestamp())
      ))
    ORDER BY area.sort_order, venue_table.code
  `, [transaction.scope.tenantId, transaction.scope.storeId, employeeId, includeAllTables])
  return result.rows.map(mapTable)
}

async function readTasks(
  transaction: ScopedTransaction,
  employeeId: string,
  roleCodes: readonly string[],
  includeAllTables: boolean,
  canManageService: boolean,
): Promise<OperationsTaskView[]> {
  const result = await transaction.query<TaskRow>(`
    SELECT task.id, task.public_id, task.table_id, venue_table.code AS table_code,
      task.table_session_id, task.task_type, task.title, task.detail, task.priority,
      task.status, task.source, task.requested_role_code, task.assigned_employee_id,
      task.backup_employee_id,
      (
        task.assigned_employee_id = $3::uuid
        OR task.backup_employee_id = $3::uuid
        OR EXISTS (
          SELECT 1 FROM mbox.table_assignments responsibility
          WHERE responsibility.tenant_id = task.tenant_id
            AND responsibility.store_id = task.store_id
            AND responsibility.table_id = task.table_id
            AND responsibility.employee_id = $3::uuid
            AND responsibility.starts_at <= clock_timestamp()
            AND (responsibility.ends_at IS NULL OR responsibility.ends_at > clock_timestamp())
        )
      ) AS assigned_to_actor,
      CASE WHEN task.task_type = 'guest.complaint'
        THEN 'manager_resolution' ELSE 'quick_complete' END AS interaction_mode,
      task.due_at::text, task.escalate_at::text, task.created_at::text
    FROM mbox.service_tasks task
    JOIN mbox.tables venue_table
      ON venue_table.tenant_id = task.tenant_id
      AND venue_table.store_id = task.store_id
      AND venue_table.id = task.table_id
    WHERE task.tenant_id = $1::uuid
      AND task.store_id = $2::uuid
      AND task.status IN ('pending', 'acknowledged', 'in_progress')
      AND (task.task_type <> 'guest.complaint' OR $6::boolean)
      AND (
        $5::boolean
        OR task.assigned_employee_id = $3::uuid
        OR task.backup_employee_id = $3::uuid
        OR (task.assigned_employee_id IS NULL AND task.requested_role_code = ANY($4::text[]))
        OR EXISTS (
          SELECT 1 FROM mbox.table_assignments assignment
          WHERE assignment.tenant_id = task.tenant_id
            AND assignment.store_id = task.store_id
            AND assignment.table_id = task.table_id
            AND assignment.employee_id = $3::uuid
            AND assignment.starts_at <= clock_timestamp()
            AND (assignment.ends_at IS NULL OR assignment.ends_at > clock_timestamp())
        )
      )
    ORDER BY
      CASE task.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
      task.due_at NULLS LAST,
      task.created_at,
      task.id
  `, [
    transaction.scope.tenantId,
    transaction.scope.storeId,
    employeeId,
    [...roleCodes],
    includeAllTables,
    canManageService,
  ])
  return result.rows.map((row) => ({
    id: row.id,
    publicId: row.public_id,
    tableId: row.table_id,
    tableCode: row.table_code,
    tableSessionId: row.table_session_id,
    taskType: row.task_type,
    title: row.title,
    detail: row.detail,
    priority: row.priority,
    status: row.status,
    source: row.source,
    requestedRoleCode: row.requested_role_code,
    assignedEmployeeId: row.assigned_employee_id,
    backupEmployeeId: row.backup_employee_id,
    assignedToActor: row.assigned_to_actor,
    interactionMode: row.interaction_mode,
    dueAt: row.due_at,
    escalateAt: row.escalate_at,
    createdAt: row.created_at,
  }))
}

function mapTable(row: TableRow): OperationsTableView {
  return {
    id: row.id,
    code: row.code,
    displayName: row.display_name,
    areaId: row.area_id,
    areaName: row.area_name,
    capacity: row.capacity,
    status: row.status,
    assignedToActor: row.assigned_to_actor,
    activeSession: row.session_id === null ? null : {
      id: row.session_id,
      publicId: row.session_public_id!,
      businessDate: row.business_date!,
      guestCount: row.guest_count!,
      guestProfileSnapshot: row.guest_profile_snapshot ?? {},
      latestMood: row.mood_code === null || row.mood_occurred_at === null
        ? null
        : { code: row.mood_code, occurredAt: row.mood_occurred_at },
      status: row.session_status!,
      openedAt: row.opened_at!,
    },
  }
}
