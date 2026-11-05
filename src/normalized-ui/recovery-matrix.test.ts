import {afterEach,describe,it,expect,vi} from 'vitest'
import {executeRecoverableCommand} from './recoverable-command'
import {GuestServiceRecovery} from './guest/guest-service-recovery'
import {GuestCheckoutRecovery} from './guest/guest-checkout-recovery'
import {GuestApiError,type GuestOrderResult} from './guest/guest-api'
import {StaffPermissionRecovery} from './staff-permission-recovery'
import type {StaffPermissionDeploymentChange,StaffPermissionDeploymentResult} from '../shared/normalized-contracts'
function storage(){const m=new Map<string,string>();return {get length(){return m.size},key:(i:number)=>[...m.keys()][i]??null,getItem:(k:string)=>m.get(k)??null,setItem:(k:string,v:string)=>{m.set(k,v)},removeItem:(k:string)=>{m.delete(k)}}}
afterEach(()=>vi.unstubAllGlobals())
const body={expectedVersion:'a'.repeat(64),reason:'调整配置',changes:[{kind:'employee_override' as const,employeeId:'target',permissionCode:'order.create',effect:'grant' as const}]}
const receipt:StaffPermissionDeploymentResult={status:'verified',replayed:true,verifiedAt:'2026-11-05T00:00:00Z',overview:null,changes:[{kind:'employee_override',targetId:'target',configurationCode:'order.create',applied:true,effectiveEmployeeCount:1,affectedEmployeeCount:1}]}
describe('cross-domain recovery fault matrix',()=>{
 it.each(['{broken','{}','null','[]'])('does not overwrite a malformed generic retry journal %s',async raw=>{
  const send=vi.fn(),saved={getItem:()=>raw,setItem:vi.fn(),removeItem:vi.fn()};vi.stubGlobal('sessionStorage',saved)
  await expect(executeRecoverableCommand(crypto.randomUUID(),{amount:100},'new-key',send)).rejects.toThrow()
  expect(send).not.toHaveBeenCalled();expect(saved.setItem).not.toHaveBeenCalled()
 })
 it('rejects changed service input while the original is in flight',async()=>{
  const recovery=new GuestServiceRecovery(storage(),'table','device');let finish!:(v:{status:'created';message:string})=>void
  const send=vi.fn(()=>new Promise<{status:'created';message:string}>(resolve=>{finish=resolve}))
  const first=recovery.execute({requestType:'custom',detail:'送水'},send)
  const changed=recovery.execute({requestType:'complaint',detail:'投诉'},send)
  finish({status:'created',message:'送水已受理'});await first
  await expect(changed).rejects.toThrow('上一条');expect(send).toHaveBeenCalledTimes(1)
 })
 it.each(['PRODUCT_UNAVAILABLE','SHARED_CART_VERSION_CONFLICT','TABLE_PREPAYMENT_NOT_ENABLED','CART_NOTE_STALE'])('keeps uncertain checkout after later %s',async code=>{
  const recovery=new GuestCheckoutRecovery(storage(),'table','device'),input={protocol:2 as const,body:{expectedGeneration:1,expectedVersion:0,note:null}}
  await expect(recovery.execute(input,async()=>{throw Error('lost')})).rejects.toThrow();const before=recovery.pending()
  await expect(recovery.execute(null,async()=>{throw new GuestApiError('denied','http',409,code)})).rejects.toThrow()
  expect(recovery.pending()).toEqual(before)
  const send=vi.fn(async()=>({} as GuestOrderResult));await expect(recovery.execute({...input,body:{...input.body,expectedVersion:2}},send)).rejects.toThrow();expect(send).not.toHaveBeenCalled()
 })
 it.each(['STAFF_ACCESS_VERSION_CONFLICT','PERMISSION_DEPLOYMENT_INVALID'])('keeps uncertain permission publication after later %s',async code=>{
  const r=new StaffPermissionRecovery('tenant:store','admin',storage());await expect(r.execute(body,async()=>{throw Error('lost')})).rejects.toThrow();const before=r.pending()
  await expect(r.execute(null,async()=>{throw {code}})).rejects.toEqual({code});expect(r.pending()).toEqual(before)
  const send=vi.fn(async()=>receipt);await r.execute(null,send);expect(send).toHaveBeenCalledWith(before,true)
 })
 it.each(['empty','wrong-target','wrong-code','negative-count'])('does not clear permission intent on mismatched receipt: %s',async kind=>{
  const r=new StaffPermissionRecovery('tenant:store','admin',storage()),bad=structuredClone(receipt)
  if(kind==='empty')bad.changes=[]
  if(kind==='wrong-target')bad.changes[0].targetId='other'
  if(kind==='wrong-code')bad.changes[0].configurationCode='refund.execute'
  if(kind==='negative-count')bad.changes[0].effectiveEmployeeCount=-1
  await expect(r.execute(body,async()=>bad)).rejects.toThrow();expect(r.pending()).not.toBeNull()
  await r.execute(null,async()=>receipt);expect(r.pending()).toBeNull()
 })
})


