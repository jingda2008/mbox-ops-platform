import {it,expect,vi} from 'vitest'
import {ManualPointsRecovery,type ManualPointsCommand} from './manual-points-recovery'
import type {ManualPointsResult} from '../shared/manual-points'
const rights=['loyalty.adjust.manual','loyalty.accrual.approve'],command:ManualPointsCommand={kind:'request',body:{memberNo:'MBX001',pointsDelta:10,reason:'核对原补发依据'}}
const receipt:ManualPointsResult={requestId:'11111111-1111-4111-8111-111111111111',status:'requested',pointsDelta:10,availableDelta:0,balance:0,pendingRecoveryPoints:0}
function storage(){const m=new Map<string,string>();return{getItem:(k:string)=>m.get(k)??null,setItem:(k:string,v:string)=>{m.set(k,v)},removeItem:(k:string)=>{m.delete(k)}}}
it('persists the original quantity, actor and key before sending and restores after reload without making a new request',async()=>{
 const saved=storage(),r=new ManualPointsRecovery('tenant:store','actor',saved),send=vi.fn(async()=>{expect(r.pending()?.body).toEqual(command.body);throw new Error('network')})
 await expect(r.execute(command,rights,send,async()=>{})).rejects.toThrow('network')
 const intent=r.pending(),reload=new ManualPointsRecovery('tenant:store','actor',saved)
 await expect(reload.execute({...command,body:{...command.body,pointsDelta:20}},rights,send,async()=>{})).rejects.toThrow('先恢复')
 const restore=vi.fn(async()=>receipt);await reload.execute(null,rights,restore,async()=>{});expect(restore).toHaveBeenCalledWith(intent);expect(reload.pending()).toBeNull()
})
it('does not send when durable storage fails, permissions were revoked or requester tries self-review',async()=>{
 const send=vi.fn(async()=>receipt)
 const saved=storage();saved.setItem=()=>{throw new Error('quota')}
 await expect(new ManualPointsRecovery('s','a',saved).execute(command,rights,send,async()=>{})).rejects.toThrow('quota')
 await expect(new ManualPointsRecovery('s','a',storage()).execute(command,[],send,async()=>{})).rejects.toThrow('无权')
 await expect(new ManualPointsRecovery('s','a',storage()).execute({kind:'decision',requestedBy:'a',body:{requestId:receipt.requestId,decision:'approve',reason:'独立复核依据'}},rights,send,async()=>{})).rejects.toThrow('无权')
 expect(send).not.toHaveBeenCalled()
})
it('keeps unknown, rejected authorization and mismatched receipts pending; only explicit business rollback permits correction',async()=>{
 for(const error of [Object.assign(new Error('denied'),{status:403,code:'MANUAL_POINTS_LIMIT',commitDisposition:'not_committed'}),Object.assign(new Error('conflict'),{status:409,code:'IDEMPOTENCY_CONFLICT',commitDisposition:'not_committed'}),new Error('network')]){
  const r=new ManualPointsRecovery('s','a',storage());await expect(r.execute(command,rights,async()=>{throw error},async()=>{})).rejects.toThrow();expect(r.pending()).not.toBeNull()
 }
 const r=new ManualPointsRecovery('s','a',storage());await expect(r.execute(command,rights,async()=>({...receipt,pointsDelta:20}),async()=>{})).rejects.toThrow('回执');expect(r.pending()).not.toBeNull()
 await expect(r.execute(null,rights,async()=>{throw Object.assign(new Error('limit'),{status:409,code:'MANUAL_POINTS_LIMIT',commitDisposition:'not_committed'})},async()=>{})).rejects.toThrow('limit');expect(r.pending()).toBeNull()
})
it('keeps committed receipt after failed readback, deduplicates in-flight recovery and separates actors and stores',async()=>{
 const saved=storage(),r=new ManualPointsRecovery('s','a',saved)
 await expect(r.execute(command,rights,async()=>receipt,async()=>{throw new Error('read timeout')})).rejects.toThrow('read timeout');expect(r.pending()).not.toBeNull()
 expect(new ManualPointsRecovery('s','b',saved).pending()).toBeNull();expect(new ManualPointsRecovery('t','a',saved).pending()).toBeNull()
 let finish!:(v:ManualPointsResult)=>void;const send=vi.fn(()=>new Promise<ManualPointsResult>(resolve=>{finish=resolve})),read=vi.fn(async()=>{})
 const a=r.execute(null,rights,send,read),b=r.execute(null,rights,send,read);await Promise.resolve();expect(send).toHaveBeenCalledTimes(1);finish(receipt);await Promise.all([a,b]);expect(read).toHaveBeenCalledTimes(1);expect(r.pending()).toBeNull()
})
