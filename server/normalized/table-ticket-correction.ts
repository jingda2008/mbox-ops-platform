import {ActivityOperationsError} from './activity-operations-repository.js'
import {StaffAccessRepository} from './staff-access-repository.js'
import {creditTableTicketGifts} from './table-ticket-gifts.js'
import type {ScopedTransaction} from './transaction-runner.js'

export async function correctTicketGift(tx:ScopedTransaction,ticketId:string,employee:string,reason:string,action:'request'|'approve'|'reject',caseId:string|null,merchantAssumes=false) {
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
  if(!k || (k.pending_refund && !(k.refunded && action==='approve')) || (k.membership_id===k.target && (k.original_points===k.expected_points || k.quantity_corrected)))throw new ActivityOperationsError('仅可把错发批次更正到原购票会员；请核对原票及售后状态','TICKET_CORRECTION_INELIGIBLE',409)
  const sameMember=k.membership_id===k.target
  const overage=sameMember?Math.max(0,k.original_points-k.expected_points):0
  if(action==='request'){
    const used=k.original_points-k.remaining_points
    if(sameMember && used && (!overage || overage>k.remaining_points))
      throw new ActivityOperationsError('数量差错已涉及消费，需核实原单差额及责任','TICKET_USED_CORRECTION_REVIEW',409)
    if(!['available','consumed'].includes(k.status)||k.expired||used && !overage && !merchantAssumes)throw new ActivityOperationsError('已用错户积分须核对原菜款和责任后处理','TICKET_USED_CORRECTION_REVIEW',409)
    if(used){
      if(!sameMember)await access.assertPermission(employee,'community.activity.manage')
      const facts=(await tx.query<{points:string;unsettled:boolean}>(`SELECT coalesce(sum(a.points-a.restored_points) FILTER(WHERE h.status='consumed'),0)::text points,
        coalesce(bool_or(h.status='held' OR (a.restored_points>0 AND a.restored_points<a.points)),false) unsettled
        FROM mbox.checkout_point_lots a JOIN mbox.checkout_point_holds h USING(tenant_id,store_id,quote_id)
        WHERE a.tenant_id=$1 AND a.store_id=$2 AND a.lot_id=$3`,[...scope,k.lot_id])).rows[0]!
      if(facts.unsettled||Number(facts.points)!==used)throw new ActivityOperationsError('已用金额与原消费不符或仍在途，请核实原菜款','TICKET_USED_CORRECTION_REVIEW',409)
    }
    const saved=(await tx.query<{id:string}>(`INSERT INTO mbox.table_ticket_corrections(tenant_id,store_id,ticket_id,original_lot_id,target_membership_id,requested_by,reason,consumption_resolution,consumed_points)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,[...scope,ticketId,k.lot_id,k.target,employee,reason,used && !sameMember?'merchant_assumes':'unused',used])).rows[0]!
    await tx.query("UPDATE mbox.loyalty_point_lots SET status='ticket_hold' WHERE tenant_id=$1 AND store_id=$2 AND id=$3",[...scope,k.lot_id])
    return {id:saved.id,status:'requested'}
  }
  const pending=(await tx.query<{requested_by:string;consumed_points:number}>(`SELECT requested_by,consumed_points FROM mbox.table_ticket_corrections
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
    }
  } else await tx.query("UPDATE mbox.loyalty_point_lots SET status=CASE WHEN remaining_points=0 THEN 'consumed' ELSE 'available' END WHERE tenant_id=$1 AND store_id=$2 AND id=$3",[...scope,k.lot_id])
  const status=action==='approve'?'approved':'rejected'
  await tx.query(`UPDATE mbox.table_ticket_corrections SET status=$4,decided_at=clock_timestamp(),decided_by=$5,replacement_lot_id=$6,decision_reason=$7
    WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,[...scope,caseId,status,employee,replacement,reason])
  return {id:caseId!,status}
}
