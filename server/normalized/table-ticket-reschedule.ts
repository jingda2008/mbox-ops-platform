import {ActivityOperationsError} from './activity-operations-repository.js'
import {StaffAccessRepository} from './staff-access-repository.js'
import {lockReservationPolicy} from './reservation-policy-lock.js'
import {ReservationRepository} from './reservation-repository.js'
import {readReservationCapacity} from './public-reservation-api.js'
import type {ScopedTransaction} from './transaction-runner.js'

const invalid=(reason:string)=>new ActivityOperationsError(reason,'TICKET_RESCHEDULE_CHANGED',409)

async function lockTicket(tx:ScopedTransaction,id:string){
  await lockReservationPolicy(tx)
  const ticket=(await tx.query<{id:string;area_id:string;price_minor:number;customer_id:string;seats:number;reservation_lock_id:string|null;effective_show:string;valid:boolean}>(`
    SELECT k.id,o.area_id,o.price_minor,r.customer_id,r.reserved_seats/p.quantity seats,k.reservation_lock_id,
      coalesce(m.activity_id,r.activity_id) effective_show,
      (k.refunded_at IS NULL AND r.status IN('confirmed','checked_in') AND NOT EXISTS(SELECT 1 FROM mbox.ticket_seating(k.tenant_id,k.store_id,k.reservation_lock_id))
       AND NOT EXISTS(SELECT 1 FROM mbox.ticket_admission_batches b WHERE b.ticket_id=k.id)
       AND NOT EXISTS(SELECT 1 FROM mbox.table_ticket_refund_requests f WHERE f.ticket_id=k.id AND f.status NOT IN('cancelled','rejected'))
       AND NOT EXISTS(SELECT 1 FROM mbox.reservation_table_locks l JOIN mbox.reservations v ON v.id=l.reservation_id
         WHERE l.id=k.reservation_lock_id AND v.status IN('arrived','seated'))) valid
    FROM mbox.table_tickets k JOIN mbox.table_ticket_purchases p USING(tenant_id,store_id,registration_id)
    JOIN mbox.table_ticket_offers o ON o.id=p.offer_id JOIN mbox.community_activity_registrations r ON r.id=p.registration_id
    LEFT JOIN mbox.ticket_reschedule_offers m ON m.id=k.reschedule_id
    WHERE k.tenant_id=$1 AND k.store_id=$2 AND k.id=$3 FOR UPDATE OF k`,[tx.scope.tenantId,tx.scope.storeId,id])).rows[0]
  if(!ticket)throw invalid('找不到原票')
  return ticket
}

