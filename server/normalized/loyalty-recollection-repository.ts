import type { JsonValue } from './command-executor.js'
import type { ScopedTransaction } from './transaction-runner.js'
import { LoyaltyAccrualRepository } from './loyalty-accrual-repository.js'
import { LoyaltyOperationalControlRepository } from './loyalty-operational-control-repository.js'
import { RecommendationFinancialAttributionRepository } from './recommendation-financial-attribution-repository.js'

export interface LoyaltyRecoveryPreview {
  status:'not_required'|'ready'|'rule_pending'|'refund_review_required'|'ineligible'
  membershipId:string|null
  memberNo:string|null
  policyVersionId:string|null
  recoveryPaymentId:string|null
  eligibleAmountMinor:number
  pointsDelta:number
  growthDelta:number
  availablePointsDelta:number
  pendingRecoveryPointsDelta:number
  expiresAt:string|null
  blockReasons:string[]
  basis:JsonValue[]
}
interface Context extends Record<string,unknown> {
  award_id:string;membership_id:string;member_no:string;customer_id:string;policy_version_id:string;currency:string
  calculation_model:'exact_carry'|'per_order_rounded';eligible_amount_minor:string;awarded_points:number;awarded_growth:number
  reversed_amount_minor:string;reversed_points:number;reversed_growth:number;restored_amount_minor:string;restored_points:number;restored_growth:number
  available_points:number;pending_recovery_points:number;growth_value:number;expires_at:string|null
  points_numerator_per_minor:string|null;points_denominator:string|null;growth_numerator_per_minor:string|null;growth_denominator:string|null
  rounding_mode:'floor'|'nearest';awarded_at:string
}
interface Application extends Record<string,unknown> {
  id:string;refund_id:string;eligible_refund_amount_minor:string;reversed_points:number;applied_at:string
  settled_payment_id:string|null;settled_at:string|null
  movements:{id:string;lotId:string;points:number;expiresAt:string|null}[]
  debt_points:number;intervening_debt_credit:boolean
}
interface Carry {denominator:bigint;remainder:bigint}
interface Plan {application:Application;points:number;growth:number;releasedDebt:number;credited:number;expired:number;lotReturns:{movementId:string;lotId:string;points:number;expiresAt:string|null}[];extraPoints:number}
const empty=():LoyaltyRecoveryPreview=>({status:'not_required',membershipId:null,memberNo:null,policyVersionId:null,recoveryPaymentId:null,eligibleAmountMinor:0,pointsDelta:0,growthDelta:0,availablePointsDelta:0,pendingRecoveryPointsDelta:0,expiresAt:null,blockReasons:[],basis:[]})

