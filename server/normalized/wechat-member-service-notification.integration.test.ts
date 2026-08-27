import { randomUUID } from 'node:crypto'
import { afterAll,beforeAll,describe,expect,it,vi } from 'vitest'
import { Pool } from 'pg'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { ScopedPostgresTransactionRunner,type PostgresPool } from './transaction-runner.js'
import { WechatMemberServiceNotificationRepository } from './wechat-member-service-notification-repository.js'
import { WechatMemberServiceNotificationWorker } from './wechat-member-service-notification-worker.js'

const databaseUrl=process.env.TEST_NORMALIZED_DATABASE_URL
const integration=databaseUrl?describe:describe.skip
const ids=Object.freeze({tenant:randomUUID(),store:randomUUID(),customer:randomUUID(),membership:randomUUID(),policy:randomUUID()})
const scope={tenantId:ids.tenant,storeId:ids.store}

integration('typed WeChat member-service notification delivery',()=>{
  let pool:Pool;let transactions:ScopedPostgresTransactionRunner
  beforeAll(async()=>{await runNormalizedMigrations(databaseUrl!);pool=new Pool({connectionString:databaseUrl,max:4});transactions=new ScopedPostgresTransactionRunner(pool as unknown as PostgresPool);await seed(pool)})
  afterAll(async()=>pool?.end())

  it('records the exact customer choice, queues only a newly issued benefit, and consumes it once',async()=>{
    const available=await transactions.run(scope,(transaction)=>(new WechatMemberServiceNotificationRepository(transaction).authorizationOptions(ids.customer,true)),{readOnly:true})
    expect(available).toEqual([expect.objectContaining({policyId:ids.policy,notificationType:'member_benefit_issued',usesRemaining:0})])
    await transactions.run(scope,(transaction)=>(new WechatMemberServiceNotificationRepository(transaction).recordAuthorization({
      customerId:ids.customer,notificationType:'member_benefit_issued',policyId:ids.policy,policyVersion:1,
      templateId:'wechat-template-benefit-001',expectedVersion:0,platformResult:'accept',platformEventReference:'member-service-benefit-grant-001',
    })))
    const benefitId=randomUUID()
    await pool.query(`INSERT INTO mbox.benefits(
      id,tenant_id,store_id,customer_id,benefit_code,benefit_type,status,benefit_snapshot,valid_from
    ) VALUES($1,$2,$3,$4,'WELCOME-DRINK','gift_product','issued',jsonb_build_object('title','欢迎饮品券'),clock_timestamp())`,[benefitId,ids.tenant,ids.store,ids.customer])
    const queued=await pool.query<{title:string;detail:string;status:string}>(`
      SELECT title,detail,status FROM mbox.wechat_member_service_notification_jobs
      WHERE tenant_id=$1 AND store_id=$2 AND source_id=$3::uuid
    `,[ids.tenant,ids.store,benefitId])
    expect(queued.rows).toEqual([{title:'会员优惠券已到账',detail:'欢迎饮品券',status:'pending'}])
    const sendTemplate=vi.fn(async()=>({outcome:'accepted' as const,providerReference:'member-service-benefit-provider-001'}))
    const worker=new WechatMemberServiceNotificationWorker(transactions,{resolveMiniProgramNotificationRecipient:async()=>({identityExternalId:'member-service-identity',openId:'openid-member-service'})},{preflight:async()=>undefined,sendTemplate})
    const result=await worker.runBatch(scope,'member-service-pg-01')
    expect(result).toMatchObject({claimed:1,accepted:[expect.any(String)]})
    expect(sendTemplate).toHaveBeenCalledWith(expect.objectContaining({data:expect.objectContaining({thing1:'会员优惠券已到账',thing2:'欢迎饮品券'})}))
    const delivered=await pool.query<{status:string;outcome:string}>(`
      SELECT job.status,receipt.outcome FROM mbox.wechat_member_service_notification_jobs job
      JOIN mbox.wechat_member_service_notification_receipts receipt
        ON receipt.tenant_id=job.tenant_id AND receipt.store_id=job.store_id AND receipt.notification_job_id=job.id
      WHERE job.tenant_id=$1 AND job.store_id=$2 AND job.source_id=$3::uuid
    `,[ids.tenant,ids.store,benefitId])
    expect(delivered.rows).toEqual([{status:'sent',outcome:'accepted'}])
  })
})

async function seed(pool:Pool):Promise<void>{
  const principal='member-service-principal'
  await pool.query(`INSERT INTO mbox.tenants(id,code,name) VALUES($1,'member-service-notice','Member service notice tenant')`,[ids.tenant])
  await pool.query(`INSERT INTO mbox.stores(id,tenant_id,code,name,timezone) VALUES($1,$2,'member-service-notice','Member service notice store','Asia/Shanghai')`,[ids.store,ids.tenant])
  await pool.query(`INSERT INTO mbox.customers(id,tenant_id,store_id,public_id) VALUES($1,$2,$3,'member-service-notice-customer')`,[ids.customer,ids.tenant,ids.store])
  await pool.query(`INSERT INTO mbox.customer_memberships(id,tenant_id,store_id,customer_id,member_no) VALUES($1,$2,$3,$4,'MBX-MEMBER-SERVICE-001')`,[ids.membership,ids.tenant,ids.store,ids.customer])
  await pool.query(`INSERT INTO mbox.customer_identities(tenant_id,store_id,customer_id,identity_kind,identity_hash)
    VALUES($1,$2,$3,'wechat',encode(digest('wechat:'||$4,'sha256'),'hex'))`,[ids.tenant,ids.store,ids.customer,principal])
  await pool.query(`INSERT INTO mbox.wechat_identities(
    tenant_id,store_id,external_identity_id,principal_type,principal_id,channel,app_id,
    openid_sha256,openid_ciphertext,openid_key_version,member_id,consent_version,consented_at,last_authenticated_at
  ) VALUES($1,$2,'member-service-identity','member',$3,'mini_program','wxMemberServiceNotice01',
    encode(digest('openid-member-service','sha256'),'hex'),decode(repeat('00',29),'hex'),1,$4,'login-v1',clock_timestamp(),clock_timestamp())`,[ids.tenant,ids.store,principal,ids.membership])
  await pool.query(`INSERT INTO mbox.wechat_member_service_notification_policies(
    id,tenant_id,store_id,notification_type,authorization_purpose,authorization_context,policy_version,status,
    template_id,page_path,title_data_key,detail_data_key,occurred_at_data_key,reason,effective_from,published_at
  ) VALUES($1,$2,$3,'member_benefit_issued','member_service_update','member_benefit',1,'published',
    'wechat-template-benefit-001','pages/profile-coupons/index','thing1','thing2','time3','优惠券到账正式服务通知',clock_timestamp()-interval '1 hour',clock_timestamp())`,[ids.policy,ids.tenant,ids.store])
}
