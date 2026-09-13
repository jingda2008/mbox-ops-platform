import type {ScopedTransaction} from './transaction-runner.js'
import {appendAuditEvent} from './command-executor.js'
import {ItemQuantityConflict} from './order-item-quantity-plan.js'

/** Money and physical disposition are independent facts. Only their conjunction
 * closes a case; a failed refund never releases a hold or undoes a stock return. */
export class ItemAfterSalesProgressRepository {
  constructor(private readonly tx:ScopedTransaction){}
  private get scope(){return [this.tx.scope.tenantId,this.tx.scope.storeId]}

  async read(caseId:string){
    const row=(await this.readMany([caseId]))[0]
    if(!row)throw new ItemQuantityConflict('QUANTITY_FACTS_CONFLICT','原商品售后不存在')
    return row
  }

  /** Bounded bulk read for handover; one SQL snapshot instead of per-case queries. */
  async readMany(caseIds:readonly string[]){
    if(caseIds.length>100)throw new ItemQuantityConflict('QUANTITY_INVALID','每页最多读取100项售后')
    if(!caseIds.length)return []
    const rows=(await this.tx.query<ProgressRow>(`SELECT target.id,target.order_id,COALESCE(target.resolved_kind,target.kind) AS kind,target.status,target.amount_minor::text,target.business_date::text,target.closed_by_order_event_id,
      EXISTS(SELECT 1 FROM mbox.item_receivable_adjustment_facts WHERE tenant_id=target.tenant_id AND store_id=target.store_id AND case_id=target.id) AS adjusted,
      (SELECT previous_case_id FROM mbox.item_after_sales_case_revisions WHERE tenant_id=target.tenant_id AND store_id=target.store_id AND replacement_case_id=target.id) AS revises_case_id,
      (SELECT replacement_case_id FROM mbox.item_after_sales_case_revisions WHERE tenant_id=target.tenant_id AND store_id=target.store_id AND previous_case_id=target.id) AS revised_by_case_id,
      (SELECT jsonb_build_object('orderId',replacement.id,'publicId',replacement.public_id,'status',replacement.status,'sourceCaseId',link.case_id)
        FROM mbox.item_after_sales_replacement_orders link JOIN mbox.orders replacement ON replacement.tenant_id=link.tenant_id AND replacement.store_id=link.store_id AND replacement.id=link.order_id
        WHERE link.tenant_id=target.tenant_id AND link.store_id=target.store_id AND link.root_case_id=mbox.item_after_sales_root_case_id(target.tenant_id,target.store_id,target.id)
          AND NOT EXISTS(SELECT 1 FROM mbox.item_after_sales_replacement_orders successor WHERE successor.tenant_id=link.tenant_id AND successor.store_id=link.store_id AND successor.previous_order_id=link.order_id)) AS replacement_order,
      quantities.selected,quantities.held,quantities.stopped,quantities.made,quantities.inventory_review,
      (SELECT count(*)::int FROM mbox.item_after_sales_notices notice WHERE notice.tenant_id=target.tenant_id AND notice.store_id=target.store_id AND notice.case_id=target.id AND notice.acknowledged_at IS NULL) AS unconfirmed_notices,
      COALESCE(refunds.facts,'[]'::jsonb) AS refunds
      FROM mbox.item_after_sales_cases target
      CROSS JOIN LATERAL(SELECT count(*)::int AS selected,count(*) FILTER(WHERE unit.held_by_case_id=target.id)::int AS held,
        count(*) FILTER(WHERE unit.stopped_by_case_id=target.id)::int AS stopped,count(*) FILTER(WHERE unit.production_state<>'unmade')::int AS made,
        count(*) FILTER(WHERE unit.inventory_evidence_state='unresolved')::int AS inventory_review
        FROM mbox.item_after_sales_case_units selected JOIN mbox.order_item_quantity_units unit ON unit.tenant_id=selected.tenant_id AND unit.store_id=selected.store_id AND unit.id=selected.unit_id
        WHERE selected.tenant_id=target.tenant_id AND selected.store_id=target.store_id AND selected.case_id=target.id) quantities
      CROSS JOIN LATERAL(SELECT jsonb_agg(jsonb_build_object('id',refund.id,'status',refund.status,'amount_minor',refund.amount_minor::text,
        'provider',payment.provider,'provider_submission_state',refund.provider_submission_state,
        'replaced_by',(SELECT replacement_refund_id FROM mbox.item_after_sales_refund_retries retry WHERE retry.tenant_id=refund.tenant_id AND retry.store_id=refund.store_id AND retry.previous_refund_id=refund.id),
        'retry_eligible',mbox.quantity_refund_retry_eligible(refund.tenant_id,refund.store_id,refund.id)) ORDER BY refund.id) AS facts
        FROM mbox.item_after_sales_case_refunds link JOIN mbox.refunds refund ON refund.tenant_id=link.tenant_id AND refund.store_id=link.store_id AND refund.id=link.refund_id
        JOIN mbox.payments payment ON payment.tenant_id=refund.tenant_id AND payment.store_id=refund.store_id AND payment.id=refund.payment_id
        WHERE link.tenant_id=target.tenant_id AND link.store_id=target.store_id AND link.case_id=target.id) refunds
      WHERE target.tenant_id=$1 AND target.store_id=$2 AND target.id=ANY($3::uuid[]) ORDER BY array_position($3::uuid[],target.id)`,[...this.scope,caseIds])).rows
    return rows.map(target=>{
      const refunds=target.refunds.filter(refund=>!refund.replaced_by),amountMinor=target.amount_minor===null?null:Number(target.amount_minor)
      const succeededMinor=refunds.filter(refund=>refund.status==='succeeded').reduce((sum,refund)=>sum+Number(refund.amount_minor),0)
      const moneyComplete=target.closed_by_order_event_id!==null|| (target.kind==='unpaid_stop'?target.adjusted:amountMinor===0||amountMinor!==null&&refunds.length>0&&refunds.every(refund=>refund.status==='succeeded')&&succeededMinor===amountMinor)
      return {caseId:target.id,orderId:target.order_id,kind:target.kind,status:target.status,businessDate:target.business_date,amountMinor,closedByOrderCancellationId:target.closed_by_order_event_id,unconfirmedNoticeCount:target.unconfirmed_notices,
        selectedQuantity:target.selected,heldQuantity:target.held,stoppedQuantity:target.stopped,madeQuantity:target.made,inventoryReviewQuantity:target.inventory_review,revisesCaseId:target.revises_case_id,revisedByCaseId:target.revised_by_case_id,
        replacementOrder:target.replacement_order??null,
        physicalComplete:target.selected>0&&target.stopped===target.selected,moneyComplete,succeededMinor,
        refundFailed:refunds.some(refund=>refund.status==='failed'),refundNeedsReview:refunds.some(refund=>refund.provider_submission_state==='manual_review'),
        awaitingCashPayout:refunds.some(refund=>refund.provider==='cash'&&['approved','processing'].includes(refund.status)),
        refunds:target.refunds.map(refund=>({id:refund.id,status:refund.status,amountMinor:Number(refund.amount_minor),provider:refund.provider,replacedByRefundId:refund.replaced_by,canRetry:target.status==='approved'&&refund.retry_eligible}))}
    })
  }

