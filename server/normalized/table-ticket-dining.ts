import {requirePersonalTicketRefund} from './table-ticket-admission-policy.js'
import {CustomerExperienceRequestError} from './customer-experience-repository.js'
import {ActivityOperationsError} from './activity-operations-repository.js'
import {readRefundApprovalLimits} from './refund-approval-limits.js'
import type {ScopedTransaction} from './transaction-runner.js'
import {PaymentRepository} from './payment-repository.js'
import {allocateMinorAmount} from './stacking-pricing.js'

export interface DiningSplit { customerMinor:number; merchantMinor:number }

const unavailable=(message:string)=>new ActivityOperationsError(message,'TICKET_DINING_REVIEW',409)

export async function ticketDiningLines(tx:ScopedTransaction,id:string,lookup:'case'|'ticket'='case') {
  const ticketMatch=lookup==='ticket'?'k.id=$3':`k.id=(SELECT f.ticket_id FROM mbox.table_ticket_refund_requests f
    WHERE f.tenant_id=$1 AND f.store_id=$2 AND f.id=$3)`
  return (await tx.query<{orderId:string;orderNo:string;portionId:string;productId:string;name:string;eligible:boolean;priceMinor:number;usedMinor:number;review:boolean}>(`
    SELECT link.order_id AS "orderId",o.public_id AS "orderNo",s.portion_id AS "portionId",q.product_id AS "productId",coalesce(original.product_snapshot->>'name',pr.name) AS name,
      (SELECT bool_and(i.loyalty_eligible_at_submission) FROM mbox.order_items i WHERE (i.tenant_id,i.store_id,i.order_id,i.product_id)=(o.tenant_id,o.store_id,o.id,q.product_id) AND i.parent_order_item_id IS NULL) AS eligible,
      coalesce((SELECT i.total_amount_minor FROM mbox.order_items i WHERE i.id=q.tab_item_id),q.standard_minor)::int AS "priceMinor" ,(s.amount_minor-coalesce(ret.returned_minor,0))::int AS "usedMinor",
      (a.restored_points<>coalesce((SELECT floor(sum(x.returned_minor)/100) FROM mbox.checkout_returned_sources(a.tenant_id,a.store_id,a.quote_id) x WHERE x.lot_id=a.lot_id),0)
       OR EXISTS(SELECT 1 FROM mbox.item_after_sales_cases y WHERE
         (y.tenant_id,y.store_id,y.order_id)=(link.tenant_id,link.store_id,link.order_id) AND y.status IN('requested','approved'))
       OR EXISTS(SELECT 1 FROM mbox.order_refund_facts y JOIN mbox.refunds original USING(tenant_id,store_id,id)
         WHERE (y.tenant_id,y.store_id,y.order_id)=(link.tenant_id,link.store_id,link.order_id)
         AND y.status NOT IN('cancelled','rejected') AND (y.status<>'succeeded' OR
           (original.purpose IS DISTINCT FROM 'service_compensation' AND (original.purpose IS DISTINCT FROM 'return_goods'
             OR y.amount_minor<>(SELECT coalesce(sum(i.amount_minor),0) FROM mbox.refund_items i
               WHERE (i.tenant_id,i.store_id,i.refund_id)=(y.tenant_id,y.store_id,y.id))))))) review
    FROM mbox.table_tickets k
    JOIN mbox.checkout_point_portion_sources s ON (s.tenant_id,s.store_id)=(k.tenant_id,k.store_id) AND s.lot_id IN (SELECT mbox.ticket_spending_lots(k.tenant_id,k.store_id,k.point_lot_id))
    LEFT JOIN mbox.checkout_returned_sources(s.tenant_id,s.store_id,s.quote_id) ret ON (ret.portion_id,ret.lot_id)=(s.portion_id,s.lot_id)
    JOIN mbox.checkout_coupon_quote_lines q ON (q.tenant_id,q.store_id,q.quote_id,q.portion_id)=(s.tenant_id,s.store_id,s.quote_id,s.portion_id)
    JOIN mbox.checkout_point_lots a ON (a.tenant_id,a.store_id,a.quote_id,a.lot_id)=(s.tenant_id,s.store_id,s.quote_id,s.lot_id)
    JOIN mbox.checkout_coupon_order_links link ON (link.tenant_id,link.store_id,link.quote_id)=(s.tenant_id,s.store_id,s.quote_id)
    JOIN mbox.checkout_point_holds h ON (h.tenant_id,h.store_id,h.quote_id)=(s.tenant_id,s.store_id,s.quote_id) AND h.status='consumed'
    JOIN mbox.orders o ON (o.tenant_id,o.store_id,o.id)=(link.tenant_id,link.store_id,link.order_id)
    LEFT JOIN mbox.checkout_portion_order_items mapped ON (mapped.tenant_id,mapped.store_id,mapped.quote_id,mapped.portion_id)=(s.tenant_id,s.store_id,s.quote_id,s.portion_id)
    LEFT JOIN mbox.order_items original ON original.id=mapped.order_item_id
    JOIN mbox.products pr ON (pr.tenant_id,pr.store_id,pr.id)=(q.tenant_id,q.store_id,q.product_id)
    WHERE k.tenant_id=$1 AND k.store_id=$2 AND ${ticketMatch} ORDER BY link.order_id,q.request_index,q.portion_id,s.lot_id`,[tx.scope.tenantId,tx.scope.storeId,id])).rows
}

