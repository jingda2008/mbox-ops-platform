import type {
  AuditActor,
  CommandExecution,
  JsonCodec,
  JsonObject,
  NormalizedCommandExecutor,
} from './command-executor.js'
import { StaffAccessRepository, type EffectiveStaffAccess } from './staff-access-repository.js'
import type { ScopedTransaction, StoreScope } from './transaction-runner.js'

export const TABLE_OPEN_PERMISSION = 'table.open'
export const TABLE_VIEW_ALL_PERMISSION = 'table.view_all'
export const TABLE_MANAGE_PERMISSION = 'table.manage'
export const TABLE_ASSIGNMENT_MANAGE_PERMISSION = 'table.assignment.manage'
export const TABLE_TRANSFER_PERMISSION = 'table.transfer'

export type AreaStatus = 'active' | 'paused' | 'retired'
export type TableStatus = 'available' | 'paused' | 'retired'
export type AssignmentType = 'primary' | 'backup' | 'temporary'

export interface ManagedArea {
  id: string
  code: string
  name: string
  areaType: 'indoor' | 'outdoor' | 'bar' | 'stage' | 'vip' | 'other'
  sortOrder: number
  layoutSnapshot: JsonObject
  status: AreaStatus
  createdAt: string
  updatedAt: string
}

export interface ManagedTable {
  id: string
  areaId: string
  areaCode: string
  areaName: string
  code: string
  displayName: string
  capacity: number
  minimumSpendMinor: number | null
  currency: string
  layoutSnapshot: JsonObject
  status: TableStatus
  assignedToActor: boolean
  activeSessionId: string | null
  activeGuestCount: number | null
  createdAt: string
  updatedAt: string
}

export interface TableResponsibilityAssignment {
  id: string
  tableId: string
  tableCode: string
  employeeId: string
  employeeName: string
  roleId: string
  roleCode: string
  assignmentType: AssignmentType
  startsAt: string
  endsAt: string | null
  reason: string
  createdByEmployeeId: string | null
  createdAt: string
  updatedAt: string
}

export interface ManagedTableSession {
  id: string
  tableId: string
  tableCode: string
  publicId: string
  businessDate: string
  guestCount: number
  capacityAtOpen: number
  capacityOverrideReason: string | null
  capacityOverriddenByEmployeeId: string | null
  guestProfileSnapshot: JsonObject
  status: 'open' | 'closing' | 'closed' | 'cancelled'
  openedByEmployeeId: string | null
  openedAt: string
}

export interface TableTransferResult {
  eventId: string
  tableSessionId: string
  sourceTableId: string
  sourceTableCode: string
  targetTableId: string
  targetTableCode: string
  reason: string
  ownershipSnapshot: JsonObject
  occurredAt: string
}

export interface TableTransferOwnershipPort {
  capture(transaction: ScopedTransaction, tableSessionId: string): Promise<JsonObject>
}

export interface TableManagementCommandBase {
  scope: Readonly<StoreScope>
  actor: AuditActor & { type: 'employee'; employeeId: string }
  businessDate: string
  reason: string
  idempotencyKey: string
  requestFingerprint: string
}

export interface CreateAreaCommand extends TableManagementCommandBase {
  code: string
  name: string
  areaType: ManagedArea['areaType']
  sortOrder: number
  layoutSnapshot?: JsonObject
  status: AreaStatus
}

export interface UpdateAreaCommand extends TableManagementCommandBase {
  areaId: string
  name: string
  areaType: ManagedArea['areaType']
  sortOrder: number
  layoutSnapshot?: JsonObject
  status: AreaStatus
}

export interface CreateTableCommand extends TableManagementCommandBase {
  areaId: string
  code: string
  displayName: string
  capacity: number
  minimumSpendMinor?: number | null
  currency?: string
  layoutSnapshot?: JsonObject
  status: TableStatus
}

export interface UpdateTableCommand extends TableManagementCommandBase {
  tableId: string
  areaId: string
  code: string
  displayName: string
  capacity: number
  minimumSpendMinor?: number | null
  currency?: string
  layoutSnapshot?: JsonObject
  status: TableStatus
}

export interface AssignTableCommand extends TableManagementCommandBase {
  tableId: string
  employeeId: string
  roleId: string
  assignmentType: AssignmentType
  startsAt: string
  endsAt?: string | null
}

export interface EndAssignmentCommand extends TableManagementCommandBase {
  assignmentId: string
  endsAt: string
}

export interface OpenManagedTableCommand extends TableManagementCommandBase {
  tableId: string
  publicId: string
  guestCount: number
  capacityOverrideReason?: string | null
  guestProfileSnapshot?: JsonObject
}

export interface TransferTableCommand extends TableManagementCommandBase {
  tableSessionId: string
  targetTableId: string
  capacityOverrideReason?: string | null
}

type AreaCreateInput = Omit<CreateAreaCommand, keyof TableManagementCommandBase>
type AreaUpdateInput = Omit<UpdateAreaCommand, keyof TableManagementCommandBase>
type TableCreateInput = Omit<CreateTableCommand, keyof TableManagementCommandBase>
type TableUpdateInput = Omit<UpdateTableCommand, keyof TableManagementCommandBase>
type AssignmentCreateInput = Omit<AssignTableCommand, keyof TableManagementCommandBase> & {
  reason: string
  createdByEmployeeId: string
}
type ManagedOpenInput = Omit<OpenManagedTableCommand, keyof TableManagementCommandBase> & {
  businessDate: string
  openedByEmployeeId: string
}
type ManagedTransferInput = Omit<TransferTableCommand, keyof TableManagementCommandBase> & {
  reason: string
  transferredByEmployeeId: string
}

