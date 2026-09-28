import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import {
  OfficialAlipayPhoneAuthorizationProvider,
  encryptAlipayPhoneFixture,
} from './alipay-phone-authorization.js'
import { NormalizedCommandExecutor } from './command-executor.js'
import { MembershipEnrollmentService } from './membership-enrollment-service.js'
import {
  createMembershipRecoveryPhoneProtector,
  mapVerifiedPhoneUniqueViolation,
  replaceVerifiedPhoneInTransaction,
} from './membership-recovery-service.js'
import { ScopedPostgresTransactionRunner, type PostgresPool } from './transaction-runner.js'

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip

const aesKey = 'alipay-aes-key16'
const appId = '2021006196615276'
const id = Object.freeze({
  tenant: randomUUID(),
  store: randomUUID(),
  manager: randomUUID(),
  approver: randomUUID(),
  owner: randomUUID(),
  repeatCustomer: randomUUID(),
  unboundOwner: randomUUID(),
  unboundClaimant: randomUUID(),
  disposedOwner: randomUUID(),
  disposedClaimant: randomUUID(),
  memberOwner: randomUUID(),
  memberClaimant: randomUUID(),
  memberMembership: randomUUID(),
  memberAccount: randomUUID(),
  wechatOwner: randomUUID(),
  wechatClaimant: randomUUID(),
})

describe('alipay phone authorization conflict copy', () => {
  it('maps the store-wide authorization unique violation to a 409 the guest can act on', () => {
    const mapped = mapVerifiedPhoneUniqueViolation(Object.assign(
      new Error('duplicate key value violates unique constraint "customer_verified_contact_actions_authorization_reference_uq"'),
      { code: '23505', constraint: 'customer_verified_contact_actions_authorization_reference_uq' },
    ))
    expect(mapped).toMatchObject({
      statusCode: 409,
      code: 'PHONE_AUTHORIZATION_REPLAY_REJECTED',
    })
  })

  it('gives Alipay and WeChat a Chinese line for the new conflict and the generic failure', () => {
    const alipay = readFileSync(new URL('../../alipay-miniprogram/utils/customer-error.js', import.meta.url), 'utf8')
    const wechat = readFileSync(new URL('../../miniprogram/utils/customer-error.js', import.meta.url), 'utf8')
    for (const source of [alipay, wechat]) {
      expect(source).toContain("PHONE_AUTHORIZATION_REPLAY_REJECTED: '这次手机号授权已经使用过。请重新点一次授权；如果这是原来的会员，请使用「找回原会员」'")
      expect(source).toContain("MEMBERSHIP_PHONE_AUTHORIZATION_CONFLICT: '这个手机号已经绑定了其他会员。请使用「找回原会员」完成登录，本次没有重复开卡'")
      expect(source).toContain("CUSTOMER_EXPERIENCE_FAILED: '会员服务暂时没有接上，请稍后重试'")
    }
  })
})

