import {describe,it,expect} from 'vitest'
import {orderPointsDelta} from './loyalty-order-points.js'
describe('per-order points: 10 yuan earns 1 point, no remainder carry',()=>{
  it.each([[0,0],[1,0],[999,0],[1000,1],[1099,1],[9999,9],[10000,10],[10900,10]])('eligible minor %i earns %i',(amount,points)=>expect(orderPointsDelta(0,amount)).toBe(points))
  it('does not combine separate sub-ten-yuan orders',()=>expect(orderPointsDelta(0,900)+orderPointsDelta(0,900)).toBe(0))
  it('refunds by remaining consumption, with cumulative conservation',()=>{
    expect(orderPointsDelta(10900,10000)).toBe(0)
    expect(orderPointsDelta(10000,9900)).toBe(-1)
    expect(orderPointsDelta(9900,0)).toBe(-9)
    expect(orderPointsDelta(0,10900)+orderPointsDelta(10900,10000)+orderPointsDelta(10000,9900)+orderPointsDelta(9900,0)).toBe(0)
  })
  it('restores the original threshold only after recollection',()=>{
    expect(orderPointsDelta(9900,10000)).toBe(1)
    expect(orderPointsDelta(10000,10900)).toBe(0)
  })
  it.each([-1,NaN,Infinity,1.5,Number.MAX_SAFE_INTEGER+1])('rejects invalid money %s',amount=>expect(()=>orderPointsDelta(0,amount)).toThrow())
})
