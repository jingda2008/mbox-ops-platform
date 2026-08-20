import { createHash } from 'node:crypto'
import type { ScopedTransaction } from './transaction-runner.js'

type Tier = 'member' | 'silver' | 'gold'
type TierEventType = 'upgraded' | 'retained' | 'grace_started' | 'downgraded' | 'corrected'

interface TierEventContext extends Record<string, unknown> {
  id: string
  membership_id: string
  customer_id: string
  tier_policy_version_id: string
  event_type: TierEventType
  from_tier: Tier
  to_tier: Tier
  occurred_at: string
  current_tier: Tier
}

interface ExistingGrantRow extends Record<string, unknown> {
  id: string
  tier_event_id: string
  status: 'active' | 'revocation_pending'
  benefit_id: string
  benefit_status: 'issued' | 'reserved' | 'redeemed' | 'expired' | 'revoked'
  quantity_total: number
  quantity_reserved: number
  quantity_redeemed: number
  expires_at: string
  eligible_tier: Tier
  inherit_to_higher_tiers: boolean
  revocation_policy: 'revoke_unreserved' | 'protect_until_expiry'
}

interface BenefitRuleRow extends Record<string, unknown> {
  id: string
  policy_version_id: string
  rule_code: string
  eligible_tier: Tier
  benefit_definition_id: string
  quantity: number
  validity_days: number
  product_id: string | null
}

export interface LoyaltyTierBenefitReconciliation {
  granted: number
  revocationPending: number
  reactivated: number
  revoked: number
  fulfilled: number
  expired: number
}

const EMPTY_RESULT: LoyaltyTierBenefitReconciliation = Object.freeze({
  granted: 0,
  revocationPending: 0,
  reactivated: 0,
  revoked: 0,
  fulfilled: 0,
  expired: 0,
})

const TIER_RANK: Readonly<Record<Tier, number>> = Object.freeze({ member: 0, silver: 1, gold: 2 })

export class LoyaltyTierBenefitRepository {
  constructor(private readonly transaction: ScopedTransaction) {}

