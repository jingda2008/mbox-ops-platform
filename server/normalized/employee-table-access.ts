import type { ScopedTransaction } from './transaction-runner.js'
import { StaffAccessDeniedError } from './staff-access-repository.js'

interface EmployeeTableAccessRow extends Record<string, unknown> {
  employee_status: string
  session_status: string
  allowed: boolean
  permissions_allowed: boolean
}

export interface EmployeeTableSessionAccessInput {
  employeeId: string
  tableSessionId: string
  allTablePermissionCodes?: readonly string[]
  includeTableViewAll?: boolean
  requiredPermissionCodes?: readonly string[]
  lockTableSession?: boolean
}

export class EmployeeTableAccessDeniedError extends Error {
  constructor(message = '当前员工不是该桌负责人，无权操作此桌') {
    super(message)
    this.name = 'EmployeeTableAccessDeniedError'
  }
}

export async function assertEmployeeEffectivePermission(
  transaction: ScopedTransaction,
  employeeId: string,
  permissionCode: string,
): Promise<void> {
  const result = await transaction.query<{ allowed: boolean }>(`
    SELECT employee.status='active'
      AND mbox.employee_has_effective_permission(
        employee.tenant_id,employee.store_id,employee.id,$4
      ) AS allowed
    FROM mbox.employees employee
    WHERE employee.tenant_id=$1::uuid AND employee.store_id=$2::uuid AND employee.id=$3::uuid
    FOR SHARE OF employee
  `, [transaction.scope.tenantId,transaction.scope.storeId,employeeId,permissionCode])
  if (result.rows[0]?.allowed !== true) {
    throw new StaffAccessDeniedError(`Employee ${employeeId} does not have permission ${permissionCode}`)
  }
}

/**
 * Server-side table data-scope guard. Operation capabilities answer what an
 * employee may do; this guard independently answers which current table they
 * may do it to. Never rely on a filtered UI list for command authorization.
 */
export async function assertEmployeeTableSessionAccess(
  transaction: ScopedTransaction,
  input: Readonly<EmployeeTableSessionAccessInput>,
): Promise<void> {
  await assertEmployeeTableSessionAccessWithLock(transaction, input,
    input.lockTableSession === true
      ? 'FOR SHARE OF employee FOR UPDATE OF session'
      : 'FOR SHARE OF employee,session')
}

/**
 * Table-scope check for a view endpoint that deliberately runs in a PostgreSQL
 * READ ONLY transaction.  Command handlers must keep using
 * assertEmployeeTableSessionAccess so their employee/session locks remain in
 * place across the mutation.
 */
export async function assertEmployeeTableSessionReadAccess(
  transaction: ScopedTransaction,
  input: Readonly<Omit<EmployeeTableSessionAccessInput, 'lockTableSession'>>,
): Promise<void> {
  await assertEmployeeTableSessionAccessWithLock(transaction, input, '')
}

async function assertEmployeeTableSessionAccessWithLock(
  transaction: ScopedTransaction,
  input: Readonly<Omit<EmployeeTableSessionAccessInput, 'lockTableSession'>>,
  lockClause: string,
): Promise<void> {
  const allTablePermissionCodes = Array.from(new Set([
    ...(input.includeTableViewAll === false ? [] : ['table.view_all']),
    ...(input.allTablePermissionCodes ?? []),
  ]))
  const requiredPermissionCodes = Array.from(new Set(input.requiredPermissionCodes ?? []))
  const result = await transaction.query<EmployeeTableAccessRow>(`
    SELECT employee.status AS employee_status,session.status AS session_status,
      (
        EXISTS (
          SELECT 1
          FROM unnest($5::text[]) AS scope_permission(code)
          WHERE mbox.employee_has_effective_permission(
            employee.tenant_id,employee.store_id,employee.id,scope_permission.code
          )
        )
        OR EXISTS (
          SELECT 1 FROM mbox.table_assignments assignment
          WHERE assignment.tenant_id=session.tenant_id
            AND assignment.store_id=session.store_id
            AND assignment.table_id=session.table_id
            AND assignment.employee_id=employee.id
            AND assignment.assignment_type IN ('primary','backup')
            AND assignment.starts_at<=clock_timestamp()
            AND (assignment.ends_at IS NULL OR assignment.ends_at>clock_timestamp())
        )
      ) AS allowed,
      NOT EXISTS (
        SELECT 1
        FROM unnest($6::text[]) AS required_permission(code)
        WHERE NOT mbox.employee_has_effective_permission(
          employee.tenant_id,employee.store_id,employee.id,required_permission.code
        )
      ) AS permissions_allowed
    FROM mbox.employees employee
    JOIN mbox.table_sessions session
      ON session.tenant_id=employee.tenant_id AND session.store_id=employee.store_id
     AND session.id=$4::uuid
    WHERE employee.tenant_id=$1::uuid AND employee.store_id=$2::uuid
      AND employee.id=$3::uuid
    ${lockClause}
  `, [
    transaction.scope.tenantId,
    transaction.scope.storeId,
    input.employeeId,
    input.tableSessionId,
    allTablePermissionCodes,
    requiredPermissionCodes,
  ])
  const row = result.rows[0]
  if (row === undefined
    || row.employee_status !== 'active'
    || !['open', 'closing'].includes(row.session_status)
    || row.allowed !== true
    || (requiredPermissionCodes.length > 0 && row.permissions_allowed !== true)) {
    throw new EmployeeTableAccessDeniedError()
  }
}
