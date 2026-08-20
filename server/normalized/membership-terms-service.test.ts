import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { NormalizedCommandExecutor } from './command-executor.js'
import { MembershipEnrollmentService } from './membership-enrollment-service.js'
import { PostgresMembershipConfigurationDraftRepository } from './membership-configuration-draft-repository.js'
import { MembershipConfigurationDraftService } from './membership-configuration-draft-service.js'
import { MembershipTermsService } from './membership-terms-service.js'
import { ScopedPostgresTransactionRunner, type PostgresPool } from './transaction-runner.js'

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip

const id = Object.freeze({
  tenant: randomUUID(), store: randomUUID(), storeWithoutTerms: randomUUID(),
  drafter: randomUUID(), approver: randomUUID(), publisher: randomUUID(),
  customer: randomUUID(), noTermsCustomer: randomUUID(), existingCustomer: randomUUID(),
  existingMembership: randomUUID(), existingAccount: randomUUID(),
})

integration('membership terms release and acceptance', () => {
  let pool: Pool
  let terms: MembershipTermsService
  let configuration: MembershipConfigurationDraftService
  let membershipEnrollment: MembershipEnrollmentService
  let phoneVerificationCount = 0
  let now = new Date()

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    pool = new Pool({ connectionString: databaseUrl, max: 4 })
    const transactions = new ScopedPostgresTransactionRunner(pool as unknown as PostgresPool)
    const commands = new NormalizedCommandExecutor(transactions)
    terms = new MembershipTermsService(transactions, commands, () => now)
    configuration = new MembershipConfigurationDraftService(
      new PostgresMembershipConfigurationDraftRepository(transactions, scope(id.store)), () => now,
    )
    membershipEnrollment = new MembershipEnrollmentService(
      commands,
      {
        verify: async ({ authorizationCode }) => {
          phoneVerificationCount += 1
          return {
            e164Phone: '+8613800138000',
            providerReference: `provider:${authorizationCode}`,
            verifiedAt: now.toISOString(),
          }
        },
      },
      {
        protect: (phone) => {
          const contactHash = createHash('sha256').update(phone).digest('hex')
          return {
            contactHash,
            encryptedValue: Buffer.alloc(48, 7),
            encryptionKeyVersion: 1,
            encryptionKeyId: 'normalized-phone-v1',
            matchHashes: [contactHash],
            maskedValue: '138****8000',
          }
        },
      },
    )
    await seed(pool)
  })

  afterAll(async () => pool?.end())

  it('enforces three-person release, future cut-over, permissions and immutable facts', async () => {
    const rolePermissions = await pool.query<{ role_code: string; permission_code: string }>(`
      SELECT role.code AS role_code,permission.code AS permission_code
      FROM mbox.role_permission_assignments assignment
      JOIN mbox.roles role ON role.id=assignment.role_id
      JOIN mbox.staff_permission_definitions permission ON permission.id=assignment.permission_id
      WHERE role.tenant_id=$1 AND role.store_id=$2 AND permission.code LIKE 'membership.terms.%'
      ORDER BY role.code,permission.code
    `, [id.tenant, id.store])
    expect(rolePermissions.rows).toEqual([
      { role_code: 'MANAGER', permission_code: 'membership.terms.manage' },
      { role_code: 'MANAGER', permission_code: 'membership.terms.view' },
      { role_code: 'OPS_LEAD', permission_code: 'membership.terms.approve' },
      { role_code: 'OPS_LEAD', permission_code: 'membership.terms.view' },
      { role_code: 'OWNER', permission_code: 'membership.terms.publish' },
      { role_code: 'OWNER', permission_code: 'membership.terms.view' },
    ])

    const first = await terms.createDraft(staff(id.drafter), {
      title: 'M-BOX会员加入与积分权益条款',
      summary: '说明会员积分、权益、退款回收及通知的独立授权边界。',
      content: '加入会员后可以累计积分并查看门店发放的权益。手机号、短信和微信服务通知均需另行授权。',
      reason: '建立第一版正式入会条款', idempotencyKey: 'membership-terms-draft-0001',
    })
    expect(first.value).toMatchObject({ version: 1, status: 'draft' })
    await expect(terms.approve(staff(id.drafter), {
      version: 1, reason: '不得由起草人自行审批', idempotencyKey: 'membership-terms-self-approve-0001',
    })).rejects.toMatchObject({ code: 'MEMBERSHIP_TERMS_SELF_APPROVAL_DENIED' })
    await approveTermsVersion(pool, configuration, 1, id.approver, '逐条核对积分与授权边界后通过')
    await expect(terms.publish(staff(id.approver), {
      version: 1, effectiveFrom: null, reason: '审批人不得自行发布',
      idempotencyKey: 'membership-terms-self-publish-0001',
    })).rejects.toMatchObject({ code: 'MEMBERSHIP_TERMS_PUBLISHER_SEPARATION_REQUIRED' })
    await terms.publish(staff(id.publisher), {
      version: 1, effectiveFrom: null, reason: '第三人正式发布第一版条款',
      idempotencyKey: 'membership-terms-publish-0001',
    })
    expect(await terms.current(scope(id.store))).toMatchObject({ version: 1 })

    await terms.createDraft(staff(id.drafter), {
      title: 'M-BOX会员加入与积分权益条款',
      summary: '第二版补充会员权益展示与积分到期说明。',
      content: '加入会员后可以累计积分并查看权益。积分到期规则会在会员页面清楚展示，通知仍需另行授权。',
      reason: '按经营规则更新第二版', idempotencyKey: 'membership-terms-draft-0002',
    })
    await approveTermsVersion(pool, configuration, 2, id.approver, '独立复核第二版业务内容')
    const cutover = new Date(now.getTime()+60*60_000)
    await terms.publish(staff(id.publisher), {
      version: 2, effectiveFrom: cutover.toISOString(), reason: '排期发布且旧版继续生效到切换时点',
      idempotencyKey: 'membership-terms-publish-0002',
    })
    expect(await terms.current(scope(id.store))).toMatchObject({ version: 1 })
    const intervals = await pool.query<{ version: number; effective_until: Date | null }>(`
      SELECT version,effective_until FROM mbox.membership_terms_versions
      WHERE tenant_id=$1 AND store_id=$2 AND status='published' ORDER BY version
    `, [id.tenant, id.store])
    expect(intervals.rows[0]?.effective_until?.toISOString()).toBe(cutover.toISOString())
    now = new Date(cutover.getTime()+1)
    expect(await terms.current(scope(id.store))).toMatchObject({ version: 2 })
    now = new Date(cutover.getTime()-30*60_000)
    await expect(pool.query(`
      UPDATE mbox.membership_terms_versions SET content='禁止篡改已发布正文'
      WHERE tenant_id=$1 AND store_id=$2 AND version=1
    `, [id.tenant, id.store])).rejects.toThrow(/immutable/)
  })

  it('writes acceptance atomically, fails closed without current terms and does not block existing members', async () => {
    now = new Date()
    const stale = membershipEnrollment.enroll(publicContext(id.store, id.customer), {
      termsVersion: 999, acknowledgementSource: 'mini_profile',
      phoneAuthorizationCode: 'wechat-phone-code-stale-0001',
      idempotencyKey: 'membership-enroll-stale-terms-0001',
    })
    await expect(stale).rejects.toMatchObject({ code: 'MEMBERSHIP_TERMS_STALE' })
    const rolledBack = await pool.query(`
      SELECT 1 FROM mbox.customer_memberships WHERE tenant_id=$1 AND store_id=$2 AND customer_id=$3
    `, [id.tenant, id.store, id.customer])
    expect(rolledBack.rowCount).toBe(0)

    const verificationsBeforeEnrollment = phoneVerificationCount
    const enrolled = await membershipEnrollment.enroll(publicContext(id.store, id.customer), {
      termsVersion: 1, acknowledgementSource: 'mini_profile',
      phoneAuthorizationCode: 'wechat-phone-code-enroll-0001',
      idempotencyKey: 'membership-enroll-accepted-terms-0001',
    })
    expect(enrolled).toMatchObject({ replayed: false, value: { created: true } })
    const replay = await membershipEnrollment.enroll(publicContext(id.store, id.customer), {
      termsVersion: 1, acknowledgementSource: 'mini_profile',
      phoneAuthorizationCode: 'wechat-phone-code-enroll-0001',
      idempotencyKey: 'membership-enroll-accepted-terms-0001',
    })
    expect(replay).toMatchObject({ replayed: true, value: { created: true } })
    expect(phoneVerificationCount).toBe(verificationsBeforeEnrollment + 1)
    const acceptance = await pool.query(`
      SELECT acceptance.terms_version,acceptance.acknowledgement_source,
        acceptance.customer_id,membership.customer_id AS membership_customer_id,
        count(*) OVER()::integer AS acceptance_count
      FROM mbox.membership_terms_acceptances acceptance
      JOIN mbox.customer_memberships membership ON membership.id=acceptance.membership_id
      WHERE acceptance.tenant_id=$1 AND acceptance.store_id=$2 AND acceptance.customer_id=$3
    `, [id.tenant, id.store, id.customer])
    expect(acceptance.rows[0]).toMatchObject({
      terms_version: 1, acknowledgement_source: 'mini_profile',
      customer_id: id.customer, membership_customer_id: id.customer, acceptance_count: 1,
    })

    const phone = await pool.query(`
      SELECT contact.processing_status,acceptance.id AS acceptance_id
      FROM mbox.customer_verified_contacts contact
      JOIN mbox.membership_terms_acceptances acceptance
        ON acceptance.tenant_id=contact.tenant_id AND acceptance.store_id=contact.store_id
       AND acceptance.customer_id=contact.customer_id
      WHERE contact.tenant_id=$1 AND contact.store_id=$2 AND contact.customer_id=$3
        AND contact.contact_type='phone'
    `, [id.tenant, id.store, id.customer])
    expect(phone.rows).toEqual([expect.objectContaining({ processing_status: 'active' })])

    await expect(membershipEnrollment.enroll(
      publicContext(id.storeWithoutTerms, id.noTermsCustomer), {
        termsVersion: 1, acknowledgementSource: 'mini_menu',
        phoneAuthorizationCode: 'wechat-phone-code-no-terms-0001',
        idempotencyKey: 'membership-enroll-no-current-terms-0001',
      },
    )).rejects.toMatchObject({ code: 'MEMBERSHIP_TERMS_NOT_AVAILABLE' })
    const failedPhone = await pool.query(`
      SELECT 1 FROM mbox.customer_verified_contacts
      WHERE tenant_id=$1 AND store_id=$2 AND customer_id=$3
    `, [id.tenant, id.storeWithoutTerms, id.noTermsCustomer])
    expect(failedPhone.rowCount).toBe(0)
    const existing = await membershipEnrollment.enroll(
      publicContext(id.storeWithoutTerms, id.existingCustomer), {
        termsVersion: 999, acknowledgementSource: 'mini_menu',
        phoneAuthorizationCode: 'wechat-phone-code-existing-0001',
        idempotencyKey: 'membership-enroll-existing-no-terms-0001',
      },
    )
    expect(existing.value.created).toBe(false)
  })
})

