import {describe,expect,it} from 'vitest'
import {parseChannelActivationReceipt} from './channel-receipt'
import {DurableStaffCommand} from '../normalized-ui/durable-staff-command'

describe('channel activation receipt recovery',()=>{
  it.each([null,{},[],{claimId:7,activationId:'a',visitId:'v'},{claimId:'claim',activationId:'a'},
    {claimId:'claim',activationId:' ',visitId:'v'},{claimId:'other',activationId:'a',visitId:'v'}])('keeps the original staff intent across invalid receipt %j and restart',async malformed=>{
    const values=new Map<string,string>(),storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value)},removeItem:(key:string)=>{values.delete(key)}}
    const sent:{key:string;recovery:boolean}[]=[]
    const send=async(input:{claimId:string},key:string,context:{recovery:boolean})=>{
      sent.push({key,recovery:context.recovery})
      return parseChannelActivationReceipt(sent.length===1?malformed:{claimId:'claim',activationId:'a',visitId:'v'},input.claimId)
    }
    const namespace='channel-receipt-'+JSON.stringify(malformed),first=new DurableStaffCommand(namespace,send,storage,true)
    await expect(first.submit({claimId:'claim'})).rejects.toMatchObject({code:'CHANNEL_RECEIPT_INVALID'})
    expect(first.pending()).not.toBeNull()
    const restarted=new DurableStaffCommand(namespace,send,storage,true)
    await expect(restarted.submit({claimId:'different'})).rejects.toThrow('原操作')
    await expect(restarted.recover()).resolves.toEqual({claimId:'claim',activationId:'a',visitId:'v'})
    expect(sent).toHaveLength(2);expect(sent[1]).toEqual({key:sent[0]!.key,recovery:true})
    await restarted.refresh(async()=>{});expect(restarted.pending()).toBeNull()
  })
  it('accepts automatic staff selection only with a complete coupon and visit receipt',()=>{
    expect(parseChannelActivationReceipt({claimId:'claim',activationId:'a',visitId:'v'})).toEqual({claimId:'claim',activationId:'a',visitId:'v'})
  })
})

it('keeps staff recovery isolated after account or split-table changes and retains a receipt until readback succeeds',async()=>{
  const rows=new Map<string,string>(),storage={getItem:(key:string)=>rows.get(key)??null,setItem:(key:string,value:string)=>{rows.set(key,value)},removeItem:(key:string)=>{rows.delete(key)}}
  const sends:string[]=[]
  const send=async(_body:{claimId:string},key:string)=>{sends.push(key);if(sends.length===1)throw new Error('offline');return{claimId:'claim',activationId:'a',visitId:'v'}}
  const original=new DurableStaffCommand('channel:staff-a:source',send,storage,true)
  await expect(original.submit({claimId:'claim'})).rejects.toThrow('offline')
  for(const namespace of ['channel:staff-b:source','channel:staff-a:split']){
    const other=new DurableStaffCommand(namespace,send,storage,true)
    expect(()=>other.recover()).toThrow('没有待恢复');expect(sends).toHaveLength(1)
  }
  const restored=new DurableStaffCommand('channel:staff-a:source',send,storage,true)
  await restored.recover();expect(sends[1]).toBe(sends[0])
  await expect(restored.refresh(async()=>{throw new Error('已切换桌次')})).rejects.toThrow('已切换桌次')
  expect(restored.pending()).not.toBeNull()
  await restored.refresh(async()=>{});expect(restored.pending()).toBeNull()
})