integration('alipay repeatable phone proof enrollment', () => {
  let pool: Pool
  let runner: ScopedPostgresTransactionRunner
  const phones = createMembershipRecoveryPhoneProtector('alipay-phone-enroll-replay-secret')
  const provider = new OfficialAlipayPhoneAuthorizationProvider({ appId, aesKey })
  const scope = { tenantId: id.tenant, storeId: id.store }

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    pool = new Pool({ connectionString: databaseUrl, max: 4 })
    runner = new ScopedPostgresTransactionRunner(pool as unknown as PostgresPool)
    await seed(pool)
  })

  afterAll(async () => pool?.end())

  it('grants the runtime login the new proof digest without letting it update that digest', async () => {
    const privileges = await pool.query<{
      select_proof: boolean
      insert_proof: boolean
      update_proof: boolean
      update_revoked_by_customer: boolean
      update_revoked_by_employee: boolean
    }>(`
      SELECT
        has_column_privilege('mbox_runtime','mbox.customer_verified_contacts','repeatable_proof_sha256','SELECT') AS select_proof,
        has_column_privilege('mbox_runtime','mbox.customer_verified_contacts','repeatable_proof_sha256','INSERT') AS insert_proof,
        has_column_privilege('mbox_runtime','mbox.customer_verified_contacts','repeatable_proof_sha256','UPDATE') AS update_proof,
        has_column_privilege('mbox_runtime','mbox.customer_verified_contacts','revoked_by_customer_id','UPDATE') AS update_revoked_by_customer,
        has_column_privilege('mbox_runtime','mbox.customer_verified_contacts','revoked_by_employee_id','UPDATE') AS update_revoked_by_employee
    `)
    expect(privileges.rows[0]).toEqual({
      select_proof: true,
      insert_proof: true,
      update_proof: false,
      update_revoked_by_customer: true,
      update_revoked_by_employee: true,
    })
  })

  it('accepts a second authorization of the same phone for the same customer without storing plaintext', async () => {
    const ciphertext = encryptAlipayPhoneFixture('13800000001', aesKey)
    const first = await provider.verify({ authorizationCode: ciphertext, customerId: id.repeatCustomer })
    const second = await provider.verify({ authorizationCode: ciphertext, customerId: id.repeatCustomer })
    expect(first.repeatableProofReference).toBe(second.repeatableProofReference)
    expect(first.providerReference).not.toBe(second.providerReference)
    const firstPhone = await bindPhone(runner, phones, id.repeatCustomer, first, 'alipay-repeat-proof-0001')
    const secondPhone = await bindPhone(runner, phones, id.repeatCustomer, second, 'alipay-repeat-proof-0002')
    expect(secondPhone.publicId).toBe(firstPhone.publicId)
    expect(secondPhone.verificationSource).toBe('wechat_phone_authorization')
    const stored = await pool.query<{
      active_count: number
      contact_hash: string
      encrypted_hex: string
      masked_value: string
      repeatable_proof_sha256: string
    }>(`
      SELECT count(*) FILTER (WHERE processing_status='active')::integer AS active_count,
        max(contact_hash) FILTER (WHERE processing_status='active') AS contact_hash,
        max(encode(encrypted_value,'hex')) FILTER (WHERE processing_status='active') AS encrypted_hex,
        max(masked_value) FILTER (WHERE processing_status='active') AS masked_value,
        max(repeatable_proof_sha256) FILTER (WHERE processing_status='active') AS repeatable_proof_sha256
      FROM mbox.customer_verified_contacts
      WHERE tenant_id=$1 AND store_id=$2 AND customer_id=$3
    `, [id.tenant, id.store, id.repeatCustomer])
    const row = stored.rows[0]!
    expect(row.active_count).toBe(1)
    expect(row.repeatable_proof_sha256).toBe(sha256(first.repeatableProofReference!))
    expect(row.contact_hash).not.toBe(sha256('+8613800000001'))
    expect(row.encrypted_hex).not.toContain(Buffer.from('+8613800000001').toString('hex'))
    expect(row.masked_value).not.toContain('13800000001')
    const references = await pool.query<{ authorization_reference_sha256: string }>(`
      SELECT action.authorization_reference_sha256
      FROM mbox.customer_verified_contact_actions action
      JOIN mbox.customer_verified_contacts contact ON contact.id=action.contact_id
      WHERE contact.customer_id=$1 AND action.action='verified'
    `, [id.repeatCustomer])
    expect(references.rows.map((item) => item.authorization_reference_sha256.trim()))
      .not.toContain(sha256(first.repeatableProofReference!))
  })

  it('rebinds a phone whose old authorization reference belongs to another family without a membership', async () => {
    const ciphertext = encryptAlipayPhoneFixture('13800000002', aesKey)
    const proof = await provider.verify({ authorizationCode: ciphertext, customerId: id.unboundOwner })
    await bindLegacyProof(runner, phones, id.unboundOwner, proof, '+8613800000002', 'alipay-legacy-unbound-0001')
    const claimantProof = await provider.verify({ authorizationCode: ciphertext, customerId: id.unboundClaimant })
    const bound = await bindPhone(runner, phones, id.unboundClaimant, claimantProof, 'alipay-rebind-unbound-0001')
    expect(bound.verificationSource).toBe('wechat_phone_authorization')
    const rows = await pool.query<{ customer_id: string; processing_status: string; provider_reference_sha256: string }>(`
      SELECT customer_id, processing_status, provider_reference_sha256
      FROM mbox.customer_verified_contacts
      WHERE tenant_id=$1 AND store_id=$2 AND customer_id=ANY($3::uuid[])
      ORDER BY processing_status, customer_id
    `, [id.tenant, id.store, [id.unboundOwner, id.unboundClaimant]])
    expect(rows.rows).toEqual([
      expect.objectContaining({ customer_id: id.unboundClaimant, processing_status: 'active' }),
      expect.objectContaining({ customer_id: id.unboundOwner, processing_status: 'revoked' }),
    ])
    const activeReference = rows.rows.find((row) => row.processing_status === 'active')!.provider_reference_sha256.trim()
    const legacyReference = rows.rows.find((row) => row.processing_status === 'revoked')!.provider_reference_sha256.trim()
    expect(activeReference).not.toBe(legacyReference)
    expect(legacyReference).toBe(sha256(proof.repeatableProofReference!))
  })

  it('lets a later customer enroll after the previous contact was disposed', async () => {
    const ciphertext = encryptAlipayPhoneFixture('13800000003', aesKey)
    const proof = await provider.verify({ authorizationCode: ciphertext, customerId: id.disposedOwner })
    await bindLegacyProof(runner, phones, id.disposedOwner, proof, '+8613800000003', 'alipay-legacy-disposed-0001')
    await disposeVerifiedPhone(runner, pool, id.disposedOwner)
    const claimantProof = await provider.verify({ authorizationCode: ciphertext, customerId: id.disposedClaimant })
    const bound = await bindPhone(runner, phones, id.disposedClaimant, claimantProof, 'alipay-after-dispose-0001')
    expect(bound.status).toBe('active')
    const rows = await pool.query<{ customer_id: string; processing_status: string; contact_hash: string | null }>(`
      SELECT customer_id, processing_status, contact_hash
      FROM mbox.customer_verified_contacts
      WHERE tenant_id=$1 AND store_id=$2 AND customer_id=ANY($3::uuid[])
    `, [id.tenant, id.store, [id.disposedOwner, id.disposedClaimant]])
    expect(rows.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ customer_id: id.disposedOwner, processing_status: 'disposed', contact_hash: null }),
      expect.objectContaining({ customer_id: id.disposedClaimant, processing_status: 'active' }),
    ]))
  })

  it('merges a repeat authorization into the existing modern membership after disposal wiped the phone hash', async () => {
    const ciphertext = encryptAlipayPhoneFixture('13800000006', aesKey)
    const proof = await provider.verify({ authorizationCode: ciphertext, customerId: id.memberOwner })
    await bindLegacyProof(runner, phones, id.memberOwner, proof, '+8613800000006', 'alipay-legacy-member-0001')
    await disposeVerifiedPhone(runner, pool, id.memberOwner)
    const enrollment = new MembershipEnrollmentService(
      new NormalizedCommandExecutor(runner),
      provider,
      phones,
    )
    const enrolled = await enrollment.enroll({
      scope,
      customerId: id.memberClaimant,
      actorRef: `customer:${id.memberClaimant}`,
      businessDate: '2026-09-28',
    }, {
      termsVersion: 1,
      acknowledgementSource: 'mini_profile',
      phoneAuthorizationCode: ciphertext,
      phoneAuthorizationProvider: 'alipay',
      idempotencyKey: 'alipay-enroll-owned-phone-0001',
    })
    expect(enrolled.value.created).toBe(false)
    expect(enrolled.value.membership?.memberNo).toBe('100001')
    expect(enrolled.value.verifiedPhone.verificationSource).toBe('wechat_phone_authorization')
    const merged = await pool.query<{ merged_into_customer_id: string }>(`
      SELECT merged_into_customer_id FROM mbox.customers WHERE id=$1
    `, [id.memberClaimant])
    expect(merged.rows[0]?.merged_into_customer_id).toBe(id.memberOwner)
    const phonesLeft = await pool.query<{ processing_status: string; customer_id: string }>(`
      SELECT processing_status, customer_id
      FROM mbox.customer_verified_contacts
      WHERE tenant_id=$1 AND store_id=$2 AND customer_id=ANY($3::uuid[])
        AND processing_status='active'
    `, [id.tenant, id.store, [id.memberOwner, id.memberClaimant]])
    expect(phonesLeft.rows).toEqual([
      expect.objectContaining({ customer_id: id.memberOwner, processing_status: 'active' }),
    ])
  })

  it('rejects a replayed one-time WeChat code from another customer instead of freeing the unique reference', async () => {
    const referenceHash = sha256('wechat-phone:one-time-code-0001')
    await bindReference(runner, phones, id.wechatOwner, '+8613800000004', referenceHash, null, 'wechat-replay-owner-0001')
    await expect(bindReference(
      runner, phones, id.wechatClaimant, '+8613800000005', referenceHash, null, 'wechat-replay-other-0001',
    )).rejects.toMatchObject({ code: 'PHONE_AUTHORIZATION_REPLAY_REJECTED', statusCode: 409 })
    const ownerBefore = await pool.query<{ processing_status: string }>(`
      SELECT processing_status FROM mbox.customer_verified_contacts
      WHERE customer_id=$1 AND contact_type='phone'
    `, [id.wechatOwner])
    expect(ownerBefore.rows).toEqual([expect.objectContaining({ processing_status: 'active' })])
    const sameCustomer = await bindReference(
      runner, phones, id.wechatOwner, '+8613800000004', referenceHash, null, 'wechat-replay-same-0001',
    )
    expect(sameCustomer.status).toBe('active')
    const ownerAfter = await pool.query<{ processing_status: string }>(`
      SELECT processing_status FROM mbox.customer_verified_contacts
      WHERE customer_id=$1 AND contact_type='phone'
    `, [id.wechatOwner])
    expect(ownerAfter.rows).toEqual([expect.objectContaining({ processing_status: 'active' })])
    await pool.query(`
      UPDATE mbox.customer_verified_contacts
      SET processing_status='revoked',
          revoked_at=GREATEST(clock_timestamp(), verified_at),
          revocation_reason_code='customer_replaced_phone'
      WHERE customer_id=$1 AND processing_status='active'
    `, [id.wechatOwner])
    const revived = await bindReference(
      runner, phones, id.wechatOwner, '+8613800000004', referenceHash, null, 'wechat-replay-revived-0001',
    )
    expect(revived.status).toBe('active')
    const revivedRows = await pool.query<{ processing_status: string }>(`
      SELECT processing_status FROM mbox.customer_verified_contacts
      WHERE customer_id=$1 AND contact_type='phone'
    `, [id.wechatOwner])
    expect(revivedRows.rows).toEqual([expect.objectContaining({ processing_status: 'active' })])
  })
})

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

