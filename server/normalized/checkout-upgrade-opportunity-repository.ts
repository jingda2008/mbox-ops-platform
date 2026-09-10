import {createHash} from 'node:crypto'
import type {ScopedTransaction} from './transaction-runner.js'
import {CheckoutUpgradeEvaluationRepository} from './checkout-upgrade-evaluation-repository.js'
import {GuestSharedCartRepository} from './guest-shared-cart-repository.js'
import {CheckoutCouponQuoteRepository} from './checkout-coupon-quote-repository.js'
import type {CheckoutCouponSelection} from './checkout-coupon-repository.js'
import {CheckoutCartPricingError} from './checkout-cart-pricing.js'

export type EligibleUpgradeEvaluation=Extract<Awaited<ReturnType<CheckoutUpgradeEvaluationRepository['evaluate']>>,{eligible:true}>
interface OpportunityRow extends Record<string,unknown>{id:string;cart_id:string;cart_generation:number;cart_version:string;customer_id:string;rule_id:string;source_portion_id:string;source_product_id:string;target_product_id:string;original_payable_minor:string;upgraded_payable_minor:string;currency:string;quote_fingerprint:string;source_name:string;target_name:string;fit_reason:string;expires_at:string;request_key:string;status:'offered'|'declined'|'accepted'|'expired'|'invalidated';replacement_portion_id:string|null;accepted_quote_id:string|null}
export function upgradeQuoteFingerprint(evaluation:EligibleUpgradeEvaluation){
 const quote=(value:EligibleUpgradeEvaluation['comparison']['before'])=>({currency:value.currency,price:value.price,allocations:value.lineAllocations,portions:value.portionIds,composition:value.composition,lines:value.lines})
 return createHash('sha256').update(JSON.stringify({ruleId:evaluation.ruleId,cartId:evaluation.cartId,generation:evaluation.generation,version:evaluation.version,sourcePortionId:evaluation.comparison.sourcePortionId,targetProductId:evaluation.targetProductId,before:quote(evaluation.comparison.before),after:quote(evaluation.comparison.after)})).digest('hex')
}

/** Persist only a fully qualified opportunity. Uniqueness is the shared cart,
 * not a page variable or a customer/device. None of these operations creates
 * orders, payments, stock holds or coupon reservations. */
