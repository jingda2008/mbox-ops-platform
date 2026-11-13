import { releaseUnusedChannelDiscounts } from './channel-discount-release.js'
import { createHash, randomUUID } from 'node:crypto'
import { channelRuleSchema, type ChannelRule } from '../../src/shared/channel-distribution.js'
import { ChannelDistributionRepository } from './channel-distribution-repository.js'
import { allocateChannelAmount, channelDiscountTarget } from './channel-distribution-policy.js'
import { OrderRepository, type SubmitOrderLineInput } from './order-repository.js'
import { PricingAuthorizationDeniedError, type PricingAuthorityContext, type PricingAuthorityDecision } from './pricing-authorization-policy.js'
import { pricingLineFingerprint, verifyPricingLineAllocations, type PricingLineAllocation } from './pricing-line-allocation.js'
import { assertEmployeeTableSessionAccess } from './employee-table-access.js'
import { lockBoundGuestCheckoutPosition } from './guest-table-authority.js'
import type { ScopedTransaction } from './transaction-runner.js'

interface PriceContext {
 tableSessionId:string; channel:'guest_qr'|'staff_assisted'|'cashier'; actorRef:string; customerId?:string|null; cart?:{id:string;generation:number;version:number}; lines:readonly SubmitOrderLineInput[]
}
interface Snapshot {
 visitId:string; subtotalMinor:number; discountMinor:number; payableMinor:number; currency:string
 allocations:PricingLineAllocation[]; coupons:{activationId:string;amountMinor:number;usedBeforeMinor:number;eligibleMinor:number}[]
 basisFingerprint:string; giftClaimId?:string; cart?:{id:string;generation:number;version:number}
}
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v,(_key,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.keys(value).sort().map(k=>[k,value[k]])):value)).digest('hex')
const money=(v:string|number)=>{const n=Number(v);if(!Number.isSafeInteger(n)||n<0)throw new PricingAuthorizationDeniedError('渠道金额依据无效');return n}
const deny=(message:string):never=>{throw new PricingAuthorizationDeniedError(message)}

/** Quote preparation and final authorization use the same calculation. A quote
 * does not reserve money; final consumption serializes the continuous visit and
 * repeats identity, product prices, outstanding applications and returned items. */
