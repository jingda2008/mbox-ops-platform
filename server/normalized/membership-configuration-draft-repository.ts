import {
  MembershipConfigurationDraftError,
  type MembershipConfigurationContent,
  type MembershipConfigurationDomain,
  type MembershipConfigurationDraftRecord,
  type MembershipConfigurationDraftRepository,
  type MembershipConfigurationDraftSession,
  type MembershipConfigurationImpactPreview,
  type MembershipImpactSnapshot,
  type MembershipTier,
} from './membership-configuration-draft-service.js'
import type {
  ScopedPostgresTransactionRunner,
  ScopedTransaction,
  StoreScope,
} from './transaction-runner.js'

type Runner = Pick<ScopedPostgresTransactionRunner, 'run'>

export class PostgresMembershipConfigurationDraftRepository
implements MembershipConfigurationDraftRepository {
  constructor(private readonly transactions: Runner, private readonly scope: Readonly<StoreScope>) {}

  runExclusive<T>(
    domain: MembershipConfigurationDomain,
    publicId: string,
    work: (session: MembershipConfigurationDraftSession) => Promise<T>,
  ): Promise<T> {
    return this.transactions.run(this.scope, async (transaction) => {
      await transaction.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `membership-configuration:${transaction.scope.tenantId}:${transaction.scope.storeId}:${domain}:${publicId}`,
      ])
      return work(new PostgresMembershipConfigurationDraftSession(transaction, domain))
    }, { isolation: 'serializable', retryOnConflict: 2 })
  }
}

class PostgresMembershipConfigurationDraftSession implements MembershipConfigurationDraftSession {
  constructor(
    private readonly transaction: ScopedTransaction,
    private readonly domain: MembershipConfigurationDomain,
  ) {}

