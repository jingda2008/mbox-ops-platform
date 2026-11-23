import {ActivityOperationsError} from './activity-operations-repository.js'
import {StaffAccessRepository} from './staff-access-repository.js'
import {creditTableTicketGifts} from './table-ticket-gifts.js'
import type {ScopedTransaction} from './transaction-runner.js'

async function readBuyerUseItems(tx:ScopedTransaction,lot:string){
  return (await tx.query(`SELECT o.public_id AS "orderNo",coalesce(i.product_snapshot->>'name','原菜品') AS name,
        sum(s.amount_minor-coalesce(r.returned_minor,0))::int AS minor
        FROM mbox.checkout_point_portion_sources s JOIN mbox.checkout_coupon_order_links l USING(tenant_id,store_id,quote_id)
        JOIN mbox.orders o ON (o.tenant_id,o.store_id,o.id)=(l.tenant_id,l.store_id,l.order_id)
        JOIN mbox.checkout_portion_order_items m ON (m.tenant_id,m.store_id,m.quote_id,m.portion_id)=(s.tenant_id,s.store_id,s.quote_id,s.portion_id)
        JOIN mbox.order_items i ON (i.tenant_id,i.store_id,i.id)=(m.tenant_id,m.store_id,m.order_item_id)
        LEFT JOIN mbox.checkout_returned_sources(s.tenant_id,s.store_id,s.quote_id) r ON(r.portion_id,r.lot_id)=(s.portion_id,s.lot_id)
        WHERE s.tenant_id=$1 AND s.store_id=$2 AND s.lot_id=$3
        GROUP BY o.public_id,i.id ORDER BY o.public_id,i.id`,[tx.scope.tenantId,tx.scope.storeId,lot])).rows
}