interface AreaRow extends Record<string, unknown> {
  id: string
  code: string
  name: string
  area_type: ManagedArea['areaType']
  sort_order: number
  layout_snapshot: JsonObject
  status: AreaStatus
  created_at: string
  updated_at: string
}

interface TableRow extends Record<string, unknown> {
  id: string
  area_id: string
  area_code: string
  area_name: string
  code: string
  display_name: string
  capacity: number
  minimum_spend_minor: string | null
  currency: string
  layout_snapshot: JsonObject
  status: TableStatus
  assigned_to_actor: boolean
  active_session_id: string | null
  active_guest_count: number | null
  created_at: string
  updated_at: string
}

interface AssignmentRow extends Record<string, unknown> {
  id: string
  table_id: string
  table_code: string
  employee_id: string
  employee_name: string
  role_id: string
  role_code: string
  assignment_type: AssignmentType
  starts_at: string
  ends_at: string | null
  reason: string
  created_by_employee_id: string | null
  created_at: string
  updated_at: string
}

interface SessionRow extends Record<string, unknown> {
  id: string
  table_id: string
  table_code: string
  public_id: string
  business_date: string
  guest_count: number
  capacity_at_open: number
  capacity_override_reason: string | null
  capacity_overridden_by_employee_id: string | null
  guest_profile_snapshot: JsonObject
  status: ManagedTableSession['status']
  opened_by_employee_id: string | null
  opened_at: string
}

interface TransferRow extends Record<string, unknown> {
  event_id: string
  table_session_id: string
  source_table_id: string
  source_table_code: string
  target_table_id: string
  target_table_code: string
  reason: string
  ownership_snapshot: JsonObject
  occurred_at: string
}

export class TableManagementNotFoundError extends Error {
  constructor(resource: string) {
    super(`${resource}不存在或不属于当前门店`)
    this.name = 'TableManagementNotFoundError'
  }
}

export class TableManagementConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TableManagementConflictError'
  }
}

export class CapacityOverrideReasonRequiredError extends Error {
  constructor(capacity: number, guestCount: number) {
    super(`人数${guestCount}超过桌台容量${capacity}，必须填写加座原因`)
    this.name = 'CapacityOverrideReasonRequiredError'
  }
}

export class TableManagementRepository {
  constructor(private readonly transaction: ScopedTransaction) {}

