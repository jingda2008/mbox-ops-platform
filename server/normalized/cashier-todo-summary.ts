import { currentRefundAttemptSql } from './refund-attempt-sql.js'
import type { ScopedTransaction } from './transaction-runner.js'

export interface CashierTodoSummary {
  refunds: { total: number; action: number; waiting: number }
  activities: { pendingPayment: number; requestedRefund: number; processingRefund: number }
  asOf: string
}

/** Count current facts before pagination, retaining the cashier's table scope. */
export async function readCashierTodoSummary(
  tx: ScopedTransaction, employeeId: string, permissions: readonly string[],
): Promise<CashierTodoSummary> {
  const allTables = ['reconciliation.view', 'reconciliation.manage', 'payment.settlement.view',
    'payment.collect.all_tables', 'refund.approve', 'refund.execute', 'business_day.close']
    .some(permission => permissions.includes(permission))
  const activities = permissions.includes('community.activity.cashier')
  const refund = (await tx.query<{ total: string; actionable: string; as_of: string }>(`
    WITH visible AS (
      SELECT r.*, p.provider,
        EXISTS(SELECT 1 FROM mbox.item_after_sales_case_refunds link
          WHERE (link.tenant_id,link.store_id,link.refund_id)=(r.tenant_id,r.store_id,r.id)) AS has_case
      FROM mbox.refunds r
      JOIN mbox.payments p ON (p.tenant_id,p.store_id,p.id)=(r.tenant_id,r.store_id,r.payment_id)
      WHERE r.tenant_id=$1 AND r.store_id=$2
        AND r.status IN ('requested','approved','processing','failed')
        AND ${currentRefundAttemptSql('r')}
        AND (($5::boolean AND p.activity_registration_id IS NOT NULL) OR EXISTS(
          SELECT 1 FROM mbox.order_payment_facts fact
          JOIN mbox.orders o ON (o.tenant_id,o.store_id,o.id)=(fact.tenant_id,fact.store_id,fact.order_id)
          JOIN mbox.table_sessions session ON (session.tenant_id,session.store_id,session.id)=(o.tenant_id,o.store_id,o.table_session_id)
          WHERE (fact.tenant_id,fact.store_id,fact.id)=(p.tenant_id,p.store_id,p.id)
            AND (r.order_id IS NULL OR r.order_id=o.id) AND o.status<>'draft'
            AND ($4::boolean OR EXISTS(SELECT 1 FROM mbox.table_assignments assignment
              WHERE (assignment.tenant_id,assignment.store_id,assignment.table_id)=(session.tenant_id,session.store_id,session.table_id)
                AND assignment.employee_id=$3 AND assignment.assignment_type IN ('primary','backup')
                AND assignment.starts_at<=CURRENT_TIMESTAMP
                AND (assignment.ends_at IS NULL OR assignment.ends_at>CURRENT_TIMESTAMP)))
        ))
    )
    SELECT count(*)::text AS total,
      count(*) FILTER (WHERE NOT has_case AND (
        ($6::boolean AND status='requested' AND requested_by_employee_id IS DISTINCT FROM $3::uuid)
        OR ($7::boolean AND (status='approved' OR (status='processing'
          AND (provider IN ('cash','physical_pos','external_manual') OR provider_submission_state='not_started'))))
      ))::text AS actionable, CURRENT_TIMESTAMP::text AS as_of
    FROM visible`, [tx.scope.tenantId, tx.scope.storeId, employeeId, allTables, activities,
    permissions.includes('refund.approve'), permissions.includes('refund.execute')])).rows[0]!
  const counts = activities ? (await tx.query<{ pending: string; requested: string; processing: string }>(`
    SELECT count(*) FILTER (WHERE registration.status='payment_pending' OR registration.payment_status='pending')::text AS pending,
      count(*) FILTER (WHERE EXISTS(SELECT 1 FROM mbox.refunds r
        WHERE (r.tenant_id,r.store_id,r.payment_id)=(registration.tenant_id,registration.store_id,registration.payment_id)
          AND r.status='requested' AND ${currentRefundAttemptSql('r')}))::text AS requested,
      count(*) FILTER (WHERE EXISTS(SELECT 1 FROM mbox.refunds r
        WHERE (r.tenant_id,r.store_id,r.payment_id)=(registration.tenant_id,registration.store_id,registration.payment_id)
          AND r.status IN ('approved','processing') AND ${currentRefundAttemptSql('r')}))::text AS processing
    FROM mbox.community_activity_registrations registration
    WHERE registration.tenant_id=$1 AND registration.store_id=$2`, [tx.scope.tenantId, tx.scope.storeId])).rows[0]!
    : { pending: '0', requested: '0', processing: '0' }
  const total = Number(refund.total), action = Number(refund.actionable)
  return { refunds: { total, action, waiting: total - action },
    activities: { pendingPayment: Number(counts.pending), requestedRefund: Number(counts.requested), processingRefund: Number(counts.processing) },
    asOf: refund.as_of }
}
