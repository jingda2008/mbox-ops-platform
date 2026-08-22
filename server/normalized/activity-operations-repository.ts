import type { ScopedTransaction } from './transaction-runner.js'

export type ActivityStatus = 'draft' | 'published' | 'full' | 'cancelled' | 'completed'
export type ActivityRegistrationStatus =
  | 'reserved' | 'payment_pending' | 'confirmed' | 'waitlisted'
  | 'cancelled' | 'checked_in' | 'no_show' | 'refunded'
export type ActivityPaymentMode = 'none' | 'deposit_optional' | 'deposit_required' | 'full_required'
export type ActivityFeeBasis = 'per_person' | 'per_registration'
export type ActivityVisibility = 'public' | 'member' | 'segment'
export type ActivityKind = 'member_night' | 'hike' | 'camping' | 'city_walk' | 'music_picnic' | 'proposal' | 'other'
export type ActivityRegistrationOperation = 'check_in' | 'no_show' | 'cancel'

export interface ActivityOperationsSummary {
  publicId: string
  title: string
  status: ActivityStatus
  startsAt: string
  endsAt: string
  assemblyLocation: string
  capacity: number
  occupiedSeats: number
  waitlistedSeats: number
  registrationCount: number
  paymentMode: ActivityPaymentMode
  feeAmountMinor: number
  currency: string
}

export interface ActivityOperationsActivity extends ActivityOperationsSummary {
  kind: ActivityKind
  summary: string
  coverUrl: string | null
  depositAmountMinor: number
  feeBasis: ActivityFeeBasis
  paymentDeadlineMinutes: number
  paymentRuleText: string
  pointsReward: number
  visibility: ActivityVisibility
  audienceMemberLevels: string[]
  audienceLifecycleStages: string[]
  safetyPolicyVersion: string | null
  safetyAcknowledgementText: string | null
  safetyRequirements: string[]
  refundPolicyVersion: string | null
  refundPolicySummary: string | null
  activityDetails: string | null
  includedItems: string[]
  participationRequirements: string[]
  contactInstructions: string | null
  memberBenefitText: string | null
  createdByEmployeeId: string
  approvedByEmployeeId: string | null
  publishedAt: string | null
  updatedAt: string
}

export interface ActivityOperationsRegistration {
  publicId: string
  customerPublicId: string
  customerLabel: string
  contactVersionPublicId: string
  maskedContact: string
  memberLevel: string | null
  partySize: number
  status: ActivityRegistrationStatus
  paymentChoice: 'none' | 'deposit' | 'full'
  requestedPaymentChoice: 'none' | 'deposit' | 'full'
  requestedPaymentMethod: 'jsapi' | 'native_qr' | null
  requestedAmountDueMinor: number
  paymentStatus: 'not_required' | 'pending' | 'paid' | 'expired' | 'refunded'
  totalFeeAmountMinor: number
  amountDueMinor: number
  paidAmountMinor: number
  currency: string
  registeredAt: string
  paymentDueAt: string | null
  seatHoldExpiresAt: string | null
  checkedInAt: string | null
  cancelledAt: string | null
  paymentId: string | null
  paymentPublicId: string | null
  authoritativePaymentStatus: string | null
  providerActionState: string | null
  refund: null | {
    id: string
    publicId: string
    status: string
    amountMinor: number
    requestedByEmployeeId: string
    approvedByEmployeeId: string | null
    createdAt: string
    updatedAt: string
  }
}

export interface ActivityOperationsDetail {
  activity: ActivityOperationsActivity
  registrations: ActivityOperationsRegistration[]
}

export interface ActivityWaitlistRetry {
  activityPublicId: string
  state: 'queued' | 'not_required'
  nextAttemptAt: string | null
}

export interface ActivityDraftInput {
  kind: ActivityKind
  title: string
  summary: string
  coverUrl: string | null
  startsAt: string
  endsAt: string
  assemblyLocation: string
  capacity: number
  feeAmountMinor: number
  depositAmountMinor: number
  feeBasis: ActivityFeeBasis
  paymentMode: ActivityPaymentMode
  paymentDeadlineMinutes: number
  paymentRuleText: string
  pointsReward: number
  visibility: ActivityVisibility
  audienceMemberLevels: readonly string[]
  audienceLifecycleStages: readonly string[]
  safetyPolicyVersion: string
  safetyAcknowledgementText: string
  safetyRequirements: readonly string[]
  refundPolicyVersion: string
  refundPolicySummary: string
  activityDetails: string
  includedItems: readonly string[]
  participationRequirements: readonly string[]
  contactInstructions: string
  memberBenefitText: string | null
}

interface ActivitySummaryRow extends Record<string, unknown> {
  public_id: string
  title: string
  status: ActivityStatus
  starts_at: string
  ends_at: string
  assembly_location: string
  capacity: number
  occupied_seats: string | number
  waitlisted_seats: string | number
  registration_count: string | number
  registration_payment_mode: ActivityPaymentMode
  fee_amount_minor: string | number
  currency: string
}

