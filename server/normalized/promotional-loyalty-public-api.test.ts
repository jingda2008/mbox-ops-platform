import Fastify from 'fastify'
import {describe,expect,it,vi} from 'vitest'
import{
  PromotionalLoyaltyPublicQuery,promotionalLoyaltyPublicApiPlugin,
}from'./promotional-loyalty-public-api.js'

const scope={tenantId:'11111111-1111-4111-8111-111111111111',storeId:'22222222-2222-4222-8222-222222222222'}

describe('public promotional loyalty benefits',()=>{
  it('returns display-safe typed benefits and explicitly says viewing does not enroll',async()=>{
    const activityBenefits=vi.fn(async()=>[{
      campaignCode:'SUPERHIGH-AUG',name:'超嗨活动到场积分',triggerKind:'activity_check_in' as const,
      points:60,minimumPaidAmountMinor:0,pointValidityDays:180,
      refundPolicy:'reverse_on_any_refund' as const,eligibleMemberLevels:['member','silver','gold'],
      effectiveFrom:'2026-08-20T10:00:00.000Z',effectiveUntil:null,
    }])
    const app=Fastify()
    await app.register(promotionalLoyaltyPublicApiPlugin,{
      query:{activityBenefits}as unknown as PromotionalLoyaltyPublicQuery,resolveScope:()=>scope,
      now:()=> '2026-08-20T12:00:00.000Z',
    })
    const response=await app.inject({method:'GET',url:'/public/community-activities/activity-superhigh-001/loyalty-benefits'})
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      data:[{triggerKind:'activity_check_in',points:60,pointValidityDays:180}],
      meta:{membershipRequired:true,automaticEnrollment:false},
    })
    expect(activityBenefits).toHaveBeenCalledWith(scope,'activity-superhigh-001','2026-08-20T12:00:00.000Z')
  })

  it('queries only published strong fields and rejects invalid public identifiers',async()=>{
    const queries:string[]=[]
    const query=new PromotionalLoyaltyPublicQuery({run:async(_scope,callback)=>callback({
      query:async(sql:string)=>{queries.push(sql);return{rows:[],rowCount:0}},scope,
    }as never)})
    await expect(query.activityBenefits(scope,'activity-superhigh-001','2026-08-20T12:00:00.000Z')).resolves.toEqual([])
    expect(queries.join('\n')).toContain("policy.status='published'")
    expect(queries.join('\n')).toContain('rule.minimum_paid_amount_minor')
    expect(queries.join('\n')).toContain('policy.eligible_member_levels')
    expect(queries.join('\n')).not.toMatch(/provider_snapshot|audience_rule|sales_copy/)

    const app=Fastify()
    await app.register(promotionalLoyaltyPublicApiPlugin,{query,resolveScope:()=>scope})
    const invalid=await app.inject({method:'GET',url:'/public/community-activities/bad%20id/loyalty-benefits'})
    expect(invalid.statusCode).toBe(400)
  })
})