// The proposal is not a receivable until the buyer confirms it on the original refund.
export async function proposeTicketDining(tx:ScopedTransaction,caseId:string,employee:string,reason:string,split?:DiningSplit) {
  const scope=[tx.scope.tenantId,tx.scope.storeId]
  const row=(await tx.query<{consumed_minor:string;price_minor:number;unresolved:boolean}>(`
    SELECT b.consumed_minor,b.unresolved,o.price_minor FROM mbox.table_ticket_refund_requests f JOIN mbox.table_tickets k
      ON (k.tenant_id,k.store_id,k.id)=(f.tenant_id,f.store_id,f.ticket_id)
    JOIN mbox.table_ticket_purchases p ON (p.tenant_id,p.store_id,p.registration_id)=(k.tenant_id,k.store_id,k.registration_id)
    JOIN mbox.table_ticket_offers o ON (o.tenant_id,o.store_id,o.id)=(p.tenant_id,p.store_id,p.offer_id)
    CROSS JOIN LATERAL mbox.ticket_refund_basis(f.tenant_id,f.store_id,k.id) b
    WHERE f.tenant_id=$1 AND f.store_id=$2 AND f.id=$3 AND f.status='review' AND f.close_intent IS NULL
      AND EXISTS(SELECT 1 FROM mbox.loyalty_point_lots l WHERE(l.tenant_id,l.store_id,l.id,l.membership_id)=(k.tenant_id,k.store_id,k.point_lot_id,p.membership_id))
      FOR UPDATE OF f`,[...scope,caseId])).rows[0]
  if(!row)throw unavailable('核算须从待复核的原票进入')
  await requirePersonalTicketRefund(tx,caseId,'case')
  const lines=(await ticketDiningLines(tx,caseId)).filter(l=>l.usedMinor>0)
  const sum=lines.reduce((total,l)=>total+l.usedMinor,0)
  if(row.unresolved || !sum||sum!==Number(row.consumed_minor)||lines.some(l=>l.review))
    throw unavailable('涉及在途售后或缺少原价分摊，请核实原餐单')
  if(((await readRefundApprovalLimits(tx,employee)).CNY??0)<sum)throw unavailable('本次差额超过经办人审批额度')
  if (!split && sum>row.price_minor) throw unavailable('本票已抵菜款高于票款，请录入顾客应补、门店承担及核定依据')
  if (split && (![split.customerMinor,split.merchantMinor].every(value=>Number.isSafeInteger(value)&&value>=0)
    || split.customerMinor+split.merchantMinor!==sum || reason.trim().length<2)) {
    throw unavailable('顾客应补与门店承担须合计等于本票实际抵扣，请核对金额及依据')
  }
  // The original quote orders sources deterministically, including corrected lots on the same portion.
  const shares=split && allocateMinorAmount(split.customerMinor,lines.map((line,index)=>({id:String(index),amountMinor:line.usedMinor})))
  const allocated=lines.map((line,index)=>({...line,customerMinor:shares?.get(String(index))}))
  const orders=[...new Set(lines.map(l=>l.orderId))]
  await tx.query(`UPDATE mbox.ticket_dining_collections SET superseded_at=clock_timestamp()
    WHERE tenant_id=$1 AND store_id=$2 AND case_id=$3 AND superseded_at IS NULL AND consented_at IS NULL
    AND NOT(order_id=ANY($4::uuid[]))`,[...scope,caseId,orders])
  for(const orderId of orders){
    const items=allocated.filter(l=>l.orderId===orderId)
    const due=items.reduce((total,l)=>total+(l.customerMinor??l.usedMinor),0)
    const merchant=split?items.reduce((total,l)=>total+l.usedMinor,0)-due:null
    const snapshot=JSON.stringify(items)
    const changed=await tx.query(`SELECT 1 FROM mbox.ticket_dining_collections WHERE tenant_id=$1 AND store_id=$2 AND case_id=$3
      AND order_id=$4 AND consented_at IS NOT NULL AND (line_snapshot<>$5::jsonb OR ((merchant_minor IS NOT NULL OR $6::boolean) AND reason<>$7))`,[...scope,caseId,orderId,snapshot,Boolean(split),reason])
    if(changed.rowCount)throw unavailable('会员已确认的菜款有变动，请先从原案撤回并核对已收款，再按新明细确认')
    // Keep confirmed receipts immutable. Retire an unaccepted proposal if its original dishes changed.
    await tx.query(`UPDATE mbox.ticket_dining_collections SET superseded_at=clock_timestamp()
      WHERE tenant_id=$1 AND store_id=$2 AND case_id=$3 AND order_id=$4 AND superseded_at IS NULL
      AND consented_at IS NULL AND (line_snapshot<>$5::jsonb OR ((merchant_minor IS NOT NULL OR $6::boolean) AND reason<>$7))`,[...scope,caseId,orderId,snapshot,Boolean(split),reason])
    await tx.query(`INSERT INTO mbox.ticket_dining_collections(tenant_id,store_id,case_id,order_id,amount_minor,line_snapshot,reason,proposed_by,merchant_minor)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9) ON CONFLICT(tenant_id,store_id,case_id,order_id) WHERE superseded_at IS NULL DO NOTHING`,
      [...scope,caseId,orderId,due,snapshot,reason,employee,merchant])
  }
  return {caseId,amountMinor:split?.customerMinor??sum}
}

