import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import {
  MembershipRecoveryService,
  createMembershipRecoveryPhoneProtector,
} from './membership-recovery-service.js'
import { ScopedPostgresTransactionRunner, type PostgresPool } from './transaction-runner.js'

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip

const id = Object.freeze({
  tenant: randomUUID(), store: randomUUID(), verifier: randomUUID(), approver: randomUUID(),
  selector: randomUUID(), current: randomUUID(), otherCurrent: randomUUID(),
  source: randomUUID(), sourceMembership: randomUUID(), sourceAccount: randomUUID(),
  sourceBenefit: randomUUID(), sourceLot: randomUUID(), sourceLedger: randomUUID(),
  secondSource: randomUUID(), secondMembership: randomUUID(), secondAccount: randomUUID(),
  thirdSource: randomUUID(), thirdMembership: randomUUID(), thirdAccount: randomUUID(),
})

integration('membership recovery and preserved merge facts', () => {
  let pool: Pool
  let service: MembershipRecoveryService
  const now = new Date()
  const phone = '+8613812345678'

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    pool = new Pool({ connectionString: databaseUrl, max: 4 })
    const runner = new ScopedPostgresTransactionRunner(pool as unknown as PostgresPool)
    service = new MembershipRecoveryService(
      runner, createMembershipRecoveryPhoneProtector('membership-recovery-test-secret-2026'), () => now,
    )
    await seed(pool)
    await service.recordStaffVerifiedContact(staff(id.verifier), {
      memberNo: 'MBXHISTORY0001', e164Phone: phone,
      reason: '现场核对原始会员登记凭证与本人手机号',
      idempotencyKey: 'legacy-contact-verify-0001',
    })
  })

  afterAll(async () => pool?.end())

  it('stores only keyed lookup/encrypted/masked phone evidence and never plaintext', async () => {
    await service.recordStaffVerifiedContact(staff(id.verifier), {
      memberNo: 'MBXHISTORY0001', e164Phone: phone,
      reason: '同一请求重试不得重复生成联系方式核验事实',
      idempotencyKey: 'legacy-contact-verify-0001',
    })
    const stored = await pool.query<{
      contact_hash: string; encrypted_hex: string; masked_value: string; event_count: number
    }>(`
      SELECT contact_hash,encode(encrypted_value,'hex') AS encrypted_hex,masked_value,
        (SELECT count(*)::integer FROM mbox.customer_verified_contact_actions action
          WHERE action.contact_id=contact.id AND action.action='verified') AS event_count
      FROM mbox.customer_verified_contacts contact WHERE customer_id=$1
    `, [id.source])
    expect(stored.rows[0]?.contact_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(stored.rows[0]?.contact_hash).not.toBe(createHash('sha256').update(phone).digest('hex'))
    expect(stored.rows[0]?.encrypted_hex).not.toContain(Buffer.from(phone).toString('hex'))
    expect(stored.rows[0]?.masked_value).toBe('+86*******5678')
    expect(stored.rows[0]?.event_count).toBe(1)
    const rolePermissions = await pool.query<{ role_code: string; permission_code: string }>(`
      SELECT role.code AS role_code,permission.code AS permission_code
      FROM mbox.role_permission_assignments assignment
      JOIN mbox.roles role ON role.id=assignment.role_id
      JOIN mbox.staff_permission_definitions permission ON permission.id=assignment.permission_id
      WHERE role.tenant_id=$1 AND role.store_id=$2
        AND permission.code LIKE 'customer.membership.%'
      ORDER BY role.code,permission.code
    `, [id.tenant, id.store])
    expect(rolePermissions.rows).toEqual([
      { role_code: 'DEPUT_MANAGER', permission_code: 'customer.membership.recovery.verify' },
      { role_code: 'MANAGER', permission_code: 'customer.membership.merge.approve' },
      { role_code: 'MANAGER', permission_code: 'customer.membership.recovery.verify' },
      { role_code: 'OWNER', permission_code: 'customer.membership.merge.approve' },
      { role_code: 'OWNER', permission_code: 'customer.membership.recovery.verify' },
    ])
  })

  it('binds a one-candidate recovery to the current customer and requires an independent checker', async () => {
    const started = await service.start(publicContext(id.current), {
      idempotencyKey: 'membership-recovery-start-0001',
    })
    const repeated = await service.start(publicContext(id.current), {
      idempotencyKey: 'membership-recovery-start-0001',
    })
    expect(repeated.challengePublicId).toBe(started.challengePublicId)

    const verified = await service.verify(publicContext(id.current), {
      challengePublicId: started.challengePublicId,
      verifiedPhone: {
        e164Phone: phone, providerReference: 'wechat-phone-code-event-0001',
        verifiedAt: now.toISOString(),
      },
      idempotencyKey: 'membership-recovery-verify-0001',
    })
    expect(verified).toMatchObject({ status: 'pending_review' })
    expect(JSON.stringify(verified)).not.toMatch(/MBXHISTORY|points|candidate/i)

    const queue = await service.reviewQueue(staff(id.approver))
    const recoveryCase = queue.find((row) => row.status === 'pending_review')
    expect(recoveryCase).toMatchObject({ candidateCount: 1, maskedPhone: '+86*******5678' })
    const casePublicId = recoveryCase?.casePublicId as string
    await expect(service.approve(staff(id.verifier), {
      casePublicId, reason: '不得由历史联系方式核验人自行复核合并',
      idempotencyKey: 'membership-recovery-approve-self-0001',
    })).rejects.toMatchObject({ code: 'RECOVERY_MAKER_CHECKER_REQUIRED' })

    await expect(service.verify(publicContext(id.otherCurrent), {
      challengePublicId: started.challengePublicId,
      verifiedPhone: {
        e164Phone: phone, providerReference: 'wechat-phone-code-event-wrong-owner',
        verifiedAt: now.toISOString(),
      },
      idempotencyKey: 'membership-recovery-verify-wrong-owner',
    })).rejects.toMatchObject({ code: 'RECOVERY_CHALLENGE_NOT_FOUND' })

    await expect(service.approve(staff(id.approver), {
      casePublicId, reason: '独立复核手机号掩码、原会员凭据与顾客现场陈述一致',
      idempotencyKey: 'membership-recovery-approve-0001',
    })).resolves.toEqual({ casePublicId, status: 'executed' })
    await expect(service.approve(staff(id.approver), {
      casePublicId, reason: '网络重试必须返回同一已执行结果',
      idempotencyKey: 'membership-recovery-approve-0001',
    })).resolves.toEqual({ casePublicId, status: 'executed' })
    await expect(service.start(publicContext(id.current), {
      idempotencyKey: 'membership-recovery-start-after-family-merge',
    })).rejects.toMatchObject({ code: 'MEMBERSHIP_ALREADY_BOUND' })

    const facts = await pool.query(`
      SELECT source.status,source.merged_into_customer_id,
        membership.customer_id AS membership_customer_id,
        account.customer_id AS account_customer_id,account.available_points,
        lot.customer_id AS lot_customer_id,ledger.customer_id AS ledger_customer_id,
        benefit.customer_id AS benefit_customer_id,merge_case.status AS merge_status,
        merge_case.approved_by_employee_id,
        (SELECT count(*)::integer FROM mbox.membership_merge_actions action
          WHERE action.merge_case_id=merge_case.id) AS action_count
      FROM mbox.customers source
      JOIN mbox.customer_memberships membership ON membership.id=$2
      JOIN mbox.loyalty_accounts account ON account.id=$3
      JOIN mbox.loyalty_point_lots lot ON lot.id=$4
      JOIN mbox.loyalty_point_ledger ledger ON ledger.id=$5
      JOIN mbox.benefits benefit ON benefit.id=$6
      JOIN mbox.membership_merge_cases merge_case ON merge_case.source_customer_id=source.id
      WHERE source.id=$1
    `, [id.source, id.sourceMembership, id.sourceAccount, id.sourceLot, id.sourceLedger, id.sourceBenefit])
    expect(facts.rows[0]).toMatchObject({
      status: 'merged', merged_into_customer_id: id.current,
      membership_customer_id: id.source, account_customer_id: id.source,
      available_points: 75, lot_customer_id: id.source,
      ledger_customer_id: id.source, benefit_customer_id: id.source,
      merge_status: 'executed', approved_by_employee_id: id.approver, action_count: 3,
    })
  })

  it('never auto-selects multiple matches and enforces selector/checker separation', async () => {
    await service.recordStaffVerifiedContact(staff(id.verifier), {
      memberNo: 'MBXHISTORY0002', e164Phone: phone,
      reason: '第二个同手机号历史账户需要人工区分',
      idempotencyKey: 'legacy-contact-verify-0002',
    })
    await service.recordStaffVerifiedContact(staff(id.verifier), {
      memberNo: 'MBXHISTORY0003', e164Phone: phone,
      reason: '第三个同手机号历史账户需要人工区分',
      idempotencyKey: 'legacy-contact-verify-0003',
    })
    const started = await service.start(publicContext(id.otherCurrent), {
      idempotencyKey: 'membership-recovery-start-0002',
    })
    const result = await service.verify(publicContext(id.otherCurrent), {
      challengePublicId: started.challengePublicId,
      verifiedPhone: {
        e164Phone: phone, providerReference: 'wechat-phone-code-event-0002',
        verifiedAt: now.toISOString(),
      },
      idempotencyKey: 'membership-recovery-verify-0002',
    })
    expect(result.status).toBe('manual_review')
    expect(Object.keys(result).sort()).toEqual([
      'challengePublicId','expiresAt','message','status',
    ])
    expect(JSON.stringify(result)).not.toMatch(/MBXHISTORY|points|candidate|memberNo/i)
    const queue = await service.reviewQueue(staff(id.selector))
    const mergeCase = queue.find((row) => row.status === 'manual_review')
    expect(mergeCase).toMatchObject({ candidateCount: 2, selectedCandidatePublicId: null })
    const casePublicId = mergeCase?.casePublicId as string
    await expect(service.approve(staff(id.approver), {
      casePublicId, reason: '尚未选择候选时必须拒绝',
      idempotencyKey: 'membership-recovery-approve-unselected',
    })).rejects.toMatchObject({ code: 'RECOVERY_CASE_NOT_APPROVABLE' })
    const candidates = await service.candidates(staff(id.selector), casePublicId)
    expect(candidates).toHaveLength(2)
    expect(JSON.stringify(candidates)).not.toContain('MBXHISTORY0001')
    await service.selectCandidate(staff(id.selector), {
      casePublicId, candidatePublicId: candidates[1]?.candidatePublicId as string,
      reason: '核对原会员码末位与建档日期后选择第二个候选',
      idempotencyKey: 'membership-recovery-select-0002',
    })
    await expect(service.approve(staff(id.selector), {
      casePublicId, reason: '选择人与复核人不得相同',
      idempotencyKey: 'membership-recovery-approve-selector-0002',
    })).rejects.toMatchObject({ code: 'RECOVERY_MAKER_CHECKER_REQUIRED' })
    await expect(service.reject(staff(id.approver), {
      casePublicId, reason: '候选资料不足，驳回本次找回并保留完整审计',
      idempotencyKey: 'membership-recovery-reject-0002',
    })).resolves.toEqual({ casePublicId, status: 'rejected' })
    await expect(service.reject(staff(id.approver), {
      casePublicId, reason: '网络重试返回相同驳回结果',
      idempotencyKey: 'membership-recovery-reject-0002',
    })).resolves.toEqual({ casePublicId, status: 'rejected' })
    const rejected = await pool.query(`
      SELECT merge_case.status,challenge.status AS challenge_status,
        count(action.id)::integer AS action_count
      FROM mbox.membership_merge_cases merge_case
      JOIN mbox.membership_recovery_challenges challenge ON challenge.id=merge_case.challenge_id
      JOIN mbox.membership_merge_actions action ON action.merge_case_id=merge_case.id
      WHERE merge_case.public_id=$1 GROUP BY merge_case.status,challenge.status
    `, [casePublicId])
    expect(rejected.rows[0]).toEqual({ status: 'rejected', challenge_status: 'rejected', action_count: 3 })
  })
})