/** Restores only original, already reversed contributions; it never accepts a reward amount from a caller. */
export class LoyaltyRecollectionRepository {
  constructor(private readonly transaction:ScopedTransaction){}
  async previewOrderRecovery(input:Readonly<{orderId:string;occurredAt?:string}>):Promise<LoyaltyRecoveryPreview>{
    return (await this.plan(input.orderId,input.occurredAt??new Date().toISOString())).preview
  }
  async applyApprovedRecovery(input:Readonly<{orderId:string;requestId?:string;paymentId:string;actorRef:string;occurredAt:string}>):Promise<LoyaltyRecoveryPreview&{applied:boolean}>{
    const tx=this.transaction,{tenantId,storeId}=tx.scope
    await tx.query('SELECT id FROM mbox.orders WHERE tenant_id=$1 AND store_id=$2 AND id=$3 FOR UPDATE',[tenantId,storeId,input.orderId])
    // Lock the account before reading carry, lots, debt or application summaries.
    await tx.query(`SELECT account.id FROM mbox.loyalty_order_awards award JOIN mbox.loyalty_accounts account
      ON (account.tenant_id,account.store_id,account.membership_id)=(award.tenant_id,award.store_id,award.membership_id)
      WHERE award.tenant_id=$1 AND award.store_id=$2 AND award.order_id=$3 FOR UPDATE OF award,account`,[tenantId,storeId,input.orderId])
    const {preview,context,plans}=await this.plan(input.orderId,input.occurredAt)
    if(preview.status!=='ready'||!context)return {...preview,applied:false}
    if(preview.recoveryPaymentId!==input.paymentId)throw new Error('Loyalty recovery settlement receipt changed')
    await new LoyaltyOperationalControlRepository(tx).assertPositiveAccrualActive()
    const accrual=new LoyaltyAccrualRepository(tx)
    let available=context.available_points,pending=context.pending_recovery_points,growth=context.growth_value
    for(const plan of plans){
      const application=plan.application
      // An approved preview is not a money fact. 237 must have persisted every original item first.
      const facts=await tx.query(`SELECT 1 FROM mbox.refund_items item WHERE item.tenant_id=$1 AND item.store_id=$2 AND item.refund_id=$3
        AND NOT EXISTS(SELECT 1 FROM mbox.order_recollection_item_restorations restored
          WHERE (restored.tenant_id,restored.store_id,restored.order_id,restored.refund_id,restored.order_item_id)=($1,$2,$4,item.refund_id,item.order_item_id)
            AND restored.amount_minor=item.amount_minor) LIMIT 1`,[tenantId,storeId,application.refund_id,input.orderId])
      if(facts.rowCount)throw new Error('Loyalty restoration requires immutable original item settlement facts')
      const settlement=(await tx.query<{payment_id:string}>(`SELECT recollection_payment_id AS payment_id FROM mbox.order_recollection_item_restorations
        WHERE tenant_id=$1 AND store_id=$2 AND order_id=$3 AND refund_id=$4 ORDER BY order_item_id LIMIT 1`,[tenantId,storeId,input.orderId,application.refund_id])).rows[0]
      if(!settlement)throw new Error('Loyalty restoration settlement fact is missing')
      let points=plan.points,growthDelta=plan.growth
      if(context.calculation_model==='exact_carry'){
        points=await accrual.applyExactCarry({membershipId:context.membership_id,policyVersionId:context.policy_version_id,currency:context.currency,rewardKind:'points',denominator:BigInt(context.points_denominator!),roundingMode:context.rounding_mode,numeratorDelta:BigInt(application.eligible_refund_amount_minor)*BigInt(context.points_numerator_per_minor!)})
        growthDelta=await accrual.applyExactCarry({membershipId:context.membership_id,policyVersionId:context.policy_version_id,currency:context.currency,rewardKind:'growth',denominator:BigInt(context.growth_denominator!),roundingMode:context.rounding_mode,numeratorDelta:BigInt(application.eligible_refund_amount_minor)*BigInt(context.growth_numerator_per_minor!)})
        if(points!==plan.points||growthDelta!==plan.growth)throw new Error('Loyalty carry changed after its locked recovery preview')
      }
      const restored=(await tx.query<{id:string}>(`INSERT INTO mbox.loyalty_recollection_restorations
        (tenant_id,store_id,award_id,application_id,order_id,refund_id,payment_id,eligible_amount_minor,points_delta,growth_delta,
         credited_points,released_recovery_points,expired_points,original_expires_at,policy_version_id,request_id,actor_ref,restored_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`,
      [tenantId,storeId,context.award_id,application.id,input.orderId,application.refund_id,settlement.payment_id,application.eligible_refund_amount_minor,points,growthDelta,plan.credited,plan.releasedDebt,plan.expired,context.expires_at,context.policy_version_id,input.requestId??null,input.actorRef,input.occurredAt])).rows[0]!
      available+=plan.credited;pending-=plan.releasedDebt;growth+=growthDelta
      if(points>0){
        const ledger=(await tx.query<{id:string}>(`INSERT INTO mbox.loyalty_point_ledger
          (tenant_id,store_id,membership_id,customer_id,entry_type,points_delta,balance_after,source_type,source_id,reason,expires_at,policy_version_id,order_id,payment_id,idempotency_key,occurred_at)
          VALUES($1,$2,$3,$4,'restore',$5,$6,'order',$7,'原普通退款经实际补收结清后的积分贡献恢复',$8,$9,$10,$11,$12,$13) RETURNING id`,
        [tenantId,storeId,context.membership_id,context.customer_id,points,available,restored.id,context.expires_at,context.policy_version_id,input.orderId,settlement.payment_id,`loyalty:recollection:${application.refund_id}:points`,input.occurredAt])).rows[0]!
        for(const lot of plan.lotReturns){
          await tx.query(`UPDATE mbox.loyalty_point_lots SET remaining_points=remaining_points+$4,status='available'
            WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND (expires_at IS NULL OR expires_at>$5::timestamptz)`,[tenantId,storeId,lot.lotId,lot.points,input.occurredAt])
          await tx.query(`INSERT INTO mbox.loyalty_point_lot_movements(tenant_id,store_id,lot_id,movement_type,points_delta,balance_after,source_type,source_id,idempotency_key,occurred_at)
            SELECT $1,$2,id,'restore',$4,remaining_points,'refund',$5,$6,$7 FROM mbox.loyalty_point_lots WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,
          [tenantId,storeId,lot.lotId,lot.points,application.refund_id,`lot:recollection:${application.refund_id}:${lot.movementId}`,input.occurredAt])
        }
        if(plan.extraPoints>0)await accrual.createPointLot({membershipId:context.membership_id,customerId:context.customer_id,sourceLedgerEntryId:ledger.id,sourceType:'supplement',sourceId:restored.id,points:plan.extraPoints,availableAt:input.occurredAt,expiresAt:context.expires_at,idempotencyKey:`lot:recollection:${application.refund_id}:carry`})
        if(plan.expired>0)await tx.query(`INSERT INTO mbox.loyalty_point_ledger
          (tenant_id,store_id,membership_id,customer_id,entry_type,points_delta,balance_after,source_type,source_id,reason,policy_version_id,order_id,payment_id,idempotency_key,occurred_at)
          VALUES($1,$2,$3,$4,'expire',$5,$6,'order',$7,'恢复原贡献时原积分期限已经届满，不延长有效期',$8,$9,$10,$11,$12)`,
        [tenantId,storeId,context.membership_id,context.customer_id,-plan.expired,available,restored.id,context.policy_version_id,input.orderId,settlement.payment_id,`loyalty:recollection:${application.refund_id}:expired`,input.occurredAt])
      }
      if(growthDelta>0)await tx.query(`INSERT INTO mbox.loyalty_growth_ledger
        (tenant_id,store_id,membership_id,customer_id,entry_type,growth_delta,balance_after,policy_version_id,order_id,payment_id,source_id,reason,idempotency_key,occurred_at)
        VALUES($1,$2,$3,$4,'supplement',$5,$6,$7,$8,$9,$10,'原普通退款经实际补收结清后的成长贡献恢复',$11,$12)`,
      [tenantId,storeId,context.membership_id,context.customer_id,growthDelta,growth,context.policy_version_id,input.orderId,settlement.payment_id,restored.id,`loyalty:recollection:${application.refund_id}:growth`,context.awarded_at])
      await tx.query(`UPDATE mbox.loyalty_order_awards SET restored_amount_minor=restored_amount_minor+$4,restored_points=restored_points+$5,restored_growth=restored_growth+$6
        WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,[tenantId,storeId,context.award_id,application.eligible_refund_amount_minor,points,growthDelta])
      if(context.calculation_model==='exact_carry')await tx.query(`UPDATE mbox.loyalty_order_reward_contributions SET restored_eligible_amount_minor=restored_eligible_amount_minor+$4 WHERE tenant_id=$1 AND store_id=$2 AND order_id=$3`,[tenantId,storeId,input.orderId,application.eligible_refund_amount_minor])
    }
    await tx.query(`UPDATE mbox.loyalty_accounts SET available_points=$4,pending_recovery_points=$5,growth_value=$6,
      redemption_status=CASE WHEN $5=0 AND redemption_status='suspended' THEN 'active' ELSE redemption_status END
      WHERE tenant_id=$1 AND store_id=$2 AND membership_id=$3`,[tenantId,storeId,context.membership_id,available,pending,growth])
    await tx.query('UPDATE mbox.customer_memberships SET points_balance=$4,lifetime_points=$5 WHERE tenant_id=$1 AND store_id=$2 AND id=$3',[tenantId,storeId,context.membership_id,available,growth])
    if(preview.growthDelta>0)await accrual.evaluateMembershipTier(context.membership_id,input.occurredAt,`recollection:${input.orderId}:${plans.at(-1)!.application.id}`)
    return {...preview,applied:true}
  }
  private async plan(orderId:string,occurredAt:string):Promise<{preview:LoyaltyRecoveryPreview;context?:Context;plans:Plan[]}>{
    const tx=this.transaction,{tenantId,storeId}=tx.scope,preview=empty()
    const context=(await tx.query<Context>(`SELECT award.id award_id,award.membership_id,member.member_no,award.customer_id,award.policy_version_id,award.currency,
      award.calculation_model,award.eligible_amount_minor::text,award.awarded_points,award.awarded_growth,award.reversed_amount_minor::text,
      award.reversed_points,award.reversed_growth,award.restored_amount_minor::text,award.restored_points,award.restored_growth,award.awarded_at::text,
      account.available_points,account.pending_recovery_points,account.growth_value,
      contribution.points_numerator_per_minor::text,contribution.points_denominator::text,contribution.growth_numerator_per_minor::text,contribution.growth_denominator::text,
      policy.rounding_mode,COALESCE((SELECT min(ledger.expires_at) FROM mbox.loyalty_point_ledger ledger
        WHERE ledger.tenant_id=award.tenant_id AND ledger.store_id=award.store_id AND ledger.order_id=award.order_id AND ledger.entry_type IN ('earn','supplement') AND ledger.refund_id IS NULL),award.awarded_at+make_interval(months=>policy.points_validity_months))::text expires_at
      FROM mbox.loyalty_order_awards award JOIN mbox.loyalty_accounts account
        ON (account.tenant_id,account.store_id,account.membership_id)=(award.tenant_id,award.store_id,award.membership_id)
      JOIN mbox.customer_memberships member ON (member.tenant_id,member.store_id,member.id)=(award.tenant_id,award.store_id,award.membership_id)
      JOIN mbox.loyalty_policy_versions policy ON (policy.tenant_id,policy.store_id,policy.id)=(award.tenant_id,award.store_id,award.policy_version_id)
      LEFT JOIN mbox.loyalty_order_reward_contributions contribution ON (contribution.tenant_id,contribution.store_id,contribution.order_id)=(award.tenant_id,award.store_id,award.order_id)
      WHERE award.tenant_id=$1 AND award.store_id=$2 AND award.order_id=$3 AND member.status='active'`,[tenantId,storeId,orderId])).rows[0]
    if(!context)return {preview,plans:[]}
    preview.membershipId=context.membership_id;preview.memberNo=context.member_no;preview.policyVersionId=context.policy_version_id;preview.expiresAt=context.expires_at
    const funds=await new RecommendationFinancialAttributionRepository(tx).previewRecollectedForOrder({orderId})
    preview.recoveryPaymentId=funds.recoveryPaymentId
    preview.basis=[context as unknown as JsonValue,...funds.basis]
    const applications=(await tx.query<Application>(`SELECT application.id,application.refund_id,application.eligible_refund_amount_minor::text,application.reversed_points,application.applied_at::text,
      (SELECT r.recollection_payment_id FROM mbox.order_recollection_item_restorations r WHERE r.tenant_id=$1 AND r.store_id=$2 AND r.order_id=$3 AND r.refund_id=application.refund_id ORDER BY r.order_item_id LIMIT 1) settled_payment_id,
      (SELECT min(r.settled_at)::text FROM mbox.order_recollection_item_restorations r WHERE r.tenant_id=$1 AND r.store_id=$2 AND r.order_id=$3 AND r.refund_id=application.refund_id) settled_at,
      COALESCE(movements.items,'[]'::jsonb) movements,application.reversed_points-COALESCE(movements.points,0)::integer debt_points,
      EXISTS(SELECT 1 FROM mbox.loyalty_point_ledger later WHERE later.tenant_id=$1 AND later.store_id=$2 AND later.membership_id=$4
        AND later.created_at>COALESCE((SELECT min(original_ledger.created_at) FROM mbox.loyalty_point_ledger original_ledger
          WHERE original_ledger.tenant_id=$1 AND original_ledger.store_id=$2 AND original_ledger.refund_id=application.refund_id
            AND original_ledger.entry_type='reverse' AND original_ledger.promotion_award_id IS NULL),application.created_at)
        AND later.points_delta>0 AND later.entry_type IN ('earn','supplement','adjust')) intervening_debt_credit
      FROM mbox.loyalty_award_refund_applications application
      JOIN mbox.order_recollection_refund_obligations obligation ON (obligation.tenant_id,obligation.store_id,obligation.order_id,obligation.refund_id)=(application.tenant_id,application.store_id,application.order_id,application.refund_id)
      LEFT JOIN LATERAL(SELECT sum(-m.points_delta) points,jsonb_agg(jsonb_build_object('id',m.id,'lotId',m.lot_id,'points',-m.points_delta,'expiresAt',lot.expires_at) ORDER BY lot.expires_at NULLS LAST,lot.available_at,m.id) items
        FROM mbox.loyalty_point_lot_movements m JOIN mbox.loyalty_point_lots lot ON (lot.tenant_id,lot.store_id,lot.id)=(m.tenant_id,m.store_id,m.lot_id)
        WHERE m.tenant_id=$1 AND m.store_id=$2 AND m.source_type='refund' AND m.source_id=application.refund_id::text AND m.movement_type='reverse') movements ON true
      WHERE application.tenant_id=$1 AND application.store_id=$2 AND application.order_id=$3
        AND application.eligible_refund_amount_minor>0
        AND NOT EXISTS(SELECT 1 FROM mbox.loyalty_recollection_restorations restored WHERE restored.tenant_id=$1 AND restored.store_id=$2 AND restored.application_id=application.id)
      ORDER BY application.applied_at,application.id`,[tenantId,storeId,orderId,context.membership_id])).rows
    const plans:Plan[]=[],eligible=applications.filter(a=>a.settled_payment_id||funds.eligible&&funds.items.some(i=>i.refundId===a.refund_id))
    preview.basis.push(...applications as unknown as JsonValue[])
    if(!eligible.length)return {preview,context,plans}
    if(!preview.recoveryPaymentId)preview.recoveryPaymentId=eligible[0]!.settled_payment_id
    const unknownPayment=await tx.query(`SELECT 1 FROM mbox.payments payment
      WHERE payment.tenant_id=$1 AND payment.store_id=$2
        AND (payment.order_id=$3 OR EXISTS(SELECT 1 FROM mbox.order_payment_allocations allocation
          WHERE (allocation.tenant_id,allocation.store_id,allocation.batch_id,allocation.order_id)=($1,$2,payment.order_batch_id,$3)))
        AND (payment.status IN ('created','pending') OR EXISTS(SELECT 1 FROM mbox.verified_provider_observations observation
          WHERE observation.tenant_id=$1 AND observation.store_id=$2 AND observation.payment_id=payment.id
            AND observation.observed_status='payment_succeeded' AND observation.consumed_at IS NULL)) LIMIT 1`,[tenantId,storeId,orderId])
    if(unknownPayment.rowCount){preview.status='ineligible';preview.blockReasons=['PAYMENT_OUTCOME_UNRESOLVED'];return {preview,context,plans}}
    const unknownRefund=await tx.query(`SELECT 1 FROM mbox.verified_provider_observations observation
      JOIN mbox.order_refund_facts refund ON (refund.tenant_id,refund.store_id,refund.id)=(observation.tenant_id,observation.store_id,observation.refund_id)
      WHERE observation.tenant_id=$1 AND observation.store_id=$2 AND refund.order_id=$3
        AND observation.observed_status='refund_succeeded' AND observation.consumed_at IS NULL LIMIT 1`,[tenantId,storeId,orderId])
    if(unknownRefund.rowCount){preview.status='ineligible';preview.blockReasons=['REFUND_OUTCOME_UNRESOLVED'];return {preview,context,plans}}
    if((await tx.query('SELECT 1 FROM mbox.loyalty_unresolved_refund_reviews WHERE tenant_id=$1 AND store_id=$2 AND order_id=$3 LIMIT 1',[tenantId,storeId,orderId])).rowCount){preview.status='refund_review_required';preview.blockReasons=['LOYALTY_REFUND_REVIEW_REQUIRED'];return {preview,context,plans}}
    const carryRows=(await tx.query<{reward_kind:'points'|'growth';denominator:string;remainder_numerator:string}>(`SELECT reward_kind,denominator::text,remainder_numerator::text FROM mbox.loyalty_reward_carry_balances WHERE tenant_id=$1 AND store_id=$2 AND membership_id=$3 AND policy_version_id=$4 AND currency=$5 ORDER BY reward_kind`,[tenantId,storeId,context.membership_id,context.policy_version_id,context.currency])).rows
    preview.basis.push(...carryRows as unknown as JsonValue[])
    const carries=new Map(carryRows.map(r=>[r.reward_kind,{denominator:BigInt(r.denominator),remainder:BigInt(r.remainder_numerator)}]))
    let netAmount=Number(context.reversed_amount_minor)-Number(context.restored_amount_minor),netPoints=context.reversed_points-context.restored_points,netGrowth=context.reversed_growth-context.restored_growth,pending=context.pending_recovery_points
    for(const application of eligible){
      const amount=Number(application.eligible_refund_amount_minor)
      if(amount>netAmount)throw new Error('Loyalty recollection exceeds the remaining reversed contribution')
      const points=context.calculation_model==='exact_carry'?carryDelta(carries,'points',context.points_denominator!,context.points_numerator_per_minor!,amount,context.rounding_mode):netPoints-proportion(context.awarded_points,netAmount-amount,Number(context.eligible_amount_minor))
      const growth=context.calculation_model==='exact_carry'?carryDelta(carries,'growth',context.growth_denominator!,context.growth_numerator_per_minor!,amount,context.rounding_mode):netGrowth-proportion(context.awarded_growth,netAmount-amount,Number(context.eligible_amount_minor))
      netAmount-=amount;netPoints-=points;netGrowth-=growth
      if(application.debt_points<0)throw new Error('Original loyalty refund movements exceed its point reversal')
      if(application.debt_points>0&&application.intervening_debt_credit){preview.status='rule_pending';preview.blockReasons=['LOYALTY_RECOLLECTION_DEBT_EXPIRY_RULE_PENDING'];return {preview,context,plans:[]}}
      const releasedDebt=Math.min(points,application.debt_points)
      if(releasedDebt>pending)throw new Error('Original loyalty recovery debt cannot be uniquely recovered')
      pending-=releasedDebt
      let remaining=points-releasedDebt,credited=0,expired=0
      const lotReturns:Plan['lotReturns']=[]
      for(const movement of application.movements){
        const count=Math.min(remaining,movement.points);remaining-=count
        if(count===0)continue
        if(movement.expiresAt&&Date.parse(movement.expiresAt)<=Date.parse(occurredAt))expired+=count
        else{credited+=count;lotReturns.push({movementId:movement.id,lotId:movement.lotId,points:count,expiresAt:movement.expiresAt})}
      }
      const extraPoints=context.expires_at&&Date.parse(context.expires_at)<=Date.parse(occurredAt)?0:remaining
      credited+=extraPoints;expired+=remaining-extraPoints
      plans.push({application,points,growth,releasedDebt,credited,expired,lotReturns,extraPoints})
      preview.eligibleAmountMinor+=amount;preview.pointsDelta+=points;preview.growthDelta+=growth;preview.availablePointsDelta+=credited;preview.pendingRecoveryPointsDelta-=releasedDebt
    }
    const control=await new LoyaltyOperationalControlRepository(tx).state('points_accrual')
    preview.basis.push({pointsAccrualState:control.state})
    preview.status=control.state==='paused'?'ineligible':'ready';if(control.state==='paused')preview.blockReasons=['LOYALTY_POINTS_ACCRUAL_PAUSED']
    return {preview,context,plans}
  }
}
function proportion(points:number,amount:number,total:number){return total===0?0:Number(BigInt(points)*BigInt(amount)/BigInt(total))}
function carryDelta(carries:Map<'points'|'growth',Carry>,kind:'points'|'growth',denominatorText:string,numeratorText:string,amount:number,rounding:'floor'|'nearest'){
  const ratio=BigInt(denominatorText),carry=carries.get(kind)??{denominator:ratio,remainder:0n}
  let a=carry.denominator,b=ratio;while(b!==0n)[a,b]=[b,a%b]
  const denominator=carry.denominator/a*ratio,total=carry.remainder*(denominator/carry.denominator)+BigInt(amount)*BigInt(numeratorText)*(denominator/ratio)
  const numerator=rounding==='nearest'?total+denominator/2n:total
  const delta=numerator>=0n?numerator/denominator:-((-numerator+denominator-1n)/denominator)
  carries.set(kind,{denominator,remainder:total-delta*denominator})
  const value=Number(delta);if(!Number.isSafeInteger(value)||value<0||value>2_000_000_000)throw new Error('Loyalty recovery contribution outside supported range')
  return value
}
