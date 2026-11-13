import { describe, expect, it } from 'vitest'
import { channelRuleSchema, channelManagementSchemas, channelStoreLimitsSchema } from '../../src/shared/channel-distribution.js'
import { allocateChannelAmount, assertChannelActivation, assertChannelClaimCapacity, channelCommissionDelta, channelDiscountTarget, requireChannelWindow } from './channel-distribution-policy.js'

const rule = channelRuleSchema.parse({title:'饭后续聚',totalClaims:3,perCustomerClaims:1,perVisitUses:1,claimFrom:'2026-11-12T18:00:00+08:00',claimUntil:'2026-11-12T23:00:00+08:00',useFrom:'2026-11-12T18:00:00+08:00',useUntil:'2026-11-13T02:00:00+08:00',minimumMinor:10000,eligibleProductIds:['11111111-1111-4111-8111-111111111111'],offer:{kind:'credit',amountMinor:1000}})
const now = new Date('2026-11-12T20:00:00+08:00')
const activation = {rule,now,couponCustomerId:'a',verifiedCustomerId:'a',atCurrentVisit:true,usedAndHeld:0,lockedVisitLimit:null,existingSource:null,source:'s',existingCampaign:null,campaign:'c'}
describe('channel shared authority policy',()=>{
  it('conserves allocations and line bounds across 500 reproducible baskets',()=>{
    let seed=20261112
    const random=(max:number)=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%max}
    for(let sample=0;sample<500;sample++){
      const lines=Array.from({length:1+random(20)},(_,i)=>({id:`item-${i}`,basisMinor:random(100000)}))
      const total=lines.reduce((n,l)=>n+l.basisMinor,0),amount=random(total+1)
      const allocated=allocateChannelAmount(amount,lines)
      expect(allocated.reduce((n,l)=>n+l.amountMinor,0)).toBe(amount)
      allocated.forEach((l,i)=>{expect(Number.isSafeInteger(l.amountMinor)).toBe(true);expect(l.amountMinor).toBeGreaterThanOrEqual(0);expect(l.amountMinor).toBeLessThanOrEqual(lines[i]!.basisMinor)})
      expect([...allocated].sort((a,b)=>a.id.localeCompare(b.id))).toEqual(allocateChannelAmount(amount,[...lines].reverse()).sort((a,b)=>a.id.localeCompare(b.id)))
    }
  })
  it('reverses 500 split-refund sequences to zero without cumulative rounding drift',()=>{
    let seed=712
    const random=(max:number)=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%max}
    for(let sample=0;sample<500;sample++){
      let remaining=1+random(100000000),accrued=0
      const rate=random(10001),initial=channelCommissionDelta(remaining,rate,0).targetMinor
      accrued=initial
      for(let part=0;part<12;part++){
        remaining-=part===11?remaining:random(remaining+1)
        const next=channelCommissionDelta(remaining,rate,accrued)
        expect(next.deltaMinor).toBeLessThanOrEqual(0)
        accrued+=next.deltaMinor
        expect(accrued).toBe(Number((BigInt(remaining)*BigInt(rate)+5000n)/10000n))
        expect(channelCommissionDelta(remaining,rate,accrued).deltaMinor).toBe(0)
      }
      expect(accrued).toBe(0)
    }
  })
  it('rejects impossible time, zero quotas, duplicate products and unknown fields',()=>{
    for(const patch of [{totalClaims:0},{perCustomerClaims:4},{claimUntil:rule.claimFrom},{useUntil:rule.claimUntil,useFrom:rule.useUntil},{claimUntil:'2026-11-13T03:00:00+08:00'},{eligibleProductIds:[rule.eligibleProductIds[0],rule.eligibleProductIds[0]]},{unlimited:true}]) expect(channelRuleSchema.safeParse({...rule,...patch}).success).toBe(false)
  })
  it('uses inclusive start, exclusive end, including midnight',()=>{
    expect(()=>requireChannelWindow(rule.useFrom,rule.useUntil,new Date(rule.useFrom))).not.toThrow()
    expect(()=>requireChannelWindow(rule.useFrom,rule.useUntil,new Date(rule.useUntil))).toThrow('有效时间')
    expect(()=>requireChannelWindow(rule.useFrom,rule.useUntil,new Date('2026-11-13T01:59:59+08:00'))).not.toThrow()
    expect(()=>requireChannelWindow(rule.useFrom,rule.useUntil,new Date('invalid'))).toThrow()
  })
  it.each([{issued:3},{customerIssued:1},{poolRemaining:0},{capacityRemaining:0},{paused:true}])('blocks a new claim when %j',patch=>{
    expect(()=>assertChannelClaimCapacity({rule,now,issued:0,customerIssued:0,poolRemaining:3,capacityRemaining:3,paused:false,...patch})).toThrow()
  })
  it('allows an issued promise after the claim deadline with no issuance counter',()=>{
    expect(()=>assertChannelActivation({...activation,now:new Date('2026-11-13T01:00:00+08:00')})).not.toThrow()
  })
  it.each([{verifiedCustomerId:'b'},{atCurrentVisit:false},{usedAndHeld:1},{existingSource:'other',existingCampaign:'c'},{existingSource:'s',existingCampaign:'other'}])('rejects invalid activation %j',patch=>expect(()=>assertChannelActivation({...activation,...patch})).toThrow())
  it('a new larger limit cannot relax a visit; smaller limits still apply',()=>{
    expect(()=>assertChannelActivation({...activation,rule:{...rule,perVisitUses:2},lockedVisitLimit:1,usedAndHeld:1})).toThrow()
    expect(()=>assertChannelActivation({...activation,lockedVisitLimit:2,usedAndHeld:1})).toThrow()
  })
  it('computes the agreed refund example and full reversal',()=>{
    expect(channelCommissionDelta(70000,1000,9000)).toEqual({targetMinor:7000,deltaMinor:-2000})
    expect(channelCommissionDelta(0,1000,7000)).toEqual({targetMinor:0,deltaMinor:-7000})
    expect(channelCommissionDelta(70000,1000,7000).deltaMinor).toBe(0)
  })
  it('uses exact integer math and rejects unsafe or negative bases',()=>{
    expect(channelCommissionDelta(5,1000,0).targetMinor).toBe(1)
    expect(channelCommissionDelta(Number.MAX_SAFE_INTEGER,10000,0).targetMinor).toBe(Number.MAX_SAFE_INTEGER)
    for(const n of [-1,0.5,NaN,Infinity])expect(()=>channelCommissionDelta(n,1000,0)).toThrow()
  })
  it('conserves pennies independently of caller line order',()=>{
    const lines=[{id:'b',basisMinor:1},{id:'a',basisMinor:1},{id:'c',basisMinor:1}]
    expect(allocateChannelAmount(2,lines)).toEqual([{id:'b',amountMinor:1},{id:'a',amountMinor:1},{id:'c',amountMinor:0}])
    expect(allocateChannelAmount(2,[...lines].reverse()).sort((a,b)=>a.id.localeCompare(b.id))).toEqual(allocateChannelAmount(2,lines).sort((a,b)=>a.id.localeCompare(b.id)))
    expect(()=>allocateChannelAmount(4,lines)).toThrow()
    expect(()=>allocateChannelAmount(1,[lines[0]!,lines[0]!])).toThrow()
  })
  it('caps discounts cumulatively and never turns gift quantity into money',()=>{
    expect(channelDiscountTarget(rule,9999)).toBe(0)
    expect(channelDiscountTarget(rule,20000)).toBe(1000)
    expect(channelDiscountTarget({...rule,offer:{kind:'discount',discountBps:1000,maximumMinor:1500}},20000)).toBe(1500)
    expect(channelDiscountTarget({...rule,offer:{kind:'gift',productId:rule.eligibleProductIds[0]!,quantity:2,costMinor:500}},20000)).toBe(0)
  })
  it.each([
    {rate:1000,basis:10000,cap:5000,expected:1000},
    {rate:1500,basis:10000,cap:5000,expected:1500},
    {rate:1500,basis:20000,cap:2000,expected:2000},
    {rate:1500,basis:33,cap:5000,expected:5},
    {rate:10000,basis:10000,cap:20000,expected:10000},
  ])('uses reduction basis points without confusing payable rate: %j',({rate,basis,cap,expected})=>{
    const discountRule=channelRuleSchema.parse({...rule,minimumMinor:0,offer:{kind:'discount',discountBps:rate,maximumMinor:cap}})
    expect(channelDiscountTarget(discountRule,basis)).toBe(expected)
  })
  it.each([{discountBps:0,maximumMinor:100},{discountBps:10001,maximumMinor:100},{discountBps:1500.5,maximumMinor:100},{discountBps:1500,maximumMinor:0}])('rejects invalid discount settings %j',offer=>{
    expect(channelRuleSchema.safeParse({...rule,offer:{kind:'discount',...offer}}).success).toBe(false)
  })

  it.each([
    {totalClaims:1000001},{perCustomerClaims:0},{perVisitUses:101},{perVisitUses:1.5},
    {minimumMinor:-1},{minimumMinor:0.1},{minimumMinor:1000000001},
    {commissionBps:-1},{commissionBps:10001},{commissionBps:100.5},{observationDays:-1},{observationDays:91},{observationDays:1.5},
    {eligibleProductIds:[]},{commissionProductIds:[]},
    {offer:{kind:'gift',productId:rule.eligibleProductIds[0],quantity:101,costMinor:100}},
    {offer:{kind:'credit',amountMinor:1,discountBps:1000}},
  ])('rejects out-of-contract configuration %j',patch=>expect(channelRuleSchema.safeParse({...rule,...patch}).success).toBe(false))
  it('accepts exact quota, money, commission and observation boundaries',()=>{
    for(const commissionBps of [0,10000])for(const observationDays of [0,90])expect(channelRuleSchema.safeParse({...rule,totalClaims:1000000,perCustomerClaims:1000000,perVisitUses:100,minimumMinor:1000000000,commissionBps,observationDays}).success).toBe(true)
  })
  it.each([0,1,1000000])('shares store cap contract at %i including an intentional pause',n=>{
    expect(channelStoreLimitsSchema.parse({action:'limits',claimLimit:n,capacityLimit:n,costLimitMinor:0,reason:'  配额依据  '})).toMatchObject({claimLimit:n,capacityLimit:n,costLimitMinor:0,reason:'配额依据'})
  })
  it.each([-1,1.5,1000001,NaN,Infinity])('rejects invalid store/campaign counts %s in the shared front and back contract',n=>{
    expect(channelStoreLimitsSchema.safeParse({action:'limits',claimLimit:n,capacityLimit:10,costLimitMinor:100,reason:'依据'}).success).toBe(false)
    expect(channelManagementSchemas.campaign.safeParse({title:'活动',claimLimit:n,capacityLimit:10,costLimitMinor:100,reason:'依据'}).success).toBe(false)
  })
  it('requires partner identities, contract and follow-up fields before writing',()=>{
    expect(channelManagementSchemas.partner.safeParse({name:'甲',settlementSubject:'公司',promoterName:'店长',reason:'登记'}).success).toBe(false)
    expect(channelManagementSchemas.partner.safeParse({name:'餐厅',settlementSubject:' ',promoterName:'店长',reason:'登记'}).success).toBe(false)
    expect(channelManagementSchemas.batch.safeParse({campaignId:rule.eligibleProductIds[0],promoterId:rule.eligibleProductIds[0],rule,contract:{version:'',settlementSubject:'公司',terms:'条款'},reason:'创建'}).success).toBe(false)
    expect(channelManagementSchemas.followup.safeParse({promoterId:rule.eligibleProductIds[0],batchId:null,kind:'fake-sent',note:'收到',nextContactAt:null}).success).toBe(false)
  })

  it('defaults missing stacking configuration to off with no total cap',()=>{
    const {allowStacking:_allow,visitDiscountCapMinor:_cap,...legacy}=rule
    expect(channelRuleSchema.parse(legacy)).toMatchObject({allowStacking:false,visitDiscountCapMinor:null})
  })
  it.each([0,-1,0.5,1000000001])('rejects invalid party discount cap %s',cap=>{
    expect(channelRuleSchema.safeParse({...rule,allowStacking:true,visitDiscountCapMinor:cap}).success).toBe(false)
  })
  it('requires an enabled stacking flag for a total cap and accepts exact valid bounds',()=>{
    expect(channelRuleSchema.safeParse({...rule,allowStacking:false,visitDiscountCapMinor:100}).success).toBe(false)
    for(const cap of [null,1,1000000000])expect(channelRuleSchema.parse({...rule,allowStacking:true,visitDiscountCapMinor:cap})).toMatchObject({allowStacking:true,visitDiscountCapMinor:cap})
  })

})
