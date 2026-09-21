import {describe,expect,it,vi} from 'vitest'
import {NormalizedApiClient,NormalizedApiError} from '../normalized-api'
import {CashierMutationCoordinator} from './cashier-mutation'
import {paymentQueryNotice} from './CashierAfterSalesWorkbench'
import type {CashierClosableUnpresentedPayment} from '../shared/cashier-workbench-contracts'

describe('whole historical payment client contract',()=>{
  it('preserves query provenance in the real client data mapping so local results and pending channel observations have distinct notices',async()=>{
    const responses=[
      {data:{id:'original-batch',status:'succeeded',queryResultSource:'local_payment'},meta:{replayed:false,resultSource:'local_payment',providerQueried:false}},
      {data:{publicId:'original-batch',status:'closed',queryObservation:{status:'processing',occurredAt:'2026-09-21T04:00:00.000Z'}},meta:{replayed:false,localStatusRetained:true},provider:{status:'processing',occurredAt:'2026-09-21T04:00:00.000Z'}},
    ]
    const send=vi.fn<typeof fetch>()
    for(const response of responses)send.mockResolvedValueOnce(new Response(JSON.stringify(response),{status:200}))
    const api=new NormalizedApiClient({fetch:send})
    const local=await api.postEndpoint('/api/payments/original-batch/provider-query',{}, {idempotencyKey:'local-result-key'})
    expect(local).toEqual(responses[0].data)
    expect(paymentQueryNotice(local,'fallback')).toContain('本次未重新请求渠道')
    const pending=await api.postEndpoint('/api/payments/original-batch/provider-query',{}, {idempotencyKey:'pending-query-key'})
    expect(pending).toEqual(responses[1].data)
    expect(paymentQueryNotice(pending,'fallback')).toContain('渠道仍在处理中')
    expect(paymentQueryNotice(pending,'fallback')).toContain('不把本次查询当作到账')
  })
  it('preserves the server whole-payment descriptor and retries the original payment with its original reason/key after an unknown response',async()=>{
    const descriptor:CashierClosableUnpresentedPayment={paymentId:'original-batch',payableKind:'order_batch',totalAmountMinor:3000,currency:'CNY',orderIds:['original-a','original-b'],orderPublicIds:['ORDER-A','ORDER-B']}
    const send=vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({data:{closableUnpresentedPayments:[descriptor]}}),{status:200}))
      .mockRejectedValueOnce(new TypeError('connection lost after acceptance'))
      .mockResolvedValueOnce(new Response(JSON.stringify({data:{id:'original-batch',status:'closed'},meta:{replayed:true}}),{status:200}))
    const api=new NormalizedApiClient({fetch:send}),coordinator=new CashierMutationCoordinator()
    expect(await api.getEndpoint('/api/payments/workbench')).toEqual({data:{closableUnpresentedPayments:[descriptor]}})
    const action='payment-close-unpresented-history-original-batch',body={reason:'核对整笔合并付款未外送'}
    const original=coordinator.prepare(action,body)
    try{await api.postEndpoint('/api/payments/original-batch/close-unpresented-history',original.body,{idempotencyKey:original.idempotencyKey});throw Error('expected unknown response')}
    catch(error){expect(error).toBeInstanceOf(NormalizedApiError);expect((error as NormalizedApiError).retryable).toBe(true);coordinator.fail(original.signature,(error as NormalizedApiError).retryable)}
    const retry=coordinator.prepare(action,body)
    expect(retry).toEqual(original)
    await expect(api.postEndpoint('/api/payments/original-batch/close-unpresented-history',retry.body,{idempotencyKey:retry.idempotencyKey})).resolves.toEqual({id:'original-batch',status:'closed'})
    for(const [path,options] of send.mock.calls.slice(1)){
      expect(path).toBe('/api/payments/original-batch/close-unpresented-history')
      expect(JSON.parse(options!.body as string)).toEqual(body)
      expect(new Headers(options!.headers).get('idempotency-key')).toBe(original.idempotencyKey)
      expect(options!.credentials).toBe('include')
    }
  })
})
