import {CustomerExperienceRequestError} from './customer-experience-repository.js'
import {ActivityOperationsError} from './activity-operations-repository.js'
import {readRefundApprovalLimits} from './refund-approval-limits.js'
import type {ScopedTransaction} from './transaction-runner.js'
import {PaymentRepository} from './payment-repository.js'

const unavailable=(message:string)=>new ActivityOperationsError(message,'TICKET_DINING_REVIEW',409)

export async function ticketDiningLines(tx:ScopedTransaction,caseId:string) {
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
    FROM mbox.table_ticket_refund_requests f JOIN mbox.table_tickets k ON (k.tenant_id,k.store_id,k.id)=(f.tenant_id,f.store_id,f.ticket_id)
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
    WHERE f.tenant_id=$1 AND f.store_id=$2 AND f.id=$3 ORDER BY link.order_id,q.request_index`,[tx.scope.tenantId,tx.scope.storeId,caseId])).rows
}

// The proposal is not a receivable until the buyer confirms it on the original refund.
export async function proposeTicketDining(tx:ScopedTransaction,caseId:string,employee:string,reason:string) {
  const scope=[tx.scope.tenantId,tx.scope.storeId]
  const row=(await tx.query<{consumed_minor:string;price_minor:number}>(`
    SELECT f.consumed_minor,o.price_minor FROM mbox.table_ticket_refund_requests f JOIN mbox.table_tickets k
      ON (k.tenant_id,k.store_id,k.id)=(f.tenant_id,f.store_id,f.ticket_id)
    JOIN mbox.table_ticket_purchases p ON (p.tenant_id,p.store_id,p.registration_id)=(k.tenant_id,k.store_id,k.registration_id)
    JOIN mbox.table_ticket_offers o ON (o.tenant_id,o.store_id,o.id)=(p.tenant_id,p.store_id,p.offer_id)
    WHERE f.tenant_id=$1 AND f.store_id=$2 AND f.id=$3 AND f.status='review' AND f.close_intent IS NULL
      AND EXISTS(SELECT 1 FROM mbox.loyalty_point_lots l WHERE(l.tenant_id,l.store_id,l.id,l.membership_id)=(k.tenant_id,k.store_id,k.point_lot_id,p.membership_id))
      FOR UPDATE OF f`,[...scope,caseId])).rows[0]
  if(!row)throw unavailable('核算须从待复核的原票进入')
  const lines=(await ticketDiningLines(tx,caseId)).filter(l=>l.usedMinor>0)
  const sum=lines.reduce((total,l)=>total+l.usedMinor,0)
  if(!sum||sum!==Number(row.consumed_minor)||sum>row.price_minor||lines.some(l=>l.review))
    throw unavailable('涉及已退菜款、超出票款或缺少原价分摊，请人工核实')
  if(((await readRefundApprovalLimits(tx,employee)).CNY??0)<sum)throw unavailable('本次差额超过经办人审批额度')
  for(const orderId of new Set(lines.map(l=>l.orderId))){
    const items=lines.filter(l=>l.orderId===orderId)
    await tx.query(`INSERT INTO mbox.ticket_dining_collections(tenant_id,store_id,case_id,order_id,amount_minor,line_snapshot,reason,proposed_by)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8) ON CONFLICT(tenant_id,store_id,case_id,order_id) DO NOTHING`,
      [...scope,caseId,orderId,items.reduce((n,l)=>n+l.usedMinor,0),JSON.stringify(items),reason,employee])
  }
  return {caseId,amountMinor:sum}
}

export async function consentTicketDining(tx:ScopedTransaction,id:string,customer:string) {
  const scope=[tx.scope.tenantId,tx.scope.storeId]
  const c=(await tx.query<{case_id:string;order_id:string;amount_minor:string;consented_at:string|null}>(`
    SELECT c.case_id,c.order_id,c.amount_minor,c.consented_at FROM mbox.ticket_dining_collections c JOIN mbox.table_ticket_refund_requests f
      ON (f.tenant_id,f.store_id,f.id)=(c.tenant_id,c.store_id,c.case_id) JOIN mbox.orders o ON (o.tenant_id,o.store_id,o.id)=(c.tenant_id,c.store_id,c.order_id)
    WHERE c.tenant_id=$1 AND c.store_id=$2 AND c.id=$3 AND f.status='review' AND f.close_intent IS NULL AND
      mbox.canonical_customer_id($1,$2,f.customer_id)=mbox.canonical_customer_id($1,$2,$4) FOR UPDATE OF f,c,o`,[...scope,id,customer])).rows[0]
  if(!c)throw new CustomerExperienceRequestError('仅原购票会员可确认待处理的菜款','TICKET_DINING_REVIEW',409)
  if(c.consented_at)return {id,amountMinor:Number(c.amount_minor)}
  const lines=(await ticketDiningLines(tx,c.case_id)).filter(l=>l.orderId===c.order_id)
  const blocked=(await tx.query(`SELECT 1 WHERE mbox.order_collection_due_amount($1,$2,$3)<>0 OR EXISTS(
    SELECT 1 FROM mbox.order_payment_facts p WHERE p.tenant_id=$1 AND p.store_id=$2 AND p.order_id=$3 AND p.status IN('created','pending'))
    OR EXISTS(SELECT 1 FROM mbox.ticket_dining_collections c JOIN mbox.table_ticket_refund_requests f
      ON (f.tenant_id,f.store_id,f.id)=(c.tenant_id,c.store_id,c.case_id) WHERE c.tenant_id=$1 AND c.store_id=$2 AND c.order_id=$3 AND c.consented_at IS NOT NULL AND f.status='review')`,
    [...scope,c.order_id])).rowCount
  if(blocked||lines.some(l=>l.review)||lines.reduce((n,l)=>n+l.usedMinor,0)!==Number(c.amount_minor))
    throw new CustomerExperienceRequestError('原菜款、售后或支付已发生变化，请门店重新核对','TICKET_DINING_REVIEW',409)
  await tx.query('UPDATE mbox.ticket_dining_collections SET consented_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=$3',[...scope,id])
  await new PaymentRepository(tx).syncOrderPaymentStatus(c.order_id)
  return {id,amountMinor:Number(c.amount_minor)}
}