interface ActivityDetailRow extends ActivitySummaryRow {
  activity_kind: ActivityKind
  summary: string
  cover_url: string | null
  deposit_amount_minor: string | number
  fee_basis: ActivityFeeBasis
  payment_deadline_minutes: number
  payment_rule_text: string
  points_reward: number
  visibility: ActivityVisibility
  audience_member_levels: string[]
  audience_lifecycle_stages: string[]
  safety_policy_version: string | null
  safety_acknowledgement_text: string | null
  safety_requirements: string[]
  refund_policy_version: string | null
  refund_policy_summary: string | null
  activity_details: string | null
  included_items: string[]
  participation_requirements: string[]
  contact_instructions: string | null
  member_benefit_text: string | null
  created_by_employee_id: string
  approved_by_employee_id: string | null
  published_at: string | null
  updated_at: string
}

interface RegistrationRow extends Record<string, unknown> {
  public_id: string
  customer_public_id: string
  customer_label: string
  contact_version_public_id: string
  masked_contact: string
  member_level: string | null
  party_size: number
  status: ActivityRegistrationStatus
  payment_choice: 'none' | 'deposit' | 'full'
  requested_payment_choice: 'none' | 'deposit' | 'full'
  requested_payment_method: 'jsapi' | 'native_qr' | null
  requested_amount_due_minor: string | number
  payment_status: 'not_required' | 'pending' | 'paid' | 'expired' | 'refunded'
  fee_amount_minor: string | number
  amount_due_minor: string | number
  paid_amount_minor: string | number
  currency: string
  registered_at: string
  payment_due_at: string | null
  seat_hold_expires_at: string | null
  checked_in_at: string | null
  cancelled_at: string | null
  payment_id: string | null
  payment_public_id: string | null
  authoritative_payment_status: string | null
  provider_action_state: string | null
  refund_id: string | null
  refund_public_id: string | null
  refund_status: string | null
  refund_amount_minor: string | number | null
  refund_requested_by_employee_id: string | null
  refund_approved_by_employee_id: string | null
  refund_created_at: string | null
  refund_updated_at: string | null
}

interface LockedRegistrationRow extends Record<string, unknown> {
  id: string
  public_id: string
  status: ActivityRegistrationStatus
  payment_status: ActivityOperationsRegistration['paymentStatus']
  payment_id: string | null
  payment_authoritative_status: string | null
  provider_action_state: string | null
  activity_starts_at: string
  activity_ends_at: string
  activity_status: ActivityStatus
}

export class ActivityOperationsError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly statusCode = 409,
  ) {
    super(message)
    this.name = 'ActivityOperationsError'
  }
}

export class ActivityOperationsRepository {
  constructor(private readonly transaction: ScopedTransaction) {}

  async createDraft(
    publicId: string,
    input: Readonly<ActivityDraftInput>,
    employeeId: string,
  ): Promise<ActivityOperationsActivity> {
    const result = await this.transaction.query<ActivityDetailRow>(`
      WITH inserted AS (
        INSERT INTO mbox.community_activities (
          tenant_id,store_id,public_id,activity_kind,title,summary,cover_url,
          starts_at,ends_at,assembly_location,capacity,fee_amount_minor,
          deposit_amount_minor,fee_basis,registration_payment_mode,
          payment_deadline_minutes,payment_rule_text,points_reward,visibility,
          audience_member_levels,audience_lifecycle_stages,safety_policy_version,
          safety_acknowledgement_text,safety_requirements,refund_policy_version,
          refund_policy_summary,activity_details,included_items,
          participation_requirements,contact_instructions,member_benefit_text,
          audience_rule,safety_snapshot,refund_policy_snapshot,sales_copy,
          status,created_by_employee_id
        ) VALUES (
          $1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8::timestamptz,$9::timestamptz,
          $10,$11,$12::bigint,$13::bigint,$14,$15,$16,$17,$18,$19,
          $20::text[],$21::text[],$22,$23,$24::text[],$25,$26,$27,
          $28::text[],$29::text[],$30,$31,
          jsonb_build_object('memberLevels',$20::text[],'lifecycleStages',$21::text[]),
          jsonb_build_object(
            'policyVersion',$22::text,'acknowledgementText',$23::text,'requirements',$24::text[]
          ),
          jsonb_build_object('policyVersion',$25::text,'summary',$26::text),
          jsonb_build_object(
            'details',$27::text,'includedItems',$28::text[],
            'participationRequirements',$29::text[],'contactInstructions',$30::text,
            'memberBenefitText',$31::text
          ),
          'draft',$32::uuid
        )
        RETURNING *
      )
      SELECT inserted.public_id,inserted.title,inserted.status,inserted.starts_at::text,
        inserted.ends_at::text,inserted.assembly_location,inserted.capacity,
        0::bigint AS occupied_seats,0::bigint AS waitlisted_seats,
        0::bigint AS registration_count,inserted.registration_payment_mode,
        inserted.fee_amount_minor,inserted.currency,inserted.activity_kind,
        inserted.summary,inserted.cover_url,inserted.deposit_amount_minor,
        inserted.fee_basis,inserted.payment_deadline_minutes,inserted.payment_rule_text,
        inserted.points_reward,inserted.visibility,inserted.audience_member_levels,
        inserted.audience_lifecycle_stages,inserted.safety_policy_version,
        inserted.safety_acknowledgement_text,inserted.safety_requirements,
        inserted.refund_policy_version,inserted.refund_policy_summary,
        inserted.activity_details,inserted.included_items,
        inserted.participation_requirements,inserted.contact_instructions,
        inserted.member_benefit_text,inserted.created_by_employee_id,
        inserted.approved_by_employee_id,inserted.published_at::text,
        inserted.updated_at::text
      FROM inserted
    `, [
      this.transaction.scope.tenantId,this.transaction.scope.storeId,publicId,
      input.kind,input.title,input.summary,input.coverUrl,input.startsAt,input.endsAt,
      input.assemblyLocation,input.capacity,input.feeAmountMinor,input.depositAmountMinor,
      input.feeBasis,input.paymentMode,input.paymentDeadlineMinutes,input.paymentRuleText,
      input.pointsReward,input.visibility,[...new Set(input.audienceMemberLevels)].toSorted(),
      [...new Set(input.audienceLifecycleStages)].toSorted(),input.safetyPolicyVersion,
      input.safetyAcknowledgementText,input.safetyRequirements,input.refundPolicyVersion,
      input.refundPolicySummary,input.activityDetails,input.includedItems,
      input.participationRequirements,input.contactInstructions,input.memberBenefitText,
      employeeId,
    ])
    const row = result.rows[0]
    if (!row) throw new ActivityOperationsError('活动草稿未能建立', 'ACTIVITY_DRAFT_CREATE_FAILED', 503)
    return detailView(row)
  }

