import {describe,it,expect,vi} from 'vitest'
import {ItemAfterSalesApi} from './item-after-sales-api'

const item='11111111-1111-4111-8111-111111111111',refund='22222222-2222-4222-8222-222222222222'
function storage(){const values=new Map<string,string>();return {getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value)},removeItem:(key:string)=>{values.delete(key)}}}
const response=(data:unknown)=>new Response(JSON.stringify({data}),{status:200})
describe('quantity after-sales recovery',()=>{
  it('binds reads, writes and recovered cash phases to the employee shown in this client',async()=>{
    const send=vi.fn<typeof fetch>().mockResolvedValue(response({}))
    // A fresh response is required for every JSON read.
    send.mockImplementation(async()=>response({}))
    const api=new ItemAfterSalesApi('employee-original',send,storage())
    await api.access()
    await api.act(item,`/api/refunds/${refund}/manual-result`,{succeeded:true})
    expect(send).toHaveBeenCalledTimes(3)
    for(const [,init] of send.mock.calls)expect(new Headers(init?.headers).get('x-mbox-staff-employee-id')).toBe('employee-original')
  })
  it('keeps the original attempt after identity rejection and hides technical errors',async()=>{
    const send=vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({error:{code:'AUTH_REQUIRED',message:'当前员工已切换，请重新登录后确认操作'}}),{status:401}))
      .mockResolvedValueOnce(new Response(JSON.stringify({error:{code:'INTERNAL_ERROR',message:'数据库失败：SELECT secret FROM staff'}}),{status:500}))
    const api=new ItemAfterSalesApi('employee-original',send,storage())
    await expect(api.act(item,'/api/commerce/item-after-sales/requests',{orderItemId:item,quantity:1,reason:'重复点单'})).rejects.toMatchObject({status:401})
    const original=api.pending(item)
    expect(original).not.toBeNull()
    await expect(api.recover(item)).rejects.toMatchObject({message:'本次操作结果尚未确认，请核对原操作后重试'})
    expect(api.pending(item)?.key).toBe(original?.key)
  })
  it('restores the original payload across a new page and blocks a different selection while the outcome is unknown',async()=>{
    const store=storage(),body={orderItemId:item,quantity:2,reason:'重复点单'}
    const send=vi.fn<typeof fetch>().mockRejectedValueOnce(new Error('lost response')).mockResolvedValueOnce(response({caseId:'original'}))
    await expect(new ItemAfterSalesApi('server',send,store).act(item,'/api/commerce/item-after-sales/requests',body)).rejects.toMatchObject({code:'NETWORK_ERROR'})
    const restored=new ItemAfterSalesApi('server',send,store)
    await expect(restored.act(item,'/api/commerce/item-after-sales/requests',{...body,quantity:1})).rejects.toMatchObject({code:'AFTER_SALES_ORIGINAL_PENDING'})
    expect(send).toHaveBeenCalledTimes(1)
    await restored.recover(item)
    expect(send.mock.calls[1]?.[1]?.body).toBe(send.mock.calls[0]?.[1]?.body)
    expect(new Headers(send.mock.calls[1]?.[1]?.headers).get('idempotency-key')).toBe(new Headers(send.mock.calls[0]?.[1]?.headers).get('idempotency-key'))
    expect(restored.pending(item)).toBeNull()
    expect(new ItemAfterSalesApi('other-server',send,store).pending(item)).toBeNull()
  })
  it.each(['/api/commerce/item-after-sales/redeliveries',`/api/commerce/item-after-sales/redeliveries/${refund}/complete`])('recovers original redelivery command %s without changing its unit count',async url=>{
    const store=storage(),body={orderItemId:item,quantity:2,reason:'原实物仍在可补送',originalGoodsAvailable:true}
    const send=vi.fn<typeof fetch>().mockRejectedValueOnce(new Error('lost response')).mockResolvedValueOnce(response({id:refund}))
    await expect(new ItemAfterSalesApi('server',send,store).act(item,url,body)).rejects.toMatchObject({code:'NETWORK_ERROR'})
    const restored=new ItemAfterSalesApi('server',send,store)
    await expect(restored.act(item,url,{...body,quantity:1})).rejects.toMatchObject({code:'AFTER_SALES_ORIGINAL_PENDING'})
    await restored.recover(item)
    expect(send.mock.calls[1]?.[1]?.body).toBe(send.mock.calls[0]?.[1]?.body)
    expect(new Headers(send.mock.calls[1]?.[1]?.headers).get('idempotency-key')).toBe(new Headers(send.mock.calls[0]?.[1]?.headers).get('idempotency-key'))
    expect(restored.pending(item)).toBeNull()
  })
  it('replays both existing cash phases with their original keys after final acknowledgement is lost',async()=>{
    const store=storage(),calls:Array<{url:string;key:string;body:unknown}>=[],committed=new Set<string>()
    let actualPayoutRecords=0,drop=true
    const send=vi.fn<typeof fetch>().mockImplementation(async(url,init)=>{
      const key=new Headers(init?.headers).get('idempotency-key')!,address=String(url)
      calls.push({url:address,key,body:JSON.parse(String(init?.body))})
      if(address.endsWith('/manual-result')&&!committed.has(key)){actualPayoutRecords++;committed.add(key);if(drop){drop=false;throw new Error('lost final result')}}
      return response({status:address.endsWith('/execute')?'processing':'succeeded'})
    })
    await expect(new ItemAfterSalesApi('cashier',send,store).act(item,`/api/refunds/${refund}/manual-result`,{succeeded:true})).rejects.toMatchObject({code:'NETWORK_ERROR'})
    const resumed=new ItemAfterSalesApi('cashier',send,store);await resumed.recover(item)
    expect(calls).toHaveLength(4);expect(calls[2]).toEqual(calls[0]);expect(calls[3]).toEqual(calls[1])
    expect(actualPayoutRecords).toBe(1);expect(resumed.pending(item)).toBeNull()
  })
  it.each(['QUANTITY_UNAVAILABLE','QUANTITY_BATCH_NOT_ENABLED'])('clears definite %s and never sends an external endpoint',async(code)=>{
    const send=vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({error:{code,message:'本次未创建新申请'}}),{status:409})).mockResolvedValueOnce(response({caseId:'corrected'}))
    const api=new ItemAfterSalesApi('server',send,storage())
    await expect(api.act(item,'/api/commerce/item-after-sales/requests',{orderItemId:item,quantity:2,reason:'重复点单'})).rejects.toMatchObject({code})
    expect(api.pending(item)).toBeNull()
    await api.act(item,'/api/commerce/item-after-sales/requests',{orderItemId:item,quantity:1,reason:'重复点单'})
    await expect(api.act(item,'https://invalid.example/submit',{})).rejects.toThrow('接口无效')
    expect(send).toHaveBeenCalledTimes(2)
  })
})
