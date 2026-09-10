import {afterEach,describe,expect,it,vi} from 'vitest'
import {GiftProductBudgetRepository} from './gift-product-budget-repository.js'
import {OrderRepository} from './order-repository.js'
import type {ScopedTransaction} from './transaction-runner.js'
afterEach(()=>vi.restoreAllMocks())
function fixture(choices:Record<string,unknown>[]=[],fixed:Record<string,unknown>[]=[]){
 const query=vi.fn(async(sql:string)=>({rows:sql.includes('choice_groups')?choices:fixed,rowCount:0}))
 return {query,repository:new GiftProductBudgetRepository({scope:{tenantId:'tenant',storeId:'store'},query} as unknown as ScopedTransaction)}
}
describe('gift issuance cost commitment',()=>{
 it('uses the highest weighted distinct options and all fixed components, not the stale parent cost',async()=>{
  const quote=vi.spyOn(OrderRepository.prototype,'quoteCurrent').mockResolvedValue({costAmountMinor:950} as never)
  const {repository,query}=fixture([
   {group_id:'a',selection_count:2,product_id:'cheap',quantity:1,cost:'100'},
   {group_id:'a',selection_count:2,product_id:'weighted',quantity:3,cost:'200'},
   {group_id:'a',selection_count:2,product_id:'next',quantity:1,cost:'250'},
  ],[{quantity:1,cost:'100'}])
  expect(await repository.maximumCost('bundle',400,'bundle')).toBe(950)
  expect(quote).not.toHaveBeenCalled()
  expect(query.mock.calls.every(([sql])=>!sql.includes('INSERT')&&!sql.includes('UPDATE')&&!sql.includes('FOR UPDATE'))).toBe(true)
 })
 it('does not reduce a higher existing cost commitment',async()=>{
  vi.spyOn(OrderRepository.prototype,'quoteCurrent').mockResolvedValue({costAmountMinor:500} as never)
  expect(await fixture([], [{quantity:1,cost:'450'}]).repository.maximumCost('bundle',700,'bundle')).toBe(700)
 })
 it.each([null,'not-cost','9007199254740992'])('rejects unknown or unsafe option cost %s instead of treating it as zero',async cost=>{
  const quote=vi.spyOn(OrderRepository.prototype,'quoteCurrent')
  await expect(fixture([{group_id:'a',selection_count:1,product_id:'option',quantity:1,cost}]).repository.maximumCost('bundle',100,'bundle')).rejects.toThrow('成本')
  expect(quote).not.toHaveBeenCalled()
 })
 it('rejects incomplete selectable quantities before creating a budget',async()=>{
  await expect(fixture([{group_id:'a',selection_count:2,product_id:'option',quantity:1,cost:'100'}]).repository.maximumCost('bundle',100,'bundle')).rejects.toThrow('数量不完整')
 })
 it('never treats unknown catalog cost as zero or blocks future coupons using current selling hours',async()=>{
  const quote=vi.spyOn(OrderRepository.prototype,'quoteCurrent').mockRejectedValue(new Error('outside selling hours'))
  await expect(fixture().repository.maximumCost('single',NaN,'single')).rejects.toThrow('成本未知')
  expect(await fixture().repository.maximumCost('single',500,'single')).toBe(500)
  expect(quote).not.toHaveBeenCalled()
 })
})
