import { createHash, randomUUID } from 'node:crypto'
import type { JsonObject } from './command-executor.js'
import type { ScopedTransaction } from './transaction-runner.js'

export type RolloutState = 'disabled' | 'shadow' | 'pilot' | 'enabled'
export type CustomerOccasion = 'business' | 'friends' | 'date' | 'birthday' | 'music' | 'relax' | 'other'
export type AlcoholPreference = 'cocktail' | 'wine' | 'sparkling' | 'beer' | 'whisky' | 'baijiu' | 'non_alcoholic' | 'mixed' | 'undecided'
export type ExperienceLevel = 'comfortable' | 'enhanced' | 'signature'
export type ServiceIntensity = 'quiet' | 'balanced' | 'hosted'
export type ActivityFeeBasis = 'per_person' | 'per_registration'
export type ActivityPaymentMode = 'none' | 'deposit_optional' | 'deposit_required' | 'full_required'
export type ActivityPaymentChoice = 'none' | 'deposit' | 'full'

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
  level: 'member' | 'silver' | 'gold' | 'black'
  lifecycleStage: 'new' | 'active' | 'high_value' | 'at_risk' | 'dormant'
  pointsBalance: number
  visitCount: number
  joinedAt: string
}

export interface PublicPointEntry {
  id: string
  entryType: 'earn' | 'redeem' | 'expire' | 'adjust'
  pointsDelta: number
  balanceAfter: number
  reason: string
  occurredAt: string
}

export interface PublicContentCard {
  code: string
  type: 'activity' | 'presale' | 'benefit' | 'article' | 'return_offer' | 'show'
  title: string
  summary: string
  imageUrl: string | null
  ctaLabel: string
  targetPath: string
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
}

export interface PublicPortalSnapshot {
  features: PublicFeature[]
  membership: PublicMembership | null
  points: PublicPointEntry[]
  preferences: JsonObject
  content: PublicContentCard[]
  activities: PublicActivity[]
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

export interface CheckoutBasketLine {
  productId: string
  quantity: number
  note?: string | null
}

export interface CheckoutUpgradeOfferView {
  publicId: string
  sourceProduct: { productId: string; name: string; amountMinor: number }
  targetExperience: { name: string; totalAmountMinor: number; included: string[] }
  amountToAddMinor: number
  currency: string
  validUntil: string
  status: 'offered' | 'selected' | 'converted' | 'expired' | 'cancelled'
  prompt: { title: string; body: string; callToAction: string }
  ruleCopy: string
}

interface MembershipRow extends Record<string, unknown> {
  id: string
  member_no: string
  level: PublicMembership['level']
  lifecycle_stage: PublicMembership['lifecycleStage']
  points_balance: number
  visit_count: number
  joined_at: string
}

interface FeatureRow extends Record<string, unknown> {
  feature_code: string
  rollout_state: RolloutState
  configuration: JsonObject
}

interface PointRow extends Record<string, unknown> {
  id: string
  entry_type: PublicPointEntry['entryType']
  points_delta: number
  balance_after: number
  reason: string
  occurred_at: string
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
  audience_rule: JsonObject
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
  currency: string
  points_reward: number
  status: 'published' | 'full'
  visibility: 'public' | 'member' | 'segment'
  audience_rule: JsonObject
  safety_snapshot: JsonObject
  registration_status: string | null
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
}

interface RecommendationSessionRow extends Record<string, unknown> {
  id: string
  public_id: string
  party_size: number
  occasion: string
  alcohol_preference: string
  experience_level: ExperienceLevel
  service_intensity: ServiceIntensity
  recommendation_snapshot: unknown
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
  selected_product_snapshot: JsonObject
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
  source_product_id: string
  source_name: string
  source_amount_minor: string | number
  target_name: string
  target_total_amount_minor: string | number
  amount_to_add_minor: string | number
  target_snapshot: JsonObject
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
  constructor(private readonly transaction: ScopedTransaction) {}