export class ChannelPricingRepository {
 constructor(private readonly tx:ScopedTransaction){}
 private get scope(){return[this.tx.scope.tenantId,this.tx.scope.storeId]}
 async guard(input:PriceContext){
  await new ChannelDistributionRepository(this.tx).lockIdentity()
  if(input.channel==='staff_assisted'||input.channel==='cashier'){
   const employee=/^employee:([0-9a-f-]{36})$/i.exec(input.actorRef)?.[1]
   if(!employee)deny('请使用员工本人账号确认渠道价格')
   await assertEmployeeTableSessionAccess(this.tx,{employeeId:employee!,tableSessionId:input.tableSessionId,requiredPermissionCodes:input.channel==='cashier'?['order.create','channel.activate']:['order.create'],lockTableSession:true})
  }else if(!input.customerId||!await lockBoundGuestCheckoutPosition(this.tx,{tableSessionId:input.tableSessionId,customerId:input.customerId,actorRef:input.actorRef}))deny('请重新扫描当前桌码后确认渠道价格')
 }
 async visitBudget(visitId:string){
  const row=(await this.tx.query<{stacking_allowed:boolean|null;cap:string|null;used:string}>(`SELECT v.stacking_allowed,v.discount_cap_minor::text AS cap,
   (SELECT COALESCE(sum(a.applied_discount_minor),0)::text FROM mbox.channel_activations a WHERE (a.tenant_id,a.store_id,a.visit_id)=(v.tenant_id,v.store_id,v.id)) AS used
   FROM mbox.channel_visits v WHERE v.tenant_id=$1 AND v.store_id=$2 AND v.id=$3 FOR UPDATE OF v`,[...this.scope,visitId])).rows[0]
  if(!row)deny('当前客组不存在')
  const cap=row!.cap===null?null:money(row!.cap),used=money(row!.used)
  return{allowStacking:row!.stacking_allowed===true,cap,used,remaining:cap===null?Number.MAX_SAFE_INTEGER:Math.max(0,cap-used)}
 }
 async prepare(input:PriceContext){
  await this.guard(input)
  const snapshot=await this.calculate(input)
  if(snapshot.discountMinor<=0)deny('本次加单尚无可抵扣的渠道优惠，请核对门槛或选择原价')
  const row=(await this.tx.query<{id:string;expiresAt:string}>(`INSERT INTO mbox.channel_price_quotes(tenant_id,store_id,visit_id,table_session_id,actor_ref,customer_id,channel,snapshot,fingerprint,expires_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,clock_timestamp()+interval '2 minutes') RETURNING id,expires_at::text AS "expiresAt"`,[...this.scope,snapshot.visitId,input.tableSessionId,input.actorRef,input.customerId??null,input.channel,JSON.stringify(snapshot),hash(snapshot)])).rows[0]!
  return{...row,...snapshot,orderAuthorization:false as const}
 }
 async calculate(input:PriceContext):Promise<Snapshot>{
  const visit=(await this.tx.query<{id:string}>(`SELECT v.id FROM mbox.channel_visit_tables t JOIN mbox.channel_visits v ON (v.tenant_id,v.store_id,v.id)=(t.tenant_id,t.store_id,t.visit_id)
   WHERE t.tenant_id=$1 AND t.store_id=$2 AND t.table_session_id=$3 AND t.detached_at IS NULL AND v.closed_at IS NULL FOR UPDATE OF v`,[...this.scope,input.tableSessionId])).rows[0]
  if(!visit)deny('当前桌没有有效渠道优惠，请先核验绑定')
  await this.releaseUnusedCancelled(visit!.id)
  const active=(await this.tx.query<{id:string;rule:ChannelRule;applied:string}>(`SELECT a.id,b.rule_snapshot AS rule,a.applied_discount_minor::text AS applied
   FROM mbox.channel_activations a JOIN mbox.channel_claims q ON (q.tenant_id,q.store_id,q.id)=(a.tenant_id,a.store_id,a.claim_id)
   JOIN mbox.channel_batches b ON (b.tenant_id,b.store_id,b.id)=(q.tenant_id,q.store_id,q.batch_id)
   WHERE a.tenant_id=$1 AND a.store_id=$2 AND a.visit_id=$3 AND a.status IN('active','fulfilled') AND NOT q.voided
   AND EXISTS(SELECT 1 FROM mbox.table_session_customer_participations p JOIN mbox.channel_visit_tables t
    ON (t.tenant_id,t.store_id,t.table_session_id)=(p.tenant_id,p.store_id,p.table_session_id)
    WHERE p.tenant_id=q.tenant_id AND p.store_id=q.store_id AND t.visit_id=a.visit_id AND t.detached_at IS NULL AND p.left_at IS NULL
    AND mbox.canonical_customer_id(p.tenant_id,p.store_id,p.customer_id)=mbox.canonical_customer_id(q.tenant_id,q.store_id,q.customer_id))
   ORDER BY a.created_at,a.id FOR UPDATE OF a`,[...this.scope,visit!.id])).rows
  const budget=await this.visitBudget(visit!.id)
  if(!budget.allowStacking&&active.length>1)deny('当前客组不允许叠加，请先核对已绑定优惠')
  let budgetRemaining=budget.remaining
  const standard=await new OrderRepository(this.tx,input.customerId??null).quoteCurrent(input.lines,input.channel,false)
  const history=(await this.tx.query<{id:string;product_id:string;gross:string;net:string;reduced:string;refunded:string;channel_discount:string}>(`SELECT i.id,i.product_id,(i.unit_price_minor*i.quantity)::text AS gross,i.total_amount_minor::text AS net,
   COALESCE((SELECT sum(f.amount_minor) FROM mbox.item_receivable_adjustment_facts f JOIN mbox.item_after_sales_cases c ON (c.tenant_id,c.store_id,c.id)=(f.tenant_id,f.store_id,f.case_id)
    WHERE (f.tenant_id,f.store_id,f.order_item_id)=(i.tenant_id,i.store_id,i.id) AND COALESCE(c.resolved_kind,c.kind)='unpaid_stop'),0)::text AS reduced,
   COALESCE((SELECT sum(r.amount_minor) FROM mbox.refund_items r JOIN mbox.refunds f ON (f.tenant_id,f.store_id,f.id)=(r.tenant_id,r.store_id,r.refund_id)
    WHERE (r.tenant_id,r.store_id,r.order_item_id)=(i.tenant_id,i.store_id,i.id) AND f.status='succeeded'),0)::text AS refunded,
   CASE WHEN i.product_snapshot->'pricingAuthorization'->>'sourceType'='channel_quote' THEN i.discount_amount_minor ELSE 0 END::text AS channel_discount
   FROM mbox.channel_order_attributions x JOIN mbox.orders o ON (o.tenant_id,o.store_id,o.id)=(x.tenant_id,x.store_id,x.order_id)
   JOIN mbox.order_items i ON (i.tenant_id,i.store_id,i.order_id)=(o.tenant_id,o.store_id,o.id)
   WHERE x.tenant_id=$1 AND x.store_id=$2 AND x.visit_id=$3 AND o.status NOT IN('draft','cancelled') AND i.status<>'cancelled' AND i.parent_order_item_id IS NULL
   AND NOT EXISTS(SELECT 1 FROM mbox.pricing_authorizations z WHERE (z.tenant_id,z.store_id,z.order_id)=(o.tenant_id,o.store_id,o.id) AND z.status='consumed' AND z.kind='gift') ORDER BY i.id`,[...this.scope,visit!.id])).rows
  const historical=history.map(i=>{
   const net=BigInt(money(i.net)),returned=BigInt(money(i.reduced))+BigInt(money(i.refunded)),discount=BigInt(money(i.channel_discount))
   const remaining=net>returned?net-returned:0n
   // The saved discount follows the returned paid portion; refunds never
   // manufacture eligible spend or make already-redeemed capacity new again.
   const basis=net===0n?(returned===0n?discount:0n):remaining+(discount*remaining/net)
   return{id:i.id,productId:i.product_id,basisMinor:money(basis.toString())}
  })
  const remaining=standard.items.map(i=>({id:String(i.requestIndex).padStart(3,'0'),basisMinor:i.amountMinor})),discounts=remaining.map(()=>0)
  const coupons:Snapshot['coupons']=[]
  for(const row of active){
   const rule=channelRuleSchema.parse(row.rule);if(rule.offer.kind==='gift')continue
   const eligible=money(historical.filter(i=>rule.eligibleProductIds.includes(i.productId)).reduce((a,i)=>a+i.basisMinor,0)+standard.items.filter(i=>rule.eligibleProductIds.includes(i.productId)).reduce((a,i)=>a+i.amountMinor,0))
   const used=money(row.applied),candidate=remaining.filter((_,i)=>rule.eligibleProductIds.includes(standard.items[i]!.productId))
   const amount=Math.min(Math.max(0,channelDiscountTarget(rule,eligible)-used),candidate.reduce((a,i)=>a+i.basisMinor,0),budgetRemaining)
   budgetRemaining-=amount
   coupons.push({activationId:row.id,amountMinor:amount,usedBeforeMinor:used,eligibleMinor:eligible})
   for(const part of allocateChannelAmount(amount,candidate)){const index=Number(part.id);remaining[index]!.basisMinor-=part.amountMinor;discounts[index]!+=part.amountMinor}
  }
  const discountMinor=money(discounts.reduce((a,b)=>a+b,0))
  return{visitId:visit!.id,subtotalMinor:standard.subtotalAmountMinor,discountMinor,payableMinor:standard.subtotalAmountMinor-discountMinor,currency:standard.currency,
   allocations:standard.items.map((i,index)=>({requestIndex:index,productId:i.productId,quantity:i.quantity,unitPriceMinor:i.unitPriceMinor,discountAmountMinor:discounts[index]!,lineFingerprint:pricingLineFingerprint(input.lines[index]!)})),
   coupons,...(input.cart?{cart:input.cart}:{}),basisFingerprint:hash({budget,history:historical,active:active.map(a=>({id:a.id,rule:a.rule,applied:a.applied}))})}
 }
 async prepareGift(input:PriceContext,claimId:string){
  await this.guard(input)
  const snapshot=await this.calculateGift(input,claimId)
  const row=(await this.tx.query<{id:string}>(`INSERT INTO mbox.channel_price_quotes(tenant_id,store_id,visit_id,table_session_id,actor_ref,channel,snapshot,fingerprint,expires_at)
   VALUES($1,$2,$3,$4,$5,'cashier',$6::jsonb,$7,clock_timestamp()+interval '2 minutes') RETURNING id`,[...this.scope,snapshot.visitId,input.tableSessionId,input.actorRef,JSON.stringify(snapshot),hash(snapshot)])).rows[0]!
  return row.id
 }
 private async calculateGift(input:PriceContext,claimId:string):Promise<Snapshot>{
  if(input.channel!=='cashier')deny('赠品须由员工从原券出品')
  const gift=(await this.tx.query<{activation_id:string;visit_id:string;product_id:string;quantity:number;rule:ChannelRule}>(`SELECT a.id AS activation_id,a.visit_id,g.product_id,g.quantity,b.rule_snapshot AS rule
   FROM mbox.channel_gift_promises g JOIN mbox.channel_claims q ON (q.tenant_id,q.store_id,q.id)=(g.tenant_id,g.store_id,g.claim_id)
   JOIN mbox.channel_batches b ON (b.tenant_id,b.store_id,b.id)=(q.tenant_id,q.store_id,q.batch_id)
   JOIN mbox.channel_activations a ON (a.tenant_id,a.store_id,a.claim_id)=(q.tenant_id,q.store_id,q.id)
   JOIN mbox.channel_visit_tables t ON (t.tenant_id,t.store_id,t.visit_id)=(a.tenant_id,a.store_id,a.visit_id)
   WHERE g.tenant_id=$1 AND g.store_id=$2 AND g.claim_id=$3 AND g.state='converted' AND g.order_id IS NULL
    AND q.status='active' AND NOT q.voided AND a.status='active' AND a.applied_discount_minor=0 AND t.table_session_id=$4 AND t.detached_at IS NULL
    AND EXISTS(SELECT 1 FROM mbox.table_session_customer_participations p JOIN mbox.channel_visit_tables vt ON (vt.tenant_id,vt.store_id,vt.table_session_id)=(p.tenant_id,p.store_id,p.table_session_id)
     WHERE p.tenant_id=q.tenant_id AND p.store_id=q.store_id AND p.left_at IS NULL AND vt.detached_at IS NULL AND vt.visit_id=a.visit_id
     AND mbox.canonical_customer_id(p.tenant_id,p.store_id,p.customer_id)=mbox.canonical_customer_id(q.tenant_id,q.store_id,q.customer_id))
   FOR UPDATE OF a,q,g`,[...this.scope,claimId,input.tableSessionId])).rows[0]
  if(!gift||input.lines.length!==1||input.lines[0]!.productId!==gift.product_id||input.lines[0]!.quantity!==gift.quantity)deny('赠品原券、顾客或桌次状态已变化')
  const rule=channelRuleSchema.parse(gift!.rule)
  const spend=(await this.tx.query<{amount:string}>(`SELECT COALESCE(sum(GREATEST(0,b.amount_minor-COALESCE((SELECT sum(r.amount_minor) FROM mbox.refund_items r JOIN mbox.refunds f ON (f.tenant_id,f.store_id,f.id)=(r.tenant_id,r.store_id,r.refund_id)
   WHERE (r.tenant_id,r.store_id,r.order_item_id)=(b.tenant_id,b.store_id,b.order_item_id) AND f.status='succeeded'),0))),0)::text AS amount
   FROM mbox.channel_order_attributions x JOIN mbox.loyalty_order_item_basis b ON (b.tenant_id,b.store_id,b.order_id)=(x.tenant_id,x.store_id,x.order_id)
   JOIN mbox.order_items i ON (i.tenant_id,i.store_id,i.id)=(b.tenant_id,b.store_id,b.order_item_id) JOIN mbox.orders o ON (o.tenant_id,o.store_id,o.id)=(x.tenant_id,x.store_id,x.order_id)
   WHERE x.tenant_id=$1 AND x.store_id=$2 AND x.visit_id=$3 AND i.product_id=ANY($4::uuid[]) AND o.status NOT IN('draft','cancelled')
   AND NOT EXISTS(SELECT 1 FROM mbox.pricing_authorizations z WHERE (z.tenant_id,z.store_id,z.order_id)=(o.tenant_id,o.store_id,o.id) AND z.status='consumed' AND z.kind='gift')`,[...this.scope,gift!.visit_id,rule.eligibleProductIds])).rows[0]!
  if(money(spend.amount)<rule.minimumMinor)deny('本次消费尚未达到赠品门槛，原券和库存承诺仍保留')
  const priced=await new OrderRepository(this.tx).quoteCurrent(input.lines,'cashier',false)
  if(priced.subtotalAmountMinor<=0)deny('赠品缺少可追溯的标准价格，请先维护商品')
  await this.releaseUnusedCancelled(gift!.visit_id)
  const budget=await this.visitBudget(gift!.visit_id)
  if(priced.subtotalAmountMinor>budget.remaining)deny('本次客组优惠余额不足以完整赠送，原券和库存承诺仍保留')
  return{visitId:gift!.visit_id,subtotalMinor:priced.subtotalAmountMinor,discountMinor:priced.subtotalAmountMinor,payableMinor:0,currency:priced.currency,giftClaimId:claimId,
   coupons:[{activationId:gift!.activation_id,amountMinor:priced.subtotalAmountMinor,usedBeforeMinor:0,eligibleMinor:money(spend.amount)}],
   allocations:priced.items.map((i,index)=>({requestIndex:index,productId:i.productId,quantity:i.quantity,unitPriceMinor:i.unitPriceMinor,discountAmountMinor:i.amountMinor,lineFingerprint:pricingLineFingerprint(input.lines[index]!)})),basisFingerprint:hash({budget,claimId,activationId:gift!.activation_id,spend:spend.amount})}
 }
 async authorize(context:Readonly<PricingAuthorityContext>):Promise<Readonly<PricingAuthorityDecision>>{
  const actorRef=context.actor.type==='employee'?`employee:${context.actor.employeeId}`:context.actor.type==='guest'?(context.actor.ref??''):''
  const row=(await this.tx.query<{table_session_id:string;actor_ref:string;customer_id:string|null;channel:PriceContext['channel'];snapshot:Snapshot;fingerprint:string;expires_at:string;valid:boolean}>(`SELECT *,expires_at::text,expires_at>clock_timestamp() AS valid FROM mbox.channel_price_quotes WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,[...this.scope,context.request.sourceId])).rows[0]
  if(!row||row.actor_ref!==actorRef||row.table_session_id!==context.tableSessionId||row.channel!==context.channel||!row.valid)deny('渠道报价已失效或不属于当前账号和桌次，请重新确认')
  const input:PriceContext={tableSessionId:context.tableSessionId,channel:row!.channel,actorRef,customerId:row!.customer_id,cart:row!.snapshot.cart,lines:context.lines}
  await this.guard(input)
  if(input.cart){
   const valid=await this.tx.query(`SELECT id FROM mbox.guest_shared_carts WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND table_session_id=$4 AND generation=$5 AND version=$6+1 AND status='submitting' FOR UPDATE`,[...this.scope,input.cart.id,input.tableSessionId,input.cart.generation,input.cart.version])
   if(!valid.rows[0])deny('购物车已变化，请重新确认渠道报价')
  }
  const current=row!.snapshot.giftClaimId?await this.calculateGift(input,row!.snapshot.giftClaimId):await this.calculate(input)
  if(hash(current)!==row!.fingerprint||current.discountMinor<=0)deny('商品、加单或优惠状态已变化，请重新确认渠道报价')
  const allocations=verifyPricingLineAllocations(current.allocations,context.lines,current.discountMinor)
  const authorizationId=randomUUID()
  await this.tx.query(`INSERT INTO mbox.pricing_authorizations(id,tenant_id,store_id,table_session_id,source_type,source_id,channel_quote_id,kind,amount_minor,maximum_amount_minor,currency,expires_at)
   VALUES($1,$2,$3,$4,'channel_quote',$5,$5,$9,$6,$6,$7,$8)`,[authorizationId,...this.scope,context.tableSessionId,context.request.sourceId,current.discountMinor,current.currency,row!.expires_at,current.giftClaimId?'gift':'discount'])
  return{authorized:true,authorizationId,kind:current.giftClaimId?'gift':'discount',sourceType:'channel_quote',sourceId:context.request.sourceId,amountMinor:current.discountMinor,maximumAmountMinor:current.discountMinor,currency:current.currency,expiresAt:row!.expires_at,lineAllocations:allocations}
 }
 async consume(quoteId:string,orderId:string){
  const quote=(await this.tx.query<{snapshot:Snapshot}>(`SELECT snapshot FROM mbox.channel_price_quotes WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,[...this.scope,quoteId])).rows[0]!
  if(quote.snapshot.giftClaimId)await this.tx.query(`UPDATE mbox.channel_gift_promises SET order_id=$4 WHERE tenant_id=$1 AND store_id=$2 AND claim_id=$3 AND order_id IS NULL`,[...this.scope,quote.snapshot.giftClaimId,orderId])
  for(const c of quote.snapshot.coupons.filter(c=>c.amountMinor>0)){
   await this.tx.query(`INSERT INTO mbox.channel_price_applications(tenant_id,store_id,quote_id,activation_id,order_id,amount_minor) VALUES($1,$2,$3,$4,$5,$6)`,[...this.scope,quoteId,c.activationId,orderId,c.amountMinor])
   await this.tx.query(`UPDATE mbox.channel_activations SET applied_discount_minor=applied_discount_minor+$4 WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,[...this.scope,c.activationId,c.amountMinor])
  }
 }
 async releaseUnusedCancelled(visitId:string){await releaseUnusedChannelDiscounts(this.tx,visitId)}
}
