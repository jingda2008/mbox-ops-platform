import type {ScopedTransaction} from './transaction-runner.js'
import {StaffAccessRepository} from './staff-access-repository.js'
import {MemberGiftCampaignError} from './member-gift-campaign-policy.js'
import {appendAuditEvent} from './command-executor.js'

const relations=`FROM mbox.refunds r
 JOIN mbox.payments p ON p.tenant_id=r.tenant_id AND p.store_id=r.store_id AND p.id=r.payment_id
 JOIN mbox.orders o ON o.tenant_id=p.tenant_id AND o.store_id=p.store_id AND o.id=p.order_id
 JOIN mbox.checkout_coupon_order_links l ON l.tenant_id=o.tenant_id AND l.store_id=o.store_id AND l.order_id=o.id
 JOIN mbox.checkout_coupon_quote_reservations h ON h.tenant_id=l.tenant_id AND h.store_id=l.store_id AND h.quote_id=l.quote_id
 JOIN mbox.benefit_reservations b ON b.tenant_id=h.tenant_id AND b.store_id=h.store_id AND b.id=h.reservation_id
 JOIN mbox.benefits benefit ON benefit.tenant_id=b.tenant_id AND benefit.store_id=b.store_id AND benefit.id=b.benefit_id
 LEFT JOIN mbox.checkout_coupon_refund_decisions d ON d.tenant_id=r.tenant_id AND d.store_id=r.store_id AND d.refund_id=r.id AND d.reservation_id=b.id`
const uuid=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i
/** Correlated to the already permission-scoped cashier alias `orders`. Only a
 * count is exposed there, not customer identity, reasons, or evidence. */
export const cashierCouponRefundReviewCountSql=`(SELECT count(*)::integer ${relations}
 WHERE r.tenant_id=orders.tenant_id AND r.store_id=orders.store_id AND p.order_id=orders.id
  AND r.status='succeeded' AND b.status IN('reserved','redeemed') AND d.refund_id IS NULL)`
function identifier(value:string){if(!uuid.test(value))throw new MemberGiftCampaignError('退款或券记录编号无效')}
/** Read actual successful refunds as the durable queue source. No callback,
 * money mutation, coupon minting, or background notification is required. */