  async reconcileTierEvent(tierEventId: string): Promise<LoyaltyTierBenefitReconciliation> {
    const scope = this.transaction.scope
    await this.transaction.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`loyalty-tier-benefit:${scope.tenantId}:${scope.storeId}:${tierEventId}`],
    )
    const selected = await this.transaction.query<TierEventContext>(`
      SELECT tier_event.id,tier_event.membership_id,membership.customer_id,
        tier_event.policy_version_id AS tier_policy_version_id,tier_event.event_type,
        tier_event.from_tier,tier_event.to_tier,tier_event.occurred_at::text,
        account.current_tier
      FROM mbox.membership_tier_events tier_event
      JOIN mbox.customer_memberships membership
        ON membership.tenant_id=tier_event.tenant_id AND membership.store_id=tier_event.store_id
       AND membership.id=tier_event.membership_id
      JOIN mbox.loyalty_accounts account
        ON account.tenant_id=membership.tenant_id AND account.store_id=membership.store_id
       AND account.membership_id=membership.id AND account.customer_id=membership.customer_id
      WHERE tier_event.tenant_id=$1::uuid AND tier_event.store_id=$2::uuid
        AND tier_event.id=$3::uuid
      FOR UPDATE OF membership,account
    `, [scope.tenantId, scope.storeId, tierEventId])
    const event = selected.rows[0]
    if (!event || event.current_tier !== event.to_tier) return EMPTY_RESULT

    const result: LoyaltyTierBenefitReconciliation = { ...EMPTY_RESULT }
    await this.reconcileExisting(event, result)
    if (event.event_type === 'grace_started') return result
    if (event.event_type === 'corrected' && event.from_tier === event.to_tier) return result

    const cadenceColumn = event.event_type === 'retained' ? 'grant_on_retention' : 'grant_on_entry'
    const rules = await this.transaction.query<BenefitRuleRow>(`
      SELECT rule.id,policy.id AS policy_version_id,rule.rule_code,rule.eligible_tier,
        rule.benefit_definition_id,rule.quantity,rule.validity_days,
        definition.product_id
      FROM mbox.loyalty_tier_benefit_policy_versions policy
      JOIN mbox.loyalty_tier_benefit_rules rule
        ON rule.tenant_id=policy.tenant_id AND rule.store_id=policy.store_id
       AND rule.policy_version_id=policy.id AND rule.enabled
      JOIN mbox.loyalty_benefit_definitions definition
        ON definition.tenant_id=rule.tenant_id AND definition.store_id=rule.store_id
       AND definition.id=rule.benefit_definition_id AND definition.status='active'
      WHERE policy.tenant_id=$1::uuid AND policy.store_id=$2::uuid
        AND policy.tier_policy_version_id=$3::uuid AND policy.status='published'
        AND policy.approved_at<=$4::timestamptz
        AND policy.effective_from<=$4::timestamptz
        AND (policy.effective_until IS NULL OR policy.effective_until>$4::timestamptz)
        AND rule.${cadenceColumn}
        AND (rule.eligible_tier=$5 OR (
          rule.inherit_to_higher_tiers AND
          CASE rule.eligible_tier WHEN 'member' THEN 0 WHEN 'silver' THEN 1 ELSE 2 END
            < CASE $5 WHEN 'member' THEN 0 WHEN 'silver' THEN 1 ELSE 2 END
        ))
      ORDER BY policy.version DESC,policy.id DESC,rule.rule_code,rule.id
      FOR SHARE OF policy,rule,definition
    `, [scope.tenantId, scope.storeId, event.tier_policy_version_id, event.occurred_at, event.to_tier])
    for (const rule of rules.rows) {
      const created = await this.issue(event, rule)
      if (created) result.granted += 1
    }
    return result
  }

  async expireDue(at: string, limit = 100): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new TypeError('limit is invalid')
    const scope = this.transaction.scope
    const expired = await this.transaction.query<{ id: string }>(`
      WITH due AS (
        SELECT benefit.id
        FROM mbox.membership_tier_benefit_grants grant_row
        JOIN mbox.benefits benefit
          ON benefit.tenant_id=grant_row.tenant_id AND benefit.store_id=grant_row.store_id
         AND benefit.id=grant_row.benefit_id
        WHERE grant_row.tenant_id=$1::uuid AND grant_row.store_id=$2::uuid
          AND grant_row.status IN ('active','revocation_pending')
          AND grant_row.expires_at<=$3::timestamptz
          AND benefit.status='issued' AND benefit.quantity_reserved=0
        ORDER BY grant_row.expires_at,grant_row.id
        FOR UPDATE OF benefit SKIP LOCKED LIMIT $4
      )
      UPDATE mbox.benefits benefit SET status='expired',aggregate_version=aggregate_version+1
      FROM due
      WHERE benefit.tenant_id=$1::uuid AND benefit.store_id=$2::uuid AND benefit.id=due.id
      RETURNING benefit.id
    `, [scope.tenantId, scope.storeId, at, limit])
    return expired.rowCount ?? expired.rows.length
  }

  async expireMembershipDue(membershipId: string, at: string): Promise<number> {
    const scope = this.transaction.scope
    const expired = await this.transaction.query<{ id: string }>(`
      UPDATE mbox.benefits benefit SET status='expired',aggregate_version=aggregate_version+1
      FROM mbox.membership_tier_benefit_grants grant_row
      WHERE grant_row.tenant_id=$1::uuid AND grant_row.store_id=$2::uuid
        AND grant_row.membership_id=$3::uuid
        AND grant_row.status IN ('active','revocation_pending')
        AND grant_row.expires_at<=$4::timestamptz
        AND benefit.tenant_id=grant_row.tenant_id AND benefit.store_id=grant_row.store_id
        AND benefit.id=grant_row.benefit_id AND benefit.status='issued'
        AND benefit.quantity_reserved=0
      RETURNING benefit.id
    `, [scope.tenantId, scope.storeId, membershipId, at])
    return expired.rowCount ?? expired.rows.length
  }

  private async reconcileExisting(
    event: TierEventContext,
    result: LoyaltyTierBenefitReconciliation,
  ): Promise<void> {
    const scope = this.transaction.scope
    result.expired += await this.expireMembershipDue(event.membership_id, event.occurred_at)

    const grants = await this.transaction.query<ExistingGrantRow>(`
      SELECT grant_row.id,grant_row.tier_event_id,grant_row.status,grant_row.benefit_id,
        benefit.status AS benefit_status,benefit.quantity_total,benefit.quantity_reserved,
        benefit.quantity_redeemed,grant_row.expires_at::text,
        rule.eligible_tier,rule.inherit_to_higher_tiers,rule.revocation_policy
      FROM mbox.membership_tier_benefit_grants grant_row
      JOIN mbox.loyalty_tier_benefit_rules rule
        ON rule.tenant_id=grant_row.tenant_id AND rule.store_id=grant_row.store_id
       AND rule.id=grant_row.rule_id
      JOIN mbox.benefits benefit
        ON benefit.tenant_id=grant_row.tenant_id AND benefit.store_id=grant_row.store_id
       AND benefit.id=grant_row.benefit_id
      WHERE grant_row.tenant_id=$1::uuid AND grant_row.store_id=$2::uuid
        AND grant_row.membership_id=$3::uuid
        AND grant_row.status IN ('active','revocation_pending')
      ORDER BY grant_row.created_at,grant_row.id
      FOR UPDATE OF grant_row,benefit
    `, [scope.tenantId, scope.storeId, event.membership_id])
    for (const grant of grants.rows) {
      const eligible = grant.eligible_tier === event.to_tier
        || (grant.inherit_to_higher_tiers && TIER_RANK[event.to_tier] > TIER_RANK[grant.eligible_tier])
      if (eligible) {
        if (grant.status === 'revocation_pending') {
          await this.setGrantState(grant, 'active', 'revocation_cancelled', event,
            '当前等级再次满足已发布权益规则')
          result.reactivated += 1
        }
        continue
      }
      if (grant.revocation_policy === 'protect_until_expiry') continue
      if (grant.benefit_status === 'redeemed' || grant.quantity_redeemed >= grant.quantity_total) {
        await this.setGrantState(grant, 'fulfilled', 'fulfilled', event,
          '权益已履约，降级不删除已履约事实')
        result.fulfilled += 1
      } else if (grant.benefit_status === 'reserved' || grant.quantity_reserved > 0) {
        if (grant.status !== 'revocation_pending') {
          await this.setGrantState(grant, 'revocation_pending', 'revocation_pending', event,
            '权益已预留；履约完成或预留释放后再按规则解决')
          result.revocationPending += 1
        }
      } else if (grant.benefit_status === 'issued') {
        const revoked = await this.transaction.query(`
          UPDATE mbox.benefits SET status='revoked',aggregate_version=aggregate_version+1
          WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
            AND status='issued' AND quantity_reserved=0
        `, [scope.tenantId, scope.storeId, grant.benefit_id])
        if (revoked.rowCount === 1) {
          if (grant.quantity_redeemed > 0) result.fulfilled += 1
          else result.revoked += 1
        }
      }
    }
  }

  private async setGrantState(
    grant: ExistingGrantRow,
    toStatus: 'active' | 'revocation_pending' | 'fulfilled',
    eventType: 'revocation_cancelled' | 'revocation_pending' | 'fulfilled',
    event: TierEventContext,
    reason: string,
  ): Promise<void> {
    const scope = this.transaction.scope
    const resolved = toStatus === 'fulfilled'
    const updated = await this.transaction.query(`
      UPDATE mbox.membership_tier_benefit_grants
      SET status=$4,resolution_reason=$5,
        resolved_at=CASE WHEN $6 THEN $7::timestamptz ELSE NULL END
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
        AND status=$8
    `, [
      scope.tenantId, scope.storeId, grant.id, toStatus,
      toStatus === 'active' ? null : reason, resolved, event.occurred_at, grant.status,
    ])
    if (updated.rowCount !== 1) return
    await this.transaction.query(`
      INSERT INTO mbox.membership_tier_benefit_events(
        tenant_id,store_id,grant_id,tier_event_id,event_type,from_status,to_status,
        reason,idempotency_key,occurred_at
      ) VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7,$8,$9,$10::timestamptz)
      ON CONFLICT (tenant_id,store_id,grant_id,idempotency_key) DO NOTHING
    `, [
      scope.tenantId, scope.storeId, grant.id, event.id, eventType,
      grant.status, toStatus, reason, `tier-event:${event.id}:${eventType}:${grant.id}`, event.occurred_at,
    ])
  }

  private async issue(event: TierEventContext, rule: BenefitRuleRow): Promise<boolean> {
    const scope = this.transaction.scope
    const idempotencyKey = `tier-benefit:${event.id}:${rule.id}`
    const fingerprint = createHash('sha256').update([
      event.membership_id,event.customer_id,event.id,event.to_tier,
      rule.policy_version_id,rule.id,rule.benefit_definition_id,
      rule.quantity,rule.validity_days,
    ].join('|')).digest('hex')
    const replay = await this.transaction.query<{
      issuance_fingerprint: string
      grant_id: string | null
    }>(`
      SELECT benefit.issuance_fingerprint,grant_row.id AS grant_id
      FROM mbox.benefits benefit
      LEFT JOIN mbox.membership_tier_benefit_grants grant_row
        ON grant_row.tenant_id=benefit.tenant_id AND grant_row.store_id=benefit.store_id
       AND grant_row.benefit_id=benefit.id
      WHERE benefit.tenant_id=$1::uuid AND benefit.store_id=$2::uuid
        AND benefit.issuance_idempotency_key=$3
      FOR UPDATE OF benefit
    `, [scope.tenantId, scope.storeId, idempotencyKey])
    if (replay.rows[0]) {
      if (replay.rows[0].issuance_fingerprint !== fingerprint || replay.rows[0].grant_id === null) {
        throw new Error('Tier benefit issuance idempotency conflict')
      }
      return false
    }
    const inserted = await this.transaction.query<{ id: string; valid_from: string; valid_until: string }>(`
      INSERT INTO mbox.benefits(
        tenant_id,store_id,customer_id,benefit_code,benefit_type,status,
        benefit_snapshot,quantity_total,valid_from,valid_until,issuance_reason,
        authorization_source,issuance_idempotency_key,issuance_fingerprint,
        benefit_definition_id,benefit_kind
      ) SELECT $1::uuid,$2::uuid,$3::uuid,definition.benefit_code,
        CASE definition.benefit_kind
          WHEN 'gift_product' THEN 'gift_product'
          WHEN 'activity_access' THEN 'access'
          ELSE 'other' END,
        'issued',definition.display_snapshot,$5,$6::timestamptz,
        $6::timestamptz + make_interval(days=>$7),
        '已发布会员等级权益自动发放','{}'::jsonb,$8,$9,
        definition.id,definition.benefit_kind
      FROM mbox.loyalty_benefit_definitions definition
      WHERE definition.tenant_id=$1::uuid AND definition.store_id=$2::uuid
        AND definition.id=$4::uuid AND definition.status='active'
      RETURNING id,valid_from::text,valid_until::text
    `, [
      scope.tenantId, scope.storeId, event.customer_id, rule.benefit_definition_id,
      rule.quantity, event.occurred_at, rule.validity_days, idempotencyKey, fingerprint,
    ])
    const benefit = inserted.rows[0]
    if (!benefit) throw new Error('Tier benefit definition became unavailable')
    if (rule.product_id) {
      const scoped = await this.transaction.query(`
        INSERT INTO mbox.benefit_allowed_products(tenant_id,store_id,benefit_id,product_id)
        VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid) ON CONFLICT DO NOTHING
      `, [scope.tenantId, scope.storeId, benefit.id, rule.product_id])
      if (scoped.rowCount !== 1) throw new Error('Tier benefit product scope was not created')
    }
    const grant = await this.transaction.query<{ id: string }>(`
      INSERT INTO mbox.membership_tier_benefit_grants(
        tenant_id,store_id,membership_id,customer_id,tier_event_id,policy_version_id,
        rule_id,benefit_id,granted_tier,status,granted_at,expires_at
      ) VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7::uuid,$8::uuid,
        $9,'active',$10::timestamptz,$11::timestamptz)
      ON CONFLICT (tenant_id,store_id,membership_id,tier_event_id,rule_id) DO NOTHING
      RETURNING id
    `, [
      scope.tenantId, scope.storeId, event.membership_id, event.customer_id,
      event.id, rule.policy_version_id, rule.id, benefit.id, event.to_tier,
      benefit.valid_from, benefit.valid_until,
    ])
    const grantId = grant.rows[0]?.id
    if (!grantId) throw new Error('Tier benefit grant was not created for a new benefit')
    await this.transaction.query(`
      INSERT INTO mbox.membership_tier_benefit_events(
        tenant_id,store_id,grant_id,tier_event_id,event_type,from_status,to_status,
        reason,idempotency_key,occurred_at
      ) VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,'granted',NULL,'active',
        '已发布等级权益规则自动发放',$5,$6::timestamptz)
      ON CONFLICT (tenant_id,store_id,grant_id,idempotency_key) DO NOTHING
    `, [scope.tenantId, scope.storeId, grantId, event.id, `tier-event:${event.id}:granted:${rule.id}`, event.occurred_at])
    return true
  }
}
