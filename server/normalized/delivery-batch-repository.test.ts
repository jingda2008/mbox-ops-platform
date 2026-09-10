import {describe,it,expect,vi} from 'vitest'
import {DeliveryBatchRepository} from './delivery-batch-repository.js'
import type {ScopedTransaction} from './transaction-runner.js'
describe('delivery batch boundaries',()=>{
 const row=(id:string,patch:Record<string,unknown>={})=>({id,quantity:4,station_code:'bar',table_session_id:'party-a',status:'ready',item_status:'ready',order_status:'fulfilling',...patch})
 it.each([
  [row('a'),row('b',{station_code:'kitchen'})],
  [row('a'),row('b',{table_session_id:'party-b'})],
  [row('a'),row('b',{status:'preparing'})],
  [row('a'),row('b',{item_status:'delivered'})],
  [row('a'),row('b',{order_status:'cancelled'})],
 ])('rejects incompatible or no longer ready items without creating batch rows',async(a,b)=>{
  const query=vi.fn().mockResolvedValue({rows:[a,b],rowCount:2})
  const tx={scope:{tenantId:'tenant',storeId:'store'},query} as unknown as ScopedTransaction
  await expect(new DeliveryBatchRepository(tx).create('employee',[{taskId:'a',quantity:1},{taskId:'b',quantity:1}])).rejects.toThrow()
  expect(query).toHaveBeenCalledOnce()
  expect(query.mock.calls[0][0]).not.toContain('INSERT')
 })
 it.each([[],[{taskId:'a',quantity:0}],[{taskId:'a',quantity:1.5}],[{taskId:'a',quantity:1},{taskId:'a',quantity:2}]])('validates quantities and duplicate selections before database access',async items=>{
  const query=vi.fn(),tx={scope:{tenantId:'tenant',storeId:'store'},query} as unknown as ScopedTransaction
  await expect(new DeliveryBatchRepository(tx).create('employee',items)).rejects.toThrow()
  expect(query).not.toHaveBeenCalled()
 })
})
