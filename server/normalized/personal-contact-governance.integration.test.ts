import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { afterAll,beforeAll,describe,expect,it } from 'vitest'
import { Pool,type PoolClient } from 'pg'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import {
  MembershipRecoveryService,createMembershipRecoveryPhoneProtector,
} from './membership-recovery-service.js'
import { PersonalContactGovernanceService } from './personal-contact-governance-service.js'
import { PersonalContactDispositionWorker } from './personal-contact-disposition-worker.js'
import { createActivityContactProtectionKeyring } from './personal-contact-protection.js'
import { ScopedPostgresTransactionRunner,type PostgresPool } from './transaction-runner.js'

const databaseUrl=process.env.TEST_NORMALIZED_DATABASE_URL
const integration=databaseUrl?describe:describe.skip
const id={
  tenant:randomUUID(),store:randomUUID(),verifier:randomUUID(),approver:randomUUID(),
  ops:randomUUID(),owner:randomUUID(),
  current:randomUUID(),source:randomUUID(),legacy:randomUUID(),sourceMembership:randomUUID(),
  activity:randomUUID(),raceCustomer:randomUUID(),retentionCustomer:randomUUID(),
  raceRegistration:randomUUID(),retentionRegistration:randomUUID(),
} as const
const scope={tenantId:id.tenant,storeId:id.store}
const contactProtection=createActivityContactProtectionKeyring(null,'personal-contact-governance-test-secret')

