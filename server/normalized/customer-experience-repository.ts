import { createHash, randomUUID } from 'node:crypto'
import type { JsonObject } from './command-executor.js'
import type { ScopedTransaction } from './transaction-runner.js'
import { PaymentRepository, type PaymentMethod } from './payment-repository.js'
import type { PublicMembershipTerms } from './membership-terms-service.js'
import { CustomerPreferenceRepository } from './customer-preference-repository.js'
import { lockBoundGuestTablePosition } from './guest-table-authority.js'

export type RolloutState = 'disabled' | 'shadow' | 'pilot' | 'enabled'
export type CustomerOccasion = 'business' | 'friends' | 'date' | 'birthday' | 'music' | 'relax' | 'other'
export type AlcoholPreference = 'cocktail' | 'wine' | 'sparkling' | 'beer' | 'whisky' | 'baijiu' | 'non_alcoholic' | 'mixed' | 'undecided'
export type ExperienceLevel = 'comfortable' | 'enhanced' | 'signature'
export type ServiceIntensity = 'quiet' | 'balanced' | 'hosted'
export type ActivityFeeBasis = 'per_person' | 'per_registration'
export type ActivityPaymentMode = 'none' | 'deposit_optional' | 'deposit_required' | 'full_required'
export type ActivityPaymentChoice = 'none' | 'deposit' | 'full'

export interface ProtectedActivityRegistrationContact {
  contactType: 'phone' | 'wechat' | 'other'
  contactHash: string
  encryptedContact: string
  encryptionKeyId: string
  maskedContact: string
  source: 'mini_program'
}

export interface CustomerExperienceContext {
  customerId: string
  businessDate: string
  actorRef: string
}

export interface TableExperienceContext extends CustomerExperienceContext {
  tableSessionId: string
  partySize: number
}

export interface PublicFeature {
  code: string
  state: RolloutState
  enabled: boolean
}

export interface PublicMembership {
  memberNo: string
  level: 'member' | 'silver' | 'gold'
  lifecycleStage: 'new' | 'active' | 'high_value' | 'at_risk' | 'dormant'
  pointsBalance: number
  growthValue: number
  pendingRecoveryPoints: number
  redemptionStatus: 'active' | 'suspended' | 'closed'
  visitCount: number
  joinedAt: string
  tierProgress: {
    evaluationWindowMonths: number
    rollingGrowth: number
    nextTier: 'silver' | 'gold' | null
    upgradeThreshold: number | null
    upgradeRemaining: number | null
    retainThreshold: number | null
    retainRemaining: number | null
    periodStatus: 'active' | 'grace' | null
    periodEndsAt: string | null
    graceEndsAt: string | null
  } | null
  pointsExpiry: {
    expiringWithin30Days: number
    nextExpiryAt: string
  } | null
}

export interface PublicPointEntry {
  id: string
  entryType: 'earn' | 'redeem' | 'expire' | 'reverse' | 'supplement' | 'adjust' | 'restore'
  pointsDelta: number
  balanceAfter: number
  sourceKind: 'order' | 'refund' | 'redemption' | 'activity' | 'benefit' | 'campaign' | 'service_recovery' | 'manual' | 'expiration'
  sourceReference: string | null
  description: string
  availableAt: string
  expiresAt: string | null
  policyVersion: number | null
  occurredAt: string
}

export interface PublicGrowthEntry {
  id: string
  entryType: 'earn' | 'reverse' | 'supplement' | 'adjust'
  growthDelta: number
  balanceAfter: number
  sourceKind: 'order' | 'refund' | 'manual' | 'system'
  sourceReference: string | null
  description: string
  availableAt: string
  policyVersion: number | null
  occurredAt: string
}

export interface PublicLoyaltyProcessingItem {
  key: string
  kind: 'accrual' | 'supplement'
  state: 'pending' | 'processing' | 'manual_review' | 'resolved' | 'no_action_needed' | 'closed'
  title: string
  message: string
  sourceReference: string
  occurredAt: string
  updatedAt: string
  active: boolean
}

export interface PublicLoyaltySnapshot {
  membership: PublicMembership | null
  points: PublicPointEntry[]
  growth: PublicGrowthEntry[]
  processing: PublicLoyaltyProcessingItem[]
}

export interface PublicContentCard {
  code: string
  type: 'activity' | 'presale' | 'benefit' | 'article' | 'return_offer' | 'show'
  title: string
  summary: string
  imageUrl: string | null
  ctaLabel: string
  targetPath: string | null
  priority: number
}

export interface PublicActivity {
  publicId: string
  kind: string
  title: string
  summary: string
  coverUrl: string | null
  startsAt: string
  endsAt: string
  assemblyLocation: string
  capacity: number
  remainingCapacity: number
  feeAmountMinor: number
  depositAmountMinor: number
  feeBasis: ActivityFeeBasis
  paymentMode: ActivityPaymentMode
  paymentDeadlineMinutes: number
  paymentRuleText: string
  refundPolicy: JsonObject
  currency: string
  pointsReward: number
  status: 'published' | 'full'
  registrationStatus: string | null
  safety: JsonObject
  salesCopy: JsonObject
  paymentAvailability: 'available' | 'blocked'
  paymentBlockedReason: string | null
  availablePaymentChoices: ActivityPaymentChoice[]
  blockedPaymentChoices: ActivityPaymentChoice[]
  availablePaymentMethods: Array<'jsapi' | 'native_qr'>
}

export interface PublicBenefit {
  id: string
  code: string
  type: string
  name: string
  description: string
  remainingQuantity: number
  valueAmountMinor: number | null
  currency: string | null
  validFrom: string
  validUntil: string | null
  status: string
  display: JsonObject
}

export interface PublicActivityRegistration {
  publicId: string
  activityPublicId: string
  activityTitle: string
  startsAt: string
  partySize: number
  status: string
  paymentChoice: ActivityPaymentChoice
  paymentStatus: string
  totalFeeAmountMinor: number
  amountDueMinor: number
  paidAmountMinor: number
  currency: string
  paymentDueAt: string | null
  seatHoldExpiresAt: string | null
  paymentAvailability: 'available' | 'blocked' | 'not_required'
  paymentBlockedReason: string | null
  maskedContact: string
}

export interface PublicPortalSnapshot {
  features: PublicFeature[]
  membership: PublicMembership | null
  points: PublicPointEntry[]
  preferences: JsonObject
  content: PublicContentCard[]
  activities: PublicActivity[]
  benefits: PublicBenefit[]
  membershipTerms: PublicMembershipTerms | null
}

export interface RecommendationAnswer {
  partySize: number
  occasion: CustomerOccasion
  alcoholPreference: AlcoholPreference
  experienceLevel: ExperienceLevel
  serviceIntensity: ServiceIntensity
}

export interface RecommendedProduct {
  productId: string
  code: string
  name: string
  description: string | null
  imageUrl: string | null
  beverageFamily: string
  amountMinor: number
  separateAmountMinor: number | null
  savingsAmountMinor: number | null
  currency: string
  grossMarginBasisPoints: number
  tier: ExperienceLevel
  reason: string
  included: Array<{ name: string; quantity: number }>
}

export interface RecommendationResult {
  publicId: string
  answers: RecommendationAnswer
  recommendations: RecommendedProduct[]
  missingTiers: ExperienceLevel[]
}

export type RecommendationPolicyStatus = 'draft' | 'approved' | 'published' | 'retired'
export type RecommendationPolicyPublicationMode = 'legacy_unverified' | 'separated'

export interface RecommendationPolicyVersionView {
  publicId: string
  code: string
  version: number
  status: RecommendationPolicyStatus
  preferenceWeight: number
  sceneWeight: number
  marginWeight: number
  priorityWeight: number
  performanceWeight: number
  inventoryWeight: number
  capacityWeight: number
  minimumGrossMarginBasisPoints: number
  preferenceHalfLifeDays: number
  preferenceMaxAgeDays: number
  preferenceMinEffectiveScore: number
  preferenceMinConfidenceBasisPoints: number
  explanationTemplate: string
  draftReason: string
  approvalReason: string | null
  publicationReason: string | null
  publicationMode: RecommendationPolicyPublicationMode
  createdBy: string | null
  approvedBy: string | null
  publishedBy: string | null
  createdAt: string
  approvedAt: string | null
  publishedAt: string | null
  effectiveFrom: string | null
  effectiveUntil: string | null
}

export interface RecommendationPolicyConfigurationView {
  feature: {
    rolloutState: 'disabled' | 'shadow' | 'pilot' | 'enabled'
    reason: string
    effectiveFrom: string | null
    updatedAt: string
  }
  policies: RecommendationPolicyVersionView[]
}

export type CustomerProductRestrictionType = 'dislike' | 'allergy_or_cannot_consume'
export type PerformancePhaseCode = 'before_show' | 'acoustic' | 'band_live' | 'intermission' | 'after_show'

export interface CustomerProductRestrictionView {
  publicId: string
  productId: string
  productName: string
  restrictionType: CustomerProductRestrictionType
  createdAt: string
}

export interface PerformancePhaseEventView {
  publicId: string
  scheduleId: string
  performerStageName: string
  phaseCode: PerformancePhaseCode
  status: 'active' | 'ended' | 'cancelled'
  startedAt: string
  endedAt: string | null
  cancelledAt: string | null
}

export interface ExperienceCueDraft {
  code: string
  sequence: number
  triggerKind: 'elapsed' | 'performance' | 'manual' | 'product_state'
  triggerOffsetMinutes: number | null
  performancePhase: 'before_show' | 'acoustic' | 'band_live' | 'intermission' | 'after_show' | null
  actionKind: 'welcome' | 'service' | 'drink' | 'food' | 'music' | 'interaction' | 'checkin' | 'upsell' | 'farewell'
  station: 'host' | 'service' | 'bar' | 'cold_kitchen' | 'stage' | 'manager' | 'marketing'
  payload: JsonObject
  dueAt: string | null
}

export interface ExperiencePlanView {
  publicId: string
  state: 'planned' | 'active' | 'paused' | 'completed' | 'cancelled'
  partySize: number
  occasion: string
  alcoholPreference: string
  serviceIntensity: ServiceIntensity
  promiseSummary: string
  selectedProduct: { productId: string; name: string; amountMinor: number; currency: string } | null
  cues: Array<ExperienceCueDraft & { id: string; status: string }>
}

export interface ExperiencePlanIntentView {
  intentPublicId: string
  state: 'intent'
  recommendationPublicId: string
  selectedProduct: { productId: string; name: string; amountMinor: number; currency: string }
  plan: null
}

export interface CheckoutBasketLine {
  productId: string
  quantity: number
  note?: string | null
}

export interface CheckoutUpgradeOfferView {
  publicId: string
  ruleRevision: number
  sourceProduct: { productId: string; name: string; amountMinor: number }
  targetExperience: { name: string; totalAmountMinor: number; included: string[] }
  amountToAddMinor: number
  currency: string
  validUntil: string
  status: 'offered' | 'selected' | 'converted' | 'expired' | 'cancelled'
  prompt: { title: string; body: string; callToAction: string }
  ruleCopy: string
}

export interface SelectedCheckoutUpgrade {
  offerId: string
  upgradedItems: CheckoutBasketLine[]
  targetProductId: string
  targetAmountMinor: number
  currency: string
}

interface MembershipRow extends Record<string, unknown> {
  id: string
  member_no: string
  level: PublicMembership['level']
  lifecycle_stage: PublicMembership['lifecycleStage']
  points_balance: number
  growth_value: number
  pending_recovery_points: number
  redemption_status: PublicMembership['redemptionStatus']
  visit_count: number
  joined_at: string
  evaluation_window_months: number | null
  silver_upgrade_growth: number | null
  silver_retain_growth: number | null
  gold_upgrade_growth: number | null
  gold_retain_growth: number | null
  rolling_growth: string | number | null
  period_status: 'active' | 'grace' | null
  period_ends_at: string | null
  grace_ends_at: string | null
  expiring_points_30_days: string | number | null
  next_expiry_at: string | null
}

interface FeatureRow extends Record<string, unknown> {
  feature_code: string
  rollout_state: RolloutState
}

interface PointRow extends Record<string, unknown> {
  id: string
  entry_type: PublicPointEntry['entryType']
  points_delta: number
  balance_after: number
  source_type: PublicPointEntry['sourceKind']
  source_reference: string | null
  available_at: string
  expires_at: string | null
  policy_version: number | null
  occurred_at: string
}

interface GrowthRow extends Record<string, unknown> {
  id: string
  entry_type: PublicGrowthEntry['entryType']
  growth_delta: number
  balance_after: number
  source_kind: PublicGrowthEntry['sourceKind']
  source_reference: string | null
  available_at: string
  policy_version: number | null
  occurred_at: string
}

interface LoyaltyProcessingRow extends Record<string, unknown> {
  kind: PublicLoyaltyProcessingItem['kind']
  source_reference: string
  status: string
  occurred_at: string
  updated_at: string
}

interface CardRow extends Record<string, unknown> {
  code: string
  card_type: PublicContentCard['type']
  title: string
  summary: string
  image_url: string | null
  cta_label: string
  target_path: string
  priority: number
  audience_visibility: 'public' | 'member' | 'segment'
  audience_member_levels: string[]
  audience_lifecycle_stages: string[]
}

interface ActivityRow extends Record<string, unknown> {
  public_id: string
  activity_kind: string
  title: string
  summary: string
  cover_url: string | null
  starts_at: string
  ends_at: string
  assembly_location: string
  capacity: number
  registered_count: string | number
  fee_amount_minor: string | number
  deposit_amount_minor: string | number
  fee_basis: ActivityFeeBasis
  registration_payment_mode: ActivityPaymentMode
  payment_deadline_minutes: number
  payment_rule_text: string
  refund_policy_snapshot: JsonObject
  refund_policy_version: string
  refund_policy_summary: string
  currency: string
  points_reward: number
  status: 'published' | 'full'
  visibility: 'public' | 'member' | 'segment'
  audience_member_levels: string[]
  audience_lifecycle_stages: string[]
  safety_snapshot: JsonObject
  safety_policy_version: string
  safety_acknowledgement_text: string
  safety_requirements: string[]
  sales_copy: JsonObject
  activity_details: string
  included_items: string[]
  participation_requirements: string[]
  contact_instructions: string
  member_benefit_text: string | null
  registration_status: string | null
  activity_payment_authorized: boolean
}

interface BenefitPortalRow extends Record<string, unknown> {
  id: string
  benefit_code: string
  benefit_type: string
  status: string
  value_amount_minor: string | number | null
  currency: string | null
  benefit_snapshot: JsonObject
  quantity_total: number
  quantity_reserved: number
  quantity_redeemed: number
  valid_from: string
  valid_until: string | null
}

interface RecommendationProductRow extends Record<string, unknown> {
  id: string
  code: string
  name: string
  beverage_family: string
  description: string | null
  image_url: string | null
  amount_minor: string | number
  cost_amount_minor: string | number
  currency: string
  recommendation_priority: number
  recommendation_scene_tags: string[]
  recommendation_intent_tags: string[]
  component_list: unknown
  separate_amount_minor: string | number | null
  learned_preference_score: number
  performance_signal_basis_points: number
  inventory_signal_basis_points: number
  capacity_signal_basis_points: number
}

interface RecommendationSessionRow extends Record<string, unknown> {
  id: string
  public_id: string
  party_size: number
  occasion: string
  alcohol_preference: string
  experience_level: ExperienceLevel
  service_intensity: ServiceIntensity
}

interface CustomerProductRestrictionRow extends Record<string, unknown> {
  public_id: string
  product_id: string
  product_name: string
  restriction_type: CustomerProductRestrictionType
  created_at: string
}

interface PerformancePhaseEventRow extends Record<string, unknown> {
  public_id: string
  schedule_id: string
  performer_stage_name: string
  phase_code: PerformancePhaseCode
  status: PerformancePhaseEventView['status']
  started_at: string
  ended_at: string | null
  cancelled_at: string | null
}

interface RecommendationPolicyRow extends Record<string, unknown> {
  id: string
  public_id: string
  policy_code: string
  version: number
  preference_weight: number
  scene_weight: number
  margin_weight: number
  priority_weight: number
  performance_weight: number
  inventory_weight: number
  capacity_weight: number
  minimum_gross_margin_basis_points: number
}

interface RecommendationPolicyVersionRow extends RecommendationPolicyRow {
  status: RecommendationPolicyStatus
  preference_half_life_days: number
  preference_max_age_days: number
  preference_min_effective_score: number
  preference_min_confidence_basis_points: number
  explanation_template: string
  draft_reason: string
  approval_reason: string | null
  publication_reason: string | null
  publication_mode: RecommendationPolicyPublicationMode
  created_by: string | null
  approved_by: string | null
  published_by: string | null
  created_at: string
  approved_at: string | null
  published_at: string | null
  effective_from: string | null
  effective_until: string | null
}

interface PlanRow extends Record<string, unknown> {
  id: string
  public_id: string
  plan_state: ExperiencePlanView['state']
  party_size: number
  occasion: string
  alcohol_preference: string
  service_intensity: ServiceIntensity
  promise_summary: string
  selected_product_id: string | null
  recommendation_option_id: string | null
  selected_product_name_at_selection: string | null
  selected_amount_minor: string | number | null
  selected_currency: string | null
}

interface CueRow extends Record<string, unknown> {
  id: string
  cue_code: string
  sequence_no: number
  trigger_kind: ExperienceCueDraft['triggerKind']
  trigger_offset_minutes: number | null
  performance_phase: ExperienceCueDraft['performancePhase']
  action_kind: ExperienceCueDraft['actionKind']
  station: ExperienceCueDraft['station']
  action_payload: JsonObject
  due_at: string | null
  status: string
}

interface CheckoutUpgradeOfferRow extends Record<string, unknown> {
  id: string
  public_id: string
  rule_revision: number
  source_product_id: string
  source_name: string
  source_amount_minor: string | number
  target_name: string
  target_amount_minor: string | number
  amount_to_add_minor: string | number
  target_included_items: string[]
  currency: string
  valid_until: string
  status: CheckoutUpgradeOfferView['status']
  prompt_title: string
  prompt_body: string
  call_to_action: string
}

export class CustomerExperienceRequestError extends Error {
  constructor(message: string, readonly code = 'CUSTOMER_EXPERIENCE_REQUEST_INVALID', readonly statusCode = 400) {
    super(message)
    this.name = 'CustomerExperienceRequestError'
  }
}

export class CustomerExperienceRepository {
  constructor(
    private readonly transaction: ScopedTransaction,
    private readonly activityPaymentProviderConfigured = false,
  ) {}

  async publicPortal(customerId: string): Promise<PublicPortalSnapshot> {
    const [features, membership, preferences, cards, activities, benefits, membershipTerms] = await Promise.all([
      this.listFeatures(),
      this.findMembership(customerId),
      this.publicOwnedPreferences(customerId),
      this.listContentCards(),
      this.listActivities(customerId),
      this.listBenefits(customerId),
      this.currentMembershipTerms(),
    ])
    const points = membership === null ? [] : await this.listPointLedger(membership.id)
    const publicMembership = membership === null ? null : membershipView(membership)
    return {
      features: features.map(featureView),
      membership: publicMembership,
      points,
      preferences,
      content: cards.filter((card) => audienceAllows(
        card.audience_visibility,
        card.audience_member_levels,
        card.audience_lifecycle_stages,
        publicMembership,
      )).map(cardView),
      activities: activities
        .filter((activity) => audienceAllows(
          activity.visibility,
          activity.audience_member_levels,
          activity.audience_lifecycle_stages,
          publicMembership,
        ))
        .map((activity) => activityView(activity, this.activityPaymentProviderConfigured)),
      benefits: benefits.map(benefitPortalView),
      membershipTerms,
    }
  }

