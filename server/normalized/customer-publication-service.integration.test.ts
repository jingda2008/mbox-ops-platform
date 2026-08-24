import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
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
  })
})

function staff(employeeId: string) {
  return {
    scope: { tenantId: ids.tenant, storeId: ids.store }, employeeId, businessDate: '2026-08-24',
  }
}