export class CheckoutCouponRefundReviewRepository{
 constructor(private readonly tx:ScopedTransaction){}
 private get scope(){return[this.tx.scope.tenantId,this.tx.scope.storeId]}
 async list(employeeId:string,state:'pending'|'resolved'='pending',cursor:string|null=null){
  await new StaffAccessRepository(this.tx).assertPermission(employeeId,'loyalty.configuration.view')
  if(state!=='pending'&&state!=='resolved')throw new MemberGiftCampaignError('复核筛选无效')
  let after:string[]|null=null
  if(cursor){after=cursor.split(':');if(after.length!==2)throw new MemberGiftCampaignError('复核分页无效');after.forEach(identifier)}
  const result=await this.tx.query<{refund_id:string;reservation_id:string;order_reference:string;refund_reference:string;refund_amount_minor:string;currency:string;benefit_code:string;quantity:number;status:string;action:string|null;reason:string|null;evidence_reference:string|null;replacement_benefit_id:string|null;replacement_quantity:number|null}>(`
   SELECT r.id AS refund_id,b.id AS reservation_id,o.public_id AS order_reference,r.public_id AS refund_reference,
    r.amount_minor::text AS refund_amount_minor,r.currency,benefit.benefit_code,b.quantity,b.status,d.action,d.reason,d.evidence_reference,d.replacement_benefit_id,d.replacement_quantity
   ${relations} WHERE r.tenant_id=$1 AND r.store_id=$2 AND r.status='succeeded'
    AND (($3='pending' AND d.refund_id IS NULL AND b.status IN('reserved','redeemed')) OR ($3='resolved' AND d.refund_id IS NOT NULL))
    AND ($4::uuid IS NULL OR (r.id,b.id)>($4::uuid,$5::uuid)) ORDER BY r.id,b.id LIMIT 51`,[...this.scope,state,after?.[0]??null,after?.[1]??null])
  const items=result.rows.slice(0,50),last=items.at(-1)
  return{items,nextCursor:result.rows.length>50&&last?`${last.refund_id}:${last.reservation_id}`:null}
 }
 async replacementOptions(employeeId:string,refundId:string,reservationId:string,cursor:string|null=null){
  await new StaffAccessRepository(this.tx).assertPermission(employeeId,'loyalty.policy.publish')
  identifier(refundId);identifier(reservationId);if(cursor)identifier(cursor)
  const source=(await this.tx.query<{customer_id:string;created_at:string;benefit_id:string}>(`SELECT b.customer_id,r.created_at::text,b.benefit_id ${relations} WHERE r.tenant_id=$1 AND r.store_id=$2 AND r.id=$3 AND b.id=$4 AND r.status='succeeded' AND b.status IN('reserved','redeemed')`,[...this.scope,refundId,reservationId])).rows[0]
  if(!source)throw new MemberGiftCampaignError('退款或原权益不可复核')
  const result=await this.tx.query<{id:string;benefit_code:string;quantity_total:number;valid_until:string|null}>(`WITH RECURSIVE family(id) AS(
   SELECT mbox.canonical_customer_id($1,$2,$4) UNION SELECT c.id FROM mbox.customers c JOIN family f ON c.merged_into_customer_id=f.id WHERE c.tenant_id=$1 AND c.store_id=$2)
   SELECT replacement.id,replacement.benefit_code,replacement.quantity_total,replacement.valid_until::text FROM mbox.benefits replacement
   WHERE replacement.tenant_id=$1 AND replacement.store_id=$2 AND replacement.id<>$3
    AND replacement.customer_id IN(SELECT id FROM family)
    AND replacement.created_at>=$5::timestamptz AND replacement.status='issued' AND replacement.quantity_reserved=0 AND replacement.quantity_redeemed=0
    AND replacement.valid_from<=clock_timestamp() AND (replacement.valid_until IS NULL OR replacement.valid_until>clock_timestamp())
    AND NOT EXISTS(SELECT 1 FROM mbox.checkout_coupon_refund_decisions used WHERE used.tenant_id=replacement.tenant_id AND used.store_id=replacement.store_id AND used.replacement_benefit_id=replacement.id)
    AND ($6::uuid IS NULL OR replacement.id>$6) ORDER BY replacement.id LIMIT 51`,[...this.scope,source.benefit_id,source.customer_id,source.created_at,cursor])
  const items=result.rows.slice(0,50);return{items,nextCursor:result.rows.length>50?items.at(-1)!.id:null}
 }
 async decide(input:{employeeId:string;businessDate:string;refundId:string;reservationId:string;action:'no_return'|'external_compensation'|'replacement_coupon';reason:string;evidenceReference:string;replacementBenefitId?:string|null}){
  await new StaffAccessRepository(this.tx).assertPermission(input.employeeId,'loyalty.policy.publish')
  identifier(input.refundId);identifier(input.reservationId)
  if(!['no_return','external_compensation','replacement_coupon'].includes(input.action)||typeof input.reason!=='string'||input.reason.trim().length<2||input.reason.length>500||typeof input.evidenceReference!=='string'||input.evidenceReference.trim().length<2||input.evidenceReference.length>200)throw new MemberGiftCampaignError('须选择权益处理方式并填写原因、规则或补偿凭证')
  if(input.action==='replacement_coupon')identifier(input.replacementBenefitId??'')
  else if(input.replacementBenefitId)throw new MemberGiftCampaignError('非补发处理不能绑定补偿券')
  const lock=(await this.tx.query<{ok:boolean}>('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS ok',[`coupon-refund:${this.scope.join(':')}:${input.refundId}:${input.reservationId}`])).rows[0]
  if(!lock?.ok)throw new MemberGiftCampaignError('此权益正在复核，请刷新核对，不影响营业')
  const existing=(await this.tx.query<{action:string;reason:string;evidence_reference:string;replacement_benefit_id:string|null}>('SELECT action,reason,evidence_reference,replacement_benefit_id FROM mbox.checkout_coupon_refund_decisions WHERE tenant_id=$1 AND store_id=$2 AND refund_id=$3 AND reservation_id=$4',[...this.scope,input.refundId,input.reservationId])).rows[0]
  if(existing){if(existing.action!==input.action||existing.reason!==input.reason.trim()||existing.evidence_reference!==input.evidenceReference.trim()||existing.replacement_benefit_id!==(input.replacementBenefitId??null))throw new MemberGiftCampaignError('已有不同处理结论，不能覆盖历史');return{recorded:true,replayed:true}}
  const current=await this.tx.query<{customer_id:string;benefit_id:string;created_at:string}>(`SELECT b.customer_id,b.benefit_id,r.created_at::text ${relations} WHERE r.tenant_id=$1 AND r.store_id=$2 AND r.id=$3 AND b.id=$4 AND r.status='succeeded' AND b.status IN('reserved','redeemed') FOR SHARE OF r,b`,[...this.scope,input.refundId,input.reservationId])
  if(current.rowCount!==1)throw new MemberGiftCampaignError('退款未成功、券已释放或不属于同一订单，请刷新核对')
  let replacementQuantity:number|null=null
  if(input.action==='replacement_coupon'){
   const source=current.rows[0]!
   const replacement=(await this.tx.query<{quantity_total:number}>(`SELECT quantity_total FROM mbox.benefits WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND status='issued' AND quantity_reserved=0 AND quantity_redeemed=0
     AND id<>$4 AND mbox.canonical_customer_id(tenant_id,store_id,customer_id)=mbox.canonical_customer_id($1,$2,$5)
     AND created_at>=$6::timestamptz AND valid_from<=clock_timestamp() AND (valid_until IS NULL OR valid_until>clock_timestamp()) FOR UPDATE`,[...this.scope,input.replacementBenefitId,source.benefit_id,source.customer_id,source.created_at])).rows[0]
   if(!replacement)throw new MemberGiftCampaignError('补偿券不存在或已经使用，请刷新核对')
   const used=await this.tx.query('SELECT 1 FROM mbox.checkout_coupon_refund_decisions WHERE tenant_id=$1 AND store_id=$2 AND replacement_benefit_id=$3',[...this.scope,input.replacementBenefitId])
   if(used.rowCount)throw new MemberGiftCampaignError('这张补偿券已关联其他复核，不能重复使用同一凭证')
   replacementQuantity=replacement.quantity_total
  }
  await this.tx.query(`INSERT INTO mbox.checkout_coupon_refund_decisions(tenant_id,store_id,refund_id,reservation_id,action,reason,evidence_reference,decided_by_employee_id,replacement_benefit_id,replacement_quantity) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[...this.scope,input.refundId,input.reservationId,input.action,input.reason.trim(),input.evidenceReference.trim(),input.employeeId,input.replacementBenefitId??null,replacementQuantity])
  await appendAuditEvent(this.tx,{actor:{type:'employee',employeeId:input.employeeId},businessDate:input.businessDate,action:'checkout_coupon.refund_reviewed',objectType:'benefit_reservation',objectId:input.reservationId,reason:input.reason.trim(),metadata:{refundId:input.refundId,action:input.action,evidenceReference:input.evidenceReference.trim(),replacementBenefitId:input.replacementBenefitId??null,replacementQuantity,moneyChanged:false,couponReissued:false}})
  return{recorded:true,replayed:false}
 }
}
