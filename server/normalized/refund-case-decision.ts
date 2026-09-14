import type {ScopedTransaction,StoreScope} from './transaction-runner.js'

export class RefundRequiresCaseDecisionError extends Error {
  readonly code='REFUND_REQUIRES_CASE_DECISION'
  constructor(readonly refundId:string,readonly caseId:string,readonly scope:Readonly<StoreScope>){
    super('这笔退款属于商品售后，请进入原售后单审批。')
    this.name='RefundRequiresCaseDecisionError'
  }
}

/** Call only after authorizing the refund. The case coordinator retains its own atomic decision. */
export async function assertStandaloneRefundDecision(tx:ScopedTransaction,refundId:string){
  const linked=(await tx.query<{case_id:string}>(`SELECT case_id FROM mbox.item_after_sales_case_refunds
    WHERE tenant_id=$1 AND store_id=$2 AND refund_id=$3`,[tx.scope.tenantId,tx.scope.storeId,refundId])).rows[0]
  if(linked)throw new RefundRequiresCaseDecisionError(refundId,linked.case_id,tx.scope)
}