integration('095 personal-contact governance PostgreSQL boundaries',()=>{
  let pool:Pool
  let service:MembershipRecoveryService
  let governance:PersonalContactGovernanceService
  let disposition:PersonalContactDispositionWorker
  const now=new Date()
  const phone='+8613812345678'

  beforeAll(async()=>{
    await runNormalizedMigrations(databaseUrl!)
    pool=new Pool({connectionString:databaseUrl,max:8})
    const transactions=new ScopedPostgresTransactionRunner(pool as unknown as PostgresPool)
    service=new MembershipRecoveryService(
      transactions,
      createMembershipRecoveryPhoneProtector('personal-contact-governance-test-secret'),
      ()=>now,
    )
    governance=new PersonalContactGovernanceService(transactions,contactProtection)
    disposition=new PersonalContactDispositionWorker(transactions)
    await seed(pool)
  })
  afterAll(async()=>pool?.end())

  it('keeps the exact 079 upsert usable while preventing direct evidence mutation',async()=>{
    const first=await legacyUpsert({
      hash:'1'.repeat(64),providerHash:'2'.repeat(64),masked:'138****8000',
      encrypted:envelope(1),verifiedAt:new Date(now.getTime()-3_000).toISOString(),
    })
    const replay=await legacyUpsert({
      hash:'1'.repeat(64),providerHash:'3'.repeat(64),masked:'138****9999',
      encrypted:envelope(2),verifiedAt:new Date(now.getTime()-2_000).toISOString(),
    })
    expect(replay.id).toBe(first.id)
    const unchanged=await pool.query(`SELECT provider_reference_sha256,masked_value,
      (SELECT count(*)::integer FROM mbox.customer_verified_contact_actions action
       WHERE action.contact_id=contact.id AND action.action='verified') AS verified_actions
      FROM mbox.customer_verified_contacts contact WHERE contact.id=$1`,[first.id])
    expect(unchanged.rows[0]).toMatchObject({
      provider_reference_sha256:'2'.repeat(64),masked_value:'138****8000',verified_actions:1,
    })
    const replacement=await legacyUpsert({
      hash:'4'.repeat(64),providerHash:'5'.repeat(64),masked:'139****8000',
      encrypted:envelope(3),verifiedAt:new Date(now.getTime()-1_000).toISOString(),
    })
    expect(replacement.id).not.toBe(first.id)
    const states=await pool.query(`SELECT id,processing_status,supersedes_contact_id
      FROM mbox.customer_verified_contacts WHERE tenant_id=$1 AND store_id=$2 AND customer_id=$3
      ORDER BY verified_at`,[id.tenant,id.store,id.legacy])
    expect(states.rows).toEqual([
      expect.objectContaining({id:first.id,processing_status:'revoked'}),
      expect.objectContaining({id:replacement.id,processing_status:'active',supersedes_contact_id:first.id}),
    ])
    await expect(asRuntime(async(client)=>client.query(`UPDATE mbox.customer_verified_contacts
      SET masked_value='137****0000' WHERE id=$1`,[replacement.id]))).rejects.toThrow(/immutable|cannot be overwritten|lifecycle is invalid/)
    await asRuntime(async(client)=>{
      await client.query(`SELECT set_config('app.verified_contact_legacy_replay',$1,true)`,[replacement.id])
      await client.query(`UPDATE mbox.customer_verified_contacts SET masked_value='137****0000' WHERE id=$1`,[replacement.id])
    })
    const afterSpoof=await pool.query(`SELECT masked_value FROM mbox.customer_verified_contacts WHERE id=$1`,[replacement.id])
    expect(afterSpoof.rows[0]?.masked_value).toBe('139****8000')
  })

  it('rejects direct and forged verified actions under the runtime role',async()=>{
    const contact=await pool.query(`SELECT id,verified_by_employee_id,verified_at::text
      FROM mbox.customer_verified_contacts WHERE customer_id=$1 AND processing_status='active'`,[id.legacy])
    const row=contact.rows[0]
    await expect(asRuntime(client=>client.query(`INSERT INTO mbox.customer_verified_contact_actions(
      tenant_id,store_id,contact_id,action,actor_type,actor_employee_id,reason_code,
      authorization_source,authorization_reference_sha256,authorized_at,idempotency_key,request_sha256
    ) VALUES($1,$2,$3,'verified','employee',$4,'forged_direct_action','staff_controlled',
      $5,clock_timestamp(),'forged-direct-action-0001',$6)`,[
      id.tenant,id.store,row.id,id.verifier,'6'.repeat(64),'7'.repeat(64),
    ]))).rejects.toThrow(/permission denied/)
    await expect(asRuntime(client=>client.query(`SELECT mbox.append_customer_verified_contact_action(
      $1::uuid,'verified',NULL::uuid,$2::uuid,'forged_controlled_action',NULL,
      'staff_controlled',$3::char(64),$4::timestamptz,'forged-controlled-0001',$5::char(64)
    )`,[row.id,id.verifier,'8'.repeat(64),row.verified_at,'9'.repeat(64)])))
      .rejects.toThrow(/immutable verification evidence/)
  })

  it('reconciles the selected same-phone evidence before merge and serializes approval',async()=>{
    await service.recordStaffVerifiedContact(staff(id.verifier),{
      memberNo:'MBX095SOURCE',e164Phone:phone,reason:'现场核对历史会员手机号与原始登记凭证',
      idempotencyKey:'contact-governance-source-verify',
    })
    const started=await service.start(customer(id.current),{
      idempotencyKey:'contact-governance-recovery-start',
    })
    const verified=await service.verify(customer(id.current),{
      challengePublicId:started.challengePublicId,
      verifiedPhone:{e164Phone:phone,providerReference:'wechat-contact-governance-code',verifiedAt:now.toISOString()},
      idempotencyKey:'contact-governance-recovery-verify',
    })
    expect(verified.status).toBe('pending_review')
    const row=(await service.reviewQueue(staff(id.approver))).find((item)=>item.status==='pending_review')
    const casePublicId=String(row?.casePublicId)
    const approvals=await Promise.allSettled([
      service.approve(staff(id.approver),{
        casePublicId,reason:'独立复核本次微信验证与历史候选强绑定一致',idempotencyKey:'contact-governance-approve-a',
      }),
      service.approve(staff(id.approver),{
        casePublicId,reason:'并发的不同审批请求不得重复执行',idempotencyKey:'contact-governance-approve-b',
      }),
    ])
    expect(approvals.filter((result)=>result.status==='fulfilled')).toHaveLength(1)
    expect(approvals.filter((result)=>result.status==='rejected')).toHaveLength(1)
    const family=await pool.query(`WITH RECURSIVE members AS (
      SELECT id FROM mbox.customers WHERE id=$1 UNION ALL
      SELECT child.id FROM mbox.customers child JOIN members parent ON child.merged_into_customer_id=parent.id
      WHERE child.tenant_id=$2 AND child.store_id=$3
    ) SELECT contact.id,contact.customer_id,contact.processing_status,contact.supersedes_contact_id,
      (SELECT count(*)::integer FROM mbox.customer_verified_contact_actions action
       WHERE action.contact_id=contact.id AND action.action='superseded') AS superseded_actions
      FROM mbox.customer_verified_contacts contact WHERE contact.customer_id IN (SELECT id FROM members)
      ORDER BY contact.processing_status`,[id.current,id.tenant,id.store])
    expect(family.rows.filter((contact)=>contact.processing_status==='active')).toHaveLength(1)
    const retired=family.rows.find((contact)=>contact.processing_status==='revoked')
    const active=family.rows.find((contact)=>contact.processing_status==='active')
    expect(retired?.superseded_actions).toBe(1)
    expect(active?.supersedes_contact_id).toBe(retired?.id)
  })

  it('rechecks the authoritative purpose after decrypt and persists a denied race without returning plaintext',async()=>{
    const contact=await activityContact(id.raceRegistration)
    await pool.query(`CREATE FUNCTION public.pcg_cancel_registration_after_claim()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.contact_version_id='${contact.id}'::uuid THEN
          UPDATE mbox.community_activity_registrations
          SET status='cancelled',cancelled_at=clock_timestamp(),updated_at=clock_timestamp()
          WHERE id='${id.raceRegistration}'::uuid;
        END IF;
        RETURN NEW;
      END $$`)
    await pool.query(`CREATE TRIGGER pcg_cancel_registration_after_claim
      AFTER INSERT ON mbox.activity_contact_access_events
      FOR EACH ROW EXECUTE FUNCTION public.pcg_cancel_registration_after_claim()`)
    try {
      await expect(governance.revealActivityContact(staff(id.verifier),{
        contactVersionPublicId:contact.public_id,purpose:'attendance_coordination',
        idempotencyKey:'contact-governance-race-reveal',
      })).rejects.toMatchObject({code:'ACTIVITY_CONTACT_REVEAL_DENIED'})
    } finally {
      await pool.query('DROP TRIGGER IF EXISTS pcg_cancel_registration_after_claim ON mbox.activity_contact_access_events')
      await pool.query('DROP FUNCTION IF EXISTS public.pcg_cancel_registration_after_claim()')
    }
    const evidence=await pool.query(`SELECT outcome,denial_code,display_expires_at
      FROM mbox.activity_contact_access_events WHERE contact_version_id=$1`,[contact.id])
    expect(evidence.rows).toEqual([
      expect.objectContaining({outcome:'denied',denial_code:'PURPOSE_ENDED',display_expires_at:null}),
    ])
    const protectedRow=await pool.query(`SELECT status,encrypted_contact IS NOT NULL AS encrypted
      FROM mbox.community_activity_registration_contact_versions WHERE id=$1`,[contact.id])
    expect(protectedRow.rows[0]).toEqual({status:'inactive',encrypted:true})
  })

  it('does not reuse revealed plaintext after cancellation and disposes only after an authorized hold release',async()=>{
    const contact=await activityContact(id.retentionRegistration)
    const first=await governance.revealActivityContact(staff(id.verifier),{
      contactVersionPublicId:contact.public_id,purpose:'attendance_coordination',
      idempotencyKey:'contact-governance-replay-reveal',
    })
    expect(first.contactValue).toBe('13812348000')
    await pool.query(`UPDATE mbox.community_activity_registrations
      SET status='cancelled',cancelled_at=clock_timestamp(),updated_at=clock_timestamp()
      WHERE id=$1`,[id.retentionRegistration])
    await expect(governance.revealActivityContact(staff(id.verifier),{
      contactVersionPublicId:contact.public_id,purpose:'attendance_coordination',
      idempotencyKey:'contact-governance-replay-reveal',
    })).rejects.toMatchObject({code:'ACTIVITY_CONTACT_REVEAL_DENIED'})

    const draft=await governance.draftPolicy(staff(id.approver),{
      resourceKind:'activity_registration_contact',retentionDaysAfterPurposeEnd:0,
      legalBasisReference:'MBOX-PRIVACY-RETENTION-TEST',reason:'测试已结束报名联系方式的最短保留边界',
    }) as { publicId:string }
    await governance.approvePolicy(staff(id.ops),{
      publicId:draft.publicId,reason:'独立复核活动联系方式保留依据与期限',
    })
    await governance.publishPolicy(staff(id.owner),{
      publicId:draft.publicId,effectiveFrom:new Date().toISOString(),reason:'发布测试保留策略并验证受控清除',
    })
    const hold=await governance.createLegalHold(staff(id.owner),{
      resourceKind:'activity_registration_contact',resourcePublicId:contact.public_id,
      legalBasisReference:'MBOX-LEGAL-HOLD-TEST',reason:'验证法定保留会阻止旧版本处置',holdUntil:null,
    })
    const heldBatch=await disposition.runBatch(scope,'pcg-held:personal-contact-disposition')
    // The earlier race-case contact is independently eligible; the held target
    // itself must remain encrypted even while the worker continues past it.
    expect(heldBatch).toMatchObject({disposed:1,failed:0})
    const stillProtected=await pool.query(`SELECT status,encrypted_contact IS NOT NULL AS encrypted
      FROM mbox.community_activity_registration_contact_versions WHERE id=$1`,[contact.id])
    expect(stillProtected.rows[0]).toEqual({status:'inactive',encrypted:true})

    await expect(asRuntime(client=>client.query(`INSERT INTO mbox.personal_contact_legal_holds(
      tenant_id,store_id,public_id,resource_kind,activity_contact_version_id,status,
      legal_basis_reference,reason,created_by_employee_id
    ) VALUES($1,$2,'PCH${'A'.repeat(32)}','activity_registration_contact',$3,'active',
      'forged-basis','forged hold',$4)`,[id.tenant,id.store,contact.id,id.owner]))).rejects.toThrow(/permission denied/)
    await expect(asRuntime(client=>client.query(`INSERT INTO mbox.personal_contact_retention_policy_versions(
      tenant_id,store_id,public_id,resource_kind,version,status,retention_days_after_purpose_end,
      legal_basis_reference,drafted_by_employee_id,draft_reason
    ) VALUES($1,$2,'PCR${'B'.repeat(32)}','activity_registration_contact',999,'draft',0,
      'forged-basis',$3,'forged draft')`,[id.tenant,id.store,id.approver]))).rejects.toThrow(/permission denied/)

    await governance.releaseLegalHold(staff(id.owner),{
      publicId:hold.publicId,reason:'测试保留目的已完成，释放旧版本',
    })
    const disposedBatch=await disposition.runBatch(scope,'pcg-released:personal-contact-disposition')
    expect(disposedBatch).toMatchObject({disposed:1,failed:0})
    const disposed=await pool.query(`SELECT status,contact_hash,encrypted_contact,encryption_key_id,masked_contact
      FROM mbox.community_activity_registration_contact_versions WHERE id=$1`,[contact.id])
    expect(disposed.rows[0]).toEqual({
      status:'disposed',contact_hash:null,encrypted_contact:null,encryption_key_id:null,masked_contact:null,
    })
    const disposalEvidence=await pool.query(`SELECT disposition_method,worker_id
      FROM mbox.personal_contact_disposition_events WHERE activity_contact_version_id=$1`,[contact.id])
    expect(disposalEvidence.rows).toEqual([
      {disposition_method:'cryptographic_erasure',worker_id:'pcg-released:personal-contact-disposition'},
    ])
    const governanceEvidence=await governance.listEvidence(staff(id.owner)) as {
      eligibleResources:Array<Record<string,unknown>>
      holds:Array<Record<string,unknown>>;dispositions:Array<Record<string,unknown>>
    }
    expect(governanceEvidence.eligibleResources.length).toBeGreaterThan(0)
    expect(governanceEvidence.eligibleResources[0]).toEqual(expect.objectContaining({
      publicId:expect.any(String),resourceKind:expect.any(String),maskedContact:expect.any(String),
      businessLabel:expect.any(String),status:expect.any(String),
    }))
    expect(governanceEvidence.holds).toEqual(expect.arrayContaining([
      expect.objectContaining({publicId:hold.publicId,status:'released',maskedContact:'已清除'}),
    ]))
    expect(governanceEvidence.dispositions).toEqual(expect.arrayContaining([
      expect.objectContaining({resourcePublicId:contact.public_id,maskedContact:'已清除',policyVersion:1}),
    ]))
    expect(JSON.stringify(governanceEvidence)).not.toMatch(/contactHash|encrypted|keyId|employeeId|workerId|customerId|memberNo/)
    const isolated=await asRuntime(async(client)=>{
      await client.query(`SELECT set_config('app.store_id',$1,true)`,[randomUUID()])
      return client.query(`SELECT public_id FROM mbox.community_activity_registration_contact_versions WHERE id=$1`,[contact.id])
    })
    expect(isolated.rows).toHaveLength(0)
  })

  async function activityContact(registrationId:string){
    const result=await pool.query<{id:string;public_id:string}>(`SELECT id,public_id
      FROM mbox.community_activity_registration_contact_versions
      WHERE tenant_id=$1 AND store_id=$2 AND registration_id=$3 AND status='active'`,[
      id.tenant,id.store,registrationId,
    ])
    return result.rows[0]!
  }

  async function legacyUpsert(input:{hash:string;providerHash:string;masked:string;encrypted:Buffer;verifiedAt:string}){
    return asRuntime(async(client)=>{
      const result=await client.query<{id:string}>(`INSERT INTO mbox.customer_verified_contacts(
        tenant_id,store_id,customer_id,contact_type,contact_hash,encrypted_value,
        encryption_key_version,masked_value,verification_source,provider_reference_sha256,
        verified_by_customer_id,verified_by_employee_id,verified_at
      ) VALUES($1,$2,$3,'phone',$4,$5::bytea,1,$6,'staff_controlled',$7,NULL::uuid,$8::uuid,$9::timestamptz)
      ON CONFLICT (tenant_id,store_id,customer_id,contact_type,contact_hash) DO UPDATE SET
        encrypted_value=EXCLUDED.encrypted_value,
        encryption_key_version=EXCLUDED.encryption_key_version,
        masked_value=EXCLUDED.masked_value,
        verification_source=EXCLUDED.verification_source,
        provider_reference_sha256=EXCLUDED.provider_reference_sha256,
        verified_by_customer_id=EXCLUDED.verified_by_customer_id,
        verified_by_employee_id=EXCLUDED.verified_by_employee_id,
        verified_at=EXCLUDED.verified_at,
        revoked_at=NULL
      RETURNING id`,[id.tenant,id.store,id.legacy,input.hash,input.encrypted,input.masked,
        input.providerHash,id.verifier,input.verifiedAt])
      return result.rows[0]!
    })
  }

  async function asRuntime<Value>(operation:(client:PoolClient)=>Promise<Value>):Promise<Value>{
    const client=await pool.connect()
    try{
      await client.query('BEGIN')
      await client.query(`SELECT set_config('app.tenant_id',$1,true),set_config('app.store_id',$2,true)`,[
        id.tenant,id.store,
      ])
      await client.query('SET LOCAL ROLE mbox_runtime')
      const result=await operation(client)
      await client.query('COMMIT')
      return result
    }catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}
  }
})