  async list(): Promise<ActivityOperationsSummary[]> {
    const result = await this.transaction.query<ActivitySummaryRow>(`${ACTIVITY_SUMMARY_QUERY}
      ORDER BY activity.starts_at DESC, activity.id DESC
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId])
    return result.rows.map(summaryView)
  }

  async detail(publicId: string): Promise<ActivityOperationsDetail> {
    const activityResult = await this.transaction.query<ActivityDetailRow>(`${ACTIVITY_DETAIL_QUERY}
      WHERE activity.tenant_id=$1::uuid AND activity.store_id=$2::uuid AND activity.public_id=$3
      GROUP BY activity.id
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, publicId])
    const activityRow = activityResult.rows[0]
    if (!activityRow) throw new ActivityOperationsError('活动不存在或不属于当前门店', 'ACTIVITY_OPERATION_NOT_FOUND', 404)
    const registrations = await this.transaction.query<RegistrationRow>(`
      SELECT registration.public_id, customer.public_id AS customer_public_id,
        COALESCE(NULLIF(btrim(profile.display_name),''),
          CASE WHEN membership.member_no IS NULL THEN '顾客 '||right(customer.public_id,6)
            ELSE '会员 '||right(membership.member_no,6) END) AS customer_label,
        current_contact.public_id AS contact_version_public_id,
        current_contact.masked_contact,
        membership.level AS member_level, registration.party_size, registration.status,
        registration.payment_choice,registration.requested_payment_choice,
        registration.requested_payment_method,registration.requested_amount_due_minor,
        registration.payment_status,
        registration.fee_amount_minor, registration.amount_due_minor,
        registration.paid_amount_minor, registration.currency,
        registration.registered_at::text, registration.payment_due_at::text,
        registration.seat_hold_expires_at::text, registration.checked_in_at::text,
        registration.cancelled_at::text, payment.id AS payment_id,
        payment.public_id AS payment_public_id,
        payment.status AS authoritative_payment_status,
        provider_action.state AS provider_action_state,
        latest_refund.id AS refund_id, latest_refund.public_id AS refund_public_id,
        latest_refund.status AS refund_status, latest_refund.amount_minor AS refund_amount_minor,
        latest_refund.requested_by_employee_id AS refund_requested_by_employee_id,
        latest_refund.approved_by_employee_id AS refund_approved_by_employee_id,
        latest_refund.created_at::text AS refund_created_at,
        latest_refund.updated_at::text AS refund_updated_at
      FROM mbox.community_activity_registrations registration
      JOIN mbox.community_activities activity
        ON activity.tenant_id=registration.tenant_id AND activity.store_id=registration.store_id
       AND activity.id=registration.activity_id
      JOIN mbox.customers customer
        ON customer.tenant_id=registration.tenant_id AND customer.store_id=registration.store_id
       AND customer.id=registration.customer_id
      LEFT JOIN mbox.customer_profiles profile
        ON profile.tenant_id=customer.tenant_id AND profile.store_id=customer.store_id
       AND profile.customer_id=customer.id
      LEFT JOIN mbox.customer_memberships membership
        ON membership.tenant_id=registration.tenant_id AND membership.store_id=registration.store_id
       AND membership.id=registration.membership_id
      JOIN LATERAL (
        SELECT contact.public_id,COALESCE(contact.masked_contact,'已清除') AS masked_contact
        FROM mbox.community_activity_registration_contact_versions contact
        WHERE contact.tenant_id=registration.tenant_id
          AND contact.store_id=registration.store_id
          AND contact.registration_id=registration.id
          AND contact.registration_cycle=registration.registration_cycle
        ORDER BY contact.version DESC LIMIT 1
      ) current_contact ON true
      LEFT JOIN mbox.payments payment
        ON payment.tenant_id=registration.tenant_id AND payment.store_id=registration.store_id
       AND payment.id=registration.payment_id AND payment.payable_kind='activity_registration'
      LEFT JOIN LATERAL (
        SELECT action.state
        FROM mbox.payment_provider_actions action
        WHERE action.tenant_id=payment.tenant_id AND action.store_id=payment.store_id
          AND action.payment_id=payment.id
        LIMIT 1
      ) provider_action ON true
      LEFT JOIN LATERAL (
        SELECT refund.id, refund.public_id, refund.status, refund.amount_minor,
          refund.requested_by_employee_id, refund.approved_by_employee_id,
          refund.created_at, refund.updated_at
        FROM mbox.refunds refund
        WHERE refund.tenant_id=payment.tenant_id AND refund.store_id=payment.store_id
          AND refund.payment_id=payment.id
        ORDER BY refund.created_at DESC, refund.id DESC LIMIT 1
      ) latest_refund ON true
      WHERE registration.tenant_id=$1::uuid AND registration.store_id=$2::uuid
        AND activity.public_id=$3
      ORDER BY CASE registration.status WHEN 'waitlisted' THEN 1 ELSE 0 END,
        registration.registered_at, registration.id
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, publicId])
    return { activity: detailView(activityRow), registrations: registrations.rows.map(registrationView) }
  }

  async updateDraft(publicId: string, input: Readonly<ActivityDraftInput>): Promise<ActivityOperationsActivity> {
    const result = await this.transaction.query<ActivityDetailRow>(`
      WITH updated AS (
        UPDATE mbox.community_activities activity
        SET activity_kind=$4, title=$5, summary=$6, cover_url=$7,
          starts_at=$8::timestamptz, ends_at=$9::timestamptz,
          assembly_location=$10, capacity=$11, fee_amount_minor=$12::bigint,
          deposit_amount_minor=$13::bigint, fee_basis=$14,
          registration_payment_mode=$15, payment_deadline_minutes=$16,
          payment_rule_text=$17, points_reward=$18, visibility=$19,
          audience_member_levels=$20::text[], audience_lifecycle_stages=$21::text[],
          safety_policy_version=$22, safety_acknowledgement_text=$23,
          safety_requirements=$24::text[], refund_policy_version=$25,
          refund_policy_summary=$26, activity_details=$27,
          included_items=$28::text[], participation_requirements=$29::text[],
          contact_instructions=$30, member_benefit_text=$31,
          audience_rule=jsonb_build_object('memberLevels',$20::text[],'lifecycleStages',$21::text[]),
          safety_snapshot=jsonb_build_object(
            'policyVersion',$22::text,'acknowledgementText',$23::text,'requirements',$24::text[]
          ),
          refund_policy_snapshot=jsonb_build_object('policyVersion',$25::text,'summary',$26::text),
          sales_copy=jsonb_build_object(
            'details',$27::text,'includedItems',$28::text[],
            'participationRequirements',$29::text[],'contactInstructions',$30::text,
            'memberBenefitText',$31::text
          ),
          updated_at=clock_timestamp()
        WHERE activity.tenant_id=$1::uuid AND activity.store_id=$2::uuid
          AND activity.public_id=$3 AND activity.status='draft'
        RETURNING activity.*
      )
      SELECT updated.public_id, updated.title, updated.status, updated.starts_at::text,
        updated.ends_at::text, updated.assembly_location, updated.capacity,
        0::bigint AS occupied_seats, 0::bigint AS waitlisted_seats,
        0::bigint AS registration_count, updated.registration_payment_mode,
        updated.fee_amount_minor, updated.currency, updated.activity_kind,
        updated.summary, updated.cover_url, updated.deposit_amount_minor,
        updated.fee_basis, updated.payment_deadline_minutes, updated.payment_rule_text,
        updated.points_reward, updated.visibility, updated.audience_member_levels,
        updated.audience_lifecycle_stages, updated.safety_policy_version,
        updated.safety_acknowledgement_text, updated.safety_requirements,
        updated.refund_policy_version, updated.refund_policy_summary,
        updated.activity_details, updated.included_items,
        updated.participation_requirements, updated.contact_instructions,
        updated.member_benefit_text, updated.created_by_employee_id,
        updated.approved_by_employee_id, updated.published_at::text,
        updated.updated_at::text
      FROM updated
    `, [
      this.transaction.scope.tenantId, this.transaction.scope.storeId, publicId,
      input.kind, input.title, input.summary, input.coverUrl, input.startsAt, input.endsAt,
      input.assemblyLocation, input.capacity, input.feeAmountMinor, input.depositAmountMinor,
      input.feeBasis, input.paymentMode, input.paymentDeadlineMinutes, input.paymentRuleText,
      input.pointsReward, input.visibility, [...new Set(input.audienceMemberLevels)].toSorted(),
      [...new Set(input.audienceLifecycleStages)].toSorted(), input.safetyPolicyVersion,
      input.safetyAcknowledgementText, input.safetyRequirements, input.refundPolicyVersion,
      input.refundPolicySummary, input.activityDetails, input.includedItems,
      input.participationRequirements, input.contactInstructions, input.memberBenefitText,
    ])
    const row = result.rows[0]
    if (row) return detailView(row)
    const existing = await this.transaction.query<{ status: ActivityStatus }>(`
      SELECT status FROM mbox.community_activities
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND public_id=$3
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, publicId])
    if (!existing.rows[0]) throw new ActivityOperationsError('活动不存在或不属于当前门店', 'ACTIVITY_OPERATION_NOT_FOUND', 404)
    throw new ActivityOperationsError(
      '活动发布后，费用、时间、权益、安全和退款承诺不可静默修改；请新建活动版本或执行明确取消流程',
      'PUBLISHED_ACTIVITY_IMMUTABLE',
    )
  }

  async transitionRegistration(
    publicId: string,
    operation: ActivityRegistrationOperation,
    reason: string,
  ): Promise<ActivityOperationsRegistration> {
    const lockedResult = await this.transaction.query<LockedRegistrationRow>(`
      SELECT registration.id, registration.public_id, registration.status,
        registration.payment_status, registration.payment_id,
        payment.status AS payment_authoritative_status,
        provider_action.state AS provider_action_state,
        activity.starts_at::text AS activity_starts_at,
        activity.ends_at::text AS activity_ends_at, activity.status AS activity_status
      FROM mbox.community_activity_registrations registration
      JOIN mbox.community_activities activity
        ON activity.tenant_id=registration.tenant_id AND activity.store_id=registration.store_id
       AND activity.id=registration.activity_id
      LEFT JOIN mbox.payments payment
        ON payment.tenant_id=registration.tenant_id AND payment.store_id=registration.store_id
       AND payment.id=registration.payment_id
      LEFT JOIN LATERAL (
        SELECT action.state FROM mbox.payment_provider_actions action
        WHERE action.tenant_id=payment.tenant_id AND action.store_id=payment.store_id
          AND action.payment_id=payment.id
        LIMIT 1
      ) provider_action ON true
      WHERE registration.tenant_id=$1::uuid AND registration.store_id=$2::uuid
        AND registration.public_id=$3
      FOR UPDATE OF registration, activity
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, publicId])
    const current = lockedResult.rows[0]
    if (!current) throw new ActivityOperationsError('报名不存在或不属于当前门店', 'ACTIVITY_REGISTRATION_NOT_FOUND', 404)

    if (operation === 'check_in') {
      if (current.status !== 'confirmed'
        || !['paid', 'not_required'].includes(current.payment_status)) {
        throw invalidTransition(current.status, '签到')
      }
      await this.updateRegistrationStatus(current.id, 'checked_in', reason)
    } else if (operation === 'no_show') {
      if (current.status !== 'confirmed') throw invalidTransition(current.status, '标记未到')
      if (Date.parse(current.activity_starts_at) > Date.now()) {
        throw new ActivityOperationsError('活动尚未开始，不能提前标记未到', 'ACTIVITY_NO_SHOW_TOO_EARLY')
      }
      await this.updateRegistrationStatus(current.id, 'no_show', reason)
    } else {
      await this.cancelUnpaidRegistration(current, reason)
    }
    return this.registrationById(current.id)
  }

  /**
   * This deliberately never promotes a customer. It only brings an already
   * queued, unprocessed release event forward for the normal FIFO worker.
   */
  async retryWaitlistPromotion(publicId: string): Promise<ActivityWaitlistRetry> {
    const activity = await this.transaction.query<{ id: string; public_id: string }>(`
      SELECT id,public_id
      FROM mbox.community_activities
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND public_id=$3
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, publicId])
    const current = activity.rows[0]
    if (!current) throw new ActivityOperationsError(
      '活动不存在或不属于当前门店', 'ACTIVITY_OPERATION_NOT_FOUND', 404,
    )
    const pending = await this.transaction.query<{ id: string }>(`
      SELECT id
      FROM mbox.activity_waitlist_release_events
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND activity_id=$3::uuid
        AND processed_at IS NULL
      ORDER BY next_attempt_at,created_at,id
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, current.id])
    const event = pending.rows[0]
    if (!event) return {
      activityPublicId: current.public_id,
      state: 'not_required',
      nextAttemptAt: null,
    }
    const retried = await this.transaction.query<{ next_attempt_at: string }>(`
      UPDATE mbox.activity_waitlist_release_events
      SET next_attempt_at=clock_timestamp(),last_block_reason=NULL
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
        AND processed_at IS NULL
      RETURNING next_attempt_at::text
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, event.id])
    const result = retried.rows[0]
    if (!result) throw new ActivityOperationsError(
      '候补任务状态刚刚变化，请刷新后查看', 'ACTIVITY_WAITLIST_RETRY_CONFLICT', 409,
    )
    return {
      activityPublicId: current.public_id,
      state: 'queued',
      nextAttemptAt: result.next_attempt_at,
    }
  }

  private async cancelUnpaidRegistration(current: LockedRegistrationRow, reason: string): Promise<void> {
    if (!['reserved', 'payment_pending', 'confirmed', 'waitlisted'].includes(current.status)) {
      throw invalidTransition(current.status, '取消')
    }
    if (current.payment_status === 'paid'
      || current.payment_authoritative_status === 'succeeded'
      || current.payment_authoritative_status === 'partially_refunded') {
      throw new ActivityOperationsError(
        '已付款报名不能直接取消；必须由店长发起退款，再由收银复核和执行',
        'ACTIVITY_PAID_CANCELLATION_REQUIRES_REFUND',
      )
    }
    if (current.payment_id !== null && current.provider_action_state !== null) {
      throw new ActivityOperationsError(
        '支付渠道已有动作，结果未明确前不能释放名额；请先查单',
        'ACTIVITY_PAYMENT_QUERY_REQUIRED',
      )
    }
    if (current.payment_id !== null) {
      const closed = await this.transaction.query(`
        UPDATE mbox.payments
        SET status='closed', provider_snapshot=provider_snapshot ||
          jsonb_build_object('providerStatus','closed_by_activity_operator'),
          updated_at=clock_timestamp()
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
          AND status IN ('created','pending')
      `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, current.payment_id])
      if (closed.rowCount !== 1) throw new ActivityOperationsError(
        '支付状态正在变化，取消未执行；请刷新后查单', 'ACTIVITY_PAYMENT_QUERY_REQUIRED',
      )
    }
    const updated = await this.transaction.query(`
      UPDATE mbox.community_activity_registrations
      SET status='cancelled', cancelled_at=clock_timestamp(), amount_due_minor=0,
        payment_status=CASE WHEN payment_status='pending' THEN 'expired' ELSE payment_status END,
        payment_due_at=NULL, seat_hold_expires_at=NULL, updated_at=clock_timestamp()
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
        AND status=ANY($4::text[]) AND payment_status<>'paid'
    `, [
      this.transaction.scope.tenantId, this.transaction.scope.storeId, current.id,
      ['reserved','payment_pending','confirmed','waitlisted'],
    ])
    if (updated.rowCount !== 1) throw invalidTransition(current.status, '取消')
    void reason
  }

  private async updateRegistrationStatus(
    id: string,
    status: Extract<ActivityRegistrationStatus, 'checked_in' | 'no_show'>,
    reason: string,
  ): Promise<void> {
    const updated = await this.transaction.query(`
      UPDATE mbox.community_activity_registrations
      SET status=$4,
        checked_in_at=CASE WHEN $4='checked_in' THEN clock_timestamp() ELSE checked_in_at END,
        updated_at=clock_timestamp()
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
        AND status='confirmed'
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, id, status])
    if (updated.rowCount !== 1) throw new ActivityOperationsError(
      `报名状态已变化，${status === 'checked_in' ? '签到' : '标记未到'}没有执行`,
      'ACTIVITY_REGISTRATION_STATE_CHANGED',
    )
    void reason
  }

  private async registrationById(id: string): Promise<ActivityOperationsRegistration> {
    const result = await this.transaction.query<RegistrationRow>(`
      SELECT registration.public_id, customer.public_id AS customer_public_id,
        COALESCE(NULLIF(btrim(profile.display_name),''),
          CASE WHEN membership.member_no IS NULL THEN '顾客 '||right(customer.public_id,6)
            ELSE '会员 '||right(membership.member_no,6) END) AS customer_label,
        current_contact.public_id AS contact_version_public_id,
        current_contact.masked_contact,
        membership.level AS member_level, registration.party_size, registration.status,
        registration.payment_choice,registration.requested_payment_choice,
        registration.requested_payment_method,registration.requested_amount_due_minor,
        registration.payment_status,
        registration.fee_amount_minor, registration.amount_due_minor,
        registration.paid_amount_minor, registration.currency,
        registration.registered_at::text, registration.payment_due_at::text,
        registration.seat_hold_expires_at::text, registration.checked_in_at::text,
        registration.cancelled_at::text, payment.id AS payment_id,
        payment.public_id AS payment_public_id, payment.status AS authoritative_payment_status,
        provider_action.state AS provider_action_state,
        latest_refund.id AS refund_id, latest_refund.public_id AS refund_public_id,
        latest_refund.status AS refund_status, latest_refund.amount_minor AS refund_amount_minor,
        latest_refund.requested_by_employee_id AS refund_requested_by_employee_id,
        latest_refund.approved_by_employee_id AS refund_approved_by_employee_id,
        latest_refund.created_at::text AS refund_created_at,
        latest_refund.updated_at::text AS refund_updated_at
      FROM mbox.community_activity_registrations registration
      JOIN mbox.customers customer
        ON customer.tenant_id=registration.tenant_id AND customer.store_id=registration.store_id
       AND customer.id=registration.customer_id
      LEFT JOIN mbox.customer_profiles profile
        ON profile.tenant_id=customer.tenant_id AND profile.store_id=customer.store_id
       AND profile.customer_id=customer.id
      LEFT JOIN mbox.customer_memberships membership
        ON membership.tenant_id=registration.tenant_id AND membership.store_id=registration.store_id
       AND membership.id=registration.membership_id
      JOIN LATERAL (
        SELECT contact.public_id,COALESCE(contact.masked_contact,'已清除') AS masked_contact
        FROM mbox.community_activity_registration_contact_versions contact
        WHERE contact.tenant_id=registration.tenant_id
          AND contact.store_id=registration.store_id
          AND contact.registration_id=registration.id
          AND contact.registration_cycle=registration.registration_cycle
        ORDER BY contact.version DESC LIMIT 1
      ) current_contact ON true
      LEFT JOIN mbox.payments payment
        ON payment.tenant_id=registration.tenant_id AND payment.store_id=registration.store_id
       AND payment.id=registration.payment_id
      LEFT JOIN LATERAL (
        SELECT action.state FROM mbox.payment_provider_actions action
        WHERE action.tenant_id=payment.tenant_id AND action.store_id=payment.store_id
          AND action.payment_id=payment.id LIMIT 1
      ) provider_action ON true
      LEFT JOIN LATERAL (
        SELECT refund.id, refund.public_id, refund.status, refund.amount_minor,
          refund.requested_by_employee_id, refund.approved_by_employee_id,
          refund.created_at, refund.updated_at
        FROM mbox.refunds refund
        WHERE refund.tenant_id=payment.tenant_id AND refund.store_id=payment.store_id
          AND refund.payment_id=payment.id
        ORDER BY refund.created_at DESC, refund.id DESC LIMIT 1
      ) latest_refund ON true
      WHERE registration.tenant_id=$1::uuid AND registration.store_id=$2::uuid
        AND registration.id=$3::uuid
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, id])
    const row = result.rows[0]
    if (!row) throw new ActivityOperationsError('报名状态读回失败', 'ACTIVITY_REGISTRATION_READBACK_FAILED', 500)
    return registrationView(row)
  }
}