function publicContext(customerId: string) {
  return {
    scope: { tenantId: id.tenant, storeId: id.store }, customerId,
    actorRef: `customer:${customerId}`, businessDate: '2026-08-16',
  }
}

function staff(employeeId: string) {
  return {
    scope: { tenantId: id.tenant, storeId: id.store }, employeeId,
    businessDate: '2026-08-16',
  }
}

async function seed(pool: Pool): Promise<void> {
  await pool.query(`INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'Recovery tenant')`, [
    id.tenant, `recovery-${id.tenant.slice(0, 8)}`,
  ])
  await pool.query(`INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1,$2,$3,'Recovery store')`, [
    id.store, id.tenant, `recovery-${id.store.slice(0, 8)}`,
  ])
  await pool.query(`
    INSERT INTO mbox.roles(tenant_id,store_id,code,name) VALUES
      ($1,$2,'OWNER','老板'),($1,$2,'MANAGER','店长'),
      ($1,$2,'DEPUT_MANAGER','副店长'),($1,$2,'WAITER','服务员')
  `, [id.tenant, id.store])
  await pool.query(`
    INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES
      ($1,$4,$5,'RECOVERY_VERIFY','Recovery verifier'),
      ($2,$4,$5,'RECOVERY_APPROVE','Recovery approver'),
      ($3,$4,$5,'RECOVERY_SELECT','Recovery selector')
  `, [id.verifier, id.approver, id.selector, id.tenant, id.store])
  await pool.query(`
    INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id,starts_at)
    SELECT $1::uuid,$2::uuid,assignment.employee_id,role.id,clock_timestamp()
    FROM (VALUES
      ($3::uuid,'DEPUT_MANAGER'),($4::uuid,'MANAGER'),($5::uuid,'MANAGER')
    ) assignment(employee_id,role_code)
    JOIN mbox.roles role ON role.tenant_id=$1::uuid AND role.store_id=$2::uuid
      AND role.code=assignment.role_code
  `,[id.tenant,id.store,id.verifier,id.approver,id.selector])
  await pool.query(`
    INSERT INTO mbox.customers(id,tenant_id,store_id,public_id,status) VALUES
      ($1,$6,$7,'recovery-current-0001','active'),
      ($2,$6,$7,'recovery-current-0002','active'),
      ($3,$6,$7,'recovery-history-0001','active'),
      ($4,$6,$7,'recovery-history-0002','active'),
      ($5,$6,$7,'recovery-history-0003','active')
  `, [id.current, id.otherCurrent, id.source, id.secondSource, id.thirdSource, id.tenant, id.store])
  await pool.query(`
    INSERT INTO mbox.customer_memberships(
      id,tenant_id,store_id,customer_id,member_no,points_balance,lifetime_points
    ) VALUES
      ($1,$7,$8,$2,'MBXHISTORY0001',75,100),
      ($3,$7,$8,$4,'MBXHISTORY0002',25,25),
      ($5,$7,$8,$6,'MBXHISTORY0003',10,10)
  `, [
    id.sourceMembership, id.source, id.secondMembership, id.secondSource,
    id.thirdMembership, id.thirdSource, id.tenant, id.store,
  ])
  await pool.query(`
    INSERT INTO mbox.loyalty_accounts(
      id,tenant_id,store_id,membership_id,customer_id,available_points,growth_value
    ) VALUES
      ($1,$10,$11,$2,$3,75,100),
      ($4,$10,$11,$5,$6,25,25),
      ($7,$10,$11,$8,$9,10,10)
  `, [
    id.sourceAccount, id.sourceMembership, id.source,
    id.secondAccount, id.secondMembership, id.secondSource,
    id.thirdAccount, id.thirdMembership, id.thirdSource, id.tenant, id.store,
  ])
  await pool.query(`
    INSERT INTO mbox.loyalty_point_lots(
      id,tenant_id,store_id,membership_id,customer_id,source_type,source_id,
      original_points,remaining_points,available_at,status
    ) VALUES($1,$2,$3,$4,$5,'legacy_balance','legacy-recovery-lot',75,75,clock_timestamp(),'available')
  `, [id.sourceLot, id.tenant, id.store, id.sourceMembership, id.source])
  await pool.query(`
    INSERT INTO mbox.loyalty_point_ledger(
      id,tenant_id,store_id,membership_id,customer_id,entry_type,points_delta,
      balance_after,source_type,source_id,reason,idempotency_key
    ) VALUES($1,$2,$3,$4,$5,'earn',75,75,'manual','legacy-recovery-ledger',
      '历史会员积分迁移事实','legacy-recovery-ledger-0001')
  `, [id.sourceLedger, id.tenant, id.store, id.sourceMembership, id.source])
  await pool.query(`
    INSERT INTO mbox.benefits(
      id,tenant_id,store_id,customer_id,benefit_code,benefit_type,status,
      value_amount_minor,currency
    ) VALUES($1,$2,$3,$4,'RECOVERY_GIFT','credit','issued',500,'CNY')
  `, [id.sourceBenefit, id.tenant, id.store, id.source])
}
