import {requirePersonalTicketRefund} from './table-ticket-admission-policy.js'
import {isDeepStrictEqual} from 'node:util'
import {CustomerExperienceRequestError} from './customer-experience-repository.js'
import {StaffAccessDeniedError,StaffAccessRepository,StaffNotFoundError} from './staff-access-repository.js'
import {ticketRefundPreview} from './table-ticket-refund-preview.js'
import {ticketDiningLines} from './table-ticket-dining.js'
import {submitTicketCashRefund} from './table-ticket-refund.js'
import type {ScopedTransaction} from './transaction-runner.js'

// Capture the original requester and their cash determination before collection.
// Never infer legacy refund amounts from the gift, the food bill or the face price.
export async function planTicketCashRefund(tx:ScopedTransaction,caseId:string,employee:string,amount:number,allowRevision=false) {
  await new StaffAccessRepository(tx).assertPermission(employee,'refund.request')
  const scope=[tx.scope.tenantId,tx.scope.storeId,caseId]
  const row=(await tx.query<{planned_refund_minor:number|null;ticket_id:string;confirmed:boolean}>(`SELECT f.planned_refund_minor,f.ticket_id,
    EXISTS(SELECT 1 FROM mbox.ticket_dining_collections c WHERE(c.tenant_id,c.store_id,c.case_id)=(f.tenant_id,f.store_id,f.id)
      AND c.superseded_at IS NULL AND c.consented_at IS NOT NULL) AS confirmed
    FROM mbox.table_ticket_refund_requests f
    WHERE(f.tenant_id,f.store_id,f.id)=($1,$2,$3) AND f.status='review' AND f.close_intent IS NULL FOR UPDATE OF f`,scope)).rows[0]
  if(row)await requirePersonalTicketRefund(tx,caseId,'case')
  const preview=row && (await ticketRefundPreview(tx,row.ticket_id))[0] as {refundLimit:number}|undefined
  if(!row || !preview || !Number.isSafeInteger(amount) || amount<=0 || amount>preview.refundLimit)
    throw new CustomerExperienceRequestError('请按原票条款核定有效退款金额','TICKET_REFUND_AMOUNT',409)
  if((row.confirmed || !allowRevision) && row.planned_refund_minor!==null && row.planned_refund_minor!==amount)
    throw new CustomerExperienceRequestError('已核定的退票款发生变化，请在原案重新核对','TICKET_REFUND_CHANGED',409)
  await tx.query(`UPDATE mbox.table_ticket_refund_requests SET planned_refund_minor=$4,planned_refund_employee=$5,auto_review_error=NULL
    WHERE (tenant_id,store_id,id)=($1,$2,$3) AND (planned_refund_minor IS DISTINCT FROM $4 OR auto_review_error IS NOT NULL)`,[...scope,amount,employee])
}

export async function processTicketRefundReviews(tx:ScopedTransaction) {
  const scope=[tx.scope.tenantId,tx.scope.storeId]
  const cases=(await tx.query<{id:string;planned_refund_minor:number;planned_refund_employee:string}>(`SELECT f.id,f.planned_refund_minor,f.planned_refund_employee
    FROM mbox.table_ticket_refund_requests f WHERE f.tenant_id=$1 AND f.store_id=$2 AND f.status='review'
      AND f.close_intent IS NULL AND f.refund_id IS NULL AND f.planned_refund_minor IS NOT NULL AND f.auto_review_error IS NULL
      AND mbox.ticket_dining_cleared($1,$2,f.id)
    ORDER BY f.created_at,f.id LIMIT 20 FOR UPDATE OF f SKIP LOCKED`,scope)).rows
  let submitted=0,exceptions=0
  for(const item of cases){
    await tx.query('SAVEPOINT ticket_auto_review')
    try {
      await new StaffAccessRepository(tx).assertPermission(item.planned_refund_employee,'refund.request')
      const current=(await ticketDiningLines(tx,item.id)).filter(line=>line.usedMinor>0)
      const bills=(await tx.query<{order_id:string;line_snapshot:Record<string,unknown>[]}>(`SELECT order_id,line_snapshot FROM mbox.ticket_dining_collections
        WHERE tenant_id=$1 AND store_id=$2 AND case_id=$3 AND superseded_at IS NULL`,[...scope,item.id])).rows
      const linesChanged=bills.some(bill=>{
        const confirmed=bill.line_snapshot.map(line=>{
          const original={...line}
          delete original.customerMinor
          return original
        })
        return !isDeepStrictEqual(confirmed,current.filter(line=>line.orderId===bill.order_id))
      })
      if(!current.length || current.some(line=>line.review) || new Set(current.map(line=>line.orderId)).size!==bills.length || linesChanged)
        throw new CustomerExperienceRequestError('原菜品抵扣明细已变化，请核对原案','TICKET_DINING_CHANGED',409)
      await submitTicketCashRefund(tx,item.id,item.planned_refund_employee,item.planned_refund_minor,null,'automatic')
      submitted++
    } catch(error) {
      await tx.query('ROLLBACK TO SAVEPOINT ticket_auto_review')
      const accessError=error instanceof StaffAccessDeniedError || error instanceof StaffNotFoundError
      if(!accessError && !(error instanceof CustomerExperienceRequestError))throw error
      await tx.query('UPDATE mbox.table_ticket_refund_requests SET auto_review_error=$4 WHERE tenant_id=$1 AND store_id=$2 AND id=$3',
        [...scope,item.id,accessError?'原经办权限已变化，请有退款权限的员工核对原案':error.message])
      exceptions++
    }
    await tx.query('RELEASE SAVEPOINT ticket_auto_review')
  }
  return {submitted,exceptions}
}
