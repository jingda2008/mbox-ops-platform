import {describe,it,expect} from 'vitest'
import {minimumSpendSummary} from './table-minimum-spend.js'

describe('table minimum spend amounts',()=>{
  it.each([
    [50000,0,49999,1], [50000,0,50000,0], [50000,50000,100,0],
    [50000,20000,29999,1], [50000,20000,30000,0], [0,0,100,0],
    [50000,40000,0,10000],
  ])('minimum %i, consumed %i, candidate %i => shortage %i',(m,g,c,s)=>{
    expect(minimumSpendSummary(m,g,c).shortfallMinor).toBe(s)
  })
  it.each([-1,NaN,Infinity,0.1,Number.MAX_SAFE_INTEGER+1])('rejects invalid amounts %s',v=>{
    expect(()=>minimumSpendSummary(v,0,0)).toThrow()
    expect(()=>minimumSpendSummary(0,v,0)).toThrow()
    expect(()=>minimumSpendSummary(0,0,v)).toThrow()
  })
  it('names the threshold and exact shortfall without changing prices',()=>{
    expect(minimumSpendSummary(50000,20000,18000).message).toContain('还差 ¥120.00')
    expect(minimumSpendSummary(0,0,0).message).toBe('')
  })
})