  async synchronize(caseId:string){
    // Provider completion already owns the order lock. No table/session write or
    // session lock is needed to reconcile immutable original-case facts.
    await this.tx.query(`SELECT original.id FROM mbox.orders original JOIN mbox.item_after_sales_cases target ON target.tenant_id=original.tenant_id AND target.store_id=original.store_id AND target.order_id=original.id WHERE target.tenant_id=$1 AND target.store_id=$2 AND target.id=$3 FOR UPDATE OF original`,[...this.scope,caseId])
    await this.tx.query(`SELECT id FROM mbox.item_after_sales_cases WHERE tenant_id=$1 AND store_id=$2 AND id=$3 FOR UPDATE`,[...this.scope,caseId])
    const current=await this.read(caseId)
    if(current.status==='completed'||!current.physicalComplete||!current.moneyComplete||!(current.status==='approved'||current.kind==='unpaid_stop'&&current.status==='requested'))return current
    await this.tx.query(`UPDATE mbox.item_after_sales_cases SET status='completed',completed_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,[...this.scope,caseId])
    const actionDate=(await this.tx.query<{date:string}>('SELECT mbox.current_operating_business_date($1,$2)::text AS date',this.scope)).rows[0]!.date
    await appendAuditEvent(this.tx,{actor:{type:'system',ref:'quantity-case-completion'},action:'item_after_sales.completed',objectType:'item_after_sales_case',objectId:caseId,businessDate:actionDate,reason:'所选商品实物与资金处理均已核实完成',
      metadata:{sourceCaseBusinessDate:current.businessDate,orderId:current.orderId,quantity:current.selectedQuantity,amountMinor:current.amountMinor,physicalComplete:true,moneyComplete:true}})
    return {...current,status:'completed'}
  }

  async synchronizeRefund(orderId:string,refundId:string){
    const link=(await this.tx.query<{case_id:string}>(`SELECT link.case_id FROM mbox.item_after_sales_case_refunds link JOIN mbox.item_after_sales_cases target
      ON target.tenant_id=link.tenant_id AND target.store_id=link.store_id AND target.id=link.case_id
      WHERE link.tenant_id=$1 AND link.store_id=$2 AND link.refund_id=$3 AND target.order_id=$4`,[...this.scope,refundId,orderId])).rows[0]
    return link?this.synchronize(link.case_id):null
  }
}

interface ProgressRow extends Record<string,unknown>{
  id:string;order_id:string;kind:string;status:string;amount_minor:string|null;business_date:string;adjusted:boolean;closed_by_order_event_id:string|null
  revises_case_id:string|null;revised_by_case_id:string|null
  replacement_order?:{orderId:string;publicId:string;status:string;sourceCaseId:string}|null
  selected:number;held:number;stopped:number;made:number;inventory_review:number
  unconfirmed_notices:number
  refunds:Array<{id:string;status:string;amount_minor:string;provider:string;provider_submission_state:string;replaced_by:string|null;retry_eligible:boolean}>
}
