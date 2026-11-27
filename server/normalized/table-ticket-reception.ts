import {ticketDiningLines} from './table-ticket-dining.js'
import {publicTableTickets} from './table-ticket-purchase.js'
import {ActivityOperationsError} from './activity-operations-repository.js'
import {ReservationRepository,ReservationConflictError} from './reservation-repository.js'
import {lockReservationPolicy} from './reservation-policy-lock.js'
import type {ScopedTransaction} from './transaction-runner.js'

export async function ticketReception(tx:ScopedTransaction,activityPublicId:string) {
  const scope=[tx.scope.tenantId,tx.scope.storeId,activityPublicId]
  const orders=(await tx.query(`
    SELECT r.public_id AS "orderId",r.status AS "registrationStatus",
      (SELECT v.public_id FROM mbox.community_activity_registration_contact_versions v
       WHERE(v.tenant_id,v.store_id,v.registration_id,v.registration_cycle)=(r.tenant_id,r.store_id,r.id,r.registration_cycle)
         AND v.status='active' ORDER BY v.version DESC LIMIT 1) AS "contactVersionPublicId",k.id,k.ordinal,o.name,pre.public_id AS "originalReservation",prelock.table_id AS "originalTable",task.status AS "contactStatus",owner.display_name AS "contactOwner",
      (SELECT coalesce(sum(b.quantity),0)::int FROM mbox.ticket_admission_batches b WHERE(b.tenant_id,b.store_id,b.ticket_id)=(k.tenant_id,k.store_id,k.id)) AS arrived,c.masked_value AS "maskedPhone",p.quantity,
      mbox.ticket_assignable_desk_ids(k.tenant_id,k.store_id,coalesce(move.offer_id,p.offer_id)) AS "assignableDeskIds",
      coalesce(move.ends_at,p.ends_at)<=statement_timestamp() AS "showEnded",
      EXISTS(SELECT 1 FROM mbox.ticket_seating(k.tenant_id,k.store_id,k.reservation_lock_id) WHERE NOT active) AS "deskClosed",
      coalesce(move.starts_at,p.starts_at)<=statement_timestamp() AND coalesce(move.ends_at,p.ends_at)>statement_timestamp() AND NOT mbox.ticket_lock_active(k.tenant_id,k.store_id,k.reservation_lock_id) AND NOT EXISTS(SELECT 1 FROM mbox.ticket_seating(k.tenant_id,k.store_id,k.reservation_lock_id)) AS "awaitingDuringShow",
      coalesce(move.starts_at,p.starts_at)::text AS "startsAt",coalesce(move.ends_at,p.ends_at)::text AS "endsAt",effective.title AS "effectiveTitle",latest.status AS "moveStatus",o.area_id AS "areaId", tab.id AS "tableId",
      fix.id AS "correctionId",fix.reason AS "correctionReason",fix.consumed_points AS "correctionUsed",fix.consumption_resolution AS resolution, (lot.membership_id<>p.membership_id OR (lot.original_points<>o.gift_points AND NOT EXISTS(
        SELECT 1 FROM mbox.table_ticket_corrections done WHERE(done.tenant_id,done.store_id,done.ticket_id,done.replacement_lot_id)=(k.tenant_id,k.store_id,k.id,lot.id) AND done.status='approved'))) AS "wrongGift",
      lot.original_points AS "issuedPoints",lot.remaining_points AS "remainingPoints" , tab.display_name AS "tableName",o.gift_points AS "giftPoints",f.id AS "refundCase",f.planned_refund_minor AS "plannedRefundMinor",f.auto_review_error AS "autoReviewError",f.closed_without_receipt AS "cashZero",f.status AS "refundStatus",coalesce(b.requires_review,f.source_review_required) AS "needsReview",coalesce(b.consumed_minor,f.consumed_minor)::text AS "consumedMinor",o.price_minor AS "priceMinor",k.refunded_at::text AS "refundedAt"
    FROM mbox.table_tickets k JOIN mbox.table_ticket_purchases p USING(tenant_id,store_id,registration_id)
    JOIN mbox.table_ticket_offers o ON (o.tenant_id,o.store_id,o.id)=(p.tenant_id,p.store_id,p.offer_id)
    JOIN mbox.community_activity_registrations r ON (r.tenant_id,r.store_id,r.id)=(k.tenant_id,k.store_id,k.registration_id)
    JOIN mbox.community_activities a ON (a.tenant_id,a.store_id,a.id)=(r.tenant_id,r.store_id,r.activity_id)
    JOIN mbox.customer_verified_contacts c ON (c.tenant_id,c.store_id,c.id)=(p.tenant_id,p.store_id,p.contact_id)
    LEFT JOIN mbox.ticket_reschedule_offers move ON move.id=k.reschedule_id
    LEFT JOIN mbox.community_activities effective ON effective.id=move.activity_id
    LEFT JOIN LATERAL(SELECT status FROM mbox.ticket_reschedule_offers proposal WHERE proposal.ticket_id=k.id ORDER BY created_at DESC LIMIT 1) latest ON true
    LEFT JOIN mbox.reservation_table_locks prelock ON (prelock.tenant_id,prelock.store_id,prelock.id)=(p.tenant_id,p.store_id,p.original_lock_id) AND k.ordinal=1 AND k.reschedule_id IS NULL AND mbox.ticket_lock_active(k.tenant_id,k.store_id,prelock.id)
    LEFT JOIN mbox.reservations pre ON (pre.tenant_id,pre.store_id,pre.id)=(prelock.tenant_id,prelock.store_id,prelock.reservation_id)
    LEFT JOIN mbox.ticket_reception_tasks task ON(task.tenant_id,task.store_id,task.registration_id)=(k.tenant_id,k.store_id,k.registration_id)
    LEFT JOIN mbox.employees owner ON(owner.tenant_id,owner.store_id,owner.id)=(task.tenant_id,task.store_id,task.owner_employee_id)
    LEFT JOIN mbox.table_ticket_corrections fix ON (fix.tenant_id,fix.store_id,fix.ticket_id)=(k.tenant_id,k.store_id,k.id) AND fix.status='requested'
    LEFT JOIN mbox.loyalty_point_lots lot ON (lot.tenant_id,lot.store_id,lot.id)=(k.tenant_id,k.store_id,k.point_lot_id)
    LEFT JOIN mbox.reservation_table_locks l ON (l.tenant_id,l.store_id,l.id)=(k.tenant_id,k.store_id,k.reservation_lock_id)
    LEFT JOIN mbox.tables tab ON (tab.tenant_id,tab.store_id,tab.id)=(l.tenant_id,l.store_id,mbox.ticket_current_table(l.tenant_id,l.store_id,l.id))
    LEFT JOIN mbox.table_ticket_refund_requests f ON (f.tenant_id,f.store_id,f.ticket_id)=(k.tenant_id,k.store_id,k.id) AND f.status NOT IN('rejected','cancelled')
    LEFT JOIN LATERAL mbox.ticket_refund_basis(f.tenant_id,f.store_id,f.ticket_id) b ON f.status='review' AND f.close_intent IS NULL
    WHERE k.tenant_id=$1 AND k.store_id=$2 AND (a.public_id=$3 OR effective.public_id=$3) ORDER BY k.paid_at DESC,k.registration_id,k.ordinal`,scope)).rows
  const tables=(await tx.query(`SELECT id,display_name AS name,area_id AS "areaId" FROM mbox.tables
    WHERE tenant_id=$1 AND store_id=$2 AND status='available' ORDER BY code`,scope.slice(0,2))).rows
  return {orders,tables,shows:(await publicTableTickets(tx)).map(({id,activityPublicId,title,areaId,priceMinor,startsAt})=>({id,activityPublicId,title,areaId,priceMinor,startsAt}))}
}