  async listAreas(access: EffectiveStaffAccess, at = new Date().toISOString()): Promise<ManagedArea[]> {
    const viewAll = canViewAllTables(access)
    const result = await this.transaction.query<AreaRow>(`
      SELECT area.id, area.code, area.name, area.area_type, area.sort_order,
        area.layout_snapshot, area.status, area.created_at::text, area.updated_at::text
      FROM mbox.areas AS area
      WHERE area.tenant_id = $1::uuid AND area.store_id = $2::uuid
        AND (
          $3::boolean
          OR EXISTS (
            SELECT 1 FROM mbox.tables AS venue_table
            JOIN mbox.table_assignments AS assignment
              ON assignment.tenant_id = venue_table.tenant_id
             AND assignment.store_id = venue_table.store_id
             AND assignment.table_id = venue_table.id
            WHERE venue_table.tenant_id = area.tenant_id
              AND venue_table.store_id = area.store_id
              AND venue_table.area_id = area.id
              AND assignment.employee_id = $4::uuid
              AND assignment.starts_at <= $5::timestamptz
              AND (assignment.ends_at IS NULL OR assignment.ends_at > $5::timestamptz)
          )
        )
      ORDER BY area.sort_order, area.code, area.id
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, viewAll, access.employeeId, at])
    return result.rows.map(mapArea)
  }

  async listTables(access: EffectiveStaffAccess, at = new Date().toISOString()): Promise<ManagedTable[]> {
    const viewAll = canViewAllTables(access)
    const result = await this.transaction.query<TableRow>(`
      SELECT venue_table.id, venue_table.area_id, area.code AS area_code,
        area.name AS area_name, venue_table.code, venue_table.display_name,
        venue_table.capacity, venue_table.minimum_spend_minor::text,
        venue_table.currency, venue_table.layout_snapshot, venue_table.status,
        EXISTS (
          SELECT 1 FROM mbox.table_assignments actor_assignment
          WHERE actor_assignment.tenant_id = venue_table.tenant_id
            AND actor_assignment.store_id = venue_table.store_id
            AND actor_assignment.table_id = venue_table.id
            AND actor_assignment.employee_id = $4::uuid
            AND actor_assignment.starts_at <= $5::timestamptz
            AND (actor_assignment.ends_at IS NULL OR actor_assignment.ends_at > $5::timestamptz)
        ) AS assigned_to_actor,
        active_session.id AS active_session_id,
        active_session.guest_count AS active_guest_count,
        venue_table.created_at::text, venue_table.updated_at::text
      FROM mbox.tables AS venue_table
      JOIN mbox.areas AS area
        ON area.tenant_id = venue_table.tenant_id
       AND area.store_id = venue_table.store_id
       AND area.id = venue_table.area_id
      LEFT JOIN mbox.table_sessions AS active_session
        ON active_session.tenant_id = venue_table.tenant_id
       AND active_session.store_id = venue_table.store_id
       AND active_session.table_id = venue_table.id
       AND active_session.status IN ('open', 'closing')
      WHERE venue_table.tenant_id = $1::uuid AND venue_table.store_id = $2::uuid
        AND (
          $3::boolean
          OR EXISTS (
            SELECT 1 FROM mbox.table_assignments visible_assignment
            WHERE visible_assignment.tenant_id = venue_table.tenant_id
              AND visible_assignment.store_id = venue_table.store_id
              AND visible_assignment.table_id = venue_table.id
              AND visible_assignment.employee_id = $4::uuid
              AND visible_assignment.starts_at <= $5::timestamptz
              AND (visible_assignment.ends_at IS NULL OR visible_assignment.ends_at > $5::timestamptz)
          )
        )
      ORDER BY area.sort_order, venue_table.code, venue_table.id
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, viewAll, access.employeeId, at])
    return result.rows.map(mapTable)
  }

  async listAssignments(access: EffectiveStaffAccess, at = new Date().toISOString()): Promise<TableResponsibilityAssignment[]> {
    const viewAll = canViewAllTables(access)
    const result = await this.transaction.query<AssignmentRow>(`
      SELECT assignment.id, assignment.table_id, venue_table.code AS table_code,
        assignment.employee_id, employee.display_name AS employee_name,
        assignment.role_id, role.code AS role_code, assignment.assignment_type,
        assignment.starts_at::text, assignment.ends_at::text, assignment.reason,
        assignment.created_by_employee_id, assignment.created_at::text,
        assignment.updated_at::text
      FROM mbox.table_assignments AS assignment
      JOIN mbox.tables AS venue_table
        ON venue_table.tenant_id = assignment.tenant_id
       AND venue_table.store_id = assignment.store_id
       AND venue_table.id = assignment.table_id
      JOIN mbox.employees AS employee
        ON employee.tenant_id = assignment.tenant_id
       AND employee.store_id = assignment.store_id
       AND employee.id = assignment.employee_id
      JOIN mbox.roles AS role
        ON role.tenant_id = assignment.tenant_id
       AND role.store_id = assignment.store_id
       AND role.id = assignment.role_id
      WHERE assignment.tenant_id = $1::uuid AND assignment.store_id = $2::uuid
        AND ($3::boolean OR assignment.employee_id = $4::uuid)
        AND assignment.starts_at <= $5::timestamptz
        AND (assignment.ends_at IS NULL OR assignment.ends_at > $5::timestamptz)
      ORDER BY venue_table.code, assignment.assignment_type, employee.display_name, assignment.id
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, viewAll, access.employeeId, at])
    return result.rows.map(mapAssignment)
  }

  async createArea(input: AreaCreateInput): Promise<ManagedArea> {
    validateArea(input)
    const result = await this.transaction.query<AreaRow>(`
      INSERT INTO mbox.areas (
        tenant_id, store_id, code, name, area_type, sort_order, layout_snapshot, status
      ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb, $8)
      RETURNING id, code, name, area_type, sort_order, layout_snapshot, status,
        created_at::text, updated_at::text
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, input.code,
      input.name, input.areaType, input.sortOrder, JSON.stringify(input.layoutSnapshot ?? {}), input.status])
    return mapArea(requiredRow(result.rows[0], '区域'))
  }

  async updateArea(input: AreaUpdateInput): Promise<ManagedArea> {
    validateArea(input)
    const result = await this.transaction.query<AreaRow>(`
      UPDATE mbox.areas
      SET name = $4, area_type = $5, sort_order = $6,
          layout_snapshot = $7::jsonb, status = $8
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
      RETURNING id, code, name, area_type, sort_order, layout_snapshot, status,
        created_at::text, updated_at::text
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, input.areaId,
      input.name, input.areaType, input.sortOrder, JSON.stringify(input.layoutSnapshot ?? {}), input.status])
    return mapArea(requiredRow(result.rows[0], '区域'))
  }

  async createTable(input: TableCreateInput): Promise<ManagedTable> {
    validateTable(input)
    await this.assertArea(input.areaId)
    const result = await this.transaction.query<TableRow>(`
      WITH inserted AS (
        INSERT INTO mbox.tables (
          tenant_id, store_id, area_id, code, display_name, capacity,
          minimum_spend_minor, currency, layout_snapshot, status
        ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::bigint, $8, $9::jsonb, $10)
        RETURNING *
      )
      SELECT inserted.id, inserted.area_id, area.code AS area_code, area.name AS area_name,
        inserted.code, inserted.display_name, inserted.capacity,
        inserted.minimum_spend_minor::text, inserted.currency, inserted.layout_snapshot,
        inserted.status, false AS assigned_to_actor, NULL::uuid AS active_session_id,
        NULL::integer AS active_guest_count, inserted.created_at::text, inserted.updated_at::text
      FROM inserted JOIN mbox.areas AS area
        ON area.tenant_id = inserted.tenant_id AND area.store_id = inserted.store_id
       AND area.id = inserted.area_id
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, input.areaId, input.code,
      input.displayName, input.capacity, input.minimumSpendMinor ?? null, input.currency ?? 'CNY',
      JSON.stringify(input.layoutSnapshot ?? {}), input.status])
    return mapTable(requiredRow(result.rows[0], '桌台'))
  }

  async updateTable(input: TableUpdateInput): Promise<ManagedTable> {
    validateTable(input)
    await this.assertArea(input.areaId)
    const result = await this.transaction.query<TableRow>(`
      WITH updated AS (
        UPDATE mbox.tables
        SET area_id = $4::uuid, code = $5, display_name = $6, capacity = $7,
            minimum_spend_minor = $8::bigint, currency = $9,
            layout_snapshot = $10::jsonb, status = $11
        WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
        RETURNING *
      )
      SELECT updated.id, updated.area_id, area.code AS area_code, area.name AS area_name,
        updated.code, updated.display_name, updated.capacity,
        updated.minimum_spend_minor::text, updated.currency, updated.layout_snapshot,
        updated.status, false AS assigned_to_actor, active_session.id AS active_session_id,
        active_session.guest_count AS active_guest_count,
        updated.created_at::text, updated.updated_at::text
      FROM updated JOIN mbox.areas AS area
        ON area.tenant_id = updated.tenant_id AND area.store_id = updated.store_id
       AND area.id = updated.area_id
      LEFT JOIN mbox.table_sessions AS active_session
        ON active_session.tenant_id = updated.tenant_id
       AND active_session.store_id = updated.store_id
       AND active_session.table_id = updated.id
       AND active_session.status IN ('open', 'closing')
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, input.tableId, input.areaId,
      input.code, input.displayName, input.capacity, input.minimumSpendMinor ?? null, input.currency ?? 'CNY',
      JSON.stringify(input.layoutSnapshot ?? {}), input.status])
    return mapTable(requiredRow(result.rows[0], '桌台'))
  }

  async assign(input: AssignmentCreateInput): Promise<TableResponsibilityAssignment> {
    validateAssignment(input)
    await this.assertAssignmentReferences(input.tableId, input.employeeId, input.roleId)
    try {
      const result = await this.transaction.query<AssignmentRow>(`
        WITH inserted AS (
          INSERT INTO mbox.table_assignments (
            tenant_id, store_id, table_id, employee_id, role_id, assignment_type,
            starts_at, ends_at, reason, created_by_employee_id
          ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6,
            $7::timestamptz, $8::timestamptz, $9, $10::uuid)
          RETURNING *
        )
        SELECT inserted.id, inserted.table_id, venue_table.code AS table_code,
          inserted.employee_id, employee.display_name AS employee_name,
          inserted.role_id, role.code AS role_code, inserted.assignment_type,
          inserted.starts_at::text, inserted.ends_at::text, inserted.reason,
          inserted.created_by_employee_id, inserted.created_at::text, inserted.updated_at::text
        FROM inserted
        JOIN mbox.tables AS venue_table ON venue_table.tenant_id = inserted.tenant_id
          AND venue_table.store_id = inserted.store_id AND venue_table.id = inserted.table_id
        JOIN mbox.employees AS employee ON employee.tenant_id = inserted.tenant_id
          AND employee.store_id = inserted.store_id AND employee.id = inserted.employee_id
        JOIN mbox.roles AS role ON role.tenant_id = inserted.tenant_id
          AND role.store_id = inserted.store_id AND role.id = inserted.role_id
      `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, input.tableId,
        input.employeeId, input.roleId, input.assignmentType, input.startsAt, input.endsAt ?? null,
        input.reason, input.createdByEmployeeId])
      return mapAssignment(requiredRow(result.rows[0], '责任分配'))
    } catch (error) {
      if (postgresCode(error) === '23P01') throw new TableManagementConflictError('该桌台责任时段与现有分配冲突')
      throw error
    }
  }

  async endAssignment(assignmentId: string, endsAt: string): Promise<TableResponsibilityAssignment> {
    const result = await this.transaction.query<AssignmentRow>(`
      WITH updated AS (
        UPDATE mbox.table_assignments
        SET ends_at = $4::timestamptz
        WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
          AND starts_at < $4::timestamptz
          AND (ends_at IS NULL OR ends_at > $4::timestamptz)
        RETURNING *
      )
      SELECT updated.id, updated.table_id, venue_table.code AS table_code,
        updated.employee_id, employee.display_name AS employee_name,
        updated.role_id, role.code AS role_code, updated.assignment_type,
        updated.starts_at::text, updated.ends_at::text, updated.reason,
        updated.created_by_employee_id, updated.created_at::text, updated.updated_at::text
      FROM updated
      JOIN mbox.tables AS venue_table ON venue_table.tenant_id = updated.tenant_id
        AND venue_table.store_id = updated.store_id AND venue_table.id = updated.table_id
      JOIN mbox.employees AS employee ON employee.tenant_id = updated.tenant_id
        AND employee.store_id = updated.store_id AND employee.id = updated.employee_id
      JOIN mbox.roles AS role ON role.tenant_id = updated.tenant_id
        AND role.store_id = updated.store_id AND role.id = updated.role_id
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, assignmentId, endsAt])
    return mapAssignment(requiredRow(result.rows[0], '有效责任分配'))
  }

  async open(input: ManagedOpenInput): Promise<ManagedTableSession> {
    validateOpen(input)
    const tableResult = await this.transaction.query<{
      id: string; code: string; capacity: number; table_status: TableStatus; area_status: AreaStatus
    }>(`
      SELECT venue_table.id, venue_table.code, venue_table.capacity,
        venue_table.status AS table_status, area.status AS area_status
      FROM mbox.tables AS venue_table
      JOIN mbox.areas AS area ON area.tenant_id = venue_table.tenant_id
        AND area.store_id = venue_table.store_id AND area.id = venue_table.area_id
      WHERE venue_table.tenant_id = $1::uuid AND venue_table.store_id = $2::uuid
        AND venue_table.id = $3::uuid
      FOR UPDATE OF venue_table
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, input.tableId])
    const table = requiredRow(tableResult.rows[0], '桌台')
    if (table.table_status !== 'available' || table.area_status !== 'active') {
      throw new TableManagementConflictError('当前桌台或所在区域已停用，不能开台')
    }
    const overCapacity = input.guestCount > table.capacity
    const overrideReason = normalizeReason(input.capacityOverrideReason ?? null)
    if (overCapacity && overrideReason === null) {
      throw new CapacityOverrideReasonRequiredError(table.capacity, input.guestCount)
    }
    if (!overCapacity && overrideReason !== null) {
      throw new TableManagementConflictError('人数未超过容量，不应填写加座原因')
    }
    const active = await this.transaction.query<{ id: string }>(`
      SELECT id FROM mbox.table_sessions
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND table_id = $3::uuid
        AND status IN ('open', 'closing')
      FOR UPDATE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, input.tableId])
    if (active.rowCount !== 0) throw new TableManagementConflictError(`桌台${table.code}已开台`)
    const profile = { ...(input.guestProfileSnapshot ?? {}), extraSeatCount: Math.max(0, input.guestCount - table.capacity) }
    const result = await this.transaction.query<SessionRow>(`
      INSERT INTO mbox.table_sessions (
        tenant_id, store_id, table_id, public_id, business_date, guest_count,
        capacity_at_open, capacity_override_reason, capacity_overridden_by_employee_id,
        guest_profile_snapshot, status, opened_by_employee_id
      ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::date, $6, $7, $8,
        $9::uuid, $10::jsonb, 'open', $11::uuid)
      RETURNING id, table_id, $12::text AS table_code, public_id, business_date::text,
        guest_count, capacity_at_open, capacity_override_reason,
        capacity_overridden_by_employee_id, guest_profile_snapshot, status,
        opened_by_employee_id, opened_at::text
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, input.tableId,
      input.publicId, input.businessDate, input.guestCount, table.capacity, overrideReason,
      overCapacity ? input.openedByEmployeeId : null, JSON.stringify(profile), input.openedByEmployeeId,
      table.code])
    return mapSession(requiredRow(result.rows[0], '桌次'))
  }

  async transfer(
    input: ManagedTransferInput,
    ownership: TableTransferOwnershipPort,
  ): Promise<TableTransferResult> {
    const sessionResult = await this.transaction.query<SessionRow>(`
      SELECT session.id, session.table_id, source.code AS table_code, session.public_id,
        session.business_date::text, session.guest_count, session.capacity_at_open,
        session.capacity_override_reason, session.capacity_overridden_by_employee_id,
        session.guest_profile_snapshot, session.status, session.opened_by_employee_id,
        session.opened_at::text
      FROM mbox.table_sessions AS session
      JOIN mbox.tables AS source ON source.tenant_id = session.tenant_id
        AND source.store_id = session.store_id AND source.id = session.table_id
      WHERE session.tenant_id = $1::uuid AND session.store_id = $2::uuid
        AND session.id = $3::uuid
      FOR UPDATE OF session
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, input.tableSessionId])
    const session = mapSession(requiredRow(sessionResult.rows[0], '桌次'))
    if (session.status !== 'open') throw new TableManagementConflictError('只有营业中的桌次可以转桌')
    if (session.tableId === input.targetTableId) throw new TableManagementConflictError('目标桌台不能与当前桌台相同')

    const tableIds = [session.tableId, input.targetTableId].toSorted()
    const tableResult = await this.transaction.query<{
      id: string; code: string; capacity: number; table_status: TableStatus; area_status: AreaStatus
    }>(`
      SELECT venue_table.id, venue_table.code, venue_table.capacity,
        venue_table.status AS table_status, area.status AS area_status
      FROM mbox.tables AS venue_table
      JOIN mbox.areas AS area ON area.tenant_id = venue_table.tenant_id
        AND area.store_id = venue_table.store_id AND area.id = venue_table.area_id
      WHERE venue_table.tenant_id = $1::uuid AND venue_table.store_id = $2::uuid
        AND venue_table.id = ANY($3::uuid[])
      ORDER BY venue_table.id
      FOR UPDATE OF venue_table
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, tableIds])
    if (tableResult.rowCount !== 2) throw new TableManagementNotFoundError('源桌台或目标桌台')
    const source = tableResult.rows.find((row) => row.id === session.tableId)!
    const target = tableResult.rows.find((row) => row.id === input.targetTableId)!
    if (target.table_status !== 'available' || target.area_status !== 'active') {
      throw new TableManagementConflictError('目标桌台或所在区域已停用')
    }
    const targetOverCapacity = session.guestCount > target.capacity
    const targetOverrideReason = normalizeReason(input.capacityOverrideReason ?? null)
    if (targetOverCapacity && targetOverrideReason === null) {
      throw new CapacityOverrideReasonRequiredError(target.capacity, session.guestCount)
    }
    if (!targetOverCapacity && targetOverrideReason !== null) {
      throw new TableManagementConflictError('目标桌台容量足够，不应填写加座原因')
    }
    const targetSession = await this.transaction.query<{ id: string }>(`
      SELECT id FROM mbox.table_sessions
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND table_id = $3::uuid
        AND status IN ('open', 'closing')
      FOR UPDATE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, input.targetTableId])
    if (targetSession.rowCount !== 0) throw new TableManagementConflictError(`目标桌台${target.code}已有营业桌次`)
    const capturedOwnership = await ownership.capture(this.transaction, session.id)
    const ownershipSnapshot: JsonObject = {
      ...capturedOwnership,
      sourceCapacitySnapshot: session.capacityAtOpen,
      targetCapacity: target.capacity,
      targetCapacityOverrideReason: targetOverrideReason,
    }
    await this.transaction.query(`
      UPDATE mbox.table_sessions
      SET table_id = $4::uuid,
          capacity_at_open = $5,
          capacity_override_reason = $6,
          capacity_overridden_by_employee_id = $7::uuid
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid AND status = 'open'
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, session.id, target.id,
      target.capacity, targetOverrideReason, targetOverCapacity ? input.transferredByEmployeeId : null])
    const result = await this.transaction.query<TransferRow>(`
      INSERT INTO mbox.table_session_transfer_events (
        tenant_id, store_id, table_session_id, source_table_id, target_table_id,
        transferred_by_employee_id, reason, ownership_snapshot
      ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7, $8::jsonb)
      RETURNING id AS event_id, table_session_id, source_table_id,
        $9::text AS source_table_code, target_table_id, $10::text AS target_table_code,
        reason, ownership_snapshot, occurred_at::text
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, session.id,
      source.id, target.id, input.transferredByEmployeeId, input.reason,
      JSON.stringify(ownershipSnapshot), source.code, target.code])
    return mapTransfer(requiredRow(result.rows[0], '转桌事件'))
  }

  private async assertArea(areaId: string): Promise<void> {
    const result = await this.transaction.query<{ id: string }>(`
      SELECT id FROM mbox.areas
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, areaId])
    if (result.rowCount !== 1) throw new TableManagementNotFoundError('区域')
  }

  private async assertAssignmentReferences(tableId: string, employeeId: string, roleId: string): Promise<void> {
    // Responsibility changes for one table serialize on that table only. This avoids
    // GiST exclusion checks deadlocking while preserving cross-table parallelism.
    const tableLock = await this.transaction.query<{ id: string }>(`
      SELECT id FROM mbox.tables
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
      FOR UPDATE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, tableId])
    if (tableLock.rowCount !== 1) throw new TableManagementNotFoundError('桌台')
    const result = await this.transaction.query<{ employee_ok: boolean; role_ok: boolean }>(`
      SELECT
        EXISTS (SELECT 1 FROM mbox.employees WHERE tenant_id = $1::uuid AND store_id = $2::uuid
          AND id = $3::uuid AND status = 'active') AS employee_ok,
        EXISTS (SELECT 1 FROM mbox.roles WHERE tenant_id = $1::uuid AND store_id = $2::uuid
          AND id = $4::uuid AND status = 'active') AS role_ok
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, employeeId, roleId])
    const row = result.rows[0]
    if (!row?.employee_ok) throw new TableManagementNotFoundError('在职员工')
    if (!row.role_ok) throw new TableManagementNotFoundError('有效岗位')
  }
}

export class TableManagementCommandService {
  constructor(
    private readonly commands: Pick<NormalizedCommandExecutor, 'execute'>,
    private readonly ownership: TableTransferOwnershipPort = new PostgresTableTransferOwnershipPort(),
  ) {}

  createArea(command: Readonly<CreateAreaCommand>) {
    return this.execute(command, 'table.area.create', TABLE_MANAGE_PERMISSION, async (repository) =>
      repository.createArea(command), 'table_area', 'table.area.created.v1')
  }

  updateArea(command: Readonly<UpdateAreaCommand>) {
    return this.execute(command, 'table.area.update', TABLE_MANAGE_PERMISSION, async (repository) =>
      repository.updateArea(command), 'table_area', 'table.area.updated.v1')
  }

  createTable(command: Readonly<CreateTableCommand>) {
    return this.execute(command, 'table.create', TABLE_MANAGE_PERMISSION, async (repository) =>
      repository.createTable(command), 'table', 'table.created.v1')
  }

  updateTable(command: Readonly<UpdateTableCommand>) {
    return this.execute(command, 'table.update', TABLE_MANAGE_PERMISSION, async (repository) =>
      repository.updateTable(command), 'table', 'table.updated.v1')
  }

  assign(command: Readonly<AssignTableCommand>) {
    return this.execute(command, 'table.assignment.create', TABLE_ASSIGNMENT_MANAGE_PERMISSION,
      async (repository) => repository.assign({ ...command, createdByEmployeeId: command.actor.employeeId }),
      'table_assignment', 'table.assignment.created.v1')
  }

  endAssignment(command: Readonly<EndAssignmentCommand>) {
    return this.execute(command, 'table.assignment.end', TABLE_ASSIGNMENT_MANAGE_PERMISSION,
      async (repository) => repository.endAssignment(command.assignmentId, command.endsAt),
      'table_assignment', 'table.assignment.ended.v1')
  }

  open(command: Readonly<OpenManagedTableCommand>) {
    return this.execute(command, 'table.open', TABLE_OPEN_PERMISSION, async (repository) => repository.open({
      ...command,
      businessDate: command.businessDate,
      openedByEmployeeId: command.actor.employeeId,
    }), 'table_session', 'table.session.opened.v1')
  }

  transfer(command: Readonly<TransferTableCommand>) {
    return this.execute(command, 'table.transfer', TABLE_TRANSFER_PERMISSION, async (repository) => repository.transfer({
      ...command,
      transferredByEmployeeId: command.actor.employeeId,
    }, this.ownership), 'table_session_transfer', 'table.session.transferred.v1')
  }

  private execute<Result extends { id?: string; eventId?: string; tableSessionId?: string }>(
    command: Readonly<TableManagementCommandBase>,
    operationScope: string,
    permission: string,
    operation: (repository: TableManagementRepository) => Promise<Result>,
    objectType: string,
    eventType: string,
  ): Promise<CommandExecution<Result>> {
    validateCommandBase(command)
    return this.commands.execute({
      scope: command.scope,
      operationScope,
      idempotencyKey: command.idempotencyKey,
      requestFingerprint: command.requestFingerprint,
      resultCodec: jsonResultCodec<Result>(),
    }, async (transaction) => {
      await new StaffAccessRepository(transaction).assertPermission(command.actor.employeeId, permission)
      const result = await operation(new TableManagementRepository(transaction))
      const objectId = result.id ?? result.eventId ?? result.tableSessionId
      if (objectId === undefined) throw new TypeError('桌台命令结果缺少对象标识')
      const payload = asJsonObject(result)
      return {
        result,
        auditEvents: [{
          actor: command.actor,
          action: eventType.replace(/\.v1$/, ''),
          objectType,
          objectId,
          businessDate: command.businessDate,
          reason: command.reason,
          afterData: payload,
        }],
        outboxMessages: [{
          aggregateType: objectType,
          aggregateId: objectId,
          aggregateVersion: 1,
          eventType,
          payload,
        }],
      }
    })
  }
}

export class PostgresTableTransferOwnershipPort implements TableTransferOwnershipPort {
  async capture(transaction: ScopedTransaction, tableSessionId: string): Promise<JsonObject> {
    const result = await transaction.query<{
      order_count: string; service_task_count: string; open_order_count: string; open_service_task_count: string
    }>(`
      SELECT
        (SELECT count(*)::text FROM mbox.orders WHERE tenant_id = $1::uuid AND store_id = $2::uuid
          AND table_session_id = $3::uuid) AS order_count,
        (SELECT count(*)::text FROM mbox.service_tasks WHERE tenant_id = $1::uuid AND store_id = $2::uuid
          AND table_session_id = $3::uuid) AS service_task_count,
        (SELECT count(*)::text FROM mbox.orders WHERE tenant_id = $1::uuid AND store_id = $2::uuid
          AND table_session_id = $3::uuid AND status NOT IN ('completed', 'cancelled')) AS open_order_count,
        (SELECT count(*)::text FROM mbox.service_tasks WHERE tenant_id = $1::uuid AND store_id = $2::uuid
          AND table_session_id = $3::uuid AND status NOT IN ('completed', 'cancelled')) AS open_service_task_count
    `, [transaction.scope.tenantId, transaction.scope.storeId, tableSessionId])
    const row = requiredRow(result.rows[0], '桌次归属快照')
    return {
      ownershipModel: 'table_session_reference',
      orderCount: Number(row.order_count),
      serviceTaskCount: Number(row.service_task_count),
      openOrderCount: Number(row.open_order_count),
      openServiceTaskCount: Number(row.open_service_task_count),
    }
  }
}

export function canViewAllTables(access: EffectiveStaffAccess): boolean {
  const managerRoles = new Set(['OWNER', 'ADMIN', 'MANAGER', 'STORE_MANAGER', 'OPERATIONS_MANAGER'])
  return access.permissions.some((permission) => [
    TABLE_VIEW_ALL_PERMISSION, TABLE_MANAGE_PERMISSION, TABLE_OPEN_PERMISSION,
  ].includes(permission)) || access.roleCodes.some((role) => managerRoles.has(role))
}

function mapArea(row: AreaRow): ManagedArea {
  return { id: row.id, code: row.code, name: row.name, areaType: row.area_type,
    sortOrder: row.sort_order, layoutSnapshot: row.layout_snapshot, status: row.status,
    createdAt: row.created_at, updatedAt: row.updated_at }
}

function mapTable(row: TableRow): ManagedTable {
  return { id: row.id, areaId: row.area_id, areaCode: row.area_code, areaName: row.area_name,
    code: row.code, displayName: row.display_name, capacity: row.capacity,
    minimumSpendMinor: row.minimum_spend_minor === null ? null : Number(row.minimum_spend_minor),
    currency: row.currency, layoutSnapshot: row.layout_snapshot, status: row.status,
    assignedToActor: row.assigned_to_actor, activeSessionId: row.active_session_id,
    activeGuestCount: row.active_guest_count, createdAt: row.created_at, updatedAt: row.updated_at }
}

function mapAssignment(row: AssignmentRow): TableResponsibilityAssignment {
  return { id: row.id, tableId: row.table_id, tableCode: row.table_code,
    employeeId: row.employee_id, employeeName: row.employee_name, roleId: row.role_id,
    roleCode: row.role_code, assignmentType: row.assignment_type, startsAt: row.starts_at,
    endsAt: row.ends_at, reason: row.reason, createdByEmployeeId: row.created_by_employee_id,
    createdAt: row.created_at, updatedAt: row.updated_at }
}

function mapSession(row: SessionRow): ManagedTableSession {
  return { id: row.id, tableId: row.table_id, tableCode: row.table_code,
    publicId: row.public_id, businessDate: row.business_date, guestCount: row.guest_count,
    capacityAtOpen: row.capacity_at_open, capacityOverrideReason: row.capacity_override_reason,
    capacityOverriddenByEmployeeId: row.capacity_overridden_by_employee_id,
    guestProfileSnapshot: row.guest_profile_snapshot, status: row.status,
    openedByEmployeeId: row.opened_by_employee_id, openedAt: row.opened_at }
}

function mapTransfer(row: TransferRow): TableTransferResult {
  return { eventId: row.event_id, tableSessionId: row.table_session_id,
    sourceTableId: row.source_table_id, sourceTableCode: row.source_table_code,
    targetTableId: row.target_table_id, targetTableCode: row.target_table_code,
    reason: row.reason, ownershipSnapshot: row.ownership_snapshot, occurredAt: row.occurred_at }
}

function validateCommandBase(command: Readonly<TableManagementCommandBase>): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(command.businessDate)) throw new TypeError('businessDate必须为YYYY-MM-DD')
  if (normalizeReason(command.reason) === null) throw new TypeError('操作原因不能为空')
  if (command.idempotencyKey.trim().length < 8) throw new TypeError('idempotencyKey至少8个字符')
  if (command.requestFingerprint.length === 0) throw new TypeError('requestFingerprint不能为空')
}

function validateArea(input: { code?: string; name: string; sortOrder: number }): void {
  if (input.code !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(input.code)) throw new TypeError('区域编码无效')
  if (input.name.trim().length === 0 || input.name.length > 120) throw new TypeError('区域名称无效')
  if (!Number.isSafeInteger(input.sortOrder) || Math.abs(input.sortOrder) > 100_000) throw new TypeError('区域排序值无效')
}

function validateTable(input: { code?: string; displayName: string; capacity: number; minimumSpendMinor?: number | null; currency?: string }): void {
  if (input.code !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(input.code)) throw new TypeError('桌台编码无效')
  if (input.displayName.trim().length === 0 || input.displayName.length > 120) throw new TypeError('桌台名称无效')
  if (!Number.isSafeInteger(input.capacity) || input.capacity < 1 || input.capacity > 200) throw new TypeError('桌台容量无效')
  if (input.minimumSpendMinor !== undefined && input.minimumSpendMinor !== null
    && (!Number.isSafeInteger(input.minimumSpendMinor) || input.minimumSpendMinor < 0)) throw new TypeError('最低消费无效')
  if (input.currency !== undefined && !/^[A-Z]{3}$/.test(input.currency)) throw new TypeError('币种无效')
}

function validateAssignment(input: { startsAt: string; endsAt?: string | null; reason: string }): void {
  const starts = Date.parse(input.startsAt)
  const ends = input.endsAt === null || input.endsAt === undefined ? null : Date.parse(input.endsAt)
  if (!Number.isFinite(starts) || (ends !== null && (!Number.isFinite(ends) || ends <= starts))) throw new TypeError('责任分配时间无效')
  if (normalizeReason(input.reason) === null) throw new TypeError('责任分配原因不能为空')
}

function validateOpen(input: { publicId: string; guestCount: number }): void {
  if (input.publicId.length < 8 || input.publicId.length > 128) throw new TypeError('publicId长度无效')
  if (!Number.isSafeInteger(input.guestCount) || input.guestCount < 1 || input.guestCount > 200) throw new TypeError('开台人数无效')
}

function normalizeReason(value: string | null): string | null {
  if (value === null) return null
  const normalized = value.trim()
  return normalized.length >= 2 && normalized.length <= 1000 ? normalized : null
}

function requiredRow<Row>(row: Row | undefined, resource: string): Row {
  if (row === undefined) throw new TableManagementNotFoundError(resource)
  return row
}

function postgresCode(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code : null
}

function asJsonObject(value: unknown): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject
}

function jsonResultCodec<Result>(): JsonCodec<Result> {
  return {
    encode: (value) => asJsonObject(value),
    decode: (value: unknown) => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('桌台命令缓存结果无效')
      return value as Result
    },
  }
}
