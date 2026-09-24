import {it,expect} from 'vitest'
import {requiresStaffLogin} from './staff-session-error'
it('separates session expiry from permission and device setup failures',()=>{
  for(const code of ['PICKUP_SESSION_INVALID','KDS_SESSION_INVALID'])expect(requiresStaffLogin({status:403,code})).toBe(true)
  expect(requiresStaffLogin({status:401,code:'AUTH_REQUIRED'})).toBe(true)
  for(const code of ['PICKUP_FORBIDDEN','PICKUP_DEVICE_REQUIRED','KDS_STATION_FORBIDDEN','STAFF_ACCESS_FORBIDDEN'])expect(requiresStaffLogin({status:403,code})).toBe(false)
  expect(requiresStaffLogin(new TypeError('offline'))).toBe(false)
})