export async function assignTicketTable(tx:ScopedTransaction,id:string,tableId:string,employee:string,reservationPublicId:string|null) {
  const scope=[tx.scope.tenantId,tx.scope.storeId]
  await lockReservationPolicy(tx)
  const k=(await tx.query<{assignable_desks:string[]|null;customer_id:string;starts_at:string;ends_at:string;area_id:string;lock_id:string|null;old_lock_id:string|null;reservation_guests:number;previous_table:string|null;original_lock_id:string|null;closed:boolean}>(`
    SELECT mbox.ticket_assignable_desk_ids(k.tenant_id,k.store_id,coalesce(move.offer_id,p.offer_id)) AS assignable_desks,
      CASE WHEN k.ordinal=1 AND k.reschedule_id IS NULL AND mbox.ticket_lock_active(k.tenant_id,k.store_id,p.original_lock_id) THEN p.original_lock_id END AS original_lock_id,r.customer_id,coalesce(move.starts_at,p.starts_at)::text AS starts_at,coalesce(move.ends_at,p.ends_at)::text AS ends_at,o.area_id,CASE WHEN k.reschedule_id IS NULL THEN 1 ELSE r.reserved_seats/p.quantity END reservation_guests,k.reservation_lock_id AS old_lock_id,CASE WHEN mbox.ticket_lock_active(k.tenant_id,k.store_id,k.reservation_lock_id) THEN k.reservation_lock_id END AS lock_id,mbox.ticket_current_table(l.tenant_id,l.store_id,l.id) previous_table,
      (k.refunded_at IS NOT NULL OR EXISTS(SELECT 1 FROM mbox.ticket_seating(k.tenant_id,k.store_id,k.reservation_lock_id) WHERE NOT active) OR r.status NOT IN('confirmed','checked_in') OR coalesce(move.ends_at,p.ends_at)<=clock_timestamp()
        OR EXISTS(SELECT 1 FROM mbox.table_ticket_refund_requests f WHERE (f.tenant_id,f.store_id,f.ticket_id)=(k.tenant_id,k.store_id,k.id) AND f.status NOT IN('rejected','cancelled'))) closed
    FROM mbox.table_tickets k JOIN mbox.table_ticket_purchases p USING(tenant_id,store_id,registration_id)
    JOIN mbox.table_ticket_offers o ON (o.tenant_id,o.store_id,o.id)=(p.tenant_id,p.store_id,p.offer_id)
    JOIN mbox.community_activity_registrations r ON (r.tenant_id,r.store_id,r.id)=(p.tenant_id,p.store_id,p.registration_id)
    LEFT JOIN mbox.reservation_table_locks l ON (l.tenant_id,l.store_id,l.id)=(k.tenant_id,k.store_id,k.reservation_lock_id)
    LEFT JOIN mbox.ticket_reschedule_offers move ON move.id=k.reschedule_id
    WHERE k.tenant_id=$1 AND k.store_id=$2 AND k.id=$3 FOR UPDATE OF k`,[...scope,id])).rows[0]
  if(!k||k.closed) throw new ActivityOperationsError('当前票不能排桌','TICKET_NOT_ASSIGNABLE',409)
  if(k.lock_id && k.previous_table===tableId)return {id,tableId}
  if(k.lock_id)throw new ActivityOperationsError('原票已经分配桌号，请核对原安排','TICKET_ALREADY_ASSIGNED',409)
  if(k.assignable_desks && !k.assignable_desks.includes(tableId.toLowerCase()))
    throw new ActivityOperationsError('请选择本票档可排的桌号','TICKET_TABLE_OUTSIDE_OFFER',409)
  const physical=(await tx.query(`SELECT id FROM mbox.tables t WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND area_id=$4
    AND status='available' AND NOT EXISTS(SELECT 1 FROM mbox.table_sessions s
      WHERE (s.tenant_id,s.store_id,s.table_id)=(t.tenant_id,t.store_id,t.id) AND s.status IN('open','closing')
      AND $5::timestamptz<=clock_timestamp()) FOR UPDATE`,[...scope,tableId,k.area_id,k.starts_at])).rows[0]
  if(!physical)throw new ActivityOperationsError('桌号与原票桌区或实际桌况不符','TICKET_TABLE_UNAVAILABLE',409)
  let lockId:string
  if(reservationPublicId){
    const owned=(await tx.query<{id:string}>(`SELECT l.id FROM mbox.reservations r JOIN mbox.reservation_table_locks l
      ON (l.tenant_id,l.store_id,l.reservation_id)=(r.tenant_id,r.store_id,r.id)
      WHERE r.tenant_id=$1 AND r.store_id=$2 AND r.public_id=$3 AND r.status IN('confirmed','arrived') AND l.table_id=$4
        AND l.status='confirmed' AND mbox.canonical_customer_id(r.tenant_id,r.store_id,r.customer_id)=mbox.canonical_customer_id($1,$2,$5)
        AND l.reserved_during @> tstzrange($6,$7,'[)') AND NOT EXISTS(SELECT 1 FROM mbox.table_tickets other
          WHERE other.tenant_id=$1 AND other.store_id=$2 AND other.reservation_lock_id=l.id) FOR UPDATE OF r,l`,
      [...scope,reservationPublicId,tableId,k.customer_id,k.starts_at,k.ends_at])).rows[0]
    if(!owned)throw new ActivityOperationsError('原预约、本人身份、桌型或完整时段不匹配','TICKET_RESERVATION_MISMATCH',409)
    if(k.original_lock_id && k.original_lock_id!==owned.id)throw new ActivityOperationsError('请沿用购票时关联的预约','TICKET_RESERVATION_MISMATCH',409)
    lockId=owned.id
  } else {
    if(k.original_lock_id)throw new ActivityOperationsError('请核对购票时已有的原预约','TICKET_RESERVATION_REQUIRED',409)
    const policy=(await tx.query<{policy_version:number;arrival_grace_minutes:number}>('SELECT policy_version,arrival_grace_minutes FROM mbox.public_reservation_policies WHERE tenant_id=$1 AND store_id=$2',scope)).rows[0]
    if(!policy)throw new ActivityOperationsError('门店尚未设置预约接待时段','TICKET_RESERVATION_POLICY_MISSING',409)
    try {
      const reservation=await new ReservationRepository(tx).create({publicId:k.old_lock_id?'ticket-next-'+k.old_lock_id:'ticket-'+id,source:'integration',customerId:k.customer_id,
        customerName:'整桌演出票',contactToken:'ticket:'+id,guestCount:k.reservation_guests,arrivalAt:k.starts_at,expectedEndAt:k.ends_at,ownerEmployeeId:employee,
        tableIds:[tableId],initialStatus:'confirmed',reservationSnapshot:{ticketId:id},reservationPolicyVersion:policy.policy_version,
        arrivalGraceEndsAt:new Date(Date.parse(k.starts_at)+policy.arrival_grace_minutes*60000).toISOString()})
      lockId=reservation.tableLocks[0]!.id
    }catch(e){if(e instanceof ReservationConflictError)throw new ActivityOperationsError('桌号已被预约，请刷新后选择','TICKET_TABLE_CONFLICT',409);throw e}
  }
  await tx.query('UPDATE mbox.table_tickets SET reservation_lock_id=$4 WHERE tenant_id=$1 AND store_id=$2 AND id=$3',[...scope,id,lockId])
  return {id,tableId}
}