async function bindPhone(
  runner: ScopedPostgresTransactionRunner,
  phones: ReturnType<typeof createMembershipRecoveryPhoneProtector>,
  customerId: string,
  verified: { e164Phone: string; providerReference: string; repeatableProofReference?: string; verifiedAt: string },
  idempotencyKey: string,
) {
  return bindReference(
    runner,
    phones,
    customerId,
    verified.e164Phone,
    sha256(verified.providerReference),
    verified.repeatableProofReference ? sha256(verified.repeatableProofReference) : null,
    idempotencyKey,
    verified.verifiedAt,
  )
}

async function bindLegacyProof(
  runner: ScopedPostgresTransactionRunner,
  phones: ReturnType<typeof createMembershipRecoveryPhoneProtector>,
  customerId: string,
  verified: { e164Phone: string; repeatableProofReference?: string; verifiedAt: string },
  e164Phone: string,
  idempotencyKey: string,
) {
  return bindReference(
    runner,
    phones,
    customerId,
    e164Phone,
    sha256(verified.repeatableProofReference!),
    null,
    idempotencyKey,
    verified.verifiedAt,
  )
}

async function bindReference(
  runner: ScopedPostgresTransactionRunner,
  phones: ReturnType<typeof createMembershipRecoveryPhoneProtector>,
  customerId: string,
  e164Phone: string,
  providerReferenceHash: string,
  repeatableProofSha256: string | null,
  idempotencyKey: string,
  verifiedAt = new Date().toISOString(),
) {
  return runner.run({ tenantId: id.tenant, storeId: id.store }, (transaction) => replaceVerifiedPhoneInTransaction(transaction, {
    customerId,
    protectedPhone: phones.protect(e164Phone),
    providerReferenceHash,
    repeatableProofSha256,
    verifiedAt,
    idempotencyKey,
  }))
}

