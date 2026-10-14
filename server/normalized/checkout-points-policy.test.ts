import {it,expect} from 'vitest'
import {calculateStackingPrice,DEFAULT_STACKING_POLICY} from './stacking-pricing.js'
it('one point is one yuan including full-point settlement and exact refundable allocation',()=>{
  const policy={...DEFAULT_STACKING_POLICY,allowPoints:true,allowBundlePrice:true}
  const scenario={units:[{id:'a',amountMinor:600,costMinor:100,bundle:false},{id:'b',amountMinor:400,costMinor:100,bundle:false}],effects:[{id:'points',stage:'points' as const,kind:'amount_off' as const,value:1000,unitIds:['a','b'],minimumSpendMinor:0}]}
  const quote=calculateStackingPrice(policy,scenario)
  expect(quote.payableMinor).toBe(0)
  expect(quote.units.map(x=>x.discountMinor)).toEqual([600,400])
})