export async function updateTicketContact(tx:ScopedTransaction,orderNo:string,status:string,employee:string){
  const result=await tx.query<{registration_id:string}>(`UPDATE mbox.ticket_reception_tasks t SET status=$4,
    owner_employee_id=CASE WHEN $4='waiting' THEN NULL ELSE $5::uuid END,updated_at=clock_timestamp()
    FROM mbox.community_activity_registrations r WHERE (t.tenant_id,t.store_id,t.registration_id)=(r.tenant_id,r.store_id,r.id)
    AND t.tenant_id=$1 AND t.store_id=$2 AND r.public_id=$3 AND (t.owner_employee_id IS NULL OR t.owner_employee_id=$5)
    AND EXISTS(SELECT 1 FROM mbox.table_tickets k WHERE(k.tenant_id,k.store_id,k.registration_id)=(r.tenant_id,r.store_id,r.id) AND k.refunded_at IS NULL)
    RETURNING t.registration_id`,[tx.scope.tenantId,tx.scope.storeId,orderNo,status,employee])
  if(!result.rowCount)throw new ActivityOperationsError('请核对原订单或联系当前经办人交班','TICKET_RECEPTION_OWNER',409)
  return {id:result.rows[0]!.registration_id,status}
}

export async function admitTicketBatch(tx:ScopedTransaction,ticketId:string,code:string,quantity:number,employee:string,key:string){
  await lockReservationPolicy(tx)
  const args=[tx.scope.tenantId,tx.scope.storeId,ticketId]
  const k=(await tx.query<{activity_id:string;capacity:number}>(`SELECT a.id activity_id,a.capacity FROM mbox.table_tickets k
    JOIN mbox.table_ticket_purchases p USING(tenant_id,store_id,registration_id)
    JOIN mbox.community_activity_registrations r ON (r.tenant_id,r.store_id,r.id)=(p.tenant_id,p.store_id,p.registration_id)
    LEFT JOIN mbox.ticket_reschedule_offers move ON move.id=k.reschedule_id
    JOIN mbox.community_activities a ON (a.tenant_id,a.store_id,a.id)=(r.tenant_id,r.store_id,coalesce(move.activity_id,r.activity_id))
    JOIN mbox.reservation_table_locks l ON (l.tenant_id,l.store_id,l.id)=(k.tenant_id,k.store_id,k.reservation_lock_id)
    WHERE k.tenant_id=$1 AND k.store_id=$2 AND k.id=$3 AND k.door_code=$4 AND k.refunded_at IS NULL AND a.status IN ('published','completed')
      AND coalesce(move.starts_at,p.starts_at)<=clock_timestamp() AND coalesce(move.ends_at,p.ends_at)>clock_timestamp() AND NOT EXISTS(SELECT 1 FROM mbox.ticket_seating(k.tenant_id,k.store_id,k.reservation_lock_id) WHERE NOT active)
      AND (l.status='confirmed' OR (l.status='released' AND mbox.ticket_lock_active(l.tenant_id,l.store_id,l.id)))
      AND NOT EXISTS(SELECT 1 FROM mbox.table_ticket_refund_requests f WHERE(f.tenant_id,f.store_id,f.ticket_id)=(k.tenant_id,k.store_id,k.id) AND f.status NOT IN('cancelled','rejected'))
    FOR UPDATE OF a,k`,[...args,code])).rows[0]
  if(!k)throw new ActivityOperationsError('请核对客人出示的本场票码、已排桌号及售后状态','TICKET_DOOR_INVALID',409)
  // Re-read after taking the ticket lock if a refund transaction was ahead of us.
  const refund=await tx.query(`SELECT 1 FROM mbox.table_ticket_refund_requests
    WHERE tenant_id=$1 AND store_id=$2 AND ticket_id=$3 AND status NOT IN('cancelled','rejected')`,args)
  if(refund.rowCount)throw new ActivityOperationsError('该票正在办理售后，请核对原案','TICKET_DOOR_INVALID',409)
  const previous=(await tx.query<{quantity:number}>('SELECT quantity FROM mbox.ticket_admission_batches WHERE tenant_id=$1 AND store_id=$2 AND ticket_id=$3 AND request_key=$4',[...args,key])).rows[0]
  if(previous)return {id:ticketId,quantity:previous.quantity}
  const counts=(await tx.query<{total:number}>(`SELECT (
    (SELECT coalesce(sum(b.quantity),0) FROM mbox.ticket_admission_batches b JOIN mbox.table_tickets k ON k.id=b.ticket_id
      JOIN mbox.community_activity_registrations r ON r.id=k.registration_id LEFT JOIN mbox.ticket_reschedule_offers m ON m.id=k.reschedule_id
      WHERE k.tenant_id=$1 AND k.store_id=$2 AND coalesce(m.activity_id,r.activity_id)=$3)
    + (SELECT coalesce(sum(CASE WHEN r.service_version=3 THEN (SELECT coalesce(sum(b.quantity),0) FROM mbox.activity_admission_batches b WHERE(b.tenant_id,b.store_id,b.registration_id)=(r.tenant_id,r.store_id,r.id))
      WHEN r.status='checked_in' THEN r.party_size ELSE 0 END),0) FROM mbox.community_activity_registrations r WHERE r.tenant_id=$1 AND r.store_id=$2 AND r.activity_id=$3 AND r.service_version IS DISTINCT FROM 4))::int total`,[args[0],args[1],k.activity_id])).rows[0]!
  if(counts.total+quantity>k.capacity)throw new ActivityOperationsError('本批超过该场剩余核准人数','TICKET_DOOR_CAPACITY',409)
  await tx.query('INSERT INTO mbox.ticket_admission_batches(tenant_id,store_id,ticket_id,request_key,quantity,employee_id) VALUES($1,$2,$3,$4,$5,$6)',[...args,key,quantity,employee])
  return {id:ticketId,quantity}
}

