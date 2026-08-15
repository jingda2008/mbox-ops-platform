import { createHash } from 'node:crypto'
import type { JsonObject, JsonValue } from './command-executor.js'
import type { ScopedTransaction } from './transaction-runner.js'

export type PaymentCapability =
  | 'payment.initiate.staff'
  | 'payment.manual.cash.record'
  | 'payment.manual.pos.record'
  | 'refund.request'
  | 'refund.approve'
  | 'refund.execute'

export interface EmployeeCapabilityAuthorization {
  transaction: ScopedTransaction
  employeeId: string
  capability: Exclude<PaymentCapability, 'refund.approve'>
}

export interface RefundApprovalAuthorization {
  transaction: ScopedTransaction
  employeeId: string
  refundId: string
}

export interface PaymentCapabilityAuthorizationPort {
  assertEmployeeCapability(input: Readonly<EmployeeCapabilityAuthorization>): Promise<void>
  assertRefundApproval(input: Readonly<RefundApprovalAuthorization>): Promise<void>
}

interface CapabilityRow extends Record<string, unknown> {
  employee_status: string
  allowed: boolean
}

interface RefundApprovalRow extends Record<string, unknown> {
  employee_status: string
  allowed: boolean
  requested_by_employee_id: string
  amount_minor: string | number
  currency: string
  approval_limit_minor: string | number | null
}

export class PaymentAuthorizationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PaymentAuthorizationError'
  }
}

export class NormalizedPaymentCapabilityAuthorization
implements PaymentCapabilityAuthorizationPort {
  async assertEmployeeCapability(
    input: Readonly<EmployeeCapabilityAuthorization>,
  ): Promise<void> {
    const result = await input.transaction.query<CapabilityRow>(`
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
                AND EXISTS (
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
        ) AS allowed
      FROM mbox.employees employee
      WHERE employee.tenant_id = $1::uuid
        AND employee.store_id = $2::uuid
        AND employee.id = $3::uuid
      FOR SHARE
    `, [
      input.transaction.scope.tenantId,
      input.transaction.scope.storeId,
      input.employeeId,
      input.capability,
    ])
    const row = result.rows[0]
    if (row === undefined || row.employee_status !== 'active') {
      throw new PaymentAuthorizationError('Employee is not active for this financial action')
    }
    if (!row.allowed) {
      throw new PaymentAuthorizationError(`Employee lacks financial capability: ${input.capability}`)
    }
  }

  async assertRefundApproval(input: Readonly<RefundApprovalAuthorization>): Promise<void> {
    const result = await input.transaction.query<RefundApprovalRow>(`
      SELECT employee.status AS employee_status,
        refund.requested_by_employee_id,
        refund.amount_minor,
        refund.currency,
        approval_context.allowed,
        approval_context.approval_limit_minor
      FROM mbox.refunds refund
      JOIN mbox.employees employee
        ON employee.tenant_id = refund.tenant_id
       AND employee.store_id = refund.store_id
       AND employee.id = $4::uuid
      CROSS JOIN LATERAL (
        SELECT
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
                AND denied_permission.code = 'refund.approve'
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
                  AND granted_permission.code = 'refund.approve'
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
                  AND EXISTS (
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
                        AND permission.code = 'refund.approve'
                  )
              )
            )
          ) AS allowed,
          (
            SELECT MAX(approval_limit.amount_minor)
            FROM mbox.employee_roles limit_employee_role
            JOIN mbox.roles limit_role
              ON limit_role.tenant_id = limit_employee_role.tenant_id
             AND limit_role.store_id = limit_employee_role.store_id
             AND limit_role.id = limit_employee_role.role_id
             AND limit_role.status = 'active'
            JOIN mbox.role_approval_limits approval_limit
              ON approval_limit.tenant_id = limit_role.tenant_id
             AND approval_limit.store_id = limit_role.store_id
             AND approval_limit.role_id = limit_role.id
             AND approval_limit.approval_code = 'refund.approve'
             AND approval_limit.currency = refund.currency
             AND approval_limit.enabled = true
            WHERE limit_employee_role.tenant_id = employee.tenant_id
              AND limit_employee_role.store_id = employee.store_id
              AND limit_employee_role.employee_id = employee.id
              AND limit_employee_role.starts_at <= clock_timestamp()
              AND (limit_employee_role.ends_at IS NULL OR limit_employee_role.ends_at > clock_timestamp())
          ) AS approval_limit_minor
      ) approval_context
      WHERE refund.tenant_id = $1::uuid
        AND refund.store_id = $2::uuid
        AND refund.id = $3::uuid
      FOR UPDATE OF refund
    `, [
      input.transaction.scope.tenantId,
      input.transaction.scope.storeId,
      input.refundId,
      input.employeeId,
    ])
    const row = result.rows[0]
    if (row === undefined || row.employee_status !== 'active') {
      throw new PaymentAuthorizationError('Employee is not active or refund is unavailable')
    }
    if (!row.allowed) {
      throw new PaymentAuthorizationError('Employee lacks financial capability: refund.approve')
    }
    if (row.requested_by_employee_id === input.employeeId) {
      throw new PaymentAuthorizationError('Refund requester cannot approve or reject the same refund')
    }
    const limit = row.approval_limit_minor === null ? null : toSafeMinor(row.approval_limit_minor)
    if (limit === null) {
      throw new PaymentAuthorizationError(`Refund approval limit is not configured for ${row.currency}`)
    }
    if (toSafeMinor(row.amount_minor) > limit) {
      throw new PaymentAuthorizationError(`Refund amount exceeds employee approval limit for ${row.currency}`)
    }
  }
}

