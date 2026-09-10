import type {ScopedTransaction} from './transaction-runner.js'
import {GuestSharedCartRepository} from './guest-shared-cart-repository.js'
import {CheckoutUpgradeEvaluationRepository} from './checkout-upgrade-evaluation-repository.js'
import {CheckoutUpgradeOpportunityRepository,type EligibleUpgradeEvaluation} from './checkout-upgrade-opportunity-repository.js'
import type {CheckoutCouponSelection} from './checkout-coupon-repository.js'
import {CheckoutCartPricingError} from './checkout-cart-pricing.js'
import {upgradeChoiceCombinations,type UpgradeChoiceGroup} from './checkout-upgrade-choice-combinations.js'
import {OrderProductUnavailableError,OrderProductCostUnavailableError} from './order-repository.js'

export type UpgradePreparationReason='feature_unavailable'|'cart_changed'|'already_considered'|'opportunity_expired_or_changed'|'no_matching_rules'|'evaluation_limit'|'no_eligible_candidate'|'offered'|'replayed'|'concurrent_decision'

/** Rank only qualified concrete alternatives. Every selectable branch must
 * preserve the source and pass the same pricing/stock/portion gates. */
export class CheckoutUpgradeCandidateRepository{
 constructor(private readonly tx:ScopedTransaction,private readonly observe?:(reason:UpgradePreparationReason)=>void){}
 private report(reason:UpgradePreparationReason){try{this.observe?.(reason)}catch{/* Diagnostics must not change checkout behavior. */}}
 async prepare(input:{customerId:string;tableSessionId:string;expectedGeneration:number;expectedVersion:number;occasion:string|null;alcoholPreference:string|null;selections:readonly CheckoutCouponSelection[];requestKey:string}){
  const none=(reason:UpgradePreparationReason)=>{this.report(reason);return null}
  const deadline=Date.now()+1500
  const scope=[this.tx.scope.tenantId,this.tx.scope.storeId]
  const enabled=(await this.tx.query<{enabled:boolean}>(`SELECT EXISTS(SELECT 1 FROM mbox.customer_experience_features WHERE tenant_id=$1 AND store_id=$2 AND feature_code='checkout_upgrade' AND rollout_state IN('pilot','enabled') AND (effective_from IS NULL OR effective_from<=clock_timestamp()) AND (effective_until IS NULL OR effective_until>clock_timestamp())) AS enabled`,scope)).rows[0]?.enabled
  if(!enabled)return none('feature_unavailable')
  const cart=await new GuestSharedCartRepository(this.tx).findCurrentOpen(input.tableSessionId)
  if(!cart||cart.guestWritesFrozen||cart.generation!==input.expectedGeneration||cart.version!==input.expectedVersion)return none('cart_changed')
  const prior=(await this.tx.query<{id:string;request_key:string}>('SELECT id,request_key FROM mbox.checkout_upgrade_opportunities WHERE tenant_id=$1 AND store_id=$2 AND cart_id=$3',[...scope,cart.id])).rows[0]
  if(prior){
   if(prior.request_key!==input.requestKey)return none('already_considered')
   const opportunity=await new CheckoutUpgradeOpportunityRepository(this.tx).find(prior.id,input.customerId)
   if(opportunity?.status==='offered'&&opportunity.version===cart.version){this.report('replayed');return opportunity}
   return none('opportunity_expired_or_changed')
  }
  const rules=(await this.tx.query<{id:string;source_product_id:string;target_product_id:string;priority:number}>(`SELECT r.id,r.source_product_id,r.target_product_id,r.priority FROM mbox.checkout_upgrade_rules r WHERE r.tenant_id=$1 AND r.store_id=$2 AND r.source_product_id=ANY($3::uuid[]) AND r.status='active' AND (r.valid_from IS NULL OR r.valid_from<=clock_timestamp()) AND (r.valid_until IS NULL OR r.valid_until>clock_timestamp()) ORDER BY r.id LIMIT 21`,[...scope,cart.lines.map(line=>line.productId)])).rows
  if(!rules.length)return none('no_matching_rules')
  if(rules.length>20)return none('evaluation_limit')
  const pairs=rules.flatMap(rule=>cart.lines.filter(line=>line.productId===rule.source_product_id).flatMap(line=>(line.portionIds??[]).map(portionId=>({rule,portionId}))))
  if(pairs.length>40)return none('evaluation_limit')
  const groupRows=(await this.tx.query<{id:string;bundle_product_id:string;display_name:string;selection_count:number;component_product_id:string|null;name:string|null}>(`SELECT g.id,g.bundle_product_id,g.display_name,g.selection_count,o.component_product_id,p.name FROM mbox.product_bundle_choice_groups g LEFT JOIN mbox.product_bundle_choice_options o ON o.tenant_id=g.tenant_id AND o.store_id=g.store_id AND o.choice_group_id=g.id LEFT JOIN mbox.products p ON p.tenant_id=o.tenant_id AND p.store_id=o.store_id AND p.id=o.component_product_id WHERE g.tenant_id=$1 AND g.store_id=$2 AND g.bundle_product_id=ANY($3::uuid[]) ORDER BY g.id,o.component_product_id`,[...scope,[...new Set(rules.map(rule=>rule.target_product_id))]])).rows
  const groupMap=new Map<string,UpgradeChoiceGroup&{targetProductId:string}>()
  for(const row of groupRows){
   const group=groupMap.get(row.id)??{id:row.id,name:row.display_name,selectionCount:row.selection_count,options:[],targetProductId:row.bundle_product_id}
   if(row.component_product_id&&row.name)group.options=[...group.options,{productId:row.component_product_id,name:row.name}]
   groupMap.set(row.id,group)
  }
  const qualified:{evaluation:EligibleUpgradeEvaluation;priority:number;label:string;hasChoices:boolean}[]=[]
  let evaluations=0
  for(const {rule,portionId} of pairs){
   if(Date.now()>=deadline)return none('evaluation_limit')
   const groups=[...groupMap.values()].filter(group=>group.targetProductId===rule.target_product_id)
   const variants=upgradeChoiceCombinations(groups)
   if(!variants)continue
   for(const variant of variants){
   if(++evaluations>40||Date.now()>=deadline)return none('evaluation_limit')
   try{
    const evaluation=await new CheckoutUpgradeEvaluationRepository(this.tx).evaluate({...input,ruleId:rule.id,portionId,bundleSelection:groups.length?variant.selection:undefined})
    if(evaluation.eligible)qualified.push({evaluation,priority:rule.priority,label:variant.label,hasChoices:groups.length>0})
   }catch(error){
    // Only domain rejection is safe to skip. SQL/connection faults must escape
    // for rollback; callers may then continue the independent original order.
    if(!(error instanceof CheckoutCartPricingError||error instanceof OrderProductUnavailableError||error instanceof OrderProductCostUnavailableError))throw error
   }
   }
  }
  qualified.sort((a,b)=>b.priority-a.priority||a.evaluation.addedPayableMinor-b.evaluation.addedPayableMinor||a.evaluation.ruleId.localeCompare(b.evaluation.ruleId)||a.evaluation.comparison.sourcePortionId.localeCompare(b.evaluation.comparison.sourcePortionId))
  const winner=qualified[0],selected=winner?.evaluation
  if(Date.now()>=deadline)return none('evaluation_limit')
  if(!selected)return none('no_eligible_candidate')
  const variants=winner.hasChoices?qualified.filter(row=>row.evaluation.ruleId===selected.ruleId&&row.evaluation.comparison.sourcePortionId===selected.comparison.sourcePortionId).map(row=>({evaluation:row.evaluation,label:row.label})):undefined
  const offered=await new CheckoutUpgradeOpportunityRepository(this.tx).offerOnce(selected,variants?{...input,variants}:input)
  this.report(offered?'offered':'concurrent_decision')
  return offered
 }
}