  private async currentMembershipTerms(): Promise<PublicMembershipTerms | null> {
    const result = await this.transaction.query<{
      version: number; title: string; summary: string; content: string; effective_from: string
    }>(`
      SELECT version,title,summary,content,effective_from::text
      FROM mbox.membership_terms_versions
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND status='published'
        AND effective_from<=clock_timestamp()
        AND (effective_until IS NULL OR effective_until>clock_timestamp())
      ORDER BY effective_from DESC,version DESC,id DESC LIMIT 1
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId])
    const row = result.rows[0]
    return row===undefined ? null : {
      version: Number(row.version), title: row.title, summary: row.summary,
      content: row.content, effectiveFrom: row.effective_from,
    }
  }

  async publicLoyalty(customerId: string): Promise<PublicLoyaltySnapshot> {
    const membership = await this.findMembership(customerId)
    if (membership === null) return { membership: null, points: [], growth: [], processing: [] }
    const points = await this.listPointLedger(membership.id)
    const growth = await this.listGrowthLedger(membership.id)
    const processing = await this.listLoyaltyProcessing(customerId, membership.id)
    return { membership: membershipView(membership), points, growth, processing }
  }

  async publicActivities(customerId: string | null): Promise<PublicActivity[]> {
    const membership = customerId === null ? null : await this.findMembership(customerId)
    const publicMembership = membership === null ? null : membershipView(membership)
    return (await this.listActivities(customerId))
      .filter((activity) => audienceAllows(
        activity.visibility,
        activity.audience_member_levels,
        activity.audience_lifecycle_stages,
        publicMembership,
      ))
      .map((activity) => activityView(activity, this.activityPaymentProviderConfigured))
  }

  async publicActivity(customerId: string | null, publicId: string): Promise<PublicActivity> {
    const membership = customerId === null ? null : await this.findMembership(customerId)
    const publicMembership = membership === null ? null : membershipView(membership)
    const activity = (await this.listActivities(customerId, publicId))
      .filter((entry) => audienceAllows(
        entry.visibility,
        entry.audience_member_levels,
        entry.audience_lifecycle_stages,
        publicMembership,
      ))
      .map((activity) => activityView(activity, this.activityPaymentProviderConfigured))[0]
    if (!activity) throw new CustomerExperienceRequestError('活动不存在或当前不可见', 'ACTIVITY_NOT_FOUND', 404)
    return activity
  }

  async publicActivityRegistrations(customerId: string): Promise<PublicActivityRegistration[]> {
    const result = await this.transaction.query<{
      public_id: string
      activity_public_id: string
      activity_title: string
      starts_at: string
      party_size: number
      status: string
      payment_choice: ActivityPaymentChoice
      payment_status: string
      fee_amount_minor: string | number
      amount_due_minor: string | number
      paid_amount_minor: string | number
      currency: string
      payment_due_at: string | null
      seat_hold_expires_at: string | null
      registration_payment_mode: ActivityPaymentMode
      activity_payment_authorized: boolean
      masked_contact: string
    }>(`
      WITH RECURSIVE ancestry AS (
        SELECT id, merged_into_customer_id FROM mbox.customers
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
        UNION ALL
        SELECT parent.id, parent.merged_into_customer_id
        FROM mbox.customers parent
        JOIN ancestry child ON child.merged_into_customer_id=parent.id
        WHERE parent.tenant_id=$1::uuid AND parent.store_id=$2::uuid
      ), canonical AS (
        SELECT id FROM ancestry WHERE merged_into_customer_id IS NULL LIMIT 1
      ), family AS (
        SELECT id FROM canonical
        UNION ALL
        SELECT child.id FROM mbox.customers child JOIN family parent ON child.merged_into_customer_id=parent.id
        WHERE child.tenant_id=$1::uuid AND child.store_id=$2::uuid
      )
      SELECT registration.public_id, activity.public_id AS activity_public_id,
        activity.title AS activity_title, activity.starts_at::text,
        registration.party_size, registration.status, registration.payment_choice,
        registration.payment_status, registration.fee_amount_minor,
        registration.amount_due_minor, registration.paid_amount_minor,
        registration.currency, registration.payment_due_at::text,
        registration.seat_hold_expires_at::text, activity.registration_payment_mode,
        COALESCE(current_contact.masked_contact,'已清除') AS masked_contact,
        COALESCE((SELECT policy.online_payment_enabled
          FROM mbox.store_commerce_policies policy
          WHERE policy.tenant_id=activity.tenant_id AND policy.store_id=activity.store_id), false)
        AND EXISTS (
          SELECT 1 FROM mbox.customer_experience_features feature
          WHERE feature.tenant_id=activity.tenant_id AND feature.store_id=activity.store_id
            AND feature.feature_code='community.activity.payment'
            AND feature.rollout_state IN ('pilot','enabled')
            AND (feature.effective_from IS NULL OR feature.effective_from <= clock_timestamp())
            AND (feature.effective_until IS NULL OR feature.effective_until > clock_timestamp())
        ) AS activity_payment_authorized
      FROM mbox.community_activity_registrations registration
      JOIN mbox.community_activities activity
        ON activity.tenant_id=registration.tenant_id AND activity.store_id=registration.store_id
       AND activity.id=registration.activity_id
      LEFT JOIN LATERAL (
        SELECT contact.masked_contact
        FROM mbox.community_activity_registration_contact_versions contact
        WHERE contact.tenant_id=registration.tenant_id AND contact.store_id=registration.store_id
          AND contact.registration_id=registration.id
          AND contact.registration_cycle=registration.registration_cycle
        ORDER BY contact.version DESC LIMIT 1
      ) current_contact ON true
      WHERE registration.tenant_id=$1::uuid AND registration.store_id=$2::uuid
        AND registration.customer_id IN (SELECT id FROM family)
      ORDER BY registration.registered_at DESC, registration.id DESC
      LIMIT 100
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, customerId])
    return result.rows.map((row) => {
      const paymentAvailability = publicActivityRegistrationPaymentAvailability(
        row.payment_status,
        this.activityPaymentProviderConfigured && row.activity_payment_authorized,
      )
      return {
        publicId: row.public_id,
        activityPublicId: row.activity_public_id,
        activityTitle: row.activity_title,
        startsAt: row.starts_at,
        partySize: row.party_size,
        status: row.status,
        paymentChoice: row.payment_choice,
        paymentStatus: row.payment_status,
        totalFeeAmountMinor: money(row.fee_amount_minor, 'activity registration fee'),
        amountDueMinor: money(row.amount_due_minor, 'activity registration amount due'),
        paidAmountMinor: money(row.paid_amount_minor, 'activity registration paid amount'),
        currency: row.currency,
        paymentDueAt: row.payment_due_at,
        seatHoldExpiresAt: row.seat_hold_expires_at,
        paymentAvailability: paymentAvailability.availability,
        paymentBlockedReason: paymentAvailability.blockedReason,
        maskedContact: row.masked_contact,
      }
    })
  }

  async findMembership(customerId: string): Promise<MembershipRow | null> {
    const result = await this.transaction.query<MembershipRow>(`
      WITH RECURSIVE ancestry AS (
        SELECT id, merged_into_customer_id FROM mbox.customers
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
        UNION ALL
        SELECT parent.id, parent.merged_into_customer_id
        FROM mbox.customers parent JOIN ancestry child ON child.merged_into_customer_id=parent.id
        WHERE parent.tenant_id=$1::uuid AND parent.store_id=$2::uuid
      ), canonical AS (
        SELECT id FROM ancestry WHERE merged_into_customer_id IS NULL LIMIT 1
      ), family AS (
        SELECT id FROM canonical
        UNION ALL
        SELECT child.id FROM mbox.customers child JOIN family parent ON child.merged_into_customer_id=parent.id
        WHERE child.tenant_id=$1::uuid AND child.store_id=$2::uuid
      )
      SELECT membership.id, membership.member_no, account.current_tier AS level,
        membership.lifecycle_stage, account.available_points AS points_balance,
        account.growth_value, account.pending_recovery_points, account.redemption_status,
        membership.visit_count, membership.joined_at::text,
        policy.evaluation_window_months, policy.silver_upgrade_growth,
        policy.silver_retain_growth, policy.gold_upgrade_growth, policy.gold_retain_growth,
        CASE WHEN policy.id IS NULL THEN NULL ELSE COALESCE(rolling.rolling_growth,0)::bigint END AS rolling_growth,
        period.status AS period_status, period.ends_at::text AS period_ends_at,
        period.grace_ends_at::text AS grace_ends_at,
        expiry.expiring_points_30_days, expiry.next_expiry_at::text
      FROM mbox.customer_memberships membership
      JOIN mbox.loyalty_accounts account
        ON account.tenant_id=membership.tenant_id AND account.store_id=membership.store_id
       AND account.membership_id=membership.id
      LEFT JOIN LATERAL (
        SELECT tier_policy.id, tier_policy.evaluation_window_months,
          tier_policy.silver_upgrade_growth, tier_policy.silver_retain_growth,
          tier_policy.gold_upgrade_growth, tier_policy.gold_retain_growth
        FROM mbox.loyalty_tier_policy_versions tier_policy
        WHERE tier_policy.tenant_id=membership.tenant_id AND tier_policy.store_id=membership.store_id
          AND tier_policy.status='published' AND tier_policy.effective_from<=clock_timestamp()
          AND (tier_policy.effective_until IS NULL OR tier_policy.effective_until>clock_timestamp())
        ORDER BY tier_policy.effective_from DESC,tier_policy.version DESC,tier_policy.id DESC LIMIT 1
      ) policy ON true
      LEFT JOIN LATERAL (
        SELECT SUM(ledger.growth_delta)::bigint AS rolling_growth
        FROM mbox.loyalty_growth_ledger ledger
        WHERE policy.id IS NOT NULL
          AND ledger.tenant_id=membership.tenant_id AND ledger.store_id=membership.store_id
          AND ledger.membership_id=membership.id
          AND ledger.occurred_at>=clock_timestamp()-make_interval(months=>policy.evaluation_window_months)
          AND ledger.occurred_at<=clock_timestamp()
      ) rolling ON true
      LEFT JOIN LATERAL (
        SELECT tier_period.status,tier_period.ends_at,tier_period.grace_ends_at
        FROM mbox.membership_tier_periods tier_period
        WHERE tier_period.tenant_id=membership.tenant_id AND tier_period.store_id=membership.store_id
          AND tier_period.membership_id=membership.id AND tier_period.status IN ('active','grace')
        ORDER BY tier_period.starts_at DESC,tier_period.id DESC LIMIT 1
      ) period ON true
      LEFT JOIN LATERAL (
        SELECT SUM(lot.remaining_points)::bigint AS expiring_points_30_days,
          MIN(lot.expires_at) AS next_expiry_at
        FROM mbox.loyalty_point_lots lot
        WHERE lot.tenant_id=membership.tenant_id AND lot.store_id=membership.store_id
          AND lot.membership_id=membership.id AND lot.status='available' AND lot.remaining_points>0
          AND lot.expires_at>clock_timestamp() AND lot.expires_at<=clock_timestamp()+interval '30 days'
      ) expiry ON true
      WHERE membership.tenant_id=$1::uuid AND membership.store_id=$2::uuid
        AND membership.customer_id IN (SELECT id FROM family) AND membership.status='active'
      ORDER BY membership.joined_at, membership.id LIMIT 1
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, customerId])
    return result.rows[0] ?? null
  }

  private async canonicalCustomerId(customerId: string): Promise<string> {
    const result = await this.transaction.query<{ id: string }>(`
      WITH RECURSIVE ancestry AS (
        SELECT id, merged_into_customer_id FROM mbox.customers
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
        UNION ALL
        SELECT parent.id, parent.merged_into_customer_id
        FROM mbox.customers parent JOIN ancestry child ON child.merged_into_customer_id=parent.id
        WHERE parent.tenant_id=$1::uuid AND parent.store_id=$2::uuid
      )
      SELECT id FROM ancestry WHERE merged_into_customer_id IS NULL LIMIT 1
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, customerId])
    const row = result.rows[0]
    if (!row) throw new CustomerExperienceRequestError('客户身份已失效，请重新进入', 'CUSTOMER_IDENTITY_UNAVAILABLE', 403)
    return row.id
  }

  private async publicOwnedPreferences(customerId: string): Promise<JsonObject> {
    const result = await this.transaction.query<{ preference_key: string; preference_value: unknown }>(`
      WITH RECURSIVE ancestry AS (
        SELECT id, merged_into_customer_id FROM mbox.customers
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
        UNION ALL
        SELECT parent.id, parent.merged_into_customer_id
        FROM mbox.customers parent JOIN ancestry child ON child.merged_into_customer_id=parent.id
        WHERE parent.tenant_id=$1::uuid AND parent.store_id=$2::uuid
      ), canonical AS (
        SELECT id FROM ancestry WHERE merged_into_customer_id IS NULL LIMIT 1
      ), family AS (
        SELECT id FROM canonical
        UNION ALL
        SELECT child.id FROM mbox.customers child JOIN family parent ON child.merged_into_customer_id=parent.id
        WHERE child.tenant_id=$1::uuid AND child.store_id=$2::uuid
      )
      SELECT DISTINCT ON (preference.preference_key)
        preference.preference_key, preference.preference_value
      FROM mbox.customer_preferences preference
      WHERE preference.tenant_id=$1::uuid AND preference.store_id=$2::uuid
        AND preference.customer_id IN (SELECT id FROM family)
        AND preference.preference_key = ANY($4::text[])
      ORDER BY preference.preference_key, preference.observed_at DESC, preference.id DESC
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      customerId,
      ['preferredAlcohol', 'serviceIntensity'],
    ])
    return Object.fromEntries(result.rows.map((row) => [row.preference_key, row.preference_value])) as JsonObject
  }

  async enrollMembership(customerId: string, memberNo: string): Promise<{ membership: PublicMembership; created: boolean }> {
    await this.transaction.query(`
      SELECT id FROM mbox.customers
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid
        AND id = $3::uuid AND status = 'active'
      FOR UPDATE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, customerId])
    const existing = await this.findMembership(customerId)
    if (existing !== null) return { membership: membershipView(existing), created: false }
    const inserted = await this.transaction.query<MembershipRow>(`
      WITH membership AS (
        INSERT INTO mbox.customer_memberships (
          tenant_id, store_id, customer_id, member_no
        ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4)
        RETURNING id, tenant_id, store_id, customer_id, member_no,
          lifecycle_stage, visit_count, joined_at
      ), account AS (
        INSERT INTO mbox.loyalty_accounts (
          tenant_id, store_id, membership_id, customer_id
        ) SELECT tenant_id, store_id, id, customer_id FROM membership
        RETURNING membership_id, available_points, growth_value,
          pending_recovery_points, current_tier, redemption_status
      )
      SELECT membership.id, membership.member_no, account.current_tier AS level,
        membership.lifecycle_stage, account.available_points AS points_balance,
        account.growth_value, account.pending_recovery_points, account.redemption_status,
        membership.visit_count, membership.joined_at::text,
        NULL::smallint AS evaluation_window_months,
        NULL::integer AS silver_upgrade_growth,
        NULL::integer AS silver_retain_growth,
        NULL::integer AS gold_upgrade_growth,
        NULL::integer AS gold_retain_growth,
        NULL::bigint AS rolling_growth,
        NULL::text AS period_status,
        NULL::text AS period_ends_at,
        NULL::text AS grace_ends_at,
        NULL::bigint AS expiring_points_30_days,
        NULL::text AS next_expiry_at
      FROM membership JOIN account ON account.membership_id=membership.id
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, customerId, memberNo])
    const row = requiredRow(inserted.rows[0], 'membership')
    await this.transaction.query(`
      INSERT INTO mbox.customer_events (
        tenant_id, store_id, customer_id, event_type, event_data
      ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'membership.joined', $4::jsonb)
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      customerId,
      JSON.stringify({ memberNo }),
    ])
    return { membership: membershipView(row), created: true }
  }

  async registerActivity(input: Readonly<{
    activityPublicId: string
    customerId: string
    partySize: number
    protectedContact: ProtectedActivityRegistrationContact
    termsAcknowledged: boolean
    acknowledgedSafetyPolicyVersion: string
    acknowledgedRefundPolicyVersion: string
    paymentChoice: ActivityPaymentChoice
    paymentMethod: Extract<PaymentMethod, 'jsapi' | 'native_qr'>
    paymentPublicId: string
    publicId: string
    idempotencyKey: string
  }>): Promise<{
    publicId: string
    status: string
    paymentRequired: boolean
    paymentChoice: ActivityPaymentChoice
    totalFeeAmountMinor: number
    amountDueMinor: number
    remainingAmountMinor: number
    paymentDueAt: string | null
    seatHoldExpiresAt: string | null
    currency: string
    paymentRuleText: string
    paymentPublicId: string | null
  }> {
    assertProtectedActivityRegistrationContact(input.protectedContact)
    const activity = await this.transaction.query<ActivityRow & { id: string }>(`
      SELECT activity.id, activity.public_id, activity.activity_kind, activity.title,
        activity.summary, activity.cover_url, activity.starts_at::text, activity.ends_at::text,
        activity.assembly_location, activity.capacity, activity.fee_amount_minor,
        activity.deposit_amount_minor, activity.fee_basis, activity.registration_payment_mode,
        activity.payment_deadline_minutes, activity.payment_rule_text,
        activity.refund_policy_snapshot, activity.refund_policy_version,
        activity.refund_policy_summary, activity.currency, activity.points_reward,
        activity.status, activity.visibility, activity.audience_member_levels,
        activity.audience_lifecycle_stages,
        activity.safety_snapshot, activity.safety_policy_version,
        activity.safety_acknowledgement_text, activity.safety_requirements,
        activity.sales_copy, activity.activity_details, activity.included_items,
        activity.participation_requirements, activity.contact_instructions,
        activity.member_benefit_text, NULL::text AS registration_status,
        COALESCE((SELECT policy.online_payment_enabled
          FROM mbox.store_commerce_policies policy
          WHERE policy.tenant_id=activity.tenant_id AND policy.store_id=activity.store_id), false)
        AND EXISTS (
          SELECT 1 FROM mbox.customer_experience_features feature
          WHERE feature.tenant_id=activity.tenant_id AND feature.store_id=activity.store_id
            AND feature.feature_code='community.activity.payment'
            AND feature.rollout_state IN ('pilot','enabled')
            AND (feature.effective_from IS NULL OR feature.effective_from <= clock_timestamp())
            AND (feature.effective_until IS NULL OR feature.effective_until > clock_timestamp())
        ) AS activity_payment_authorized,
        COALESCE((
          SELECT sum(registration.party_size)
          FROM mbox.community_activity_registrations AS registration
          WHERE registration.tenant_id = activity.tenant_id
            AND registration.store_id = activity.store_id
            AND registration.activity_id = activity.id
            AND registration.status IN ('reserved', 'payment_pending', 'confirmed', 'checked_in')
        ), 0)::text AS registered_count
      FROM mbox.community_activities AS activity
      WHERE activity.tenant_id = $1::uuid AND activity.store_id = $2::uuid
        AND activity.public_id = $3 AND activity.status IN ('published', 'full')
        AND activity.ends_at > clock_timestamp()
      FOR UPDATE OF activity
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, input.activityPublicId])
    const row = activity.rows[0]
    if (!row) throw new CustomerExperienceRequestError('这个活动已结束或暂停报名', 'ACTIVITY_UNAVAILABLE', 409)
    const registrationCustomerId = await this.canonicalCustomerId(input.customerId)
    const membership = await this.findMembership(input.customerId)
    const publicMembership = membership === null ? null : membershipView(membership)
    if (!audienceAllows(
      row.visibility,
      row.audience_member_levels,
      row.audience_lifecycle_stages,
      publicMembership,
    )) {
      throw new CustomerExperienceRequestError('这个活动当前不在您的可报名范围内', 'ACTIVITY_AUDIENCE_DENIED', 403)
    }
    const termsAcknowledgement = serverActivityTermsAcknowledgement(
      row.safety_policy_version,
      row.refund_policy_version,
      input.acknowledgedSafetyPolicyVersion,
      input.acknowledgedRefundPolicyVersion,
      input.termsAcknowledged,
    )
    const registered = integer(row.registered_count, 'registered count')
    const hasCapacity = row.status !== 'full' && registered + input.partySize <= row.capacity
    const feeUnitAmountMinor = money(row.fee_amount_minor, 'activity fee')
    const depositUnitAmountMinor = money(row.deposit_amount_minor, 'activity deposit')
    const multiplier = row.fee_basis === 'per_person' ? input.partySize : 1
    const totalFeeAmountMinor = feeUnitAmountMinor * multiplier
    const depositAmountMinor = depositUnitAmountMinor * multiplier
    const payment = resolveActivityRegistrationPayment(row.registration_payment_mode, input.paymentChoice, {
      totalFeeAmountMinor,
      depositAmountMinor,
    })
    if (hasCapacity && payment.amountDueMinor > 0
      && (!this.activityPaymentProviderConfigured || !row.activity_payment_authorized)) {
      throw new CustomerExperienceRequestError(
        '活动收款尚未接入权威支付对象，本次没有创建待付款报名或占用名额',
        'ACTIVITY_PAYMENT_AUTHORITY_NOT_CONFIGURED',
        503,
      )
    }
    const status = hasCapacity ? (payment.amountDueMinor > 0 ? 'payment_pending' : 'confirmed') : 'waitlisted'
    const effectiveChoice: ActivityPaymentChoice = hasCapacity ? payment.choice : 'none'
    const amountDueMinor = hasCapacity ? payment.amountDueMinor : 0
    const paymentStatus = amountDueMinor > 0 ? 'pending' : 'not_required'
    const existing = await this.transaction.query<{
      id: string
      public_id: string
      status: string
      paid_amount_minor: string | number
      payment_id: string | null
    }>(`
      SELECT id, public_id, status, paid_amount_minor, payment_id
      FROM mbox.community_activity_registrations
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid
        AND activity_id=$3::uuid AND customer_id=$4::uuid
      FOR UPDATE
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      row.id,
      registrationCustomerId,
    ])
    const previous = existing.rows[0]
    if (previous && (previous.status !== 'cancelled'
      || money(previous.paid_amount_minor, 'registration paid amount') !== 0
      || previous.payment_id !== null)) {
      throw new CustomerExperienceRequestError('您已有这个活动的有效报名', 'ACTIVITY_ALREADY_REGISTERED', 409)
    }
    const registrationValues = [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      previous?.id ?? input.publicId,
      registrationCustomerId,
      membership?.id ?? null,
      input.partySize,
      status,
      effectiveChoice,
      paymentStatus,
      totalFeeAmountMinor,
      amountDueMinor,
      row.currency,
      JSON.stringify(termsAcknowledgement.evidence),
      input.idempotencyKey,
      JSON.stringify({
        policyVersion: row.refund_policy_version,
        summary: row.refund_policy_summary,
      }),
      row.payment_deadline_minutes,
      termsAcknowledgement.safetyPolicyVersion,
      termsAcknowledgement.refundPolicyVersion,
      termsAcknowledgement.source,
      payment.choice,
      payment.amountDueMinor > 0 ? input.paymentMethod : null,
      payment.amountDueMinor,
    ]
    const inserted = previous
      ? await this.transaction.query<{
        id: string
        public_id: string
        status: string
        registration_cycle: number
        payment_due_at: string | null
        seat_hold_expires_at: string | null
      }>(`
        UPDATE mbox.community_activity_registrations
        SET membership_id=$5::uuid, party_size=$6, status=$7,
          registration_cycle=registration_cycle+1,
          payment_choice=$8, payment_status=$9, fee_amount_minor=$10::bigint,
          amount_due_minor=$11::bigint, paid_amount_minor=0, currency=$12,
          payment_id=NULL,contact_snapshot=NULL,
          safety_acknowledgement=$13::jsonb, idempotency_key=$14,
          registered_at=clock_timestamp(),
          payment_due_at=CASE WHEN $11::bigint > 0 THEN clock_timestamp()+make_interval(mins=>$16) ELSE NULL END,
          seat_hold_expires_at=CASE WHEN $11::bigint > 0 THEN clock_timestamp()+make_interval(mins=>$16) ELSE NULL END,
          refund_policy_snapshot=$15::jsonb,
          acknowledged_safety_policy_version=$17,
          acknowledged_refund_policy_version=$18,
          terms_acknowledged_at=clock_timestamp(),
          terms_acknowledgement_source=$19,
          requested_payment_choice=$20,requested_payment_method=$21,
          requested_amount_due_minor=$22::bigint,
          checked_in_at=NULL, cancelled_at=NULL
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
          AND customer_id=$4::uuid AND status='cancelled'
          AND paid_amount_minor=0 AND payment_id IS NULL
        RETURNING id, public_id, status, registration_cycle,
          payment_due_at::text, seat_hold_expires_at::text
      `, registrationValues)
      : await this.transaction.query<{
        id: string
        public_id: string
        status: string
        registration_cycle: number
        payment_due_at: string | null
        seat_hold_expires_at: string | null
      }>(`
        INSERT INTO mbox.community_activity_registrations (
          tenant_id, store_id, public_id, activity_id, customer_id, membership_id,
          party_size, status, payment_choice, payment_status, fee_amount_minor,
          amount_due_minor, paid_amount_minor, currency,
          safety_acknowledgement, idempotency_key, payment_due_at,
          seat_hold_expires_at, refund_policy_snapshot,
          acknowledged_safety_policy_version, acknowledged_refund_policy_version,
          terms_acknowledged_at, terms_acknowledgement_source,
          requested_payment_choice,requested_payment_method,requested_amount_due_minor
        ) VALUES (
          $1::uuid, $2::uuid, $3, $23::uuid, $4::uuid, $5::uuid,
          $6, $7, $8, $9, $10::bigint, $11::bigint, 0, $12,
          $13::jsonb, $14,
          CASE WHEN $11::bigint > 0 THEN clock_timestamp()+make_interval(mins=>$16) ELSE NULL END,
          CASE WHEN $11::bigint > 0 THEN clock_timestamp()+make_interval(mins=>$16) ELSE NULL END,
          $15::jsonb, $17, $18, clock_timestamp(), $19,
          $20,$21,$22::bigint
        )
        RETURNING id, public_id, status, registration_cycle,
          payment_due_at::text, seat_hold_expires_at::text
      `, [...registrationValues, row.id])
    const registration = requiredRow(inserted.rows[0], 'activity registration')
    const inactivatedContact = await this.transaction.query<{ id: string }>(`
      UPDATE mbox.community_activity_registration_contact_versions
      SET status='inactive',inactivated_at=clock_timestamp()
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid
        AND registration_id=$3::uuid AND status='active'
      RETURNING id
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, registration.id])
    await this.transaction.query(`
      INSERT INTO mbox.community_activity_registration_contact_versions(
        tenant_id,store_id,public_id,registration_id,registration_cycle,version,status,
        supersedes_contact_version_id,contact_type,contact_hash,encrypted_contact,
        encryption_key_id,masked_contact,contact_source,created_by_customer_id,
        idempotency_key,request_sha256
      ) VALUES (
        $1::uuid,$2::uuid,$3,$4::uuid,$5,1,'active',$6::uuid,$7,$8,$9::bytea,$10,$11,$12,
        $13::uuid,$14,$15
      )
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      `ACV${randomUUID().replaceAll('-', '').toUpperCase()}`,
      registration.id,
      registration.registration_cycle,
      inactivatedContact.rows[0]?.id ?? null,
      input.protectedContact.contactType,
      input.protectedContact.contactHash,
      Buffer.from(input.protectedContact.encryptedContact, 'base64'),
      input.protectedContact.encryptionKeyId,
      input.protectedContact.maskedContact,
      input.protectedContact.source,
      registrationCustomerId,
      input.idempotencyKey,
      createHash('sha256').update(JSON.stringify({
        contactType: input.protectedContact.contactType,
        contactHash: input.protectedContact.contactHash,
        contactSource: input.protectedContact.source,
      })).digest('hex'),
    ])
    const authoritativePayment = amountDueMinor > 0
      ? await new PaymentRepository(this.transaction).createForActivityRegistration({
          activityRegistrationId: registration.id,
          publicId: input.paymentPublicId,
          method: input.paymentMethod,
          amountMinor: amountDueMinor,
          currency: row.currency,
        })
      : null
    return {
      publicId: registration.public_id,
      status: registration.status,
      paymentRequired: registration.status === 'payment_pending',
      paymentChoice: effectiveChoice,
      totalFeeAmountMinor,
      amountDueMinor,
      remainingAmountMinor: Math.max(0, totalFeeAmountMinor - amountDueMinor),
      paymentDueAt: registration.payment_due_at,
      seatHoldExpiresAt: registration.seat_hold_expires_at,
      currency: row.currency,
      paymentRuleText: row.payment_rule_text,
      paymentPublicId: authoritativePayment?.publicId ?? null,
    }
  }

  async cancelActivityRegistration(input: Readonly<{
    registrationPublicId: string
    customerId: string
    reason: string
  }>): Promise<{ publicId: string; status: 'cancelled' }> {
    const result = await this.transaction.query<{ public_id: string; payment_id: string | null }>(`
      WITH RECURSIVE ancestry AS (
        SELECT id, merged_into_customer_id FROM mbox.customers
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$4::uuid
        UNION ALL
        SELECT parent.id, parent.merged_into_customer_id
        FROM mbox.customers parent JOIN ancestry child ON child.merged_into_customer_id=parent.id
        WHERE parent.tenant_id=$1::uuid AND parent.store_id=$2::uuid
      ), canonical AS (
        SELECT id FROM ancestry WHERE merged_into_customer_id IS NULL LIMIT 1
      ), family AS (
        SELECT id FROM canonical
        UNION ALL
        SELECT child.id FROM mbox.customers child JOIN family parent ON child.merged_into_customer_id=parent.id
        WHERE child.tenant_id=$1::uuid AND child.store_id=$2::uuid
      )
      UPDATE mbox.community_activity_registrations
      SET status = 'cancelled', cancelled_at = clock_timestamp(),
        payment_status = CASE WHEN payment_status = 'pending' THEN 'expired' ELSE payment_status END,
        amount_due_minor = 0
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid
        AND public_id = $3 AND customer_id IN (SELECT id FROM family)
        AND status IN ('reserved', 'payment_pending', 'confirmed', 'waitlisted')
        AND payment_status IN ('not_required', 'pending', 'expired')
        AND (
          payment_id IS NULL
          OR EXISTS (
            SELECT 1 FROM mbox.payments payment
            WHERE payment.tenant_id=$1::uuid AND payment.store_id=$2::uuid
              AND payment.id=community_activity_registrations.payment_id
              AND payment.status IN ('created','pending')
              AND NOT EXISTS (
                SELECT 1 FROM mbox.payment_provider_actions provider_action
                WHERE provider_action.tenant_id=payment.tenant_id
                  AND provider_action.store_id=payment.store_id
                  AND provider_action.payment_id=payment.id
              )
          )
        )
      RETURNING public_id, payment_id
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.registrationPublicId,
      input.customerId,
    ])
    const row = result.rows[0]
    if (row?.payment_id !== null && row?.payment_id !== undefined) {
      const closed = await this.transaction.query(`
        UPDATE mbox.payments payment
        SET status='closed', provider_snapshot=provider_snapshot ||
          jsonb_build_object('providerStatus','closed_before_provider_action'),
          updated_at=clock_timestamp()
        WHERE payment.tenant_id=$1::uuid AND payment.store_id=$2::uuid AND payment.id=$3::uuid
          AND payment.status IN ('created','pending')
          AND NOT EXISTS (
            SELECT 1 FROM mbox.payment_provider_actions provider_action
            WHERE provider_action.tenant_id=payment.tenant_id
              AND provider_action.store_id=payment.store_id
              AND provider_action.payment_id=payment.id
          )
      `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, row.payment_id])
      if (closed.rowCount !== 1) throw new CustomerExperienceRequestError(
        '支付状态正在变化，请先查单后再处理', 'ACTIVITY_PAYMENT_RESULT_UNKNOWN', 409,
      )
    }
    if (!row) {
      const current = await this.transaction.query<{
        public_id: string
        status: string
        payment_status: string
        paid_amount_minor: string | number
        payment_id: string | null
        authoritative_payment_status: string | null
        provider_action_state: string | null
      }>(`
        WITH RECURSIVE ancestry AS (
          SELECT id, merged_into_customer_id FROM mbox.customers
          WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$4::uuid
          UNION ALL
          SELECT parent.id, parent.merged_into_customer_id
          FROM mbox.customers parent JOIN ancestry child ON child.merged_into_customer_id=parent.id
          WHERE parent.tenant_id=$1::uuid AND parent.store_id=$2::uuid
        ), canonical AS (
          SELECT id FROM ancestry WHERE merged_into_customer_id IS NULL LIMIT 1
        ), family AS (
          SELECT id FROM canonical
          UNION ALL
          SELECT child.id FROM mbox.customers child JOIN family parent ON child.merged_into_customer_id=parent.id
          WHERE child.tenant_id=$1::uuid AND child.store_id=$2::uuid
        )
        SELECT registration.public_id, registration.status, registration.payment_status,
          registration.paid_amount_minor, registration.payment_id,
          payment.status AS authoritative_payment_status,
          provider_action.state AS provider_action_state
        FROM mbox.community_activity_registrations registration
        LEFT JOIN mbox.payments payment
          ON payment.tenant_id=registration.tenant_id AND payment.store_id=registration.store_id
         AND payment.id=registration.payment_id
        LEFT JOIN mbox.payment_provider_actions provider_action
          ON provider_action.tenant_id=payment.tenant_id AND provider_action.store_id=payment.store_id
         AND provider_action.payment_id=payment.id
        WHERE registration.tenant_id=$1::uuid AND registration.store_id=$2::uuid
          AND registration.public_id=$3 AND registration.customer_id IN (SELECT id FROM family)
        FOR UPDATE OF registration
      `, [
        this.transaction.scope.tenantId,
        this.transaction.scope.storeId,
        input.registrationPublicId,
        input.customerId,
      ])
      const registration = current.rows[0]
      if (!registration) {
        throw new CustomerExperienceRequestError('没有找到可取消的本人报名', 'ACTIVITY_REGISTRATION_NOT_FOUND', 404)
      }
      if (registration.status === 'cancelled') return { publicId: registration.public_id, status: 'cancelled' }
      if (money(registration.paid_amount_minor, 'registration paid amount') > 0
        || registration.payment_status === 'paid'
        || ['succeeded','partially_refunded','refunded'].includes(registration.authoritative_payment_status ?? '')) {
        throw new CustomerExperienceRequestError(
          '已付款报名不能直接取消，必须由店长发起、收银复核退款后再关闭名额',
          'ACTIVITY_PAID_CANCELLATION_REQUIRES_REFUND_WORKFLOW',
          409,
        )
      }
      if (registration.provider_action_state !== null
        || ['created','pending'].includes(registration.authoritative_payment_status ?? '')) {
        throw new CustomerExperienceRequestError(
          '支付结果正在处理或暂时未知，请先查单，不能直接释放名额',
          'ACTIVITY_PAYMENT_RESULT_UNKNOWN',
          409,
        )
      }
      throw new CustomerExperienceRequestError('当前报名状态不能由顾客取消', 'ACTIVITY_REGISTRATION_NOT_CANCELLABLE', 409)
    }
    return { publicId: row.public_id, status: 'cancelled' }
  }

  async createRecommendationSession(input: Readonly<{
    context: TableExperienceContext
    answers: RecommendationAnswer
    publicId: string
  }>): Promise<RecommendationResult> {
    if (!await this.featureEnabled('recommendation.engine')) {
      throw new CustomerExperienceRequestError(
        '门店推荐功能尚未开放试点，原点单流程不受影响',
        'RECOMMENDATION_FEATURE_NOT_ENABLED',
        503,
      )
    }
    const policy = await this.currentRecommendationPolicy()
    await new CustomerPreferenceRepository(this.transaction).recompute(input.context.customerId)
    const products = await this.recommendationProducts(input.answers, input.context.customerId)
    const recommendations = rankProducts(products, input.answers, policy)
    const missingTiers = (['comfortable', 'enhanced', 'signature'] as const)
      .filter((tier) => !recommendations.some((product) => product.tier === tier))
    const inserted = await this.transaction.query<{ id: string }>(`
      INSERT INTO mbox.recommendation_sessions (
        tenant_id, store_id, public_id, customer_id, table_session_id,
        business_date, source, party_size, occasion, alcohol_preference,
        experience_level, service_intensity, answers_snapshot, recommendation_snapshot
      ) VALUES (
        $1::uuid, $2::uuid, $3, $4::uuid, $5::uuid,
        $6::date, 'guest_table', $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb
      ) RETURNING id
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.publicId,
      input.context.customerId,
      input.context.tableSessionId,
      input.context.businessDate,
      input.answers.partySize,
      input.answers.occasion,
      input.answers.alcoholPreference,
      input.answers.experienceLevel,
      input.answers.serviceIntensity,
      JSON.stringify(input.answers),
      JSON.stringify(recommendations),
    ])
    const sessionId = requiredRow(inserted.rows[0], 'recommendation session').id
    for (const [index, recommendation] of recommendations.entries()) {
      const product = products.find((entry) => entry.id === recommendation.productId)
      if (!product) throw new Error('ranked recommendation product was not found')
      const score = recommendationScore(product, input.answers, policy)
      await this.transaction.query(`
        INSERT INTO mbox.recommendation_options (
          tenant_id, store_id, recommendation_session_id, policy_version_id,
          product_id, rank, tier, amount_minor, cost_amount_minor, currency,
          total_score, preference_contribution, scene_contribution,
          margin_contribution, priority_contribution, performance_contribution,
          inventory_contribution, capacity_contribution, explanation, display_snapshot
        ) VALUES (
          $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7,
          $8::bigint, $9::bigint, $10, $11, $12, $13, $14, $15, $16, $17, $18,
          $19, $20::jsonb
        )
      `, [
        this.transaction.scope.tenantId,
        this.transaction.scope.storeId,
        sessionId,
        policy.id,
        recommendation.productId,
        index + 1,
        recommendation.tier,
        recommendation.amountMinor,
        money(product.cost_amount_minor, 'recommendation product cost'),
        recommendation.currency,
        score.total,
        score.preference,
        score.scene,
        score.margin,
        score.priority,
        score.performance,
        score.inventory,
        score.capacity,
        recommendation.reason,
        JSON.stringify({
          name: recommendation.name,
          description: recommendation.description,
          imageUrl: recommendation.imageUrl,
          included: recommendation.included,
        }),
      ])
    }
    await this.transaction.query(`
      INSERT INTO mbox.recommendation_behavior_events (
        tenant_id, store_id, recommendation_session_id, customer_id,
        table_session_id, event_type, actor_type, actor_ref,
        evidence_snapshot
      ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
        'generated', 'system', 'recommendation-engine-v1', $6::jsonb)
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      sessionId,
      input.context.customerId,
      input.context.tableSessionId,
      JSON.stringify({ policyPublicId: policy.public_id, policyVersion: policy.version }),
    ])
    return { publicId: input.publicId, answers: input.answers, recommendations, missingTiers }
  }

  async createExperiencePlan(input: Readonly<{
    context: TableExperienceContext
    recommendationPublicId: string
    selectedProductId: string
    publicId: string
    promiseSummary: string
  }>): Promise<ExperiencePlanIntentView> {
    const recommendation = await this.transaction.query<RecommendationSessionRow>(`
      SELECT id, public_id, party_size, occasion, alcohol_preference,
        experience_level, service_intensity
      FROM mbox.recommendation_sessions
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid
        AND public_id = $3 AND customer_id = $4::uuid
        AND table_session_id = $5::uuid AND completed_at IS NULL
      FOR UPDATE
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.recommendationPublicId,
      input.context.customerId,
      input.context.tableSessionId,
    ])
    const session = recommendation.rows[0]
    if (!session) throw new CustomerExperienceRequestError('推荐已失效，请重新选择', 'RECOMMENDATION_EXPIRED', 409)
    const selectedResult = await this.transaction.query<{
      id: string
      product_id: string
      product_name: string
      amount_minor: string | number
      currency: string
      display_snapshot: JsonObject
    }>(`
      SELECT option.id, option.product_id, product.name AS product_name,
        option.amount_minor, option.currency, option.display_snapshot
      FROM mbox.recommendation_options option
      JOIN mbox.products product
        ON product.tenant_id=option.tenant_id AND product.store_id=option.store_id
       AND product.id=option.product_id
      WHERE option.tenant_id=$1::uuid AND option.store_id=$2::uuid
        AND option.recommendation_session_id=$3::uuid AND option.product_id=$4::uuid
      FOR UPDATE OF option
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      session.id,
      input.selectedProductId,
    ])
    const selected = selectedResult.rows[0]
    if (!selected) throw new CustomerExperienceRequestError('所选套餐不属于这次推荐', 'RECOMMENDATION_SELECTION_INVALID', 409)
    const selectedAmountMinor = money(selected.amount_minor, 'selected recommendation amount')

    const selectedSession = await this.transaction.query(`
      UPDATE mbox.recommendation_sessions
      SET selected_product_id=$4::uuid,experience_intent_summary=$5,
        selected_at=COALESCE(selected_at,clock_timestamp()),
        selection_idempotency_key=COALESCE(selection_idempotency_key,$6),
        completed_at=COALESCE(completed_at,clock_timestamp()),updated_at=clock_timestamp()
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
        AND (selected_product_id IS NULL OR (
          selected_product_id=$4::uuid AND selection_idempotency_key=$6
        ))
    `, [this.transaction.scope.tenantId,this.transaction.scope.storeId,session.id,
      selected.product_id,input.promiseSummary,input.publicId])
    if (selectedSession.rowCount !== 1) throw new CustomerExperienceRequestError(
      '这次推荐已经选择了其他方案，请重新发起推荐', 'RECOMMENDATION_SELECTION_CONFLICT', 409,
    )
    return {
      intentPublicId: input.publicId,
      state: 'intent',
      recommendationPublicId: session.public_id,
      selectedProduct: {
        productId: selected.product_id,
        name: selected.product_name,
        amountMinor: selectedAmountMinor,
        currency: selected.currency,
      },
      plan: null,
    }
  }

  async findPlanByTable(tableSessionId: string): Promise<ExperiencePlanView | null> {
    const result = await this.transaction.query<PlanRow>(`
      SELECT id, public_id, plan_state, party_size, occasion, alcohol_preference,
        service_intensity, promise_summary, selected_product_id, recommendation_option_id,
        selected_product_name_at_selection, selected_amount_minor, selected_currency
      FROM mbox.customer_experience_plans
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid
        AND table_session_id = $3::uuid
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, tableSessionId])
    const plan = result.rows[0]
    if (!plan) return null
    const cues = await this.transaction.query<CueRow>(`
      SELECT id, cue_code, sequence_no, trigger_kind, trigger_offset_minutes,
        performance_phase, action_kind, station, action_payload, due_at::text, status
      FROM mbox.experience_plan_cues
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid
        AND experience_plan_id = $3::uuid
      ORDER BY sequence_no, id
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, plan.id])
    return planView(plan, cues.rows)
  }

  async prepareCheckoutUpgrade(
    context: TableExperienceContext,
    input: Readonly<{
      items: readonly CheckoutBasketLine[]
      occasion?: CustomerOccasion
      alcoholPreference?: AlcoholPreference
      idempotencyKey: string
    }>,
  ): Promise<CheckoutUpgradeOfferView | null> {
    await this.expireCheckoutUpgradeOffers(context.tableSessionId, context.customerId)
    const featureEnabled = await this.featureEnabled('checkout_upgrade')
    if (!featureEnabled || input.items.length === 0) return null
    const basket = normalizeCheckoutBasket(input.items)
    const candidate = await this.transaction.query<{
      rule_id: string
      rule_revision: number
      rule_updated_at: string
      source_product_id: string
      source_name: string
      source_snapshot: JsonObject
      source_amount_minor: string | number
      target_product_id: string
      target_name: string
      target_snapshot: JsonObject
      target_amount_minor: string | number
      target_cost_amount_minor: string | number
      currency: string
      prompt_title: string
      prompt_body: string
      call_to_action: string
      offer_valid_minutes: number
      minimum_gross_margin_basis_points: number
      target_component_list: unknown
    }>(`
      WITH requested AS (
        SELECT product_id, quantity
        FROM jsonb_to_recordset($4::jsonb) AS line(product_id uuid, quantity integer)
      )
      SELECT rule.id AS rule_id, rule.revision AS rule_revision,
        rule.updated_at::text AS rule_updated_at,
        source_product.id AS source_product_id, source_product.name AS source_name,
        source_product.product_snapshot AS source_snapshot,
        source_price.amount_minor AS source_amount_minor,
        target_product.id AS target_product_id, target_product.name AS target_name,
        target_product.product_snapshot AS target_snapshot,
        target_price.amount_minor AS target_amount_minor,
        target_product.cost_amount_minor AS target_cost_amount_minor,
        target_price.currency, rule.prompt_title, rule.prompt_body,
        rule.call_to_action, rule.offer_valid_minutes,
        rule.minimum_gross_margin_basis_points,
        COALESCE(target_components.items, '[]'::jsonb) AS target_component_list
      FROM mbox.checkout_upgrade_rules AS rule
      JOIN requested ON requested.product_id = rule.source_product_id AND requested.quantity = 1
      JOIN mbox.products AS source_product
        ON source_product.tenant_id = rule.tenant_id AND source_product.store_id = rule.store_id
       AND source_product.id = rule.source_product_id AND source_product.status = 'active'
      JOIN mbox.products AS target_product
        ON target_product.tenant_id = rule.tenant_id AND target_product.store_id = rule.store_id
       AND target_product.id = rule.target_product_id AND target_product.status = 'active'
       AND target_product.guest_visible = true
      JOIN LATERAL (
        SELECT amount_minor, currency FROM mbox.product_prices
        WHERE tenant_id = source_product.tenant_id AND store_id = source_product.store_id
          AND product_id = source_product.id AND price_type = 'standard'
          AND valid_from <= clock_timestamp() AND (valid_until IS NULL OR valid_until > clock_timestamp())
        ORDER BY valid_from DESC, id DESC LIMIT 1
      ) AS source_price ON true
      JOIN LATERAL (
        SELECT amount_minor, currency FROM mbox.product_prices
        WHERE tenant_id = target_product.tenant_id AND store_id = target_product.store_id
          AND product_id = target_product.id AND price_type = 'standard'
          AND valid_from <= clock_timestamp() AND (valid_until IS NULL OR valid_until > clock_timestamp())
        ORDER BY valid_from DESC, id DESC LIMIT 1
      ) AS target_price ON target_price.currency = source_price.currency
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(component_product.name ORDER BY component.sort_order, component.id) AS items
        FROM mbox.product_bundle_components component
        JOIN mbox.products component_product
          ON component_product.tenant_id=component.tenant_id
         AND component_product.store_id=component.store_id
         AND component_product.id=component.component_product_id
        WHERE component.tenant_id=target_product.tenant_id
          AND component.store_id=target_product.store_id
          AND component.bundle_product_id=target_product.id
      ) AS target_components ON true
      WHERE rule.tenant_id = $1::uuid AND rule.store_id = $2::uuid
        AND rule.status = 'active'
        AND (rule.valid_from IS NULL OR rule.valid_from <= clock_timestamp())
        AND (rule.valid_until IS NULL OR rule.valid_until > clock_timestamp())
        AND $3::integer BETWEEN rule.minimum_party_size AND rule.maximum_party_size
        AND (cardinality(rule.occasion_tags) = 0 OR $5::text = ANY(rule.occasion_tags))
        AND (cardinality(rule.alcohol_preference_tags) = 0 OR $6::text = ANY(rule.alcohol_preference_tags))
        AND target_price.amount_minor > source_price.amount_minor
        AND NOT EXISTS (SELECT 1 FROM requested WHERE product_id = rule.target_product_id)
      ORDER BY rule.priority DESC, target_price.amount_minor ASC, rule.id
      LIMIT 1
      FOR KEY SHARE OF rule, source_product, target_product
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      context.partySize,
      JSON.stringify(basket.map((item) => ({
        product_id: item.productId,
        quantity: item.quantity,
      }))),
      input.occasion ?? 'other',
      input.alcoholPreference ?? 'undecided',
    ])
    const row = candidate.rows[0]
    if (!row) return null
    const sourceAmount = money(row.source_amount_minor, 'checkout source amount')
    const targetAmount = money(row.target_amount_minor, 'checkout target amount')
    const targetCost = money(row.target_cost_amount_minor, 'checkout target cost')
    const marginBasisPoints = Math.floor((targetAmount - targetCost) * 10_000 / targetAmount)
    if (marginBasisPoints < row.minimum_gross_margin_basis_points) return null
    const upgradedBasket = replaceCheckoutLine(basket, row.source_product_id, row.target_product_id)
    const structure = await this.checkoutUpgradeStructureFingerprint(row.target_product_id)
    const fingerprint = checkoutBasketFingerprint(basket, {
      ruleId: row.rule_id,
      ruleUpdatedAt: row.rule_updated_at,
      sourceProductId: row.source_product_id,
      targetProductId: row.target_product_id,
      sourceAmountMinor: sourceAmount,
      targetAmountMinor: targetAmount,
      currency: row.currency,
    })
    const validUntil = new Date(Date.now() + row.offer_valid_minutes * 60_000).toISOString()
    const targetSnapshot = {
      ...row.target_snapshot,
      name: row.target_name,
      totalAmountMinor: targetAmount,
      included: stringArray(row.target_component_list),
      promptTitle: row.prompt_title,
      promptBody: row.prompt_body,
      callToAction: row.call_to_action,
    }
    const inserted = await this.transaction.query<CheckoutUpgradeOfferRow>(`
      INSERT INTO mbox.checkout_upgrade_offers (
        tenant_id, store_id, public_id, table_session_id, business_date,
        customer_id, rule_id, source_product_id, target_product_id,
        source_amount_minor, target_amount_minor, amount_to_add_minor, currency,
        original_basket, upgraded_basket, basket_fingerprint,
        bundle_fingerprint, recipe_fingerprint, rule_revision,
        source_snapshot, target_snapshot, valid_until, idempotency_key,
        source_name_at_offer, target_name_at_offer, target_included_items,
        prompt_title_at_offer, prompt_body_at_offer, call_to_action_at_offer
      ) VALUES (
        $1::uuid, $2::uuid, $3, $4::uuid, $5::date,
        $6::uuid, $7::uuid, $8::uuid, $9::uuid,
        $10::bigint, $11::bigint, $12::bigint, $13,
        $14::jsonb, $15::jsonb, $16, $17, $18, $19,
        $20::jsonb, $21::jsonb, $22::timestamptz, $23,
        $24, $25, $26::text[], $27, $28, $29
      )
      ON CONFLICT (tenant_id, store_id, idempotency_key) DO UPDATE
      SET updated_at = clock_timestamp()
      RETURNING id, public_id, rule_revision, source_product_id,
        source_name_at_offer AS source_name, source_amount_minor,
        target_name_at_offer AS target_name, target_amount_minor,
        amount_to_add_minor, target_included_items, currency, valid_until::text, status,
        prompt_title_at_offer AS prompt_title,
        prompt_body_at_offer AS prompt_body,
        call_to_action_at_offer AS call_to_action
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      `checkout-upgrade-${randomUUID()}`,
      context.tableSessionId,
      context.businessDate,
      context.customerId,
      row.rule_id,
      row.source_product_id,
      row.target_product_id,
      sourceAmount,
      targetAmount,
      targetAmount - sourceAmount,
      row.currency,
      JSON.stringify(basket),
      JSON.stringify(upgradedBasket),
      fingerprint,
      structure.bundleFingerprint,
      structure.recipeFingerprint,
      row.rule_revision,
      JSON.stringify({ ...row.source_snapshot, name: row.source_name }),
      JSON.stringify(targetSnapshot),
      validUntil,
      input.idempotencyKey,
      row.source_name,
      row.target_name,
      stringArray(row.target_component_list),
      row.prompt_title,
      row.prompt_body,
      row.call_to_action,
    ])
    const offer = requiredRow(inserted.rows[0], 'checkout upgrade offer')
    await this.insertCheckoutUpgradeEvent({
      offerId: offer.id,
      eventType: 'offered',
      actorType: 'system',
      customerId: null,
      reasonCode: null,
      orderId: null,
      orderItemId: null,
      idempotencyKey: `offered:${offer.id}`,
    })
    return checkoutUpgradeOfferView(offer)
  }

  async selectCheckoutUpgrade(
    context: Pick<TableExperienceContext, 'customerId' | 'tableSessionId' | 'businessDate'>,
    publicId: string,
    originalItems: readonly CheckoutBasketLine[],
  ): Promise<SelectedCheckoutUpgrade> {
    const basket = normalizeCheckoutBasket(originalItems)
    const selected = await this.transaction.query<{
      id: string
      basket_fingerprint: string
      bundle_fingerprint: string
      recipe_fingerprint: string
      rule_id: string
      rule_revision: number
      rule_updated_at: string
      source_product_id: string
      target_product_id: string
      source_price_id: string
      target_price_id: string
      source_amount_minor: string | number
      target_amount_minor: string | number
      currency: string
    }>(`
      SELECT offer.id, offer.basket_fingerprint,
        offer.bundle_fingerprint, offer.recipe_fingerprint,
        offer.rule_id, offer.rule_revision, rule.updated_at::text AS rule_updated_at,
        offer.source_product_id, offer.target_product_id,
        source_price.id AS source_price_id, target_price.id AS target_price_id,
        source_price.amount_minor AS source_amount_minor,
        target_price.amount_minor AS target_amount_minor, target_price.currency
      FROM mbox.checkout_upgrade_offers AS offer
      JOIN mbox.checkout_upgrade_rules AS rule
        ON rule.tenant_id=offer.tenant_id AND rule.store_id=offer.store_id
       AND rule.id=offer.rule_id
      JOIN mbox.customer_experience_features AS feature
        ON feature.tenant_id=offer.tenant_id AND feature.store_id=offer.store_id
       AND feature.feature_code='checkout_upgrade'
       AND feature.rollout_state IN ('pilot','enabled')
      JOIN mbox.table_sessions AS table_session
        ON table_session.tenant_id=offer.tenant_id AND table_session.store_id=offer.store_id
       AND table_session.id=offer.table_session_id
       AND table_session.status='open' AND table_session.business_date=offer.business_date
      JOIN mbox.stores AS store
        ON store.tenant_id=offer.tenant_id AND store.id=offer.store_id
       AND store.status='active'
      JOIN mbox.products AS source_product
        ON source_product.tenant_id=offer.tenant_id AND source_product.store_id=offer.store_id
       AND source_product.id=offer.source_product_id
      JOIN mbox.products AS target_product
        ON target_product.tenant_id=offer.tenant_id AND target_product.store_id=offer.store_id
       AND target_product.id=offer.target_product_id
      JOIN LATERAL (
        SELECT id, amount_minor, currency
        FROM mbox.product_prices
        WHERE tenant_id=offer.tenant_id AND store_id=offer.store_id
          AND product_id=offer.source_product_id AND price_type='standard'
          AND valid_from <= clock_timestamp()
          AND (valid_until IS NULL OR valid_until > clock_timestamp())
        ORDER BY valid_from DESC, id DESC LIMIT 1
      ) AS source_price ON true
      JOIN LATERAL (
        SELECT id, amount_minor, currency
        FROM mbox.product_prices
        WHERE tenant_id=offer.tenant_id AND store_id=offer.store_id
          AND product_id=offer.target_product_id AND price_type='standard'
          AND valid_from <= clock_timestamp()
          AND (valid_until IS NULL OR valid_until > clock_timestamp())
        ORDER BY valid_from DESC, id DESC LIMIT 1
      ) AS target_price ON target_price.currency=source_price.currency
      WHERE offer.tenant_id = $1::uuid AND offer.store_id = $2::uuid
        AND offer.table_session_id = $3::uuid AND offer.customer_id = $4::uuid
        AND offer.public_id = $5 AND offer.business_date=$6::date
        AND offer.status IN ('offered', 'selected')
        AND offer.valid_until > clock_timestamp()
        AND rule.status='active' AND rule.revision=offer.rule_revision
        AND (rule.valid_from IS NULL OR rule.valid_from <= clock_timestamp())
        AND (rule.valid_until IS NULL OR rule.valid_until > clock_timestamp())
        AND table_session.guest_count BETWEEN rule.minimum_party_size AND rule.maximum_party_size
        AND source_product.status='active'
        AND target_product.status='active' AND target_product.guest_visible=true
        AND target_product.product_kind='bundle'
        AND 'guest_qr'=ANY(target_product.allowed_channels)
        AND target_product.cost_amount_minor IS NOT NULL
        AND target_price.amount_minor > source_price.amount_minor
        AND floor(
          (target_price.amount_minor-target_product.cost_amount_minor) * 10000.0
          / target_price.amount_minor
        ) >= rule.minimum_gross_margin_basis_points
        AND (
          target_product.available_from IS NULL
          OR (
            target_product.available_from < target_product.available_until
            AND (clock_timestamp() AT TIME ZONE store.timezone)::time >= target_product.available_from
            AND (clock_timestamp() AT TIME ZONE store.timezone)::time < target_product.available_until
          )
          OR (
            target_product.available_from > target_product.available_until
            AND (
              (clock_timestamp() AT TIME ZONE store.timezone)::time >= target_product.available_from
              OR (clock_timestamp() AT TIME ZONE store.timezone)::time < target_product.available_until
            )
          )
        )
      FOR UPDATE OF offer, rule, table_session, source_product, target_product
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      context.tableSessionId,
      context.customerId,
      publicId,
      context.businessDate,
    ])
    const row = selected.rows[0]
    if (!row) throw new CustomerExperienceRequestError('升级建议已失效，请在付款页重新确认', 'CHECKOUT_UPGRADE_UNAVAILABLE', 409)
    const lockedPrices = await this.transaction.query<{
      id: string
      amount_minor: string | number
      currency: string
    }>(`
      SELECT id, amount_minor, currency
      FROM mbox.product_prices
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid
        AND id=ANY($3::uuid[])
      ORDER BY id
      FOR SHARE
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      [row.source_price_id, row.target_price_id],
    ])
    const sourcePrice = lockedPrices.rows.find((price) => price.id === row.source_price_id)
    const targetPrice = lockedPrices.rows.find((price) => price.id === row.target_price_id)
    if (!sourcePrice || !targetPrice || sourcePrice.currency !== targetPrice.currency) {
      throw new CustomerExperienceRequestError(
        '升级建议对应的价格已变化，请重新确认',
        'CHECKOUT_UPGRADE_PRICE_CHANGED',
        409,
      )
    }
    const sourceAmountMinor = money(sourcePrice.amount_minor, 'checkout source amount')
    const targetAmountMinor = money(targetPrice.amount_minor, 'checkout target amount')
    const fingerprint = checkoutBasketFingerprint(basket, {
      ruleId: row.rule_id,
      ruleUpdatedAt: row.rule_updated_at,
      sourceProductId: row.source_product_id,
      targetProductId: row.target_product_id,
      sourceAmountMinor,
      targetAmountMinor,
      currency: targetPrice.currency,
    })
    if (fingerprint !== row.basket_fingerprint) {
      throw new CustomerExperienceRequestError(
        '升级建议对应的价格或规则已变化，请重新确认',
        'CHECKOUT_UPGRADE_PRICE_CHANGED',
        409,
      )
    }
    const structure = await this.checkoutUpgradeStructureFingerprint(row.target_product_id)
    if (structure.bundleFingerprint !== row.bundle_fingerprint
      || structure.recipeFingerprint !== row.recipe_fingerprint) {
      throw new CustomerExperienceRequestError(
        '升级套餐的内容或出品配方已变化，请重新确认',
        'CHECKOUT_UPGRADE_STRUCTURE_CHANGED',
        409,
      )
    }
    const updated = await this.transaction.query<{ id: string }>(`
      UPDATE mbox.checkout_upgrade_offers
      SET status='selected', selected_at=COALESCE(selected_at, clock_timestamp()),
        updated_at=clock_timestamp()
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
        AND status IN ('offered','selected') AND valid_until > clock_timestamp()
      RETURNING id
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, row.id])
    if (updated.rowCount !== 1) {
      throw new CustomerExperienceRequestError('升级建议已被使用，请重新确认', 'CHECKOUT_UPGRADE_UNAVAILABLE', 409)
    }
    await this.insertCheckoutUpgradeEvent({
      offerId: row.id,
      eventType: 'accepted',
      actorType: 'guest',
      customerId: context.customerId,
      reasonCode: null,
      orderId: null,
      orderItemId: null,
      idempotencyKey: `accepted:${row.id}`,
    })
    return {
      offerId: row.id,
      upgradedItems: replaceCheckoutLine(basket, row.source_product_id, row.target_product_id),
      targetProductId: row.target_product_id,
      targetAmountMinor,
      currency: targetPrice.currency,
    }
  }

  async markCheckoutUpgradeConverted(input: Readonly<{
    offerId: string
    orderId: string
    targetProductId: string
    targetAmountMinor: number
    currency: string
  }>): Promise<void> {
    const result = await this.transaction.query<{ id: string; customer_id: string; order_item_id: string }>(`
      WITH target_item AS (
        SELECT item.id
        FROM mbox.orders AS ordered
        JOIN mbox.order_items AS item
          ON item.tenant_id=ordered.tenant_id AND item.store_id=ordered.store_id
         AND item.order_id=ordered.id
        WHERE ordered.tenant_id=$1::uuid AND ordered.store_id=$2::uuid
          AND ordered.id=$4::uuid AND ordered.status='submitted'
          AND ordered.payment_status='unpaid'
          AND item.product_id=$5::uuid AND item.parent_order_item_id IS NULL
          AND item.quantity=1 AND item.unit_price_minor=$6::bigint AND item.currency=$7
        ORDER BY item.id LIMIT 1
        FOR UPDATE OF ordered,item
      )
      UPDATE mbox.checkout_upgrade_offers AS offer
      SET status = 'converted', converted_order_id = $4::uuid,
        converted_order_item_id=target_item.id,
        converted_at = clock_timestamp(), updated_at = clock_timestamp()
      FROM target_item
      WHERE offer.tenant_id = $1::uuid AND offer.store_id = $2::uuid
        AND offer.id = $3::uuid AND offer.status = 'selected'
        AND offer.valid_until > clock_timestamp()
        AND offer.target_product_id = $5::uuid
        AND offer.target_amount_minor = $6::bigint AND offer.currency = $7
        AND EXISTS (SELECT 1 FROM mbox.orders ordered
          WHERE ordered.tenant_id=offer.tenant_id AND ordered.store_id=offer.store_id
            AND ordered.id=$4::uuid AND ordered.table_session_id=offer.table_session_id
            AND ordered.created_by_customer_id=offer.customer_id)
      RETURNING offer.id,offer.customer_id,target_item.id AS order_item_id
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.offerId,
      input.orderId,
      input.targetProductId,
      input.targetAmountMinor,
      input.currency,
    ])
    if (result.rowCount !== 1) {
      throw new CustomerExperienceRequestError(
        '升级商品价格或订单关联不一致，已取消本次下单，请重新确认',
        'CHECKOUT_UPGRADE_ORDER_MISMATCH',
        409,
      )
    }
    const converted = requiredRow(result.rows[0], 'converted checkout upgrade')
    await this.insertCheckoutUpgradeEvent({
      offerId: converted.id,
      eventType: 'converted',
      actorType: 'system',
      customerId: null,
      reasonCode: null,
      orderId: input.orderId,
      orderItemId: converted.order_item_id,
      idempotencyKey: `converted:${input.orderId}`,
    })
  }

  async recordCheckoutUpgradeOfferEvent(
    context: Pick<TableExperienceContext, 'customerId' | 'tableSessionId' | 'actorRef'>,
    input: Readonly<{
      publicId: string
      eventType: 'viewed' | 'declined'
      reasonCode: 'kept_original' | 'not_needed' | null
      idempotencyKey: string
    }>,
  ): Promise<{ publicId: string; status: 'offered' | 'selected' | 'cancelled'; eventType: 'viewed' | 'declined' }> {
    const lockedSession = await this.transaction.query<{ id: string }>(`
      SELECT session.id
      FROM mbox.table_sessions session
      WHERE session.tenant_id=$1::uuid AND session.store_id=$2::uuid
        AND session.id=$3::uuid AND session.status='open'
      FOR UPDATE
    `, [this.transaction.scope.tenantId,this.transaction.scope.storeId,context.tableSessionId])
    if (!lockedSession.rows[0]) {
      throw new CustomerExperienceRequestError('当前桌次已结束，请重新扫码', 'TABLE_CUSTOMER_MISMATCH', 403)
    }
    if (!await lockBoundGuestTablePosition(this.transaction,context)) {
      throw new CustomerExperienceRequestError('当前客户已不在这桌，请重新扫码', 'TABLE_CUSTOMER_MISMATCH', 403)
    }
    const selected = await this.transaction.query<{ id: string; status: 'offered' | 'selected' | 'cancelled' }>(`
      SELECT offer.id,offer.status
      FROM mbox.checkout_upgrade_offers offer
      JOIN mbox.table_sessions session
        ON session.tenant_id=offer.tenant_id AND session.store_id=offer.store_id
       AND session.id=offer.table_session_id
      WHERE offer.tenant_id=$1::uuid AND offer.store_id=$2::uuid
        AND offer.public_id=$3 AND offer.customer_id=$4::uuid
        AND offer.table_session_id=$5::uuid AND session.status='open'
      FOR UPDATE OF offer
    `, [
      this.transaction.scope.tenantId,this.transaction.scope.storeId,input.publicId,
      context.customerId,context.tableSessionId,
    ])
    const offer = selected.rows[0]
    if (!offer || !['offered','selected','cancelled'].includes(offer.status)) {
      throw new CustomerExperienceRequestError('升级建议不存在或已结束', 'CHECKOUT_UPGRADE_UNAVAILABLE', 409)
    }
    if (input.eventType==='declined' && offer.status!=='cancelled') {
      const cancelled = await this.transaction.query(`
        UPDATE mbox.checkout_upgrade_offers SET status='cancelled',updated_at=clock_timestamp()
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
          AND status IN ('offered','selected')
      `, [this.transaction.scope.tenantId,this.transaction.scope.storeId,offer.id])
      if (cancelled.rowCount!==1) throw new CustomerExperienceRequestError(
        '升级建议状态刚刚变化，请按当前购物车继续结账','CHECKOUT_UPGRADE_UNAVAILABLE',409,
      )
      offer.status='cancelled'
    }
    await this.insertCheckoutUpgradeEvent({
      offerId: offer.id,eventType: input.eventType,actorType: 'guest',
      customerId: context.customerId,reasonCode: input.reasonCode,
      orderId: null,orderItemId: null,idempotencyKey: input.idempotencyKey,
    })
    return { publicId: input.publicId,status: offer.status,eventType: input.eventType }
  }

  async recordRecommendationBehavior(input: Readonly<{
    recommendationPublicId: string
    restrictionPublicId: string
    customerId: string
    tableSessionId: string
    eventType: 'exposed' | 'viewed' | 'selected' | 'ignored' | 'rejected'
    productId: string | null
    actorRef: string
    reasonCode: string | null
    evidence: JsonObject
  }>): Promise<{ recorded: true; restriction: CustomerProductRestrictionView | null }> {
    const result = await this.transaction.query<{ session_id: string; option_id: string | null }>(`
      SELECT session.id AS session_id, option.id AS option_id
      FROM mbox.recommendation_sessions session
      LEFT JOIN mbox.recommendation_options option
        ON option.tenant_id=session.tenant_id AND option.store_id=session.store_id
       AND option.recommendation_session_id=session.id AND option.product_id=$6::uuid
      WHERE session.tenant_id=$1::uuid AND session.store_id=$2::uuid
        AND session.public_id=$3 AND session.customer_id=$4::uuid
        AND session.table_session_id=$5::uuid
      FOR KEY SHARE OF session
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.recommendationPublicId,
      input.customerId,
      input.tableSessionId,
      input.productId,
    ])
    const row = result.rows[0]
    if (!row || (input.productId !== null && row.option_id === null)) {
      throw new CustomerExperienceRequestError('推荐会话或方案不属于当前桌次', 'RECOMMENDATION_EVENT_INVALID', 409)
    }
    await this.transaction.query(`
      INSERT INTO mbox.recommendation_behavior_events (
        tenant_id, store_id, recommendation_session_id, recommendation_option_id,
        customer_id, table_session_id, event_type, actor_type, actor_ref,
        reason_code, evidence_snapshot
      ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
        $7, 'guest', $8, $9, $10::jsonb)
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      row.session_id,
      row.option_id,
      input.customerId,
      input.tableSessionId,
      input.eventType,
      input.actorRef,
      input.reasonCode,
      JSON.stringify(input.evidence),
    ])
    let restriction: CustomerProductRestrictionView | null = null
    if (input.eventType === 'rejected' && input.productId !== null
      && (input.reasonCode === 'dislike' || input.reasonCode === 'allergy_or_cannot_consume')) {
      const inserted = await this.transaction.query<CustomerProductRestrictionRow>(`
        WITH RECURSIVE ancestry AS (
          SELECT customer.id,customer.merged_into_customer_id,0 AS depth
          FROM mbox.customers customer
          WHERE customer.tenant_id=$1::uuid AND customer.store_id=$2::uuid
            AND customer.id=$5::uuid
          UNION ALL
          SELECT parent.id,parent.merged_into_customer_id,child.depth+1
          FROM mbox.customers parent JOIN ancestry child
            ON child.merged_into_customer_id=parent.id
          WHERE parent.tenant_id=$1::uuid AND parent.store_id=$2::uuid
            AND child.depth<32
        ), canonical AS (
          SELECT id FROM ancestry WHERE merged_into_customer_id IS NULL
          ORDER BY depth DESC LIMIT 1
        )
        INSERT INTO mbox.customer_product_restrictions (
          tenant_id,store_id,public_id,customer_id,source_customer_id,
          product_id,restriction_type,
          source_recommendation_session_id,source_recommendation_option_id,
          created_by_customer_id
        )
        SELECT $1::uuid,$2::uuid,$6,canonical.id,$5::uuid,$7::uuid,$8,
          $3::uuid,$4::uuid,$5::uuid
        FROM mbox.products product CROSS JOIN canonical
        WHERE product.tenant_id=$1::uuid AND product.store_id=$2::uuid
          AND product.id=$7::uuid
        ON CONFLICT (tenant_id,store_id,customer_id,product_id)
          WHERE status='active'
        DO UPDATE SET
          restriction_type=EXCLUDED.restriction_type,
          source_customer_id=EXCLUDED.source_customer_id,
          source_recommendation_session_id=EXCLUDED.source_recommendation_session_id,
          source_recommendation_option_id=EXCLUDED.source_recommendation_option_id,
          created_by_customer_id=EXCLUDED.created_by_customer_id
        RETURNING public_id,product_id,
          (SELECT name FROM mbox.products product
           WHERE product.tenant_id=mbox.customer_product_restrictions.tenant_id
             AND product.store_id=mbox.customer_product_restrictions.store_id
             AND product.id=mbox.customer_product_restrictions.product_id) AS product_name,
          restriction_type,created_at::text
      `, [
        this.transaction.scope.tenantId,
        this.transaction.scope.storeId,
        row.session_id,
        row.option_id,
        input.customerId,
        input.restrictionPublicId,
        input.productId,
        input.reasonCode,
      ])
      const created = requiredRow(inserted.rows[0], 'customer product restriction')
      restriction = restrictionView(created)
    }
    return { recorded: true, restriction }
  }

  async customerProductRestrictions(customerId: string): Promise<CustomerProductRestrictionView[]> {
    const result = await this.transaction.query<CustomerProductRestrictionRow>(`
      WITH RECURSIVE ancestry AS (
        SELECT id,merged_into_customer_id FROM mbox.customers
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
        UNION ALL
        SELECT parent.id,parent.merged_into_customer_id
        FROM mbox.customers parent JOIN ancestry child ON child.merged_into_customer_id=parent.id
        WHERE parent.tenant_id=$1::uuid AND parent.store_id=$2::uuid
      ), canonical AS (
        SELECT id FROM ancestry WHERE merged_into_customer_id IS NULL LIMIT 1
      ), family AS (
        SELECT id FROM canonical
        UNION ALL
        SELECT child.id FROM mbox.customers child JOIN family parent
          ON child.merged_into_customer_id=parent.id
        WHERE child.tenant_id=$1::uuid AND child.store_id=$2::uuid
      )
      SELECT restriction.public_id,restriction.product_id,product.name AS product_name,
        restriction.restriction_type,restriction.created_at::text
      FROM mbox.customer_product_restrictions restriction
      JOIN mbox.products product
        ON product.tenant_id=restriction.tenant_id AND product.store_id=restriction.store_id
       AND product.id=restriction.product_id
      WHERE restriction.tenant_id=$1::uuid AND restriction.store_id=$2::uuid
        AND restriction.customer_id IN (SELECT id FROM family)
        AND restriction.status='active'
      ORDER BY restriction.created_at DESC,restriction.id DESC
      LIMIT 100
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, customerId])
    return result.rows.map(restrictionView)
  }

  async withdrawCustomerProductRestriction(input: Readonly<{
    publicId: string
    customerId: string
    reason: string
  }>): Promise<CustomerProductRestrictionView> {
    const selected = await this.transaction.query<CustomerProductRestrictionRow & { id: string }>(`
      WITH RECURSIVE ancestry AS (
        SELECT id,merged_into_customer_id FROM mbox.customers
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
        UNION ALL
        SELECT parent.id,parent.merged_into_customer_id
        FROM mbox.customers parent JOIN ancestry child ON child.merged_into_customer_id=parent.id
        WHERE parent.tenant_id=$1::uuid AND parent.store_id=$2::uuid
      ), canonical AS (
        SELECT id FROM ancestry WHERE merged_into_customer_id IS NULL LIMIT 1
      ), family AS (
        SELECT id FROM canonical
        UNION ALL
        SELECT child.id FROM mbox.customers child JOIN family parent
          ON child.merged_into_customer_id=parent.id
        WHERE child.tenant_id=$1::uuid AND child.store_id=$2::uuid
      )
      SELECT restriction.id,restriction.public_id,restriction.product_id,
        product.name AS product_name,restriction.restriction_type,
        restriction.created_at::text
      FROM mbox.customer_product_restrictions restriction
      JOIN mbox.products product
        ON product.tenant_id=restriction.tenant_id AND product.store_id=restriction.store_id
       AND product.id=restriction.product_id
      WHERE restriction.tenant_id=$1::uuid AND restriction.store_id=$2::uuid
        AND restriction.public_id=$4
        AND restriction.customer_id IN (SELECT id FROM family)
        AND restriction.status='active'
      FOR UPDATE OF restriction
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, input.customerId, input.publicId])
    const row = selected.rows[0]
    if (!row) throw new CustomerExperienceRequestError(
      '没有找到可撤回的本人商品限制', 'CUSTOMER_PRODUCT_RESTRICTION_NOT_FOUND', 404,
    )
    await this.transaction.query(`
      UPDATE mbox.customer_product_restrictions
      SET status='withdrawn',withdrawn_by_customer_id=$4::uuid,
        withdrawn_at=clock_timestamp(),withdrawal_reason=$5
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid AND status='active'
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      row.id,
      input.customerId,
      input.reason,
    ])
    return restrictionView(row)
  }

  async currentPerformancePhaseEvents(): Promise<PerformancePhaseEventView[]> {
    const result = await this.transaction.query<PerformancePhaseEventRow>(`
      SELECT event.public_id,event.schedule_id,performer.stage_name AS performer_stage_name,
        event.phase_code,event.status,event.started_at::text,event.ended_at::text,
        event.cancelled_at::text
      FROM mbox.schedule_performance_phase_events event
      JOIN mbox.schedules schedule
        ON schedule.tenant_id=event.tenant_id AND schedule.store_id=event.store_id
       AND schedule.id=event.schedule_id
      JOIN mbox.performers performer
        ON performer.tenant_id=schedule.tenant_id AND performer.store_id=schedule.store_id
       AND performer.id=schedule.performer_id
      WHERE event.tenant_id=$1::uuid AND event.store_id=$2::uuid
        AND event.status='active'
      ORDER BY event.started_at DESC,event.id DESC
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId])
    return result.rows.map(performancePhaseEventView)
  }

  async productPerformancePhases(productId: string): Promise<{
    productId: string
    phaseCodes: PerformancePhaseCode[]
  }> {
    const product = await this.transaction.query<{ id: string }>(`
      SELECT id FROM mbox.products
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, productId])
    if (!product.rows[0]) throw new CustomerExperienceRequestError(
      '商品不存在或不属于当前门店', 'PERFORMANCE_PHASE_PRODUCT_NOT_FOUND', 404,
    )
    const phases = await this.transaction.query<{ phase_code: PerformancePhaseCode }>(`
      SELECT phase_code
      FROM mbox.product_performance_phase_eligibilities
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND product_id=$3::uuid
        AND status='active'
      ORDER BY phase_code,id
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, productId])
    return { productId, phaseCodes: phases.rows.map((row) => row.phase_code) }
  }

  async configureProductPerformancePhases(input: Readonly<{
    productId: string
    phaseCodes: readonly PerformancePhaseCode[]
    employeeId: string
    reason: string
  }>): Promise<{ productId: string; phaseCodes: PerformancePhaseCode[] }> {
    const product = await this.transaction.query<{ id: string }>(`
      SELECT id FROM mbox.products
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
      FOR UPDATE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, input.productId])
    if (!product.rows[0]) throw new CustomerExperienceRequestError(
      '商品不存在或不属于当前门店', 'PERFORMANCE_PHASE_PRODUCT_NOT_FOUND', 404,
    )
    const phaseCodes = [...new Set(input.phaseCodes)].toSorted()
    await this.transaction.query(`
      UPDATE mbox.product_performance_phase_eligibilities
      SET status='retired',retired_by_employee_id=$4::uuid,
        retired_at=clock_timestamp(),retirement_reason=$5
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND product_id=$3::uuid
        AND status='active' AND NOT (phase_code=ANY($6::text[]))
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.productId,
      input.employeeId,
      input.reason,
      phaseCodes,
    ])
    if (phaseCodes.length > 0) await this.transaction.query(`
      INSERT INTO mbox.product_performance_phase_eligibilities (
        tenant_id,store_id,product_id,phase_code,configured_by_employee_id,
        configuration_reason
      )
      SELECT $1::uuid,$2::uuid,$3::uuid,phase_code,$4::uuid,$5
      FROM unnest($6::text[]) AS phase_code
      ON CONFLICT (tenant_id,store_id,product_id,phase_code)
        WHERE status='active' DO NOTHING
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.productId,
      input.employeeId,
      input.reason,
      phaseCodes,
    ])
    return { productId: input.productId, phaseCodes }
  }

  async startPerformancePhase(input: Readonly<{
    publicId: string
    scheduleId: string
    phaseCode: PerformancePhaseCode
    employeeId: string
    reason: string
  }>): Promise<PerformancePhaseEventView> {
    await this.transaction.query(`
      SELECT id FROM mbox.stores
      WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId])
    const schedule = await this.transaction.query<{ id: string; status: string; performer_stage_name: string }>(`
      SELECT schedule.id,schedule.status,performer.stage_name AS performer_stage_name
      FROM mbox.schedules schedule
      JOIN mbox.performers performer
        ON performer.tenant_id=schedule.tenant_id AND performer.store_id=schedule.store_id
       AND performer.id=schedule.performer_id
      WHERE schedule.tenant_id=$1::uuid AND schedule.store_id=$2::uuid
        AND schedule.id=$3::uuid
      FOR UPDATE OF schedule
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, input.scheduleId])
    const selectedSchedule = schedule.rows[0]
    if (!selectedSchedule) throw new CustomerExperienceRequestError(
      '演出场次不存在或不属于当前门店', 'PERFORMANCE_SCHEDULE_NOT_FOUND', 404,
    )
    if (selectedSchedule.status !== 'performing') throw new CustomerExperienceRequestError(
      '只有已切换为演出中的场次才能启动现场阶段', 'PERFORMANCE_PHASE_SCHEDULE_NOT_PERFORMING', 409,
    )
    const active = await this.transaction.query<{ public_id: string }>(`
      SELECT public_id FROM mbox.schedule_performance_phase_events
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND status='active'
      FOR UPDATE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId])
    if (active.rows[0]) throw new CustomerExperienceRequestError(
      '当前已有活动演出阶段，请先结束或取消后再切换', 'PERFORMANCE_PHASE_ALREADY_ACTIVE', 409,
    )
    const inserted = await this.transaction.query<PerformancePhaseEventRow>(`
      INSERT INTO mbox.schedule_performance_phase_events (
        tenant_id,store_id,public_id,schedule_id,phase_code,
        started_by_employee_id,start_reason
      ) VALUES ($1::uuid,$2::uuid,$3,$4::uuid,$5,$6::uuid,$7)
      RETURNING public_id,schedule_id,$8::text AS performer_stage_name,
        phase_code,status,started_at::text,ended_at::text,cancelled_at::text
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.publicId,
      input.scheduleId,
      input.phaseCode,
      input.employeeId,
      input.reason,
      selectedSchedule.performer_stage_name,
    ])
    return performancePhaseEventView(requiredRow(inserted.rows[0], 'performance phase event'))
  }

  async transitionPerformancePhase(input: Readonly<{
    publicId: string
    action: 'end' | 'cancel'
    employeeId: string
    reason: string
  }>): Promise<PerformancePhaseEventView> {
    const selected = await this.transaction.query<PerformancePhaseEventRow & { id: string }>(`
      SELECT event.id,event.public_id,event.schedule_id,
        performer.stage_name AS performer_stage_name,event.phase_code,event.status,
        event.started_at::text,event.ended_at::text,event.cancelled_at::text
      FROM mbox.schedule_performance_phase_events event
      JOIN mbox.schedules schedule
        ON schedule.tenant_id=event.tenant_id AND schedule.store_id=event.store_id
       AND schedule.id=event.schedule_id
      JOIN mbox.performers performer
        ON performer.tenant_id=schedule.tenant_id AND performer.store_id=schedule.store_id
       AND performer.id=schedule.performer_id
      WHERE event.tenant_id=$1::uuid AND event.store_id=$2::uuid
        AND event.public_id=$3
      FOR UPDATE OF event
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, input.publicId])
    const event = selected.rows[0]
    if (!event) throw new CustomerExperienceRequestError(
      '现场演出阶段不存在', 'PERFORMANCE_PHASE_NOT_FOUND', 404,
    )
    if (event.status !== 'active') throw new CustomerExperienceRequestError(
      '现场演出阶段已经结束，不能重复修改', 'PERFORMANCE_PHASE_NOT_ACTIVE', 409,
    )
    const transitioned = await this.transaction.query<PerformancePhaseEventRow>(input.action === 'end' ? `
      UPDATE mbox.schedule_performance_phase_events
      SET status='ended',ended_by_employee_id=$4::uuid,ended_at=clock_timestamp(),
        end_reason=$5,updated_at=clock_timestamp()
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid AND status='active'
      RETURNING public_id,schedule_id,$6::text AS performer_stage_name,
        phase_code,status,started_at::text,ended_at::text,cancelled_at::text
    ` : `
      UPDATE mbox.schedule_performance_phase_events
      SET status='cancelled',cancelled_by_employee_id=$4::uuid,
        cancelled_at=clock_timestamp(),cancellation_reason=$5,
        updated_at=clock_timestamp()
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid AND status='active'
      RETURNING public_id,schedule_id,$6::text AS performer_stage_name,
        phase_code,status,started_at::text,ended_at::text,cancelled_at::text
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      event.id,
      input.employeeId,
      input.reason,
      event.performer_stage_name,
    ])
    return performancePhaseEventView(requiredRow(transitioned.rows[0], 'performance phase transition'))
  }

  async recordRecommendationOrdered(input: Readonly<{
    recommendationPublicId: string
    selectedProductId: string
    customerId: string
    tableSessionId: string
    businessDate: string
    orderId: string
    orderPublicId: string
    actorRef: string
  }>): Promise<{ recommendationSessionId: string; recommendationOptionId: string; orderItemId: string }> {
    const result = await this.transaction.query<{
      recommendation_session_id: string
      recommendation_option_id: string
      order_item_id: string
    }>(`
      WITH matched AS (
        SELECT session.id AS recommendation_session_id,
          option.id AS recommendation_option_id,
          item.id AS order_item_id
        FROM mbox.recommendation_sessions AS session
        JOIN mbox.recommendation_options AS option
          ON option.tenant_id=session.tenant_id AND option.store_id=session.store_id
         AND option.recommendation_session_id=session.id
         AND option.product_id=$4::uuid
        JOIN mbox.orders AS ordered
          ON ordered.tenant_id=session.tenant_id AND ordered.store_id=session.store_id
         AND ordered.id=$7::uuid AND ordered.table_session_id=session.table_session_id
         AND ordered.created_by_customer_id=session.customer_id
         AND ordered.status='submitted'
        JOIN LATERAL (
          SELECT candidate.id
          FROM mbox.order_items AS candidate
          WHERE candidate.tenant_id=ordered.tenant_id
            AND candidate.store_id=ordered.store_id
            AND candidate.order_id=ordered.id
            AND candidate.product_id=option.product_id
            AND candidate.parent_order_item_id IS NULL
            AND candidate.quantity > 0 AND candidate.status='submitted'
          ORDER BY candidate.created_at, candidate.id
          LIMIT 1
        ) AS item ON true
        WHERE session.tenant_id=$1::uuid AND session.store_id=$2::uuid
          AND session.public_id=$3 AND session.customer_id=$5::uuid
          AND session.table_session_id=$6::uuid
          AND session.business_date=$9::date AND session.abandoned_at IS NULL
        FOR KEY SHARE OF session, option
      )
      INSERT INTO mbox.recommendation_behavior_events (
        tenant_id, store_id, recommendation_session_id, recommendation_option_id,
        customer_id, table_session_id, order_id, order_item_id,
        event_type, actor_type, actor_ref,
        reason_code, evidence_snapshot
      )
      SELECT $1::uuid, $2::uuid, matched.recommendation_session_id,
        matched.recommendation_option_id, $5::uuid, $6::uuid, $7::uuid,
        matched.order_item_id,
        'ordered', 'guest', $8, NULL,
        jsonb_build_object('source','guest_checkout','orderPublicId',$10::text)
      FROM matched
      RETURNING recommendation_session_id, recommendation_option_id, order_item_id
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.recommendationPublicId,
      input.selectedProductId,
      input.customerId,
      input.tableSessionId,
      input.orderId,
      input.actorRef,
      input.businessDate,
      input.orderPublicId,
    ])
    const row = result.rows[0]
    if (!row) {
      throw new CustomerExperienceRequestError(
        '推荐会话、方案或订单商品与当前顾客桌次不一致，已取消本次下单',
        'RECOMMENDATION_ORDER_INVALID',
        409,
      )
    }
    return {
      recommendationSessionId: row.recommendation_session_id,
      recommendationOptionId: row.recommendation_option_id,
      orderItemId: row.order_item_id,
    }
  }

  async createRecommendationPolicy(input: Readonly<{
    publicId: string
    code: string
    employeeId: string
    preferenceWeight: number
    sceneWeight: number
    marginWeight: number
    priorityWeight: number
    performanceWeight: number
    inventoryWeight: number
    capacityWeight: number
    minimumGrossMarginBasisPoints: number
    preferenceHalfLifeDays: number
    preferenceMaxAgeDays: number
    preferenceMinEffectiveScore: number
    preferenceMinConfidenceBasisPoints: number
    explanationTemplate: string
    displayConfiguration: JsonObject
    draftReason: string
  }>): Promise<{ publicId: string; code: string; version: number; status: 'draft' }> {
    if (input.preferenceMaxAgeDays < input.preferenceHalfLifeDays) {
      throw new CustomerExperienceRequestError(
        '偏好最长有效期不能短于衰减半衰期', 'RECOMMENDATION_PREFERENCE_POLICY_INVALID', 409,
      )
    }
    await this.transaction.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2::text || ':' || $3, 0))`,
      [this.transaction.scope.tenantId, this.transaction.scope.storeId, input.code],
    )
    const result = await this.transaction.query<{ public_id: string; policy_code: string; version: number; status: 'draft' }>(`
      INSERT INTO mbox.recommendation_policy_versions (
        tenant_id, store_id, public_id, policy_code, version, status,
        preference_weight, scene_weight, margin_weight, priority_weight,
        performance_weight, inventory_weight, capacity_weight,
        minimum_gross_margin_basis_points,preference_half_life_days,
        preference_max_age_days,preference_min_effective_score,
        preference_min_confidence_basis_points, explanation_template,
        display_configuration, created_by_employee_id,draft_reason,publication_mode
      ) SELECT $1::uuid, $2::uuid, $3, $4,
        COALESCE(max(version),0)+1, 'draft', $5, $6, $7, $8, $9, $10, $11,
        $12,$13,$14,$15,$16,$17,$18::jsonb,$19::uuid,$20,'separated'
      FROM mbox.recommendation_policy_versions
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND policy_code=$4
      RETURNING public_id, policy_code, version, status
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.publicId,
      input.code,
      input.preferenceWeight,
      input.sceneWeight,
      input.marginWeight,
      input.priorityWeight,
      input.performanceWeight,
      input.inventoryWeight,
      input.capacityWeight,
      input.minimumGrossMarginBasisPoints,
      input.preferenceHalfLifeDays,
      input.preferenceMaxAgeDays,
      input.preferenceMinEffectiveScore,
      input.preferenceMinConfidenceBasisPoints,
      input.explanationTemplate,
      JSON.stringify(input.displayConfiguration),
      input.employeeId,
      input.draftReason,
    ])
    const row = requiredRow(result.rows[0], 'recommendation policy')
    return { publicId: row.public_id, code: row.policy_code, version: row.version, status: row.status }
  }

  async recommendationPolicyConfiguration(code = 'DEFAULT'): Promise<RecommendationPolicyConfigurationView> {
    const [policyResult, featureResult] = await Promise.all([
      this.transaction.query<RecommendationPolicyVersionRow>(`
        SELECT policy.id,policy.public_id,policy.policy_code,policy.version,policy.status,
          policy.preference_weight,policy.scene_weight,policy.margin_weight,policy.priority_weight,
          policy.performance_weight,policy.inventory_weight,policy.capacity_weight,
          policy.minimum_gross_margin_basis_points,policy.preference_half_life_days,
          policy.preference_max_age_days,policy.preference_min_effective_score,
          policy.preference_min_confidence_basis_points,policy.explanation_template,
          policy.draft_reason,policy.approval_reason,policy.publication_reason,
          policy.publication_mode,creator.display_name AS created_by,
          approver.display_name AS approved_by,publisher.display_name AS published_by,
          policy.created_at::text,policy.approved_at::text,policy.published_at::text,
          policy.effective_from::text,policy.effective_until::text
        FROM mbox.recommendation_policy_versions policy
        LEFT JOIN mbox.employees creator
          ON creator.tenant_id=policy.tenant_id AND creator.store_id=policy.store_id
         AND creator.id=policy.created_by_employee_id
        LEFT JOIN mbox.employees approver
          ON approver.tenant_id=policy.tenant_id AND approver.store_id=policy.store_id
         AND approver.id=policy.approved_by_employee_id
        LEFT JOIN mbox.employees publisher
          ON publisher.tenant_id=policy.tenant_id AND publisher.store_id=policy.store_id
         AND publisher.id=policy.published_by_employee_id
        WHERE policy.tenant_id=$1::uuid AND policy.store_id=$2::uuid AND policy.policy_code=$3
        ORDER BY policy.version DESC,policy.id DESC
      `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, code]),
      this.transaction.query<{
        rollout_state: RecommendationPolicyConfigurationView['feature']['rolloutState']
        reason: string
        effective_from: string | null
        updated_at: string
      }>(`
        SELECT rollout_state,reason,effective_from::text,updated_at::text
        FROM mbox.customer_experience_features
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND feature_code='recommendation.engine'
      `, [this.transaction.scope.tenantId, this.transaction.scope.storeId]),
    ])
    const feature = requiredRow(featureResult.rows[0], 'recommendation feature')
    return {
      feature: {
        rolloutState: feature.rollout_state,
        reason: feature.reason,
        effectiveFrom: feature.effective_from,
        updatedAt: feature.updated_at,
      },
      policies: policyResult.rows.map(recommendationPolicyVersionView),
    }
  }

  async cloneRecommendationPolicyDraft(input: Readonly<{
    sourcePublicId: string
    publicId: string
    employeeId: string
    draftReason: string
  }>): Promise<{ publicId: string; code: string; version: number; status: 'draft' }> {
    const source = await this.transaction.query<{ policy_code: string }>(`
      SELECT policy_code FROM mbox.recommendation_policy_versions
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND public_id=$3
      FOR KEY SHARE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, input.sourcePublicId])
    const code = source.rows[0]?.policy_code
    if (!code) throw new CustomerExperienceRequestError('没有找到可复制的推荐规则版本', 'RECOMMENDATION_POLICY_NOT_FOUND', 404)
    await this.transaction.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2::text || ':' || $3, 0))`,
      [this.transaction.scope.tenantId, this.transaction.scope.storeId, code],
    )
    const result = await this.transaction.query<{
      public_id: string; policy_code: string; version: number; status: 'draft'
    }>(`
      INSERT INTO mbox.recommendation_policy_versions(
        tenant_id,store_id,public_id,policy_code,version,status,
        preference_weight,scene_weight,margin_weight,priority_weight,
        performance_weight,inventory_weight,capacity_weight,
        minimum_gross_margin_basis_points,preference_half_life_days,
        preference_max_age_days,preference_min_effective_score,
        preference_min_confidence_basis_points,explanation_template,
        display_configuration,created_by_employee_id,draft_reason,publication_mode
      ) SELECT source.tenant_id,source.store_id,$4,source.policy_code,
          COALESCE((SELECT max(version) FROM mbox.recommendation_policy_versions existing
            WHERE existing.tenant_id=source.tenant_id AND existing.store_id=source.store_id
              AND existing.policy_code=source.policy_code),0)+1,'draft',
          source.preference_weight,source.scene_weight,source.margin_weight,source.priority_weight,
          source.performance_weight,source.inventory_weight,source.capacity_weight,
          source.minimum_gross_margin_basis_points,source.preference_half_life_days,
          source.preference_max_age_days,source.preference_min_effective_score,
          source.preference_min_confidence_basis_points,source.explanation_template,
          source.display_configuration,$5::uuid,$6,'separated'
        FROM mbox.recommendation_policy_versions source
        WHERE source.tenant_id=$1::uuid AND source.store_id=$2::uuid AND source.public_id=$3
      RETURNING public_id,policy_code,version,status
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.sourcePublicId,
      input.publicId,
      input.employeeId,
      input.draftReason,
    ])
    const row = requiredRow(result.rows[0], 'cloned recommendation policy')
    return { publicId: row.public_id, code: row.policy_code, version: row.version, status: row.status }
  }

  async approveRecommendationPolicy(
    publicId: string,
    employeeId: string,
    reason: string,
  ): Promise<{ publicId: string; status: 'approved' }> {
    const result = await this.transaction.query<{ public_id: string; status: 'approved' }>(`
      UPDATE mbox.recommendation_policy_versions
      SET status='approved', approved_by_employee_id=$4::uuid,
        approved_at=clock_timestamp(),approval_reason=$5,updated_at=clock_timestamp()
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND public_id=$3
        AND status='draft' AND created_by_employee_id<>$4::uuid
      RETURNING public_id, status
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, publicId, employeeId, reason])
    const row = result.rows[0]
    if (!row) throw new CustomerExperienceRequestError('推荐规则必须由另一名授权人员审批', 'RECOMMENDATION_POLICY_APPROVAL_DENIED', 409)
    return { publicId: row.public_id, status: row.status }
  }

  async publishRecommendationPolicy(input: Readonly<{
    publicId: string
    employeeId: string
    effectiveFrom: string
    reason: string
  }>): Promise<{ publicId: string; status: 'published'; effectiveFrom: string }> {
    const policy = await this.transaction.query<{
      id: string; policy_code: string; created_by_employee_id: string; approved_by_employee_id: string
    }>(`
      SELECT id,policy_code,created_by_employee_id,approved_by_employee_id
      FROM mbox.recommendation_policy_versions
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND public_id=$3 AND status='approved'
      FOR UPDATE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, input.publicId])
    const row = policy.rows[0]
    if (!row) throw new CustomerExperienceRequestError('只有已审批规则可以发布', 'RECOMMENDATION_POLICY_NOT_APPROVED', 409)
    if (row.created_by_employee_id === input.employeeId || row.approved_by_employee_id === input.employeeId) {
      throw new CustomerExperienceRequestError('发布人必须与起草人、审批人不同', 'RECOMMENDATION_POLICY_PUBLISHER_NOT_INDEPENDENT', 409)
    }
    await this.transaction.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2::text || ':' || $3, 0))`,
      [this.transaction.scope.tenantId, this.transaction.scope.storeId, row.policy_code],
    )
    const next = await this.transaction.query<{ effective_from: string }>(`
      SELECT effective_from::text FROM mbox.recommendation_policy_versions
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND policy_code=$3 AND status='published'
        AND effective_from>$4::timestamptz
      ORDER BY effective_from LIMIT 1
      FOR UPDATE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, row.policy_code, input.effectiveFrom])
    await this.transaction.query('SET CONSTRAINTS mbox.recommendation_policy_versions_no_published_overlap_excl DEFERRED')
    const published = await this.transaction.query<{
      public_id: string; status: 'published'; effective_from: string
    }>(`
      UPDATE mbox.recommendation_policy_versions
      SET status='published', published_by_employee_id=$4::uuid,
        published_at=clock_timestamp(),publication_reason=$6,
        effective_from=$5::timestamptz,effective_until=$7::timestamptz,
        updated_at=clock_timestamp()
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND public_id=$3 AND status='approved'
      RETURNING public_id,status,effective_from::text
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.publicId,
      input.employeeId,
      input.effectiveFrom,
      input.reason,
      next.rows[0]?.effective_from ?? null,
    ])
    const result = requiredRow(published.rows[0], 'published recommendation policy')
    await this.transaction.query(`
      UPDATE mbox.recommendation_policy_versions
      SET effective_until=$4::timestamptz,updated_at=clock_timestamp()
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND policy_code=$3
        AND status='published' AND id<>$5::uuid
        AND effective_from<$4::timestamptz
        AND (effective_until IS NULL OR effective_until>$4::timestamptz)
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      row.policy_code,
      input.effectiveFrom,
      row.id,
    ])
    return { publicId: result.public_id, status: result.status, effectiveFrom: result.effective_from }
  }

  async staffDashboard(): Promise<JsonObject> {
    const [plans, cues, followups, activities] = await Promise.all([
      this.transaction.query<{ count: string }>(`
        SELECT count(*)::text AS count FROM mbox.customer_experience_plans
        WHERE tenant_id = $1::uuid AND store_id = $2::uuid
          AND plan_state IN ('planned', 'active', 'paused')
      `, [this.transaction.scope.tenantId, this.transaction.scope.storeId]),
      this.transaction.query<CueRow & { table_code: string; plan_public_id: string }>(`
        SELECT cue.id, cue.cue_code, cue.sequence_no, cue.trigger_kind,
          cue.trigger_offset_minutes, cue.performance_phase, cue.action_kind,
          cue.station, cue.action_payload, cue.due_at::text, cue.status,
          venue_table.code AS table_code, plan.public_id AS plan_public_id
        FROM mbox.experience_plan_cues AS cue
        JOIN mbox.customer_experience_plans AS plan
          ON plan.tenant_id = cue.tenant_id AND plan.store_id = cue.store_id
         AND plan.id = cue.experience_plan_id AND plan.plan_state = 'active'
        JOIN mbox.table_sessions AS session
          ON session.tenant_id = plan.tenant_id AND session.store_id = plan.store_id
         AND session.id = plan.table_session_id AND session.status = 'open'
        JOIN mbox.tables AS venue_table
          ON venue_table.tenant_id = session.tenant_id AND venue_table.store_id = session.store_id
         AND venue_table.id = session.table_id
        WHERE cue.tenant_id = $1::uuid AND cue.store_id = $2::uuid
          AND cue.status IN ('pending', 'ready', 'dispatched')
        ORDER BY COALESCE(cue.due_at, 'infinity'::timestamptz), cue.sequence_no
        LIMIT 100
      `, [this.transaction.scope.tenantId, this.transaction.scope.storeId]),
      this.transaction.query<{
        public_id: string
        customer_id: string
        owner_employee_id: string
        priority: string
        recommended_action: string
        recommended_channel: string
        due_at: string
        status: string
      }>(`
        SELECT public_id, customer_id, owner_employee_id, priority,
          recommended_action, recommended_channel, due_at::text, status
        FROM mbox.customer_followup_tasks
        WHERE tenant_id = $1::uuid AND store_id = $2::uuid
          AND status IN ('open', 'in_progress')
        ORDER BY CASE priority WHEN 'urgent' THEN 4 WHEN 'high' THEN 3 WHEN 'normal' THEN 2 ELSE 1 END DESC,
          due_at, id
        LIMIT 100
      `, [this.transaction.scope.tenantId, this.transaction.scope.storeId]),
      this.transaction.query<{
        public_id: string
        title: string
        status: string
        starts_at: string
        registrations: string
        fee_amount_minor: string
        deposit_amount_minor: string
        fee_basis: ActivityFeeBasis
        registration_payment_mode: ActivityPaymentMode
        payment_deadline_minutes: number
        payment_rule_text: string
      }>(`
        SELECT activity.public_id, activity.title, activity.status, activity.starts_at::text,
          COALESCE(sum(registration.party_size), 0)::text AS registrations,
          activity.fee_amount_minor::text, activity.deposit_amount_minor::text,
          activity.fee_basis, activity.registration_payment_mode,
          activity.payment_deadline_minutes, activity.payment_rule_text
        FROM mbox.community_activities AS activity
        LEFT JOIN mbox.community_activity_registrations AS registration
          ON registration.tenant_id = activity.tenant_id AND registration.store_id = activity.store_id
         AND registration.activity_id = activity.id
         AND registration.status IN ('reserved', 'payment_pending', 'confirmed', 'checked_in')
        WHERE activity.tenant_id = $1::uuid AND activity.store_id = $2::uuid
          AND activity.status IN ('draft', 'published', 'full')
        GROUP BY activity.id
        ORDER BY activity.starts_at
        LIMIT 50
      `, [this.transaction.scope.tenantId, this.transaction.scope.storeId]),
    ])
    return {
      activePlanCount: integer(plans.rows[0]?.count ?? 0, 'active plan count'),
      cueQueue: cues.rows.map((cue) => ({
        id: cue.id,
        code: cue.cue_code,
        tableCode: cue.table_code,
        planPublicId: cue.plan_public_id,
        station: cue.station,
        actionKind: cue.action_kind,
        dueAt: cue.due_at,
        status: cue.status,
        instruction: text(cue.action_payload.instruction) ?? '',
      })),
      followups: followups.rows.map((task) => ({
        publicId: task.public_id,
        customerId: task.customer_id,
        ownerEmployeeId: task.owner_employee_id,
        priority: task.priority,
        action: task.recommended_action,
        channel: task.recommended_channel,
        dueAt: task.due_at,
        status: task.status,
      })),
      activities: activities.rows.map((activity) => ({
        publicId: activity.public_id,
        title: activity.title,
        status: activity.status,
        startsAt: activity.starts_at,
        registrations: integer(activity.registrations, 'activity registrations'),
        feeAmountMinor: money(activity.fee_amount_minor, 'activity fee'),
        depositAmountMinor: money(activity.deposit_amount_minor, 'activity deposit'),
        feeBasis: activity.fee_basis,
        paymentMode: activity.registration_payment_mode,
        paymentDeadlineMinutes: activity.payment_deadline_minutes,
        paymentRuleText: activity.payment_rule_text,
      })),
    }
  }

  private async listFeatures(): Promise<FeatureRow[]> {
    const result = await this.transaction.query<FeatureRow>(`
      SELECT feature_code, rollout_state
      FROM mbox.customer_experience_features
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid
        AND (effective_from IS NULL OR effective_from <= clock_timestamp())
        AND (effective_until IS NULL OR effective_until > clock_timestamp())
      ORDER BY feature_code
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId])
    return result.rows
  }

  private async currentRecommendationPolicy(): Promise<RecommendationPolicyRow> {
    const result = await this.transaction.query<RecommendationPolicyRow>(`
      SELECT id, public_id, policy_code, version, preference_weight, scene_weight,
        margin_weight, priority_weight, performance_weight, inventory_weight,
        capacity_weight, minimum_gross_margin_basis_points
      FROM mbox.recommendation_policy_versions
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid
        AND policy_code='DEFAULT' AND status='published'
        AND effective_from<=clock_timestamp()
        AND (effective_until IS NULL OR effective_until>clock_timestamp())
      ORDER BY effective_from DESC,version DESC,id DESC LIMIT 1
      FOR KEY SHARE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId])
    const row = result.rows[0]
    if (!row) throw new CustomerExperienceRequestError('推荐规则尚未发布，请联系经营负责人', 'RECOMMENDATION_POLICY_UNAVAILABLE', 503)
    return row
  }

  private async featureEnabled(code: string): Promise<boolean> {
    const result = await this.transaction.query<{ enabled: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM mbox.customer_experience_features
        WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND feature_code = $3
          AND rollout_state IN ('pilot', 'enabled')
          AND (effective_from IS NULL OR effective_from <= clock_timestamp())
          AND (effective_until IS NULL OR effective_until > clock_timestamp())
      ) AS enabled
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, code])
    return result.rows[0]?.enabled === true
  }

  private async listPointLedger(membershipId: string): Promise<PublicPointEntry[]> {
    const result = await this.transaction.query<PointRow>(`
      SELECT ledger.id, ledger.entry_type, ledger.points_delta, ledger.balance_after,
        ledger.source_type,
        CASE ledger.source_type
          WHEN 'order' THEN ordering.public_id
          WHEN 'refund' THEN COALESCE(refund.public_id, ordering.public_id)
          WHEN 'redemption' THEN redemption.public_id
          ELSE NULL
        END AS source_reference,
        ledger.available_at::text, ledger.expires_at::text,
        policy.version AS policy_version, ledger.occurred_at::text
      FROM mbox.loyalty_point_ledger ledger
      LEFT JOIN mbox.orders ordering
        ON ordering.tenant_id=ledger.tenant_id AND ordering.store_id=ledger.store_id
       AND ordering.id=ledger.order_id
      LEFT JOIN mbox.refunds refund
        ON refund.tenant_id=ledger.tenant_id AND refund.store_id=ledger.store_id
       AND refund.id=ledger.refund_id
      LEFT JOIN mbox.member_redemptions redemption
        ON redemption.tenant_id=ledger.tenant_id AND redemption.store_id=ledger.store_id
       AND redemption.membership_id=ledger.membership_id
       AND ledger.source_type='redemption' AND redemption.public_id=ledger.source_id
      LEFT JOIN mbox.loyalty_policy_versions policy
        ON policy.tenant_id=ledger.tenant_id AND policy.store_id=ledger.store_id
       AND policy.id=ledger.policy_version_id
      WHERE ledger.tenant_id = $1::uuid AND ledger.store_id = $2::uuid
        AND ledger.membership_id = $3::uuid
      ORDER BY ledger.occurred_at DESC, ledger.id DESC LIMIT 20
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, membershipId])
    return result.rows.map((row) => ({
      id: row.id,
      entryType: row.entry_type,
      pointsDelta: row.points_delta,
      balanceAfter: row.balance_after,
      sourceKind: row.source_type,
      sourceReference: row.source_reference,
      description: publicPointDescription(row.entry_type, row.source_type),
      availableAt: row.available_at,
      expiresAt: row.expires_at,
      policyVersion: row.policy_version === null ? null : Number(row.policy_version),
      occurredAt: row.occurred_at,
    }))
  }

  private async listGrowthLedger(membershipId: string): Promise<PublicGrowthEntry[]> {
    const result = await this.transaction.query<GrowthRow>(`
      SELECT ledger.id, ledger.entry_type, ledger.growth_delta, ledger.balance_after,
        CASE
          WHEN ledger.refund_id IS NOT NULL THEN 'refund'
          WHEN ledger.order_id IS NOT NULL THEN 'order'
          WHEN ledger.created_by_employee_id IS NOT NULL THEN 'manual'
          ELSE 'system'
        END AS source_kind,
        CASE
          WHEN ledger.refund_id IS NOT NULL THEN refund.public_id
          WHEN ledger.order_id IS NOT NULL THEN ordering.public_id
          ELSE NULL
        END AS source_reference,
        ledger.occurred_at::text AS available_at,
        policy.version AS policy_version, ledger.occurred_at::text
      FROM mbox.loyalty_growth_ledger ledger
      LEFT JOIN mbox.orders ordering
        ON ordering.tenant_id=ledger.tenant_id AND ordering.store_id=ledger.store_id
       AND ordering.id=ledger.order_id
      LEFT JOIN mbox.refunds refund
        ON refund.tenant_id=ledger.tenant_id AND refund.store_id=ledger.store_id
       AND refund.id=ledger.refund_id
      LEFT JOIN mbox.loyalty_policy_versions policy
        ON policy.tenant_id=ledger.tenant_id AND policy.store_id=ledger.store_id
       AND policy.id=ledger.policy_version_id
      WHERE ledger.tenant_id = $1::uuid AND ledger.store_id = $2::uuid
        AND ledger.membership_id = $3::uuid
      ORDER BY ledger.occurred_at DESC, ledger.id DESC LIMIT 20
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, membershipId])
    return result.rows.map((row) => ({
      id: row.id,
      entryType: row.entry_type,
      growthDelta: row.growth_delta,
      balanceAfter: row.balance_after,
      sourceKind: row.source_kind,
      sourceReference: row.source_reference,
      description: publicGrowthDescription(row.entry_type, row.source_kind),
      availableAt: row.available_at,
      policyVersion: row.policy_version === null ? null : Number(row.policy_version),
      occurredAt: row.occurred_at,
    }))
  }

  private async listLoyaltyProcessing(
    customerId: string,
    membershipId: string,
  ): Promise<PublicLoyaltyProcessingItem[]> {
    const result = await this.transaction.query<LoyaltyProcessingRow>(`
      WITH RECURSIVE ancestry AS (
        SELECT id,merged_into_customer_id FROM mbox.customers
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
        UNION ALL
        SELECT parent.id,parent.merged_into_customer_id
        FROM mbox.customers parent JOIN ancestry child ON child.merged_into_customer_id=parent.id
        WHERE parent.tenant_id=$1::uuid AND parent.store_id=$2::uuid
      ), canonical AS (
        SELECT id FROM ancestry WHERE merged_into_customer_id IS NULL LIMIT 1
      ), family AS (
        SELECT id FROM canonical
        UNION ALL
        SELECT child.id FROM mbox.customers child JOIN family parent
          ON child.merged_into_customer_id=parent.id
        WHERE child.tenant_id=$1::uuid AND child.store_id=$2::uuid
      ), progress AS (
        SELECT 'accrual'::text AS kind, ordering.public_id AS source_reference,
          deferred.status, deferred.created_at AS occurred_at, deferred.updated_at
        FROM mbox.loyalty_accrual_deferred_orders deferred
        JOIN mbox.orders ordering
          ON ordering.tenant_id=deferred.tenant_id AND ordering.store_id=deferred.store_id
         AND ordering.id=deferred.order_id
        WHERE deferred.tenant_id=$1::uuid AND deferred.store_id=$2::uuid
          AND ordering.created_by_customer_id IN (SELECT id FROM family)
        UNION ALL
        SELECT 'supplement'::text AS kind, ordering.public_id AS source_reference,
          request.status, request.created_at AS occurred_at, request.updated_at
        FROM mbox.loyalty_supplement_requests request
        JOIN mbox.orders ordering
          ON ordering.tenant_id=request.tenant_id AND ordering.store_id=request.store_id
         AND ordering.id=request.order_id
        WHERE request.tenant_id=$1::uuid AND request.store_id=$2::uuid
          AND request.membership_id=$4::uuid
          AND request.customer_id IN (SELECT id FROM family)
      )
      SELECT kind,source_reference,status,occurred_at::text,updated_at::text
      FROM progress
      ORDER BY CASE
        WHEN status IN ('pending','processing','requested','approved','review_required') THEN 0
        ELSE 1
      END,updated_at DESC,kind,source_reference
      LIMIT 10
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, customerId, membershipId])
    return result.rows.map(publicLoyaltyProcessingItem)
  }

  private async listContentCards(): Promise<CardRow[]> {
    const result = await this.transaction.query<CardRow>(`
      SELECT code, card_type, title, summary, image_url, cta_label,
        target_path, priority, audience_visibility, audience_member_levels,
        audience_lifecycle_stages
      FROM mbox.member_content_cards
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid
        AND status = 'published' AND valid_from <= clock_timestamp()
        AND valid_until > clock_timestamp()
      ORDER BY priority, valid_from DESC, id
      LIMIT 20
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId])
    return result.rows
  }

  private async listBenefits(customerId: string): Promise<BenefitPortalRow[]> {
    const result = await this.transaction.query<BenefitPortalRow>(`
      WITH RECURSIVE ancestry AS (
        SELECT id, merged_into_customer_id FROM mbox.customers
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
        UNION ALL
        SELECT parent.id, parent.merged_into_customer_id
        FROM mbox.customers parent JOIN ancestry child ON child.merged_into_customer_id=parent.id
        WHERE parent.tenant_id=$1::uuid AND parent.store_id=$2::uuid
      ), canonical AS (
        SELECT id FROM ancestry WHERE merged_into_customer_id IS NULL LIMIT 1
      ), family AS (
        SELECT id FROM canonical
        UNION ALL
        SELECT child.id FROM mbox.customers child JOIN family parent ON child.merged_into_customer_id=parent.id
        WHERE child.tenant_id=$1::uuid AND child.store_id=$2::uuid
      )
      SELECT benefit.id, benefit.benefit_code, benefit.benefit_type, benefit.status,
        benefit.value_amount_minor, benefit.currency, benefit.benefit_snapshot,
        benefit.quantity_total, benefit.quantity_reserved, benefit.quantity_redeemed,
        benefit.valid_from::text, benefit.valid_until::text
      FROM mbox.benefits benefit
      WHERE benefit.tenant_id=$1::uuid AND benefit.store_id=$2::uuid
        AND benefit.customer_id IN (SELECT id FROM family)
        AND benefit.status IN ('issued','reserved')
        AND benefit.quantity_reserved + benefit.quantity_redeemed < benefit.quantity_total
        AND benefit.valid_from <= clock_timestamp()
        AND (benefit.valid_until IS NULL OR benefit.valid_until > clock_timestamp())
      ORDER BY benefit.valid_until NULLS LAST, benefit.created_at DESC, benefit.id
      LIMIT 100
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, customerId])
    return result.rows
  }

  private async listActivities(customerId: string | null, publicId: string | null = null): Promise<ActivityRow[]> {
    const result = await this.transaction.query<ActivityRow>(`
      WITH RECURSIVE ancestry AS (
        SELECT id, merged_into_customer_id FROM mbox.customers
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
        UNION ALL
        SELECT parent.id, parent.merged_into_customer_id
        FROM mbox.customers parent JOIN ancestry child ON child.merged_into_customer_id=parent.id
        WHERE parent.tenant_id=$1::uuid AND parent.store_id=$2::uuid
      ), canonical AS (
        SELECT id FROM ancestry WHERE merged_into_customer_id IS NULL LIMIT 1
      ), family AS (
        SELECT id FROM canonical
        UNION ALL
        SELECT child.id FROM mbox.customers child JOIN family parent ON child.merged_into_customer_id=parent.id
        WHERE child.tenant_id=$1::uuid AND child.store_id=$2::uuid
      )
      SELECT activity.public_id, activity.activity_kind, activity.title,
        activity.summary, activity.cover_url, activity.starts_at::text,
        activity.ends_at::text, activity.assembly_location, activity.capacity,
        activity.fee_amount_minor, activity.deposit_amount_minor, activity.fee_basis,
        activity.registration_payment_mode, activity.payment_deadline_minutes,
        activity.payment_rule_text, activity.refund_policy_snapshot,
        activity.refund_policy_version, activity.refund_policy_summary, activity.currency,
        activity.points_reward, activity.status, activity.visibility,
        activity.audience_member_levels, activity.audience_lifecycle_stages,
        activity.safety_snapshot, activity.safety_policy_version,
        activity.safety_acknowledgement_text, activity.safety_requirements,
        activity.sales_copy, activity.activity_details, activity.included_items,
        activity.participation_requirements, activity.contact_instructions,
        activity.member_benefit_text,
        registration.status AS registration_status,
        COALESCE((SELECT policy.online_payment_enabled
          FROM mbox.store_commerce_policies policy
          WHERE policy.tenant_id=activity.tenant_id AND policy.store_id=activity.store_id), false)
        AND EXISTS (
          SELECT 1 FROM mbox.customer_experience_features feature
          WHERE feature.tenant_id=activity.tenant_id AND feature.store_id=activity.store_id
            AND feature.feature_code='community.activity.payment'
            AND feature.rollout_state IN ('pilot','enabled')
            AND (feature.effective_from IS NULL OR feature.effective_from <= clock_timestamp())
            AND (feature.effective_until IS NULL OR feature.effective_until > clock_timestamp())
        ) AS activity_payment_authorized,
        COALESCE(sum(active_registration.party_size), 0)::text AS registered_count
      FROM mbox.community_activities AS activity
      LEFT JOIN mbox.community_activity_registrations AS active_registration
        ON active_registration.tenant_id = activity.tenant_id
       AND active_registration.store_id = activity.store_id
       AND active_registration.activity_id = activity.id
       AND active_registration.status IN ('reserved', 'payment_pending', 'confirmed', 'checked_in')
      LEFT JOIN LATERAL (
        SELECT candidate.status
        FROM mbox.community_activity_registrations candidate
        WHERE candidate.tenant_id=activity.tenant_id
          AND candidate.store_id=activity.store_id
          AND candidate.activity_id=activity.id
          AND candidate.customer_id IN (SELECT id FROM family)
        ORDER BY candidate.registered_at DESC, candidate.id DESC LIMIT 1
      ) AS registration ON true
      WHERE activity.tenant_id = $1::uuid AND activity.store_id = $2::uuid
        AND activity.status IN ('published', 'full')
        AND activity.ends_at > clock_timestamp()
        AND ($4::text IS NULL OR activity.public_id=$4)
      GROUP BY activity.id, registration.status
      ORDER BY activity.starts_at, activity.id
      LIMIT 50
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, customerId, publicId])
    return result.rows
  }

  private async recommendationProducts(
    answers: RecommendationAnswer,
    customerId: string,
  ): Promise<RecommendationProductRow[]> {
    const families = preferenceFamilies(answers.alcoholPreference)
    const result = await this.transaction.query<RecommendationProductRow>(`
      SELECT product.id, product.code, product.name,
        product.recommendation_beverage_family AS beverage_family,
        product.product_snapshot->>'description' AS description,
        product.product_snapshot->>'imageUrl' AS image_url,
        price.amount_minor, product.cost_amount_minor, price.currency,
        product.recommendation_priority, product.recommendation_scene_tags,
        product.recommendation_intent_tags,
        COALESCE(component_data.items, '[]'::jsonb) AS component_list,
        component_data.separate_amount_minor,
        COALESCE(learned_preference.net_score,0)::integer AS learned_preference_score,
        CASE WHEN EXISTS (
          SELECT 1 FROM mbox.product_performance_phase_eligibilities configured_phase
          WHERE configured_phase.tenant_id=product.tenant_id
            AND configured_phase.store_id=product.store_id
            AND configured_phase.product_id=product.id AND configured_phase.status='active'
        ) AND EXISTS (
          SELECT 1
          FROM mbox.product_performance_phase_eligibilities eligible_phase
          JOIN (
            SELECT min(event.phase_code) AS phase_code
            FROM mbox.schedule_performance_phase_events event
            JOIN mbox.schedules active_schedule
              ON active_schedule.tenant_id=event.tenant_id
             AND active_schedule.store_id=event.store_id
             AND active_schedule.id=event.schedule_id
            WHERE event.tenant_id=product.tenant_id AND event.store_id=product.store_id
              AND event.status='active' AND active_schedule.status='performing'
            HAVING count(*)=1
          ) reliable_phase ON reliable_phase.phase_code=eligible_phase.phase_code
          WHERE eligible_phase.tenant_id=product.tenant_id
            AND eligible_phase.store_id=product.store_id
            AND eligible_phase.product_id=product.id AND eligible_phase.status='active'
        ) THEN 10000 ELSE 0 END::integer AS performance_signal_basis_points,
        COALESCE(inventory_signal.basis_points,0)::integer AS inventory_signal_basis_points,
        COALESCE(capacity_signal.basis_points,0)::integer AS capacity_signal_basis_points
      FROM mbox.products AS product
      JOIN mbox.stores store
        ON store.tenant_id=product.tenant_id AND store.id=product.store_id AND store.status='active'
      JOIN LATERAL (
        SELECT candidate.amount_minor, candidate.currency
        FROM mbox.product_prices AS candidate
        WHERE candidate.tenant_id = product.tenant_id
          AND candidate.store_id = product.store_id
          AND candidate.product_id = product.id
          AND candidate.price_type = 'standard'
          AND candidate.valid_from <= clock_timestamp()
          AND (candidate.valid_until IS NULL OR candidate.valid_until > clock_timestamp())
        ORDER BY candidate.valid_from DESC, candidate.id DESC LIMIT 1
      ) AS price ON true
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(jsonb_build_object(
          'name', component_product.name,
          'quantity', component.quantity
        ) ORDER BY component.sort_order, component.id) AS items,
        sum(component.quantity * component_price.amount_minor)::bigint AS separate_amount_minor
        FROM mbox.product_bundle_components AS component
        JOIN mbox.products AS component_product
          ON component_product.tenant_id = component.tenant_id
         AND component_product.store_id = component.store_id
         AND component_product.id = component.component_product_id
        JOIN LATERAL (
          SELECT candidate.amount_minor
          FROM mbox.product_prices AS candidate
          WHERE candidate.tenant_id = component_product.tenant_id
            AND candidate.store_id = component_product.store_id
            AND candidate.product_id = component_product.id
            AND candidate.price_type = 'standard'
            AND candidate.valid_from <= clock_timestamp()
            AND (candidate.valid_until IS NULL OR candidate.valid_until > clock_timestamp())
          ORDER BY candidate.valid_from DESC, candidate.id DESC LIMIT 1
        ) AS component_price ON true
        WHERE component.tenant_id = product.tenant_id
          AND component.store_id = product.store_id
          AND component.bundle_product_id = product.id
      ) AS component_data ON true
      LEFT JOIN LATERAL (
        SELECT greatest(0,sum(fact.net_score))::integer AS net_score
        FROM mbox.customer_preference_facts fact
        WHERE fact.tenant_id=product.tenant_id AND fact.store_id=product.store_id
          AND fact.customer_id=mbox.canonical_customer_id($1::uuid,$2::uuid,$5::uuid)
          AND fact.preference_key='beverage.family'
          AND fact.preference_value=product.recommendation_beverage_family
          AND fact.status='active'
          AND (fact.valid_until IS NULL OR fact.valid_until>clock_timestamp())
      ) AS learned_preference ON true
      LEFT JOIN LATERAL (
        SELECT CASE WHEN count(*)=0 THEN 0 ELSE floor(
          least(1::numeric,greatest(0::numeric,min(
            (COALESCE(balance.on_hand_quantity-balance.reserved_quantity,0)-demand.required_quantity)
              /demand.required_quantity
          )))*10000
        )::integer END AS basis_points
        FROM (
          SELECT recipe_item.inventory_item_id,
            SUM(component.quantity::numeric
              *(recipe_item.quantity+recipe_item.expected_waste_quantity)
              /recipe.yield_quantity::numeric) AS required_quantity
          FROM mbox.product_bundle_components component
          JOIN mbox.recipes recipe
            ON recipe.tenant_id=component.tenant_id AND recipe.store_id=component.store_id
           AND recipe.product_id=component.component_product_id
           AND recipe.status='active' AND recipe.effective_at<=clock_timestamp()
          JOIN mbox.recipe_items recipe_item
            ON recipe_item.tenant_id=recipe.tenant_id AND recipe_item.store_id=recipe.store_id
           AND recipe_item.recipe_id=recipe.id
          WHERE component.tenant_id=product.tenant_id AND component.store_id=product.store_id
            AND component.bundle_product_id=product.id
          GROUP BY recipe_item.inventory_item_id
        ) demand
        LEFT JOIN mbox.inventory_balances balance
          ON balance.tenant_id=product.tenant_id AND balance.store_id=product.store_id
         AND balance.inventory_item_id=demand.inventory_item_id
        WHERE demand.required_quantity>0
      ) AS inventory_signal ON true
      LEFT JOIN LATERAL (
        SELECT CASE
          WHEN count(*)=0 OR bool_and(window_data.capacity_limit_units IS NOT NULL) IS NOT TRUE THEN 0
          ELSE floor(least(1::numeric,greatest(0::numeric,min(
            (window_data.capacity_limit_units-window_data.used_units-capacity_need.required_units)::numeric
              /capacity_need.required_units::numeric
          )))*10000)::integer
        END AS basis_points
        FROM (
          SELECT component_product.fulfillment_station AS station_code,
            SUM(component.quantity*component_product.capacity_units)::bigint AS required_units
          FROM mbox.product_bundle_components component
          JOIN mbox.products component_product
            ON component_product.tenant_id=component.tenant_id
           AND component_product.store_id=component.store_id
           AND component_product.id=component.component_product_id
          WHERE component.tenant_id=product.tenant_id AND component.store_id=product.store_id
            AND component.bundle_product_id=product.id
            AND component_product.fulfillment_station<>'none'
          GROUP BY component_product.fulfillment_station
        ) capacity_need
        LEFT JOIN LATERAL (
          SELECT capacity_window.capacity_limit_units::bigint,
            COALESCE(sum(reservation.capacity_units),0)::bigint AS used_units
          FROM mbox.fulfillment_capacity_policy_versions capacity_policy
          JOIN mbox.fulfillment_capacity_windows capacity_window
            ON capacity_window.tenant_id=capacity_policy.tenant_id
           AND capacity_window.store_id=capacity_policy.store_id
           AND capacity_window.policy_version_id=capacity_policy.id
          LEFT JOIN mbox.fulfillment_capacity_reservations reservation
            ON reservation.tenant_id=capacity_window.tenant_id
           AND reservation.store_id=capacity_window.store_id
           AND reservation.capacity_window_id=capacity_window.id
           AND reservation.status IN ('reserved','active')
          WHERE capacity_policy.tenant_id=product.tenant_id
            AND capacity_policy.store_id=product.store_id
            AND capacity_policy.station_code=capacity_need.station_code
            AND capacity_policy.status='published'
            AND capacity_window.starts_at<=clock_timestamp()+make_interval(mins=>product.recommendation_expected_prep_minutes)
            AND capacity_window.ends_at>clock_timestamp()+make_interval(mins=>product.recommendation_expected_prep_minutes)
          GROUP BY capacity_window.id,capacity_window.capacity_limit_units
          LIMIT 1
        ) window_data ON true
        WHERE capacity_need.required_units>0
      ) AS capacity_signal ON true
      WHERE product.tenant_id = $1::uuid AND product.store_id = $2::uuid
        AND product.status = 'active' AND product.guest_visible = true
        AND 'guest_qr'=ANY(product.allowed_channels)
        AND (
          product.available_from IS NULL
          OR CASE WHEN product.available_from<product.available_until
            THEN (clock_timestamp() AT TIME ZONE store.timezone)::time>=product.available_from
              AND (clock_timestamp() AT TIME ZONE store.timezone)::time<product.available_until
            ELSE (clock_timestamp() AT TIME ZONE store.timezone)::time>=product.available_from
              OR (clock_timestamp() AT TIME ZONE store.timezone)::time<product.available_until END
        )
        AND product.product_kind = 'bundle' AND product.recommendation_enabled = true
        AND product.recommendation_min_guests <= $3
        AND product.recommendation_max_guests >= $3
        AND product.cost_amount_minor IS NOT NULL
        AND price.amount_minor > product.cost_amount_minor
        AND (cardinality($4::text[]) = 0
          OR product.recommendation_beverage_family = ANY($4::text[]))
        AND NOT EXISTS (
          WITH RECURSIVE ancestry AS (
            SELECT id,merged_into_customer_id FROM mbox.customers
            WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$5::uuid
            UNION ALL
            SELECT parent.id,parent.merged_into_customer_id
            FROM mbox.customers parent JOIN ancestry child
              ON child.merged_into_customer_id=parent.id
            WHERE parent.tenant_id=$1::uuid AND parent.store_id=$2::uuid
          ), canonical AS (
            SELECT id FROM ancestry WHERE merged_into_customer_id IS NULL LIMIT 1
          ), family AS (
            SELECT id FROM canonical
            UNION ALL
            SELECT child.id FROM mbox.customers child JOIN family parent
              ON child.merged_into_customer_id=parent.id
            WHERE child.tenant_id=$1::uuid AND child.store_id=$2::uuid
          )
          SELECT 1 FROM mbox.customer_product_restrictions restriction
          WHERE restriction.tenant_id=product.tenant_id
            AND restriction.store_id=product.store_id
            AND restriction.customer_id IN (SELECT id FROM family)
            AND restriction.product_id=product.id AND restriction.status='active'
        )
        AND (
          NOT EXISTS (
            SELECT 1 FROM mbox.product_performance_phase_eligibilities configured_phase
            WHERE configured_phase.tenant_id=product.tenant_id
              AND configured_phase.store_id=product.store_id
              AND configured_phase.product_id=product.id
              AND configured_phase.status='active'
          )
          OR EXISTS (
            SELECT 1
            FROM mbox.product_performance_phase_eligibilities eligible_phase
            JOIN (
              SELECT min(event.phase_code) AS phase_code
              FROM mbox.schedule_performance_phase_events event
              JOIN mbox.schedules active_schedule
                ON active_schedule.tenant_id=event.tenant_id
               AND active_schedule.store_id=event.store_id
               AND active_schedule.id=event.schedule_id
              WHERE event.tenant_id=product.tenant_id
                AND event.store_id=product.store_id
                AND event.status='active'
                AND active_schedule.status='performing'
              HAVING count(*)=1
            ) reliable_phase ON reliable_phase.phase_code=eligible_phase.phase_code
            WHERE eligible_phase.tenant_id=product.tenant_id
              AND eligible_phase.store_id=product.store_id
              AND eligible_phase.product_id=product.id
              AND eligible_phase.status='active'
          )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM mbox.product_bundle_components component
          JOIN mbox.products component_product
            ON component_product.tenant_id=component.tenant_id
           AND component_product.store_id=component.store_id
           AND component_product.id=component.component_product_id
          LEFT JOIN mbox.recipes recipe
            ON recipe.tenant_id=component_product.tenant_id
           AND recipe.store_id=component_product.store_id
           AND recipe.product_id=component_product.id
           AND recipe.status='active' AND recipe.effective_at<=clock_timestamp()
          WHERE component.tenant_id=product.tenant_id AND component.store_id=product.store_id
            AND component.bundle_product_id=product.id
            AND (
              component_product.status<>'active'
              OR (component_product.fulfillment_station<>'none' AND (
                recipe.id IS NULL OR NOT EXISTS (
                  SELECT 1 FROM mbox.recipe_items required_recipe_item
                  WHERE required_recipe_item.tenant_id=recipe.tenant_id
                    AND required_recipe_item.store_id=recipe.store_id
                    AND required_recipe_item.recipe_id=recipe.id
                )
              ))
            )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM (
            SELECT recipe_item.inventory_item_id,
              SUM(component.quantity::numeric
                *(recipe_item.quantity+recipe_item.expected_waste_quantity)
                /recipe.yield_quantity::numeric) AS required_quantity
            FROM mbox.product_bundle_components component
            JOIN mbox.recipes recipe
              ON recipe.tenant_id=component.tenant_id AND recipe.store_id=component.store_id
             AND recipe.product_id=component.component_product_id
             AND recipe.status='active' AND recipe.effective_at<=clock_timestamp()
            JOIN mbox.recipe_items recipe_item
              ON recipe_item.tenant_id=recipe.tenant_id AND recipe_item.store_id=recipe.store_id
             AND recipe_item.recipe_id=recipe.id
            WHERE component.tenant_id=product.tenant_id AND component.store_id=product.store_id
              AND component.bundle_product_id=product.id
            GROUP BY recipe_item.inventory_item_id
          ) demand
          LEFT JOIN mbox.inventory_balances balance
            ON balance.tenant_id=product.tenant_id AND balance.store_id=product.store_id
           AND balance.inventory_item_id=demand.inventory_item_id
          WHERE COALESCE(balance.on_hand_quantity-balance.reserved_quantity,0)<demand.required_quantity
        )
        AND NOT EXISTS (
          SELECT 1
          FROM (
            SELECT component_product.fulfillment_station AS station_code,
              SUM(component.quantity*component_product.capacity_units)::bigint AS required_units
            FROM mbox.product_bundle_components component
            JOIN mbox.products component_product
              ON component_product.tenant_id=component.tenant_id
             AND component_product.store_id=component.store_id
             AND component_product.id=component.component_product_id
            WHERE component.tenant_id=product.tenant_id AND component.store_id=product.store_id
              AND component.bundle_product_id=product.id
              AND component_product.fulfillment_station<>'none'
            GROUP BY component_product.fulfillment_station
          ) capacity_need
          WHERE EXISTS (
            SELECT 1 FROM mbox.fulfillment_capacity_policy_versions configured_policy
            WHERE configured_policy.tenant_id=product.tenant_id AND configured_policy.store_id=product.store_id
              AND configured_policy.station_code=capacity_need.station_code AND configured_policy.status='published'
          ) AND NOT EXISTS (
            SELECT 1
            FROM mbox.fulfillment_capacity_policy_versions capacity_policy
            JOIN mbox.fulfillment_capacity_windows capacity_window
              ON capacity_window.tenant_id=capacity_policy.tenant_id
             AND capacity_window.store_id=capacity_policy.store_id
             AND capacity_window.policy_version_id=capacity_policy.id
            WHERE capacity_policy.tenant_id=product.tenant_id AND capacity_policy.store_id=product.store_id
              AND capacity_policy.station_code=capacity_need.station_code AND capacity_policy.status='published'
              AND capacity_window.starts_at<=clock_timestamp()+make_interval(mins=>product.recommendation_expected_prep_minutes)
              AND capacity_window.ends_at>clock_timestamp()+make_interval(mins=>product.recommendation_expected_prep_minutes)
              AND capacity_window.capacity_limit_units-COALESCE((
                SELECT SUM(reservation.capacity_units)
                FROM mbox.fulfillment_capacity_reservations reservation
                WHERE reservation.tenant_id=capacity_window.tenant_id
                  AND reservation.store_id=capacity_window.store_id
                  AND reservation.capacity_window_id=capacity_window.id
                  AND reservation.status IN ('reserved','active')
              ),0)>=capacity_need.required_units
          )
        )
      ORDER BY product.recommendation_priority, price.amount_minor, product.id
      LIMIT 60
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      answers.partySize,
      families,
      customerId,
    ])
    return result.rows
  }

  private async checkoutUpgradeStructureFingerprint(targetProductId: string): Promise<{
    bundleFingerprint: string
    recipeFingerprint: string
  }> {
    const components = await this.transaction.query<{
      id: string
      component_product_id: string
      quantity: number
      sort_order: number
      updated_at: string
      product_status: string
      fulfillment_station: string
      product_updated_at: string
    }>(`
      SELECT component.id, component.component_product_id, component.quantity,
        component.sort_order, component.updated_at::text,
        product.status AS product_status, product.fulfillment_station,
        product.updated_at::text AS product_updated_at
      FROM mbox.product_bundle_components AS component
      JOIN mbox.products AS product
        ON product.tenant_id=component.tenant_id AND product.store_id=component.store_id
       AND product.id=component.component_product_id
      WHERE component.tenant_id=$1::uuid AND component.store_id=$2::uuid
        AND component.bundle_product_id=$3::uuid
      ORDER BY component.sort_order, component.component_product_id, component.id
      FOR UPDATE OF component, product
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, targetProductId])
    if (components.rows.length === 0) {
      throw new CustomerExperienceRequestError(
        '升级套餐尚未配置可履约的商品组件',
        'CHECKOUT_UPGRADE_BUNDLE_INVALID',
        409,
      )
    }
    if (components.rows.some((component) => component.product_status !== 'active')) {
      throw new CustomerExperienceRequestError(
        '升级套餐包含已停用商品',
        'CHECKOUT_UPGRADE_BUNDLE_INVALID',
        409,
      )
    }
    const productIds = [targetProductId, ...components.rows.map((component) => component.component_product_id)]
    const recipes = await this.transaction.query<{
      recipe_id: string
      product_id: string
      version: number
      yield_quantity: number
      recipe_updated_at: string
      recipe_item_id: string
      inventory_item_id: string
      quantity: string
      expected_waste_quantity: string
      inventory_status: string
    }>(`
      SELECT recipe.id AS recipe_id, recipe.product_id, recipe.version,
        recipe.yield_quantity, recipe.updated_at::text AS recipe_updated_at,
        item.id AS recipe_item_id, item.inventory_item_id,
        item.quantity::text, item.expected_waste_quantity::text,
        inventory.status AS inventory_status
      FROM mbox.recipes AS recipe
      JOIN mbox.recipe_items AS item
        ON item.tenant_id=recipe.tenant_id AND item.store_id=recipe.store_id
       AND item.recipe_id=recipe.id
      JOIN mbox.inventory_items AS inventory
        ON inventory.tenant_id=item.tenant_id AND inventory.store_id=item.store_id
       AND inventory.id=item.inventory_item_id
      WHERE recipe.tenant_id=$1::uuid AND recipe.store_id=$2::uuid
        AND recipe.product_id=ANY($3::uuid[]) AND recipe.status='active'
      ORDER BY recipe.product_id, recipe.version, item.inventory_item_id, item.id
      FOR UPDATE OF recipe, item
      FOR SHARE OF inventory
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, productIds])
    if (recipes.rows.some((recipe) => recipe.inventory_status !== 'active')) {
      throw new CustomerExperienceRequestError(
        '升级套餐配方包含已停用库存物料',
        'CHECKOUT_UPGRADE_RECIPE_INVALID',
        409,
      )
    }
    const requiredRecipeProductIds = components.rows
      .filter((component) => component.fulfillment_station === 'bar' || component.fulfillment_station === 'kitchen')
      .map((component) => component.component_product_id)
    const configuredRecipeProductIds = new Set(recipes.rows.map((recipe) => recipe.product_id))
    const missingRecipe = requiredRecipeProductIds.find((productId) => !configuredRecipeProductIds.has(productId))
    if (missingRecipe !== undefined) {
      throw new CustomerExperienceRequestError(
        '升级套餐组件缺少有效配方，暂不能提供',
        'CHECKOUT_UPGRADE_RECIPE_INVALID',
        409,
      )
    }
    return {
      bundleFingerprint: sha256Json(components.rows),
      recipeFingerprint: sha256Json(recipes.rows),
    }
  }

  private async expireCheckoutUpgradeOffers(tableSessionId: string, customerId: string): Promise<void> {
    await this.transaction.query(`
      WITH expired AS (
        UPDATE mbox.checkout_upgrade_offers
        SET status='expired',updated_at=clock_timestamp()
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid
          AND table_session_id=$3::uuid AND customer_id=$4::uuid
          AND status IN ('offered','selected') AND valid_until<=clock_timestamp()
        RETURNING id
      )
      INSERT INTO mbox.checkout_upgrade_offer_events(
        tenant_id,store_id,public_id,offer_id,event_type,actor_type,
        actor_customer_id,reason_code,order_id,order_item_id,idempotency_key
      )
      SELECT $1::uuid,$2::uuid,'checkout-upgrade-event-'||gen_random_uuid(),id,
        'invalidated','system',NULL,'expired',NULL,NULL,'expired:'||id::text
      FROM expired
      ON CONFLICT (tenant_id,store_id,offer_id,idempotency_key) DO NOTHING
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, tableSessionId, customerId])
  }

  private async insertCheckoutUpgradeEvent(input: Readonly<{
    offerId: string
    eventType: 'offered' | 'viewed' | 'declined' | 'accepted' | 'converted' | 'invalidated'
    actorType: 'guest' | 'system'
    customerId: string | null
    reasonCode: 'kept_original' | 'not_needed' | 'expired' | 'price_changed'
      | 'structure_changed' | 'capacity_unavailable' | 'order_failed' | 'rule_replaced' | null
    orderId: string | null
    orderItemId: string | null
    idempotencyKey: string
  }>): Promise<void> {
    await this.transaction.query(`
      INSERT INTO mbox.checkout_upgrade_offer_events(
        tenant_id,store_id,public_id,offer_id,event_type,actor_type,
        actor_customer_id,reason_code,order_id,order_item_id,idempotency_key
      ) VALUES (
        $1::uuid,$2::uuid,$3,$4::uuid,$5,$6,$7::uuid,$8,$9::uuid,$10::uuid,$11
      )
      ON CONFLICT (tenant_id,store_id,offer_id,idempotency_key) DO NOTHING
    `, [
      this.transaction.scope.tenantId,this.transaction.scope.storeId,
      `checkout-upgrade-event-${randomUUID()}`,input.offerId,input.eventType,input.actorType,
      input.customerId,input.reasonCode,input.orderId,input.orderItemId,input.idempotencyKey,
    ])
  }
}

