import {createElement} from 'react'
import {NormalizedApiClient} from '../normalized-api'
import {renderToStaticMarkup} from 'react-dom/server'
import {describe,expect,it,vi} from 'vitest'
import {effectiveStaffNavigation} from '../shared/staff-module-access'
import type {OrderFinancialRecoveryResult,OrderRecoverySnapshot} from '../shared/order-financial-recovery'
import {OrderFinancialRecoveryJournal,canSendFinancialRecovery,financialRecoveryPermissions,recoveryDefinitelyNotCommitted,sendFinancialRecoveryIntent,type FinancialRecoveryCommand} from './order-financial-recovery'
import {RecoveryAmounts} from './OrderFinancialRecoveryPanel'
const finance=['reconciliation.view','reconciliation.manage'],loyalty=[...finance,'loyalty.accrual.exception.view','loyalty.accrual.request','loyalty.accrual.approve']
const command:FinancialRecoveryCommand={kind:'request',orderId:'original-order',orderPublicId:'ORDER-original',body:{basisVersion:'a'.repeat(64),dimensions:'attribution',reason:'核对原退款和真实补收'}}
const receipt:{data:OrderFinancialRecoveryResult}={data:{requestId:'request-1',orderId:command.orderId,orderPublicId:command.orderPublicId,dimensions:'attribution',status:'requested',itemAmountMinor:0,recommendationAmountMinor:0,pointsDelta:0,growthDelta:0,availablePointsDelta:0,pendingRecoveryPointsDelta:0}}
function storage(){const values=new Map<string,string>();return {get length(){return values.size},key:(i:number)=>[...values.keys()][i]??null,getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>{values.set(k,v)},removeItem:(k:string)=>{values.delete(k)}}}
describe('original-order recovery intent and financial-only access',()=>{
  it('recovers the exact request after a lost response and refresh, and waits for authoritative readback',async()=>{
    const saved=storage(),first=new OrderFinancialRecoveryJournal('t:s','requester',saved),sent:string[]=[]
    await expect(first.execute(command,finance,async intent=>{sent.push(JSON.stringify(intent));throw new Error('response lost')},async()=>{})).rejects.toThrow('response lost')
    const refreshed=new OrderFinancialRecoveryJournal('t:s','requester',saved)
    await expect(refreshed.execute(null,finance,async intent=>{sent.push(JSON.stringify(intent));return receipt},async()=>{throw new Error('readback lost')})).rejects.toThrow('readback lost')
    expect(refreshed.pending()).not.toBeNull()
    await refreshed.execute(null,finance,async intent=>{sent.push(JSON.stringify(intent));return receipt},async()=>{})
    expect(new Set(sent).size).toBe(1);expect(refreshed.pending()).toBeNull()
  })
  it('uses the real API client envelope for an accepted original intent',async()=>{
    const fetcher=vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(receipt),{status:200,headers:{'content-type':'application/json'}}))
    const api=new NormalizedApiClient({fetch:fetcher}),journal=new OrderFinancialRecoveryJournal('t:s','requester',storage())
    expect(await journal.execute(command,finance,intent=>sendFinancialRecoveryIntent(api,intent),async()=>{})).toEqual(receipt.data)
    expect(journal.pending()).toBeNull();expect(fetcher).toHaveBeenCalledTimes(1)
    const options=fetcher.mock.calls[0]![1]!
    expect(new Headers(options.headers).get('idempotency-key')).toMatch(/^order-recovery-/);expect(JSON.parse(options.body as string)).toEqual(command.body)
  })
  it('coalesces concurrent same-intent retries without allowing replacement body',async()=>{
    const saved=storage(),journal=new OrderFinancialRecoveryJournal('t:s','requester',saved)
    let finish!:(value:typeof receipt)=>void;const send=vi.fn(()=>new Promise<typeof receipt>(resolve=>{finish=resolve}))
    const first=journal.execute(command,finance,send,async()=>{})
    await Promise.resolve();const second=journal.execute(null,finance,send,async()=>{})
    await expect(journal.execute({...command,body:{...command.body,reason:'替换原内容'}},finance,send,async()=>{})).rejects.toThrow('不能用新申请覆盖')
    finish(receipt);await Promise.all([first,second]);expect(send).toHaveBeenCalledTimes(1)
  })
  it('retains keys for auth, conflict and unknown failures; clears only explicit rollback rejection',async()=>{
    for(const error of [{status:401,code:'AUTHENTICATION_REQUIRED'},{status:403,code:'PERMISSION_DENIED'},{status:409,code:'IDEMPOTENCY_CONFLICT'},{status:409,code:'ORDER_RECOVERY_STALE'},{status:500,code:'ORDER_RECOVERY_STALE',commitDisposition:'not_committed'}]){
      const journal=new OrderFinancialRecoveryJournal('t:s','requester',storage())
      await expect(journal.execute(command,finance,async()=>{throw error},async()=>{})).rejects.toEqual(error)
      expect(journal.pending()).not.toBeNull();expect(recoveryDefinitelyNotCommitted(error)).toBe(false)
    }
    const journal=new OrderFinancialRecoveryJournal('t:s','requester',storage()),error={status:409,code:'ORDER_RECOVERY_STALE',commitDisposition:'not_committed'}
    await expect(journal.execute(command,finance,async()=>{throw error},async()=>{})).rejects.toEqual(error);expect(journal.pending()).toBeNull()
  })
  it('gates dimensions independently and keeps a revoked original intent without transmission',async()=>{
    expect(financialRecoveryPermissions(finance)).toMatchObject({view:true,request:true,approve:true})
    expect(effectiveStaffNavigation(finance,[]).some(item=>item.route==='/staff/payments')).toBe(true)
    expect(canSendFinancialRecovery(command,'requester',finance)).toBe(true)
    const all:FinancialRecoveryCommand={...command,body:{...command.body,dimensions:'all'}}
    expect(canSendFinancialRecovery(all,'requester',finance)).toBe(false);expect(canSendFinancialRecovery(all,'requester',loyalty)).toBe(true)
    const journal=new OrderFinancialRecoveryJournal('t:s','requester',storage()),send=vi.fn(async()=>receipt)
    await expect(journal.execute(command,finance,async()=>{throw new Error('unknown')},async()=>{})).rejects.toThrow()
    await expect(journal.execute(null,['reconciliation.view'],send,async()=>{})).rejects.toThrow('无权恢复');expect(send).not.toHaveBeenCalled();expect(journal.pending()).not.toBeNull()
  })
  it('binds decision dimensions and actor, forbids self review and preserves storage per scope',async()=>{
    const decision:FinancialRecoveryCommand={kind:'decision',orderId:command.orderId,orderPublicId:command.orderPublicId,requestId:'request-1',requestedByEmployeeId:'requester',dimensions:'all',body:{basisVersion:'a'.repeat(64),decision:'approve',reason:'异人核对原贡献'}}
    expect(canSendFinancialRecovery(decision,'requester',loyalty)).toBe(false);expect(canSendFinancialRecovery(decision,'reviewer',finance)).toBe(false)
    const saved=storage(),journal=new OrderFinancialRecoveryJournal('t:s','reviewer',saved)
    await expect(journal.execute(decision,loyalty,async()=>{throw new Error('unknown')},async()=>{})).rejects.toThrow()
    expect(new OrderFinancialRecoveryJournal('other:s','reviewer',saved).pending()).toBeNull();expect(new OrderFinancialRecoveryJournal('t:s','requester',saved).pending()).toBeNull()
    await expect(journal.execute(null,loyalty,async()=>({data:{...receipt.data,status:'approved',dimensions:'attribution'}}),async()=>{})).rejects.toThrow('回执无法核对');expect(journal.pending()).not.toBeNull()
  })
  it('does not send without durable storage or accept numeric override fields',async()=>{
    const saved=storage();saved.setItem=()=>{throw new Error('storage failed')};const send=vi.fn(async()=>receipt)
    await expect(new OrderFinancialRecoveryJournal('t:s','requester',saved).execute(command,finance,send,async()=>{})).rejects.toThrow('storage failed');expect(send).not.toHaveBeenCalled()
    const changed={...command,body:{...command.body,pointsDelta:999}}
    await expect(new OrderFinancialRecoveryJournal('t:s','requester',storage()).execute(changed,finance,send,async()=>{})).rejects.toThrow('重新读取');expect(send).not.toHaveBeenCalled()
  })
  it('renders no-member attribution and rule-pending expiry without claiming member credit',()=>{
    const snapshot:OrderRecoverySnapshot={attribution:{eligible:true,itemAmountMinor:2000,recommendationCurrentMinor:2000,recommendationExpectedMinor:4000,recommendationDeltaMinor:2000,blockReasons:[],items:[]},loyalty:{status:'permission_required',memberNo:null,policyVersionId:null,eligibleAmountMinor:0,pointsDelta:0,growthDelta:0,availablePointsDelta:0,pendingRecoveryPointsDelta:0,expiresAt:null,blockReasons:[]}}
    const financeHtml=renderToStaticMarkup(createElement(RecoveryAmounts,{snapshot}));expect(financeHtml).toContain('推荐归属不代表现金佣金');expect(financeHtml).toContain('当前仍可独立处理商品与推荐归属');expect(financeHtml).not.toContain('会员 null')
    const pending=renderToStaticMarkup(createElement(RecoveryAmounts,{snapshot:{...snapshot,loyalty:{...snapshot.loyalty,status:'rule_pending'}}}));expect(pending).toContain('规则待确认');expect(pending).toContain('不能恢复会员贡献')
  })
})