  async publicPortal(customerId: string): Promise<PublicPortalSnapshot> {
    const [features, membership, preferences, cards, activities] = await Promise.all([
      this.listFeatures(),
      this.findMembership(customerId),
      this.publicOwnedPreferences(customerId),
      this.listContentCards(),
      this.listActivities(customerId),
    ])
    const points = membership === null ? [] : await this.listPointLedger(membership.id)
    const publicMembership = membership === null ? null : membershipView(membership)
    return {
      features: features.map(featureView),
      membership: publicMembership,
      points,
      preferences,
      content: cards.filter((card) => audienceAllows(card.audience_rule, publicMembership)).map(cardView),
      activities: activities
        .filter((activity) => activity.visibility === 'public'
          || (publicMembership !== null && audienceAllows(activity.audience_rule, publicMembership)))
        .map(activityView),
    }
  }

  async publicActivities(customerId: string | null): Promise<PublicActivity[]> {
    const membership = customerId === null ? null : await this.findMembership(customerId)
    const publicMembership = membership === null ? null : membershipView(membership)
    return (await this.listActivities(customerId))
      .filter((activity) => activity.visibility === 'public'
        || (publicMembership !== null && audienceAllows(activity.audience_rule, publicMembership)))
      .map(activityView)
  }

  async findMembership(customerId: string): Promise<MembershipRow | null> {
    const result = await this.transaction.query<MembershipRow>(`
      SELECT id, member_no, level, lifecycle_stage, points_balance,
        visit_count, joined_at::text
      FROM mbox.customer_memberships
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid
        AND customer_id = $3::uuid AND status = 'active'
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, customerId])
    return result.rows[0] ?? null
  }

  private async publicOwnedPreferences(customerId: string): Promise<JsonObject> {
    const result = await this.transaction.query<{ preference_key: string; preference_value: unknown }>(`
      SELECT preference_key, preference_value
      FROM mbox.customer_preferences
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid
        AND customer_id = $3::uuid
        AND preference_key = ANY($4::text[])
      ORDER BY preference_key
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
      INSERT INTO mbox.customer_memberships (
        tenant_id, store_id, customer_id, member_no
      ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4)
      RETURNING id, member_no, level, lifecycle_stage, points_balance,
        visit_count, joined_at::text
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
    contactSnapshot: JsonObject
    safetyAcknowledgement: JsonObject
    paymentChoice: ActivityPaymentChoice
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
  }> {
    const activity = await this.transaction.query<ActivityRow & { id: string }>(`
      SELECT activity.id, activity.public_id, activity.activity_kind, activity.title,
        activity.summary, activity.cover_url, activity.starts_at::text, activity.ends_at::text,
        activity.assembly_location, activity.capacity, activity.fee_amount_minor,
        activity.deposit_amount_minor, activity.fee_basis, activity.registration_payment_mode,
        activity.payment_deadline_minutes, activity.payment_rule_text,
        activity.refund_policy_snapshot, activity.currency, activity.points_reward,
        activity.status, activity.visibility, activity.audience_rule,
        activity.safety_snapshot, NULL::text AS registration_status,
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
    const membership = await this.findMembership(input.customerId)
    const publicMembership = membership === null ? null : membershipView(membership)
    if (row.visibility !== 'public' && (publicMembership === null || !audienceAllows(row.audience_rule, publicMembership))) {
      throw new CustomerExperienceRequestError('这个活动当前不在您的可报名范围内', 'ACTIVITY_AUDIENCE_DENIED', 403)
    }
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
    const status = hasCapacity ? (payment.amountDueMinor > 0 ? 'payment_pending' : 'confirmed') : 'waitlisted'
    const effectiveChoice: ActivityPaymentChoice = hasCapacity ? payment.choice : 'none'
    const amountDueMinor = hasCapacity ? payment.amountDueMinor : 0
    const paymentStatus = amountDueMinor > 0 ? 'pending' : 'not_required'
    const inserted = await this.transaction.query<{
      public_id: string
      status: string
      payment_due_at: string | null
      seat_hold_expires_at: string | null
    }>(`
      INSERT INTO mbox.community_activity_registrations (
        tenant_id, store_id, public_id, activity_id, customer_id, membership_id,
        party_size, status, payment_choice, payment_status, fee_amount_minor,
        amount_due_minor, paid_amount_minor, currency, contact_snapshot,
        safety_acknowledgement, idempotency_key, payment_due_at,
        seat_hold_expires_at, refund_policy_snapshot
      ) VALUES (
        $1::uuid, $2::uuid, $3, $4::uuid, $5::uuid, $6::uuid,
        $7, $8, $9, $10, $11::bigint, $12::bigint, 0, $13,
        $14::jsonb, $15::jsonb, $16,
        CASE WHEN $12::bigint > 0 THEN clock_timestamp() + make_interval(mins => $17) ELSE NULL END,
        CASE WHEN $12::bigint > 0 THEN clock_timestamp() + make_interval(mins => $17) ELSE NULL END,
        $18::jsonb
      )
      RETURNING public_id, status, payment_due_at::text, seat_hold_expires_at::text
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.publicId,
      row.id,
      input.customerId,
      membership?.id ?? null,
      input.partySize,
      status,
      effectiveChoice,
      paymentStatus,
      totalFeeAmountMinor,
      amountDueMinor,
      row.currency,
      JSON.stringify(input.contactSnapshot),
      JSON.stringify(input.safetyAcknowledgement),
      input.idempotencyKey,
      row.payment_deadline_minutes,
      JSON.stringify(row.refund_policy_snapshot),
    ])
    const registration = requiredRow(inserted.rows[0], 'activity registration')
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
    }
  }