const ACTIVITY_SUMMARY_QUERY = `
  SELECT activity.public_id, activity.title, activity.status,
    activity.starts_at::text, activity.ends_at::text, activity.assembly_location,
    activity.capacity, activity.registration_payment_mode, activity.fee_amount_minor,
    activity.currency,
    COALESCE(sum(registration.party_size) FILTER (
      WHERE registration.status IN ('reserved','payment_pending','confirmed','checked_in')
    ),0)::text AS occupied_seats,
    COALESCE(sum(registration.party_size) FILTER (
      WHERE registration.status='waitlisted'
    ),0)::text AS waitlisted_seats,
    count(registration.id)::text AS registration_count
  FROM mbox.community_activities activity
  LEFT JOIN mbox.community_activity_registrations registration
    ON registration.tenant_id=activity.tenant_id AND registration.store_id=activity.store_id
   AND registration.activity_id=activity.id
  WHERE activity.tenant_id=$1::uuid AND activity.store_id=$2::uuid
  GROUP BY activity.id
`

const ACTIVITY_DETAIL_QUERY = `
  SELECT activity.public_id, activity.title, activity.status,
    activity.starts_at::text, activity.ends_at::text, activity.assembly_location,
    activity.capacity, activity.registration_payment_mode, activity.fee_amount_minor,
    activity.currency, activity.activity_kind, activity.summary, activity.cover_url,
    activity.deposit_amount_minor, activity.fee_basis, activity.payment_deadline_minutes,
    activity.payment_rule_text, activity.points_reward, activity.visibility,
    activity.audience_member_levels, activity.audience_lifecycle_stages,
    activity.safety_policy_version, activity.safety_acknowledgement_text,
    activity.safety_requirements, activity.refund_policy_version,
    activity.refund_policy_summary, activity.activity_details, activity.included_items,
    activity.participation_requirements, activity.contact_instructions,
    activity.member_benefit_text, activity.created_by_employee_id,
    activity.approved_by_employee_id, activity.published_at::text,
    activity.updated_at::text,
    COALESCE(sum(registration.party_size) FILTER (
      WHERE registration.status IN ('reserved','payment_pending','confirmed','checked_in')
    ),0)::text AS occupied_seats,
    COALESCE(sum(registration.party_size) FILTER (
      WHERE registration.status='waitlisted'
    ),0)::text AS waitlisted_seats,
    count(registration.id)::text AS registration_count
  FROM mbox.community_activities activity
  LEFT JOIN mbox.community_activity_registrations registration
    ON registration.tenant_id=activity.tenant_id AND registration.store_id=activity.store_id
   AND registration.activity_id=activity.id
`

