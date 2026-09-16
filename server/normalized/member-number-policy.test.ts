import { describe, expect, it } from 'vitest'
import { defaultMemberNumberPolicy as policy, memberNumberAt, memberNumberPolicySchema } from './member-number-policy.js'
describe('configurable short member numbers', () => {
 it('expands each prefix only after its numeric range is exhausted', () => {
  expect(memberNumberAt(policy,0n)).toBe('100001')
  expect(memberNumberAt(policy,899998n)).toBe('999999')
  expect(memberNumberAt(policy,899999n)).toBe('A10001')
  expect(memberNumberAt(policy,989997n)).toBe('A99999')
  expect(memberNumberAt(policy,989998n)).toBe('B10001')
  expect(memberNumberAt(policy,899999n+26n*89999n)).toBe('AA1001')
 })
 it('supports zero padding and custom ordered alphabets without duplicates', () => {
  const p={...policy,startNumber:1,alphabet:'BA',width:4}
  expect(memberNumberAt(p,0n)).toBe('0001')
  expect(memberNumberAt({...p,padZero:false},0n)).toBe('1')
  expect(memberNumberAt(p,9999n)).toBe('B001')
  expect(memberNumberPolicySchema.safeParse({...p,alphabet:'ABA'}).success).toBe(false)
 })
 it('refuses exhaustion, negative ordinals and invalid policy', () => {
  expect(()=>memberNumberAt({...policy,maximumPrefixLength:0},899999n)).toThrow('用尽')
  expect(()=>memberNumberAt(policy,-1n)).toThrow()
  expect(memberNumberPolicySchema.safeParse({...policy,width:4}).success).toBe(false)
 })
})