  async cancelActivityRegistration(input: Readonly<{
    registrationPublicId: string
    customerId: string
    reason: string
  }>): Promise<{ publicId: string; status: 'cancelled' }> {
    const result = await this.transaction.query<{ public_id: string }>(`
      UPDATE mbox.community_activity_registrations
      SET status = 'cancelled', cancelled_at = clock_timestamp(),
        payment_status = CASE WHEN payment_status = 'pending' THEN 'expired' ELSE payment_status END,
        amount_due_minor = 0,
        contact_snapshot = contact_snapshot || jsonb_build_object('cancellationReason', $4)
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid
        AND public_id = $3 AND customer_id = $5::uuid
        AND status IN ('reserved', 'payment_pending', 'confirmed', 'waitlisted')
      RETURNING public_id
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.registrationPublicId,
      input.reason,
      input.customerId,
    ])
    const row = result.rows[0]
    if (!row) throw new CustomerExperienceRequestError('报名已不能直接取消，请联系活动负责人', 'ACTIVITY_CANCEL_DENIED', 409)
    return { publicId: row.public_id, status: 'cancelled' }
  }

  async createRecommendationSession(input: Readonly<{
    context: TableExperienceContext
    answers: RecommendationAnswer
    publicId: string
  }>): Promise<RecommendationResult> {
    const products = await this.recommendationProducts(input.answers)
    const recommendations = rankProducts(products, input.answers)
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
    requiredRow(inserted.rows[0], 'recommendation session')
    return { publicId: input.publicId, answers: input.answers, recommendations, missingTiers }
  }

  async createExperiencePlan(input: Readonly<{
    context: TableExperienceContext
    recommendationPublicId: string
    selectedProductId: string
    publicId: string
    promiseSummary: string
  }>): Promise<ExperiencePlanView> {
    const recommendation = await this.transaction.query<RecommendationSessionRow>(`
      SELECT id, public_id, party_size, occasion, alcohol_preference,
        experience_level, service_intensity, recommendation_snapshot
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
    const recommendations = recommendationSnapshot(session.recommendation_snapshot)
    const selected = recommendations.find((product) => product.productId === input.selectedProductId)
    if (!selected) throw new CustomerExperienceRequestError('所选套餐不属于这次推荐', 'RECOMMENDATION_SELECTION_INVALID', 409)

    const existing = await this.findPlanByTable(input.context.tableSessionId)
    if (existing !== null) throw new CustomerExperienceRequestError('本桌已经有一份进行中的体验安排', 'EXPERIENCE_PLAN_EXISTS', 409)
    const show = await this.currentShowSnapshot(input.context.businessDate)
    const planInsert = await this.transaction.query<{ id: string }>(`
      INSERT INTO mbox.customer_experience_plans (
        tenant_id, store_id, public_id, table_session_id, customer_id,
        recommendation_session_id, business_date, plan_state, party_size,
        occasion, alcohol_preference, service_intensity, promise_summary,
        selected_product_id, selected_product_snapshot, show_snapshot,
        created_by_actor_type, created_by_actor_ref, activated_at
      ) VALUES (
        $1::uuid, $2::uuid, $3, $4::uuid, $5::uuid,
        $6::uuid, $7::date, 'active', $8, $9, $10, $11, $12,
        $13::uuid, $14::jsonb, $15::jsonb, 'guest', $16, clock_timestamp()
      ) RETURNING id
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.publicId,
      input.context.tableSessionId,
      input.context.customerId,
      session.id,
      input.context.businessDate,
      session.party_size,
      session.occasion,
      session.alcohol_preference,
      session.service_intensity,
      input.promiseSummary,
      selected.productId,
      JSON.stringify(selected),
      JSON.stringify(show),
      input.context.actorRef,
    ])
    const planId = requiredRow(planInsert.rows[0], 'experience plan').id
    const cues = buildExperienceCues({
      serviceIntensity: session.service_intensity,
      occasion: session.occasion,
      createdAt: new Date(),
      show,
    })
    for (const cue of cues) await this.insertCue(planId, cue)
    await this.transaction.query(`
      UPDATE mbox.recommendation_sessions
      SET selected_product_id = $4::uuid, completed_at = clock_timestamp()
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, session.id, selected.productId])
    return requiredPlan(await this.findPlanByTable(input.context.tableSessionId))
  }