export async function correctTicketGift(tx:ScopedTransaction,ticketId:string,employee:string,reason:string,action:'request'|'approve'|'reject',caseId:string|null,merchantAssumes=false,buyerUse=false) {
  const scope=[tx.scope.tenantId,tx.scope.storeId]
  const access=new StaffAccessRepository(tx)
  await access.assertPermission(employee,'loyalty.adjust.manual')
  if(action!=='request')await access.assertPermission(employee,'loyalty.accrual.approve')
  const k=(await tx.query<{membership_id:string;target:string;customer_id:string;lot_id:string;original_points:number;remaining_points:number;
    registration_id:string;payment_id:string;expected_points:number;quantity_corrected:boolean;status:string;refunded:boolean;expired:boolean;pending_refund:boolean}>(`
    SELECT l.membership_id,p.membership_id target,l.customer_id,l.id lot_id,l.original_points,l.remaining_points,k.registration_id,
      o.gift_points expected_points,EXISTS(SELECT 1 FROM mbox.table_ticket_corrections applied
        WHERE(applied.tenant_id,applied.store_id,applied.ticket_id,applied.replacement_lot_id)=(k.tenant_id,k.store_id,k.id,l.id) AND applied.status='approved') quantity_corrected,
      k.payment_id,k.refunded_at IS NOT NULL refunded,l.status,l.expires_at<=clock_timestamp() expired,
      EXISTS(SELECT 1 FROM mbox.table_ticket_refund_requests f WHERE (f.tenant_id,f.store_id,f.ticket_id)=(k.tenant_id,k.store_id,k.id)
        AND f.status NOT IN('cancelled','rejected')) pending_refund
    FROM mbox.table_tickets k JOIN mbox.table_ticket_purchases p USING(tenant_id,store_id,registration_id)
    JOIN mbox.loyalty_point_lots l ON (l.tenant_id,l.store_id,l.id)=(k.tenant_id,k.store_id,k.point_lot_id)
    JOIN mbox.table_ticket_offers o ON (o.tenant_id,o.store_id,o.id)=(p.tenant_id,p.store_id,p.offer_id)
    WHERE l.source_type='table_ticket' AND l.source_id=k.id::text AND k.tenant_id=$1 AND k.store_id=$2 AND k.id=$3 FOR UPDATE OF k,l`,[...scope,ticketId])).rows[0]
  if(!k || (k.membership_id===k.target && (k.original_points===k.expected_points || k.quantity_corrected)))throw new ActivityOperationsError('仅可把错发批次更正到原购票会员；请核对原票及售后状态','TICKET_CORRECTION_INELIGIBLE',409)
  if(k.pending_refund && !k.refunded){
    const open=(await tx.query(`SELECT f.id FROM mbox.table_ticket_refund_requests f WHERE f.ticket_id=$1 AND f.status='review'
      AND f.close_intent IS NULL AND f.refund_id IS NULL AND NOT EXISTS(SELECT 1 FROM mbox.ticket_dining_collections c WHERE c.case_id=f.id) FOR UPDATE`,[ticketId])).rowCount
    if(!open)throw new ActivityOperationsError('原退款已办理，请待回执后核对错户积分','TICKET_CORRECTION_INELIGIBLE',409)
  }
  const sameMember=k.membership_id===k.target
  const overage=sameMember?Math.max(0,k.original_points-k.expected_points):0
  if(action==='request'){
    const used=k.original_points-k.remaining_points
    if(sameMember && used && (!overage || overage>k.remaining_points))
      throw new ActivityOperationsError('数量差错已涉及消费，需核实原单差额及责任','TICKET_USED_CORRECTION_REVIEW',409)
    const eligibleLot=['available','consumed'].includes(k.status)||(k.pending_refund && k.status==='ticket_hold')
    if(!eligibleLot || (k.expired&&!k.refunded) || (used && !overage && !merchantAssumes && !buyerUse))throw new ActivityOperationsError('已用错户积分须核对原菜款和责任后处理','TICKET_USED_CORRECTION_REVIEW',409)
    if(buyerUse && (merchantAssumes || sameMember || used<1 || used>k.expected_points))
      throw new ActivityOperationsError('请核实原票金额和唯一消费归属','TICKET_USED_CORRECTION_REVIEW',409)
    if(used){
      if(!sameMember)await access.assertPermission(employee,'community.activity.manage')
      const facts=(await tx.query<{points:string;unsettled:boolean}>(`SELECT coalesce(sum(a.points-a.restored_points) FILTER(WHERE h.status='consumed'),0)::text points,
        coalesce(bool_or(h.status='held' OR (a.restored_points>0 AND a.restored_points<a.points)),false) unsettled
        FROM mbox.checkout_point_lots a JOIN mbox.checkout_point_holds h USING(tenant_id,store_id,quote_id)
        WHERE a.tenant_id=$1 AND a.store_id=$2 AND a.lot_id=$3`,[...scope,k.lot_id])).rows[0]!
      if(facts.unsettled||Number(facts.points)!==used)throw new ActivityOperationsError('已用金额与原消费不符或仍在途，请核实原菜款','TICKET_USED_CORRECTION_REVIEW',409)
    }
    let details:null|Record<string,unknown>[]=null
    if (buyerUse) {
      details=await readBuyerUseItems(tx,k.lot_id)
      if(details.reduce((n,line)=>n+Number(line.minor),0)!==used*100)
        throw new ActivityOperationsError('须核对原消费份次和本票抵扣','TICKET_USED_CORRECTION_REVIEW',409)
    }
    const saved=(await tx.query<{id:string}>(`INSERT INTO mbox.table_ticket_corrections(tenant_id,store_id,ticket_id,original_lot_id,target_membership_id,requested_by,reason,consumption_resolution,consumed_points,consumption_items)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) RETURNING id`,[...scope,ticketId,k.lot_id,k.target,employee,reason,buyerUse?'buyer_use':used && !sameMember?'merchant_assumes':'unused',used,details?JSON.stringify(details):null])).rows[0]!
    await tx.query("UPDATE mbox.loyalty_point_lots SET status='ticket_hold' WHERE tenant_id=$1 AND store_id=$2 AND id=$3",[...scope,k.lot_id])
    return {id:saved.id,status:'requested'}
  }
  const pending=(await tx.query<{requested_by:string;consumed_points:number;consumption_resolution:string;buyer_confirmed_at:string|null;consumption_items:{orderNo:string;name:string;minor:number}[]}>(`SELECT requested_by,consumed_points,consumption_resolution,buyer_confirmed_at,consumption_items FROM mbox.table_ticket_corrections
    WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND ticket_id=$4 AND original_lot_id=$5 AND status='requested' FOR UPDATE`,
    [...scope,caseId,ticketId,k.lot_id])).rows[0]
  if(!pending||pending.requested_by===employee)throw new ActivityOperationsError('需要另一位有权限的员工复核原申请','TICKET_CORRECTION_REVIEWER',409)
  let replacement:string|null=null
  if(action==='approve'){
    const authority=await access.resolveApprovalAuthority(employee,'loyalty.adjust.manual')
    if(authority?.calculationMode!=='amount_limit'||authority.currency!=='CNY'||(authority.amountMinor??0)<Math.max(k.original_points,k.expected_points)*100)
      throw new ActivityOperationsError('未达到本票赠分的审批额度','TICKET_CORRECTION_LIMIT',403)
    if(pending.consumed_points && !sameMember)await access.assertPermission(employee,'community.activity.manage')
    if((k.expired && !k.refunded)||k.status!=='ticket_hold'||k.original_points-pending.consumed_points!==k.remaining_points)throw new ActivityOperationsError('原批次已变化，请重新核算','TICKET_CORRECTION_CHANGED',409)
    if (pending.consumption_resolution==='buyer_use' && !pending.buyer_confirmed_at)
      throw new ActivityOperationsError('需要原购票会员在我的门票中确认原消费','TICKET_BUYER_CONFIRM_REQUIRED',409)
    if(pending.consumption_resolution==='buyer_use'){
      const current=await readBuyerUseItems(tx,k.lot_id)
      if(current.length!==pending.consumption_items.length || current.some((line,i)=>{
        const confirmed=pending.consumption_items[i]!
        return line.orderNo!==confirmed.orderNo || line.name!==confirmed.name || line.minor!==confirmed.minor
      }))throw new ActivityOperationsError('原菜品售后已变化，请重新核对并确认','TICKET_CORRECTION_CHANGED',409)
    }
    const retainLot=overage>0 && !k.refunded
    const debit=retainLot?overage:k.remaining_points
    const retained=k.remaining_points-debit
    const account=(await tx.query<{available_points:number}>(`UPDATE mbox.loyalty_accounts SET available_points=available_points-$4
      WHERE tenant_id=$1 AND store_id=$2 AND membership_id=$3 AND available_points>=$4 RETURNING available_points`,
      [...scope,k.membership_id,debit])).rows[0]
    if(!account)throw new ActivityOperationsError('原账户余额不符，未执行冲正','TICKET_CORRECTION_BALANCE',409)
    await tx.query('UPDATE mbox.customer_memberships SET points_balance=$4 WHERE tenant_id=$1 AND store_id=$2 AND id=$3',
      [...scope,k.membership_id,account.available_points])
    if(debit>0)await tx.query(`INSERT INTO mbox.loyalty_point_ledger(tenant_id,store_id,membership_id,customer_id,entry_type,points_delta,balance_after,source_type,
      source_id,reason,idempotency_key,created_by_employee_id) VALUES($1,$2,$3,$4,'reverse',$5,$6,'manual',$7,$8,'ticket-correction:'||$7,$9)`,
      [...scope,k.membership_id,k.customer_id,-debit,account.available_points,caseId,reason,employee])
    if(debit>0)await tx.query(`INSERT INTO mbox.loyalty_point_lot_movements(tenant_id,store_id,lot_id,movement_type,points_delta,balance_after,source_type,source_id,idempotency_key)
      VALUES($1,$2,$3,'reverse',$4,$6,'manual',$5,'ticket-correction:'||$5)`,[...scope,k.lot_id,-debit,caseId,retained])
    await tx.query("UPDATE mbox.loyalty_point_lots SET remaining_points=$4,status=$5 WHERE tenant_id=$1 AND store_id=$2 AND id=$3",
      [...scope,k.lot_id,retained,retainLot?(retained?'available':'consumed'):'reversed'])
    if(retainLot)replacement=k.lot_id
    else if(!k.refunded && k.expected_points>0){
      await tx.query('UPDATE mbox.table_tickets SET point_lot_id=NULL WHERE tenant_id=$1 AND store_id=$2 AND id=$3',[...scope,ticketId])
      const count=await creditTableTicketGifts(tx,k.registration_id,k.payment_id,{ticketId,caseId:caseId!})
      if(count!==1)throw new ActivityOperationsError('更正批次未完整入账','TICKET_CORRECTION_INCOMPLETE',409)
      replacement=(await tx.query<{point_lot_id:string}>('SELECT point_lot_id FROM mbox.table_tickets WHERE tenant_id=$1 AND store_id=$2 AND id=$3',[...scope,ticketId])).rows[0]!.point_lot_id
      if (pending.consumption_resolution==='buyer_use') {
        const used=pending.consumed_points
        const debited=(await tx.query<{available_points:number;customer_id:string}>(`UPDATE mbox.loyalty_accounts SET available_points=available_points-$4
          WHERE tenant_id=$1 AND store_id=$2 AND membership_id=$3 AND available_points>=$4 RETURNING available_points,customer_id`,
          [...scope,k.target,used])).rows[0]!
        await tx.query('UPDATE mbox.customer_memberships SET points_balance=$4 WHERE tenant_id=$1 AND store_id=$2 AND id=$3',[...scope,k.target,debited.available_points])
        const left=k.expected_points-used
        await tx.query("UPDATE mbox.loyalty_point_lots SET remaining_points=$4,status=CASE WHEN $4::int=0 THEN 'consumed' ELSE 'available' END WHERE tenant_id=$1 AND store_id=$2 AND id=$3",
          [...scope,replacement,left])
        await tx.query(`INSERT INTO mbox.loyalty_point_lot_movements(tenant_id,store_id,lot_id,movement_type,points_delta,balance_after,source_type,source_id,idempotency_key)
          VALUES($1,$2,$3,'redeem',$4,$5,'manual',$6,'ticket-used:'||$6)`,[...scope,replacement,-used,left,caseId])
        await tx.query(`INSERT INTO mbox.loyalty_point_ledger(tenant_id,store_id,membership_id,customer_id,entry_type,points_delta,balance_after,source_type,source_id,reason,idempotency_key)
          VALUES($1,$2,$3,$4,'redeem',$5,$6,'manual',$7,'购票会员已确认原菜品抵扣','ticket-used:'||$7)`,
          [...scope,k.target,debited.customer_id,-used,debited.available_points,caseId])
      }
    }
    if(replacement && k.pending_refund)await tx.query("UPDATE mbox.loyalty_point_lots SET status='ticket_hold' WHERE id=$1",[replacement])
  } else if(!k.pending_refund)await tx.query("UPDATE mbox.loyalty_point_lots SET status=CASE WHEN remaining_points=0 THEN 'consumed' ELSE 'available' END WHERE tenant_id=$1 AND store_id=$2 AND id=$3",[...scope,k.lot_id])
  const status=action==='approve'?'approved':'rejected'
  await tx.query(`UPDATE mbox.table_ticket_corrections SET status=$4,decided_at=clock_timestamp(),decided_by=$5,replacement_lot_id=$6,decision_reason=$7
    WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,[...scope,caseId,status,employee,replacement,reason])
  return {id:caseId!,status}
}

export async function confirmBuyerUse(tx:ScopedTransaction,id:string,customer:string) {
  const result=await tx.query(`UPDATE mbox.table_ticket_corrections c
    SET buyer_confirmed_at=coalesce(c.buyer_confirmed_at,clock_timestamp()),buyer_customer_id=coalesce(c.buyer_customer_id,$4)
    FROM mbox.customer_memberships m
    WHERE (m.tenant_id,m.store_id,m.id)=(c.tenant_id,c.store_id,c.target_membership_id)
      AND c.tenant_id=$1 AND c.store_id=$2 AND c.id=$3 AND c.status='requested' AND c.consumption_resolution='buyer_use'
      AND mbox.canonical_customer_id($1,$2,m.customer_id)=mbox.canonical_customer_id($1,$2,$4) RETURNING c.id`,
    [tx.scope.tenantId,tx.scope.storeId,id,customer])
  if (!result.rowCount) throw new ActivityOperationsError('请用原购票会员确认本次消费归属','TICKET_BUYER_MISMATCH',409)
  return {id}
}
