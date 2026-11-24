import {describe,it,expect} from 'vitest'
import {orderPointsDelta} from './loyalty-order-points.js'
const legacyDelta = (before: number, after: number) => orderPointsDelta(before, after, 1n, 1000n)

describe('per-order points: 10 yuan earns 1 point, no remainder carry',()=>{
  it.each([[0,0],[1,0],[999,0],[1000,1],[1099,1],[9999,9],[10000,10],[10900,10]])('eligible minor %i earns %i',(amount,points)=>expect(legacyDelta(0,amount)).toBe(points))
  it('does not combine separate sub-ten-yuan orders',()=>expect(legacyDelta(0,900)+legacyDelta(0,900)).toBe(0))
  it('refunds by remaining consumption, with cumulative conservation',()=>{
    expect(legacyDelta(10900,10000)).toBe(0)
    expect(legacyDelta(10000,9900)).toBe(-1)
    expect(legacyDelta(9900,0)).toBe(-9)
    expect(legacyDelta(0,10900)+legacyDelta(10900,10000)+legacyDelta(10000,9900)+legacyDelta(9900,0)).toBe(0)
  })
  it('restores the original threshold only after recollection',()=>{
    expect(legacyDelta(9900,10000)).toBe(1)
    expect(legacyDelta(10000,10900)).toBe(0)
  })
  it.each([-1,NaN,Infinity,1.5,Number.MAX_SAFE_INTEGER+1])('rejects invalid money %s',amount=>expect(()=>legacyDelta(0,amount)).toThrow())
})

describe('per-order points at 20 yuan', () => {
  const delta = (before: number, after: number) => orderPointsDelta(before, after, 1n, 2000n)
  it.each([[1999, 0], [2000, 1], [3999, 1], [4000, 2], [50000, 25]])(
    'eligible minor %i earns %i', (amount, expected) => expect(delta(0, amount)).toBe(expected),
  )
  it('uses the original threshold when refunding and recollecting', () => {
    expect(delta(4000, 3999)).toBe(-1)
    expect(delta(3999, 4000)).toBe(1)
    expect(delta(0, 1999) + delta(0, 1999)).toBe(0)
  })
})
