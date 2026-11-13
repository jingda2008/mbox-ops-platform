import { describe, expect, it } from 'vitest'
import { hashChannelWebPassword, verifyChannelWebPassword } from './channel-web-auth.js'
import { channelPartnerStatementSchema, channelWebVisitSchema } from './channel-public-view.js'

describe('website partner privacy and credentials',()=>{
 it('salts each password, rejects a wrong password and never treats invalid hashes as credentials',async()=>{
  const first=await hashChannelWebPassword('strong-fixture-password'),second=await hashChannelWebPassword('strong-fixture-password')
  expect(first).not.toBe(second);expect(first).not.toContain('strong-fixture-password')
  expect(await verifyChannelWebPassword('strong-fixture-password',first)).toBe(true)
  expect(await verifyChannelWebPassword('wrong-fixture-password',first)).toBe(false)
  expect(await verifyChannelWebPassword('strong-fixture-password','')).toBe(false)
 })
 it('strips nested order evidence, customer identity, table numbers and financial account references',()=>{
  const detail=channelPartnerStatementSchema.parse({statement:{id:'s',sourceStatementId:null,amountMinor:'900',status:'pending',accountReference:'SECRET-BANK',accountSubject:'PRIVATE',promoterId:'internal'},lines:[{visitNumber:'ANONYMOUS',date:'2026-11-13',basisMinor:'9000',deltaMinor:'900',customerId:'CUSTOMER',tableId:'TABLE',evidence:{evidence:[{orderId:'ORDER',items:[{name:'secret-order-item'}]}]}}]})
  expect(JSON.stringify(detail)).not.toMatch(/SECRET|PRIVATE|CUSTOMER|TABLE|ORDER|evidence|account|promoterId|secret-order-item/)
  const visit=channelWebVisitSchema.parse({visitNumber:'ANON',date:'2026-11-13',arrived:true,closed:false,qualifiedConsumptionMinor:null,accruedCommissionMinor:null,customerName:'PRIVATE',customerPhone:'13900000000',orderId:'ORDER',tableName:'A1'})
  expect(visit).toEqual({visitNumber:'ANON',date:'2026-11-13',arrived:true,closed:false,qualifiedConsumptionMinor:null,accruedCommissionMinor:null})
 })
})