export async function consentTicketDining(tx:ScopedTransaction,id:string,customer:string) {
  const scope=[tx.scope.tenantId,tx.scope.storeId]
  const c=(await tx.query<{case_id:string;order_id:string;amount_minor:string;merchant_minor:string|null;consented_at:string|null}>(`
    SELECT c.case_id,c.order_id,c.amount_minor,c.merchant_minor,c.consented_at FROM mbox.ticket_dining_collections c JOIN mbox.table_ticket_refund_requests f
      ON (f.tenant_id,f.store_id,f.id)=(c.tenant_id,c.store_id,c.case_id) JOIN mbox.orders o ON (o.tenant_id,o.store_id,o.id)=(c.tenant_id,c.store_id,c.order_id)
    WHERE c.tenant_id=$1 AND c.store_id=$2 AND c.id=$3 AND c.superseded_at IS NULL AND f.status='review' AND f.close_intent IS NULL AND
      mbox.canonical_customer_id($1,$2,f.customer_id)=mbox.canonical_customer_id($1,$2,$4) FOR UPDATE OF f,c,o`,[...scope,id,customer])).rows[0]
  if(!c)throw new CustomerExperienceRequestError('请用原购票会员查看最新补款明细，原确认记录已变更或不可用','TICKET_DINING_REVIEW',409)
  if(c.consented_at)return {id,amountMinor:Number(c.amount_minor)}
  const lines=(await ticketDiningLines(tx,c.case_id)).filter(l=>l.orderId===c.order_id && l.usedMinor>0)
  const blocked=(await tx.query(`SELECT 1 WHERE EXISTS(SELECT 1 FROM mbox.ticket_dining_collections WHERE tenant_id=$1 AND store_id=$2 AND id=$4 AND (SELECT jsonb_agg(item-'customerMinor' ORDER BY n) FROM jsonb_array_elements(line_snapshot) WITH ORDINALITY AS x(item,n))<>$5::jsonb) OR mbox.order_collection_due_amount($1,$2,$3)<>0 OR EXISTS(
    SELECT 1 FROM mbox.order_payment_facts p WHERE p.tenant_id=$1 AND p.store_id=$2 AND p.order_id=$3 AND p.status IN('created','pending'))
    OR EXISTS(SELECT 1 FROM mbox.ticket_dining_collections c JOIN mbox.table_ticket_refund_requests f
      ON (f.tenant_id,f.store_id,f.id)=(c.tenant_id,c.store_id,c.case_id) WHERE c.tenant_id=$1 AND c.store_id=$2 AND c.order_id=$3 AND c.consented_at IS NOT NULL AND f.status='review')`,
    [...scope,c.order_id,id,JSON.stringify(lines)])).rowCount
  if(blocked||lines.some(l=>l.review)||lines.reduce((n,l)=>n+l.usedMinor,0)!==Number(c.amount_minor)+Number(c.merchant_minor))
    throw new CustomerExperienceRequestError('原菜款、售后或支付已发生变化，请门店重新核对','TICKET_DINING_REVIEW',409)
  await tx.query('UPDATE mbox.ticket_dining_collections SET consented_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=$3',[...scope,id])
  await new PaymentRepository(tx).syncOrderPaymentStatus(c.order_id)
  return {id,amountMinor:Number(c.amount_minor)}
}
