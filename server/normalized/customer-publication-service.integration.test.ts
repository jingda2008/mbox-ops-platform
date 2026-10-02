import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import Fastify from 'fastify'
import {nativeCustomerPublicationApiPlugin} from './native-customer-publication-api.js'
import { customerExperienceApiPlugin } from './customer-experience-api.js'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { NormalizedCommandExecutor } from './command-executor.js'
import { CustomerExperienceRequestError } from './customer-experience-repository.js'
import { CustomerExperienceService } from './customer-experience-service.js'
import { ScopedPostgresTransactionRunner, type PostgresPool } from './transaction-runner.js'

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip
const ids = {
  tenant: randomUUID(), store: randomUUID(), drafter: randomUUID(), publisher: randomUUID(), employee: randomUUID(),
} as const

integration('customer-publication PostgreSQL integration', () => {
  let pool: Pool
  let service: CustomerExperienceService

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    pool = new Pool({ connectionString: databaseUrl, max: 4 })
    const runner = new ScopedPostgresTransactionRunner(pool as unknown as PostgresPool)
    service = new CustomerExperienceService(
      runner, new NormalizedCommandExecutor(runner),
      { updateProfile: async () => { throw new Error('not used') } },
    )
    const suffix = ids.tenant.replaceAll('-', '').slice(0, 10)
    await pool.query(`INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'Customer Publication Tenant')`, [
      ids.tenant, `pub-${suffix}`,
    ])
    await pool.query(`INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1,$2,$3,'Customer Publication Store')`, [
      ids.store, ids.tenant, `pub-${suffix}`,
    ])
    await pool.query(`
      INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name,status) VALUES
        ($1,$4,$5,$6,'草拟人','active'),($2,$4,$5,$7,'独立发布人','active'),($3,$4,$5,$8,'服务员工','active')
    `, [ids.drafter, ids.publisher, ids.employee, ids.tenant, ids.store,
      `PD-${suffix}`, `PP-${suffix}`, `PE-${suffix}`])
  })

  afterAll(async () => pool?.end())

  it('native publication separates authors and publishers, freezes source versions and keeps durable receipts',async()=>{
    const role=randomUUID();const codes=['customer.public-profile.manage','customer.public-profile.publish','privacy.policy.view','privacy.policy.manage','privacy.policy.publish','customer.experience.feature.manage'];
    await pool.query("INSERT INTO mbox.roles(id,tenant_id,store_id,code,name) VALUES($1,$2,$3,'NATIVE_PUBLICATION','内容配置')",[role,ids.tenant,ids.store]);
    await pool.query('INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id) VALUES($1,$2,$3,$5),($1,$2,$4,$5)',[ids.tenant,ids.store,ids.drafter,ids.publisher,role]);
    await pool.query("INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name,category,status) SELECT $1,$2,p,p,'publication','active' FROM unnest($3::text[]) p ON CONFLICT (tenant_id,store_id,code) DO UPDATE SET status='active'",[ids.tenant,ids.store,codes]);
    await pool.query('INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) SELECT $1,$2,$3,id FROM mbox.staff_permission_definitions WHERE tenant_id=$1 AND store_id=$2 AND code=ANY($4::text[])',[ids.tenant,ids.store,role,codes]);
    const runtime=new Pool({connectionString:process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL,max:4});const tx=new ScopedPostgresTransactionRunner(runtime as unknown as PostgresPool);const app=Fastify();let employee:string=ids.drafter;
    await app.register(nativeCustomerPublicationApiPlugin,{prefix:'/api',transactions:tx,commands:new NormalizedCommandExecutor(tx),resolveContext:()=>staff(employee)});
    const read=async()=>{const r=await app.inject({url:'/api/staff/native-publication'});expect(r.statusCode,r.body).toBe(200);return r.json().data};
    const post=(action:string,body:object,key=`native-business-${randomUUID()}`)=>app.inject({method:'POST',url:'/api/staff/native-publication/'+action,payload:body,headers:{'idempotency-key':key}});
    try{
      let b=await read();const content='此正文仅用于隔离测试库校验员工配置权限、原内容版本、独立发布和内容摘要的一致性，不是实际法律文本。'.repeat(4);const policy='NATIVE-POLICY';const draft={expectedVersion:b.versions.privacy,policyVersion:policy,content,operatorName:'测试运营主体',contact:'test@example.test',dataRetentionPolicyVersion:'test-retention',thirdPartyRegisterVersion:'test-register',reason:'创建隔离测试草稿'};const key=`native-business-${randomUUID()}`;
      const created=await post('privacy-draft',draft,key);expect(created.statusCode,created.body).toBe(200);expect(created.json().data.result.contentSha256).toBe(createHash('sha256').update(content).digest('hex'));
      expect((await post('privacy-draft',{...draft,content:content+'旧版本修改'})).statusCode).toBe(409);
      b=await read();const publish={expectedVersion:b.versions.privacy,policyVersion:policy,approvedBy:'测试批准人',approvalReference:'NATIVE-TEST-APPROVAL',effectiveAt:new Date().toISOString(),reason:'独立发布隔离测试'};
      const self=await post('privacy-publish',publish);expect(self.statusCode,self.body).toBe(409);expect(self.json().error.message).toContain('不能自行发布');
      employee=ids.publisher;const future=await post('privacy-publish',{...publish,effectiveAt:new Date(Date.now()+3600000).toISOString()});expect(future.statusCode,future.body).toBe(409);expect((await read()).policies.find((p:any)=>p.policyVersion===policy).status).toBe('draft');
      const published=await post('privacy-publish',publish);expect(published.statusCode,published.body).toBe(200);
      employee=ids.drafter;expect((await post('privacy-draft',draft,key)).json().meta.replayed).toBe(true);
      b=await read();const profile=await post('profile-draft',{expectedVersion:b.versions.profile,employeeId:ids.employee,publicDisplayName:'原生服务名',reason:'测试原生公开服务名'});expect(profile.statusCode,profile.body).toBe(200);const profileId=profile.json().data.result.id;
      employee=ids.publisher;b=await read();const p=await post('profile-publish',{expectedVersion:b.versions.profile,profileId,approvalReference:'PROFILE-TEST-APPROVAL',effectiveAt:new Date().toISOString(),reason:'测试独立发布'});expect(p.statusCode,p.body).toBe(200);
      b=await read();const contact=await post('contact',{expectedVersion:b.versions.contact,reason:'测试配置门店联系',rolloutState:'enabled',configuration:{phone:'021-12345678',phoneLabel:'门店电话',wecomName:'客服',wecomQrImageUrl:null}});expect(contact.statusCode,contact.body).toBe(200);expect((await read()).contact.contact.phone).toBe('021-12345678');
      const originalWeb=await service.setFeature(staff(ids.publisher),{featureCode:'customer.support.contact',rolloutState:'enabled',configuration:{phone:'021-87654321',phoneLabel:'新的门店电话',wecomName:'客服',wecomQrImageUrl:null},reason:'原网页共用服务第二次修改',idempotencyKey:`web-contact-${randomUUID()}`});expect(originalWeb.value.rolloutState).toBe('enabled');expect((await read()).contact.contact.phone).toBe('021-87654321');
      expect((await pool.query("SELECT aggregate_id FROM mbox.outbox_messages WHERE tenant_id=$1 AND store_id=$2 AND message_type='customer.experience.feature.set.v1'",[ids.tenant,ids.store])).rows).toHaveLength(2);
      b=await read();expect((await post('profile-withdraw',{expectedVersion:b.versions.profile,profileId,reason:'清理测试公开服务名'})).statusCode).toBe(200);
      b=await read();expect((await post('privacy-withdraw',{expectedVersion:b.versions.privacy,policyVersion:policy,reason:'清理测试政策发布'})).statusCode).toBe(200);
      employee=ids.drafter;await pool.query("UPDATE mbox.employees SET status='suspended' WHERE id=$1",[ids.drafter]);expect((await post('privacy-draft',draft,key)).statusCode).toBe(403);
    }finally{await pool.query("UPDATE mbox.employees SET status='active' WHERE id=$1",[ids.drafter]);await pool.query("DELETE FROM mbox.employee_customer_public_profiles WHERE tenant_id=$1 AND store_id=$2 AND public_display_name='原生服务名'",[ids.tenant,ids.store]);await pool.query("DELETE FROM mbox.privacy_policy_releases WHERE tenant_id=$1 AND store_id=$2 AND policy_version='NATIVE-POLICY'",[ids.tenant,ids.store]);await app.close();await runtime.end()}
  });

  it('keeps a published customer name visible until an independently published replacement takes over', async () => {
    const draft = await service.draftCustomerPublicProfile(staff(ids.drafter), {
      employeeId: ids.employee, publicDisplayName: '小林', reason: '员工书面确认公开服务名',
      idempotencyKey: `profile-draft-${randomUUID()}`,
    })
    await expect(service.publishCustomerPublicProfile(staff(ids.drafter), {
      profileId: draft.value.id, approvalReference: 'HR-2026-0824-001', effectiveAt: new Date().toISOString(),
      reason: '本人不能发布', idempotencyKey: `profile-self-publish-${randomUUID()}`,
    })).rejects.toMatchObject<CustomerExperienceRequestError>({ code: 'CUSTOMER_PUBLIC_PROFILE_PUBLISHER_NOT_INDEPENDENT' })
    await service.publishCustomerPublicProfile(staff(ids.publisher), {
      profileId: draft.value.id, approvalReference: 'HR-2026-0824-001', effectiveAt: new Date().toISOString(),
      reason: '人事复核完成', idempotencyKey: `profile-publish-${randomUUID()}`,
    })
    const replacement = await service.draftCustomerPublicProfile(staff(ids.drafter), {
      employeeId: ids.employee, publicDisplayName: '林经理', reason: '员工确认更新顾客公开服务名',
      idempotencyKey: `profile-replacement-draft-${randomUUID()}`,
    })
    expect((await pool.query(`
      SELECT public_display_name,status FROM mbox.employee_customer_public_profiles
      WHERE tenant_id=$1 AND store_id=$2 AND employee_id=$3 ORDER BY created_at
    `, [ids.tenant, ids.store, ids.employee])).rows).toEqual([
      { public_display_name: '小林', status: 'published' },
      { public_display_name: '林经理', status: 'draft' },
    ])
    await service.publishCustomerPublicProfile(staff(ids.publisher), {
      profileId: replacement.value.id, approvalReference: 'HR-2026-0824-002', effectiveAt: new Date().toISOString(),
      reason: '独立复核替代服务名', idempotencyKey: `profile-replacement-publish-${randomUUID()}`,
    })
    expect((await pool.query(`
      SELECT public_display_name,status FROM mbox.employee_customer_public_profiles
      WHERE tenant_id=$1 AND store_id=$2 AND employee_id=$3 ORDER BY created_at
    `, [ids.tenant, ids.store, ids.employee])).rows).toEqual([
      { public_display_name: '小林', status: 'withdrawn' },
      { public_display_name: '林经理', status: 'published' },
    ])
  })

  it('requires independent legal publication and preserves the released policy hash', async () => {
    const content = 'M-BOX 顾客隐私政策正式正文，包含已批准的个人信息处理、保留和第三方服务说明。'.repeat(4)
    const policyVersion = `PIPL.${ids.tenant.slice(0, 8)}`
    const draft = await service.draftPrivacyPolicy(staff(ids.drafter), {
      policyVersion, content, contentSha256: createHash('sha256').update(content).digest('hex'),
      operatorName: 'M-BOX 运营主体', contact: 'privacy@example.test',
      dataRetentionPolicyVersion: 'retention-v1', thirdPartyRegisterVersion: 'third-party-v1',
      reason: '录入已获批准的隐私政策正文', idempotencyKey: `privacy-draft-${randomUUID()}`,
    })
    const app = Fastify()
    const scope = {tenantId:ids.tenant,storeId:ids.store}
    await app.register(customerExperienceApiPlugin,{
      publishedContentScope:scope,transactions:new ScopedPostgresTransactionRunner(pool as unknown as PostgresPool),service,
      resolvePublicContext:()=>{throw new Error('Published copy must not authenticate a customer')},
      resolveGuestContext:()=>{throw new Error('not used')},resolveStaffContext:()=>{throw new Error('not used')},protectContact:()=>{throw new Error('not used')},
    })
    try {
    const unpublished = await app.inject({method:'GET',url:'/public/mini/privacy-policy'})
    expect(unpublished.statusCode).toBe(200)
    expect(unpublished.json().data.version).toBe('MBOX-PRIVACY-20260914-V2')
    expect(unpublished.json().meta).toEqual({ published: false, source: 'approved-review-copy' })
    expect(unpublished.body).not.toContain(content.slice(0, 24))
    await expect(service.publishPrivacyPolicy(staff(ids.drafter), {
      policyVersion, approvedBy: '法务复核人', approvalReference: 'LEGAL-2026-0824-001',
      effectiveAt: new Date().toISOString(), reason: '本人不能发布',
      idempotencyKey: `privacy-self-publish-${randomUUID()}`,
    })).rejects.toMatchObject<CustomerExperienceRequestError>({ code: 'PRIVACY_POLICY_PUBLISHER_NOT_INDEPENDENT' })
    await service.publishPrivacyPolicy(staff(ids.publisher), {
      policyVersion, approvedBy: '法务复核人', approvalReference: 'LEGAL-2026-0824-001',
      effectiveAt: new Date().toISOString(), reason: '法务与运营独立复核完成',
      idempotencyKey: `privacy-publish-${randomUUID()}`,
    })
    expect((await pool.query(`
      SELECT policy_version,status,content_sha256,approval_reference
      FROM mbox.privacy_policy_releases WHERE id=$1
    `, [draft.value.id])).rows[0]).toEqual({
      policy_version: policyVersion, status: 'published',
      content_sha256: createHash('sha256').update(content).digest('hex'),
      approval_reference: 'LEGAL-2026-0824-001',
    })
    const publicResponse=await app.inject({method:'GET',url:'/public/mini/privacy-policy?storeId=forged',headers:{'x-mbox-store-id':'forged'}})
    expect(publicResponse.statusCode, publicResponse.body).toBe(200)
    expect(publicResponse.json()).toMatchObject({data:{version:policyVersion,content,contentSha256:createHash('sha256').update(content).digest('hex')},meta:{published:true}})
    expect(publicResponse.body).not.toContain('LEGAL-2026-0824-001')
    await service.withdrawPrivacyPolicy(staff(ids.publisher),{policyVersion,reason:'隔离测试撤下政策',idempotencyKey:randomUUID()})
    expect((await app.inject({method:'GET',url:'/public/mini/privacy-policy'})).json()).toEqual({data:null,meta:{published:false}})
    } finally {await app.close()}
  })
})

function staff(employeeId: string) {
  return {
    scope: { tenantId: ids.tenant, storeId: ids.store }, employeeId, businessDate: '2026-08-24',
  }
}
