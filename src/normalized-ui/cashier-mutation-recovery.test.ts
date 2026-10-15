import {describe,it,expect,vi} from 'vitest'
import {CashierMutationCoordinator} from './cashier-mutation'
describe('cashier uncertain outcomes',()=>{
 it('retains the original body and key after generic failure, permission loss and failed readback',async()=>{
  const c=new CashierMutationCoordinator(),body={orderId:'order',occurredAt:'original',amountMinor:1000}
  const original=c.prepare('pay',body);body.occurredAt='edited'
  for(const error of [new Error('network'),Object.assign(new Error('permission'),{status:403})]){
   await expect(c.execute('pay',body,async attempt=>{expect(attempt).toEqual(original);throw error},async()=>{})).rejects.toThrow()
  }
  await expect(c.execute('pay',body,async()=>({paid:true}),async()=>{throw new Error('read unavailable')})).rejects.toThrow('read unavailable')
  expect(c.prepare('pay',body)).toEqual(original)
  expect(await c.execute('pay',body,async attempt=>{expect(attempt).toEqual(original);return 'confirmed'},async()=>{})).toBe('confirmed')
  expect(c.prepare('pay',body).idempotencyKey).not.toBe(original.idempotencyKey)
 })
 it('coalesces double taps while the receipt and readback are pending',async()=>{
  const c=new CashierMutationCoordinator(),send=vi.fn(async()=>42)
  let release!:()=>void
  const readback=vi.fn(()=>new Promise<void>(resolve=>{release=resolve}))
  const a=c.execute('pay',{},send,readback),b=c.execute('pay',{},send,readback)
  await vi.waitFor(()=>expect(readback).toHaveBeenCalledTimes(1));expect(send).toHaveBeenCalledTimes(1)
  release();expect(await Promise.all([a,b])).toEqual([42,42])
 })
})