let retentionPolicyId: string | null = null

async function disposeVerifiedPhone(
  runner: ScopedPostgresTransactionRunner,
  pool: Pool,
  customerId: string,
): Promise<void> {
  await pool.query(`
    UPDATE mbox.customer_verified_contacts
    SET processing_status='revoked',
        revoked_at=GREATEST(clock_timestamp(), verified_at),
        revocation_reason_code='test_retention_elapsed'
    WHERE tenant_id=$1 AND store_id=$2 AND customer_id=$3 AND processing_status='active'
  `, [id.tenant, id.store, customerId])
  const policyId = retentionPolicyId ?? await publishRetentionPolicy(runner)
  retentionPolicyId = policyId
  const contact = await pool.query<{ id: string }>(`
    SELECT id FROM mbox.customer_verified_contacts
    WHERE tenant_id=$1 AND store_id=$2 AND customer_id=$3 AND processing_status='revoked'
    ORDER BY revoked_at DESC LIMIT 1
  `, [id.tenant, id.store, customerId])
  const disposed = await runner.run({ tenantId: id.tenant, storeId: id.store }, (transaction) => transaction.query<{ disposed: boolean }>(`
    SELECT mbox.dispose_personal_contact(
      'verified_membership_phone',$1::uuid,$2::uuid,'test-worker:personal-contact-disposition'
    ) AS disposed
  `, [contact.rows[0]?.id, policyId]))
  if (disposed.rows[0]?.disposed !== true) throw new Error('verified phone was not disposed')
}