function envelope(seed:number){return Buffer.concat([Buffer.from([1,seed]),randomBytes(38)])}
function customer(customerId:string){return {scope,customerId,actorRef:`customer:${customerId}`,businessDate:'2026-08-16'}}
function staff(employeeId:string){return {scope,employeeId,businessDate:'2026-08-16'}}

async function seed(pool:Pool){
  const suffix=id.tenant.replaceAll('-','').slice(0,10)
  await pool.query(`INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'Contact governance tenant')`,[
    id.tenant,`pcg-${suffix}`,
  ])
  await pool.query(`INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1,$2,$3,'Contact governance store')`,[
    id.store,id.tenant,`pcg-${suffix}`,
  ])
  await pool.query(`INSERT INTO mbox.roles(tenant_id,store_id,code,name) VALUES
    ($1,$2,'DEPUT_MANAGER','Verifier'),($1,$2,'MANAGER','Drafter'),
    ($1,$2,'OPS_LEAD','Approver'),($1,$2,'OWNER','Publisher')`,[id.tenant,id.store])
  await pool.query(`INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES
    ($1,$5,$6,$7,'Verifier'),($2,$5,$6,$8,'Drafter'),
    ($3,$5,$6,$9,'Approver'),($4,$5,$6,$10,'Publisher')`,[
    id.verifier,id.approver,id.ops,id.owner,id.tenant,id.store,
    `PV-${suffix}`,`PD-${suffix}`,`PA-${suffix}`,`PO-${suffix}`,
  ])
  await pool.query(`INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id,starts_at)
    SELECT $1,$2,assignment.employee_id,role.id,clock_timestamp()
    FROM (VALUES($3::uuid,'DEPUT_MANAGER'),($4::uuid,'MANAGER'),($5::uuid,'OPS_LEAD'),
      ($6::uuid,'OWNER')) assignment(employee_id,role_code)
    JOIN mbox.roles role ON role.tenant_id=$1 AND role.store_id=$2 AND role.code=assignment.role_code`,[
    id.tenant,id.store,id.verifier,id.approver,id.ops,id.owner,
  ])
  await pool.query(`INSERT INTO mbox.customers(id,tenant_id,store_id,public_id,status) VALUES
    ($1,$6,$7,'pcg-current','active'),($2,$6,$7,'pcg-source','active'),
    ($3,$6,$7,'pcg-legacy','active'),($4,$6,$7,'pcg-race','active'),
    ($5,$6,$7,'pcg-retention','active')`,[
    id.current,id.source,id.legacy,id.raceCustomer,id.retentionCustomer,id.tenant,id.store,
  ])
  await pool.query(`INSERT INTO mbox.customer_memberships(
    id,tenant_id,store_id,customer_id,member_no,points_balance,lifetime_points
  ) VALUES($1,$2,$3,$4,'MBX095SOURCE',0,0)`,[
    id.sourceMembership,id.tenant,id.store,id.source,
  ])
  await seedActivity(pool)
  expect(createHash('sha256').update(phoneForStaticCheck()).digest('hex')).toHaveLength(64)
}

