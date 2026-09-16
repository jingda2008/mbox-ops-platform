import {describe,it,expect} from 'vitest'
import {normalizePaymentClientIp} from './payment-client-network.js'
describe('payment client network identity',()=>{
 it('preserves real IPv4 and IPv6 addresses without inventing a local address',()=>{
  expect(normalizePaymentClientIp('::ffff:203.0.113.10')).toBe('203.0.113.10')
  expect(normalizePaymentClientIp('2001:db8::1')).toBe('2001:db8::1')
 })
 it('rejects invalid addresses and forwarded chains instead of presenting them as customer IP',()=>{
  for(const value of ['999.1.2.3','abc','2001:::1','203.0.113.1, 10.0.0.1',''])expect(()=>normalizePaymentClientIp(value)).toThrow()
 })
})