export function buildExperienceCues(input: Readonly<{
  serviceIntensity: ServiceIntensity
  occasion: string
  createdAt: Date
  show: JsonObject
}>): ExperienceCueDraft[] {
  const due = (minutes: number) => new Date(input.createdAt.getTime() + minutes * 60_000).toISOString()
  const cues: ExperienceCueDraft[] = [
    cue('welcome.promise', 1, 0, 'welcome', 'host', '确认今晚需求、称呼、主要联系人和不希望被打扰的边界；只承诺系统能履约的内容。', due(0)),
    cue('first.wave', 2, 5, 'drink', 'bar', '先出第一轮核心酒水；冷食只上适合当前人数的一份，桌面不要一次堆满。', due(5)),
    cue('first.food', 3, 8, 'food', 'cold_kitchen', '按套餐组件出第一轮低气味冷食，并确认杯具、温度和桌面空间。', due(8)),
    cue('comfort.check', 4, 18, 'checkin', 'service', '用一句具体问题确认第一轮是否合口味，不问“还需要什么”。', due(18)),
    cue('show.bridge', 5, 30, 'music', 'stage', '结合当前演出段落提醒值得听的一首歌；不强迫互动，不在客户深聊时打断。', due(30), 'performance', 'acoustic'),
    cue('second.wave', 6, 42, 'drink', 'bar', '根据饮用进度和演出节奏准备第二轮；未确认前不得提前开瓶或出酒。', due(42)),
    cue('value.moment', 7, 58, 'interaction', 'service', occasionInstruction(input.occasion), due(58)),
    cue('experience.extend', 8, 72, 'upsell', 'service', '只有客户第一轮满意且酒水低于三分之一时，给出一个明确的延续选项和总价。', due(72)),
    cue('farewell.memory', 9, 105, 'farewell', 'manager', '结账前确认是否有未解决事项；离店时复述一个今晚的具体记忆点，并给出真实可用的下次权益。', due(105)),
  ]
  if (input.serviceIntensity === 'quiet') {
    return cues.filter((item) => !['value.moment', 'experience.extend'].includes(item.code))
      .map((item, index) => ({ ...item, sequence: index + 1 }))
  }
  if (input.serviceIntensity === 'hosted') {
    cues.splice(6, 0, cue('hosted.attention', 7, 50, 'interaction', 'manager', '经理确认一次体验节奏；可安排合影、歌手问候或纪念小物，但必须先征得客户同意。', due(50)))
    return cues.map((item, index) => ({ ...item, sequence: index + 1 }))
  }
  return cues
}