  async findPlanByTable(tableSessionId: string): Promise<ExperiencePlanView | null> {
    const result = await this.transaction.query<PlanRow>(`
      SELECT id, public_id, plan_state, party_size, occasion, alcohol_preference,
        service_intensity, promise_summary, selected_product_id, selected_product_snapshot
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
    const configuration = await this.featureConfiguration('checkout_upgrade')
    if (configuration === null || input.items.length === 0) return null
    const minimumMarginBasisPoints = boundedInteger(configuration.minimumGrossMarginBasisPoints, 0, 9_999, 6_000)
    const basket = normalizeCheckoutBasket(input.items)
    const fingerprint = checkoutBasketFingerprint(basket)
    const candidate = await this.transaction.query<{
      rule_id: string
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
    }>(`
      WITH requested AS (
        SELECT product_id, quantity
        FROM jsonb_to_recordset($4::jsonb) AS line(product_id uuid, quantity integer)
      )
      SELECT rule.id AS rule_id,
        source_product.id AS source_product_id, source_product.name AS source_name,
        source_product.product_snapshot AS source_snapshot,
        source_price.amount_minor AS source_amount_minor,
        target_product.id AS target_product_id, target_product.name AS target_name,
        target_product.product_snapshot AS target_snapshot,
        target_price.amount_minor AS target_amount_minor,
        target_product.cost_amount_minor AS target_cost_amount_minor,
        target_price.currency, rule.prompt_title, rule.prompt_body,
        rule.call_to_action, rule.offer_valid_minutes
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
      JSON.stringify(basket),
      input.occasion ?? 'other',
      input.alcoholPreference ?? 'undecided',
    ])
    const row = candidate.rows[0]
    if (!row) return null
    const sourceAmount = money(row.source_amount_minor, 'checkout source amount')
    const targetAmount = money(row.target_amount_minor, 'checkout target amount')
    const targetCost = money(row.target_cost_amount_minor, 'checkout target cost')
    const marginBasisPoints = Math.floor((targetAmount - targetCost) * 10_000 / targetAmount)
    if (marginBasisPoints < minimumMarginBasisPoints) return null
    const upgradedBasket = replaceCheckoutLine(basket, row.source_product_id, row.target_product_id)
    const validUntil = new Date(Date.now() + row.offer_valid_minutes * 60_000).toISOString()
    const targetSnapshot = {
      ...row.target_snapshot,
      name: row.target_name,
      totalAmountMinor: targetAmount,
      included: stringArray(row.target_snapshot.displayIncluded),
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
        source_snapshot, target_snapshot, valid_until, idempotency_key
      ) VALUES (
        $1::uuid, $2::uuid, $3, $4::uuid, $5::date,
        $6::uuid, $7::uuid, $8::uuid, $9::uuid,
        $10::bigint, $11::bigint, $12::bigint, $13,
        $14::jsonb, $15::jsonb, $16, $17::jsonb, $18::jsonb,
        $19::timestamptz, $20
      )
      ON CONFLICT (tenant_id, store_id, idempotency_key) DO UPDATE
      SET updated_at = clock_timestamp()
      RETURNING id, public_id, source_product_id,
        source_snapshot->>'name' AS source_name, source_amount_minor,
        target_snapshot->>'name' AS target_name,
        (target_snapshot->>'totalAmountMinor')::bigint AS target_total_amount_minor,
        amount_to_add_minor, target_snapshot, currency, valid_until::text, status,
        target_snapshot->>'promptTitle' AS prompt_title,
        target_snapshot->>'promptBody' AS prompt_body,
        target_snapshot->>'callToAction' AS call_to_action
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
      JSON.stringify({ ...row.source_snapshot, name: row.source_name }),
      JSON.stringify(targetSnapshot),
      validUntil,
      input.idempotencyKey,
    ])
    return checkoutUpgradeOfferView(requiredRow(inserted.rows[0], 'checkout upgrade offer'))
  }

  async selectCheckoutUpgrade(
    context: TableExperienceContext,
    publicId: string,
    originalItems: readonly CheckoutBasketLine[],
  ): Promise<{ offerId: string; upgradedItems: CheckoutBasketLine[] }> {
    const basket = normalizeCheckoutBasket(originalItems)
    const result = await this.transaction.query<{
      id: string
      original_basket: unknown
      upgraded_basket: unknown
      basket_fingerprint: string
    }>(`
      UPDATE mbox.checkout_upgrade_offers
      SET status = 'selected', selected_at = COALESCE(selected_at, clock_timestamp()),
        updated_at = clock_timestamp()
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid
        AND table_session_id = $3::uuid AND customer_id = $4::uuid
        AND public_id = $5 AND status IN ('offered', 'selected')
        AND valid_until > clock_timestamp()
        AND basket_fingerprint = $6
      RETURNING id, original_basket, upgraded_basket, basket_fingerprint
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      context.tableSessionId,
      context.customerId,
      publicId,
      checkoutBasketFingerprint(basket),
    ])
    const row = result.rows[0]
    if (!row) throw new CustomerExperienceRequestError('升级建议已失效，请在付款页重新确认', 'CHECKOUT_UPGRADE_UNAVAILABLE', 409)
    return { offerId: row.id, upgradedItems: parseCheckoutBasket(row.upgraded_basket) }
  }

  async markCheckoutUpgradeConverted(offerId: string, orderId: string): Promise<void> {
    const result = await this.transaction.query(`
      UPDATE mbox.checkout_upgrade_offers
      SET status = 'converted', converted_order_id = $4::uuid,
        converted_at = clock_timestamp(), updated_at = clock_timestamp()
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid
        AND id = $3::uuid AND status = 'selected'
        AND valid_until > clock_timestamp()
      RETURNING id
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, offerId, orderId])
    if (result.rowCount !== 1) {
      throw new CustomerExperienceRequestError('订单已创建，但升级记录未能完成，请联系店长核对', 'CHECKOUT_UPGRADE_RECORD_FAILED', 409)
    }
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
      SELECT feature_code, rollout_state, configuration
      FROM mbox.customer_experience_features
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid
        AND (effective_from IS NULL OR effective_from <= clock_timestamp())
        AND (effective_until IS NULL OR effective_until > clock_timestamp())
      ORDER BY feature_code
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId])
    return result.rows
  }

  private async featureConfiguration(code: string): Promise<JsonObject | null> {
    const result = await this.transaction.query<FeatureRow>(`
      SELECT feature_code, rollout_state, configuration
      FROM mbox.customer_experience_features
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND feature_code = $3
        AND rollout_state IN ('pilot', 'enabled')
        AND (effective_from IS NULL OR effective_from <= clock_timestamp())
        AND (effective_until IS NULL OR effective_until > clock_timestamp())
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, code])
    return result.rows[0]?.configuration ?? null
  }

  private async listPointLedger(membershipId: string): Promise<PublicPointEntry[]> {
    const result = await this.transaction.query<PointRow>(`
      SELECT id, entry_type, points_delta, balance_after, reason, occurred_at::text
      FROM mbox.loyalty_point_ledger
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid
        AND membership_id = $3::uuid
      ORDER BY occurred_at DESC, id DESC LIMIT 20
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, membershipId])
    return result.rows.map((row) => ({
      id: row.id,
      entryType: row.entry_type,
      pointsDelta: row.points_delta,
      balanceAfter: row.balance_after,
      reason: row.reason,
      occurredAt: row.occurred_at,
    }))
  }

  private async listContentCards(): Promise<CardRow[]> {
    const result = await this.transaction.query<CardRow>(`
      SELECT code, card_type, title, summary, image_url, cta_label,
        target_path, priority, audience_rule
      FROM mbox.member_content_cards
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid
        AND status = 'published' AND valid_from <= clock_timestamp()
        AND valid_until > clock_timestamp()
      ORDER BY priority, valid_from DESC, id
      LIMIT 20
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId])
    return result.rows
  }

  private async listActivities(customerId: string | null): Promise<ActivityRow[]> {
    const result = await this.transaction.query<ActivityRow>(`
      SELECT activity.public_id, activity.activity_kind, activity.title,
        activity.summary, activity.cover_url, activity.starts_at::text,
        activity.ends_at::text, activity.assembly_location, activity.capacity,
        activity.fee_amount_minor, activity.deposit_amount_minor, activity.fee_basis,
        activity.registration_payment_mode, activity.payment_deadline_minutes,
        activity.payment_rule_text, activity.refund_policy_snapshot, activity.currency,
        activity.points_reward, activity.status, activity.visibility,
        activity.audience_rule, activity.safety_snapshot,
        registration.status AS registration_status,
        COALESCE(sum(active_registration.party_size), 0)::text AS registered_count
      FROM mbox.community_activities AS activity
      LEFT JOIN mbox.community_activity_registrations AS active_registration
        ON active_registration.tenant_id = activity.tenant_id
       AND active_registration.store_id = activity.store_id
       AND active_registration.activity_id = activity.id
       AND active_registration.status IN ('reserved', 'payment_pending', 'confirmed', 'checked_in')
      LEFT JOIN mbox.community_activity_registrations AS registration
        ON registration.tenant_id = activity.tenant_id
       AND registration.store_id = activity.store_id
       AND registration.activity_id = activity.id
       AND registration.customer_id = $3::uuid
      WHERE activity.tenant_id = $1::uuid AND activity.store_id = $2::uuid
        AND activity.status IN ('published', 'full')
        AND activity.ends_at > clock_timestamp()
      GROUP BY activity.id, registration.status
      ORDER BY activity.starts_at, activity.id
      LIMIT 50
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, customerId])
    return result.rows
  }

  private async recommendationProducts(answers: RecommendationAnswer): Promise<RecommendationProductRow[]> {
    const families = preferenceFamilies(answers.alcoholPreference)
    const result = await this.transaction.query<RecommendationProductRow>(`
      SELECT product.id, product.code, product.name,
        COALESCE(product.product_snapshot->>'beverageFamily', 'none') AS beverage_family,
        product.product_snapshot->>'description' AS description,
        product.product_snapshot->>'imageUrl' AS image_url,
        price.amount_minor, product.cost_amount_minor, price.currency,
        product.recommendation_priority, product.recommendation_scene_tags,
        product.recommendation_intent_tags,
        COALESCE(component_data.items, '[]'::jsonb) AS component_list,
        component_data.separate_amount_minor
      FROM mbox.products AS product
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
      WHERE product.tenant_id = $1::uuid AND product.store_id = $2::uuid
        AND product.status = 'active' AND product.guest_visible = true
        AND product.product_kind = 'bundle' AND product.recommendation_enabled = true
        AND product.recommendation_min_guests <= $3
        AND product.recommendation_max_guests >= $3
        AND product.cost_amount_minor IS NOT NULL
        AND price.amount_minor > product.cost_amount_minor
        AND (cardinality($4::text[]) = 0
          OR COALESCE(product.product_snapshot->>'beverageFamily', 'none') = ANY($4::text[]))
      ORDER BY product.recommendation_priority, price.amount_minor, product.id
      LIMIT 60
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, answers.partySize, families])
    return result.rows
  }

  private async currentShowSnapshot(businessDate: string): Promise<JsonObject> {
    const result = await this.transaction.query<{
      schedule_id: string
      performer_name: string
      starts_at: string
      ends_at: string
      status: string
    }>(`
      SELECT schedule.id AS schedule_id, performer.stage_name AS performer_name,
        schedule.starts_at::text, schedule.ends_at::text, schedule.status
      FROM mbox.schedules AS schedule
      JOIN mbox.performers AS performer
        ON performer.tenant_id = schedule.tenant_id AND performer.store_id = schedule.store_id
       AND performer.id = schedule.performer_id
      WHERE schedule.tenant_id = $1::uuid AND schedule.store_id = $2::uuid
        AND (schedule.starts_at AT TIME ZONE 'Asia/Shanghai')::date = $3::date
        AND schedule.status <> 'cancelled'
      ORDER BY schedule.starts_at, schedule.sort_order, schedule.id
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, businessDate])
    return { schedules: result.rows.map((schedule) => ({
      scheduleId: schedule.schedule_id,
      performerName: schedule.performer_name,
      startsAt: schedule.starts_at,
      endsAt: schedule.ends_at,
      status: schedule.status,
    })) }
  }

  private async insertCue(planId: string, cue: ExperienceCueDraft): Promise<void> {
    await this.transaction.query(`
      INSERT INTO mbox.experience_plan_cues (
        tenant_id, store_id, experience_plan_id, cue_code, sequence_no,
        trigger_kind, trigger_offset_minutes, performance_phase,
        action_kind, station, action_payload, due_at
      ) VALUES (
        $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::timestamptz
      )
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      planId,
      cue.code,
      cue.sequence,
      cue.triggerKind,
      cue.triggerOffsetMinutes,
      cue.performancePhase,
      cue.actionKind,
      cue.station,
      JSON.stringify(cue.payload),
      cue.dueAt,
    ])
  }

  private async expireCheckoutUpgradeOffers(tableSessionId: string, customerId: string): Promise<void> {
    await this.transaction.query(`
      UPDATE mbox.checkout_upgrade_offers
      SET status = 'expired'
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid
        AND table_session_id = $3::uuid AND customer_id = $4::uuid
        AND status IN ('offered', 'selected')
        AND valid_until <= clock_timestamp()
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, tableSessionId, customerId])
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

