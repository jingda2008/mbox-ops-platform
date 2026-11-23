import {creditTableTicketGifts} from './table-ticket-gifts.js'
import {LoyaltyOperationalControlRepository} from './loyalty-operational-control-repository.js'
import {PaymentRepository} from './payment-repository.js'
import {CustomerExperienceRequestError} from './customer-experience-repository.js'
import type {ScopedTransaction} from './transaction-runner.js'

// Freeze the exact lot on the original ticket. Already expired points are
// distinguished from settled food discounts by the checkout source records.
export async function requestTicketRefund(tx:ScopedTransaction,registrationId:string,ticketId:string,customerId:string,reason:string) {
  const scope=[tx.scope.tenantId,tx.scope.storeId]
  const ticket=(await tx.query<{point_lot_id:string|null;gift_points:number;price_minor:number;refunded_at:string|null}>(`
    SELECT k.point_lot_id,o.gift_points,o.price_minor,k.refunded_at FROM mbox.table_tickets k
    JOIN mbox.table_ticket_purchases p USING(tenant_id,store_id,registration_id)
    JOIN mbox.table_ticket_offers o ON (o.tenant_id,o.store_id,o.id)=(p.tenant_id,p.store_id,p.offer_id)
    JOIN mbox.community_activity_registrations r ON (r.tenant_id,r.store_id,r.id)=(p.tenant_id,p.store_id,p.registration_id)
    WHERE k.tenant_id=$1 AND k.store_id=$2 AND k.id=$3 AND k.registration_id=$4
      AND mbox.canonical_customer_id(r.tenant_id,r.store_id,r.customer_id)=mbox.canonical_customer_id($1,$2,$5) FOR UPDATE OF k`,
    [...scope,ticketId,registrationId,customerId])).rows[0]
  if(!ticket)throw new CustomerExperienceRequestError('请选择本单本人的原票','TICKET_NOT_FOUND',404)
  const previous=(await tx.query<{id:string;status:string;consumed_minor:string}>(`SELECT id,status,consumed_minor FROM mbox.table_ticket_refund_requests
    WHERE tenant_id=$1 AND store_id=$2 AND ticket_id=$3 AND status NOT IN('rejected','cancelled')`,[...scope,ticketId])).rows[0]
  if(previous)return {caseId:previous.id,status:previous.status,ticketId,amountMinor:ticket.price_minor,consumedMinor:Number(previous.consumed_minor)}
  const correctionOpen=Boolean((await tx.query("SELECT 1 FROM mbox.table_ticket_corrections WHERE tenant_id=$1 AND store_id=$2 AND ticket_id=$3 AND status='requested'",[...scope,ticketId])).rowCount)
  if(ticket.refunded_at)throw new CustomerExperienceRequestError('该票已退款','TICKET_ALREADY_REFUNDED',409)
  let frozen=0,consumedMinor=0,review=correctionOpen
  if(ticket.gift_points>0 && !ticket.point_lot_id){
    // A delayed award is suppressed by the open case. An unlinked ledger entry needs reconciliation.
    review=review || Boolean((await tx.query(`SELECT 1 FROM mbox.loyalty_point_ledger
      WHERE tenant_id=$1 AND store_id=$2 AND source_type='activity' AND source_id=$3 AND entry_type='earn'`,[...scope,ticketId])).rowCount)
  }
  if(ticket.point_lot_id){
    const lot=(await tx.query<{remaining_points:number;status:string;wrong:boolean}>(`SELECT remaining_points,status,
      membership_id<>(SELECT p.membership_id FROM mbox.table_ticket_purchases p WHERE p.registration_id=$4 AND p.tenant_id=$1 AND p.store_id=$2) wrong FROM mbox.loyalty_point_lots
      WHERE tenant_id=$1 AND store_id=$2 AND id=$3 FOR UPDATE`,[...scope,ticket.point_lot_id,registrationId])).rows[0]!
    const usage=(await tx.query<{used:string;uncertain:boolean}>(`SELECT coalesce(sum(coalesce((SELECT sum(s.amount_minor-coalesce(rr.returned_minor,0)) FROM mbox.checkout_point_portion_sources s
        LEFT JOIN mbox.checkout_returned_sources(a.tenant_id,a.store_id,a.quote_id) rr ON (rr.portion_id,rr.lot_id)=(s.portion_id,s.lot_id)
        WHERE (s.tenant_id,s.store_id,s.quote_id,s.lot_id)=(a.tenant_id,a.store_id,a.quote_id,a.lot_id)),(a.points::bigint-a.restored_points)*100))
      FILTER(WHERE h.status='consumed'),0)::text used,
      coalesce(bool_or(h.status='held' OR (a.restored_points>0 AND a.restored_points<a.points)),false) uncertain
      FROM mbox.checkout_point_lots a JOIN mbox.checkout_point_holds h USING(tenant_id,store_id,quote_id)
      WHERE a.tenant_id=$1 AND a.store_id=$2 AND a.lot_id IN(SELECT mbox.ticket_spending_lots($1,$2,$3))`,[...scope,ticket.point_lot_id])).rows[0]!
    consumedMinor=Number(usage.used);review=lot.wrong || correctionOpen || usage.uncertain || consumedMinor>0 || lot.status==='reversed'
    frozen=lot.remaining_points
    if(lot.status==='available' || lot.status==='consumed')await tx.query(`UPDATE mbox.loyalty_point_lots SET status='ticket_hold'
      WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,[...scope,ticket.point_lot_id])
  }
  const saved=(await tx.query<{id:string}>(`INSERT INTO mbox.table_ticket_refund_requests(tenant_id,store_id,ticket_id,
    customer_id,reason,status,frozen_points,consumed_minor,source_review_required) VALUES($1,$2,$3,$4,$5,'review',$6,$7,$8) RETURNING id`,
    [...scope,ticketId,customerId,reason,frozen,consumedMinor,review])).rows[0]!
  return {caseId:saved.id,status:'review',ticketId,amountMinor:ticket.price_minor,consumedMinor}
}

async function diningDifferencePaid(tx:ScopedTransaction,caseId:string){
  return (await tx.query<{cleared:boolean}>(`SELECT EXISTS(SELECT 1 FROM mbox.ticket_dining_collections c WHERE c.tenant_id=$1 AND c.store_id=$2 AND c.case_id=$3)
    AND f.consumed_minor=(SELECT coalesce(sum(c.amount_minor),0) FROM mbox.ticket_dining_collections c JOIN mbox.payments p
      ON (p.tenant_id,p.store_id,p.id)=(c.tenant_id,c.store_id,c.payment_id) WHERE c.tenant_id=$1 AND c.store_id=$2 AND c.case_id=$3
      AND c.consented_at IS NOT NULL AND p.status='succeeded' AND p.amount_minor=c.amount_minor AND p.order_id=c.order_id
      AND NOT EXISTS(SELECT 1 FROM mbox.refunds r WHERE (r.tenant_id,r.store_id,r.payment_id)=(p.tenant_id,p.store_id,p.id) AND r.status NOT IN('cancelled','rejected')))
    AS cleared FROM mbox.table_ticket_refund_requests f WHERE f.tenant_id=$1 AND f.store_id=$2 AND f.id=$3`,[tx.scope.tenantId,tx.scope.storeId,caseId])).rows[0]?.cleared===true
}

export async function submitTicketCashRefund(tx:ScopedTransaction,caseId:string,employee:string,amountMinor:number,merchantReason:string|null) {
  const scope=[tx.scope.tenantId,tx.scope.storeId]
  const row=(await tx.query<{refund_id:string|null;status:string;price_minor:number;payment_id:string;reason:string;source_review_required:boolean}>(`
    SELECT f.refund_id,f.status,f.reason,f.source_review_required,o.price_minor,k.payment_id
    FROM mbox.table_ticket_refund_requests f JOIN mbox.table_tickets k ON (k.tenant_id,k.store_id,k.id)=(f.tenant_id,f.store_id,f.ticket_id)
    JOIN mbox.table_ticket_purchases p ON (p.tenant_id,p.store_id,p.registration_id)=(k.tenant_id,k.store_id,k.registration_id)
    JOIN mbox.table_ticket_offers o ON (o.tenant_id,o.store_id,o.id)=(p.tenant_id,p.store_id,p.offer_id)
    WHERE f.tenant_id=$1 AND f.store_id=$2 AND f.id=$3 AND f.close_intent IS NULL FOR UPDATE OF f,k`,[...scope,caseId])).rows[0]
  if(!row || !['review','requested','refunded'].includes(row.status))throw new CustomerExperienceRequestError('原退票案不可提交','TICKET_REFUND_UNAVAILABLE',409)
  if(row.refund_id)return {caseId,refundId:row.refund_id}
  if(row.source_review_required && !merchantReason && !await diningDifferencePaid(tx,caseId))throw new CustomerExperienceRequestError('请先核对本票关联菜款及收款记录','TICKET_DINING_REVIEW_REQUIRED',409)
  if(amountMinor<=0 || !Number.isSafeInteger(amountMinor) || amountMinor>row.price_minor)throw new CustomerExperienceRequestError('退款金额超出原票实付')
  const pay=(await tx.query<{status:string;amount_minor:string}>(`SELECT status,amount_minor FROM mbox.payments
    WHERE tenant_id=$1 AND store_id=$2 AND id=$3 FOR UPDATE`,[...scope,row.payment_id])).rows[0]!
  const total=(await tx.query<{reserved:string}>(`SELECT coalesce(sum(amount_minor),0) reserved FROM mbox.refunds
    WHERE tenant_id=$1 AND store_id=$2 AND payment_id=$3 AND (status IN('requested','approved','processing','succeeded')
      OR (status='failed' AND approved_by_employee_id IS NOT NULL))`,[...scope,row.payment_id])).rows[0]!
  if(!['succeeded','partially_refunded'].includes(pay.status)||Number(total.reserved)+amountMinor>Number(pay.amount_minor))
    throw new CustomerExperienceRequestError('原支付可退金额不足，请查原退款','TICKET_REFUND_BALANCE',409)
  const saved=(await tx.query<{id:string}>(`INSERT INTO mbox.refunds(tenant_id,store_id,payment_id,public_id,amount_minor,
    currency,status,reason,requested_by_employee_id,provider_snapshot)
    VALUES($1,$2,$3,$4,$5,'CNY','requested',$6,$7,$8::jsonb) RETURNING id`,[...scope,row.payment_id,'TTR'+caseId.replaceAll('-',''),
    amountMinor,merchantReason??row.reason,employee,JSON.stringify({tableTicketCaseId:caseId,merchantReason})])).rows[0]!
  await tx.query("UPDATE mbox.table_ticket_refund_requests SET refund_id=$4,status='requested' WHERE tenant_id=$1 AND store_id=$2 AND id=$3",
    [...scope,caseId,saved.id])
  return {caseId,refundId:saved.id}
}

export async function decideTicketCase(tx:ScopedTransaction,ticket:string,actor:{customer:string}|{employee:string},action:'cancelled'|'rejected'|'zero',reason:string){
  const scope=[tx.scope.tenantId,tx.scope.storeId]
  const r=(await tx.query<{id:string;customer_id:string;status:string;cash_status:string|null;close_intent:string|null;consumed_minor:string;source_review_required:boolean;registration_id:string;payment_id:string;point_lot_id:string|null}>(`
    SELECT f.id,f.customer_id,f.status,r.status AS cash_status,f.close_intent,f.consumed_minor,f.source_review_required,k.registration_id,k.payment_id,k.point_lot_id
    FROM mbox.table_ticket_refund_requests f JOIN mbox.table_tickets k ON (k.tenant_id,k.store_id,k.id)=(f.tenant_id,f.store_id,f.ticket_id)
    LEFT JOIN mbox.refunds r ON(r.tenant_id,r.store_id,r.id)=(f.tenant_id,f.store_id,f.refund_id)
    WHERE f.tenant_id=$1 AND f.store_id=$2 AND f.ticket_id=$3 AND f.status IN('requested','review')
    AND ($4::uuid IS NULL OR mbox.canonical_customer_id($1,$2,f.customer_id)=mbox.canonical_customer_id($1,$2,$4)) FOR UPDATE OF f,k`,
    [...scope,ticket,'customer' in actor?actor.customer:null])).rows[0]
  if(!r || (r.cash_status && !['cancelled','rejected'].includes(r.cash_status)) || ('customer' in actor && action!=='cancelled'))
    throw new CustomerExperienceRequestError('退款已进入原收款渠道，请查询原退款状态','TICKET_CASE_STATE',409)
  if(r.close_intent && r.close_intent!==action)throw new CustomerExperienceRequestError('正在处理原售后决定','TICKET_CASE_STATE',409)
  if(action==='zero' && (r.source_review_required || Number(r.consumed_minor)>0) && !await diningDifferencePaid(tx,r.id))throw new CustomerExperienceRequestError('有消费或归属争议，须先核实原菜款','TICKET_DINING_REVIEW_REQUIRED',409)
  await tx.query(`UPDATE mbox.table_ticket_refund_requests SET close_intent=$4,close_reason=coalesce(close_reason,$5),close_actor=coalesce(close_actor,$6)
    WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,[...scope,r.id,action,reason,'employee' in actor?'employee:'+actor.employee:'customer:'+actor.customer])
  const bills=(await tx.query<{id:string;order_id:string;payment_id:string|null;amount_minor:string;status:string|null;refund_status:string|null}>(`
    SELECT c.id,c.order_id,c.payment_id,c.amount_minor,p.status,old.status AS refund_status FROM mbox.ticket_dining_collections c LEFT JOIN mbox.payments p
      ON(p.tenant_id,p.store_id,p.id)=(c.tenant_id,c.store_id,c.payment_id) LEFT JOIN mbox.refunds old ON(old.tenant_id,old.store_id,old.id)=(c.tenant_id,c.store_id,c.return_refund_id)
    WHERE c.tenant_id=$1 AND c.store_id=$2 AND c.case_id=$3 FOR UPDATE OF c`,[...scope,r.id])).rows
  for(const c of bills){
    if(action==='zero'||!('employee' in actor)||!c.payment_id||c.status!=='succeeded'||(c.refund_status && !['rejected','cancelled'].includes(c.refund_status)))continue
    await tx.query('SELECT id FROM mbox.payments WHERE tenant_id=$1 AND store_id=$2 AND id=$3 FOR UPDATE',[...scope,c.payment_id])
    const existing=(await tx.query(`SELECT 1 FROM mbox.refunds WHERE tenant_id=$1 AND store_id=$2 AND payment_id=$3 AND status NOT IN('rejected','cancelled')`,[...scope,c.payment_id])).rowCount
    if(existing)continue
    const receipt=(await tx.query<{id:string}>(`INSERT INTO mbox.refunds(tenant_id,store_id,payment_id,order_id,public_id,amount_minor,currency,status,reason,requested_by_employee_id,provider_snapshot)
      VALUES($1,$2,$3,$4,'TDR'||replace(gen_random_uuid()::text,'-',''),$5,'CNY','requested',$6,$7,jsonb_build_object('diningCollection',$8::text)) RETURNING id`,
      [...scope,c.payment_id,c.order_id,c.amount_minor,reason,actor.employee,c.id])).rows[0]!
    await tx.query('UPDATE mbox.ticket_dining_collections SET return_refund_id=$4 WHERE tenant_id=$1 AND store_id=$2 AND id=$3',[...scope,c.id,receipt.id])
  }
  await tx.query('SELECT mbox.finish_ticket_case($1,$2,$3)',[...scope,r.id])
  for(const c of bills)await new PaymentRepository(tx).syncOrderPaymentStatus(c.order_id)
  const state=(await tx.query<{status:string}>('SELECT status FROM mbox.table_ticket_refund_requests WHERE tenant_id=$1 AND store_id=$2 AND id=$3',[...scope,r.id])).rows[0]!.status
  if(!r.point_lot_id && ['rejected','cancelled'].includes(state) && (await new LoyaltyOperationalControlRepository(tx).state('points_accrual',true)).state!=='paused'){
    await creditTableTicketGifts(tx,r.registration_id,r.payment_id)
  }
  return {id:r.id,status:state}
}