function cue(
  code: string,
  sequence: number,
  offset: number,
  actionKind: ExperienceCueDraft['actionKind'],
  station: ExperienceCueDraft['station'],
  instruction: string,
  dueAt: string,
  triggerKind: ExperienceCueDraft['triggerKind'] = 'elapsed',
  performancePhase: ExperienceCueDraft['performancePhase'] = null,
): ExperienceCueDraft {
  return {
    code,
    sequence,
    triggerKind,
    triggerOffsetMinutes: offset,
    performancePhase,
    actionKind,
    station,
    payload: { instruction },
    dueAt,
  }
}

function occasionInstruction(occasion: string): string {
  if (occasion === 'business') return '保持克制，只提供一轮换杯、加水和轻食整理；不要全场公开客户身份。'
  if (occasion === 'birthday') return '与组织者确认公开程度后再执行祝福、合影或点歌，避免泄露惊喜。'
  if (occasion === 'date') return '提供一次自然的合影或共同品鉴选择；不评价双方关系，不制造尴尬。'
  if (occasion === 'music') return '提供歌单信息或点歌入口，让音乐成为交流素材，不要求客户全场参与。'
  return '给出一个低压力的共同选择，例如交换品鉴或选择下一段音乐氛围。'
}

function rankProducts(
  rows: RecommendationProductRow[],
  answers: RecommendationAnswer,
  policy: RecommendationPolicyRow,
): RecommendedProduct[] {
  const ranked = rows.map((row) => {
    const amount = money(row.amount_minor, 'product amount')
    const cost = money(row.cost_amount_minor, 'product cost')
    const separate = row.separate_amount_minor === null ? null : money(row.separate_amount_minor, 'separate amount')
    const contributions = recommendationScore(row, answers, policy)
    return {
      row,
      amount,
      cost,
      separate,
      grossMarginBasisPoints: Math.floor((amount - cost) * 10_000 / amount),
      score: contributions.total,
    }
  }).filter((entry) => entry.grossMarginBasisPoints >= policy.minimum_gross_margin_basis_points)
    .toSorted((left, right) => right.score - left.score || left.amount - right.amount || left.row.id.localeCompare(right.row.id))
  if (ranked.length === 0) return []
  const candidates = distinctByAmount(ranked.slice(0, 12))
  const selected = tierSelections(candidates, answers.experienceLevel)
  return selected.map(({ item, tier }) => productView(item.row, tier, answers, item.amount, item.cost, item.separate))
}

