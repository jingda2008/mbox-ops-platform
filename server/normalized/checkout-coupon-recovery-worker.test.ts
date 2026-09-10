import {afterEach,describe,expect,it,vi} from 'vitest'
import {CheckoutCouponRecoveryWorker} from './checkout-coupon-recovery-worker.js'
import {CheckoutCouponLifecycleRepository} from './checkout-coupon-lifecycle-repository.js'
import type {ScopedTransaction,TransactionOptions,StoreScope} from './transaction-runner.js'

const scope={tenantId:'tenant-test',storeId:'store-test'}
afterEach(()=>vi.restoreAllMocks())
function fixture(orderIds:string[]){
  const calls:Array<{scope:Readonly<StoreScope>;options?:TransactionOptions}>=[]
  const query=vi.fn().mockResolvedValue({rows:orderIds.map(order_id=>({order_id})),rowCount:orderIds.length})
  const tx={scope,query} as ScopedTransaction
  const transactions={async run<T>(actual:Readonly<StoreScope>,work:(tx:ScopedTransaction)=>Promise<T>,options?:TransactionOptions){
    calls.push({scope:actual,options});return work(tx)
  }}
  return{worker:new CheckoutCouponRecoveryWorker(transactions),calls,query}
}
describe('checkout coupon recovery failure isolation',()=>{
  it('rolls a failed item back independently and continues later orders',async()=>{
    const release=vi.spyOn(CheckoutCouponLifecycleRepository.prototype,'releaseCancelledOrderHolds')
      .mockRejectedValueOnce(new Error('isolated transaction failure'))
      .mockResolvedValueOnce({released:2})
    const {worker,calls,query}=fixture(['one','two'])
    expect(await worker.runBatch(scope,'test')).toEqual({workerId:'test',examined:2,released:2,failed:1})
    expect(release.mock.calls).toEqual([['one'],['two']])
    expect(calls).toHaveLength(3)
    expect(calls[0]?.options).toEqual({readOnly:true})
    expect(calls.every(call=>call.scope===scope)).toBe(true)
    expect(query).toHaveBeenCalledTimes(1)
  })
  it('treats an already recovered or concurrently locked order as a no-op',async()=>{
    vi.spyOn(CheckoutCouponLifecycleRepository.prototype,'releaseCancelledOrderHolds').mockResolvedValue({released:0})
    expect(await fixture(['one']).worker.runBatch(scope,'test')).toMatchObject({examined:1,released:0,failed:0})
  })
  it('does not start item transactions when there are no eligible orders',async()=>{
    const {worker,calls}=fixture([])
    expect(await worker.runBatch(scope,'test')).toMatchObject({examined:0,released:0,failed:0})
    expect(calls).toHaveLength(1)
  })
  it.each([0,101,1.5,Number.NaN])('rejects an unbounded or invalid batch %s before querying',async batch=>{
    const {worker,query}=fixture([])
    await expect(worker.runBatch(scope,'test',batch)).rejects.toThrow('Invalid coupon recovery batch')
    expect(query).not.toHaveBeenCalled()
  })
})
