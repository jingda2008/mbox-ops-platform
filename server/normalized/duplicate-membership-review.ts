import { createHash, randomUUID } from 'node:crypto'
import { appendAuditEvent } from './command-executor.js'
import { CustomerRepository } from './customer-repository.js'
import { ChannelDistributionRepository } from './channel-distribution-repository.js'
import {
  CustomerExperienceRepository,
  CustomerExperienceRequestError,
} from './customer-experience-repository.js'
import type { StaffCustomerExperienceContext } from './customer-experience-service.js'
import { lockMembershipPhone, revokeVerifiedContact } from './membership-recovery-service.js'
import { StaffAccessRepository } from './staff-access-repository.js'
import type { ActivityContactProtectionKeyring } from './personal-contact-protection.js'
import type { ScopedTransaction, ScopedPostgresTransactionRunner } from './transaction-runner.js'

type Context = StaffCustomerExperienceContext
type Member = {
  id: string
  customer: string
  number: string
  contact: string
  hash: string
  encrypted: Buffer
  key: string
  masked: string
  joined: Date
  verifier: string | null
}
type Review = {
  id: string
  sourceSuffix: string
  keeperSuffix: string
  maskedPhone: string
  requestedBy: string
  key: string
  reason: string
  stateHash: string
  status: 'pending' | 'approved' | 'rejected'
  decidedBy?: string
  decisionReason?: string
}
const verify = 'customer.membership.recovery.verify'
const approve = 'customer.membership.merge.approve'
const conflict = (message: string) =>
  new CustomerExperienceRequestError(message, 'DUPLICATE_MEMBERSHIP_REVIEW_CONFLICT', 409)
const args = (tx: ScopedTransaction) => [tx.scope.tenantId, tx.scope.storeId]
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

