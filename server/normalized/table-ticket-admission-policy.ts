import {CustomerExperienceRequestError} from './customer-experience-repository.js'
import type {ScopedTransaction} from './transaction-runner.js'

// Use the terms accepted on this purchase and the admissions of this single ticket.
export const personalRefundClosedSql = `(
  coalesce(r.refund_policy_snapshot->>'personalRefundUntil','')='first_admission'
  AND EXISTS (SELECT 1 FROM mbox.ticket_admission_batches admitted
    WHERE (admitted.tenant_id,admitted.store_id,admitted.ticket_id)=(k.tenant_id,k.store_id,k.id))
)`

export async function requirePersonalTicketRefund(tx:ScopedTransaction,id:string,lookup:'ticket'|'case'){
  const viaCase=lookup==='case'?'JOIN mbox.table_ticket_refund_requests f ON (f.tenant_id,f.store_id,f.ticket_id)=(k.tenant_id,k.store_id,k.id)':''
  const blocked=await tx.query(`SELECT 1 FROM mbox.table_tickets k
    JOIN mbox.community_activity_registrations r ON (r.tenant_id,r.store_id,r.id)=(k.tenant_id,k.store_id,k.registration_id)
    ${viaCase} WHERE k.tenant_id=$1 AND k.store_id=$2 AND ${lookup==='case'?'f.id':'k.id'}=$3
    AND ${personalRefundClosedSql}`,[tx.scope.tenantId,tx.scope.storeId,id])
  if(blocked.rowCount)throw new CustomerExperienceRequestError('本票已验票入场，无法办理个人原因退票。','TICKET_ALREADY_ADMITTED',409)
}
