import {afterEach,describe,it,expect,vi} from 'vitest'
import {activityRefundCommand,pendingActivityRefund} from './activity-refund-recovery'
function storage(){const rows=new Map<string,string>();return {getItem:(key:string)=>rows.get(key)??null,setItem:(key:string,value:string)=>{rows.set(key,value)},removeItem:(key:string)=>{rows.delete(key)}}}
afterEach(()=>vi.unstubAllGlobals())
describe('activity compensation recovery',()=>{
 it('retains original reason, amount and disposition across reload, blocks replacement and isolates registration and staff',async()=>{
  vi.stubGlobal('localStorage',storage());const scope=crypto.randomUUID(),keys:string[]=[],ledger=new Set<string>()
  const body={reason:'少送菜品补偿',amountMinor:1200,disposition:'retain_fulfillment' as const,customerConfirmed:true}
  const initial=activityRefundCommand(scope,'original',async(_body,key)=>{keys.push(key);ledger.add(key);throw Error('lost receipt')})
  await expect(initial.submit(body)).rejects.toThrow('lost receipt');expect(pendingActivityRefund(scope,'original')?.body).toEqual(body)
  vi.resetModules();const restored=await import('./activity-refund-recovery')
  const retry=restored.activityRefundCommand(scope,'original',async(sent,key)=>{expect(sent).toEqual(body);keys.push(key);ledger.add(key);return {refundPublicId:'original-refund'}})
  await expect(retry.submit({...body,amountMinor:2000})).rejects.toThrow('原操作')
  expect(restored.pendingActivityRefund(scope,'other')).toBeNull();expect(restored.pendingActivityRefund(scope+'other','original')).toBeNull()
  await retry.recover();expect(new Set(keys).size).toBe(1);expect(ledger.size).toBe(1)
  await expect(retry.refresh(async()=>{throw Error('read failed')})).rejects.toThrow('read failed');expect(restored.pendingActivityRefund(scope,'original')).not.toBeNull()
  await retry.refresh(async()=>{});expect(restored.pendingActivityRefund(scope,'original')).toBeNull()
 })
 it('does not send a financial request if the original intent cannot be persisted',async()=>{
  vi.stubGlobal('localStorage',{getItem:()=>null,setItem:()=>{},removeItem:()=>{}});const send=vi.fn(async()=>({ok:true}))
  await expect(activityRefundCommand(crypto.randomUUID(),'blocked',send).submit({reason:'有效原因'})).rejects.toThrow('操作记录未能保存');expect(send).not.toHaveBeenCalled()
 })
 it('rejects malformed persisted compensation rather than using its amount or disposition',()=>{
  const saved=storage(),employee=crypto.randomUUID();vi.stubGlobal('localStorage',saved)
  saved.setItem(`mbox.staff-command.v1:activity-refund:${employee}:original`,JSON.stringify({key:'old-key',body:{reason:'有效原因',amountMinor:-100,disposition:'stop_unstarted',customerConfirmed:true}}))
  expect(()=>pendingActivityRefund(employee,'original')).toThrow('原活动退款记录无法读取')
 })
})