const PROVIDER_EVIDENCE_FIELDS = new Set([
  'bankType',
  'channel',
  'collectedByEmployeeId',
  'errorCode',
  'eventId',
  'merchantOrderId',
  'merchantRefundId',
  'occurredAt',
  'providerOrderId',
  'providerReportedAmountMinor',
  'providerStatus',
  'receiptReference',
  'receivedAt',
  'refundState',
  'resultCode',
  'settledAt',
  'signatureVerified',
  'terminalId',
  'tradeState',
  'transactionState',
  'verificationAlgorithm',
])

const CLIENT_PAYMENT_HINT_FIELDS = new Set([
  'channel',
])

const CLIENT_REFUND_EVIDENCE_FIELDS = new Set([
  'reasonCode',
])

export function sanitizeProviderSnapshot(snapshot: JsonObject | undefined): JsonObject {
  if (snapshot === undefined) return {}
  const sanitized: Record<string, JsonValue> = {}
  for (const [key, value] of Object.entries(snapshot)) {
    if (!PROVIDER_EVIDENCE_FIELDS.has(key) || !isSafeEvidenceValue(value)) continue
    sanitized[key] = value
  }
  return sanitized
}

export function sanitizeClientPaymentHints(snapshot: JsonObject | undefined): JsonObject {
  if (snapshot === undefined) return {}
  const sanitized: Record<string, JsonValue> = {}
  for (const [key, value] of Object.entries(snapshot)) {
    if (!CLIENT_PAYMENT_HINT_FIELDS.has(key) || !isSafeEvidenceValue(value)) continue
    sanitized[key] = value
  }
  return sanitized
}

export function sanitizeClientRefundEvidence(snapshot: JsonObject | undefined): JsonObject {
  if (snapshot === undefined) return {}
  const sanitized: Record<string, JsonValue> = {}
  for (const [key, value] of Object.entries(snapshot)) {
    if (!CLIENT_REFUND_EVIDENCE_FIELDS.has(key) || !isSafeEvidenceValue(value)) continue
    sanitized[key] = value
  }
  return sanitized
}

export function paymentBusinessEventKey(
  eventType: string,
  provider: string,
  providerReference: string,
): string {
  const digest = createHash('sha256')
    .update(`${eventType}:${provider}:${providerReference}`, 'utf8')
    .digest('hex')
  return `payment:${eventType}:${digest}`
}

function isSafeEvidenceValue(value: JsonValue): boolean {
  return value === null || ['boolean', 'number', 'string'].includes(typeof value)
}

function toSafeMinor(value: string | number): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new PaymentAuthorizationError('Financial authorization amount is invalid')
  }
  return parsed
}