function rankProducts(rows: RecommendationProductRow[], answers: RecommendationAnswer): RecommendedProduct[] {
  const ranked = rows.map((row) => {
    const amount = money(row.amount_minor, 'product amount')
    const cost = money(row.cost_amount_minor, 'product cost')
    const separate = row.separate_amount_minor === null ? null : money(row.separate_amount_minor, 'separate amount')
    const sceneScore = row.recommendation_scene_tags.includes(sceneTag(answers.occasion)) ? 60 : 0
    const preferenceScore = preferenceFamilies(answers.alcoholPreference).includes(row.beverage_family) ? 100 : 0
    const marginScore = Math.min(50, Math.floor(((amount - cost) * 10_000 / amount) / 100))
    const priorityScore = Math.max(0, 50 - row.recommendation_priority)
    return {
      row,
      amount,
      cost,
      separate,
      score: preferenceScore + sceneScore + marginScore + priorityScore,
    }
  }).toSorted((left, right) => right.score - left.score || left.amount - right.amount || left.row.id.localeCompare(right.row.id))
  if (ranked.length === 0) return []
  const candidates = distinctByAmount(ranked.slice(0, 12))
  const selected = tierSelections(candidates, answers.experienceLevel)
  return selected.map(({ item, tier }) => productView(item.row, tier, answers, item.amount, item.cost, item.separate))
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

function recommendationSnapshot(value: unknown): RecommendedProduct[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!isObject(item) || typeof item.productId !== 'string' || typeof item.name !== 'string'
      || typeof item.amountMinor !== 'number' || typeof item.currency !== 'string'
      || !['comfortable', 'enhanced', 'signature'].includes(String(item.tier))) return []
    return [item as unknown as RecommendedProduct]
  })
}

