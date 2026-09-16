import {describe,it,expect} from 'vitest'
import {defaultCustodyPolicy,reminderDueAt,custodyPolicySchema,quantityText,quantityUnits} from './bottle-custody-policy.js'
describe('custody reminder and quantity boundaries',()=>{
 it('schedules six independent tiers in Shanghai time and skips expired tiers for a short custody period',()=>{
  const expiry='2026-10-06T18:00:00+08:00',stored=Date.parse('2026-09-16T19:00:00+08:00')
  const valid=defaultCustodyPolicy.reminderDays.map(day=>({day,due:reminderDueAt(expiry,day,990)})).filter(item=>item.due.getTime()>=stored)
  expect(valid.map(x=>x.day)).toEqual([15,7,3,2,1])
  expect(valid[0]!.due.toISOString()).toBe('2026-09-21T08:30:00.000Z')
  expect(defaultCustodyPolicy.reminderDays.map(day=>reminderDueAt(expiry,day,990).toISOString())).toHaveLength(6)
 })
 it('supports configurable daytime and preserves six-place fractional quantities exactly',()=>{
  expect(custodyPolicySchema.parse({...defaultCustodyPolicy,sendMinute:965}).sendMinute).toBe(965)
  expect(reminderDueAt('2026-09-17T00:00:00+08:00',1,965).toISOString()).toBe('2026-09-16T08:05:00.000Z')
  expect(quantityText(quantityUnits('999999999999.123456'))).toBe('999999999999.123456')
  expect(quantityText(quantityUnits('20'))).toBe('20')
  expect(quantityText(0n)).toBe('0')
 })
})
