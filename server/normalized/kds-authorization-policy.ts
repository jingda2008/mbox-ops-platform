import type { JsonValue } from './command-executor.js'
import { StaffAccessRepository } from './staff-access-repository.js'
import type { ScopedTransaction } from './transaction-runner.js'

export const KDS_PREPARE_CAPABILITY = 'kds.prepare'
export const KDS_DELIVER_CAPABILITY = 'kds.deliver'
export const KDS_EXCEPTION_MANAGE_CAPABILITY = 'kds.exception.manage'
export const KDS_PRIORITY_OVERRIDE_CAPABILITY = 'kds.priority.override'

// `cancel` remains only for the repository's manager-exception transition.
// It is deliberately not exposed by the ordinary KDS HTTP action union.
export type KdsEmployeeAction = 'claim' | 'accept' | 'start' | 'complete' | 'fail' | 'cancel'
export type KdsScopedAction = KdsEmployeeAction | 'deliver' | 'manager_cancel'

export type KdsAuthorizationErrorCode =
  | 'KDS_ACTOR_INACTIVE'
  | 'KDS_PREPARE_FORBIDDEN'
  | 'KDS_DELIVER_FORBIDDEN'
  | 'KDS_EXCEPTION_FORBIDDEN'
  | 'KDS_SESSION_INVALID'
  | 'KDS_STATION_FORBIDDEN'
  | 'KDS_TABLE_FORBIDDEN'

export interface KdsAuthorizationInput {
  transaction: ScopedTransaction
  employeeId: string
  action: KdsEmployeeAction
}

export interface ScopedKdsAuthorizationInput {
  transaction: ScopedTransaction
  employeeId: string
  staffSessionId: string
  deviceAccessLeaseId: string
  action: KdsScopedAction
  stationCode: string
  tableId: string
}

export interface KdsAuthorizationPort {
  assertCanPrepare(input: Readonly<KdsAuthorizationInput>): Promise<void>
}

interface AuthorizationRow extends Record<string, unknown> {
  employee_status: string
  allowed: boolean
}

export class KdsAuthorizationError extends Error {
  constructor(
    public readonly code: KdsAuthorizationErrorCode,
    public readonly action: KdsScopedAction,
  ) {
    super(messageFor(code, action))
    this.name = 'KdsAuthorizationError'
  }
}

export class NormalizedKdsAuthorization implements KdsAuthorizationPort {
  async assertCanPrepare(input: Readonly<KdsAuthorizationInput>): Promise<void> {
    const result = await input.transaction.query<AuthorizationRow>(permissionSql(), [
      input.transaction.scope.tenantId,
      input.transaction.scope.storeId,
      input.employeeId,
      input.action === 'cancel' ? KDS_EXCEPTION_MANAGE_CAPABILITY : KDS_PREPARE_CAPABILITY,
    ])
    const row = result.rows[0]
    if (row === undefined || row.employee_status !== 'active') {
      throw new KdsAuthorizationError('KDS_ACTOR_INACTIVE', input.action)
    }
    if (!row.allowed) {
      throw new KdsAuthorizationError(
        input.action === 'cancel' ? 'KDS_EXCEPTION_FORBIDDEN' : 'KDS_PREPARE_FORBIDDEN',
        input.action,
      )
    }
  }