function planView(plan: PlanRow, cues: CueRow[]): ExperiencePlanView {
  const product = isObject(plan.selected_product_snapshot)
    && typeof plan.selected_product_snapshot.productId === 'string'
    && typeof plan.selected_product_snapshot.name === 'string'
    && typeof plan.selected_product_snapshot.amountMinor === 'number'
    && typeof plan.selected_product_snapshot.currency === 'string'
    ? {
        productId: plan.selected_product_snapshot.productId,
        name: plan.selected_product_snapshot.name,
        amountMinor: plan.selected_product_snapshot.amountMinor,
        currency: plan.selected_product_snapshot.currency,
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

function requiredPlan(value: ExperiencePlanView | null): ExperiencePlanView {
  if (value === null) throw new Error('experience plan could not be reloaded')
  return value
}

function membershipView(row: MembershipRow): PublicMembership {
  return {
    memberNo: row.member_no,
    level: row.level,
    lifecycleStage: row.lifecycle_stage,
    pointsBalance: row.points_balance,
    visitCount: row.visit_count,
    joinedAt: row.joined_at,
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
    targetPath: safeTargetPath(row.target_path),
    priority: row.priority,
  }
}

function activityView(row: ActivityRow): PublicActivity {
  const registered = integer(row.registered_count, 'registered count')
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
    feeAmountMinor: money(row.fee_amount_minor, 'activity fee'),
    depositAmountMinor: money(row.deposit_amount_minor, 'activity deposit'),
    feeBasis: row.fee_basis,
    paymentMode: row.registration_payment_mode,
    paymentDeadlineMinutes: row.payment_deadline_minutes,
    paymentRuleText: row.payment_rule_text,
    refundPolicy: row.refund_policy_snapshot,
    currency: row.currency,
    pointsReward: row.points_reward,
    status: row.status,
    registrationStatus: row.registration_status,
    safety: publicSafety(row.safety_snapshot),
  }
}

function checkoutUpgradeOfferView(row: CheckoutUpgradeOfferRow): CheckoutUpgradeOfferView {
  return {
    publicId: row.public_id,
    sourceProduct: {
      productId: row.source_product_id,
      name: row.source_name,
      amountMinor: money(row.source_amount_minor, 'source amount'),
    },
    targetExperience: {
      name: row.target_name,
      totalAmountMinor: money(row.target_total_amount_minor, 'target total amount'),
      included: stringArray(row.target_snapshot.included),
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

function checkoutBasketFingerprint(items: readonly CheckoutBasketLine[]): string {
  return createHash('sha256').update(JSON.stringify(items)).digest('hex')
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

function parseCheckoutBasket(value: unknown): CheckoutBasketLine[] {
  if (!Array.isArray(value)) throw new CustomerExperienceRequestError('升级购物车快照损坏', 'CHECKOUT_UPGRADE_SNAPSHOT_INVALID', 500)
  return normalizeCheckoutBasket(value.map((item) => {
    if (!isObject(item)) throw new CustomerExperienceRequestError('升级购物车快照损坏', 'CHECKOUT_UPGRADE_SNAPSHOT_INVALID', 500)
    return {
      productId: String(item.productId ?? ''),
      quantity: Number(item.quantity),
      note: typeof item.note === 'string' ? item.note : null,
    }
  }))
}

function audienceAllows(rule: JsonObject, membership: PublicMembership | null): boolean {
  const requiredLevels = stringArray(rule.memberLevels)
  const requiredStages = stringArray(rule.lifecycleStages)
  if ((requiredLevels.length > 0 || requiredStages.length > 0) && membership === null) return false
  if (membership !== null && requiredLevels.length > 0 && !requiredLevels.includes(membership.level)) return false
  if (membership !== null && requiredStages.length > 0 && !requiredStages.includes(membership.lifecycleStage)) return false
  return true
}

function publicSafety(value: JsonObject): JsonObject {
  const allowed = ['difficulty', 'insuranceIncluded', 'requirements', 'cancellationPolicy', 'ageRequirement']
  return Object.fromEntries(allowed.flatMap((key) => value[key] === undefined ? [] : [[key, value[key]]]))
}

function safeAssetUrl(value: string | null): string | null {
  if (value === null || value.trim() === '') return null
  if (value.startsWith('/') && !value.startsWith('//')) return value
  if (/^https:\/\//i.test(value)) return value
  return null
}

function safeTargetPath(value: string): string {
  if (value.startsWith('/pages/') && !value.includes('..')) return value
  if (/^https:\/\//i.test(value)) return value
  return '/pages/home/index'
}

function money(value: unknown, name: string): number {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(number) || number < 0) throw new TypeError(`${name} is invalid`)
  return number
}

function integer(value: unknown, name: string): number {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(number) || number < 0) throw new TypeError(`${name} is invalid`)
  return number
}

function boundedInteger(value: unknown, minimum: number, maximum: number, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum
    ? Number(value) : fallback
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
