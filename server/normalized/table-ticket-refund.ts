import {requirePersonalTicketRefund} from './table-ticket-admission-policy.js'
import {ticketRefundPreview} from './table-ticket-refund-preview.js'
import {creditTableTicketGifts} from './table-ticket-gifts.js'
import {LoyaltyOperationalControlRepository} from './loyalty-operational-control-repository.js'
import {PaymentRepository} from './payment-repository.js'
import {CustomerExperienceRequestError} from './customer-experience-repository.js'
import type {ScopedTransaction} from './transaction-runner.js'

// Freeze the exact lot on the original ticket. Already expired points are
// distinguished from settled food discounts by the checkout source records.
export async function requestTicketRefund(tx:ScopedTransaction,registrationId:string,ticketId:string,customerId:string,reason:string,previewVersion?:string,merchant=false) {
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
  const previous=(await tx.query<{id:string;status:string;consumed_minor:string}>(`SELECT f.id,f.status,coalesce(b.consumed_minor,f.consumed_minor) AS consumed_minor FROM mbox.table_ticket_refund_requests f
    LEFT JOIN LATERAL mbox.ticket_refund_basis(f.tenant_id,f.store_id,f.ticket_id) b ON f.status='review' AND f.close_intent IS NULL
    WHERE f.tenant_id=$1 AND f.store_id=$2 AND f.ticket_id=$3 AND f.status NOT IN('rejected','cancelled')`,[...scope,ticketId])).rows[0]
  if(previous)return {caseId:previous.id,status:previous.status,ticketId,amountMinor:ticket.price_minor,consumedMinor:Number(previous.consumed_minor)}
  if(ticket.refunded_at)throw new CustomerExperienceRequestError('该票已退款','TICKET_ALREADY_REFUNDED',409)
  if(!merchant)await requirePersonalTicketRefund(tx,ticketId,'ticket')
  let frozen=0,holdLot=false
  if(ticket.point_lot_id){
    const lot=(await tx.query<{remaining_points:number;status:string}>(`SELECT remaining_points,status FROM mbox.loyalty_point_lots
      WHERE tenant_id=$1 AND store_id=$2 AND id=$3 FOR UPDATE`,[...scope,ticket.point_lot_id])).rows[0]!
    frozen=lot.remaining_points
    holdLot=lot.status==='available' || lot.status==='consumed'
  }
  if(previewVersion && (await ticketRefundPreview(tx,ticketId))[0]?.previewVersion!==previewVersion)
    throw new CustomerExperienceRequestError('原票金额或积分已变化，请刷新本票后重新核对','TICKET_PREVIEW_CHANGED',409)
  if(holdLot)await tx.query(`UPDATE mbox.loyalty_point_lots SET status='ticket_hold'
    WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,[...scope,ticket.point_lot_id])
  const basis=(await tx.query<{consumed_minor:string;requires_review:boolean}>('SELECT * FROM mbox.ticket_refund_basis($1,$2,$3)',[...scope,ticketId])).rows[0]!
  const consumedMinor=Number(basis.consumed_minor),review=basis.requires_review
  const saved=(await tx.query<{id:string}>(`INSERT INTO mbox.table_ticket_refund_requests(tenant_id,store_id,ticket_id,
    customer_id,reason,status,frozen_points,consumed_minor,source_review_required) VALUES($1,$2,$3,$4,$5,'review',$6,$7,$8) RETURNING id`,
    [...scope,ticketId,customerId,reason,frozen,consumedMinor,review])).rows[0]!
  return {caseId:saved.id,status:'review',ticketId,amountMinor:ticket.price_minor,consumedMinor}
}

async function hasConfirmedDining(tx:ScopedTransaction,caseId:string){
  return Boolean((await tx.query(`SELECT 1 FROM mbox.ticket_dining_collections WHERE tenant_id=$1 AND store_id=$2
    AND case_id=$3 AND consented_at IS NOT NULL LIMIT 1`,[tx.scope.tenantId,tx.scope.storeId,caseId])).rowCount)
}

async function diningDifferencePaid(tx:ScopedTransaction,caseId:string,consumed:string){
  const scope=[tx.scope.tenantId,tx.scope.storeId,caseId,consumed]
  const totals=await tx.query<{cleared:boolean}>(`SELECT mbox.ticket_dining_cleared($1,$2,$3) AND sum(c.amount_minor+coalesce(c.merchant_minor,0))=$4::bigint AS cleared
    FROM mbox.ticket_dining_collections c WHERE (c.tenant_id,c.store_id,c.case_id)=($1,$2,$3) AND c.superseded_at IS NULL`,scope)
  return totals.rows[0]?.cleared===true
}

export async function submitTicketCashRefund(tx:ScopedTransaction,caseId:string,employee:string,amountMinor:number,merchantReason:string|null,origin:'staff'|'automatic'='staff') {
  const scope=[tx.scope.tenantId,tx.scope.storeId]
  const row=(await tx.query<{planned_refund_minor:number|null;planned_refund_employee:string|null;refund_id:string|null;status:string;price_minor:number;payment_id:string;reason:string;source_review_required:boolean;unresolved:boolean;consumed_minor:string}>(`
    SELECT f.planned_refund_minor,f.planned_refund_employee,f.refund_id,f.status,f.reason,b.requires_review AS source_review_required,b.unresolved,b.consumed_minor,o.price_minor,k.payment_id
    FROM mbox.table_ticket_refund_requests f JOIN mbox.table_tickets k ON (k.tenant_id,k.store_id,k.id)=(f.tenant_id,f.store_id,f.ticket_id)
    JOIN mbox.table_ticket_purchases p ON (p.tenant_id,p.store_id,p.registration_id)=(k.tenant_id,k.store_id,k.registration_id)
    JOIN mbox.table_ticket_offers o ON (o.tenant_id,o.store_id,o.id)=(p.tenant_id,p.store_id,p.offer_id)
    CROSS JOIN LATERAL mbox.ticket_refund_basis(f.tenant_id,f.store_id,k.id) b
    WHERE f.tenant_id=$1 AND f.store_id=$2 AND f.id=$3 AND f.close_intent IS NULL FOR UPDATE OF f,k`,[...scope,caseId])).rows[0]
  if(!row || !['review','requested','refunded'].includes(row.status))throw new CustomerExperienceRequestError('原退票案不可提交','TICKET_REFUND_UNAVAILABLE',409)
  if(row.refund_id){
    const original=await tx.query(`SELECT 1 FROM mbox.refunds WHERE tenant_id=$1 AND store_id=$2 AND id=$3
      AND amount_minor=$4 AND (provider_snapshot->>'merchantReason') IS NOT DISTINCT FROM $5::text`,[...scope,row.refund_id,amountMinor,merchantReason])
    if(!original.rowCount)throw new CustomerExperienceRequestError('原退款已提交，本次金额或退票原因与原申请不一致，请查询原退款','TICKET_REFUND_CHANGED',409)
    return {caseId,refundId:row.refund_id}
  }
  if(!merchantReason)await requirePersonalTicketRefund(tx,caseId,'case')
  const confirmed=await hasConfirmedDining(tx,caseId)
  if(!merchantReason && (row.unresolved || ((row.source_review_required || confirmed) && !await diningDifferencePaid(tx,caseId,row.consumed_minor))))throw new CustomerExperienceRequestError('请先核对本票关联菜款及收款记录','TICKET_DINING_REVIEW_REQUIRED',409)
  if(!merchantReason && row.planned_refund_minor!==null && (origin!=='automatic' || row.planned_refund_minor!==amountMinor || row.planned_refund_employee!==employee))
    throw new CustomerExperienceRequestError('本案已安排自动送审，请从原案查看进度','TICKET_AUTO_REVIEW_PLANNED',409)
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
    amountMinor,merchantReason??row.reason,employee,JSON.stringify({tableTicketCaseId:caseId,merchantReason,...(origin==='automatic'&&{submittedAfterDiningCollection:true})})])).rows[0]!
  await tx.query("UPDATE mbox.table_ticket_refund_requests SET refund_id=$4,status='requested',merchant_assumes_dining=$5 WHERE tenant_id=$1 AND store_id=$2 AND id=$3",
    [...scope,caseId,saved.id,Boolean(merchantReason)])
  if(merchantReason && confirmed){
    const orders=await tx.query<{order_id:string}>('SELECT order_id FROM mbox.ticket_dining_collections WHERE tenant_id=$1 AND store_id=$2 AND case_id=$3 AND consented_at IS NOT NULL ORDER BY order_id',[...scope,caseId])
    for(const bill of orders.rows)await new PaymentRepository(tx).syncOrderPaymentStatus(bill.order_id)
  }
  return {caseId,refundId:saved.id}
}

export async function decideTicketCase(tx:ScopedTransaction,ticket:string,actor:{customer:string}|{employee:string},action:'cancelled'|'rejected'|'zero',reason:string){
  const scope=[tx.scope.tenantId,tx.scope.storeId]
  const r=(await tx.query<{id:string;customer_id:string;status:string;cash_status:string|null;close_intent:string|null;unresolved:boolean;consumed_minor:string;source_review_required:boolean;registration_id:string;payment_id:string;point_lot_id:string|null}>(`
    SELECT f.id,f.customer_id,f.status,r.status AS cash_status,f.close_intent,b.consumed_minor,b.unresolved,b.requires_review AS source_review_required,k.registration_id,k.payment_id,k.point_lot_id
    FROM mbox.table_ticket_refund_requests f JOIN mbox.table_tickets k ON (k.tenant_id,k.store_id,k.id)=(f.tenant_id,f.store_id,f.ticket_id)
    LEFT JOIN mbox.refunds r ON(r.tenant_id,r.store_id,r.id)=(f.tenant_id,f.store_id,f.refund_id)
    CROSS JOIN LATERAL mbox.ticket_refund_basis(f.tenant_id,f.store_id,k.id) b
    WHERE f.tenant_id=$1 AND f.store_id=$2 AND f.ticket_id=$3 AND f.status IN('requested','review')
    AND ($4::uuid IS NULL OR mbox.canonical_customer_id($1,$2,f.customer_id)=mbox.canonical_customer_id($1,$2,$4)) FOR UPDATE OF f,k`,
    [...scope,ticket,'customer' in actor?actor.customer:null])).rows[0]
  if(!r || (r.cash_status && !['cancelled','rejected'].includes(r.cash_status)) || ('customer' in actor && action!=='cancelled'))
    throw new CustomerExperienceRequestError('退款已进入原收款渠道，请查询原退款状态','TICKET_CASE_STATE',409)
  if(r.close_intent && r.close_intent!==action)throw new CustomerExperienceRequestError('正在处理原售后决定','TICKET_CASE_STATE',409)
  if(action==='zero' && (r.unresolved || ((r.source_review_required || await hasConfirmedDining(tx,r.id)) && !await diningDifferencePaid(tx,r.id,r.consumed_minor))))throw new CustomerExperienceRequestError('有消费或归属争议，须先核实原菜款','TICKET_DINING_REVIEW_REQUIRED',409)
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
