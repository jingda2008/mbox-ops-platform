import type {ScopedTransaction} from './transaction-runner.js'
import {lockQuantityOrder} from './item-quantity-lock.js'
import {ItemQuantityConflict} from './order-item-quantity-plan.js'
import {RefundRepository} from './refund-repository.js'

/** An execution retry, never a new business approval or a second stock return.
 * Unknown provider results must recover their original attempt instead. */
export class ItemQuantityRefundRetryRepository {
  constructor(private readonly tx:ScopedTransaction){}
  async retry(input:{caseId:string;refundId:string;employeeId:string}){
    await lockQuantityOrder(this.tx,{kind:'case',id:input.caseId},true)
    const scope=[this.tx.scope.tenantId,this.tx.scope.storeId]
    const original=(await this.tx.query<{status:string;payment_id:string;reason:string;requester:string;reviewer:string|null;decision_reason:string|null;eligible:boolean}>(`SELECT target.status,refund.payment_id,target.reason,
      target.requested_by_employee_id AS requester,target.decided_by_employee_id AS reviewer,target.decision_reason,
      mbox.quantity_refund_retry_eligible(refund.tenant_id,refund.store_id,refund.id) AS eligible
      FROM mbox.item_after_sales_cases target JOIN mbox.item_after_sales_case_refunds link ON link.tenant_id=target.tenant_id AND link.store_id=target.store_id AND link.case_id=target.id
      JOIN mbox.refunds refund ON refund.tenant_id=link.tenant_id AND refund.store_id=link.store_id AND refund.id=link.refund_id
      WHERE target.tenant_id=$1 AND target.store_id=$2 AND target.id=$3 AND refund.id=$4 FOR UPDATE OF target,refund`,[...scope,input.caseId,input.refundId])).rows[0]
    if(!original)throw new ItemQuantityConflict('QUANTITY_FACTS_CONFLICT','所选退款不属于原商品申请')
    const existing=(await this.tx.query<{id:string}>(`SELECT replacement_refund_id AS id FROM mbox.item_after_sales_refund_retries WHERE tenant_id=$1 AND store_id=$2 AND case_id=$3 AND previous_refund_id=$4`,[...scope,input.caseId,input.refundId])).rows[0]
    // Also absorbs a second employee or a new command key after lost feedback.
    if(existing)return {refundId:existing.id,replayed:true}
    if(original.status!=='approved'||!original.reviewer||!original.eligible)throw new ItemQuantityConflict('QUANTITY_UNAVAILABLE','原退款尚未确认失败或存在待核对结果，请先核对原退款，不创建另一笔')
    const allocations=(await this.tx.query<{order_item_id:string;amount_minor:string}>(`SELECT order_item_id,amount_minor::text FROM mbox.refund_items WHERE tenant_id=$1 AND store_id=$2 AND refund_id=$3 ORDER BY order_item_id`,[...scope,input.refundId])).rows
    const repository=new RefundRepository(this.tx)
    const replacement=await repository.request({quantityRetryOf:input.refundId,paymentId:original.payment_id,publicId:`QR-RETRY-${input.refundId.replaceAll('-','')}`,reason:original.reason,
      requestedByEmployeeId:original.requester,purpose:'return_goods',allocations:allocations.map(row=>({orderItemId:row.order_item_id,amountMinor:Number(row.amount_minor)})),
      requestEvidence:{quantityCaseId:input.caseId,previousRefundId:input.refundId,source:'confirmed_failure_same_approval'}})
    await this.tx.query(`INSERT INTO mbox.item_after_sales_refund_retries(tenant_id,store_id,case_id,previous_refund_id,replacement_refund_id,employee_id) VALUES($1,$2,$3,$4,$5,$6)`,[...scope,input.caseId,input.refundId,replacement.id,input.employeeId])
    await this.tx.query(`INSERT INTO mbox.item_after_sales_case_refunds(tenant_id,store_id,case_id,refund_id) VALUES($1,$2,$3,$4)`,[...scope,input.caseId,replacement.id])
    // Inherits the immutable original decision; no new limit or role grant.
    const approved=await repository.approve(replacement.id,original.reviewer,original.decision_reason??'沿用原商品审核结果')
    if(approved.paymentProvider==='postar'){
      await repository.beginExecution(replacement.id)
      await this.tx.query(`UPDATE mbox.refunds SET auto_execute_requested_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,[...scope,replacement.id])
    }
    return {refundId:replacement.id,replayed:false}
  }
}