function recommendationScore(
  row: RecommendationProductRow,
  answers: RecommendationAnswer,
  policy: RecommendationPolicyRow,
): Readonly<{
  total: number
  preference: number
  scene: number
  margin: number
  priority: number
  performance: number
  inventory: number
  capacity: number
}> {
  const amount = money(row.amount_minor, 'recommendation product amount')
  const cost = money(row.cost_amount_minor, 'recommendation product cost')
  const grossMarginBasisPoints = Math.max(0, Math.floor((amount - cost) * 10_000 / amount))
  const statedPreference = preferenceFamilies(answers.alcoholPreference).includes(row.beverage_family)
    ? policy.preference_weight : 0
  const learnedPreference = Math.floor(
    policy.preference_weight*Math.min(10_000,Math.max(0,row.learned_preference_score))/10_000,
  )
  const preference = statedPreference+learnedPreference
  const scene = row.recommendation_scene_tags.includes(sceneTag(answers.occasion))
    ? policy.scene_weight : 0
  const margin = Math.floor(policy.margin_weight * grossMarginBasisPoints / 10_000)
  const priority = Math.max(0, policy.priority_weight - row.recommendation_priority)
  const performance = recommendationOperationalSignalContribution(
    policy.performance_weight,row.performance_signal_basis_points,
  )
  const inventory = recommendationOperationalSignalContribution(
    policy.inventory_weight,row.inventory_signal_basis_points,
  )
  const capacity = recommendationOperationalSignalContribution(
    policy.capacity_weight,row.capacity_signal_basis_points,
  )
  return {
    total: preference + scene + margin + priority + performance + inventory + capacity,
    preference,
    scene,
    margin,
    priority,
    performance,
    inventory,
    capacity,
  }
}