describe('recovery positive controls and malformed receipt matrix',()=>{
 it('fails closed on unreadable storage without sending or overwriting',async()=>{
  const saved={getItem:()=>{throw Error('unavailable')},setItem:vi.fn()},send=vi.fn();vi.stubGlobal('sessionStorage',saved)
  await expect(executeRecoverableCommand(crypto.randomUUID(),{},'new-key',send)).rejects.toThrow('无法读取')
  expect(send).not.toHaveBeenCalled();expect(saved.setItem).not.toHaveBeenCalled()
 })
 it('accepts all five permission kinds in reordered minimal receipts with zero affected staff',async()=>{
  const changes:StaffPermissionDeploymentChange[]=[body.changes[0],
   {kind:'role_permission',roleId:'role',permissionCode:'order.view',enabled:false},
   {kind:'role_data_scope',roleId:'role',scopeKey:'report.history',effect:'include',scopeValue:true,enabled:true},
   {kind:'role_approval_limit',roleId:'role',approvalCode:'refund',currency:'CNY',amountMinor:100,rules:{},enabled:true},
   {kind:'role_navigation',roleId:'role',navigationCode:'reports',label:'报表',route:'/reports',icon:null,sortOrder:1,enabled:true,displayConfig:{}}]
  const good:StaffPermissionDeploymentResult={...receipt,replayed:false,changes:[receipt.changes[0],
   ...(['order.view','report.history:include','refund:CNY','reports'].map((code,index)=>({kind:changes[index+1].kind,targetId:'role',configurationCode:code,applied:true,effectiveEmployeeCount:0,affectedEmployeeCount:0})))].reverse()}
  const r=new StaffPermissionRecovery('tenant:store','admin',storage()),send=vi.fn(async (_intent:unknown,_receiptOnly:boolean)=>good)
  await expect(r.execute({...body,changes},send)).resolves.toEqual(good);expect(send.mock.calls[0][1]).toBe(false);expect(r.pending()).toBeNull()
 })
 it.each(['duplicate','not-applied','fractional','over-count','timestamp'])('retains intent on malformed permission receipt %s',async kind=>{
  const r=new StaffPermissionRecovery('tenant:store','admin',storage()),bad=structuredClone(receipt)
  const changes:StaffPermissionDeploymentChange[]=[...body.changes,{...body.changes[0],employeeId:'second'}]
  bad.changes.push({...bad.changes[0],targetId:'second'})
  if(kind==='duplicate')bad.changes[1]=structuredClone(bad.changes[0])
  if(kind==='not-applied')bad.changes[0].applied=false
  if(kind==='fractional')bad.changes[0].effectiveEmployeeCount=0.5
  if(kind==='over-count')bad.changes[0].effectiveEmployeeCount=2
  if(kind==='timestamp')bad.verifiedAt='invalid'
  await expect(r.execute({...body,changes},async()=>bad)).rejects.toThrow();expect(r.pending()).not.toBeNull()
 })
 it.each(['PRODUCT_UNAVAILABLE','SHARED_CART_VERSION_CONFLICT','TABLE_PREPAYMENT_NOT_ENABLED','CART_NOTE_STALE'])('allows correction of a fresh definitive checkout refusal %s',async code=>{
  const r=new GuestCheckoutRecovery(storage(),'table','device'),input={protocol:2 as const,body:{expectedGeneration:1,expectedVersion:0,note:null}}
  await expect(r.execute(input,async()=>{throw new GuestApiError('denied','http',409,code)})).rejects.toThrow();expect(r.pending()).toBeNull()
 })
})