function summaryView(row: ActivitySummaryRow): ActivityOperationsSummary {
  return {
    publicId: row.public_id,
    title: row.title,
    status: row.status,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    assemblyLocation: row.assembly_location,
    capacity: integer(row.capacity, 'activity capacity'),
    occupiedSeats: integer(row.occupied_seats, 'occupied seats'),
    waitlistedSeats: integer(row.waitlisted_seats, 'waitlisted seats'),
    registrationCount: integer(row.registration_count, 'registration count'),
    paymentMode: row.registration_payment_mode,
    feeAmountMinor: money(row.fee_amount_minor, 'activity fee'),
    currency: row.currency,
  }
}

function detailView(row: ActivityDetailRow): ActivityOperationsActivity {
  return {
    ...summaryView(row),
    kind: row.activity_kind,
    summary: row.summary,
    coverUrl: row.cover_url,
    depositAmountMinor: money(row.deposit_amount_minor, 'activity deposit'),
    feeBasis: row.fee_basis,
    paymentDeadlineMinutes: integer(row.payment_deadline_minutes, 'payment deadline'),
    paymentRuleText: row.payment_rule_text,
    pointsReward: integer(row.points_reward, 'points reward'),
    visibility: row.visibility,
    audienceMemberLevels: textArray(row.audience_member_levels),
    audienceLifecycleStages: textArray(row.audience_lifecycle_stages),
    safetyPolicyVersion: row.safety_policy_version,
    safetyAcknowledgementText: row.safety_acknowledgement_text,
    safetyRequirements: textArray(row.safety_requirements),
    refundPolicyVersion: row.refund_policy_version,
    refundPolicySummary: row.refund_policy_summary,
    activityDetails: row.activity_details,
    includedItems: textArray(row.included_items),
    participationRequirements: textArray(row.participation_requirements),
    contactInstructions: row.contact_instructions,
    memberBenefitText: row.member_benefit_text,
    createdByEmployeeId: row.created_by_employee_id,
    approvedByEmployeeId: row.approved_by_employee_id,
    publishedAt: row.published_at,
    updatedAt: row.updated_at,
  }
}