async function publishRetentionPolicy(runner: ScopedPostgresTransactionRunner): Promise<string> {
  const policyPublicId = `PCR${randomUUID().replaceAll('-', '').toUpperCase()}`
  return runner.run({ tenantId: id.tenant, storeId: id.store }, async (transaction) => {
    await transaction.query(`
      SELECT mbox.draft_personal_contact_retention_policy(
        $1,'verified_membership_phone',0,$2,$3::uuid,$4
      )
    `, [
      policyPublicId,
      '个人信息保护法规定的最短必要保存期限，测试用零日保留。',
      id.manager,
      '为手机号处置回归准备零日保留策略',
    ])
    const drafted = await transaction.query<{ id: string }>(`
      SELECT id FROM mbox.personal_contact_retention_policy_versions
      WHERE tenant_id=$1 AND store_id=$2 AND public_id=$3
    `, [id.tenant, id.store, policyPublicId])
    const draftedId = drafted.rows[0]?.id
    if (!draftedId) throw new Error('retention draft missing')
    await transaction.query(`
      SELECT mbox.approve_personal_contact_retention_policy($1::uuid,$2::uuid,$3)
    `, [draftedId, id.approver, '独立复核零日保留仅用于回归'])
    await transaction.query(`
      SELECT mbox.publish_personal_contact_retention_policy(
        $1::uuid,$2::uuid,$3,clock_timestamp()
      )
    `, [draftedId, id.owner, '第三人发布零日保留策略'])
    return draftedId
  })
}

async function seed(pool: Pool): Promise<void> {
  await pool.query(`INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'Alipay enroll tenant')`, [
    id.tenant, `alipay-${id.tenant.slice(0, 8)}`,
  ])
  await pool.query(`INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1,$2,$3,'Alipay enroll store')`, [
    id.store, id.tenant, `alipay-${id.store.slice(0, 8)}`,
  ])
  await pool.query(`
    INSERT INTO mbox.roles(tenant_id,store_id,code,name) VALUES
      ($1,$2,'MANAGER','店长'),($1,$2,'OPS_LEAD','运营负责人'),($1,$2,'OWNER','老板')
  `, [id.tenant, id.store])
  await pool.query(`
    INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES
      ($1,$4,$5,'ALIPAY_MANAGER','支付宝回归店长'),
      ($2,$4,$5,'ALIPAY_OPS','支付宝回归运营'),
      ($3,$4,$5,'ALIPAY_OWNER','支付宝回归老板')
  `, [id.manager, id.approver, id.owner, id.tenant, id.store])
  await pool.query(`
    INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id,starts_at)
    SELECT $1::uuid,$2::uuid,assignment.employee_id,role.id,clock_timestamp()
    FROM (VALUES
      ($3::uuid,'MANAGER'),($4::uuid,'OPS_LEAD'),($5::uuid,'OWNER')
    ) assignment(employee_id,role_code)
    JOIN mbox.roles role ON role.tenant_id=$1::uuid AND role.store_id=$2::uuid
      AND role.code=assignment.role_code
  `, [id.tenant, id.store, id.manager, id.approver, id.owner])
  const customers = [
    id.repeatCustomer, id.unboundOwner, id.unboundClaimant, id.disposedOwner, id.disposedClaimant,
    id.memberOwner, id.memberClaimant, id.wechatOwner, id.wechatClaimant,
  ]
  await pool.query(`
    INSERT INTO mbox.customers(id,tenant_id,store_id,public_id,status)
    SELECT customer_id,$2,$3,'alipay-'||substr(replace(customer_id::text,'-',''),1,16),'active'
    FROM unnest($1::uuid[]) AS customer_id
  `, [customers, id.tenant, id.store])
  await pool.query(`
    INSERT INTO mbox.customer_memberships(
      id,tenant_id,store_id,customer_id,member_no
    ) VALUES($1,$2,$3,$4,'100001')
  `, [id.memberMembership, id.tenant, id.store, id.memberOwner])
  await pool.query(`
    INSERT INTO mbox.loyalty_accounts(
      id,tenant_id,store_id,membership_id,customer_id
    ) VALUES($1,$2,$3,$4,$5)
  `, [id.memberAccount, id.tenant, id.store, id.memberMembership, id.memberOwner])
}