export function recommendationOperationalSignalContribution(weight: number,basisPoints: number): number {
  if (!Number.isSafeInteger(weight) || !Number.isSafeInteger(basisPoints)) {
    throw new Error('recommendation operational signal must be a safe integer')
  }
  return Math.floor(weight*Math.min(10_000,Math.max(0,basisPoints))/10_000)
}

function tierSelections<T extends { amount: number }>(items: T[], preferred: ExperienceLevel): Array<{ item: T; tier: ExperienceLevel }> {
  if (items.length === 1) return [{ item: items[0]!, tier: preferred }]
  if (items.length === 2) return [
    { item: items[0]!, tier: preferred === 'signature' ? 'enhanced' : 'comfortable' },
    { item: items[1]!, tier: preferred === 'comfortable' ? 'enhanced' : 'signature' },
  ]
  const middle = Math.floor((items.length - 1) / 2)
  return [
    { item: items[0]!, tier: 'comfortable' },
    { item: items[middle]!, tier: 'enhanced' },
    { item: items.at(-1)!, tier: 'signature' },
  ]
}

function distinctByAmount<T extends { amount: number }>(items: T[]): T[] {
  const seen = new Set<number>()
  return items.filter((item) => {
    if (seen.has(item.amount)) return false
    seen.add(item.amount)
    return true
  }).toSorted((left, right) => left.amount - right.amount)
}