function registrationView(row: RegistrationRow): ActivityOperationsRegistration {
  const refund = row.refund_id === null ? null : {
    id: row.refund_id,
    publicId: required(row.refund_public_id, 'refund public id'),
    status: required(row.refund_status, 'refund status'),
    amountMinor: money(row.refund_amount_minor, 'refund amount'),
    requestedByEmployeeId: required(row.refund_requested_by_employee_id, 'refund requester'),
    approvedByEmployeeId: row.refund_approved_by_employee_id,
    createdAt: required(row.refund_created_at, 'refund created at'),
    updatedAt: required(row.refund_updated_at, 'refund updated at'),
  }
  return {
    publicId: row.public_id,
    customerPublicId: row.customer_public_id,
    customerLabel: row.customer_label,
    contactVersionPublicId: row.contact_version_public_id,
    maskedContact: row.masked_contact,
    memberLevel: row.member_level,
    partySize: integer(row.party_size, 'party size'),
    status: row.status,
    paymentChoice: row.payment_choice,
    requestedPaymentChoice: row.requested_payment_choice,
    requestedPaymentMethod: row.requested_payment_method,
    requestedAmountDueMinor: money(row.requested_amount_due_minor, 'requested registration amount due'),
    paymentStatus: row.payment_status,
    totalFeeAmountMinor: money(row.fee_amount_minor, 'registration fee'),
    amountDueMinor: money(row.amount_due_minor, 'registration amount due'),
    paidAmountMinor: money(row.paid_amount_minor, 'registration paid amount'),
    currency: row.currency,
    registeredAt: row.registered_at,
    paymentDueAt: row.payment_due_at,
    seatHoldExpiresAt: row.seat_hold_expires_at,
    checkedInAt: row.checked_in_at,
    cancelledAt: row.cancelled_at,
    paymentId: row.payment_id,
    paymentPublicId: row.payment_public_id,
    authoritativePaymentStatus: row.authoritative_payment_status,
    providerActionState: row.provider_action_state,
    refund,
  }
}

function invalidTransition(status: string, action: string) {
  return new ActivityOperationsError(`当前报名状态“${status}”不能${action}`, 'ACTIVITY_REGISTRATION_TRANSITION_DENIED')
}

function money(value: unknown, label: string): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new TypeError(`${label} is invalid`)
  return parsed
}

function integer(value: unknown, label: string): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new TypeError(`${label} is invalid`)
  return parsed
}

function textArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new TypeError('activity text array is invalid')
  }
  return [...value]
}

function required(value: string | null, label: string): string {
  if (value === null || value === '') throw new TypeError(`${label} is missing`)
  return value
}
