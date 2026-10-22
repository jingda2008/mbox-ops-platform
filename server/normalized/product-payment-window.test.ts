import {afterEach,describe,it,expect,vi} from 'vitest'
import {validateProductPaymentWindow} from './product-payment-window.js'
import {OnlinePaymentService} from './online-payment-service.js'
import {PaymentProviderActionRepository} from './payment-provider-action-repository.js'
import type {ScopedTransaction} from './transaction-runner.js'
const scope={tenantId:'11111111-1111-4111-8111-111111111111',storeId:'22222222-2222-4222-8222-222222222222'},paymentId='33333333-3333-4333-8333-333333333333'
function fixture(rows:Record<string,unknown>[],activity:Record<string,unknown>[]=[]){
 const calls:{sql:string;values:readonly unknown[]}[]=[]
 const tx:ScopedTransaction={scope,async query<Row extends Record<string,unknown>>(sql:string,values:readonly unknown[]=[]){
  calls.push({sql,values});return {rows:(sql.includes('SELECT item.product_id')?rows:sql.includes('SELECT r.payment_due_at')?activity:[]) as Row[],rowCount:1}
 }};return {tx,calls}
}
const valid={product_id:'product',valid:true,deadline:'2030-01-01T00:03:00Z',price_until:null,reservation_until:'2030-01-01T00:04:00Z'}
describe('new payment window cutoff and original action recovery',()=>{
 afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks()})
 it('stores the earliest supply/price/reservation deadline before contacting any provider',async()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2030-01-01T00:00:00Z'))
  const f=fixture([{...valid,price_until:'2030-01-01T00:02:00Z'}])
  expect(await validateProductPaymentWindow(f.tx,paymentId,'2030-01-01T00:05:00Z')).toBe('2030-01-01T00:02:00.000Z')
  expect(f.calls.at(-1)?.values.at(-1)).toBe('2030-01-01T00:02:00.000Z')
 })
 it.each([{...valid,deadline:null},{...valid,valid:false}])('rejects unavailable/repriced fresh actions without writing a new cutoff',async row=>{
  const f=fixture([row]);await expect(validateProductPaymentWindow(f.tx,paymentId,'2030-01-01T00:05:00Z')).rejects.toThrow('已变化')
  expect(f.calls.some(call=>call.sql.includes('UPDATE'))).toBe(false)
 })
 it('uses the already committed activity cutoff, including the exact end boundary',async()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2030-01-01T00:00:00Z'))
  const f=fixture([],[{deadline:'2030-01-01T00:01:00Z'}]);expect(await validateProductPaymentWindow(f.tx,paymentId,'2030-01-01T00:05:00Z')).toBe('2030-01-01T00:01:00.000Z')
  vi.setSystemTime(new Date('2030-01-01T00:01:00Z'));await expect(validateProductPaymentWindow(f.tx,paymentId,'2030-01-01T00:05:00Z')).rejects.toThrow('已过截止')
 })
 it('does not revalidate a restored ready action after the menu/card was changed',async()=>{
  const query=vi.fn().mockRejectedValue(new Error('Current qualification must not be reread'))
  vi.spyOn(PaymentProviderActionRepository.prototype,'resolvePaymentContext').mockResolvedValue({id:paymentId,status:'pending',publicId:'PAY-WINDOW',provider:'simulation',method:'native_qr',payableKind:'order',orderPublicId:'ORDER-WINDOW'} as never)
  vi.spyOn(PaymentProviderActionRepository.prototype,'claim').mockResolvedValue({claimed:false,payload:{presentation:'simulation'},expiresAt:'2030-01-01T00:02:00Z'} as never)
  const transactions={run:async(_scope:unknown,fn:(tx:ScopedTransaction)=>unknown)=>fn({scope,query})}
  const service=new OnlinePaymentService(transactions as never,'window-secret-at-least-thirty-two-bytes',null,null)
  expect(await service.create({scope,paymentId,principal:{type:'employee',employeeId:'employee'},operatorId:'MBOX'})).toMatchObject({expiresAt:'2030-01-01T00:02:00Z'})
  expect(query).not.toHaveBeenCalled()
 })
})