export class CheckoutUpgradeOpportunityRepository{
 constructor(private readonly tx:ScopedTransaction){}
 private get scope(){return[this.tx.scope.tenantId,this.tx.scope.storeId]}
 async offerOnce(evaluation:EligibleUpgradeEvaluation,input:{customerId:string;requestKey:string;variants?:readonly {evaluation:EligibleUpgradeEvaluation;label:string}[]}){
  if(!/^[A-Za-z0-9_-]{8,128}$/.test(input.requestKey))throw new CheckoutCartPricingError('推荐请求编号无效')
  const fingerprint=upgradeQuoteFingerprint(evaluation)
  const previous=(await this.tx.query<{id:string;request_key:string;quote_fingerprint:string}>('SELECT id,request_key,quote_fingerprint FROM mbox.checkout_upgrade_opportunities WHERE tenant_id=$1 AND store_id=$2 AND cart_id=$3',[...this.scope,evaluation.cartId])).rows[0]
  if(previous){
   if(previous.request_key!==input.requestKey)return null
   if(previous.quote_fingerprint!==fingerprint)throw new CheckoutCartPricingError('同一推荐请求对应的购物车或报价已变化')
   const found=await this.find(previous.id,input.customerId);return found?.status==='offered'?found:null
  }
  const sourceIndex=evaluation.comparison.before.portionIds.indexOf(evaluation.comparison.sourcePortionId)
  const targetIndex=evaluation.comparison.after.portionIds.indexOf(evaluation.comparison.sourcePortionId)
  const source=evaluation.comparison.before.lines[sourceIndex]!,target=evaluation.comparison.after.lines[targetIndex]!
  const inserted=(await this.tx.query<{id:string}>(`
   INSERT INTO mbox.checkout_upgrade_opportunities(tenant_id,store_id,cart_id,cart_generation,cart_version,customer_id,rule_id,source_portion_id,source_product_id,target_product_id,original_payable_minor,upgraded_payable_minor,currency,quote_fingerprint,source_name,target_name,fit_reason,request_key,expires_at,occasion,alcohol_preference)
   SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,source.name,target.name,$15,$16,clock_timestamp()+make_interval(mins=>LEAST(rule.offer_valid_minutes,2)),$17,$18
   FROM mbox.checkout_upgrade_rules rule JOIN mbox.products source ON source.tenant_id=rule.tenant_id AND source.store_id=rule.store_id AND source.id=rule.source_product_id
   JOIN mbox.products target ON target.tenant_id=rule.tenant_id AND target.store_id=rule.store_id AND target.id=rule.target_product_id
   WHERE rule.tenant_id=$1 AND rule.store_id=$2 AND rule.id=$7 AND rule.status='active'
   ON CONFLICT(tenant_id,store_id,cart_id) DO NOTHING RETURNING id`,[...this.scope,evaluation.cartId,evaluation.generation,evaluation.version,input.customerId,evaluation.ruleId,evaluation.comparison.sourcePortionId,source.productId,target.productId,evaluation.comparison.before.price.payableMinor,evaluation.comparison.after.price.payableMinor,evaluation.comparison.before.currency,fingerprint,evaluation.reason,input.requestKey,evaluation.occasion,evaluation.alcoholPreference])).rows[0]
  if(!inserted)return null
  const selections=(evaluation.comparison.before as {selections?:readonly CheckoutCouponSelection[]}).selections??[]
  for(const selection of selections)await this.tx.query('INSERT INTO mbox.checkout_upgrade_opportunity_coupons(tenant_id,store_id,opportunity_id,portion_id,benefit_id) VALUES($1,$2,$3,$4,$5)',[...this.scope,inserted.id,selection.portionId,selection.benefitId])
  for(const group of target.bundleSelections?.[0]?.groups??[])for(const [position,productId] of group.productIds.entries())await this.tx.query('INSERT INTO mbox.checkout_upgrade_opportunity_choices(tenant_id,store_id,opportunity_id,choice_group_id,position,component_product_id) VALUES($1,$2,$3,$4,$5,$6)',[...this.scope,inserted.id,group.groupId,position,productId])
  if((input.variants?.length??0)>40)throw new CheckoutCartPricingError('可选范围过大，暂不推荐')
  for(const variant of input.variants??[]){
   const value=variant.evaluation
   if(value.ruleId!==evaluation.ruleId||value.cartId!==evaluation.cartId||value.version!==evaluation.version||value.comparison.sourcePortionId!==evaluation.comparison.sourcePortionId||value.comparison.before.price.payableMinor!==evaluation.comparison.before.price.payableMinor||value.comparison.after.price.payableMinor!==evaluation.comparison.after.price.payableMinor)throw new CheckoutCartPricingError('可选升级不能使用不同报价宣传')
   const variantId=(await this.tx.query<{id:string}>('INSERT INTO mbox.checkout_upgrade_choice_variants(tenant_id,store_id,opportunity_id,quote_fingerprint,label) VALUES($1,$2,$3,$4,$5) RETURNING id',[...this.scope,inserted.id,upgradeQuoteFingerprint(value),variant.label])).rows[0]!.id
   const index=value.comparison.after.portionIds.indexOf(value.comparison.sourcePortionId)
   for(const group of value.comparison.after.lines[index]!.bundleSelections?.[0]?.groups??[])for(const [position,productId] of group.productIds.entries())await this.tx.query('INSERT INTO mbox.checkout_upgrade_variant_choices(tenant_id,store_id,opportunity_id,variant_id,choice_group_id,position,component_product_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[...this.scope,inserted.id,variantId,group.groupId,position,productId])
  }
  return this.find(inserted.id,input.customerId)
 }
 async find(id:string,customerId:string){
  const row=(await this.tx.query<OpportunityRow>(`SELECT opportunity.*,opportunity.expires_at::text,
   COALESCE(closure.action,CASE WHEN opportunity.expires_at<=clock_timestamp() THEN 'expired' ELSE 'offered' END) AS status,
   closure.replacement_portion_id,closure.accepted_quote_id,closure.accepted_variant_id
   FROM mbox.checkout_upgrade_opportunities opportunity LEFT JOIN mbox.checkout_upgrade_opportunity_closures closure
    ON closure.tenant_id=opportunity.tenant_id AND closure.store_id=opportunity.store_id AND closure.opportunity_id=opportunity.id
   WHERE opportunity.tenant_id=$1 AND opportunity.store_id=$2 AND opportunity.id=$3
    AND mbox.canonical_customer_id(opportunity.tenant_id,opportunity.store_id,opportunity.customer_id)=mbox.canonical_customer_id($1,$2,$4)`,[...this.scope,id,customerId])).rows[0]
  if(!row)return null
  const variants=(await this.tx.query<{id:string;label:string}>('SELECT id,label FROM mbox.checkout_upgrade_choice_variants WHERE tenant_id=$1 AND store_id=$2 AND opportunity_id=$3 ORDER BY label,id',[...this.scope,id])).rows
  return{id:row.id,cartId:row.cart_id,generation:row.cart_generation,version:Number(row.cart_version),ruleId:row.rule_id,sourcePortionId:row.source_portion_id,sourceProductId:row.source_product_id,targetProductId:row.target_product_id,
   sourceName:row.source_name,targetName:row.target_name,fitReason:row.fit_reason,originalPayableMinor:Number(row.original_payable_minor),upgradedPayableMinor:Number(row.upgraded_payable_minor),currency:row.currency,expiresAt:row.expires_at,status:row.status,
   replacementPortionId:row.replacement_portion_id,acceptedQuoteId:row.accepted_quote_id,acceptedVariantId:typeof row.accepted_variant_id==='string'?row.accepted_variant_id:null,variants:variants.map(variant=>({id:variant.id,label:variant.label}))}
 }
 async decline(id:string,customerId:string,tableSessionId:string){
  const found=await this.find(id,customerId)
  if(!found)throw new CheckoutCartPricingError('推荐不存在或不属于当前会员')
  const cart=(await this.tx.query<{table_session_id:string}>('SELECT table_session_id FROM mbox.guest_shared_carts WHERE tenant_id=$1 AND store_id=$2 AND id=$3',[...this.scope,found.cartId])).rows[0]
  if(cart?.table_session_id!==tableSessionId)throw new CheckoutCartPricingError('推荐不属于当前桌次')
  await this.tx.query(`INSERT INTO mbox.checkout_upgrade_opportunity_closures(tenant_id,store_id,opportunity_id,action,customer_id,reason) VALUES($1,$2,$3,'declined',$4,'顾客保留原购物车，不再主动推荐') ON CONFLICT(tenant_id,store_id,opportunity_id) DO NOTHING`,[...this.scope,id,customerId])
  return this.find(id,customerId)
 }
 /** Must run in one transaction. A failed check or closure rolls back the
  * replacement and any new quote. No order or payment is created here. */
 async accept(id:string,input:{customerId:string;tableSessionId:string;actorSessionRef:string;variantId?:string}){
  const lock=(await this.tx.query<{ok:boolean}>('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS ok',[`upgrade-accept:${this.scope.join(':')}:${id}`])).rows[0]?.ok
  if(!lock)throw new CheckoutCartPricingError('升级正在确认，请稍后核对；原订单仍可继续')
  const opportunity=await this.find(id,input.customerId)
  if(!opportunity)throw new CheckoutCartPricingError('推荐不存在或不属于当前会员')
  const row=(await this.tx.query<{quote_fingerprint:string;occasion:string|null;alcohol_preference:string|null;table_session_id:string}>(`SELECT o.quote_fingerprint,o.occasion,o.alcohol_preference,c.table_session_id FROM mbox.checkout_upgrade_opportunities o JOIN mbox.guest_shared_carts c ON c.tenant_id=o.tenant_id AND c.store_id=o.store_id AND c.id=o.cart_id WHERE o.tenant_id=$1 AND o.store_id=$2 AND o.id=$3`,[...this.scope,id])).rows[0]!
  if(row.table_session_id!==input.tableSessionId)throw new CheckoutCartPricingError('推荐不属于当前桌次')
  if(opportunity.status==='accepted'){
   if(input.variantId&&input.variantId!==opportunity.acceptedVariantId)throw new CheckoutCartPricingError('此前已按另一选项完成升级，请核对实际购物车')
   return{opportunity,cart:await new GuestSharedCartRepository(this.tx).findCurrentOpen(input.tableSessionId),replayed:true}
  }
  if(opportunity.status!=='offered')throw new CheckoutCartPricingError('推荐已结束，请保留当前购物车继续下单')
  const enabled=(await this.tx.query<{enabled:boolean}>(`SELECT EXISTS(SELECT 1 FROM mbox.customer_experience_features WHERE tenant_id=$1 AND store_id=$2 AND feature_code='checkout_upgrade' AND rollout_state IN('pilot','enabled') AND (effective_from IS NULL OR effective_from<=clock_timestamp()) AND (effective_until IS NULL OR effective_until>clock_timestamp())) AS enabled`,this.scope)).rows[0]?.enabled
  if(!enabled)throw new CheckoutCartPricingError('升级推荐已暂停，原购物车仍可继续下单')
  if(opportunity.variants.length&&!opportunity.variants.some(variant=>variant.id===input.variantId))throw new CheckoutCartPricingError('请先选齐具体菜品，原购物车尚未变更')
  if(!opportunity.variants.length&&input.variantId)throw new CheckoutCartPricingError('此升级不含可选分支')
  const variant=input.variantId?(await this.tx.query<{quote_fingerprint:string}>('SELECT quote_fingerprint FROM mbox.checkout_upgrade_choice_variants WHERE tenant_id=$1 AND store_id=$2 AND opportunity_id=$3 AND id=$4',[...this.scope,id,input.variantId])).rows[0]:null
  const choices=(await this.tx.query<{choice_group_id:string;component_product_id:string}>(input.variantId?'SELECT choice_group_id,component_product_id FROM mbox.checkout_upgrade_variant_choices WHERE tenant_id=$1 AND store_id=$2 AND opportunity_id=$3 AND variant_id=$4 ORDER BY choice_group_id,position':'SELECT choice_group_id,component_product_id FROM mbox.checkout_upgrade_opportunity_choices WHERE tenant_id=$1 AND store_id=$2 AND opportunity_id=$3 ORDER BY choice_group_id,position',input.variantId?[...this.scope,id,input.variantId]:[...this.scope,id])).rows
  const groups=new Map<string,string[]>()
  for(const choice of choices)groups.set(choice.choice_group_id,[...(groups.get(choice.choice_group_id)??[]),choice.component_product_id])
  const bundleSelection=groups.size?{groups:[...groups].map(([groupId,productIds])=>({groupId,productIds}))}:undefined
  const selections=(await this.tx.query<{portion_id:string;benefit_id:string}>('SELECT portion_id,benefit_id FROM mbox.checkout_upgrade_opportunity_coupons WHERE tenant_id=$1 AND store_id=$2 AND opportunity_id=$3 ORDER BY portion_id',[...this.scope,id])).rows.map(c=>({portionId:c.portion_id,benefitId:c.benefit_id}))
  const evaluation=await new CheckoutUpgradeEvaluationRepository(this.tx).evaluate({ruleId:opportunity.ruleId,tableSessionId:input.tableSessionId,customerId:input.customerId,portionId:opportunity.sourcePortionId,expectedGeneration:opportunity.generation,expectedVersion:opportunity.version,occasion:row.occasion,alcoholPreference:row.alcohol_preference,bundleSelection,selections})
  if(!evaluation.eligible||upgradeQuoteFingerprint(evaluation)!==(variant?.quote_fingerprint??row.quote_fingerprint))throw new CheckoutCartPricingError('套餐、价格或可售条件已变化，未更改原购物车，请重新确认订单')
  const carts=new GuestSharedCartRepository(this.tx),before=await carts.findCurrentOpen(input.tableSessionId)
  if(!before||before.id!==opportunity.cartId)throw new CheckoutCartPricingError('购物车已变化，未执行升级')
  const oldIds=new Set(before.lines.flatMap(line=>line.portionIds??[])),operationId=`upgrade-${id}`
  const cart=await carts.replacePortionProduct(input.tableSessionId,before.publicId,{productId:opportunity.sourceProductId,portionId:opportunity.sourcePortionId,targetProductId:opportunity.targetProductId,bundleSelection,expectedGeneration:opportunity.generation,expectedVersion:opportunity.version,operationId,actorSessionRef:input.actorSessionRef})
  const replacementIds=cart.lines.filter(line=>line.productId===opportunity.targetProductId).flatMap(line=>line.portionIds??[]).filter(portionId=>!oldIds.has(portionId))
  if(replacementIds.length!==1)throw new CheckoutCartPricingError('升级份次未能完整确认，已保留原购物车')
  const replacementPortionId=replacementIds[0]!
  const quote=selections.length?await new CheckoutCouponQuoteRepository(this.tx).prepare({customerId:input.customerId,tableSessionId:input.tableSessionId,expectedGeneration:cart.generation,expectedVersion:cart.version,requestKey:`upgrade-quote-${id}`,selections:selections.map(s=>({...s,portionId:s.portionId===opportunity.sourcePortionId?replacementPortionId:s.portionId}))}):null
  if(quote&&quote.payableMinor!==opportunity.upgradedPayableMinor)throw new CheckoutCartPricingError('优惠报价发生变化，升级已回滚')
  const operation=(await this.tx.query<{id:string}>('SELECT id FROM mbox.guest_shared_cart_operations WHERE tenant_id=$1 AND store_id=$2 AND cart_id=$3 AND scope_operation_id=$4',[...this.scope,cart.id,operationId])).rows[0]!
  await this.tx.query(`INSERT INTO mbox.checkout_upgrade_opportunity_closures(tenant_id,store_id,opportunity_id,action,customer_id,accepted_operation_id,replacement_portion_id,accepted_quote_id,accepted_variant_id,reason) VALUES($1,$2,$3,'accepted',$4,$5,$6,$7,$8,'顾客明确接受，重新核价后原子替换指定份次')`,[...this.scope,id,input.customerId,operation.id,replacementPortionId,quote?.id??null,input.variantId??null])
  return{opportunity:await this.find(id,input.customerId),cart,replayed:false}
 }
}
