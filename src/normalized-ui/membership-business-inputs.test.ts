import { describe, expect, it } from 'vitest'
import { minorToYuanInput, yuanInputToMinor } from './membership-business-inputs'
import { defaultStaffWorkMode, quickStaffEntries } from './staff-navigation-model'

describe('business amount inputs preserve exact cents',()=>{
  it.each([[0,'0.00'],[1,'0.01'],[1001,'10.01'],[123456789,'1234567.89'],[Number.MAX_SAFE_INTEGER,'90071992547409.91']])('round trips %i without floating-point rounding',(minor,yuan)=>{
    expect(minorToYuanInput(minor)).toBe(yuan);expect(yuanInputToMinor(yuan)).toBe(minor)
  })
  it.each(['1.001','1e3','-1','','NaN','90071992547409.92'])('rejects ambiguous or unsafe money %s',value=>expect(yuanInputToMinor(value)).toBeNull())
})
describe('role quick navigation never manufactures permissions',()=>{
  it('prioritizes only authorized existing routes, keeping original entries intact',()=>{
    const entries=[{code:'live',label:'桌台',route:'/staff/live'},{code:'commerce',label:'出品',route:'/staff/fulfillment'}]
    expect(quickStaffEntries(entries,'cashier')).toEqual(entries)
    expect(quickStaffEntries(entries,'production').map(item=>item.code)).toEqual(['commerce','live'])
    expect(entries[0].code).toBe('live')
    expect(defaultStaffWorkMode(['CASHIER'])).toBe('cashier')
  })
})
