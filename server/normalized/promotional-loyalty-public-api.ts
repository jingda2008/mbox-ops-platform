import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import type { ScopedPostgresTransactionRunner, StoreScope } from './transaction-runner.js'

interface PublicBenefitRow extends Record<string,unknown>{
  campaign_code:string
  name:string
  rule_code:string
  trigger_kind:'activity_payment'|'activity_check_in'|'activity_completion'
  points:number
  minimum_paid_amount_minor:string|number
  point_validity_days:number
  refund_policy:'reverse_on_any_refund'|'reverse_on_full_refund'
  eligible_member_levels:string[]
  effective_from:string
  effective_until:string|null
}

export interface PublicActivityLoyaltyBenefit {
  campaignCode:string
  name:string
  ruleCode:string
  triggerKind:'activity_payment'|'activity_check_in'|'activity_completion'
  points:number
  minimumPaidAmountMinor:number
  pointValidityDays:number
  refundPolicy:'reverse_on_any_refund'|'reverse_on_full_refund'
  eligibleMemberLevels:string[]
  effectiveFrom:string
  effectiveUntil:string|null
}

export class PromotionalLoyaltyPublicQuery {
  constructor(private readonly transactions:Pick<ScopedPostgresTransactionRunner,'run'>){}

  activityBenefits(scope:Readonly<StoreScope>,activityPublicId:string,at:string){
    return this.transactions.run(scope,async(transaction)=>{
      const result=await transaction.query<PublicBenefitRow>(`
        SELECT policy.campaign_code,policy.name,rule.rule_code,rule.trigger_kind,rule.points,
          rule.minimum_paid_amount_minor,policy.point_validity_days,
          policy.refund_policy,policy.eligible_member_levels,
          policy.effective_from::text,policy.effective_until::text
        FROM mbox.community_activities activity
        JOIN mbox.loyalty_promotion_policy_versions policy
          ON policy.tenant_id=activity.tenant_id AND policy.store_id=activity.store_id
         AND policy.activity_id=activity.id AND policy.status='published'
         AND policy.effective_from<=$4::timestamptz
         AND (policy.effective_until IS NULL OR policy.effective_until>$4::timestamptz)
        JOIN mbox.loyalty_promotion_rules rule
          ON rule.tenant_id=policy.tenant_id AND rule.store_id=policy.store_id
         AND rule.policy_version_id=policy.id AND rule.enabled
        WHERE activity.tenant_id=$1::uuid AND activity.store_id=$2::uuid
          AND activity.public_id=$3 AND activity.status IN ('published','full','completed')
        ORDER BY policy.priority DESC,policy.campaign_code,rule.rule_code,rule.id
      `,[scope.tenantId,scope.storeId,activityPublicId,at])
      return result.rows.map((row):PublicActivityLoyaltyBenefit=>({
        campaignCode:row.campaign_code,name:row.name,ruleCode:row.rule_code,triggerKind:row.trigger_kind,
        points:Number(row.points),minimumPaidAmountMinor:Number(row.minimum_paid_amount_minor),
        pointValidityDays:Number(row.point_validity_days),refundPolicy:row.refund_policy,
        eligibleMemberLevels:[...row.eligible_member_levels],effectiveFrom:row.effective_from,
        effectiveUntil:row.effective_until,
      }))
    },{readOnly:true})
  }
}

export interface PromotionalLoyaltyPublicApiOptions{
  query:PromotionalLoyaltyPublicQuery
  resolveScope(request:FastifyRequest):Readonly<StoreScope>|Promise<Readonly<StoreScope>>
  now?():string
}

export const promotionalLoyaltyPublicApiPlugin:FastifyPluginAsync<PromotionalLoyaltyPublicApiOptions>=async(app,options)=>{
  app.get<{Params:{activityPublicId:string}}>(
    '/public/community-activities/:activityPublicId/loyalty-benefits',
    async(request,reply)=>handle(reply,async()=>{
      const publicId=identifier(request.params.activityPublicId)
      const data=await options.query.activityBenefits(
        await options.resolveScope(request),publicId,options.now?.()??new Date().toISOString(),
      )
      return reply.send({data,meta:{membershipRequired:true,automaticEnrollment:false}})
    }),
  )
}

async function handle(reply:FastifyReply,execute:()=>Promise<unknown>){
  try{return await execute()}catch(error){
    if(error instanceof PublicPromotionInputError){
      return reply.code(400).send({error:{code:'LOYALTY_PROMOTION_INVALID_INPUT',message:error.message}})
    }
    throw error
  }
}
class PublicPromotionInputError extends Error{}
function identifier(value:unknown){
  if(typeof value!=='string'||value.length<8||value.length>128||!/^[A-Za-z0-9][A-Za-z0-9_.:-]+$/.test(value)){
    throw new PublicPromotionInputError('活动编号格式无效')
  }
  return value
}