// Each event amount belongs to this ticket. The shared purchase receipt appears
// once per ticket with only its allocated face price, including multi-table orders.
export async function ticketStatement(tx:ScopedTransaction,id:string){
  const scope=[tx.scope.tenantId,tx.scope.storeId,id]
  const ticket=(await tx.query(`SELECT k.id,k.ordinal,o.price_minor AS "priceMinor",o.gift_points AS "giftPoints",
    pay.public_id AS receipt,k.paid_at AS "paidAt",k.refunded_at AS "closedAt",r.public_id AS "orderNo"
    FROM mbox.table_tickets k JOIN mbox.table_ticket_purchases p USING(tenant_id,store_id,registration_id)
    JOIN mbox.table_ticket_offers o ON (o.tenant_id,o.store_id,o.id)=(p.tenant_id,p.store_id,p.offer_id)
    JOIN mbox.payments pay ON (pay.tenant_id,pay.store_id,pay.id)=(k.tenant_id,k.store_id,k.payment_id)
    JOIN mbox.community_activity_registrations r ON (r.tenant_id,r.store_id,r.id)=(k.tenant_id,k.store_id,k.registration_id)
    WHERE k.tenant_id=$1 AND k.store_id=$2 AND k.id=$3`,scope)).rows[0]
  if(!ticket)throw new ActivityOperationsError('未找到本店原票','TICKET_NOT_FOUND',404)
  const points=(await tx.query(`SELECT l.id AS lot,m.movement_type AS kind,m.points_delta AS delta,m.balance_after AS remaining,m.occurred_at AS at
    FROM mbox.loyalty_point_lots l JOIN mbox.loyalty_point_lot_movements m ON(m.tenant_id,m.store_id,m.lot_id)=(l.tenant_id,l.store_id,l.id)
    WHERE l.tenant_id=$1 AND l.store_id=$2 AND l.source_type='table_ticket' AND l.source_id=$3::text ORDER BY m.occurred_at,m.id`,scope)).rows
  const refunds=(await tx.query<{id:string;status:string;closeReason:string|null;zeroCash:boolean;merchantAssumes:boolean;consumedMinor:string;receipt:string|null;cashStatus:string|null;cashMinor:string|null;paidAt:Date|null}>(`SELECT f.id,f.status,f.close_reason AS "closeReason",f.closed_without_receipt AS "zeroCash",
    f.merchant_assumes_dining AS "merchantAssumes",f.consumed_minor AS "consumedMinor",r.public_id AS receipt,r.status AS "cashStatus",r.amount_minor AS "cashMinor",r.completed_at AS "paidAt"
    FROM mbox.table_ticket_refund_requests f LEFT JOIN mbox.refunds r ON(r.tenant_id,r.store_id,r.id)=(f.tenant_id,f.store_id,f.refund_id)
    WHERE (f.tenant_id,f.store_id,f.ticket_id)=($1,$2,$3) ORDER BY f.created_at,f.id`,scope)).rows
  const dining=(await tx.query(`SELECT o.public_id AS "orderNo",c.amount_minor AS "amountMinor",c.merchant_minor AS "merchantMinor",c.reason,c.consented_at AS "confirmedAt",p.public_id AS receipt,p.status AS "paymentStatus",
    p.succeeded_at AS "paidAt",r.public_id AS "returnNo",r.status AS "returnStatus",r.completed_at AS "returnedAt",
    (SELECT coalesce(jsonb_agg(jsonb_build_object('receipt',back.public_id,'amountMinor',back.amount_minor,'status',back.status)
        ORDER BY back.created_at,back.id),'[]'::jsonb) FROM mbox.refunds back
       WHERE (back.tenant_id,back.store_id,back.payment_id)=(c.tenant_id,c.store_id,c.payment_id)) AS returns
    FROM mbox.table_ticket_refund_requests f JOIN mbox.ticket_dining_collections c ON(c.tenant_id,c.store_id,c.case_id)=(f.tenant_id,f.store_id,f.id)
    JOIN mbox.orders o ON(o.tenant_id,o.store_id,o.id)=(c.tenant_id,c.store_id,c.order_id)
    LEFT JOIN mbox.payments p ON(p.tenant_id,p.store_id,p.id)=(c.tenant_id,c.store_id,c.payment_id)
    LEFT JOIN mbox.refunds r ON(r.tenant_id,r.store_id,r.id)=(c.tenant_id,c.store_id,c.return_refund_id)
    WHERE (f.tenant_id,f.store_id,f.ticket_id)=($1,$2,$3) AND c.superseded_at IS NULL ORDER BY c.created_at,c.id`,scope)).rows
  const originalDishes=(await ticketDiningLines(tx,id,'ticket')).filter(line=>line.usedMinor>0)
  return {ticket,points,refunds,dining,originalDishes}
}