async function seedActivity(pool:Pool){
  await pool.query(`INSERT INTO mbox.community_activities(
    id,tenant_id,store_id,public_id,activity_kind,title,summary,starts_at,ends_at,
    assembly_location,capacity,fee_amount_minor,deposit_amount_minor,fee_basis,
    registration_payment_mode,payment_deadline_minutes,payment_rule_text,currency,
    points_reward,visibility,audience_member_levels,audience_lifecycle_stages,
    safety_policy_version,safety_acknowledgement_text,safety_requirements,
    refund_policy_version,refund_policy_summary,activity_details,included_items,
    participation_requirements,contact_instructions,status,published_at,
    created_by_employee_id,approved_by_employee_id
  ) VALUES($1,$2,$3,'pcg-activity','member_night','联系方式治理活动','测试活动联系方式用途',
    clock_timestamp()+interval '1 hour',clock_timestamp()+interval '3 hours','M-BOX',20,
    0,0,'per_registration','none',15,'本活动无需预付','CNY',0,'public','{}'::text[],
    '{}'::text[],'pcg-safety-v1','我已阅读活动安全说明',ARRAY['年满十八周岁']::text[],
    'pcg-refund-v1','免费活动可提前取消','联系方式治理数据库集成测试',ARRAY['测试权益']::text[],
    ARRAY['准时到场']::text[],'仅为当前活动联系','published',clock_timestamp(),$4,$4)`,[
    id.activity,id.tenant,id.store,id.owner,
  ])
  const protectedContact=contactProtection.protect('13812348000')
  for (const [registrationId,publicId,customerId,key] of [
    [id.raceRegistration,'pcg-race-registration',id.raceCustomer,'pcg-race-registration-key'],
    [id.retentionRegistration,'pcg-retention-registration',id.retentionCustomer,'pcg-retention-registration-key'],
  ] as const) {
    await pool.query(`INSERT INTO mbox.community_activity_registrations(
      id,tenant_id,store_id,public_id,activity_id,customer_id,party_size,status,
      payment_choice,payment_status,fee_amount_minor,amount_due_minor,paid_amount_minor,currency,
      contact_snapshot,safety_acknowledgement,idempotency_key,refund_policy_snapshot,
      acknowledged_safety_policy_version,acknowledged_refund_policy_version,
      terms_acknowledged_at,terms_acknowledgement_source,requested_payment_choice,
      requested_amount_due_minor
    ) VALUES($1,$2,$3,$4,$5,$6,1,'confirmed','none','not_required',0,0,0,'CNY',
      jsonb_build_object('contactType','phone','contactHash',$7::text,'encryptedContact',$8::text,
        'encryptionKeyId',$9::text,'maskedContact',$10::text,'source','mini_program'),
      '{}'::jsonb,$11,jsonb_build_object('policyVersion','pcg-refund-v1'),
      'pcg-safety-v1','pcg-refund-v1',clock_timestamp(),'mini_program','none',0)`,[
      registrationId,id.tenant,id.store,publicId,id.activity,customerId,
      protectedContact.hash,protectedContact.encryptedBase64,protectedContact.keyId,
      protectedContact.masked,key,
    ])
  }
}

function phoneForStaticCheck(){return '+8613812345678'}