async function inspect(
  tx: ScopedTransaction,
  memberIds: readonly string[],
  keys: ActivityContactProtectionKeyring,
) {
  const sc = args(tx)
  const result = await tx.query<Member>(
    `
    SELECT m.id,m.customer_id AS customer,m.member_no AS number,m.joined_at AS joined,
      p.id AS contact,p.encrypted_value AS encrypted,p.contact_hash AS hash,p.contact_encryption_key_id AS key,
      p.masked_value AS masked,p.verified_by_employee_id AS verifier
    FROM mbox.customer_memberships m
    JOIN mbox.customers c ON (c.tenant_id,c.store_id,c.id)=(m.tenant_id,m.store_id,m.customer_id)
    JOIN mbox.customer_verified_contacts p ON (p.tenant_id,p.store_id,p.customer_id)=(m.tenant_id,m.store_id,m.customer_id)
    WHERE m.tenant_id=$1 AND m.store_id=$2 AND m.id=ANY($3::uuid[]) AND m.status='active'
      AND c.status='active' AND p.revoked_at IS NULL AND p.contact_type='phone' AND p.processing_status='active'
      AND NOT EXISTS (SELECT 1 FROM mbox.customers child WHERE child.tenant_id=$1 AND child.store_id=$2
        AND child.merged_into_customer_id=c.id)
    ORDER BY m.id
  `,
    [...sc, memberIds],
  )
  const source = result.rows.find((row) => row.id === memberIds[0]),
    keeper = result.rows.find((row) => row.id === memberIds[1])
  if (
    result.rows.length !== 2 ||
    !source ||
    !keeper ||
    source.customer === keeper.customer ||
    source.joined >= keeper.joined ||
    !result.rows.every((m) => m.number.startsWith('MBX-'))
  ) {
    throw conflict('两张卡的归属或开卡顺序已变化，请重新核对。')
  }
  if (!keys.revealPhone) throw conflict('当前无法核对手机号，请联系门店。')
  const phone = keys.revealPhone({
    encryptedValue: keeper.encrypted,
    contactHash: keeper.hash,
    encryptionKeyId: keeper.key,
  })
  const hashes = keys.protectPhone(phone).matchHashes
  if (!hashes.includes(source.hash)) throw conflict('两张会员卡的已验证手机号不同。')
  await lockMembershipPhone(tx, { matchHashes: hashes })
  const matched = await tx.query(
    `
    SELECT p.id FROM mbox.customer_verified_contacts p WHERE p.tenant_id=$1 AND p.store_id=$2
      AND p.contact_type='phone' AND p.revoked_at IS NULL AND p.processing_status='active'
      AND p.contact_hash=ANY($3::char(64)[]) ORDER BY p.id FOR UPDATE
  `,
    [...sc, hashes],
  )
  if (matched.rows.length !== 2) throw conflict('这个手机号还有其他绑定，请先核对归属。')
  const ids = [source.id, keeper.id],
    customers = [source.customer, keeper.customer]
  const accounts = await tx.query(
    `
    SELECT a.id FROM mbox.loyalty_accounts a JOIN mbox.customer_memberships m ON m.id=a.membership_id
    WHERE a.tenant_id=$1 AND a.store_id=$2 AND a.membership_id=ANY($3::uuid[])
      AND a.available_points=0 AND a.growth_value=0 AND a.pending_recovery_points=0
      AND a.current_tier='member' AND a.redemption_status='active'
      AND m.lifetime_points=0 AND m.points_balance=0 AND m.visit_count=0 AND m.lifetime_spend_amount_minor=0
    ORDER BY a.id FOR UPDATE OF a
  `,
    [...sc, ids],
  )
  if (accounts.rows.length !== 2) throw conflict('会员有积分、成长值、等级或消费累计，需要先核账。')
  const blocked = await tx.query(
    `
    SELECT EXISTS (
      SELECT 1 FROM mbox.loyalty_point_lots WHERE tenant_id=$1 AND store_id=$2 AND membership_id=ANY($3::uuid[])
      UNION ALL SELECT 1 FROM mbox.loyalty_growth_ledger WHERE tenant_id=$1 AND store_id=$2 AND membership_id=ANY($3::uuid[])
      UNION ALL SELECT 1 FROM mbox.loyalty_point_ledger WHERE tenant_id=$1 AND store_id=$2 AND membership_id=ANY($3::uuid[])
      UNION ALL SELECT 1 FROM mbox.checkout_point_holds WHERE tenant_id=$1 AND store_id=$2 AND membership_id=ANY($3::uuid[])
      UNION ALL SELECT 1 FROM mbox.loyalty_order_awards WHERE tenant_id=$1 AND store_id=$2 AND membership_id=ANY($3::uuid[])
      UNION ALL SELECT 1 FROM mbox.loyalty_reward_carry_balances WHERE tenant_id=$1 AND store_id=$2 AND membership_id=ANY($3::uuid[]) AND remainder_numerator<>0
      UNION ALL SELECT 1 FROM mbox.member_redemptions WHERE tenant_id=$1 AND store_id=$2 AND membership_id=ANY($3::uuid[])
      UNION ALL SELECT 1 FROM mbox.benefits WHERE tenant_id=$1 AND store_id=$2 AND customer_id=ANY($4::uuid[]) AND status IN ('issued','reserved')
      UNION ALL SELECT 1 FROM mbox.table_ticket_purchases WHERE tenant_id=$1 AND store_id=$2 AND membership_id=ANY($3::uuid[])
      UNION ALL SELECT 1 FROM mbox.member_card_applications WHERE tenant_id=$1 AND store_id=$2 AND customer_id=ANY($4::uuid[])
      UNION ALL SELECT 1 FROM mbox.bottle_custody_orders WHERE tenant_id=$1 AND store_id=$2 AND customer_id=ANY($4::uuid[])
      UNION ALL SELECT 1 FROM mbox.orders WHERE tenant_id=$1 AND store_id=$2 AND created_by_customer_id=ANY($4::uuid[])
        AND status NOT IN ('draft','cancelled')
      UNION ALL SELECT 1 FROM mbox.community_activity_registrations r JOIN mbox.community_activities e ON e.id=r.activity_id
        WHERE r.tenant_id=$1 AND r.store_id=$2 AND r.customer_id=ANY($4::uuid[])
          AND (r.payment_status='pending' OR (e.ends_at>=clock_timestamp() AND r.status NOT IN ('cancelled','refunded')))
    ) AS blocked
  `,
    [...sc, ids, customers],
  )
  if (blocked.rows[0]?.blocked) throw conflict('两户还有需要单独核算的业务，本次未并户。')
  const identities = (
    await tx.query<{ customer_id: string; identity_kind: string; identity_hash: string }>(
      `
    SELECT customer_id,identity_kind,identity_hash FROM mbox.customer_identities WHERE tenant_id=$1 AND store_id=$2
      AND customer_id=ANY($3::uuid[]) AND status='active' ORDER BY id FOR UPDATE
  `,
      [...sc, customers],
    )
  ).rows
  const wechat = identities.filter((i) => i.identity_kind === 'wechat')
  if (
    wechat.length !== 1 ||
    wechat[0]!.customer_id !== source.customer ||
    identities.some((i) => !['wechat', 'anonymous'].includes(i.identity_kind))
  )
    throw conflict('微信绑定情况需要另外核对。')
  const claims = (
    await tx.query<{ id: string; customer_id: string; status: string }>(
      `
    SELECT id,customer_id,status FROM mbox.channel_claims WHERE tenant_id=$1 AND store_id=$2
      AND customer_id=ANY($3::uuid[]) AND NOT voided ORDER BY id FOR UPDATE
  `,
      [...sc, customers],
    )
  ).rows
  if (
    claims.length !== 1 ||
    claims[0]!.customer_id !== source.customer ||
    claims[0]!.status !== 'available'
  ) {
    throw conflict('请核对旧号的可用推广券，本次仅支持保留原有一张券的情况。')
  }
  const stateHash = digest([ids, customers, source.contact, keeper.contact, identities, claims])
  return { source, keeper, stateHash, claimId: claims[0]!.id, wechatHash: wechat[0]!.identity_hash }
}

