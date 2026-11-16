import type { ScopedTransaction } from './transaction-runner.js'

/** Internal SQL expressions only; $1/$2 always identify the current tenant/store. */
export function refundApprovalLimitsSql(employee: string): string {
  return `SELECT al.currency, MAX(al.amount_minor)::text AS amount_minor
    FROM mbox.role_approval_limits al
    JOIN mbox.employee_roles er ON (er.tenant_id,er.store_id,er.role_id)=(al.tenant_id,al.store_id,al.role_id)
    JOIN mbox.roles role ON (role.tenant_id,role.store_id,role.id)=(er.tenant_id,er.store_id,er.role_id)
    WHERE al.tenant_id=$1::uuid AND al.store_id=$2::uuid AND er.employee_id=${employee}
      AND al.approval_code='refund.approve' AND al.enabled=true AND role.status='active'
      AND er.starts_at<=clock_timestamp() AND (er.ends_at IS NULL OR er.ends_at>clock_timestamp())
    GROUP BY al.currency`
}

export async function readRefundApprovalLimits(tx: ScopedTransaction, employeeId: string): Promise<Record<string, number>> {
  const {rows}=await tx.query<{currency:string;amount_minor:string|null}>(refundApprovalLimitsSql('$3::uuid'),[tx.scope.tenantId,tx.scope.storeId,employeeId])
  return Object.fromEntries(rows.flatMap(row=>{
    const amount=row.amount_minor===null?NaN:Number(row.amount_minor)
    return Number.isSafeInteger(amount)&&amount>=0?[[row.currency,amount]]:[]
  }))
}
