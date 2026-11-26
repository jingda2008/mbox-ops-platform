import {createHash,randomUUID} from 'node:crypto'
import type {ActivityContactProtectionKeyring} from './personal-contact-protection.js'
import {CustomerExperienceRequestError} from './customer-experience-repository.js'
import {PaymentRepository} from './payment-repository.js'
import {lockReservationPolicy} from './reservation-policy-lock.js'
import type {ScopedTransaction} from './transaction-runner.js'
import {readReservationCapacity} from './public-reservation-api.js'

const currentOffers = `
  WITH current_offers AS (
    SELECT DISTINCT ON(activity_id,area_id) * FROM mbox.table_ticket_offers
    WHERE tenant_id=$1 AND store_id=$2 AND status<>'draft'
    ORDER BY activity_id,area_id,version DESC
  )
  SELECT EXISTS(SELECT 1 FROM mbox.store_commerce_policies p JOIN mbox.customer_experience_features f USING(tenant_id,store_id)
      WHERE p.tenant_id=$1 AND p.store_id=$2 AND f.feature_code='community.activity.payment'
      AND f.rollout_state IN('pilot','enabled') AND (f.effective_from IS NULL OR f.effective_from<=statement_timestamp())
      AND (f.effective_until IS NULL OR f.effective_until>statement_timestamp())) AS "acceptsCash",o.id,o.activity_id AS "activityId", a.public_id AS "activityPublicId",o.area_id AS "areaId",
    o.sale_from::text AS "saleFrom",o.sale_until::text AS "saleUntil",
    CASE WHEN o.sale_from>clock_timestamp() THEN 'upcoming' WHEN o.sale_until<=clock_timestamp() THEN 'ended' ELSE 'open' END AS "saleState",
    (SELECT array_agg(d.code ORDER BY d.code) FROM mbox.scoped_ticket_offer_membership frozen
      JOIN mbox.tables d ON (d.tenant_id,d.store_id)=(frozen.tenant_id,frozen.store_id) AND d.id=ANY(frozen.table_ids)
      WHERE (frozen.tenant_id,frozen.store_id,frozen.offer_id)=(o.tenant_id,o.store_id,o.id)) AS "deskCodes",
    o.name, ar.name AS "areaName", a.title, a.cover_url AS "coverUrl", a.activity_details AS "activityDetails",
    c.code AS "categoryCode", c.display_name AS "categoryName", c.sort_order AS "categorySortOrder",
    p.code AS "categoryParentCode", p.display_name AS "categoryParentName", coalesce(p.sort_order,c.sort_order) AS "topCategorySortOrder", a.starts_at::text AS "startsAt",a.ends_at::text AS "endsAt",
    o.recommend_in_community AS "recommendInCommunity",o.price_minor AS "priceMinor",o.gift_points AS "giftPoints", a.assembly_location AS location,
    et.version AS "eventTermsVersion",concat_ws(chr(10),'本票首次验票入场后，不支持因个人原因退票。',et.refund_schedule) AS "refundSchedule",et.organizer,et.seller,et.approval_reference AS "approvalReference",et.performers,et.duration_minutes AS "durationMinutes",et.program_note AS "programNote",et.service_contact AS "serviceContact",a.refund_policy_summary AS "refundSummary",md5(concat_ws(':','first_admission',a.refund_policy_version,et.id::text)) AS "refundVersion",
    a.safety_policy_version AS "safetyVersion",a.safety_acknowledgement_text AS "safetySummary",
    a.capacity,a.payment_deadline_minutes AS "paymentMinutes",
    to_char((mbox.table_ticket_expiry(statement_timestamp())-interval '1 second') AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD') AS "validThroughIfPaidToday",
    mbox.table_ticket_area_remaining(o.tenant_id,o.store_id,o.area_id,a.starts_at,a.ends_at) AS remaining,
    (SELECT max(t.capacity) FROM mbox.tables t WHERE (t.tenant_id,t.store_id,t.area_id)=(o.tenant_id,o.store_id,o.area_id)
      AND t.status='available') AS "seatsPerTable"
  FROM current_offers o JOIN mbox.community_activities a ON (a.tenant_id,a.store_id,a.id)=(o.tenant_id,o.store_id,o.activity_id)
  JOIN mbox.table_ticket_event_terms et ON(et.tenant_id,et.store_id,et.activity_id,et.id)=(o.tenant_id,o.store_id,o.activity_id,o.event_terms_id)
  JOIN mbox.areas ar ON (ar.tenant_id,ar.store_id,ar.id)=(o.tenant_id,o.store_id,o.area_id)
  LEFT JOIN mbox.menu_categories c ON (c.tenant_id,c.store_id,c.code)=(o.tenant_id,o.store_id,o.category_code)
  LEFT JOIN mbox.menu_categories p ON (p.tenant_id,p.store_id,p.code)=(c.tenant_id,c.store_id,c.parent_code)
  WHERE o.status='published'
    AND NOT EXISTS (SELECT 1 FROM mbox.scoped_ticket_offer_membership frozen
      WHERE (frozen.tenant_id,frozen.store_id,frozen.offer_id)=(o.tenant_id,o.store_id,o.id))
    AND NOT (SELECT latest.requires_named_attendees FROM mbox.table_ticket_event_terms latest
    WHERE(latest.tenant_id,latest.store_id,latest.activity_id)=(o.tenant_id,o.store_id,o.activity_id) ORDER BY latest.version DESC LIMIT 1)
    AND ar.status='active' AND a.visibility='public' AND a.status='published'
    AND mbox.menu_category_visible_at(o.tenant_id,o.store_id,o.category_code,statement_timestamp())
    AND a.ends_at>clock_timestamp() AND a.registration_closed_at IS NULL
    AND (o.visible_from IS NULL OR o.visible_from<=clock_timestamp()) AND (o.visible_until IS NULL OR o.visible_until>clock_timestamp())
`
interface Offer extends Record<string,unknown> {
  id:string;activityId:string;activityPublicId:string;areaId:string;name:string;areaName:string;deskCodes:string[]|null;startsAt:string;endsAt:string
  title:string;priceMinor:number;giftPoints:number;capacity:number;paymentMinutes:number;remaining:number
  acceptsCash:boolean;seatsPerTable:number|null;refundSummary:string;refundVersion:string;safetyVersion:string;safetySummary:string;serviceContact:string;eventTermsVersion:number
}
export async function publicTableTickets(tx:ScopedTransaction,recommendedOnly=false) {
  return (await tx.query<Offer>(currentOffers+(recommendedOnly?' AND o.recommend_in_community':'')+' ORDER BY a.starts_at,o.price_minor,o.id',[tx.scope.tenantId,tx.scope.storeId])).rows
}
export async function memberTicketReservations(tx:ScopedTransaction,customer:string){
  return (await tx.query<{id:string;reservationId:string;reference:string;tableName:string;areaId:string;startsAt:string;endsAt:string}>(`
    SELECT l.id,r.id AS "reservationId",r.public_id AS reference,t.display_name AS "tableName",t.area_id AS "areaId",
      lower(l.reserved_during)::text AS "startsAt",upper(l.reserved_during)::text AS "endsAt"
    FROM mbox.reservations r JOIN mbox.reservation_table_locks l ON (l.tenant_id,l.store_id,l.reservation_id)=(r.tenant_id,r.store_id,r.id)
    JOIN mbox.tables t ON(t.tenant_id,t.store_id,t.id)=(l.tenant_id,l.store_id,l.table_id)
    WHERE r.tenant_id=$1 AND r.store_id=$2 AND mbox.canonical_customer_id(r.tenant_id,r.store_id,r.customer_id)=mbox.canonical_customer_id($1,$2,$3)
      AND r.status IN('confirmed','arrived') AND l.status='confirmed' AND upper(l.reserved_during)>clock_timestamp()
      AND r.reservation_snapshot->>'ticketId' IS NULL AND NOT mbox.ticket_original_lock_in_use(l.tenant_id,l.store_id,l.id)
      AND NOT EXISTS(SELECT 1 FROM mbox.reservation_table_locks other WHERE(other.tenant_id,other.store_id,other.reservation_id)=(r.tenant_id,r.store_id,r.id)
        AND other.id<>l.id AND other.status IN('held','confirmed')) ORDER BY lower(l.reserved_during),r.public_id`,[tx.scope.tenantId,tx.scope.storeId,customer])).rows
}
export async function memberTicketProposals(tx:ScopedTransaction,customer:string){
  return (await tx.query(`SELECT DISTINCT a.id,a.offer_id AS "offerId",a.quantity,o.name FROM mbox.table_ticket_assistance a
    JOIN mbox.table_ticket_offers o ON(o.tenant_id,o.store_id,o.id)=(a.tenant_id,a.store_id,a.offer_id)
    JOIN mbox.customer_verified_contacts c ON (a.tenant_id,a.store_id)=(c.tenant_id,c.store_id) AND c.contact_hash=ANY(a.phone_hashes)
    WHERE a.tenant_id=$1 AND a.store_id=$2 AND a.registration_id IS NULL AND a.expires_at>clock_timestamp()
      AND c.processing_status='active' AND c.contact_type='phone' AND c.revoked_at IS NULL AND
      mbox.canonical_customer_id($1,$2,c.customer_id)=mbox.canonical_customer_id($1,$2,$3)`,[tx.scope.tenantId,tx.scope.storeId,customer])).rows
}
export interface TablePurchaseInput {paymentMethod?:'jsapi'|'cash';proposalId?:string;reservationLockId?:string;offerId:string;quantity:number;safetyVersion:string;refundVersion:string}
export async function buyTableTickets(tx:ScopedTransaction,customerId:string,input:TablePurchaseInput,registrationPublicId:string,paymentPublicId:string,key:string,protection:ActivityContactProtectionKeyring) {
  const scope=[tx.scope.tenantId,tx.scope.storeId]
  await lockReservationPolicy(tx)
  await tx.query(`SELECT a.id FROM mbox.table_ticket_offers o JOIN mbox.community_activities a
    ON (a.tenant_id,a.store_id,a.id)=(o.tenant_id,o.store_id,o.activity_id)
    WHERE o.tenant_id=$1 AND o.store_id=$2 AND o.id=$3 FOR UPDATE OF a`,[...scope,input.offerId])
  const offer=(await tx.query<Offer>(currentOffers+' AND o.id=$3 FOR UPDATE OF a',[...scope,input.offerId])).rows[0]
  if(offer && offer.saleState!=='open')throw new CustomerExperienceRequestError(offer.saleState==='upcoming'?'本场还未开售':'本票已停售','TICKET_SALES_WINDOW',409)
  if (!offer || offer.safetyVersion!==input.safetyVersion || offer.refundVersion!==input.refundVersion)
    throw new CustomerExperienceRequestError('票档或条款已更新，请重新核对','TICKET_OFFER_CHANGED',409)
  const identity=(await tx.query<{membership_id:string;customer_id:string;contact_id:string;encrypted_value:Buffer;contact_hash:string;contact_encryption_key_id:string}>(`
    SELECT m.id membership_id,m.customer_id,c.id contact_id,c.encrypted_value,c.contact_hash,c.contact_encryption_key_id FROM mbox.customer_memberships m JOIN mbox.customer_verified_contacts c
      ON (c.tenant_id,c.store_id)=(m.tenant_id,m.store_id) AND mbox.canonical_customer_id(c.tenant_id,c.store_id,c.customer_id)=mbox.canonical_customer_id(m.tenant_id,m.store_id,m.customer_id)
    WHERE m.tenant_id=$1 AND m.store_id=$2 AND mbox.canonical_customer_id(m.tenant_id,m.store_id,m.customer_id)=mbox.canonical_customer_id($1,$2,$3)
      AND m.status='active' AND c.processing_status='active' AND c.contact_type='phone' AND c.revoked_at IS NULL
    FOR SHARE OF m,c`,[...scope,customerId])).rows
  if (identity.length!==1) throw new CustomerExperienceRequestError('请确认会员及本人已授权手机号后继续购票','TICKET_MEMBERSHIP_PHONE_REQUIRED',403)
  const buyer=identity[0]!
  if(input.proposalId){
    const proposal=(await tx.query(`SELECT id FROM mbox.table_ticket_assistance WHERE tenant_id=$1 AND store_id=$2 AND id=$3
      AND offer_id=$4 AND quantity=$5 AND $6::text=ANY(phone_hashes) AND registration_id IS NULL AND expires_at>clock_timestamp() FOR UPDATE`,
      [...scope,input.proposalId,input.offerId,input.quantity,buyer.contact_hash])).rows[0]
    if(!proposal)throw new CustomerExperienceRequestError('请核对代售票对应的本人手机号、桌数和有效期','TICKET_ASSISTANCE_CHANGED',409)
  }
  const cash=input.paymentMethod==='cash'
  if (!offer.acceptsCash) throw new CustomerExperienceRequestError('本场收款尚未启用','ACTIVITY_PAYMENT_AUTHORITY_NOT_CONFIGURED',503)
  if (!cash) {
    const policy=await tx.query('SELECT online_payment_enabled FROM mbox.store_commerce_policies WHERE tenant_id=$1 AND store_id=$2',scope)
    if (!policy.rows[0]?.online_payment_enabled) throw new CustomerExperienceRequestError('本场线上收款尚未启用','ACTIVITY_PAYMENT_AUTHORITY_NOT_CONFIGURED',503)
  }
  const original=input.reservationLockId?(await memberTicketReservations(tx,customerId)).find(r=>r.id===input.reservationLockId
    && r.areaId===offer.areaId && Date.parse(r.startsAt)<=Date.parse(offer.startsAt) && Date.parse(r.endsAt)>=Date.parse(offer.endsAt)):null
  if(input.reservationLockId && !original)throw new CustomerExperienceRequestError('原预约的会员、桌区、时段或占用情况已变化','TICKET_RESERVATION_MISMATCH',409)
  const capacity=await readReservationCapacity(tx,offer.startsAt,offer.endsAt,original?.reservationId??null)
  const committed=(await tx.query<{seats:number}>(`SELECT mbox.ticket_event_committed($1,$2,$3)::int seats`,[...scope,offer.activityId])).rows[0]!.seats
  const seats=input.quantity*(offer.seatsPerTable??0)
  if (!Number.isSafeInteger(input.quantity)||input.quantity<1 || !seats || input.quantity>offer.remaining+(original?1:0) ||
      committed+seats>offer.capacity || seats+Number(capacity.committed_guests)>Number(capacity.total_capacity))
    throw new CustomerExperienceRequestError('该场次或桌区余量不足，请调整桌数','TICKET_CAPACITY_FULL',409)
  const total=offer.priceMinor*input.quantity
  const registered=(await tx.query<{id:string}>(`
    INSERT INTO mbox.community_activity_registrations (tenant_id,store_id,public_id,activity_id,customer_id,membership_id,party_size,
      status,payment_choice,payment_status,fee_amount_minor,amount_due_minor,paid_amount_minor,currency,idempotency_key,
      payment_due_at,seat_hold_expires_at,refund_policy_snapshot,acknowledged_safety_policy_version,acknowledged_refund_policy_version,
      terms_acknowledged_at,terms_acknowledgement_source,requested_payment_choice,requested_payment_method,requested_amount_due_minor,
      service_version,reserved_seats,includes_admission)
    VALUES($1,$2,$3,$4,$5,$6,1,'payment_pending','full','pending',$7,$7,0,'CNY',$8,
      least(clock_timestamp()+make_interval(mins=>$9),$10::timestamptz),least(clock_timestamp()+make_interval(mins=>$9),$10::timestamptz),
      $11::jsonb,$12,$13,clock_timestamp(),'mini_program','full',$15,$7,4,$14,true) RETURNING id`,
    [...scope,registrationPublicId,offer.activityId,buyer.customer_id,buyer.membership_id,total,key,offer.paymentMinutes,offer.endsAt,
      JSON.stringify({personalRefundUntil:'first_admission',policyVersion:offer.refundVersion,summary:offer.refundSummary,schedule:offer.refundSchedule,serviceContact:offer.serviceContact,eventTermsVersion:offer.eventTermsVersion,priceMinor:offer.priceMinor,giftPoints:offer.giftPoints,offerId:offer.id,area:offer.areaName,...(offer.deskCodes?.length?{deskCodes:offer.deskCodes}:{}),startsAt:offer.startsAt,endsAt:offer.endsAt}),offer.safetyVersion,offer.refundVersion,seats,input.paymentMethod??'jsapi'])).rows[0]!
  await tx.query(`INSERT INTO mbox.table_ticket_purchases(tenant_id,store_id,registration_id,offer_id,quantity,membership_id,contact_id,starts_at,ends_at,original_lock_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[...scope,registered.id,offer.id,input.quantity,buyer.membership_id,buyer.contact_id,offer.startsAt,offer.endsAt,original?.id??null])
  if (!protection.revealPhone) throw new CustomerExperienceRequestError('会员联系方式服务暂不可用','TICKET_CONTACT_UNAVAILABLE',503)
  const phone=protection.revealPhone({encryptedValue:buyer.encrypted_value,contactHash:buyer.contact_hash,encryptionKeyId:buyer.contact_encryption_key_id})
  const captured=protection.protect(phone.replace(/^\+86/,''))
  await tx.query(`INSERT INTO mbox.community_activity_registration_contact_versions(tenant_id,store_id,public_id,registration_id,
    registration_cycle,version,status,contact_type,contact_hash,encrypted_contact,encryption_key_id,masked_contact,contact_source,
    created_by_customer_id,idempotency_key,request_sha256) VALUES($1,$2,$3,$4,1,1,'active','phone',$5,$6,$7,$8,'mini_program',$9,$10,$11)`,
    [...scope,'ACV'+randomUUID().replaceAll('-','').toUpperCase(),registered.id,captured.hash,Buffer.from(captured.encryptedBase64,'base64'),
      captured.keyId,captured.masked,buyer.customer_id,key,createHash('sha256').update(registered.id+captured.hash).digest('hex')])
  if(!cash)await new PaymentRepository(tx).createForActivityRegistration({activityRegistrationId:registered.id,publicId:paymentPublicId,
    method:'jsapi',amountMinor:total,currency:'CNY'})
  if(input.proposalId)await tx.query('UPDATE mbox.table_ticket_assistance SET registration_id=$4 WHERE tenant_id=$1 AND store_id=$2 AND id=$3',[...scope,input.proposalId,registered.id])
  return {id:registered.id,registrationPublicId,paymentPublicId:cash?null:paymentPublicId,amountMinor:total,quantity:input.quantity}
}