function productView(
  row: RecommendationProductRow,
  tier: ExperienceLevel,
  answers: RecommendationAnswer,
  amount: number,
  cost: number,
  separate: number | null,
): RecommendedProduct {
  const included = componentList(row.component_list)
  return {
    productId: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    imageUrl: safeAssetUrl(row.image_url),
    beverageFamily: row.beverage_family,
    amountMinor: amount,
    separateAmountMinor: separate,
    savingsAmountMinor: separate !== null && separate > amount ? separate - amount : null,
    currency: row.currency,
    grossMarginBasisPoints: Math.floor((amount - cost) * 10_000 / amount),
    tier,
    reason: recommendationReason(answers, tier, row.beverage_family),
    included,
  }
}

function recommendationReason(answers: RecommendationAnswer, tier: ExperienceLevel, family: string): string {
  const tierCopy = tier === 'comfortable' ? '控制总价、完整体验第一轮'
    : tier === 'enhanced' ? '酒水与冷食更充足，适合完整看完演出'
      : '更强的主场感和服务参与，适合重要一晚'
  const occasionCopy = answers.occasion === 'business' ? '不打断谈话'
    : answers.occasion === 'date' ? '保留交流空间'
      : answers.occasion === 'birthday' ? '支持庆祝节奏'
        : '适合一起分享'
  return `${tierCopy}；${occasionCopy}；核心酒水为${familyLabel(family)}`
}

function preferenceFamilies(preference: AlcoholPreference): string[] {
  if (preference === 'mixed' || preference === 'undecided') return []
  if (preference === 'whisky' || preference === 'baijiu') return ['spirits']
  return [preference]
}

function sceneTag(occasion: CustomerOccasion): string {
  if (occasion === 'friends') return 'friends'
  if (occasion === 'date') return 'date'
  if (occasion === 'birthday') return 'celebration'
  if (occasion === 'business') return 'business'
  if (occasion === 'music') return 'music'
  return 'relaxed'
}

function familyLabel(family: string): string {
  const labels: Record<string, string> = {
    cocktail: '鸡尾酒', wine: '葡萄酒', sparkling: '起泡酒', beer: '啤酒',
    spirits: '烈酒', non_alcoholic: '无酒精', none: '综合',
  }
  return labels[family] ?? '综合'
}

function componentList(value: unknown): Array<{ name: string; quantity: number }> {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => isObject(item) && typeof item.name === 'string'
    && Number.isSafeInteger(item.quantity) && Number(item.quantity) > 0
    ? [{ name: item.name, quantity: Number(item.quantity) }] : [])
}

