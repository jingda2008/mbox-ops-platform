import {describe,it,expect,vi} from 'vitest'
import type {NormalizedApiClient} from '../normalized-api'
import {OrderStockReturnRecovery,type StockReturnBody} from './order-stock-return-recovery'
const body:StockReturnBody={quantity:1,disposition:'returned_unopened',reason:'未开封一瓶已收回',unopenedConfirmed:true}
function storage(){const map=new Map<string,string>();return {getItem:(key:string)=>map.get(key)??null,setItem:(key:string,value:string)=>{map.set(key,value)},removeItem:(key:string)=>{map.delete(key)}}}
function fixture(){const post=vi.fn();return {post,api:{postEndpoint:post} as Pick<NormalizedApiClient,'postEndpoint'>,employee:crypto.randomUUID(),item:crypto.randomUUID(),store:storage()}}
describe('actual stock return and remaining-quantity recovery',()=>{
 it('keeps a confirmed first return locked after read failure and recovers by reads only after reopening',async()=>{
  const {post,api,employee,item,store}=fixture();let returned=0
  post.mockImplementation(async()=>{returned++;return {id:'stock-return-first'}})
  const first=new OrderStockReturnRecovery(api,employee,item,store)
  await first.submit(body)
  await expect(first.refresh(async()=>{throw new Error('history unavailable')})).rejects.toThrow('unavailable')
  expect(first.pending()?.recordId).toBe('stock-return-first')
  const reopened=new OrderStockReturnRecovery(api,employee,item,store)
  await expect(reopened.submit(body)).rejects.toThrow('退库已成功')
  expect(await reopened.recover()).toBe('stock-return-first')
  const read=vi.fn().mockResolvedValue(undefined);await reopened.refresh(read)
  expect(post).toHaveBeenCalledTimes(1);expect(returned).toBe(1);expect(read).toHaveBeenCalledTimes(1);expect(reopened.pending()).toBeNull()
  // A subsequent, intentional return only becomes possible after the fresh read.
  await reopened.submit(body);expect(returned).toBe(2)
  expect(post.mock.calls[1][2].idempotencyKey).not.toBe(post.mock.calls[0][2].idempotencyKey)
 })
 it('retains exact original payload/key after lost feedback and prevents a different disposition while uncertain',async()=>{
  const {post,api,employee,item,store}=fixture();let returned=0
  const applied=new Set<string>()
  post.mockImplementation(async(_url,_body,options)=>{if(!applied.has(options.idempotencyKey)){applied.add(options.idempotencyKey);returned++;throw new Error('lost after commit')}return {id:'original-return'}})
  const first=new OrderStockReturnRecovery(api,employee,item,store)
  await expect(first.submit(body)).rejects.toThrow('lost after commit')
  const reopened=new OrderStockReturnRecovery(api,employee,item,store)
  await expect(reopened.submit({...body,quantity:2})).rejects.toThrow('恢复原退库')
  expect(await reopened.recover()).toBe('original-return');expect(returned).toBe(1)
  expect(post.mock.calls[1]).toEqual(post.mock.calls[0])
 })
 it('coalesces concurrent clicks but isolates original item and employee and permits definite quantity corrections',async()=>{
  const {post,api,employee,item,store}=fixture();let resolve!:(value:{id:string})=>void
  post.mockImplementation(()=>new Promise(done=>{resolve=done}))
  const a=new OrderStockReturnRecovery(api,employee,item,store),b=new OrderStockReturnRecovery(api,employee,item,store)
  const one=a.submit(body),two=b.submit(body)
  await vi.waitFor(()=>expect(post).toHaveBeenCalledTimes(1));resolve({id:'one'});await Promise.all([one,two])
  expect(new OrderStockReturnRecovery(api,employee,'other',store).pending()).toBeNull()
  expect(new OrderStockReturnRecovery(api,'other',item,store).pending()).toBeNull()
  const third=new OrderStockReturnRecovery(api,employee,'corrected',store)
  post.mockRejectedValueOnce({status:409,code:'STOCK_RETURN_CONFLICT'})
  await expect(third.submit({...body,quantity:20})).rejects.toMatchObject({code:'STOCK_RETURN_CONFLICT'});expect(third.pending()).toBeNull()
  post.mockResolvedValueOnce({id:'corrected'});expect(await third.submit(body)).toBe('corrected')
 })
 it('retains an ambiguous legacy 409 because it can mean the original command is still running',async()=>{
  const {post,api,employee,item,store}=fixture();post.mockRejectedValueOnce({status:409,code:'HARDWARE_CONFLICT'}).mockResolvedValueOnce({id:'original-still-running'})
  const recovery=new OrderStockReturnRecovery(api,employee,item,store)
  await expect(recovery.submit(body)).rejects.toMatchObject({code:'HARDWARE_CONFLICT'})
  await expect(recovery.submit({...body,quantity:2})).rejects.toThrow('恢复原退库')
  await recovery.recover();expect(post.mock.calls[1][2].idempotencyKey).toBe(post.mock.calls[0][2].idempotencyKey)
 })
 it('does not treat a malformed success response as a confirmed stock change',async()=>{
  const {post,api,employee,item,store}=fixture();post.mockResolvedValueOnce({unexpected:true}).mockResolvedValueOnce({id:'recovered'})
  const recovery=new OrderStockReturnRecovery(api,employee,item,store)
  await expect(recovery.submit(body)).rejects.toThrow('回执暂未读全')
  expect(recovery.pending()?.recordId).toBeNull();expect(await recovery.recover()).toBe('recovered')
  expect(post.mock.calls[1][2].idempotencyKey).toBe(post.mock.calls[0][2].idempotencyKey)
 })
})
