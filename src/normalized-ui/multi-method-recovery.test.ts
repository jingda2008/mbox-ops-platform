import {describe,it,expect,vi} from 'vitest'
import {ItemAfterSalesApi} from './item-after-sales-api'
import {OrderStockReturnRecovery} from './order-stock-return-recovery'
import {DurableStaffCommand} from './durable-staff-command'
const storage=()=>{const m=new Map<string,string>();return {getItem:(k:string)=>m.get(k)??null,setItem:(k:string,v:string)=>{m.set(k,v)},removeItem:(k:string)=>{m.delete(k)}}}
const body={quantity:1,disposition:'unmade' as const,reason:'原商品',unopenedConfirmed:true}
describe('uncertain command recovery boundaries',()=>{
 it.each([400,401,403,404,409,422,500])('keeps original stock return after recovery refusal %s',async status=>{
  const saved=storage(),post=vi.fn().mockRejectedValueOnce(Error('lost')).mockRejectedValueOnce({status,code:'STOCK_RETURN_CONFLICT'}).mockResolvedValue({id:'original'})
  const employee=crypto.randomUUID(),item=crypto.randomUUID(),api={postEndpoint:post}
  const original=new OrderStockReturnRecovery(api,employee,item,saved)
  await expect(original.submit(body)).rejects.toThrow('lost')
  const restored=new OrderStockReturnRecovery(api,employee,item,saved),key=restored.pending()!.key
  await expect(restored.recover()).rejects.toMatchObject({status})
  expect(restored.pending()!.key).toBe(key)
  await expect(restored.submit({...body,quantity:2})).rejects.toThrow('原退库')
  expect(post).toHaveBeenCalledTimes(2)
  await restored.recover();expect(post.mock.calls[2][2].idempotencyKey).toBe(key)
 })
 it.each(['{broken','null','{}','{"key":"","body":{}}','[]',''])('blocks corrupt journal %s in every recovery implementation',async raw=>{
  const saved={getItem:()=>raw,setItem:vi.fn(),removeItem:vi.fn()},send=vi.fn()
  const after=new ItemAfterSalesApi('staff',send,saved)
  await expect(after.act('item','/api/commerce/item-after-sales/requests',body)).rejects.toThrow('记录损坏')
  const stock=new OrderStockReturnRecovery({postEndpoint:send},crypto.randomUUID(),crypto.randomUUID(),saved)
  await expect(stock.submit(body)).rejects.toThrow('记录损坏')
  const durable=new DurableStaffCommand(crypto.randomUUID(),send,saved)
  await expect(durable.submit(body)).rejects.toThrow('记录损坏')
  expect(send).not.toHaveBeenCalled();expect(saved.setItem).not.toHaveBeenCalled();expect(saved.removeItem).not.toHaveBeenCalled()
 })
 it('blocks unreadable storage but permits a genuinely empty journal',async()=>{
  const send=vi.fn().mockResolvedValue({ok:true}),saved=storage()
  const blocked=new DurableStaffCommand(crypto.randomUUID(),send,{...saved,getItem(){throw Error('denied')}})
  await expect(blocked.submit(body)).rejects.toThrow('存储访问');expect(send).not.toHaveBeenCalled()
  await new DurableStaffCommand(crypto.randomUUID(),send,saved).submit(body);expect(send).toHaveBeenCalledTimes(1)
 })
})
