import {z} from 'zod'
import type {MemberReportView,MemberReportDetail,MemberReportRow} from '../../src/shared/member-report.js'
import type {ScopedTransaction} from './transaction-runner.js'
import type {ActivityContactProtectionKeyring} from './personal-contact-protection.js'
export const memberReportFilter=z.object({search:z.string().trim().max(64).default(''),joinedFrom:z.iso.date().optional(),joinedTo:z.iso.date().optional(),interest:z.enum(['all','yes','no']).default('all'),card:z.string().trim().max(60).default(''),page:z.coerce.number().int().min(1).max(100000).default(1)}).strict().refine(v=>!v.joinedFrom||!v.joinedTo||v.joinedFrom<=v.joinedTo,'入会日期范围不正确')
export type MemberReportFilter=z.infer<typeof memberReportFilter>
const pageSize=30
// Historical customer identities are mapped once; records are never rewritten.
export const memberReportCtes=`WITH family AS MATERIALIZED (
 SELECT id,mbox.canonical_customer_id(tenant_id,store_id,id) root FROM mbox.customers WHERE tenant_id=$1 AND store_id=$2
), memberships AS (
 SELECT f.root,min(m.joined_at) joined_at,
 (array_agg(m.member_no ORDER BY (m.customer_id=f.root) DESC,m.joined_at DESC,m.id))[1] member_no,
 (array_agg(m.status ORDER BY (m.customer_id=f.root) DESC,m.joined_at DESC,m.id))[1] status
 FROM mbox.customer_memberships m JOIN family f ON f.id=m.customer_id WHERE m.tenant_id=$1 AND m.store_id=$2 GROUP BY f.root
), paid AS MATERIALIZED (
 SELECT p.order_id,sum(p.amount_minor)::bigint paid_minor,min(p.succeeded_at) first_paid_at,max(p.succeeded_at) last_paid_at
 FROM mbox.order_payment_facts p WHERE p.tenant_id=$1 AND p.store_id=$2 AND p.currency='CNY'
 AND p.status IN ('succeeded','partially_refunded','refunded') AND p.provider<>'simulation' GROUP BY p.order_id
), refunded AS (
 SELECT r.order_id,sum(r.amount_minor)::bigint refund_minor,max(r.completed_at) last_refund_at
 FROM mbox.order_refund_facts r JOIN mbox.payments p ON p.tenant_id=r.tenant_id AND p.store_id=r.store_id AND p.id=r.payment_id
 WHERE r.tenant_id=$1 AND r.store_id=$2 AND r.status='succeeded' AND r.currency='CNY' AND p.provider<>'simulation' GROUP BY r.order_id
), purchases AS MATERIALIZED (
 SELECT f.root,o.public_id reference,'order'::text kind,o.business_date::text business_date,
 'table:'||o.table_session_id::text visit_key,paid.paid_minor,coalesce(r.refund_minor,0)::bigint refund_minor,
 paid.first_paid_at,paid.last_paid_at,r.last_refund_at
 FROM mbox.orders o JOIN family f ON f.id=o.created_by_customer_id JOIN paid ON paid.order_id=o.id LEFT JOIN refunded r ON r.order_id=o.id
 WHERE o.tenant_id=$1 AND o.store_id=$2 AND coalesce(o.note,'') !~* '(测试|澈试|验收|test|smoke|probe|模拟)'
 AND NOT EXISTS(SELECT 1 FROM mbox.table_sessions s JOIN mbox.tables t ON t.tenant_id=s.tenant_id AND t.store_id=s.store_id AND t.id=s.table_id WHERE s.id=o.table_session_id AND s.tenant_id=$1 AND s.store_id=$2 AND t.display_name ~* '(测试|验收|test|smoke|probe|模拟)')
 AND NOT EXISTS(SELECT 1 FROM mbox.order_items i WHERE i.tenant_id=$1 AND i.store_id=$2 AND i.order_id=o.id AND (coalesce(i.note,'')||' '||coalesce(i.product_snapshot->>'name','')) ~* '(测试|验收|test|smoke|probe|模拟)')
 UNION ALL
 SELECT f.root,a.public_id,'activity',((min(p.succeeded_at) AT TIME ZONE s.timezone)-(s.business_day_cutoff-time '00:00'))::date::text,
 'activity:'||a.id::text,sum(p.amount_minor)::bigint,sum(coalesce(r.refund_minor,0))::bigint,min(p.succeeded_at),max(p.succeeded_at),max(r.last_refund_at)
 FROM mbox.community_activity_registrations a JOIN family f ON f.id=a.customer_id
 JOIN mbox.community_activities event ON event.tenant_id=a.tenant_id AND event.store_id=a.store_id AND event.id=a.activity_id
 JOIN mbox.payments p ON p.tenant_id=a.tenant_id AND p.store_id=a.store_id AND p.activity_registration_id=a.id AND p.payable_kind='activity_registration'
 JOIN mbox.stores s ON s.tenant_id=a.tenant_id AND s.id=a.store_id
 LEFT JOIN LATERAL (SELECT sum(amount_minor)::bigint refund_minor,max(completed_at) last_refund_at FROM mbox.refunds WHERE tenant_id=$1 AND store_id=$2 AND payment_id=p.id AND status='succeeded' AND currency='CNY') r ON true
 WHERE a.tenant_id=$1 AND a.store_id=$2 AND p.status IN ('succeeded','partially_refunded','refunded') AND p.provider<>'simulation' AND p.currency='CNY'
 AND event.title !~* '(测试|验收|test|smoke|probe|模拟)' GROUP BY f.root,a.id,s.id
), spend AS (
 SELECT root,sum(paid_minor)::bigint paid_minor,sum(refund_minor)::bigint refund_minor,count(*) FILTER(WHERE paid_minor>refund_minor)::int order_count,
 min(first_paid_at) first_paid_at,max(last_paid_at) last_paid_at FROM purchases GROUP BY root
), visits AS (
 SELECT root,count(*)::int consumption_count FROM (SELECT root,visit_key FROM purchases GROUP BY root,visit_key HAVING sum(paid_minor-refund_minor)>0) v GROUP BY root
), card_rows AS (
 SELECT f.root,p.name,p.kind,c.status,c.valid_until,(c.status='active' AND c.valid_from<=now() AND (c.valid_until IS NULL OR c.valid_until>now())) current_card
 FROM mbox.member_cards c JOIN family f ON f.id=c.customer_id JOIN mbox.member_card_projects p ON p.tenant_id=c.tenant_id AND p.store_id=c.store_id AND p.id=c.project_id WHERE c.tenant_id=$1 AND c.store_id=$2
), cards AS (
 SELECT root,bool_or(kind='interest' AND current_card) has_interest,
 jsonb_agg(jsonb_build_object('name',name,'kind',kind,'status',CASE WHEN status='active' AND NOT current_card THEN 'outside_validity' ELSE status END,'validUntil',valid_until) ORDER BY name,valid_until NULLS FIRST) cards FROM card_rows GROUP BY root
), members AS (
 SELECT m.root,m.member_no,m.status,m.joined_at,profile.display_name,coalesce(cards.has_interest,false) has_interest,coalesce(cards.cards,'[]'::jsonb) cards,
 coalesce(spend.paid_minor,0)::text paid_minor,coalesce(spend.refund_minor,0)::text refund_minor,coalesce(spend.order_count,0)::int order_count,
 coalesce(visits.consumption_count,0)::int consumption_count,spend.first_paid_at::text,spend.last_paid_at::text,
 phone.encrypted_value,phone.contact_hash,phone.contact_encryption_key_id,s.timezone,s.business_day_cutoff::text cutoff
 FROM memberships m JOIN mbox.customers c ON c.id=m.root AND c.tenant_id=$1 AND c.store_id=$2 AND c.status<>'deleted' JOIN mbox.stores s ON s.tenant_id=$1 AND s.id=$2
 LEFT JOIN mbox.customer_profiles profile ON profile.tenant_id=$1 AND profile.store_id=$2 AND profile.customer_id=m.root
 LEFT JOIN cards ON cards.root=m.root LEFT JOIN spend ON spend.root=m.root LEFT JOIN visits ON visits.root=m.root
 LEFT JOIN LATERAL (SELECT cv.* FROM mbox.customer_verified_contacts cv JOIN family f ON f.id=cv.customer_id WHERE cv.tenant_id=$1 AND cv.store_id=$2 AND f.root=m.root AND cv.contact_type='phone' AND cv.processing_status='active' AND cv.revoked_at IS NULL ORDER BY cv.verified_at DESC,cv.id LIMIT 1) phone ON true
)`
export async function readMemberReport(tx:ScopedTransaction,filter:MemberReportFilter,protection:ActivityContactProtectionKeyring):Promise<MemberReportView>{
 const phoneSearch=/^\+?[0-9]{8,15}$/.test(filter.search)?protection.protectPhone(filter.search.startsWith('+')?filter.search:/^86[0-9]{11}$/.test(filter.search)?`+${filter.search}`:`+86${filter.search}`).matchHashes:[]
 const args=[tx.scope.tenantId,tx.scope.storeId,filter.search,filter.joinedFrom??null,filter.joinedTo??null,filter.interest,filter.card,phoneSearch]
 const filtered=`, filtered AS (SELECT * FROM members m WHERE ($3='' OR position(lower($3) in lower(m.member_no))>0 OR position(lower($3) in lower(coalesce(m.display_name,'')))>0 OR m.contact_hash=ANY($8::text[]))
 AND ($4::date IS NULL OR m.joined_at >= (($4::date + m.cutoff::time) AT TIME ZONE m.timezone))
 AND ($5::date IS NULL OR m.joined_at < ((($5::date+1) + m.cutoff::time) AT TIME ZONE m.timezone))
 AND ($6='all' OR m.has_interest=($6='yes')) AND ($7='' OR EXISTS(SELECT 1 FROM card_rows cr WHERE cr.root=m.root AND position(lower($7) in lower(cr.name))>0)))`
 const data=await tx.query<{result:Omit<MemberReportView,'items'> & {items:Record<string,unknown>[]}}>(memberReportCtes+filtered+` SELECT jsonb_build_object('generatedAt',now(),'timezone',(SELECT timezone FROM mbox.stores WHERE tenant_id=$1 AND id=$2),'cutoff',(SELECT business_day_cutoff::text FROM mbox.stores WHERE tenant_id=$1 AND id=$2),'totalMembers',(SELECT count(*) FROM members),'matchedMembers',(SELECT count(*) FROM filtered),'items',coalesce((SELECT jsonb_agg(to_jsonb(p)-'encrypted_value') FROM (SELECT *,encode(encrypted_value,'base64') phone_cipher FROM filtered ORDER BY joined_at DESC,root LIMIT 30 OFFSET $9) p),'[]'::jsonb)) result`,[...args,(filter.page-1)*pageSize])
 const result=data.rows[0]!.result
 return {...result,page:filter.page,pageSize,items:result.items.map(row=>{
  let phone:string|null=null,phoneStatus:MemberReportRow['phoneStatus']=row.phone_cipher?'unavailable':'missing'
  if(row.phone_cipher&&protection.revealPhone)try{phone=protection.revealPhone({encryptedValue:Buffer.from(String(row.phone_cipher),'base64'),contactHash:String(row.contact_hash),encryptionKeyId:String(row.contact_encryption_key_id)});phoneStatus='available'}catch{/* No ciphertext or plaintext in errors. */}
  const paidMinor=Number(row.paid_minor),refundMinor=Number(row.refund_minor)
  return {customerId:String(row.root),memberNo:String(row.member_no),name:row.display_name as string|null,status:String(row.status),joinedAt:String(row.joined_at),phone,phoneStatus,gender:null,cards:row.cards as MemberReportRow['cards'],hasInterestCard:row.has_interest===true,paidMinor,refundMinor,netMinor:paidMinor-refundMinor,consumptionCount:Number(row.consumption_count),orderCount:Number(row.order_count),firstPaidAt:row.first_paid_at as string|null,lastPaidAt:row.last_paid_at as string|null}
 })}
}
export async function readMemberReportDetail(tx:ScopedTransaction,customerId:string,page:number):Promise<MemberReportDetail>{
 const result=await tx.query<{result:MemberReportDetail}>(memberReportCtes+` SELECT jsonb_build_object('total',(SELECT count(*) FROM purchases WHERE root=$3 AND EXISTS(SELECT 1 FROM members WHERE root=$3)),
 'items',coalesce((SELECT jsonb_agg(jsonb_build_object('reference',reference,'kind',kind,'businessDate',business_date,'firstPaidAt',first_paid_at,'lastPaidAt',last_paid_at,'lastRefundAt',last_refund_at,'paidMinor',paid_minor,'refundMinor',refund_minor,'netMinor',paid_minor-refund_minor)) FROM (SELECT * FROM purchases WHERE root=$3 AND EXISTS(SELECT 1 FROM members WHERE root=$3) ORDER BY last_paid_at DESC,reference LIMIT 30 OFFSET $4) p),'[]'::jsonb)) result`,[tx.scope.tenantId,tx.scope.storeId,customerId,(page-1)*pageSize])
 return {...result.rows[0]!.result,page,pageSize}
}
