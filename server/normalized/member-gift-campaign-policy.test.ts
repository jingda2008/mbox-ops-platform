import {describe,it,expect} from 'vitest'
import {parseMemberGiftCampaign,assessGiftBudget,giftBudgetDate} from './member-gift-campaign-policy.js'
const id='11111111-1111-4111-8111-111111111111'
const input={trigger:'card_entry',cardProjectId:id,audience:{minimumTier:'member',cardCodes:['MUSIC'],cardMatch:'any',tierAndCards:'and'},
  quantityPerCustomer:2,maximumQuantity:100,maximumDailyQuantity:20,maximumCostMinor:50000,maximumDailyCostMinor:10000,maximumUnitCostMinor:500,currency:'CNY',budgetDateBasis:'natural',budgetDayStartMinute:0,
  availableFrom:'2026-09-09T00:00:00+08:00',availableUntil:'2026-10-01T00:00:00+08:00',couponCalendarVersionId:id,productIds:[id]}
const zero={quantity:0,dailyQuantity:0,costMinor:0,dailyCostMinor:0}
describe('member gift campaign budgets are explicit obligations',()=>{
  it('keeps a fixed 9.9 yuan selling price distinct from a free gift or a cash deduction',()=>{
    expect(parseMemberGiftCampaign(input)).toMatchObject({pricingKind:'free',fixedPriceMinor:null,stackingVersionId:null})
    const rule=parseMemberGiftCampaign({...input,pricingKind:'fixed_price',fixedPriceMinor:990,stackingVersionId:id})
    expect(rule).toMatchObject({pricingKind:'fixed_price',fixedPriceMinor:990,stackingVersionId:id})
    expect(assessGiftBudget(rule,zero,400)).toEqual({allowed:true,quantity:2,estimatedCostMinor:800})
  })
  it.each([{pricingKind:'fixed_price',fixedPriceMinor:0,stackingVersionId:id},
    {pricingKind:'fixed_price',fixedPriceMinor:9.9,stackingVersionId:id},
    {pricingKind:'fixed_price',fixedPriceMinor:990,stackingVersionId:null},
    {pricingKind:'free',fixedPriceMinor:990},{pricingKind:'deduct',fixedPriceMinor:990}])('rejects ambiguous price promises %j',override=>{
    expect(()=>parseMemberGiftCampaign({...input,...override})).toThrow()
  })
  it('keeps grant budget dates separate from coupon redemption windows',()=>{
    const rule=parseMemberGiftCampaign({...input,budgetDateBasis:'business',budgetDayStartMinute:360})
    expect(giftBudgetDate(rule,new Date('2026-09-10T05:59:59+08:00'))).toBe('2026-09-09')
    expect(giftBudgetDate(rule,new Date('2026-09-10T06:00:00+08:00'))).toBe('2026-09-10')
  })
  it('does not lose integer precision when multiplying a high cost by multiple units',()=>{
    const rule=parseMemberGiftCampaign({...input,maximumUnitCostMinor:Number.MAX_SAFE_INTEGER,maximumCostMinor:Number.MAX_SAFE_INTEGER,maximumDailyCostMinor:Number.MAX_SAFE_INTEGER})
    expect(assessGiftBudget(rule,zero,Number.MAX_SAFE_INTEGER)).toEqual({allowed:false,reason:'campaign_cost_exceeded'})
  })
  it('separates two free goods estimated ingredient cost from nominal value and revenue',()=>{
    expect(assessGiftBudget(parseMemberGiftCampaign(input),zero,400)).toEqual({allowed:true,quantity:2,estimatedCostMinor:800})
  })
  it('never treats missing cost as zero',()=>{
    expect(assessGiftBudget(parseMemberGiftCampaign(input),zero,null)).toEqual({allowed:false,reason:'cost_unknown'})
  })
  it.each([
    [{...zero,quantity:99},'campaign_quantity_exceeded'],[{...zero,dailyQuantity:19},'daily_quantity_exceeded'],
    [{...zero,costMinor:49999},'campaign_cost_exceeded'],[{...zero,dailyCostMinor:9999},'daily_cost_exceeded'],
  ] as const)('refuses over-budget grant without silently granting a partial quantity', (usage,reason)=>{
    expect(assessGiftBudget(parseMemberGiftCampaign(input),usage,400)).toEqual({allowed:false,reason})
  })
  it('blocks a changed product whose actual cost exceeds the approved unit ceiling',()=>{
    expect(assessGiftBudget(parseMemberGiftCampaign(input),zero,501)).toEqual({allowed:false,reason:'unit_cost_exceeded'})
  })
  it.each([{quantityPerCustomer:0},{maximumQuantity:1},{maximumDailyCostMinor:50001},{currency:'USD'},
    {audience:{minimumTier:null,cardCodes:[],cardMatch:'any',tierAndCards:'and'}},{cardProjectId:null},{productIds:[]},{productIds:[id,id]}])('rejects incomplete or contradictory policy %j',override=>{
    expect(()=>parseMemberGiftCampaign({...input,...override})).toThrow()
  })
  it('does not mutate configuration or usage when calculating',()=>{
    const before=structuredClone(input),usage=structuredClone(zero)
    assessGiftBudget(parseMemberGiftCampaign(input),usage,400)
    expect(input).toEqual(before);expect(usage).toEqual(zero)
  })
})