export async function ticketFinanceDay(tx:ScopedTransaction,day:string|null){
  const summary=(await tx.query(`
    WITH store_day AS NOT MATERIALIZED (SELECT s.id,s.tenant_id,s.timezone,s.business_day_cutoff,
      coalesce($3::date,((clock_timestamp() AT TIME ZONE s.timezone)-s.business_day_cutoff)::date) AS day
      FROM mbox.stores s WHERE s.tenant_id=$1 AND s.id=$2),
    times AS (SELECT day,(day+business_day_cutoff) AT TIME ZONE timezone AS start,
      ((day+1)+business_day_cutoff) AT TIME ZONE timezone AS finish FROM store_day),
    dining_orders AS (
      SELECT DISTINCT l.order_id FROM mbox.checkout_point_portion_sources s
      JOIN mbox.loyalty_point_lots lot ON (lot.tenant_id,lot.store_id,lot.id)=(s.tenant_id,s.store_id,s.lot_id) AND lot.source_type='table_ticket'
      JOIN mbox.checkout_coupon_order_links l ON (l.tenant_id,l.store_id,l.quote_id)=(s.tenant_id,s.store_id,s.quote_id)
      WHERE s.tenant_id=$1 AND s.store_id=$2
    ), flows AS (
      SELECT 'ticketCash' AS kind,p.amount_minor AS amount,p.succeeded_at AS at FROM mbox.payments p
        JOIN mbox.table_ticket_purchases buy ON (buy.tenant_id,buy.store_id,buy.registration_id)=(p.tenant_id,p.store_id,p.activity_registration_id)
        WHERE p.tenant_id=$1 AND p.store_id=$2 AND p.status IN('succeeded','partially_refunded','refunded')
      UNION ALL SELECT 'ticketRefund',f.amount_minor,f.completed_at FROM mbox.refunds f JOIN mbox.payments p
        ON(p.tenant_id,p.store_id,p.id)=(f.tenant_id,f.store_id,f.payment_id) JOIN mbox.table_ticket_purchases buy
        ON(buy.tenant_id,buy.store_id,buy.registration_id)=(p.tenant_id,p.store_id,p.activity_registration_id)
        WHERE f.tenant_id=$1 AND f.store_id=$2 AND f.status='succeeded'
      UNION ALL SELECT CASE WHEN p.prepaid_table_session_id IS NOT NULL THEN 'originalPrepay' ELSE 'originalDiningCash' END,f.amount_minor,
        CASE WHEN p.prepaid_table_session_id IS NOT NULL THEN a.created_at ELSE f.succeeded_at END
        FROM dining_orders d JOIN mbox.order_payment_facts f ON f.order_id=d.order_id JOIN mbox.payments p ON p.id=f.id
        LEFT JOIN mbox.table_prepayment_allocations a ON (a.order_id,a.payment_id)=(d.order_id,f.id)
        WHERE f.tenant_id=$1 AND f.store_id=$2 AND f.status IN('succeeded','partially_refunded','refunded') AND NOT(p.provider_snapshot ? 'ticketDiningCollection')
      UNION ALL SELECT 'originalDiningRefund',f.amount_minor,f.completed_at FROM dining_orders d
        JOIN mbox.order_refund_facts f ON f.order_id=d.order_id JOIN mbox.payments p ON p.id=f.payment_id
        WHERE f.tenant_id=$1 AND f.store_id=$2 AND f.status='succeeded' AND NOT(p.provider_snapshot ? 'ticketDiningCollection')
      UNION ALL SELECT 'diningCash',p.amount_minor,p.succeeded_at FROM mbox.ticket_dining_collections c
        JOIN mbox.payments p ON(p.tenant_id,p.store_id,p.id)=(c.tenant_id,c.store_id,c.payment_id)
        WHERE c.tenant_id=$1 AND c.store_id=$2 AND p.status IN('succeeded','partially_refunded','refunded')
      UNION ALL SELECT 'diningRefund',r.amount_minor,r.completed_at FROM mbox.ticket_dining_collections c
        JOIN mbox.refunds r ON(r.tenant_id,r.store_id,r.payment_id)=(c.tenant_id,c.store_id,c.payment_id)
        WHERE c.tenant_id=$1 AND c.store_id=$2 AND r.status='succeeded'
      UNION ALL SELECT CASE WHEN e.entry_type='earn' THEN 'diningRewardEarn' ELSE 'diningRewardReverse' END,
        e.points_delta,e.occurred_at FROM mbox.ticket_dining_collections c JOIN mbox.loyalty_point_ledger e
        ON (e.tenant_id,e.store_id,e.order_id,e.payment_id)=(c.tenant_id,c.store_id,c.order_id,c.payment_id)
        WHERE c.tenant_id=$1 AND c.store_id=$2 AND ((e.entry_type='earn' AND e.source_type='order')
          OR (e.entry_type='reverse' AND e.refund_id IS NOT NULL))
      UNION ALL SELECT 'merchantDining',cost.amount,k.refunded_at
        FROM mbox.table_ticket_refund_requests f JOIN mbox.table_tickets k
          ON (k.tenant_id,k.store_id,k.id)=(f.tenant_id,f.store_id,f.ticket_id)
        CROSS JOIN LATERAL (SELECT CASE WHEN f.merchant_assumes_dining THEN f.consumed_minor ELSE
          (SELECT sum(c.merchant_minor) FROM mbox.ticket_dining_collections c WHERE (c.tenant_id,c.store_id,c.case_id)=(f.tenant_id,f.store_id,f.id)
           AND c.consented_at IS NOT NULL) END AS amount) cost
        WHERE f.tenant_id=$1 AND f.store_id=$2 AND f.status='refunded' AND cost.amount>0
      UNION ALL SELECT 'points_'||m.movement_type,m.points_delta,m.occurred_at FROM mbox.loyalty_point_lots l
        JOIN mbox.loyalty_point_lot_movements m ON(m.tenant_id,m.store_id,m.lot_id)=(l.tenant_id,l.store_id,l.id)
        WHERE l.tenant_id=$1 AND l.store_id=$2 AND l.source_type='table_ticket'
    ), amounts AS(SELECT kind,sum(amount)::text AS amount FROM times JOIN flows ON flows.at>=times.start AND flows.at<times.finish GROUP BY kind)
    SELECT day::text,coalesce((SELECT jsonb_object_agg(kind,amount) FROM amounts),'{}'::jsonb) amounts FROM times`,[tx.scope.tenantId,tx.scope.storeId,day])).rows[0]
  return summary
}
