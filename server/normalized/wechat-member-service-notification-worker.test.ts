import { afterEach,describe, expect, it, vi } from 'vitest'
import type { ScopedTransaction } from './transaction-runner.js'
import { WechatMemberServiceNotificationWorker } from './wechat-member-service-notification-worker.js'

const scope={tenantId:'83000000-0000-4000-8000-000000000001',storeId:'83000000-0000-4000-8000-000000000002'}
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks()})

describe('WechatMemberServiceNotificationWorker',()=>{
  it('bounds an unresolved recipient lookup and records unknown without sending',async()=>{
    vi.useFakeTimers()
    const transaction=fakeTransaction(sql=>{
      if(sql.includes("FROM (VALUES('points_accrual')"))return activeControls()
      if(sql.includes('SELECT changed.id'))return{rows:[{id:'83000000-0000-4000-8000-000000000010',customer_id:'customer',identity_external_id:'identity'}],rowCount:1}
      return{rows:[],rowCount:1}
    })
    const sendTemplate=vi.fn()
    const worker=new WechatMemberServiceNotificationWorker(runner(transaction),{resolveMiniProgramNotificationRecipient:()=>new Promise(()=>{})},{sendTemplate})
    const pending=worker.runBatch(scope,'bounded-recipient')
    await vi.advanceTimersByTimeAsync(2100)
    expect(await pending).toMatchObject({claimed:1,unknown:['83000000-0000-4000-8000-000000000010'],accepted:[]})
    expect(sendTemplate).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('consumes one matching authorization and sends only configured template fields',async()=>{
    const statements:string[]=[]
    const transaction=fakeTransaction((sql)=>{
      statements.push(sql)
      if(sql.includes("FROM (VALUES('points_accrual')"))return activeControls()
      if(sql.includes('SELECT job.source_type,job.source_id'))return {rows:[{source_type:'membership_tier_event',source_id:'83000000-0000-4000-8000-000000000020',now:new Date().toISOString()}],rowCount:1}
      if(sql.includes('SELECT changed.id'))return {rows:[{
        id:'83000000-0000-4000-8000-000000000010',customer_id:'83000000-0000-4000-8000-000000000011',identity_external_id:'wx-identity-customer-self',
        template_id:'wechat-template-tier-001',page_path:'pages/profile/index',title_data_key:'thing1',detail_data_key:'thing2',occurred_at_data_key:'time3',
        title:'会员等级已更新',detail:'恭喜升级至：银卡会员',event_occurred_at:'2026-08-27T12:00:00.000Z',
      }],rowCount:1}
      if(sql.includes('RETURNING notification_job_id')&&sql.includes('member_service_notification_receipts'))return {rows:[],rowCount:1}
      return {rows:[],rowCount:1}
    })
    const preflight=vi.fn(async()=>undefined)
    const sendTemplate=vi.fn(async()=>({outcome:'accepted' as const,providerReference:'member-service-provider-001'}))
    const resolveRecipient=vi.fn(async()=>({identityExternalId:'wx-identity-customer-self',openId:'openid-self'}))
    const worker=new WechatMemberServiceNotificationWorker(runner(transaction),{resolveMiniProgramNotificationRecipient:resolveRecipient},{preflight,sendTemplate})
    const result=await worker.runBatch(scope,'worker-member-service-01')
    expect(result).toMatchObject({claimed:1,accepted:['83000000-0000-4000-8000-000000000010']})
    expect(preflight).toHaveBeenCalledBefore(sendTemplate)
    expect(sendTemplate).toHaveBeenCalledWith(expect.objectContaining({recipientOpenId:'openid-self',data:{thing1:'会员等级已更新',thing2:'恭喜升级至：银卡会员',time3:'2026-08-27 20:00'}}))
    expect(statements.some((sql)=>sql.includes('wechat_member_service_notification_authorization_uses'))).toBe(true)
    expect(statements.some((sql)=>sql.includes('wechat_member_service_notification_receipts'))).toBe(true)
  })
})

function activeControls(){return {rows:[
  {capability:'points_accrual',state:'active',control_version:0,reason:null,review_at:null,changed_by_employee_id:null,changed_at:null,pending_accrual_count:0},
  {capability:'points_redemption',state:'active',control_version:0,reason:null,review_at:null,changed_by_employee_id:null,changed_at:null,pending_accrual_count:0},
  {capability:'wechat_notification',state:'active',control_version:0,reason:null,review_at:null,changed_by_employee_id:null,changed_at:null,pending_accrual_count:0},
],rowCount:3}}
function runner(transaction:ScopedTransaction){return {run:async<Value>(_scope:typeof scope,operation:(current:ScopedTransaction)=>Promise<Value>|Value)=>operation(transaction)}}
function fakeTransaction(query:(sql:string,values?:readonly unknown[])=>{rows:Record<string,unknown>[];rowCount:number|null}):ScopedTransaction{return {scope,query:async<Row extends Record<string,unknown>>(sql:string,values?:readonly unknown[])=>{const result=query(sql,values);return{...result,rows:result.rows as Row[]}}}}