async function destination(tx:ScopedTransaction,offer:string,area:string,table:string){
  return (await tx.query<{id:string;activity_id:string;starts_at:string;ends_at:string;price_minor:number;capacity:number}>(`
    SELECT o.id,o.activity_id,a.starts_at::text,a.ends_at::text,o.price_minor,a.capacity
    FROM mbox.table_ticket_offers o JOIN mbox.community_activities a ON a.id=o.activity_id
    JOIN mbox.tables tab ON tab.area_id=o.area_id AND tab.tenant_id=o.tenant_id AND tab.store_id=o.store_id
    JOIN mbox.areas ar ON ar.id=tab.area_id
    WHERE o.tenant_id=$1 AND o.store_id=$2 AND o.id=$3 AND o.area_id=$4 AND tab.id=$5
      AND tab.status='available' AND ar.status='active' AND o.status='published' AND a.status='published'
      AND a.starts_at>clock_timestamp() AND NOT EXISTS(SELECT 1 FROM mbox.table_ticket_offers newer
        WHERE newer.activity_id=o.activity_id AND newer.area_id=o.area_id AND newer.version>o.version AND newer.status<>'draft')
      AND NOT (SELECT et.requires_named_attendees FROM mbox.table_ticket_event_terms et WHERE et.activity_id=a.id ORDER BY et.version DESC LIMIT 1)
    FOR UPDATE OF a,tab`,[tx.scope.tenantId,tx.scope.storeId,offer,area,table])).rows[0]
}
export async function proposeMove(tx:ScopedTransaction,ticketId:string,offerId:string,table:string,employee:string,reason:string,key:string){
  await new StaffAccessRepository(tx).assertPermission(employee,'community.activity.manage')
  const k=await lockTicket(tx,ticketId)
  const args=[tx.scope.tenantId,tx.scope.storeId]
  const previous=(await tx.query<{id:string;same:boolean}>(`SELECT id,(ticket_id=$4 AND offer_id=$5 AND table_id=$6 AND reason=$7) same
    FROM mbox.ticket_reschedule_offers WHERE tenant_id=$1 AND store_id=$2 AND proposed_by=$3 AND request_key=$8`,[...args,employee,ticketId,offerId,table,reason,key])).rows[0]
  if(previous){if(!previous.same)throw invalid('请核对上次操作');return {id:previous.id}}
  const show=await destination(tx,offerId,k.area_id,table)
  if(!k.valid || !show || show.price_minor!==k.price_minor || k.effective_show===show.activity_id)throw invalid('请选择可承接本票的同价同桌区新场次')
  await tx.query("UPDATE mbox.ticket_reschedule_offers SET status='superseded' WHERE ticket_id=$1 AND status='proposed'",[ticketId])
  return (await tx.query<{id:string}>(`INSERT INTO mbox.ticket_reschedule_offers(tenant_id,store_id,ticket_id,activity_id,offer_id,table_id,starts_at,ends_at,reason,proposed_by,request_key)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,[...args,ticketId,show.activity_id,offerId,table,show.starts_at,show.ends_at,reason,employee,key])).rows[0]!
}

export async function decideMove(tx:ScopedTransaction,id:string,customer:string,accept:boolean){
  const args=[tx.scope.tenantId,tx.scope.storeId]
  const m=(await tx.query<{ticket_id:string;offer_id:string;table_id:string;starts_at:string;ends_at:string;status:string;proposed_by:string}>(`
    SELECT m.ticket_id,m.offer_id,m.table_id,m.starts_at::text,m.ends_at::text,m.status,m.proposed_by
    FROM mbox.ticket_reschedule_offers m JOIN mbox.table_tickets k ON k.id=m.ticket_id
    JOIN mbox.community_activity_registrations r ON r.id=k.registration_id
    WHERE m.tenant_id=$1 AND m.store_id=$2 AND m.id=$3 AND mbox.canonical_customer_id($1,$2,r.customer_id)=mbox.canonical_customer_id($1,$2,$4)`,[...args,id,customer])).rows[0]
  if(!m)throw invalid('请使用原购票会员核对改期安排')
  const k=await lockTicket(tx,m.ticket_id)
  const row=(await tx.query<{status:string}>('SELECT status FROM mbox.ticket_reschedule_offers WHERE id=$1 FOR UPDATE',[id])).rows[0]!
  const status=accept?'accepted':'declined'
  if(row.status===status)return {id,status}
  if(row.status!=='proposed'||!k.valid)throw invalid('原安排或售后已变化，请重新核对')
  if(accept){
    const show=await destination(tx,m.offer_id,k.area_id,m.table_id)
    if(!show || show.starts_at!==m.starts_at || show.ends_at!==m.ends_at || show.price_minor!==k.price_minor)throw invalid('新场次已发生变化，请重新联系门店')
    // Detach only the lock owned by this ticket. The surrounding transaction restores it if any destination check fails.
    if(k.reservation_lock_id){
      const old=await tx.query<{reservation_id:string}>(`UPDATE mbox.reservation_table_locks l SET status='cancelled' FROM mbox.reservations r
        WHERE l.id=$1 AND r.id=l.reservation_id AND r.reservation_snapshot->>'ticketId'=$2 AND r.status='confirmed'
          AND l.status='confirmed' RETURNING l.reservation_id`,[k.reservation_lock_id,k.id])
      if(old.rows[0])await tx.query("UPDATE mbox.reservations SET status='cancelled' WHERE id=$1",[old.rows[0].reservation_id])
    }
    await tx.query('UPDATE mbox.table_tickets SET reschedule_id=$2,reservation_lock_id=NULL WHERE id=$1',[k.id,id])
    const cap=await readReservationCapacity(tx,m.starts_at,m.ends_at)
    const physical=(await tx.query<{remaining:number;guests:string}>(`SELECT mbox.table_ticket_area_remaining($1,$2,$3,$4,$5) remaining,
      mbox.ticket_event_committed($1,$2,$6) guests`,[...args,k.area_id,m.starts_at,m.ends_at,show.activity_id])).rows[0]!
    if(physical.remaining<0 || Number(physical.guests)>show.capacity || Number(cap.committed_guests)>Number(cap.total_capacity))throw invalid('目标场次或桌区余量不足，原安排保留')
    const policy=(await tx.query<{policy_version:number;arrival_grace_minutes:number}>('SELECT policy_version,arrival_grace_minutes FROM mbox.public_reservation_policies WHERE tenant_id=$1 AND store_id=$2',args)).rows[0]!
    const reservation=await new ReservationRepository(tx).create({publicId:'ticket-move-'+id,source:'integration',customerId:k.customer_id,
      customerName:'整桌演出票改期',contactToken:'ticket:'+k.id,guestCount:k.seats,arrivalAt:m.starts_at,expectedEndAt:m.ends_at,ownerEmployeeId:m.proposed_by,
      tableIds:[m.table_id],initialStatus:'confirmed',reservationSnapshot:{ticketId:k.id,rescheduleId:id},reservationPolicyVersion:policy.policy_version,
      arrivalGraceEndsAt:new Date(Date.parse(m.starts_at)+policy.arrival_grace_minutes*60000).toISOString()})
    await tx.query('UPDATE mbox.table_tickets SET reservation_lock_id=$2 WHERE id=$1',[k.id,reservation.tableLocks[0]!.id])
  }
  await tx.query('UPDATE mbox.ticket_reschedule_offers SET status=$2,customer_id=$3,decided_at=clock_timestamp() WHERE id=$1',[id,status,customer])
  return {id,status}
}