const objectType = 'duplicate_membership_review'

export class DuplicateMembershipReviews {
  private readonly caseKey: string
  constructor(
    private readonly transactions: Pick<ScopedPostgresTransactionRunner, 'run'>,
    private readonly keys: ActivityContactProtectionKeyring,
    private readonly pair: readonly [string, string] | readonly [],
  ) {
    this.caseKey = digest(pair)
  }

  private async latest(tx: ScopedTransaction): Promise<Review | undefined> {
    return (
      await tx.query<{ record: Review }>(
        `
      SELECT after_snapshot AS record FROM mbox.audit_events
      WHERE tenant_id=$1 AND store_id=$2 AND object_type=$3 AND object_id=$4
      ORDER BY occurred_at DESC,id DESC LIMIT 1
    `,
        [...args(tx), objectType, this.caseKey],
      )
    ).rows[0]?.record
  }

  private async lock(tx: ScopedTransaction) {
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [objectType + ':' + this.caseKey])
  }

  async list(ctx: Context) {
    if (!this.pair.length) return null
    return this.transactions.run(
      ctx.scope,
      async (tx) => {
        const row = await this.latest(tx)
        if (row) {
          const { id, sourceSuffix, keeperSuffix, maskedPhone, reason, requestedBy, status } = row
          return { id, sourceSuffix, keeperSuffix, maskedPhone, reason, requestedBy, status }
        }
        const cards = (
          await tx.query<{ id: string; suffix: string }>(
            `
        SELECT id,right(member_no,4) AS suffix FROM mbox.customer_memberships
        WHERE tenant_id=$1 AND store_id=$2 AND status='active' AND id=ANY($3::uuid[])
      `,
            [...args(tx), this.pair],
          )
        ).rows
        if (cards.length !== 2) return null
        return {
          status: 'new',
          sourceSuffix: cards.find((c) => c.id === this.pair[0])!.suffix,
          keeperSuffix: cards.find((c) => c.id === this.pair[1])!.suffix,
        }
      },
      { readOnly: true },
    )
  }

  request(ctx: Context, reason: string, key: string) {
    return this.transactions.run(
      ctx.scope,
      async (tx) => {
        await new StaffAccessRepository(tx).assertPermission(ctx.employeeId, verify)
        if (!this.pair.length) throw conflict('当前没有指定的并户个案。')
        await this.lock(tx)
        const last = await this.latest(tx)
        if (last?.key === key) {
          if (last.requestedBy !== ctx.employeeId || last.reason !== reason)
            throw conflict('这次提交与原申请不同，请刷新。')
          return { id: last.id }
        }
        if (last && last.status !== 'rejected') throw conflict('已有并户记录，请刷新后查看。')
        const { source, keeper, stateHash } = await inspect(tx, this.pair, this.keys)
        const row: Review = {
          id: randomUUID(),
          sourceSuffix: source.number.slice(-4),
          keeperSuffix: keeper.number.slice(-4),
          maskedPhone: keeper.masked,
          requestedBy: ctx.employeeId,
          key,
          reason,
          stateHash,
          status: 'pending',
        }
        await appendAuditEvent(tx, {
          actor: { type: 'employee', employeeId: ctx.employeeId },
          action: 'membership.duplicate_requested',
          objectType,
          objectId: this.caseKey,
          businessDate: ctx.businessDate,
          reason,
          afterData: { ...row },
        })
        return { id: row.id }
      },
      { isolation: 'serializable', retryOnConflict: 2 },
    )
  }

  decide(ctx: Context, id: string, accept: boolean, reason: string) {
    return this.transactions.run(
      ctx.scope,
      async (tx) => {
        const access = new StaffAccessRepository(tx)
        await access.assertPermission(ctx.employeeId, approve)
        await this.lock(tx)
        const r = await this.latest(tx),
          status = accept ? 'approved' : 'rejected'
        if (!r || r.id !== id) throw conflict('没有找到本次并户申请。')
        if (ctx.employeeId === r.requestedBy) throw conflict('请由另一位有会员合并审批权限的员工复核。')
        if (r.status !== 'pending') {
          if (r.status === status && r.decidedBy === ctx.employeeId && r.decisionReason === reason)
            return { status }
          throw conflict('申请已经处理，请刷新。')
        }
        if (accept) {
          const { source, keeper, stateHash, claimId, wechatHash } = await inspect(tx, this.pair, this.keys)
          if (r.stateHash !== stateHash) throw conflict('会员资料或券已变化，请驳回后重新核对。')
          if ([source.verifier, keeper.verifier].includes(ctx.employeeId))
            throw conflict('手机号核验人不能复核这次并户。')
          await access.assertPermission(ctx.employeeId, verify)
          await revokeVerifiedContact(tx, source.contact, {
            customerId: null,
            employeeId: ctx.employeeId,
            reasonCode: 'duplicate_membership_approved',
            reasonDetail: reason,
            idempotencyKey: id,
            action: 'superseded',
          })
          const closed = await tx.query(
            `UPDATE mbox.customer_memberships SET status='closed',updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND status='active' RETURNING id`,
            [...args(tx), source.id],
          )
          if (closed.rowCount !== 1) throw conflict('旧号状态已经变化。')
          const customers = new CustomerRepository(tx)
          await customers.merge(source.customer, keeper.customer)
          const owner = await customers.findByIdentity('wechat', wechatHash)
          const active = await new CustomerExperienceRepository(tx).findMembership(keeper.customer)
          const wallet = await new ChannelDistributionRepository(tx).wallet(keeper.customer)
          if (
            owner?.id !== keeper.customer ||
            active?.id !== keeper.id ||
            !wallet.some((c) => c.id === claimId && c.status === 'available')
          )
            throw conflict('原微信、会员号或券包核对未通过，已撤销本次修改。')
        }
        await appendAuditEvent(tx, {
          actor: { type: 'employee', employeeId: ctx.employeeId },
          action: 'membership.duplicate_' + status,
          objectType,
          objectId: this.caseKey,
          businessDate: ctx.businessDate,
          reason,
          afterData: { ...r, status, decidedBy: ctx.employeeId, decisionReason: reason },
        })
        return { status }
      },
      { isolation: 'serializable', retryOnConflict: 2 },
    )
  }
}
