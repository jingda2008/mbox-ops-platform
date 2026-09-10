import {afterEach,describe,expect,it,vi} from 'vitest'
import {CheckoutUpgradeCandidateRepository} from './checkout-upgrade-candidate-repository.js'
import {CheckoutUpgradeEvaluationRepository} from './checkout-upgrade-evaluation-repository.js'
import {CheckoutUpgradeOpportunityRepository} from './checkout-upgrade-opportunity-repository.js'
import {GuestSharedCartRepository} from './guest-shared-cart-repository.js'
import {CheckoutCartPricingError} from './checkout-cart-pricing.js'
import type {ScopedTransaction} from './transaction-runner.js'

afterEach(()=>vi.restoreAllMocks())
const input={customerId:'customer',tableSessionId:'table',expectedGeneration:1,expectedVersion:2,occasion:null,alcoholPreference:null,selections:[],requestKey:'candidate-request'}
function fixture(options:{enabled?:boolean;prior?:unknown;rules?:unknown[];groups?:unknown[]}={}){
 const tx={scope:{tenantId:'tenant',storeId:'store'},query:vi.fn(async(sql:string)=>({rows:sql.includes('product_bundle_choice_groups')?(options.groups??[]):sql.includes('AS enabled')?[{enabled:options.enabled??true}]:sql.includes('checkout_upgrade_opportunities')?(options.prior?[options.prior]:[]):options.rules??[{id:'bad-high-priority',source_product_id:'source',priority:100},{id:'good',source_product_id:'source',priority:1}],rowCount:1}))} as unknown as ScopedTransaction
 vi.spyOn(GuestSharedCartRepository.prototype,'findCurrentOpen').mockResolvedValue({id:'cart',generation:1,version:2,guestWritesFrozen:false,lines:[{productId:'source',portionIds:['portion']}]} as never)
 const offer=vi.spyOn(CheckoutUpgradeOpportunityRepository.prototype,'offerOnce').mockResolvedValue({id:'offered'} as never)
 return{repo:new CheckoutUpgradeCandidateRepository(tx),offer,tx}
}
describe('strict upgrade candidate selection',()=>{
 it('distinguishes no rules from disabled without exposing customer details or letting telemetry block checkout',async()=>{
  const disabled=fixture({enabled:false}),observe=vi.fn()
  expect(await new CheckoutUpgradeCandidateRepository(disabled.tx,observe).prepare(input)).toBeNull()
  expect(observe).toHaveBeenCalledExactlyOnceWith('feature_unavailable')
  const empty=fixture({rules:[]})
  observe.mockClear()
  expect(await new CheckoutUpgradeCandidateRepository(empty.tx,observe).prepare(input)).toBeNull()
  expect(observe).toHaveBeenCalledExactlyOnceWith('no_matching_rules')
  expect(await new CheckoutUpgradeCandidateRepository(empty.tx,()=>{throw Error('metrics offline')}).prepare(input)).toBeNull()
 })
 it('publishes only concrete branches that preserve the source and pass every gate',async()=>{
  const groups=['fits','wrong-drink'].map(id=>({id:'group',bundle_product_id:'target',display_name:'鸡尾酒',selection_count:1,component_product_id:id,name:id}))
  const {repo,offer}=fixture({rules:[{id:'rule',source_product_id:'source',target_product_id:'target',priority:1}],groups})
  const evaluate=vi.spyOn(CheckoutUpgradeEvaluationRepository.prototype,'evaluate').mockImplementation(async value=>value.bundleSelection?.groups[0]?.productIds[0]==='fits'?{eligible:true,ruleId:'rule',addedPayableMinor:100,comparison:{sourcePortionId:'portion'}} as never:{eligible:false,reason:'original_not_preserved'} as never)
  await repo.prepare(input)
  expect(evaluate).toHaveBeenCalledTimes(2)
  expect(offer).toHaveBeenCalledWith(expect.objectContaining({eligible:true}),expect.objectContaining({variants:[expect.objectContaining({label:'鸡尾酒：fits'})]}))
 })
 it('does not read carts or evaluate when feature is closed',async()=>{
  const {repo}=fixture({enabled:false}),evaluate=vi.spyOn(CheckoutUpgradeEvaluationRepository.prototype,'evaluate')
  expect(await repo.prepare(input)).toBeNull()
  expect(GuestSharedCartRepository.prototype.findCurrentOpen).not.toHaveBeenCalled()
  expect(evaluate).not.toHaveBeenCalled()
 })
 it('qualifies before ranking and never lets priority admit a rejected rule',async()=>{
  const {repo,offer}=fixture()
  const evaluate=vi.spyOn(CheckoutUpgradeEvaluationRepository.prototype,'evaluate').mockImplementation(async value=>value.ruleId==='good'?{eligible:true,ruleId:'good',addedPayableMinor:100,comparison:{sourcePortionId:'portion'}} as never:{eligible:false,reason:'not_qualified'} as never)
  expect(await repo.prepare(input)).toEqual({id:'offered'})
  expect(evaluate).toHaveBeenCalledTimes(2)
  expect(offer).toHaveBeenCalledWith(expect.objectContaining({ruleId:'good'}),input)
 })
 it('skips a domain-incompatible coupon but propagates SQL failures for rollback',async()=>{
  const {repo}=fixture(),evaluate=vi.spyOn(CheckoutUpgradeEvaluationRepository.prototype,'evaluate').mockRejectedValue(new CheckoutCartPricingError('商品池不匹配'))
  expect(await repo.prepare(input)).toBeNull()
  evaluate.mockRejectedValue(new Error('database disconnected'))
  await expect(repo.prepare(input)).rejects.toThrow('database disconnected')
 })
 it('does not retrigger a cart on another device or after version changes',async()=>{
  const {repo}=fixture({prior:{id:'old',request_key:'different-request'}}),evaluate=vi.spyOn(CheckoutUpgradeEvaluationRepository.prototype,'evaluate')
  expect(await repo.prepare(input)).toBeNull()
  expect(await repo.prepare({...input,expectedVersion:1})).toBeNull()
  expect(evaluate).not.toHaveBeenCalled()
 })
 it('fails closed instead of truncating a large rule set before qualification',async()=>{
  const {repo}=fixture({rules:Array.from({length:21},(_,i)=>({id:String(i),source_product_id:'source',priority:i}))}),evaluate=vi.spyOn(CheckoutUpgradeEvaluationRepository.prototype,'evaluate')
  expect(await repo.prepare(input)).toBeNull()
  expect(evaluate).not.toHaveBeenCalled()
 })
})