async function approveTermsVersion(
  pool: Pool, configuration: MembershipConfigurationDraftService, version: number,
  approverEmployeeId: string, reason: string,
) {
  const row = (await pool.query<{ id: string }>(`
    SELECT id::text FROM mbox.membership_terms_versions
    WHERE tenant_id=$1 AND store_id=$2 AND version=$3
  `, [id.tenant, id.store, version])).rows[0]!
  const draft = await configuration.get('membership_terms', row.id)
  const preview = await configuration.preview('membership_terms', row.id, approverEmployeeId)
  return configuration.approve({ domain: 'membership_terms', publicId: row.id,
    expectedRevision: draft.revision, approverEmployeeId, reason,
    impactPreviewPublicId: preview.publicId })
}

function scope(storeId: string) {
  return { tenantId: id.tenant, storeId }
}

function staff(employeeId: string) {
  return { scope: scope(id.store), employeeId, businessDate: '2026-08-16' }
}

function publicContext(storeId: string, customerId: string) {
  return {
    scope: scope(storeId), customerId, actorRef: `customer:${customerId}`, businessDate: '2026-08-16',
  }
}

async function seed(pool: Pool): Promise<void> {
  await pool.query(`INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'Terms tenant')`, [
    id.tenant, `terms-${id.tenant.slice(0,8)}`,
  ])
  await pool.query(`
    INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES
      ($1,$3,$4,'Terms store'),($2,$3,$5,'No terms store')
  `, [
    id.store,id.storeWithoutTerms,id.tenant,
    `terms-${id.store.slice(0,8)}`,`no-terms-${id.storeWithoutTerms.slice(0,8)}`,
  ])
  await pool.query(`
    INSERT INTO mbox.roles(tenant_id,store_id,code,name) VALUES
      ($1,$2,'MANAGER','店长'),($1,$2,'OPS_LEAD','运营负责人'),($1,$2,'OWNER','最高管理人员')
  `, [id.tenant,id.store])
  await pool.query(`
    INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES
      ($1,$4,$5,'TERMS_DRAFTER','条款起草人'),
      ($2,$4,$5,'TERMS_APPROVER','条款审批人'),
      ($3,$4,$5,'TERMS_PUBLISHER','条款发布人')
  `, [id.drafter,id.approver,id.publisher,id.tenant,id.store])
  await pool.query(`
    INSERT INTO mbox.customers(id,tenant_id,store_id,public_id,status) VALUES
      ($1,$4,$5,'terms-new-customer','active'),
      ($2,$4,$6,'terms-no-current-customer','active'),
      ($3,$4,$6,'terms-existing-member','active')
  `, [id.customer,id.noTermsCustomer,id.existingCustomer,id.tenant,id.store,id.storeWithoutTerms])
  await pool.query(`
    INSERT INTO mbox.customer_memberships(
      id,tenant_id,store_id,customer_id,member_no
    ) VALUES($1,$2,$3,$4,'MBX-EXISTING-NO-TERMS')
  `, [id.existingMembership,id.tenant,id.storeWithoutTerms,id.existingCustomer])
  await pool.query(`
    INSERT INTO mbox.loyalty_accounts(
      id,tenant_id,store_id,membership_id,customer_id
    ) VALUES($1,$2,$3,$4,$5)
  `, [id.existingAccount,id.tenant,id.storeWithoutTerms,id.existingMembership,id.existingCustomer])
}
