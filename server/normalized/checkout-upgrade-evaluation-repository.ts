import type {ScopedTransaction} from './transaction-runner.js'
import {GuestSharedCartRepository} from './guest-shared-cart-repository.js'
import {CheckoutUpgradeQualificationRepository} from './checkout-upgrade-qualification-repository.js'
import {CheckoutUpgradePricingRepository} from './checkout-upgrade-pricing-repository.js'
import {CheckoutUpgradeAvailabilityRepository} from './checkout-upgrade-availability-repository.js'
import {qualifyCheckoutUpgrade,type UpgradeComposition} from './checkout-upgrade-eligibility.js'
import type {CheckoutCouponSelection} from './checkout-coupon-repository.js'
import type {BundleUnitSelectionInput} from './order-repository.js'

/** Internal hard qualification. All cart/party/order/stock facts are loaded in
 * the scoped transaction; no browser-provided eligibility flags are accepted.
 * This evaluates one candidate, does not display/accept it or grant authority. */
export class CheckoutUpgradeEvaluationRepository{
 constructor(private readonly tx:ScopedTransaction){}
 async evaluate(input:{ruleId:string;tableSessionId:string;customerId:string;portionId:string;expectedGeneration:number;expectedVersion:number;occasion:string|null;alcoholPreference:string|null;bundleSelection?:BundleUnitSelectionInput;selections:readonly CheckoutCouponSelection[]}){
  const scope=[this.tx.scope.tenantId,this.tx.scope.storeId]
  const cart=await new GuestSharedCartRepository(this.tx).findCurrentOpen(input.tableSessionId)
  if(!cart||cart.guestWritesFrozen||cart.generation!==input.expectedGeneration||cart.version!==input.expectedVersion)return{eligible:false as const,reason:'cart_changed'}
  const source=cart.lines.find(line=>line.portionIds?.includes(input.portionId))
  if(!source)return{eligible:false as const,reason:'portion_missing'}
  const rule=(await this.tx.query<{target_product_id:string;guest_count:number}>(`
    SELECT r.target_product_id,s.guest_count FROM mbox.checkout_upgrade_rules r
    JOIN mbox.products p ON p.tenant_id=r.tenant_id AND p.store_id=r.store_id AND p.id=r.target_product_id AND p.product_kind='bundle' AND p.status='active'
    JOIN mbox.table_sessions s ON s.tenant_id=r.tenant_id AND s.store_id=r.store_id AND s.id=$4 AND s.status='open'
    WHERE r.tenant_id=$1 AND r.store_id=$2 AND r.id=$3 AND r.source_product_id=$5 AND r.status='active'
      AND (r.valid_from IS NULL OR r.valid_from<=clock_timestamp()) AND (r.valid_until IS NULL OR r.valid_until>clock_timestamp())`,[...scope,input.ruleId,input.tableSessionId,source.productId])).rows[0]
  if(!rule)return{eligible:false as const,reason:'rule_not_available'}
  const bounds=await new CheckoutUpgradeQualificationRepository(this.tx).find(input.ruleId)
  if(!bounds)return{eligible:false as const,reason:'qualification_not_configured'}
  const bundleSelection=input.bundleSelection?{groups:input.bundleSelection.groups.map(group=>({groupId:group.groupId,productIds:[...group.productIds].sort()})).sort((a,b)=>a.groupId.localeCompare(b.groupId))}:undefined
  const comparison=await new CheckoutUpgradePricingRepository(this.tx).compare({...input,bundleSelection,cart,targetProductId:rule.target_product_id,channel:'guest_qr'})
  const available=await new CheckoutUpgradeAvailabilityRepository(this.tx).assess(comparison.after.operationalPortions)
  const before=comparison.before.composition.find(item=>item.portionId===input.portionId)!.items
  const after=comparison.after.composition.find(item=>item.portionId===input.portionId)!.items
  const sourceUnit=comparison.before.price.units.find(item=>item.id===input.portionId)!
  const targetUnit=comparison.after.price.units.find(item=>item.id===input.portionId)!
  const ids=[...new Set([rule.target_product_id,...after.map(item=>item.productId)])]
  const restrictions=(await this.tx.query<{verified:boolean;satisfied:boolean}>(`
    WITH RECURSIVE family(id) AS(
      SELECT mbox.canonical_customer_id($1,$2,$3)
      UNION SELECT c.id FROM mbox.customers c JOIN family f ON c.merged_into_customer_id=f.id WHERE c.tenant_id=$1 AND c.store_id=$2
    ) SELECT EXISTS(SELECT 1 FROM mbox.customers WHERE tenant_id=$1 AND store_id=$2 AND id=$3) AS verified,
      NOT EXISTS(SELECT 1 FROM mbox.customer_product_restrictions r WHERE r.tenant_id=$1 AND r.store_id=$2 AND r.customer_id IN(SELECT id FROM family) AND r.status='active' AND r.product_id=ANY($4::uuid[]))
      AND ($5::text IS DISTINCT FROM 'non_alcoholic' OR NOT EXISTS(SELECT 1 FROM mbox.products p WHERE p.tenant_id=$1 AND p.store_id=$2 AND p.id=ANY($4::uuid[]) AND p.product_kind='single' AND p.recommendation_beverage_family IS DISTINCT FROM 'non_alcoholic')) AS satisfied`,[...scope,input.customerId,ids,input.alcoholPreference])).rows[0]
  const ordered=(await this.tx.query<{product_id:string;quantity:string}>(`
    SELECT i.product_id,sum(i.quantity)::text AS quantity FROM mbox.orders o JOIN mbox.order_items i
      ON i.tenant_id=o.tenant_id AND i.store_id=o.store_id AND i.order_id=o.id
    WHERE o.tenant_id=$1 AND o.store_id=$2 AND o.table_session_id=$3 AND o.submitted_at IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM mbox.order_items child WHERE child.tenant_id=i.tenant_id AND child.store_id=i.store_id AND child.parent_order_item_id=i.id)
      AND ((o.status<>'cancelled' AND i.status<>'cancelled') OR EXISTS(
        SELECT 1 FROM mbox.kds_tasks k WHERE k.tenant_id=i.tenant_id AND k.store_id=i.store_id AND k.order_item_id=i.id
          AND (k.accepted_at IS NOT NULL OR k.ready_at IS NOT NULL OR k.status IN('accepted','preparing','ready')
            OR EXISTS(SELECT 1 FROM mbox.kds_task_events e WHERE e.tenant_id=k.tenant_id AND e.store_id=k.store_id AND e.kds_task_id=k.id AND (e.from_status IN('accepted','preparing','ready') OR e.to_status IN('accepted','preparing','ready'))))))
    GROUP BY i.product_id`,[...scope,input.tableSessionId])).rows
  const composition=(rows:readonly {productId:string;quantity:number}[]):UpgradeComposition[]=>rows.map(item=>({...item,specificationId:item.productId,optionKey:''}))
  const result=qualifyCheckoutUpgrade(bounds,{published:true,available:available.available,inventoryKnownAndSufficient:available.inventoryKnownAndSufficient,productionAvailable:available.productionAvailable,
    partySize:rule.guest_count,occasion:input.occasion,alcoholPreference:input.alcoholPreference,
    originalPayableMinor:comparison.before.price.payableMinor,upgradedPayableMinor:comparison.after.price.payableMinor,
    originalCostMinor:comparison.before.price.costMinor,upgradedCostMinor:comparison.after.price.costMinor,
    sourcePortionPayableMinor:sourceUnit.payableMinor,targetPortionPayableMinor:targetUnit.payableMinor,sourcePortionCostMinor:comparison.before.composition.find(item=>item.portionId===input.portionId)!.costMinor,targetPortionCostMinor:comparison.after.composition.find(item=>item.portionId===input.portionId)!.costMinor,
    originalComposition:composition(before),upgradedComposition:composition(after),
    otherTableComposition:[...composition(comparison.before.composition.filter(item=>item.portionId!==input.portionId).flatMap(item=>item.items)),...composition(ordered.map(item=>({productId:item.product_id,quantity:Number(item.quantity)})))],
    restrictionsVerified:restrictions?.verified===true,restrictionsSatisfied:restrictions?.satisfied===true,choicesComplete:true,quoteComparable:true})
  if(!result.eligible)return result
  const unchanged=(await this.tx.query<{ok:boolean}>(`SELECT EXISTS(SELECT 1 FROM mbox.guest_shared_carts c JOIN mbox.table_sessions s ON s.tenant_id=c.tenant_id AND s.store_id=c.store_id AND s.id=c.table_session_id WHERE c.tenant_id=$1 AND c.store_id=$2 AND c.id=$3 AND c.version=$4 AND c.status='open' AND s.status='open' AND s.guest_count=$5 AND NOT s.guest_cart_writes_frozen) AS ok`,[...scope,cart.id,cart.version,rule.guest_count])).rows[0]?.ok
  if(!unchanged)return{eligible:false as const,reason:'cart_changed'}
  return{...result,ruleId:input.ruleId,targetProductId:rule.target_product_id,cartId:cart.id,generation:cart.generation,version:cart.version,occasion:input.occasion,alcoholPreference:input.alcoholPreference,comparison}
 }
}