function planView(plan: PlanRow, cues: CueRow[]): ExperiencePlanView {
  const product = plan.recommendation_option_id !== null
    && plan.selected_product_id !== null
    && plan.selected_product_name_at_selection !== null
    && plan.selected_amount_minor !== null
    && plan.selected_currency !== null
    ? {
        productId: plan.selected_product_id,
        name: plan.selected_product_name_at_selection,
        amountMinor: money(plan.selected_amount_minor, 'selected plan amount'),
        currency: plan.selected_currency,
      } : null
  return {
    publicId: plan.public_id,
    state: plan.plan_state,
    partySize: plan.party_size,
    occasion: plan.occasion,
    alcoholPreference: plan.alcohol_preference,
    serviceIntensity: plan.service_intensity,
    promiseSummary: plan.promise_summary,
    selectedProduct: product,
    cues: cues.map((cueRow) => ({
      id: cueRow.id,
      code: cueRow.cue_code,
      sequence: cueRow.sequence_no,
      triggerKind: cueRow.trigger_kind,
      triggerOffsetMinutes: cueRow.trigger_offset_minutes,
      performancePhase: cueRow.performance_phase,
      actionKind: cueRow.action_kind,
      station: cueRow.station,
      payload: cueRow.action_payload,
      dueAt: cueRow.due_at,
      status: cueRow.status,
    })),
  }
}

function membershipView(row: MembershipRow): PublicMembership {
  const rollingGrowth = row.rolling_growth === null ? null : integer(row.rolling_growth, 'rolling membership growth')
  const tierProgress = row.evaluation_window_months === null || rollingGrowth === null
    ? null
    : publicTierProgress(row, rollingGrowth)
  const expiringPoints = row.expiring_points_30_days === null
    ? 0
    : integer(row.expiring_points_30_days, 'expiring membership points')
  return {
    memberNo: row.member_no,
    level: row.level,
    lifecycleStage: row.lifecycle_stage,
    pointsBalance: row.points_balance,
    growthValue: row.growth_value,
    pendingRecoveryPoints: row.pending_recovery_points,
    redemptionStatus: row.redemption_status,
    visitCount: row.visit_count,
    joinedAt: row.joined_at,
    tierProgress,
    pointsExpiry: expiringPoints > 0 && row.next_expiry_at !== null
      ? { expiringWithin30Days: expiringPoints, nextExpiryAt: row.next_expiry_at }
      : null,
  }
}

function publicTierProgress(row: MembershipRow, rollingGrowth: number): NonNullable<PublicMembership['tierProgress']> {
  const silverUpgrade = integer(row.silver_upgrade_growth, 'silver upgrade growth')
  const silverRetain = integer(row.silver_retain_growth, 'silver retain growth')
  const goldUpgrade = integer(row.gold_upgrade_growth, 'gold upgrade growth')
  const goldRetain = integer(row.gold_retain_growth, 'gold retain growth')
  const nextTier = row.level === 'member' ? 'silver' : row.level === 'silver' ? 'gold' : null
  const upgradeThreshold = row.level === 'member' ? silverUpgrade : row.level === 'silver' ? goldUpgrade : null
  const retainThreshold = row.level === 'silver' ? silverRetain : row.level === 'gold' ? goldRetain : null
  return {
    evaluationWindowMonths: integer(row.evaluation_window_months, 'tier evaluation window'),
    rollingGrowth,
    nextTier,
    upgradeThreshold,
    upgradeRemaining: upgradeThreshold === null ? null : Math.max(0, upgradeThreshold-rollingGrowth),
    retainThreshold,
    retainRemaining: retainThreshold === null ? null : Math.max(0, retainThreshold-rollingGrowth),
    periodStatus: row.period_status,
    periodEndsAt: row.period_ends_at,
    graceEndsAt: row.grace_ends_at,
  }
}

function featureView(row: FeatureRow): PublicFeature {
  return {
    code: row.feature_code,
    state: row.rollout_state,
    enabled: row.rollout_state === 'pilot' || row.rollout_state === 'enabled',
  }
}

function cardView(row: CardRow): PublicContentCard {
  return {
    code: row.code,
    type: row.card_type,
    title: row.title,
    summary: row.summary,
    imageUrl: safeAssetUrl(row.image_url),
    ctaLabel: row.cta_label,
    targetPath: safeContentTargetPath(row.target_path),
    priority: row.priority,
  }
}

function activityView(row: ActivityRow, providerConfigured: boolean): PublicActivity {
  const registered = integer(row.registered_count, 'registered count')
  const feeAmountMinor = money(row.fee_amount_minor, 'activity fee')
  const depositAmountMinor = money(row.deposit_amount_minor, 'activity deposit')
  const payment = publicActivityPaymentAvailability(
    row.registration_payment_mode,
    feeAmountMinor,
    depositAmountMinor,
    providerConfigured && row.activity_payment_authorized,
  )
  return {
    publicId: row.public_id,
    kind: row.activity_kind,
    title: row.title,
    summary: row.summary,
    coverUrl: safeAssetUrl(row.cover_url),
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    assemblyLocation: row.assembly_location,
    capacity: row.capacity,
    remainingCapacity: Math.max(0, row.capacity - registered),
    feeAmountMinor,
    depositAmountMinor,
    feeBasis: row.fee_basis,
    paymentMode: row.registration_payment_mode,
    paymentDeadlineMinutes: row.payment_deadline_minutes,
    paymentRuleText: row.payment_rule_text,
    refundPolicy: {
      ...row.refund_policy_snapshot,
      policyVersion: row.refund_policy_version,
      summary: row.refund_policy_summary,
    },
    currency: row.currency,
    pointsReward: row.points_reward,
    status: row.status,
    registrationStatus: row.registration_status,
    safety: publicSafety({
      ...row.safety_snapshot,
      policyVersion: row.safety_policy_version,
      acknowledgementText: row.safety_acknowledgement_text,
      requirements: row.safety_requirements,
    }),
    salesCopy: publicActivitySalesCopy({
      ...row.sales_copy,
      details: row.activity_details,
      includedItems: row.included_items,
      participationRequirements: row.participation_requirements,
      contactInstructions: row.contact_instructions,
      memberBenefitText: row.member_benefit_text ?? '',
    }),
    paymentAvailability: payment.availability,
    paymentBlockedReason: payment.blockedReason,
    availablePaymentChoices: payment.availableChoices,
    blockedPaymentChoices: payment.blockedChoices,
    availablePaymentMethods: providerConfigured && row.activity_payment_authorized
      && payment.availableChoices.some((choice) => choice !== 'none')
      ? ['jsapi', 'native_qr'] : [],
  }
}

export function publicActivitySalesCopy(value: JsonObject): JsonObject {
  const allowed = [
    'details', 'includedItems', 'participationRequirements',
    'memberBenefitText', 'contactInstructions',
  ]
  return Object.fromEntries(allowed.flatMap((key) => (
    value[key] === undefined ? [] : [[key, value[key]]]
  ))) as JsonObject
}

export function publicActivityPaymentAvailability(
  mode: ActivityPaymentMode,
  feeAmountMinor = 0,
  depositAmountMinor = 0,
  authorityAvailable = false,
): Readonly<{
  availability: 'available' | 'blocked'
  blockedReason: string | null
  availableChoices: ActivityPaymentChoice[]
  blockedChoices: ActivityPaymentChoice[]
}> {
  if (mode === 'none' && feeAmountMinor === 0 && depositAmountMinor === 0) return {
    availability: 'available', blockedReason: null,
    availableChoices: ['none'], blockedChoices: [],
  }
  const requiredChoices: ActivityPaymentChoice[] = mode === 'full_required' ? ['full'] : ['deposit']
  if (authorityAvailable) return {
    availability: 'available', blockedReason: null,
    availableChoices: mode === 'deposit_optional' ? ['none', 'deposit'] : requiredChoices,
    blockedChoices: [],
  }
  if (mode === 'deposit_optional') return {
    availability: 'available', blockedReason: null,
    availableChoices: ['none'], blockedChoices: ['deposit'],
  }
  return {
    availability: 'blocked', blockedReason: 'ACTIVITY_PAYMENT_AUTHORITY_NOT_CONFIGURED',
    availableChoices: [],
    blockedChoices: mode === 'none' ? ['none'] : requiredChoices,
  }
}

export function publicActivityRegistrationPaymentAvailability(
  paymentStatus: string,
  authorityAvailable: boolean,
): Readonly<{
  availability: 'available' | 'blocked' | 'not_required'
  blockedReason: string | null
}> {
  if (paymentStatus === 'not_required') return {
    availability: 'not_required', blockedReason: null,
  }
  if (paymentStatus === 'pending' && !authorityAvailable) return {
    availability: 'blocked', blockedReason: 'ACTIVITY_PAYMENT_AUTHORITY_NOT_CONFIGURED',
  }
  return { availability: 'available', blockedReason: null }
}

export function assertProtectedActivityRegistrationContact(
  value: ProtectedActivityRegistrationContact,
): void {
  const allowed = [
    'contactType', 'contactHash', 'encryptedContact',
    'encryptionKeyId', 'maskedContact', 'source',
  ]
  const keys = Object.keys(value).toSorted()
  if (keys.length !== allowed.length || keys.some((key) => !allowed.includes(key))) {
    throw new CustomerExperienceRequestError('报名联系信息未受保护', 'ACTIVITY_CONTACT_UNPROTECTED')
  }
  if (!['phone', 'wechat', 'other'].includes(String(value.contactType))
    || typeof value.contactHash !== 'string' || !/^[0-9a-f]{64}$/.test(value.contactHash)
    || typeof value.encryptedContact !== 'string'
    || value.encryptedContact.length < 24 || value.encryptedContact.length > 4096
    || typeof value.encryptionKeyId !== 'string'
    || value.encryptionKeyId.trim().length < 3 || value.encryptionKeyId.trim().length > 128
    || typeof value.maskedContact !== 'string'
    || value.maskedContact.trim().length < 3 || value.maskedContact.trim().length > 64
    || value.source !== 'mini_program') {
    throw new CustomerExperienceRequestError('报名联系信息未受保护', 'ACTIVITY_CONTACT_UNPROTECTED')
  }
}

function benefitPortalView(row: BenefitPortalRow): PublicBenefit {
  const display = isObject(row.benefit_snapshot.publicDisplay)
    ? row.benefit_snapshot.publicDisplay : {}
  const name = text(display.name) ?? text(display.title) ?? row.benefit_code
  const description = text(display.description) ?? text(display.summary) ?? '到店后可查看具体使用条件'
  return {
    id: row.id,
    code: row.benefit_code,
    type: row.benefit_type,
    name,
    description,
    remainingQuantity: Math.max(0, row.quantity_total - row.quantity_reserved - row.quantity_redeemed),
    valueAmountMinor: row.value_amount_minor === null ? null : money(row.value_amount_minor, 'benefit value'),
    currency: row.currency,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    status: row.status,
    display,
  }
}

function checkoutUpgradeOfferView(row: CheckoutUpgradeOfferRow): CheckoutUpgradeOfferView {
  return {
    publicId: row.public_id,
    ruleRevision: Number(row.rule_revision),
    sourceProduct: {
      productId: row.source_product_id,
      name: row.source_name,
      amountMinor: money(row.source_amount_minor, 'source amount'),
    },
    targetExperience: {
      name: row.target_name,
      totalAmountMinor: money(row.target_amount_minor, 'target total amount'),
      included: row.target_included_items,
    },
    amountToAddMinor: money(row.amount_to_add_minor, 'upgrade amount'),
    currency: row.currency,
    validUntil: row.valid_until,
    status: row.status,
    prompt: {
      title: row.prompt_title,
      body: row.prompt_body,
      callToAction: row.call_to_action,
    },
    ruleCopy: '付款前升级：原单杯会替换为完整套餐，并按套餐总价一次结算；不会先收费再退款。',
  }
}

function normalizeCheckoutBasket(items: readonly CheckoutBasketLine[]): CheckoutBasketLine[] {
  if (items.length === 0 || items.length > 50) {
    throw new CustomerExperienceRequestError('购物车商品数量不正确', 'CHECKOUT_BASKET_INVALID')
  }
  const normalized = items.map((item) => {
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(item.productId)
      || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 20) {
      throw new CustomerExperienceRequestError('购物车商品不正确', 'CHECKOUT_BASKET_INVALID')
    }
    return {
      productId: item.productId,
      quantity: item.quantity,
      ...(item.note?.trim() ? { note: item.note.trim().slice(0, 240) } : {}),
    }
  })
  return normalized.toSorted((left, right) => (
    left.productId.localeCompare(right.productId) || (left.note ?? '').localeCompare(right.note ?? '')
  ))
}

export function resolveActivityRegistrationPayment(
  mode: ActivityPaymentMode,
  requestedChoice: ActivityPaymentChoice,
  amounts: Readonly<{ totalFeeAmountMinor: number; depositAmountMinor: number }>,
): { choice: ActivityPaymentChoice; amountDueMinor: number } {
  if (mode === 'none') {
    if (requestedChoice !== 'none') {
      throw new CustomerExperienceRequestError('本活动无需预付，请直接报名', 'ACTIVITY_PAYMENT_CHOICE_INVALID')
    }
    return { choice: 'none', amountDueMinor: 0 }
  }
  if (mode === 'deposit_optional') {
    if (requestedChoice === 'none') return { choice: 'none', amountDueMinor: 0 }
    if (requestedChoice === 'deposit') return { choice: 'deposit', amountDueMinor: amounts.depositAmountMinor }
    throw new CustomerExperienceRequestError('本活动只支持选择付订金或到店支付', 'ACTIVITY_PAYMENT_CHOICE_INVALID')
  }
  if (mode === 'deposit_required') {
    if (requestedChoice !== 'deposit') {
      throw new CustomerExperienceRequestError('本活动需支付订金后保留名额', 'ACTIVITY_DEPOSIT_REQUIRED', 409)
    }
    return { choice: 'deposit', amountDueMinor: amounts.depositAmountMinor }
  }
  if (requestedChoice !== 'full') {
    throw new CustomerExperienceRequestError('本活动需全额预付后保留名额', 'ACTIVITY_FULL_PAYMENT_REQUIRED', 409)
  }
  return { choice: 'full', amountDueMinor: amounts.totalFeeAmountMinor }
}

function checkoutBasketFingerprint(
  items: readonly CheckoutBasketLine[],
  pricing: Readonly<{
    ruleId: string
    ruleUpdatedAt: string
    sourceProductId: string
    targetProductId: string
    sourceAmountMinor: number
    targetAmountMinor: number
    currency: string
  }>,
): string {
  return createHash('sha256').update(JSON.stringify({ items, pricing })).digest('hex')
}

function sha256Json(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function replaceCheckoutLine(
  items: readonly CheckoutBasketLine[],
  sourceProductId: string,
  targetProductId: string,
): CheckoutBasketLine[] {
  let replaced = false
  const upgraded = items.map((item) => {
    if (!replaced && item.productId === sourceProductId && item.quantity === 1) {
      replaced = true
      return { productId: targetProductId, quantity: 1 }
    }
    return item
  })
  if (!replaced) throw new CustomerExperienceRequestError('购物车中没有可升级商品', 'CHECKOUT_UPGRADE_SOURCE_MISSING')
  return normalizeCheckoutBasket(upgraded)
}

function publicPointDescription(
  entryType: PublicPointEntry['entryType'],
  sourceKind: PublicPointEntry['sourceKind'],
): string {
  if (entryType === 'earn') return '已按付款订单和锁定规则入账'
  if (entryType === 'redeem') return '已用于本人确认的积分兑换'
  if (entryType === 'expire') return '积分批次已按锁定有效期到期'
  if (entryType === 'supplement') return '门店复核权威交易后补发'
  if (entryType === 'adjust') return '门店授权调整，详细依据由门店留档'
  if (entryType === 'restore') return '未完成兑换已按原积分批次返还'
  return sourceKind === 'refund'
    ? '权威退款确认后按原订单规则冲回'
    : '已按原业务事实冲回'
}

function publicGrowthDescription(
  entryType: PublicGrowthEntry['entryType'],
  sourceKind: PublicGrowthEntry['sourceKind'],
): string {
  if (entryType === 'earn') return '已按付款订单和锁定规则计入成长值'
  if (entryType === 'supplement') return '门店复核权威交易后补发成长值'
  if (entryType === 'adjust') return '门店授权调整，详细依据由门店留档'
  return sourceKind === 'refund'
    ? '权威退款确认后按原订单规则冲回成长值'
    : '已按原业务事实冲回成长值'
}

function publicLoyaltyProcessingItem(row: LoyaltyProcessingRow): PublicLoyaltyProcessingItem {
  if (row.kind === 'accrual') {
    const state = row.status === 'pending'
      ? 'pending'
      : row.status === 'processing'
        ? 'processing'
        : row.status === 'review_required'
          ? 'manual_review'
          : row.status === 'applied'
            ? 'resolved'
            : 'no_action_needed'
    return {
      key: `accrual:${row.source_reference}`,
      kind: 'accrual',
      state,
      title: state === 'resolved'
        ? '消费积分已入账'
        : state === 'no_action_needed'
          ? '订单无需发放积分'
          : state === 'manual_review'
            ? '积分正在人工核对'
            : '积分正在处理中',
      message: state === 'resolved'
        ? '系统已根据付款与订单事实完成处理。'
        : state === 'no_action_needed'
          ? '系统复核后确认该订单不产生积分。'
          : state === 'manual_review'
            ? '系统未返回虚假到账，门店正在核对付款、退款和规则。'
            : '已保留付款事实，系统会继续安全重试，不会重复发放。',
      sourceReference: row.source_reference,
      occurredAt: row.occurred_at,
      updatedAt: row.updated_at,
      active: state === 'pending' || state === 'processing' || state === 'manual_review',
    }
  }
  const state = row.status === 'requested' || row.status === 'approved'
    ? 'manual_review'
    : row.status === 'executed'
      ? 'resolved'
      : row.status === 'not_required'
        ? 'no_action_needed'
        : 'closed'
  return {
    key: `supplement:${row.source_reference}`,
    kind: 'supplement',
    state,
    title: state === 'resolved'
      ? '漏发积分已补齐'
      : state === 'no_action_needed'
        ? '系统已自动恢复'
        : state === 'manual_review'
          ? '门店正在核对积分'
          : '积分核对已结束',
    message: state === 'resolved'
      ? '门店复核权威交易后已补发差额。'
      : state === 'no_action_needed'
        ? '自动处理已经完成，无需再次补发。'
        : state === 'manual_review'
          ? '门店将按付款、退款和既有流水复核，顾客无需填写补分金额。'
          : '本次申请未执行补发，如仍有疑问请联系门店。',
    sourceReference: row.source_reference,
    occurredAt: row.occurred_at,
    updatedAt: row.updated_at,
    active: state === 'manual_review',
  }
}

function audienceAllows(
  visibility: 'public' | 'member' | 'segment',
  requiredLevels: readonly string[],
  requiredStages: readonly string[],
  membership: PublicMembership | null,
): boolean {
  if (visibility === 'public') return true
  if (membership === null) return false
  if (membership !== null && requiredLevels.length > 0 && !requiredLevels.includes(membership.level)) return false
  if (membership !== null && requiredStages.length > 0 && !requiredStages.includes(membership.lifecycleStage)) return false
  return true
}

function publicSafety(value: JsonObject): JsonObject {
  const allowed = [
    'policyVersion', 'acknowledgementText', 'difficulty', 'insuranceIncluded',
    'requirements', 'cancellationPolicy', 'ageRequirement',
  ]
  return Object.fromEntries(allowed.flatMap((key) => value[key] === undefined ? [] : [[key, value[key]]]))
}

export function serverActivityTermsAcknowledgement(
  publishedSafetyPolicyVersion: string,
  publishedRefundPolicyVersion: string,
  submittedSafetyPolicyVersion: string,
  submittedRefundPolicyVersion: string,
  acknowledged: boolean,
): Readonly<{
  safetyPolicyVersion: string
  refundPolicyVersion: string
  source: 'mini_program'
  evidence: JsonObject
}> {
  const safetyPolicyVersion = publishedSafetyPolicyVersion.trim()
  const refundPolicyVersion = publishedRefundPolicyVersion.trim()
  if (safetyPolicyVersion === '' || refundPolicyVersion === '') {
    throw new CustomerExperienceRequestError(
      '活动安全或退款条款缺少有效版本，当前不能报名',
      'ACTIVITY_TERMS_NOT_CONFIGURED',
      503,
    )
  }
  if (
    acknowledged !== true
    || submittedSafetyPolicyVersion.trim() !== safetyPolicyVersion
    || submittedRefundPolicyVersion.trim() !== refundPolicyVersion
  ) {
    throw new CustomerExperienceRequestError(
      '请阅读并确认当前版本的活动安全与退款条款',
      'ACTIVITY_TERMS_ACKNOWLEDGEMENT_REQUIRED',
      409,
    )
  }
  return {
    safetyPolicyVersion,
    refundPolicyVersion,
    source: 'mini_program',
    evidence: {
      acknowledged: true,
      safetyPolicyVersion,
      refundPolicyVersion,
      acknowledgedAt: new Date().toISOString(),
      source: 'mini_program',
    },
  }
}

function safeAssetUrl(value: string | null): string | null {
  if (value === null || value.trim() === '') return null
  if (value.startsWith('/') && !value.startsWith('//')) return value
  if (/^https:\/\//i.test(value)) return value
  return null
}

function recommendationPolicyVersionView(row: RecommendationPolicyVersionRow): RecommendationPolicyVersionView {
  return {
    publicId: row.public_id,
    code: row.policy_code,
    version: row.version,
    status: row.status,
    preferenceWeight: row.preference_weight,
    sceneWeight: row.scene_weight,
    marginWeight: row.margin_weight,
    priorityWeight: row.priority_weight,
    performanceWeight: row.performance_weight,
    inventoryWeight: row.inventory_weight,
    capacityWeight: row.capacity_weight,
    minimumGrossMarginBasisPoints: row.minimum_gross_margin_basis_points,
    preferenceHalfLifeDays: row.preference_half_life_days,
    preferenceMaxAgeDays: row.preference_max_age_days,
    preferenceMinEffectiveScore: row.preference_min_effective_score,
    preferenceMinConfidenceBasisPoints: row.preference_min_confidence_basis_points,
    explanationTemplate: row.explanation_template,
    draftReason: row.draft_reason,
    approvalReason: row.approval_reason,
    publicationReason: row.publication_reason,
    publicationMode: row.publication_mode,
    createdBy: row.created_by,
    approvedBy: row.approved_by,
    publishedBy: row.published_by,
    createdAt: row.created_at,
    approvedAt: row.approved_at,
    publishedAt: row.published_at,
    effectiveFrom: row.effective_from,
    effectiveUntil: row.effective_until,
  }
}

const CONTENT_CARD_SIMPLE_TARGETS = new Set([
  '/pages/home/index',
  '/pages/reservations/index',
  '/pages/order/index',
  '/pages/community/index',
  '/pages/profile/index',
  '/pages/songs/index',
  '/pages/privacy/index',
])

export function safeContentTargetPath(value: string): string | null {
  if (!value.startsWith('/') || value.startsWith('//')) return null
  try {
    const parsed = new URL(value, 'https://mini.mbox.invalid')
    if (parsed.origin !== 'https://mini.mbox.invalid' || parsed.hash !== '') return null
    if (CONTENT_CARD_SIMPLE_TARGETS.has(parsed.pathname)) {
      return parsed.search === '' ? parsed.pathname : null
    }
    if (parsed.pathname !== '/pages/community-detail/index') return null
    const identifiers = parsed.searchParams.getAll('id')
    if (identifiers.length !== 1 || Array.from(parsed.searchParams.keys()).some((key) => key !== 'id')) return null
    const publicId = identifiers[0]?.trim() ?? ''
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/.test(publicId)) return null
    return `/pages/community-detail/index?id=${encodeURIComponent(publicId)}`
  } catch {
    return null
  }
}

function restrictionView(row: CustomerProductRestrictionRow): CustomerProductRestrictionView {
  return {
    publicId: row.public_id,
    productId: row.product_id,
    productName: row.product_name,
    restrictionType: row.restriction_type,
    createdAt: row.created_at,
  }
}

function performancePhaseEventView(row: PerformancePhaseEventRow): PerformancePhaseEventView {
  return {
    publicId: row.public_id,
    scheduleId: row.schedule_id,
    performerStageName: row.performer_stage_name,
    phaseCode: row.phase_code,
    status: row.status,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    cancelledAt: row.cancelled_at,
  }
}

function money(value: unknown, name: string): number {
  if ((typeof value !== 'number' && typeof value !== 'string')
    || (typeof value === 'string' && value.trim() === '')) {
    throw new TypeError(`${name} is invalid`)
  }
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(number) || number < 0) throw new TypeError(`${name} is invalid`)
  return number
}

function integer(value: unknown, name: string): number {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(number) || number < 0) throw new TypeError(`${name} is invalid`)
  return number
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map((item) => item.trim())
    : []
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredRow<Row>(row: Row | undefined, label: string): Row {
  if (!row) throw new Error(`${label} did not return a row`)
  return row
}
