import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  PromotionalLoyaltyService,
  type PromotionPolicyDraftInput,
} from './promotional-loyalty-service.js'

const context={
  scope:{tenantId:'11111111-1111-4111-8111-111111111111',storeId:'22222222-2222-4222-8222-222222222222'},
  employeeId:'33333333-3333-4333-8333-333333333333',businessDate:'2026-08-16',
}

describe('promotional loyalty service contract',()=>{
  it('rejects a payment threshold on a non-payment trigger before any command or write',()=>{
    const execute=vi.fn()
    const service=new PromotionalLoyaltyService({run:vi.fn()}, {execute})
    const input=validDraft()
    input.rules=[{...input.rules[0]!,minimumPaidAmountMinor:100}]
    expect(()=>service.draft(context,input)).toThrow('只有付款触发规则可以设置最低付款金额')
    expect(execute).not.toHaveBeenCalled()
  })

  it('rejects duplicate rules and a member exposure above the configured cap',()=>{
    const service=new PromotionalLoyaltyService({run:vi.fn()}, {execute:vi.fn()})
    const duplicate=validDraft()
    duplicate.rules=[duplicate.rules[0]!,{...duplicate.rules[0]!,triggerKind:'activity_completion'}]
    expect(()=>service.draft(context,duplicate)).toThrow('同一版本内规则编号不能重复')

    const excessive=validDraft()
    excessive.perMemberPointsLimit=100
    excessive.rules=[{...excessive.rules[0]!,points:60,perMemberAwardLimit:2}]
    expect(()=>service.draft(context,excessive)).toThrow('所有已启用规则的最大累计积分不能超过每会员积分上限')
  })

  it('keeps runtime decisions in typed columns and enforces three-person publication',()=>{
    const source=readFileSync(new URL('./promotional-loyalty-service.ts',import.meta.url),'utf8')
    expect(source).toContain("status='approved'")
    expect(source).toContain('drafted_by_employee_id<>$4::uuid')
    expect(source).toContain('context.employeeId === policy.drafted_by_employee_id')
    expect(source).toContain('context.employeeId === policy.approved_by_employee_id')
    for(const field of ['store_budget_points','per_member_points_limit','point_validity_days','refund_policy','budget_reuse_after_refund','member_limit_reuse_after_refund','eligible_member_levels']){
      expect(source).toContain(field)
    }
    expect(source).not.toMatch(/provider_snapshot|audience_rule|sales_copy|activity_details/)
  })
})

function validDraft():PromotionPolicyDraftInput{return{
  campaignCode:'SUPERHIGH-AUG',name:'超嗨活动到场积分',activityId:'44444444-4444-4444-8444-444444444444',
  stackingGroup:'SUPERHIGH',stackingMode:'exclusive_highest',priority:100,storeBudgetPoints:10000,
  perMemberPointsLimit:200,pointValidityDays:180,refundPolicy:'reverse_on_any_refund',
  budgetReuseAfterRefund:false,eligibleMemberLevels:['member','silver','gold'],
  memberLimitReuseAfterRefund:false,
  rules:[{ruleCode:'CHECKIN',triggerKind:'activity_check_in',points:60,perMemberAwardLimit:1,minimumPaidAmountMinor:0,enabled:true}],
  reason:'限定预算试运行并观察活动完成质量',idempotencyKey:'promotion-draft-0001',
}}
