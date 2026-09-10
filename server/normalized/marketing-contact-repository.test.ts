import {randomUUID} from 'node:crypto'
import {beforeAll,afterAll,describe,it,expect} from 'vitest'
import {Pool} from 'pg'
import {runNormalizedMigrations} from '../migrate-normalized.js'
import {ScopedPostgresTransactionRunner,type PostgresPool} from './transaction-runner.js'
import {MarketingContactRepository} from './marketing-contact-repository.js'
import {CustomerRepository} from './customer-repository.js'
import {MarketingDeliveryRepository,type MarketingChannelEvidence} from './marketing-delivery-repository.js'
import {MarketingDeliveryWorker} from './marketing-delivery-worker.js'
const url=process.env.TEST_NORMALIZED_DATABASE_URL
;(url?describe:describe.skip)('marketing consent persistence independent from membership and subscriptions',()=>{
  const tenantId=randomUUID(),storeId=randomUUID(),editor=randomUUID(),approver=randomUUID(),publisher=randomUUID(),denied=randomUUID(),role=randomUUID(),scope={tenantId,storeId},businessDate='2026-09-09'
  let pool:Pool,runner:ScopedPostgresTransactionRunner,noticeId:string
  const run=<T>(action:(repo:MarketingContactRepository)=>Promise<T>)=>runner.run(scope,tx=>action(new MarketingContactRepository(tx)))
  beforeAll(async()=>{
    await runNormalizedMigrations(url!);pool=new Pool({connectionString:url,max:8});runner=new ScopedPostgresTransactionRunner({connect:()=>pool.connect(),end:()=>pool.end()} as PostgresPool)
    await pool.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'Marketing test')",[tenantId,`marketing-${tenantId.slice(0,8)}`]);await pool.query("INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1,$2,'marketing-test','Marketing test')",[storeId,tenantId])
    for(const [id,code] of [[editor,'EDITOR'],[approver,'APPROVER'],[publisher,'PUBLISHER'],[denied,'DENIED']])await pool.query('INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$2,$3,$4,$4)',[id,tenantId,storeId,code])
    await pool.query("INSERT INTO mbox.roles(id,tenant_id,store_id,code,name) VALUES($1,$2,$3,'MARKETING_TEST','Marketing test')",[role,tenantId,storeId])
    for(const employeeId of [editor,approver,publisher])await pool.query("INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id,starts_at) VALUES($1,$2,$3,$4,clock_timestamp()-interval '1 minute')",[tenantId,storeId,employeeId,role])
    await pool.query("INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) SELECT $1,$2,$3,id FROM mbox.staff_permission_definitions WHERE tenant_id=$1 AND store_id=$2 AND code LIKE 'marketing.%'",[tenantId,storeId,role])
    const rule={operatorName:'隔离测试运营主体',operatorContact:'测试客服',summary:'门店活动及由本店联系的联合活动，不向合作方提供名单。',withdrawalInstructions:'随时停止全部营销联系，原会员与权益不受影响。',purposes:['own_activities','mbox_joint_activities'],channels:['wechat','sms','phone'],dataCategories:['本人联系地址'],validFrom:new Date(Date.now()-86400000).toISOString(),validUntil:new Date(Date.now()+30*86400000).toISOString(),consentDays:7,contactStartMinute:0,contactEndMinute:1440,weekdays:[1,2,3,4,5,6,7],maximumPerDay:1,maximumPerMonth:4,sharingMode:'no_partner_list'}
    const input={code:'MARKETING_NOTICE',rule,employeeId:editor,businessDate,reason:'隔离许可测试',requestKey:randomUUID(),expectedVersion:0}
    const saved=await run(repo=>repo.save(input));noticeId=saved.noticeId
    expect(await run(repo=>repo.save(input))).toEqual({...saved,replayed:true})
    await expect(run(repo=>repo.decide({noticeId,action:'approve',employeeId:editor,businessDate,reason:'禁止自审'}))).rejects.toThrow('不同')
    for(const [action,employeeId] of [['approve',approver],['publish',publisher]] as const)await run(repo=>repo.decide({noticeId,action,employeeId,businessDate,reason:'核实告知范围'}))
  })
  afterAll(async()=>pool?.end())
  async function customer(){const id=randomUUID();await pool.query('INSERT INTO mbox.customers(id,tenant_id,store_id,public_id) VALUES($1,$2,$3,$4)',[id,tenantId,storeId,`marketing-${id}`]);return id}
  const grant=(customerId:string,expectedRevision:string)=>run(repo=>repo.recordChoices({customerId,noticeId,expectedRevision,businessDate,choices:[{channel:'sms',purpose:'own_activities',decision:'granted'}]}))
  const delivery=<T>(action:(repo:MarketingDeliveryRepository)=>Promise<T>)=>runner.run(scope,tx=>action(new MarketingDeliveryRepository(tx)))
  const evidence=(customerId:string):MarketingChannelEvidence=>({customerId,channel:'sms',purpose:'own_activities',checkedAt:new Date().toISOString(),validUntil:new Date(Date.now()+60000).toISOString(),channelReady:true,verifiedRecipient:true,platformPermissionVerified:true,capabilityRef:'isolated-capability',recipientRef:'isolated-recipient',platformRef:'isolated-platform'})
  const queue=(customerId:string,campaignKey=randomUUID())=>delivery(repo=>repo.queue({customerId,noticeId,channel:'sms',purpose:'own_activities',campaignKey,content:'隔离数据库任务，不发送真实客户',expiresAt:new Date(Date.now()+3600000).toISOString(),employeeId:publisher,businessDate}))
  it('defaults all scopes closed and keeps a chosen channel separate from delivery capability',async()=>{
    const customerId=await customer(),before=await run(repo=>repo.selfView(customerId))
    expect(before.revision).toBe('none');expect(before.decisions.every(d=>d.decision==='not_granted')).toBe(true)
    const result=await grant(customerId,before.revision)
    expect(result.decisions.filter(d=>d.decision==='granted')).toHaveLength(1)
    expect(result.decisions.find(d=>d.channel==='sms'&&d.purpose==='own_activities')?.decision).toBe('granted')
    expect(result.channels.every(c=>!c.ready)).toBe(true)
    expect((await pool.query('SELECT count(*)::int AS n FROM mbox.customer_notification_consents WHERE customer_id=$1',[customerId])).rows[0].n).toBe(0)
  })
  it('stop-all rejects stale grants and does not require an available notice',async()=>{
    const customerId=await customer(),granted=await grant(customerId,'none')
    await run(repo=>repo.stopAll({customerId,businessDate}))
    await expect(grant(customerId,granted.revision)).rejects.toThrow('已变化')
    const stopped=await run(repo=>repo.selfView(customerId));expect(stopped.stoppedAll).toBe(true)
    expect(stopped.decisions.every(d=>d.decision!=='granted')).toBe(true)
    const reopened=await grant(customerId,stopped.revision);expect(reopened.decisions.filter(d=>d.decision==='granted')).toHaveLength(1)
  })
  it('serializes concurrent choices and keeps evidence immutable',async()=>{
    const customerId=await customer(),results=await Promise.allSettled([grant(customerId,'none'),grant(customerId,'none')])
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1)
    expect((await pool.query('SELECT count(*)::int AS n FROM mbox.marketing_consent_events WHERE customer_id=$1',[customerId])).rows[0].n).toBe(1)
    await expect(pool.query("UPDATE mbox.marketing_consent_events SET action='withdrawn' WHERE customer_id=$1",[customerId])).rejects.toThrow()
    await expect(pool.query("UPDATE mbox.marketing_notice_versions SET summary='悄悄扩大原用途' WHERE id=$1",[noticeId])).rejects.toThrow()
  })
  it('merged customer stop dominates old grants and event order remains numeric after ten changes',async()=>{
    const source=await customer(),target=await customer();await grant(source,'none')
    await runner.run(scope,tx=>new CustomerRepository(tx).merge(source,target))
    await run(repo=>repo.stopAll({customerId:target,businessDate}))
    for(let i=0;i<12;i++){
      const view=await run(repo=>repo.selfView(target));await grant(target,view.revision);await run(repo=>repo.stopAll({customerId:source,businessDate}))
    }
    expect((await run(repo=>repo.selfView(target))).decisions.every(d=>d.decision!=='granted')).toBe(true)
    expect((await pool.query("SELECT customer_id FROM mbox.marketing_consent_events WHERE customer_id=$1 AND action='granted'",[source])).rows).toHaveLength(1)
  })
  it('only refusal-authorized staff can record refusal, never staff-invented consent',async()=>{
    const customerId=await customer();await grant(customerId,'none')
    await expect(run(repo=>repo.stopAll({customerId,businessDate,employeeId:denied,reason:'客户明确拒绝'}))).rejects.toThrow()
    await run(repo=>repo.stopAll({customerId,businessDate,employeeId:publisher,reason:'客户明确拒绝'}))
    expect((await run(repo=>repo.selfView(customerId))).stoppedAll).toBe(true)
    await expect(pool.query("INSERT INTO mbox.marketing_consent_events(tenant_id,store_id,customer_id,action,channel,purpose,notice_id,valid_until,source,actor_employee_id,reason) VALUES($1,$2,$3,'granted','phone','own_activities',$4,clock_timestamp()+interval '1 day','staff_recorded_refusal',$5,'员工伪造客户同意')",[tenantId,storeId,customerId,noticeId,publisher])).rejects.toThrow()
  })
  it('audits merged consent history with exact paging, original notice and no contact-address disclosure',async()=>{
    const source=await customer(),target=await customer();await grant(source,'none')
    await runner.run(scope,tx=>new CustomerRepository(tx).merge(source,target))
    await pool.query("INSERT INTO mbox.marketing_consent_events(tenant_id,store_id,customer_id,action,source) SELECT $1,$2,$3,'stop_all','customer_self' FROM generate_series(1,52)",[tenantId,storeId,target])
    const input={employeeId:publisher,customerId:source,businessDate,reason:'客户要求核对许可历史'}
    const first=await run(repo=>repo.consentHistory(input))
    expect(first.customerId).toBe(target);expect(first.items).toHaveLength(50);expect(first.nextCursor).not.toBeNull()
    const second=await run(repo=>repo.consentHistory({...input,cursor:first.nextCursor}))
    expect(second.items).toHaveLength(3);expect(second.nextCursor).toBeNull()
    expect(new Set([...first.items,...second.items].map(row=>row.id)).size).toBe(53)
    expect(second.items.at(-1)).toMatchObject({action:'granted',channel:'sms',source:'customer_self',notice:{version:1,operatorName:'隔离测试运营主体'}})
    expect(JSON.stringify(first)).not.toMatch(/phone_number|openid|recipientRef|access_token/)
    const audit=await pool.query("SELECT reason FROM mbox.audit_events WHERE object_id=$1 AND action='marketing.consent_history_viewed'",[target])
    expect(audit.rows).toHaveLength(2);expect(audit.rows.every(row=>row.reason===input.reason)).toBe(true)
    await expect(run(repo=>repo.consentHistory({...input,employeeId:denied}))).rejects.toThrow()
    await expect(run(repo=>repo.consentHistory({...input,reason:''}))).rejects.toThrow()
    await expect(run(repo=>repo.consentHistory({...input,cursor:'9223372036854775808'}))).rejects.toThrow()
  })
  it('withdrawal cancels queued and blocked jobs in the same commit without orders or benefits',async()=>{
    const id=await customer();await grant(id,'none');const a=await queue(id),b=await queue(id)
    expect(await delivery(repo=>repo.prepare(a.jobId,null))).toMatchObject({status:'blocked',reason:'channel_not_configured'})
    await run(repo=>repo.withdrawChannel({customerId:id,channel:'sms',businessDate}))
    for(const job of [a,b])expect((await delivery(repo=>repo.get(job.jobId))).status).toBe('cancelled')
    expect((await pool.query('SELECT count(*)::int AS n FROM mbox.marketing_delivery_attempts WHERE customer_id=$1',[id])).rows[0].n).toBe(0)
    await expect(queue(id)).rejects.toThrow('有效本人')
  })
  it('persists blocked backoff and does not claim delivery without independent channel proofs',async()=>{
    const id=await customer();await grant(id,'none');const job=await queue(id)
    const bad={...evidence(id),platformPermissionVerified:false}
    expect(await delivery(repo=>repo.prepare(job.jobId,bad))).toMatchObject({status:'blocked',reason:'channel_authority_missing'})
    const row=(await pool.query('SELECT checks,next_check_at>clock_timestamp()+interval \'14 minutes\' AS backed_off FROM mbox.marketing_delivery_jobs WHERE id=$1',[job.jobId])).rows[0]
    expect(row).toEqual({checks:1,backed_off:true})
    expect(await delivery(repo=>repo.prepare(job.jobId,evidence(id)))).toBeNull()
    await run(repo=>repo.stopAll({customerId:id,businessDate}))
  })
  it('reserves frequency across concurrent campaigns and never retries an unknown attempt',async()=>{
    const id=await customer();await grant(id,'none');const a=await queue(id),b=await queue(id)
    const prepared=await Promise.allSettled([delivery(repo=>repo.prepare(a.jobId,evidence(id))),delivery(repo=>repo.prepare(b.jobId,evidence(id)))])
    const claimed=prepared.flatMap(result=>result.status==='fulfilled'&&result.value?.status==='dispatching'?[result.value]:[])
    expect(claimed).toHaveLength(1)
    const claim=claimed[0]!
    await delivery(repo=>repo.finish(claim.attemptId,{state:'unknown'}))
    expect(await delivery(repo=>repo.prepare(claim.jobId,evidence(id)))).toBeNull()
    const other=claim.jobId===a.jobId?b:a
    await pool.query('UPDATE mbox.marketing_delivery_jobs SET next_check_at=clock_timestamp() WHERE id=$1',[other.jobId])
    expect(await delivery(repo=>repo.prepare(other.jobId,evidence(id)))).toMatchObject({status:'blocked',reason:'previous_delivery_unknown'})
    await delivery(repo=>repo.finish(claim.attemptId,{state:'sent',providerReceiptRef:'isolated-final-receipt'}))
    expect(await delivery(repo=>repo.finish(claim.attemptId,{state:'sent',providerReceiptRef:'isolated-final-receipt'}))).toEqual({replayed:true})
    await expect(delivery(repo=>repo.finish(claim.attemptId,{state:'sent',providerReceiptRef:'conflicting-receipt'}))).rejects.toThrow('冲突')
    await pool.query('UPDATE mbox.marketing_delivery_jobs SET next_check_at=clock_timestamp() WHERE id=$1',[other.jobId])
    expect(await delivery(repo=>repo.prepare(other.jobId,evidence(id)))).toMatchObject({status:'blocked',reason:'frequency_limit'})
    await run(repo=>repo.stopAll({customerId:id,businessDate}))
  })
  it('rechecks a withdrawal after claim immediately before channel handoff',async()=>{
    const id=await customer();await grant(id,'none');const job=await queue(id),claim=await delivery(repo=>repo.prepare(job.jobId,evidence(id)))
    if(claim?.status!=='dispatching')throw Error('Expected isolated claim')
    await run(repo=>repo.stopAll({customerId:id,businessDate}))
    expect(await delivery(repo=>repo.beforeDispatch(claim.attemptId,evidence(id)))).toBe(false)
    expect((await delivery(repo=>repo.get(job.jobId))).status).toBe('cancelled')
  })
  it('authorizes handoff once and rejects status changes without matching attempt facts',async()=>{
    const id=await customer();await grant(id,'none');const job=await queue(id)
    await expect(pool.query("UPDATE mbox.marketing_delivery_jobs SET status='dispatching' WHERE id=$1",[job.jobId])).rejects.toThrow()
    const claim=await delivery(repo=>repo.prepare(job.jobId,evidence(id)));if(claim?.status!=='dispatching')throw Error('Expected isolated claim')
    expect(await delivery(repo=>repo.beforeDispatch(claim.attemptId,evidence(id)))).toBe(true)
    expect(await delivery(repo=>repo.beforeDispatch(claim.attemptId,evidence(id)))).toBe(false)
    await expect(pool.query('UPDATE mbox.marketing_delivery_attempts SET handoff_at=NULL WHERE id=$1',[claim.attemptId])).rejects.toThrow()
    await delivery(repo=>repo.finish(claim.attemptId,{state:'sent',providerReceiptRef:'isolated-handoff-receipt'}))
  })
  it('default worker never sends and a delivery transport exception records unknown once',async()=>{
    const id=await customer();await grant(id,'none');const job=await queue(id)
    await new MarketingDeliveryWorker(runner).runBatch(scope,'marketing-default')
    expect((await delivery(repo=>repo.get(job.jobId))).status).toBe('blocked')
    await pool.query('UPDATE mbox.marketing_delivery_jobs SET next_check_at=clock_timestamp() WHERE id=$1',[job.jobId])
    let calls=0
    const worker=new MarketingDeliveryWorker(runner,{verify:async input=>evidence(input.customerId),deliver:async()=>{calls++;throw Error('isolated network interruption')}})
    await worker.runBatch(scope,'marketing-isolated');await worker.runBatch(scope,'marketing-isolated')
    expect(calls).toBe(1);expect((await delivery(repo=>repo.get(job.jobId))).status).toBe('unknown')
  })
})