  async loadDraft(publicId: string): Promise<MembershipConfigurationDraftRecord | null> {
    const id = configurationId(publicId)
    const contributors = await this.transaction.query<{ employee_id: string }>(`
      SELECT employee_id FROM mbox.membership_configuration_draft_contributors
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND configuration_domain=$3
        AND configuration_id=$4::uuid ORDER BY first_contributed_at,employee_id
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, this.domain, id])
    const makerEmployeeIds = contributors.rows.map((row) => row.employee_id)
    if (this.domain === 'base_points') {
      const row = (await this.transaction.query<BasePointsRow>(`
        SELECT id,status,draft_revision,updated_at::text,points_numerator,points_denominator_minor,
          growth_numerator,growth_denominator_minor,rounding_mode,points_validity_months
        FROM mbox.loyalty_policy_versions
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid FOR UPDATE
      `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, id])).rows[0]
      return row ? record(row, 'base_points', makerEmployeeIds, {
        domain: 'base_points', pointsNumerator: row.points_numerator,
        pointsDenominatorMinor: row.points_denominator_minor,
        growthNumerator: row.growth_numerator, growthDenominatorMinor: row.growth_denominator_minor,
        roundingMode: row.rounding_mode, pointsValidityMonths: row.points_validity_months,
      }) : null
    }
    if (this.domain === 'tier_policy') {
      const row = (await this.transaction.query<TierPolicyRow>(`
        SELECT id,status,draft_revision,updated_at::text,evaluation_window_months,tier_period_months,
          downgrade_grace_days,silver_upgrade_growth,silver_retain_growth,gold_upgrade_growth,
          gold_retain_growth,silver_points_multiplier_numerator,silver_points_multiplier_denominator,
          gold_points_multiplier_numerator,gold_points_multiplier_denominator
        FROM mbox.loyalty_tier_policy_versions
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid FOR UPDATE
      `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, id])).rows[0]
      return row ? record(row, 'tier_policy', makerEmployeeIds, {
        domain: 'tier_policy', evaluationWindowMonths: row.evaluation_window_months,
        tierPeriodMonths: row.tier_period_months, downgradeGraceDays: row.downgrade_grace_days,
        silverUpgradeGrowth: row.silver_upgrade_growth, silverRetainGrowth: row.silver_retain_growth,
        goldUpgradeGrowth: row.gold_upgrade_growth, goldRetainGrowth: row.gold_retain_growth,
        silverPointsMultiplierNumerator: row.silver_points_multiplier_numerator,
        silverPointsMultiplierDenominator: row.silver_points_multiplier_denominator,
        goldPointsMultiplierNumerator: row.gold_points_multiplier_numerator,
        goldPointsMultiplierDenominator: row.gold_points_multiplier_denominator,
      }) : null
    }
    if (this.domain === 'tier_benefits') return this.loadTierBenefits(id, makerEmployeeIds)
    if (this.domain === 'redemption_catalog') return this.loadRedemptionCatalog(id, makerEmployeeIds)
    if (this.domain === 'promotion_points') return this.loadPromotionPolicy(id, makerEmployeeIds)
    if (this.domain === 'membership_terms') {
      const row = (await this.transaction.query<MembershipTermsRow>(`
        SELECT id,status,draft_revision,updated_at::text,title,summary,content
        FROM mbox.membership_terms_versions
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid FOR UPDATE
      `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, id])).rows[0]
      return row ? record(row, 'membership_terms', makerEmployeeIds, {
        domain: 'membership_terms', title: row.title, summary: row.summary, content: row.content,
      }) : null
    }
    return this.loadNotification(id, makerEmployeeIds)
  }

  async replaceDraft(input: Readonly<{
    publicId: string
    expectedRevision: number
    nextRevision: number
    content: MembershipConfigurationContent
    makerEmployeeIds: readonly string[]
    reason: string
    employeeId: string
  }>): Promise<MembershipConfigurationDraftRecord> {
    const id = configurationId(input.publicId)
    await this.transaction.query(`
      INSERT INTO mbox.membership_configuration_draft_contributors(
        tenant_id,store_id,configuration_domain,configuration_id,employee_id,
        first_revision,last_revision,contribution_reason
      ) VALUES($1::uuid,$2::uuid,$3,$4::uuid,$5::uuid,$6,$6,$7)
      ON CONFLICT (tenant_id,store_id,configuration_domain,configuration_id,employee_id)
      DO UPDATE SET last_revision=GREATEST(
        mbox.membership_configuration_draft_contributors.last_revision,EXCLUDED.last_revision
      ),contribution_reason=EXCLUDED.contribution_reason,last_contributed_at=clock_timestamp()
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, this.domain,
      id, input.employeeId, input.nextRevision, input.reason])
    await this.replaceTypedContent(id, input)
    const updated = await this.loadDraft(id)
    if (!updated || updated.revision !== input.nextRevision) throw stale()
    return updated
  }

  async loadImpactSnapshot(content: MembershipConfigurationContent): Promise<MembershipImpactSnapshot> {
    const scope = [this.transaction.scope.tenantId, this.transaction.scope.storeId]
    const common = (await this.transaction.query<ImpactCommonRow>(`
      SELECT
        count(*) FILTER (WHERE membership.status='active')::integer AS active_members,
        count(*) FILTER (WHERE membership.status='active' AND account.current_tier='member')::integer AS member_count,
        count(*) FILTER (WHERE membership.status='active' AND account.current_tier='silver')::integer AS silver_count,
        count(*) FILTER (WHERE membership.status='active' AND account.current_tier='gold')::integer AS gold_count,
        COALESCE(sum(account.available_points) FILTER (WHERE membership.status='active'),0)::bigint AS points_liability,
        GREATEST(
          COALESCE(max(account.updated_at),'2000-01-01'::timestamptz),
          COALESCE((SELECT max(payment.updated_at) FROM mbox.payments payment
            WHERE payment.tenant_id=$1::uuid AND payment.store_id=$2::uuid),'2000-01-01'::timestamptz),
          COALESCE((SELECT max(redemption.updated_at) FROM mbox.member_redemptions redemption
            WHERE redemption.tenant_id=$1::uuid AND redemption.store_id=$2::uuid),'2000-01-01'::timestamptz)
        )::text AS measured_at,
        COALESCE((SELECT sum(payment.amount_minor) FROM mbox.payments payment
          WHERE payment.tenant_id=$1::uuid AND payment.store_id=$2::uuid
            AND payment.status IN ('succeeded','partially_refunded','refunded')
            AND payment.succeeded_at>=clock_timestamp()-interval '30 days'),0)::bigint AS eligible_paid_minor,
        COALESCE((SELECT max((item.cost_amount_minor*1000000)/item.points_required)::bigint
          FROM mbox.redemption_catalog_items item JOIN mbox.redemption_catalog_versions catalog
            ON catalog.tenant_id=item.tenant_id AND catalog.store_id=item.store_id
           AND catalog.id=item.catalog_version_id
          WHERE item.tenant_id=$1::uuid AND item.store_id=$2::uuid
            AND item.status='active' AND catalog.status='published'),0)::bigint AS point_cost_micros,
        (SELECT count(*)::integer FROM mbox.membership_terms_acceptances acceptance
          WHERE acceptance.tenant_id=$1::uuid AND acceptance.store_id=$2::uuid) AS terms_acceptances
      FROM mbox.loyalty_accounts account
      JOIN mbox.customer_memberships membership
        ON membership.tenant_id=account.tenant_id AND membership.store_id=account.store_id
       AND membership.id=account.membership_id
      WHERE account.tenant_id=$1::uuid AND account.store_id=$2::uuid
    `, scope)).rows[0] ?? emptyCommon()
    const growth = await this.transaction.query<GrowthRow>(`
      SELECT account.current_tier,account.growth_value,
        count(*)::integer AS members,
        COALESCE(sum(points.eligible_base_points),0)::bigint AS eligible_base_points
      FROM mbox.loyalty_accounts account
      JOIN mbox.customer_memberships membership
        ON membership.tenant_id=account.tenant_id AND membership.store_id=account.store_id
       AND membership.id=account.membership_id AND membership.status='active'
      LEFT JOIN LATERAL (
        SELECT COALESCE(sum(ledger.points_delta) FILTER (WHERE ledger.points_delta>0),0)::bigint AS eligible_base_points
        FROM mbox.loyalty_point_ledger ledger
        WHERE ledger.tenant_id=account.tenant_id AND ledger.store_id=account.store_id
          AND ledger.membership_id=account.membership_id
          AND ledger.occurred_at>=clock_timestamp()-interval '30 days'
      ) points ON true
      WHERE account.tenant_id=$1::uuid AND account.store_id=$2::uuid
      GROUP BY account.current_tier,account.growth_value
      ORDER BY account.current_tier,account.growth_value
    `, scope)
    const events = await this.transaction.query<TierEventRow>(`
      SELECT to_tier,
        count(*) FILTER (WHERE event_type='upgraded')::integer AS entries,
        count(*) FILTER (WHERE event_type='retained')::integer AS retentions
      FROM mbox.membership_tier_events
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid
        AND occurred_at>=clock_timestamp()-interval '90 days'
      GROUP BY to_tier
    `, scope)
    const benefitFacts = content.domain === 'tier_benefits'
      ? await this.benefitFacts(content) : []
    const redemptionDemand = content.domain === 'redemption_catalog'
      ? await this.redemptionDemand(content) : []
    const promotionTriggerParticipants = content.domain === 'promotion_points'
      ? await this.promotionFacts(content) : []
    const notificationFacts = await this.notificationFacts()
    const sourceVersion = `impact-v1:${common.measured_at}`
    return {
      sourceVersion, measuredAt: common.measured_at,
      activeMembers: number(common.active_members),
      membersByTier: {
        member: number(common.member_count), silver: number(common.silver_count), gold: number(common.gold_count),
      },
      availablePointsLiability: number(common.points_liability),
      eligiblePaidAmountMinor: number(common.eligible_paid_minor),
      expectedTierEntries: tierCounts(events.rows, 'entries'),
      expectedTierRetentions: tierCounts(events.rows, 'retentions'),
      growthBucketsByTier: growthBuckets(growth.rows),
      pointCostMicrosPerPoint: number(common.point_cost_micros),
      benefitFacts, redemptionDemand, promotionTriggerParticipants, notificationFacts,
      currentTermsAcceptances: number(common.terms_acceptances),
    }
  }

  async saveImpactPreview(preview: MembershipConfigurationImpactPreview): Promise<void> {
    const inserted = await this.transaction.query<{ id: string }>(`
      INSERT INTO mbox.membership_configuration_impact_previews(
        tenant_id,store_id,public_id,configuration_domain,configuration_id,draft_revision,
        generated_by_employee_id,generated_at,expires_at,source_version,source_measured_at,
        active_members,current_member_count,current_silver_count,current_gold_count,
        available_points_liability,estimated_points_issued,estimated_points_cost_amount_minor,
        estimated_benefit_cost_amount_minor,estimated_redemption_cost_amount_minor,
        projected_member_count,projected_silver_count,projected_gold_count,affected_existing_members,
        inventory_shortage_warning,fulfillment_capacity_warning,points_cost_warning,
        benefit_cost_warning,redemption_cost_warning,terms_reacceptance_not_forced,fingerprint
      ) VALUES($1::uuid,$2::uuid,$3,$4,$5::uuid,$6,$7::uuid,$8::timestamptz,$9::timestamptz,
        $10,$11::timestamptz,$12,$13,$14,$15,$16::bigint,$17::bigint,$18::bigint,$19::bigint,$20::bigint,
        $21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31)
      RETURNING id
    `, [
      this.transaction.scope.tenantId, this.transaction.scope.storeId, preview.publicId,
      preview.domain, configurationId(preview.draftPublicId), preview.draftRevision,
      preview.generatedByEmployeeId, preview.generatedAt, preview.expiresAt, preview.sourceVersion,
      preview.sourceVersion.slice('impact-v1:'.length), preview.historicalMembership.activeMembers,
      preview.historicalMembership.membersByTier.member, preview.historicalMembership.membersByTier.silver,
      preview.historicalMembership.membersByTier.gold, preview.historicalMembership.availablePointsLiability,
      preview.estimatedPointsIssued, preview.estimatedPointsCostAmountMinor,
      preview.estimatedBenefitCostAmountMinor, preview.estimatedRedemptionCostAmountMinor,
      preview.projectedTierMembers?.member ?? null, preview.projectedTierMembers?.silver ?? null,
      preview.projectedTierMembers?.gold ?? null, preview.affectedExistingMembers,
      preview.warnings.includes('inventory_shortage'), preview.warnings.includes('fulfillment_capacity_review'),
      preview.warnings.includes('points_cost_review'), preview.warnings.includes('benefit_cost_review'),
      preview.warnings.includes('redemption_cost_review'), preview.warnings.includes('terms_reacceptance_not_forced'),
      preview.fingerprint,
    ])
    const previewId = inserted.rows[0]?.id
    if (!previewId) throw new Error('Membership configuration impact preview was not stored')
    for (const fact of preview.fulfillment) await this.transaction.query(`
      INSERT INTO mbox.membership_configuration_impact_fulfillment_facts(
        tenant_id,store_id,preview_id,fact_kind,reference_code,expected_demand,
        available_after_reservations,shortage,open_fulfillment_tasks
      ) VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8,$9)
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, previewId,
      preview.domain === 'tier_benefits' ? 'tier_benefit' : 'redemption', fact.referenceCode,
      fact.expectedDemand, fact.availableAfterReservations, fact.shortage, fact.openFulfillmentTasks])
  }

  async loadImpactPreview(publicId: string): Promise<MembershipConfigurationImpactPreview | null> {
    const row = (await this.transaction.query<PreviewRow>(`
      SELECT id,public_id,configuration_domain,configuration_id,draft_revision,
        generated_by_employee_id,generated_at::text,expires_at::text,source_version,
        active_members,current_member_count,current_silver_count,current_gold_count,
        available_points_liability,estimated_points_issued,estimated_points_cost_amount_minor,
        estimated_benefit_cost_amount_minor,estimated_redemption_cost_amount_minor,
        projected_member_count,projected_silver_count,projected_gold_count,affected_existing_members,
        inventory_shortage_warning,fulfillment_capacity_warning,points_cost_warning,
        benefit_cost_warning,redemption_cost_warning,terms_reacceptance_not_forced,fingerprint
      FROM mbox.membership_configuration_impact_previews
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND public_id=$3
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, publicId])).rows[0]
    if (!row) return null
    const draft = await this.loadDraft(row.configuration_id)
    if (!draft || draft.domain !== row.configuration_domain) return null
    const fulfillment = await this.transaction.query<FulfillmentRow>(`
      SELECT reference_code,expected_demand,available_after_reservations,shortage,open_fulfillment_tasks
      FROM mbox.membership_configuration_impact_fulfillment_facts
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND preview_id=$3::uuid
      ORDER BY fact_kind,reference_code
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, row.id])
    return previewRecord(row, draft.content, fulfillment.rows)
  }

  async approveDraft(input: Readonly<{
    publicId: string
    expectedRevision: number
    approverEmployeeId: string
    reason: string
    impactPreviewPublicId: string
    impactFingerprint: string
  }>): Promise<MembershipConfigurationDraftRecord> {
    const id = configurationId(input.publicId)
    const preview = (await this.transaction.query<{ id: string }>(`
      SELECT id FROM mbox.membership_configuration_impact_previews
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND public_id=$3
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, input.impactPreviewPublicId])).rows[0]
    if (!preview) throw stale()
    await this.transaction.query(`
      INSERT INTO mbox.membership_configuration_approval_facts(
        tenant_id,store_id,configuration_domain,configuration_id,draft_revision,
        impact_preview_id,impact_fingerprint,approved_by_employee_id,approval_reason
      ) VALUES($1::uuid,$2::uuid,$3,$4::uuid,$5,$6::uuid,$7,$8::uuid,$9)
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, this.domain, id,
      input.expectedRevision, preview.id, input.impactFingerprint, input.approverEmployeeId, input.reason])
    const table = versionTable(this.domain)
    const reasonColumn = this.domain === 'membership_terms' ? 'approval_reason' : 'reason'
    const updated = await this.transaction.query(`
      UPDATE mbox.${table}
      SET status='approved',approved_by_employee_id=$4::uuid,approved_at=clock_timestamp(),${reasonColumn}=$5
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
        AND status='draft' AND draft_revision=$6
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, id,
      input.approverEmployeeId, input.reason, input.expectedRevision])
    if (updated.rowCount !== 1) throw stale()
    const result = await this.loadDraft(id)
    if (!result) throw stale()
    return result
  }

  private async replaceTypedContent(
    id: string,
    input: Parameters<MembershipConfigurationDraftSession['replaceDraft']>[0],
  ): Promise<void> {
    const content = input.content
    if (content.domain === 'base_points') {
      await changed(this.transaction, `UPDATE mbox.loyalty_policy_versions SET
        points_numerator=$4,points_denominator_minor=$5,growth_numerator=$6,growth_denominator_minor=$7,
        rounding_mode=$8,points_validity_months=$9,draft_revision=$10,reason=$11,updated_at=clock_timestamp()
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid AND status='draft' AND draft_revision=$12`,
      [this.transaction.scope.tenantId, this.transaction.scope.storeId, id, content.pointsNumerator,
        content.pointsDenominatorMinor, content.growthNumerator, content.growthDenominatorMinor,
        content.roundingMode, content.pointsValidityMonths, input.nextRevision, input.reason, input.expectedRevision])
      return
    }
    if (content.domain === 'tier_policy') {
      await changed(this.transaction, `UPDATE mbox.loyalty_tier_policy_versions SET
        evaluation_window_months=$4,tier_period_months=$5,downgrade_grace_days=$6,
        silver_upgrade_growth=$7,silver_retain_growth=$8,gold_upgrade_growth=$9,gold_retain_growth=$10,
        silver_points_multiplier_numerator=$11,silver_points_multiplier_denominator=$12,
        gold_points_multiplier_numerator=$13,gold_points_multiplier_denominator=$14,
        draft_revision=$15,reason=$16,updated_at=clock_timestamp()
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid AND status='draft' AND draft_revision=$17`,
      [this.transaction.scope.tenantId, this.transaction.scope.storeId, id, content.evaluationWindowMonths,
        content.tierPeriodMonths, content.downgradeGraceDays, content.silverUpgradeGrowth,
        content.silverRetainGrowth, content.goldUpgradeGrowth, content.goldRetainGrowth,
        content.silverPointsMultiplierNumerator, content.silverPointsMultiplierDenominator,
        content.goldPointsMultiplierNumerator, content.goldPointsMultiplierDenominator,
        input.nextRevision, input.reason, input.expectedRevision])
      return
    }
    if (content.domain === 'membership_terms') {
      await changed(this.transaction, `UPDATE mbox.membership_terms_versions SET
        title=$4,summary=$5,content=$6,draft_revision=$7,draft_reason=$8,updated_at=clock_timestamp()
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid AND status='draft' AND draft_revision=$9`,
      [this.transaction.scope.tenantId, this.transaction.scope.storeId, id, content.title,
        content.summary, content.content, input.nextRevision, input.reason, input.expectedRevision])
      return
    }
    if (content.domain === 'tier_benefits') return this.replaceTierBenefits(id, input, content)
    if (content.domain === 'redemption_catalog') return this.replaceRedemptionCatalog(id, input, content)
    if (content.domain === 'promotion_points') return this.replacePromotion(id, input, content)
    return this.replaceNotification(id, input, content)
  }

  private async loadTierBenefits(id: string, makers: readonly string[]) {
    const row = (await this.transaction.query<VersionRow & { tier_policy_version_id: string }>(`
      SELECT id,status,draft_revision,updated_at::text,tier_policy_version_id
      FROM mbox.loyalty_tier_benefit_policy_versions
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid FOR UPDATE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, id])).rows[0]
    if (!row) return null
    const rules = await this.transaction.query<TierBenefitRuleRow>(`
      SELECT rule_code,eligible_tier,inherit_to_higher_tiers,grant_on_entry,grant_on_retention,
        benefit_definition_id,quantity,validity_days,revocation_policy,enabled
      FROM mbox.loyalty_tier_benefit_rules
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND policy_version_id=$3::uuid ORDER BY rule_code
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, id])
    return record(row, 'tier_benefits', makers, { domain: 'tier_benefits',
      tierPolicyVersionId: row.tier_policy_version_id,
      rules: rules.rows.map((rule) => ({ ruleCode: rule.rule_code, eligibleTier: rule.eligible_tier,
        inheritToHigherTiers: rule.inherit_to_higher_tiers, grantOnEntry: rule.grant_on_entry,
        grantOnRetention: rule.grant_on_retention, benefitDefinitionId: rule.benefit_definition_id,
        quantity: rule.quantity, validityDays: rule.validity_days,
        revocationPolicy: rule.revocation_policy, enabled: rule.enabled })),
    })
  }

  private async loadRedemptionCatalog(id: string, makers: readonly string[]) {
    const row = (await this.transaction.query<VersionRow>(`
      SELECT id,status,draft_revision,updated_at::text FROM mbox.redemption_catalog_versions
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid FOR UPDATE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, id])).rows[0]
    if (!row) return null
    const items = await this.transaction.query<RedemptionItemRow>(`
      SELECT public_id,item_code,name,fulfillment_kind,product_id,benefit_definition_id,activity_id,
        points_required,cost_amount_minor,currency,total_inventory,daily_inventory,member_daily_limit,
        member_rolling_30_day_limit,member_lifetime_limit,minimum_tier,requires_table_session,
        requires_employee_fulfillment,cancellation_allowed_before_fulfillment,restore_expired_points_days,
        available_from::text,available_until::text,fulfillment_timeout_minutes,status
      FROM mbox.redemption_catalog_items WHERE tenant_id=$1::uuid AND store_id=$2::uuid
        AND catalog_version_id=$3::uuid ORDER BY item_code
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, id])
    return record(row, 'redemption_catalog', makers, { domain: 'redemption_catalog',
      items: items.rows.map(mapRedemptionItem) })
  }

  private async loadPromotionPolicy(id: string, makers: readonly string[]) {
    const row = (await this.transaction.query<PromotionRow>(`
      SELECT id,status,draft_revision,updated_at::text,campaign_code,name,activity_id,stacking_group,
        stacking_mode,priority,store_budget_points,per_member_points_limit,point_validity_days,
        refund_policy,budget_reuse_after_refund,member_limit_reuse_after_refund,eligible_member_levels
      FROM mbox.loyalty_promotion_policy_versions
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid FOR UPDATE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, id])).rows[0]
    if (!row) return null
    const rules = await this.transaction.query<PromotionRuleRow>(`
      SELECT rule_code,trigger_kind,points,per_member_award_limit,minimum_paid_amount_minor,enabled
      FROM mbox.loyalty_promotion_rules WHERE tenant_id=$1::uuid AND store_id=$2::uuid
        AND policy_version_id=$3::uuid ORDER BY rule_code
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, id])
    return record(row, 'promotion_points', makers, { domain: 'promotion_points', campaignCode: row.campaign_code,
      name: row.name, activityId: row.activity_id, stackingGroup: row.stacking_group,
      stackingMode: row.stacking_mode, priority: row.priority, storeBudgetPoints: row.store_budget_points,
      perMemberPointsLimit: row.per_member_points_limit, pointValidityDays: row.point_validity_days,
      refundPolicy: row.refund_policy, budgetReuseAfterRefund: row.budget_reuse_after_refund,
      memberLimitReuseAfterRefund: row.member_limit_reuse_after_refund,
      eligibleMemberLevels: row.eligible_member_levels,
      rules: rules.rows.map((rule) => ({ ruleCode: rule.rule_code, triggerKind: rule.trigger_kind,
        points: rule.points, perMemberAwardLimit: rule.per_member_award_limit,
        minimumPaidAmountMinor: number(rule.minimum_paid_amount_minor), enabled: rule.enabled })),
    })
  }

  private async loadNotification(id: string, makers: readonly string[]) {
    const row = (await this.transaction.query<NotificationRow>(`
      SELECT id,status,draft_revision,updated_at::text,notification_type,authorization_purpose,
        authorization_context,template_id,page_path,points_data_key,balance_data_key,
        occurred_at_data_key,expires_at_data_key,expiry_lead_days,max_per_customer_per_24h,
        minimum_interval_minutes,quiet_hours_start::text,quiet_hours_end::text
      FROM mbox.wechat_notification_policies
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
        AND governance_mode='managed' FOR UPDATE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, id])).rows[0]
    return row ? record(row, 'wechat_notifications', makers, { domain: 'wechat_notifications',
      notificationType: row.notification_type, authorizationPurpose: row.authorization_purpose,
      authorizationContext: row.authorization_context, templateId: row.template_id,
      pagePath: row.page_path, pointsDataKey: row.points_data_key, balanceDataKey: row.balance_data_key,
      occurredAtDataKey: row.occurred_at_data_key, expiresAtDataKey: row.expires_at_data_key,
      expiryLeadDays: row.expiry_lead_days, maxPerCustomerPer24h: row.max_per_customer_per_24h,
      minimumIntervalMinutes: row.minimum_interval_minutes, quietHoursStart: row.quiet_hours_start,
      quietHoursEnd: row.quiet_hours_end,
    }) : null
  }

  private async replaceTierBenefits(id: string, input: Parameters<MembershipConfigurationDraftSession['replaceDraft']>[0], content: Extract<MembershipConfigurationContent,{domain:'tier_benefits'}>) {
    await changed(this.transaction, `UPDATE mbox.loyalty_tier_benefit_policy_versions SET
      tier_policy_version_id=$4::uuid,draft_revision=$5,reason=$6,updated_at=clock_timestamp()
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid AND status='draft' AND draft_revision=$7`,
    [this.transaction.scope.tenantId,this.transaction.scope.storeId,id,content.tierPolicyVersionId,
      input.nextRevision,input.reason,input.expectedRevision])
    await this.transaction.query(`DELETE FROM mbox.loyalty_tier_benefit_rules
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND policy_version_id=$3::uuid`,
    [this.transaction.scope.tenantId,this.transaction.scope.storeId,id])
    for (const rule of content.rules) await this.transaction.query(`INSERT INTO mbox.loyalty_tier_benefit_rules(
      tenant_id,store_id,policy_version_id,rule_code,eligible_tier,inherit_to_higher_tiers,
      grant_on_entry,grant_on_retention,benefit_definition_id,quantity,validity_days,revocation_policy,enabled
    ) VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8,$9::uuid,$10,$11,$12,$13)`,
    [this.transaction.scope.tenantId,this.transaction.scope.storeId,id,rule.ruleCode,rule.eligibleTier,
      rule.inheritToHigherTiers,rule.grantOnEntry,rule.grantOnRetention,rule.benefitDefinitionId,
      rule.quantity,rule.validityDays,rule.revocationPolicy,rule.enabled])
  }

  private async replaceRedemptionCatalog(id: string, input: Parameters<MembershipConfigurationDraftSession['replaceDraft']>[0], content: Extract<MembershipConfigurationContent,{domain:'redemption_catalog'}>) {
    await changed(this.transaction, `UPDATE mbox.redemption_catalog_versions SET draft_revision=$4,reason=$5,
      updated_at=clock_timestamp() WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
      AND status='draft' AND draft_revision=$6`, [this.transaction.scope.tenantId,this.transaction.scope.storeId,id,
      input.nextRevision,input.reason,input.expectedRevision])
    await this.transaction.query(`DELETE FROM mbox.redemption_catalog_items
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND catalog_version_id=$3::uuid
        AND NOT (public_id=ANY($4::text[]))`, [this.transaction.scope.tenantId,this.transaction.scope.storeId,id,
      content.items.map((item)=>item.publicId)])
    for (const item of content.items) await this.transaction.query(`
      INSERT INTO mbox.redemption_catalog_items(
        tenant_id,store_id,catalog_version_id,public_id,item_code,name,fulfillment_kind,product_id,
        benefit_definition_id,activity_id,points_required,cost_amount_minor,currency,total_inventory,
        daily_inventory,member_daily_limit,member_rolling_30_day_limit,member_lifetime_limit,
        minimum_tier,requires_table_session,requires_employee_fulfillment,cancellation_allowed_before_fulfillment,
        restore_expired_points_days,available_from,available_until,fulfillment_timeout_minutes,status,display_snapshot
      ) VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8::uuid,$9::uuid,$10::uuid,$11,$12::bigint,$13,
        $14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24::timestamptz,$25::timestamptz,$26,$27,'{}'::jsonb)
      ON CONFLICT (tenant_id,store_id,catalog_version_id,item_code) DO UPDATE SET
        public_id=EXCLUDED.public_id,name=EXCLUDED.name,fulfillment_kind=EXCLUDED.fulfillment_kind,
        product_id=EXCLUDED.product_id,benefit_definition_id=EXCLUDED.benefit_definition_id,
        activity_id=EXCLUDED.activity_id,points_required=EXCLUDED.points_required,
        cost_amount_minor=EXCLUDED.cost_amount_minor,currency=EXCLUDED.currency,
        total_inventory=EXCLUDED.total_inventory,daily_inventory=EXCLUDED.daily_inventory,
        member_daily_limit=EXCLUDED.member_daily_limit,member_rolling_30_day_limit=EXCLUDED.member_rolling_30_day_limit,
        member_lifetime_limit=EXCLUDED.member_lifetime_limit,minimum_tier=EXCLUDED.minimum_tier,
        requires_table_session=EXCLUDED.requires_table_session,
        requires_employee_fulfillment=EXCLUDED.requires_employee_fulfillment,
        cancellation_allowed_before_fulfillment=EXCLUDED.cancellation_allowed_before_fulfillment,
        restore_expired_points_days=EXCLUDED.restore_expired_points_days,available_from=EXCLUDED.available_from,
        available_until=EXCLUDED.available_until,fulfillment_timeout_minutes=EXCLUDED.fulfillment_timeout_minutes,
        status=EXCLUDED.status
    `, [this.transaction.scope.tenantId,this.transaction.scope.storeId,id,item.publicId,item.itemCode,item.name,
      item.fulfillmentKind,item.productId,item.benefitDefinitionId,item.activityId,item.pointsRequired,
      item.costAmountMinor,item.currency,item.totalInventory,item.dailyInventory,item.memberDailyLimit,
      item.memberRolling30DayLimit,item.memberLifetimeLimit,item.minimumTier,item.requiresTableSession,
      item.requiresEmployeeFulfillment,item.cancellationAllowedBeforeFulfillment,item.restoreExpiredPointsDays,
      item.availableFrom,item.availableUntil,item.fulfillmentTimeoutMinutes,item.status])
  }

  private async replacePromotion(id: string, input: Parameters<MembershipConfigurationDraftSession['replaceDraft']>[0], content: Extract<MembershipConfigurationContent,{domain:'promotion_points'}>) {
    await changed(this.transaction, `UPDATE mbox.loyalty_promotion_policy_versions SET name=$4,activity_id=$5::uuid,
      stacking_group=$6,stacking_mode=$7,priority=$8,store_budget_points=$9,per_member_points_limit=$10,
      point_validity_days=$11,refund_policy=$12,budget_reuse_after_refund=$13,
      member_limit_reuse_after_refund=$14,eligible_member_levels=$15::text[],draft_revision=$16,
      reason=$17,updated_at=clock_timestamp() WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
      AND status='draft' AND draft_revision=$18`, [this.transaction.scope.tenantId,this.transaction.scope.storeId,id,
      content.name,content.activityId,content.stackingGroup,content.stackingMode,content.priority,
      content.storeBudgetPoints,content.perMemberPointsLimit,content.pointValidityDays,content.refundPolicy,
      content.budgetReuseAfterRefund,content.memberLimitReuseAfterRefund,content.eligibleMemberLevels,
      input.nextRevision,input.reason,input.expectedRevision])
    await this.transaction.query(`UPDATE mbox.loyalty_promotion_rules SET enabled=false
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND policy_version_id=$3::uuid
        AND NOT (rule_code=ANY($4::text[]))`, [this.transaction.scope.tenantId,this.transaction.scope.storeId,id,
      content.rules.map((rule)=>rule.ruleCode)])
    for (const rule of content.rules) await this.transaction.query(`INSERT INTO mbox.loyalty_promotion_rules(
      tenant_id,store_id,policy_version_id,rule_code,trigger_kind,points,per_member_award_limit,
      minimum_paid_amount_minor,enabled
    ) VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8::bigint,$9)
    ON CONFLICT(tenant_id,store_id,policy_version_id,rule_code) DO UPDATE SET
      trigger_kind=EXCLUDED.trigger_kind,points=EXCLUDED.points,
      per_member_award_limit=EXCLUDED.per_member_award_limit,
      minimum_paid_amount_minor=EXCLUDED.minimum_paid_amount_minor,enabled=EXCLUDED.enabled`,
    [this.transaction.scope.tenantId,this.transaction.scope.storeId,id,rule.ruleCode,rule.triggerKind,
      rule.points,rule.perMemberAwardLimit,rule.minimumPaidAmountMinor,rule.enabled])
  }

  private async replaceNotification(id: string, input: Parameters<MembershipConfigurationDraftSession['replaceDraft']>[0], content: Extract<MembershipConfigurationContent,{domain:'wechat_notifications'}>) {
    await changed(this.transaction, `UPDATE mbox.wechat_notification_policies SET notification_type=$4,
      authorization_purpose=$5,authorization_context=$6,template_id=$7,page_path=$8,points_data_key=$9,
      balance_data_key=$10,occurred_at_data_key=$11,expires_at_data_key=$12,expiry_lead_days=$13,
      max_per_customer_per_24h=$14,minimum_interval_minutes=$15,quiet_hours_start=$16::time,
      quiet_hours_end=$17::time,draft_revision=$18,reason=$19,updated_at=clock_timestamp()
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid AND status='draft'
        AND governance_mode='managed' AND draft_revision=$20`, [this.transaction.scope.tenantId,
      this.transaction.scope.storeId,id,content.notificationType,content.authorizationPurpose,
      content.authorizationContext,content.templateId,content.pagePath,content.pointsDataKey,
      content.balanceDataKey,content.occurredAtDataKey,content.expiresAtDataKey,content.expiryLeadDays,
      content.maxPerCustomerPer24h,content.minimumIntervalMinutes,content.quietHoursStart,
      content.quietHoursEnd,input.nextRevision,input.reason,input.expectedRevision])
  }

  private async benefitFacts(content: Extract<MembershipConfigurationContent,{domain:'tier_benefits'}>) {
    const ids=[...new Set(content.rules.map((rule)=>rule.benefitDefinitionId))]
    if(ids.length===0)return []
    const result=await this.transaction.query<BenefitFactRow>(`SELECT definition.id,
      definition.cost_amount_minor,definition.requires_employee_fulfillment,
      count(DISTINCT benefit_grant.id) FILTER(
        WHERE benefit_grant.status IN ('active','revocation_pending')
      )::integer AS open_tasks
      FROM mbox.loyalty_benefit_definitions definition
      LEFT JOIN mbox.loyalty_tier_benefit_rules historical_rule
        ON historical_rule.tenant_id=definition.tenant_id
       AND historical_rule.store_id=definition.store_id
       AND historical_rule.benefit_definition_id=definition.id
      LEFT JOIN mbox.membership_tier_benefit_grants benefit_grant
        ON benefit_grant.tenant_id=definition.tenant_id
       AND benefit_grant.store_id=definition.store_id AND benefit_grant.rule_id=historical_rule.id
       AND benefit_grant.status IN ('active','revocation_pending')
      WHERE definition.tenant_id=$1::uuid AND definition.store_id=$2::uuid AND definition.id=ANY($3::uuid[])
      GROUP BY definition.id,definition.cost_amount_minor,definition.requires_employee_fulfillment`,
    [this.transaction.scope.tenantId,this.transaction.scope.storeId,ids])
    return result.rows.map((row)=>({benefitDefinitionId:row.id,unitCostAmountMinor:number(row.cost_amount_minor),
      availableInventory:null,reservedInventory:0,requiresEmployeeFulfillment:row.requires_employee_fulfillment,
      openFulfillmentTasks:number(row.open_tasks)}))
  }

  private async redemptionDemand(content: Extract<MembershipConfigurationContent,{domain:'redemption_catalog'}>) {
    const codes=content.items.map((item)=>item.itemCode)
    if(codes.length===0)return []
    const result=await this.transaction.query<RedemptionDemandRow>(`SELECT item.item_code,
      count(redemption.id) FILTER(WHERE redemption.created_at>=clock_timestamp()-interval '30 days')::integer AS expected_requests,
      COALESCE(balance.total_consumed,0)::integer AS reserved_total,
      COALESCE(daily.consumed,0)::integer AS reserved_today,
      count(redemption.id) FILTER(WHERE redemption.status='awaiting_fulfillment')::integer AS open_tasks
      FROM mbox.redemption_catalog_items item
      LEFT JOIN mbox.redemption_inventory_balances balance ON balance.tenant_id=item.tenant_id
        AND balance.store_id=item.store_id AND balance.catalog_item_id=item.id
      LEFT JOIN mbox.redemption_daily_inventory daily ON daily.tenant_id=item.tenant_id
        AND daily.store_id=item.store_id AND daily.catalog_item_id=item.id AND daily.business_date=current_date
      LEFT JOIN mbox.member_redemptions redemption ON redemption.tenant_id=item.tenant_id
        AND redemption.store_id=item.store_id AND redemption.catalog_item_id=item.id
      WHERE item.tenant_id=$1::uuid AND item.store_id=$2::uuid AND item.item_code=ANY($3::text[])
      GROUP BY item.item_code,balance.total_consumed,daily.consumed`,
    [this.transaction.scope.tenantId,this.transaction.scope.storeId,codes])
    return result.rows.map((row)=>({itemCode:row.item_code,expectedRequests:number(row.expected_requests),
      currentlyReservedTotal:number(row.reserved_total),currentlyReservedToday:number(row.reserved_today),
      openFulfillmentTasks:number(row.open_tasks)}))
  }

  private async promotionFacts(content: Extract<MembershipConfigurationContent,{domain:'promotion_points'}>) {
    const result=[]
    for(const triggerKind of [...new Set(content.rules.map((rule)=>rule.triggerKind))]){
      const row=(await this.transaction.query<{eligible_members:string|number;trigger_facts:string|number}>(`
        SELECT count(DISTINCT registration.customer_id)::integer AS eligible_members,
          count(*)::integer AS trigger_facts
        FROM mbox.loyalty_promotion_trigger_facts fact
        JOIN mbox.community_activity_registrations registration
          ON registration.tenant_id=fact.tenant_id AND registration.store_id=fact.store_id
         AND registration.id=fact.registration_id AND registration.registration_cycle=fact.registration_cycle
        WHERE fact.tenant_id=$1::uuid AND fact.store_id=$2::uuid
          AND fact.activity_id=$3::uuid AND fact.trigger_kind=$4
      `,[this.transaction.scope.tenantId,this.transaction.scope.storeId,content.activityId,triggerKind])).rows[0]
      result.push({triggerKind,eligibleMembers:number(row?.eligible_members??0),expectedTriggerFacts:number(row?.trigger_facts??0)})
    }
    return result
  }

  private async notificationFacts() {
    const result=await this.transaction.query<NotificationFactRow>(`SELECT policy.notification_type,
      count(DISTINCT authorization_choice.customer_id) FILTER(
        WHERE authorization_choice.decision='granted' AND authorization_choice.uses_allowed>0
          AND NOT EXISTS (SELECT 1 FROM mbox.wechat_notification_authorization_uses used
            WHERE used.tenant_id=authorization_choice.tenant_id
              AND used.store_id=authorization_choice.store_id
              AND used.authorization_id=authorization_choice.id)
      )::integer AS authorizations,
      count(job.id) FILTER(WHERE job.created_at>=clock_timestamp()-interval '24 hours')::integer AS messages
      FROM mbox.wechat_notification_policies policy
      LEFT JOIN mbox.wechat_notification_authorizations authorization_choice
        ON authorization_choice.tenant_id=policy.tenant_id
       AND authorization_choice.store_id=policy.store_id AND authorization_choice.policy_id=policy.id
      LEFT JOIN mbox.wechat_customer_notification_jobs job ON job.tenant_id=policy.tenant_id
        AND job.store_id=policy.store_id AND job.policy_id=policy.id
      WHERE policy.tenant_id=$1::uuid AND policy.store_id=$2::uuid GROUP BY policy.notification_type`,
    [this.transaction.scope.tenantId,this.transaction.scope.storeId])
    return result.rows.map((row)=>({notificationType:row.notification_type,
      activeAuthorizations:number(row.authorizations),expectedMessagesPer24h:number(row.messages)}))
  }
}

interface VersionRow extends Record<string,unknown>{id:string;status:MembershipConfigurationDraftRecord['status'];draft_revision:number;updated_at:string}
interface BasePointsRow extends VersionRow{points_numerator:number;points_denominator_minor:number;growth_numerator:number;growth_denominator_minor:number;rounding_mode:'floor'|'nearest';points_validity_months:number}
interface TierPolicyRow extends VersionRow{evaluation_window_months:number;tier_period_months:number;downgrade_grace_days:number;silver_upgrade_growth:number;silver_retain_growth:number;gold_upgrade_growth:number;gold_retain_growth:number;silver_points_multiplier_numerator:number;silver_points_multiplier_denominator:number;gold_points_multiplier_numerator:number;gold_points_multiplier_denominator:number}
interface MembershipTermsRow extends VersionRow{title:string;summary:string;content:string}
interface TierBenefitRuleRow extends Record<string,unknown>{rule_code:string;eligible_tier:MembershipTier;inherit_to_higher_tiers:boolean;grant_on_entry:boolean;grant_on_retention:boolean;benefit_definition_id:string;quantity:number;validity_days:number;revocation_policy:'revoke_unreserved'|'protect_until_expiry';enabled:boolean}
interface RedemptionItemRow extends Record<string,unknown>{public_id:string;item_code:string;name:string;fulfillment_kind:'product'|'benefit'|'activity'|'service';product_id:string|null;benefit_definition_id:string|null;activity_id:string|null;points_required:number;cost_amount_minor:string|number;currency:string;total_inventory:number|null;daily_inventory:number|null;member_daily_limit:number;member_rolling_30_day_limit:number;member_lifetime_limit:number|null;minimum_tier:MembershipTier;requires_table_session:boolean;requires_employee_fulfillment:boolean;cancellation_allowed_before_fulfillment:boolean;restore_expired_points_days:number;available_from:string;available_until:string|null;fulfillment_timeout_minutes:number;status:'active'|'paused'|'retired'}
interface PromotionRow extends VersionRow{campaign_code:string;name:string;activity_id:string;stacking_group:string;stacking_mode:'stackable'|'exclusive_highest'|'exclusive_first';priority:number;store_budget_points:number;per_member_points_limit:number;point_validity_days:number;refund_policy:'reverse_on_any_refund'|'reverse_on_full_refund';budget_reuse_after_refund:boolean;member_limit_reuse_after_refund:boolean;eligible_member_levels:MembershipTier[]}
interface PromotionRuleRow extends Record<string,unknown>{rule_code:string;trigger_kind:'activity_payment'|'activity_check_in'|'activity_completion';points:number;per_member_award_limit:number;minimum_paid_amount_minor:string|number;enabled:boolean}
interface NotificationRow extends VersionRow{notification_type:'loyalty_points_credited'|'loyalty_points_reversed'|'loyalty_points_expiring';authorization_purpose:'loyalty_balance_change'|'loyalty_expiry_reminder';authorization_context:'loyalty_accrual'|'loyalty_refund'|'loyalty_expiry';template_id:string;page_path:string;points_data_key:string;balance_data_key:string|null;occurred_at_data_key:string;expires_at_data_key:string|null;expiry_lead_days:number|null;max_per_customer_per_24h:number;minimum_interval_minutes:number;quiet_hours_start:string|null;quiet_hours_end:string|null}
interface ImpactCommonRow extends Record<string,unknown>{active_members:string|number;member_count:string|number;silver_count:string|number;gold_count:string|number;points_liability:string|number;measured_at:string;eligible_paid_minor:string|number;point_cost_micros:string|number;terms_acceptances:string|number}
interface GrowthRow extends Record<string,unknown>{current_tier:MembershipTier;growth_value:number;members:number;eligible_base_points:string|number}
interface TierEventRow extends Record<string,unknown>{to_tier:MembershipTier;entries:number;retentions:number}
interface BenefitFactRow extends Record<string,unknown>{id:string;cost_amount_minor:string|number;requires_employee_fulfillment:boolean;open_tasks:string|number}
interface RedemptionDemandRow extends Record<string,unknown>{item_code:string;expected_requests:string|number;reserved_total:string|number;reserved_today:string|number;open_tasks:string|number}
interface NotificationFactRow extends Record<string,unknown>{notification_type:'loyalty_points_credited'|'loyalty_points_reversed'|'loyalty_points_expiring';authorizations:string|number;messages:string|number}
interface PreviewRow extends Record<string,unknown>{id:string;public_id:string;configuration_domain:MembershipConfigurationDomain;configuration_id:string;draft_revision:number;generated_by_employee_id:string;generated_at:string;expires_at:string;source_version:string;active_members:number;current_member_count:number;current_silver_count:number;current_gold_count:number;available_points_liability:string|number;estimated_points_issued:string|number;estimated_points_cost_amount_minor:string|number;estimated_benefit_cost_amount_minor:string|number;estimated_redemption_cost_amount_minor:string|number;projected_member_count:number|null;projected_silver_count:number|null;projected_gold_count:number|null;affected_existing_members:number;inventory_shortage_warning:boolean;fulfillment_capacity_warning:boolean;points_cost_warning:boolean;benefit_cost_warning:boolean;redemption_cost_warning:boolean;terms_reacceptance_not_forced:boolean;fingerprint:string}
interface FulfillmentRow extends Record<string,unknown>{reference_code:string;expected_demand:number;available_after_reservations:number|null;shortage:number;open_fulfillment_tasks:number}

function record(row:VersionRow,domain:MembershipConfigurationDomain,makers:readonly string[],content:MembershipConfigurationContent):MembershipConfigurationDraftRecord{return{publicId:row.id,domain,status:row.status,revision:row.draft_revision,makerEmployeeIds:makers,content,updatedAt:row.updated_at}}
function mapRedemptionItem(row:RedemptionItemRow):Extract<MembershipConfigurationContent,{domain:'redemption_catalog'}>['items'][number]{return{publicId:row.public_id,itemCode:row.item_code,name:row.name,fulfillmentKind:row.fulfillment_kind,productId:row.product_id,benefitDefinitionId:row.benefit_definition_id,activityId:row.activity_id,pointsRequired:row.points_required,costAmountMinor:number(row.cost_amount_minor),currency:row.currency,totalInventory:row.total_inventory,dailyInventory:row.daily_inventory,memberDailyLimit:row.member_daily_limit,memberRolling30DayLimit:row.member_rolling_30_day_limit,memberLifetimeLimit:row.member_lifetime_limit,minimumTier:row.minimum_tier,requiresTableSession:row.requires_table_session,requiresEmployeeFulfillment:row.requires_employee_fulfillment,cancellationAllowedBeforeFulfillment:row.cancellation_allowed_before_fulfillment,restoreExpiredPointsDays:row.restore_expired_points_days,availableFrom:row.available_from,availableUntil:row.available_until,fulfillmentTimeoutMinutes:row.fulfillment_timeout_minutes,status:row.status}}
function growthBuckets(rows:readonly GrowthRow[]):MembershipImpactSnapshot['growthBucketsByTier']{const result:{member:Array<{minimumGrowth:number;maximumGrowth:number;members:number;eligibleBasePoints:number}>;silver:Array<{minimumGrowth:number;maximumGrowth:number;members:number;eligibleBasePoints:number}>;gold:Array<{minimumGrowth:number;maximumGrowth:number;members:number;eligibleBasePoints:number}>}={member:[],silver:[],gold:[]};for(const row of rows)result[row.current_tier].push({minimumGrowth:row.growth_value,maximumGrowth:row.growth_value,members:row.members,eligibleBasePoints:number(row.eligible_base_points)});return result}
function tierCounts(rows:readonly TierEventRow[],key:'entries'|'retentions'){const value:Record<MembershipTier,number>={member:0,silver:0,gold:0};for(const row of rows)value[row.to_tier]=row[key];return value}
function previewRecord(row:PreviewRow,content:MembershipConfigurationContent,fulfillment:readonly FulfillmentRow[]):MembershipConfigurationImpactPreview{const warnings:MembershipConfigurationImpactPreview['warnings'][number][]=[];if(row.inventory_shortage_warning)warnings.push('inventory_shortage');if(row.fulfillment_capacity_warning)warnings.push('fulfillment_capacity_review');if(row.points_cost_warning)warnings.push('points_cost_review');if(row.benefit_cost_warning)warnings.push('benefit_cost_review');if(row.redemption_cost_warning)warnings.push('redemption_cost_review');if(row.terms_reacceptance_not_forced)warnings.push('terms_reacceptance_not_forced');return{publicId:row.public_id,draftPublicId:row.configuration_id,domain:row.configuration_domain,draftRevision:row.draft_revision,generatedByEmployeeId:row.generated_by_employee_id,generatedAt:row.generated_at,expiresAt:row.expires_at,sourceVersion:row.source_version,historicalMembership:{activeMembers:row.active_members,membersByTier:{member:row.current_member_count,silver:row.current_silver_count,gold:row.current_gold_count},availablePointsLiability:number(row.available_points_liability)},policyContent:content,estimatedPointsIssued:number(row.estimated_points_issued),estimatedPointsCostAmountMinor:number(row.estimated_points_cost_amount_minor),estimatedBenefitCostAmountMinor:number(row.estimated_benefit_cost_amount_minor),estimatedRedemptionCostAmountMinor:number(row.estimated_redemption_cost_amount_minor),projectedTierMembers:row.projected_member_count===null?null:{member:row.projected_member_count,silver:row.projected_silver_count!,gold:row.projected_gold_count!},fulfillment:fulfillment.map((fact)=>({referenceCode:fact.reference_code,expectedDemand:fact.expected_demand,availableAfterReservations:fact.available_after_reservations,shortage:fact.shortage,openFulfillmentTasks:fact.open_fulfillment_tasks})),affectedExistingMembers:row.affected_existing_members,warnings,fingerprint:row.fingerprint}}
function versionTable(domain:MembershipConfigurationDomain){return({base_points:'loyalty_policy_versions',tier_policy:'loyalty_tier_policy_versions',tier_benefits:'loyalty_tier_benefit_policy_versions',redemption_catalog:'redemption_catalog_versions',promotion_points:'loyalty_promotion_policy_versions',membership_terms:'membership_terms_versions',wechat_notifications:'wechat_notification_policies'} as const)[domain]}
function configurationId(value:string){if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))throw new TypeError('configuration id must be a UUID');return value}
function number(value:string|number){const result=Number(value);if(!Number.isSafeInteger(result)||result<0)throw new Error('Membership impact counter is invalid');return result}
async function changed(transaction:ScopedTransaction,sql:string,values:readonly unknown[]){const result=await transaction.query(sql,values);if(result.rowCount!==1)throw stale()}
function stale(){return new MembershipConfigurationDraftError(
  'MEMBERSHIP_CONFIGURATION_DRAFT_STALE','会员配置草稿已被修改，请刷新后重试',
)}
function emptyCommon():ImpactCommonRow{return{active_members:0,member_count:0,silver_count:0,gold_count:0,points_liability:0,measured_at:'2000-01-01T00:00:00.000Z',eligible_paid_minor:0,point_cost_micros:0,terms_acceptances:0}}