  async assertCanActOnTask(input: Readonly<ScopedKdsAuthorizationInput>): Promise<void> {
    const access = await new StaffAccessRepository(input.transaction).resolve(input.employeeId)
    const session = await input.transaction.query<{ id: string }>(`
      SELECT session.id
      FROM mbox.staff_sessions AS session
      JOIN mbox.store_device_access_leases AS lease
        ON lease.tenant_id = session.tenant_id
       AND lease.store_id = session.store_id
       AND lease.id = session.device_access_lease_id
      JOIN mbox.store_daily_credentials AS credential
        ON credential.tenant_id = lease.tenant_id
       AND credential.store_id = lease.store_id
       AND credential.id = lease.daily_credential_id
      WHERE session.tenant_id = $1::uuid
        AND session.store_id = $2::uuid
        AND session.id = $3::uuid
        AND session.employee_id = $4::uuid
        AND session.device_access_lease_id = $5::uuid
        AND session.revoked_at IS NULL
        AND session.expires_at > clock_timestamp()
        AND session.online_lease_until > clock_timestamp()
        AND lease.revoked_at IS NULL
        AND lease.expires_at > clock_timestamp()
        AND credential.revoked_at IS NULL
        AND credential.valid_from <= clock_timestamp()
        AND credential.valid_until > clock_timestamp()
      FOR KEY SHARE OF session, lease, credential
    `, [
      input.transaction.scope.tenantId,
      input.transaction.scope.storeId,
      input.staffSessionId,
      input.employeeId,
      input.deviceAccessLeaseId,
    ])
    if (session.rowCount !== 1) {
      throw new KdsAuthorizationError('KDS_SESSION_INVALID', input.action)
    }

    const capability = requiredCapability(input.action)
    if (!access.permissions.includes(capability)) {
      throw new KdsAuthorizationError(errorForCapability(capability), input.action)
    }

    if (isProductionAction(input.action) && !stationAllowed(access.dataScopes, input.stationCode)) {
      throw new KdsAuthorizationError('KDS_STATION_FORBIDDEN', input.action)
    }

    if (input.action === 'deliver' || input.action === 'manager_cancel') {
      const hasGlobalTableAccess = access.permissions.includes('table.view_all')
        || access.permissions.includes('fulfillment.view_all')
      if (!hasGlobalTableAccess) {
        const assignment = await input.transaction.query<{ id: string }>(`
          SELECT assignment.id
          FROM mbox.table_assignments AS assignment
          WHERE assignment.tenant_id = $1::uuid
            AND assignment.store_id = $2::uuid
            AND assignment.table_id = $3::uuid
            AND assignment.employee_id = $4::uuid
            AND assignment.assignment_type IN ('primary', 'backup')
            AND assignment.starts_at <= clock_timestamp()
            AND (assignment.ends_at IS NULL OR assignment.ends_at > clock_timestamp())
          FOR KEY SHARE OF assignment
        `, [
          input.transaction.scope.tenantId,
          input.transaction.scope.storeId,
          input.tableId,
          input.employeeId,
        ])
        if (assignment.rowCount !== 1) {
          throw new KdsAuthorizationError('KDS_TABLE_FORBIDDEN', input.action)
        }
      }
    }
  }
}

function permissionSql(): string {
  return `
    SELECT employee.status AS employee_status,
      (
        NOT EXISTS (
          SELECT 1
          FROM mbox.employee_permission_overrides denied_override
          JOIN mbox.staff_permission_definitions denied_permission
            ON denied_permission.tenant_id = denied_override.tenant_id
           AND denied_permission.store_id = denied_override.store_id
           AND denied_permission.id = denied_override.permission_id
           AND denied_permission.status = 'active'
          WHERE denied_override.tenant_id = employee.tenant_id
            AND denied_override.store_id = employee.store_id
            AND denied_override.employee_id = employee.id
            AND denied_permission.code = $4
            AND denied_override.effect = 'deny'
            AND denied_override.starts_at <= clock_timestamp()
            AND (denied_override.ends_at IS NULL OR denied_override.ends_at > clock_timestamp())
        )
        AND (
          EXISTS (
            SELECT 1
            FROM mbox.employee_permission_overrides granted_override
            JOIN mbox.staff_permission_definitions granted_permission
              ON granted_permission.tenant_id = granted_override.tenant_id
             AND granted_permission.store_id = granted_override.store_id
             AND granted_permission.id = granted_override.permission_id
             AND granted_permission.status = 'active'
            WHERE granted_override.tenant_id = employee.tenant_id
              AND granted_override.store_id = employee.store_id
              AND granted_override.employee_id = employee.id
              AND granted_permission.code = $4
              AND granted_override.effect = 'grant'
              AND granted_override.starts_at <= clock_timestamp()
              AND (granted_override.ends_at IS NULL OR granted_override.ends_at > clock_timestamp())
          )
          OR EXISTS (
            SELECT 1
            FROM mbox.employee_roles employee_role
            JOIN mbox.roles role
              ON role.tenant_id = employee_role.tenant_id
             AND role.store_id = employee_role.store_id
             AND role.id = employee_role.role_id
             AND role.status = 'active'
            WHERE employee_role.tenant_id = employee.tenant_id
              AND employee_role.store_id = employee.store_id
              AND employee_role.employee_id = employee.id
              AND employee_role.starts_at <= clock_timestamp()
              AND (employee_role.ends_at IS NULL OR employee_role.ends_at > clock_timestamp())
              AND (
                $4 = ANY(role.capabilities)
                OR EXISTS (
                  SELECT 1
                  FROM mbox.role_permission_assignments role_permission
                  JOIN mbox.staff_permission_definitions permission
                    ON permission.tenant_id = role_permission.tenant_id
                   AND permission.store_id = role_permission.store_id
                   AND permission.id = role_permission.permission_id
                   AND permission.status = 'active'
                  WHERE role_permission.tenant_id = role.tenant_id
                    AND role_permission.store_id = role.store_id
                    AND role_permission.role_id = role.id
                    AND permission.code = $4
                )
              )
          )
        )
      ) AS allowed
    FROM mbox.employees employee
    WHERE employee.tenant_id = $1::uuid
      AND employee.store_id = $2::uuid
      AND employee.id = $3::uuid
    FOR SHARE
  `
}

function requiredCapability(action: KdsScopedAction): string {
  if (action === 'deliver') return KDS_DELIVER_CAPABILITY
  if (action === 'manager_cancel' || action === 'cancel') return KDS_EXCEPTION_MANAGE_CAPABILITY
  return KDS_PREPARE_CAPABILITY
}

function errorForCapability(capability: string): KdsAuthorizationErrorCode {
  if (capability === KDS_DELIVER_CAPABILITY) return 'KDS_DELIVER_FORBIDDEN'
  if (capability === KDS_EXCEPTION_MANAGE_CAPABILITY) return 'KDS_EXCEPTION_FORBIDDEN'
  return 'KDS_PREPARE_FORBIDDEN'
}

function isProductionAction(action: KdsScopedAction): boolean {
  return action === 'claim' || action === 'accept' || action === 'start'
    || action === 'complete' || action === 'fail'
}

function stationAllowed(
  scopes: readonly Readonly<{ key: string; effect: 'include' | 'exclude'; value: JsonValue }>[],
  stationCode: string,
): boolean {
  const stationScopes = scopes.filter((scope) => scope.key === 'kds.station_codes')
  if (stationScopes.length === 0) return false
  const included = new Set<string>()
  const excluded = new Set<string>()
  for (const scope of stationScopes) {
    for (const station of scopeValues(scope.value)) {
      if (scope.effect === 'exclude') excluded.add(station)
      else included.add(station)
    }
  }
  return included.has(stationCode) && !excluded.has(stationCode)
}

function scopeValues(value: JsonValue): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string')
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const values = value.values ?? value.stationCodes
    return Array.isArray(values) ? values.filter((item): item is string => typeof item === 'string') : []
  }
  return []
}

function messageFor(code: KdsAuthorizationErrorCode, action: KdsScopedAction): string {
  switch (code) {
    case 'KDS_ACTOR_INACTIVE': return 'KDS actor is not an active employee'
    case 'KDS_SESSION_INVALID': return 'KDS action requires the employee current active device session'
    case 'KDS_STATION_FORBIDDEN': return 'KDS actor is outside the assigned station data scope'
    case 'KDS_TABLE_FORBIDDEN': return 'KDS actor is not the primary or backup employee for this table'
    case 'KDS_DELIVER_FORBIDDEN': return `KDS actor lacks ${KDS_DELIVER_CAPABILITY} for action ${action}`
    case 'KDS_EXCEPTION_FORBIDDEN': return `KDS actor lacks ${KDS_EXCEPTION_MANAGE_CAPABILITY} for action ${action}`
    case 'KDS_PREPARE_FORBIDDEN': return `KDS actor lacks ${KDS_PREPARE_CAPABILITY} for action ${action}`
  }
}
