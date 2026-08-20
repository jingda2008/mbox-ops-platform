import { createHash } from 'node:crypto'
import type { ScopedTransaction } from './transaction-runner.js'

export const WECHAT_LOYALTY_NOTIFICATION_TYPES = Object.freeze([
  'loyalty_points_credited',
  'loyalty_points_reversed',
  'loyalty_points_expiring',
] as const)

export type WechatLoyaltyNotificationType = (typeof WECHAT_LOYALTY_NOTIFICATION_TYPES)[number]
export type WechatNotificationAuthorizationContext = 'loyalty_accrual' | 'loyalty_refund' | 'loyalty_expiry'
export type WechatNotificationAuthorizationPurpose = 'loyalty_balance_change' | 'loyalty_expiry_reminder'

export interface WechatNotificationAuthorizationOption {
  policyId: string
  notificationType: WechatLoyaltyNotificationType
  purpose: WechatNotificationAuthorizationPurpose
  authorizationContext: WechatNotificationAuthorizationContext
  policyVersion: number
  templateId: string
  decision: 'granted' | 'denied' | 'revoked' | null
  platformResult: 'accept' | 'reject' | 'ban' | 'revoke' | null
  authorizationVersion: number
  usesRemaining: number
  changedAt: string | null
}

export interface WechatNotificationAuthorizationRecord extends WechatNotificationAuthorizationOption {
  id: string
  customerId: string
  membershipId: string
  identityExternalId: string
}

interface AuthorizationOptionRow extends Record<string, unknown> {
  policy_id: string
  notification_type: WechatLoyaltyNotificationType
  authorization_purpose: WechatNotificationAuthorizationPurpose
  authorization_context: WechatNotificationAuthorizationContext
  policy_version: number
  template_id: string
  decision: 'granted' | 'denied' | 'revoked' | null
  platform_result: 'accept' | 'reject' | 'ban' | 'revoke' | null
  authorization_version: number | null
  uses_remaining: number | null
  authorized_at: string | null
}

interface AuthorizationRow extends AuthorizationOptionRow {
  id: string
  customer_id: string
  membership_id: string
  identity_external_id: string
}

export class WechatNotificationAuthorizationError extends Error {
  constructor(
    readonly code:
      | 'WECHAT_NOTIFICATION_NOT_CONFIGURED'
      | 'WECHAT_NOTIFICATION_POLICY_STALE'
      | 'WECHAT_NOTIFICATION_MEMBERSHIP_REQUIRED'
      | 'WECHAT_NOTIFICATION_IDENTITY_REQUIRED'
      | 'WECHAT_NOTIFICATION_VERSION_CONFLICT',
    message: string,
  ) {
    super(message)
    this.name = 'WechatNotificationAuthorizationError'
  }
}

export class WechatLoyaltyNotificationRepository {
  constructor(private readonly transaction: ScopedTransaction) {}

  async authorizationOptions(
    customerId: string,
    channelConfigured: boolean,
  ): Promise<WechatNotificationAuthorizationOption[]> {
    requireUuid(customerId, 'customerId')
    if (!channelConfigured) return []
    const result = await this.transaction.query<AuthorizationOptionRow>(`
      SELECT policy.id AS policy_id,policy.notification_type,policy.authorization_purpose,
        policy.authorization_context,policy.policy_version,policy.template_id,
        latest.decision,latest.platform_result,latest.authorization_version,latest.authorized_at::text,
        CASE WHEN latest.decision='granted' AND NOT EXISTS(
          SELECT 1 FROM mbox.wechat_notification_authorization_uses used
          WHERE used.tenant_id=policy.tenant_id AND used.store_id=policy.store_id
            AND used.authorization_id=latest.id
        ) THEN 1 ELSE 0 END::integer AS uses_remaining
      FROM mbox.wechat_notification_policies policy
      JOIN mbox.customer_memberships membership
        ON membership.tenant_id=policy.tenant_id AND membership.store_id=policy.store_id
       AND membership.customer_id=$3::uuid AND membership.status='active'
      LEFT JOIN LATERAL (
        SELECT latest_auth.id,latest_auth.decision,latest_auth.platform_result,
          latest_auth.authorization_version,latest_auth.authorized_at
        FROM mbox.wechat_notification_authorizations latest_auth
        WHERE latest_auth.tenant_id=policy.tenant_id
          AND latest_auth.store_id=policy.store_id
          AND latest_auth.customer_id=membership.customer_id
          AND latest_auth.membership_id=membership.id
          AND latest_auth.policy_id=policy.id
        ORDER BY latest_auth.authorization_version DESC,latest_auth.id DESC LIMIT 1
      ) latest ON true
      WHERE policy.tenant_id=$1::uuid AND policy.store_id=$2::uuid
        AND policy.status='published' AND policy.effective_from<=clock_timestamp()
        AND (policy.effective_until IS NULL OR policy.effective_until>clock_timestamp())
      ORDER BY CASE policy.notification_type
        WHEN 'loyalty_points_credited' THEN 1
        WHEN 'loyalty_points_reversed' THEN 2 ELSE 3 END
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, customerId])
    return result.rows.map(mapAuthorizationOption)
  }

  async recordAuthorization(input: Readonly<{
    customerId: string
    notificationType: WechatLoyaltyNotificationType
    policyId: string
    policyVersion: number
    templateId: string
    expectedVersion: number
    platformResult: 'accept' | 'reject' | 'ban' | 'revoke'
    platformEventReference: string
    authorizedAt?: string
  }>): Promise<WechatNotificationAuthorizationRecord> {
    validateAuthorizationInput(input)
    await this.transaction.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `wechat-notification-authorization:${this.transaction.scope.tenantId}:${this.transaction.scope.storeId}:${input.customerId}:${input.policyId}`,
    ])
    const selected = await this.transaction.query<{
      policy_id: string
      notification_type: WechatLoyaltyNotificationType
      authorization_purpose: WechatNotificationAuthorizationPurpose
      authorization_context: WechatNotificationAuthorizationContext
      policy_version: number
      template_id: string
      membership_id: string
      identity_external_id: string | null
      current_version: number
    }>(`
      SELECT policy.id AS policy_id,policy.notification_type,policy.authorization_purpose,
        policy.authorization_context,policy.policy_version,policy.template_id,
        membership.id AS membership_id,identity.external_identity_id AS identity_external_id,
        COALESCE(latest.authorization_version,0)::integer AS current_version
      FROM mbox.wechat_notification_policies policy
      JOIN mbox.customer_memberships membership
        ON membership.tenant_id=policy.tenant_id AND membership.store_id=policy.store_id
       AND membership.customer_id=$3::uuid AND membership.status='active'
      LEFT JOIN LATERAL (
        SELECT wechat_identity.external_identity_id
        FROM mbox.wechat_identities wechat_identity
        JOIN mbox.customer_identities customer_identity
          ON customer_identity.tenant_id=wechat_identity.tenant_id
         AND customer_identity.store_id=wechat_identity.store_id
         AND customer_identity.identity_kind='wechat'
         AND customer_identity.identity_hash=encode(digest('wechat:'||wechat_identity.principal_id,'sha256'),'hex')
         AND customer_identity.status='active' AND customer_identity.customer_id=membership.customer_id
        WHERE wechat_identity.tenant_id=policy.tenant_id
          AND wechat_identity.store_id=policy.store_id
          AND wechat_identity.channel='mini_program' AND wechat_identity.revoked_at IS NULL
          AND (wechat_identity.member_id IS NULL OR wechat_identity.member_id=membership.id)
        ORDER BY wechat_identity.last_authenticated_at DESC,wechat_identity.id DESC LIMIT 1
      ) identity ON true
      LEFT JOIN LATERAL (
        SELECT latest_auth.authorization_version
        FROM mbox.wechat_notification_authorizations latest_auth
        WHERE latest_auth.tenant_id=policy.tenant_id AND latest_auth.store_id=policy.store_id
          AND latest_auth.customer_id=membership.customer_id
          AND latest_auth.membership_id=membership.id AND latest_auth.policy_id=policy.id
        ORDER BY latest_auth.authorization_version DESC,latest_auth.id DESC LIMIT 1
      ) latest ON true
      WHERE policy.tenant_id=$1::uuid AND policy.store_id=$2::uuid
        AND policy.id=$4::uuid AND policy.notification_type=$5
        AND policy.status='published' AND policy.effective_from<=clock_timestamp()
        AND (policy.effective_until IS NULL OR policy.effective_until>clock_timestamp())
      FOR KEY SHARE OF policy,membership
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.customerId,
      input.policyId,
      input.notificationType,
    ])
    const row = selected.rows[0]
    if (!row) throw new WechatNotificationAuthorizationError(
      'WECHAT_NOTIFICATION_MEMBERSHIP_REQUIRED', '当前会员或通知政策不可用',
    )
    if (row.policy_version !== input.policyVersion || row.template_id !== input.templateId) {
      throw new WechatNotificationAuthorizationError(
        'WECHAT_NOTIFICATION_POLICY_STALE', '通知模板已经更新，请刷新后重新授权',
      )
    }
    if (row.identity_external_id === null) throw new WechatNotificationAuthorizationError(
      'WECHAT_NOTIFICATION_IDENTITY_REQUIRED', '当前顾客没有可验证的本人微信身份',
    )
    if (row.current_version !== input.expectedVersion) throw new WechatNotificationAuthorizationError(
      'WECHAT_NOTIFICATION_VERSION_CONFLICT', '通知授权已变化，请刷新后重试',
    )
    const decision = input.platformResult === 'accept' ? 'granted'
      : input.platformResult === 'revoke' ? 'revoked' : 'denied'
    const inserted = await this.transaction.query<AuthorizationRow>(`
      INSERT INTO mbox.wechat_notification_authorizations(
        tenant_id,store_id,customer_id,membership_id,identity_external_id,
        policy_id,notification_type,authorization_purpose,authorization_context,
        policy_version,template_id,decision,platform_result,authorization_version,
        uses_allowed,source,platform_event_reference_hash,authorized_at
      ) VALUES(
        $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6::uuid,$7,$8,$9,$10,$11,$12,$13,
        $14,$15,$16,$17,COALESCE($18::timestamptz,clock_timestamp())
      )
      RETURNING id,customer_id,membership_id,identity_external_id,policy_id,
        notification_type,authorization_purpose,authorization_context,policy_version,
        template_id,decision,platform_result,authorization_version,
        uses_allowed AS uses_remaining,authorized_at::text
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.customerId,
      row.membership_id,
      row.identity_external_id,
      row.policy_id,
      row.notification_type,
      row.authorization_purpose,
      row.authorization_context,
      row.policy_version,
      row.template_id,
      decision,
      input.platformResult,
      row.current_version + 1,
      decision === 'granted' ? 1 : 0,
      input.platformResult === 'revoke' ? 'customer_revoke' : 'wechat_client',
      createHash('sha256').update(input.platformEventReference).digest('hex'),
      input.authorizedAt ?? null,
    ])
    const authorization = inserted.rows[0]
    if (!authorization) throw new Error('WeChat notification authorization was not recorded')
    return mapAuthorization(authorization)
  }

  async enqueuePointsCredited(input: Readonly<{
    awardId: string
    pointsChange: number
    balanceAfter: number
    occurredAt: string
  }>): Promise<boolean> {
    validateEvent(input.awardId, input.pointsChange, input.balanceAfter, input.occurredAt, 'credited')
    return this.enqueueFromSource({
      sourceType: 'loyalty_order_award',
      sourceId: input.awardId,
      notificationType: 'loyalty_points_credited',
      pointsChange: input.pointsChange,
      pointsAtRisk: 0,
      balanceAfter: input.balanceAfter,
      expiresAt: null,
      occurredAt: input.occurredAt,
    })
  }

  async enqueuePointsReversed(input: Readonly<{
    refundApplicationId: string
    pointsChange: number
    balanceAfter: number
    occurredAt: string
  }>): Promise<boolean> {
    validateEvent(input.refundApplicationId, input.pointsChange, input.balanceAfter, input.occurredAt, 'reversed')
    return this.enqueueFromSource({
      sourceType: 'loyalty_refund_application',
      sourceId: input.refundApplicationId,
      notificationType: 'loyalty_points_reversed',
      pointsChange: input.pointsChange,
      pointsAtRisk: 0,
      balanceAfter: input.balanceAfter,
      expiresAt: null,
      occurredAt: input.occurredAt,
    })
  }

  async enqueueExpiringLots(batchSize = 100): Promise<number> {
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 500) {
      throw new TypeError('batchSize must be between 1 and 500')
    }
    const result = await this.transaction.query(`
      WITH candidates AS (
        SELECT lot.id AS source_id,lot.membership_id,membership.customer_id,
          lot.remaining_points AS points_at_risk,lot.expires_at,
          policy.id AS policy_id,policy.notification_type,policy.authorization_purpose,
          policy.authorization_context,policy.policy_version,policy.template_id,
          authorization_choice.id AS authorization_id,authorization_choice.identity_external_id,
          mbox.wechat_notification_scheduled_at(
            clock_timestamp(),policy.quiet_hours_start,policy.quiet_hours_end,store.timezone
          ) AS scheduled_for
        FROM mbox.loyalty_point_lots lot
        JOIN mbox.customer_memberships membership
          ON membership.tenant_id=lot.tenant_id AND membership.store_id=lot.store_id
         AND membership.id=lot.membership_id AND membership.status='active'
        JOIN mbox.stores store ON store.tenant_id=lot.tenant_id AND store.id=lot.store_id
        JOIN mbox.wechat_notification_policies policy
          ON policy.tenant_id=lot.tenant_id AND policy.store_id=lot.store_id
         AND policy.notification_type='loyalty_points_expiring' AND policy.status='published'
         AND policy.effective_from<=clock_timestamp()
         AND (policy.effective_until IS NULL OR policy.effective_until>clock_timestamp())
        JOIN LATERAL (
          SELECT candidate.id,candidate.identity_external_id
          FROM mbox.wechat_notification_authorizations candidate
          WHERE candidate.tenant_id=lot.tenant_id AND candidate.store_id=lot.store_id
            AND candidate.customer_id=membership.customer_id
            AND candidate.membership_id=membership.id AND candidate.policy_id=policy.id
          ORDER BY candidate.authorization_version DESC,candidate.id DESC LIMIT 1
        ) authorization_choice ON true
        WHERE lot.tenant_id=$1::uuid AND lot.store_id=$2::uuid
          AND lot.status='available' AND lot.remaining_points>0 AND lot.expires_at IS NOT NULL
          AND lot.expires_at>clock_timestamp()
          AND lot.expires_at<=clock_timestamp()+make_interval(days=>policy.expiry_lead_days)
          AND EXISTS(
            SELECT 1 FROM mbox.wechat_notification_authorizations current_authorization
            WHERE current_authorization.tenant_id=lot.tenant_id
              AND current_authorization.store_id=lot.store_id
              AND current_authorization.id=authorization_choice.id
              AND current_authorization.decision='granted'
          )
          AND NOT EXISTS(
            SELECT 1 FROM mbox.wechat_notification_authorization_uses authorization_use
            WHERE authorization_use.tenant_id=lot.tenant_id
              AND authorization_use.store_id=lot.store_id
              AND authorization_use.authorization_id=authorization_choice.id
          )
          AND NOT EXISTS(
            SELECT 1 FROM mbox.wechat_customer_notification_jobs existing
            WHERE existing.tenant_id=lot.tenant_id AND existing.store_id=lot.store_id
              AND existing.source_type='loyalty_point_lot' AND existing.source_id=lot.id
              AND existing.notification_type='loyalty_points_expiring'
          )
        ORDER BY lot.expires_at,lot.id LIMIT $3
        FOR UPDATE OF lot SKIP LOCKED
      )
      INSERT INTO mbox.wechat_customer_notification_jobs(
        tenant_id,store_id,customer_id,membership_id,identity_external_id,
        authorization_id,policy_id,notification_type,authorization_purpose,
        authorization_context,policy_version,template_id,source_type,source_id,
        points_change,points_at_risk,balance_after,expires_at,event_occurred_at,scheduled_for
      )
      SELECT $1::uuid,$2::uuid,customer_id,membership_id,identity_external_id,
        authorization_id,policy_id,notification_type,authorization_purpose,
        authorization_context,policy_version,template_id,'loyalty_point_lot',source_id,
        0,points_at_risk,NULL,expires_at,clock_timestamp(),scheduled_for
      FROM candidates
      ON CONFLICT (tenant_id,store_id,source_type,source_id,notification_type) DO NOTHING
      RETURNING id
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, batchSize])
    return result.rowCount ?? result.rows.length
  }

  private async enqueueFromSource(input: Readonly<{
    sourceType: 'loyalty_order_award' | 'loyalty_refund_application'
    sourceId: string
    notificationType: 'loyalty_points_credited' | 'loyalty_points_reversed'
    pointsChange: number
    pointsAtRisk: 0
    balanceAfter: number
    expiresAt: null
    occurredAt: string
  }>): Promise<boolean> {
    const sourceJoin = input.sourceType === 'loyalty_order_award'
      ? `JOIN mbox.loyalty_order_awards source
           ON source.tenant_id=policy.tenant_id AND source.store_id=policy.store_id
          AND source.id=$4::uuid
         JOIN mbox.customer_memberships membership
           ON membership.tenant_id=source.tenant_id AND membership.store_id=source.store_id
          AND membership.id=source.membership_id AND membership.status='active'`
      : `JOIN mbox.loyalty_award_refund_applications source
           ON source.tenant_id=policy.tenant_id AND source.store_id=policy.store_id
          AND source.id=$4::uuid
         JOIN mbox.loyalty_order_awards award
           ON award.tenant_id=source.tenant_id AND award.store_id=source.store_id
          AND award.id=source.award_id
         JOIN mbox.customer_memberships membership
           ON membership.tenant_id=award.tenant_id AND membership.store_id=award.store_id
          AND membership.id=award.membership_id AND membership.status='active'`
    const result = await this.transaction.query(`
      WITH eligible AS (
        SELECT membership.id AS membership_id,membership.customer_id,
          policy.id AS policy_id,policy.notification_type,policy.authorization_purpose,
          policy.authorization_context,policy.policy_version,policy.template_id,
          authorization_choice.id AS authorization_id,authorization_choice.identity_external_id,
          mbox.wechat_notification_scheduled_at(
            $8::timestamptz,policy.quiet_hours_start,policy.quiet_hours_end,store.timezone
          ) AS scheduled_for
        FROM mbox.wechat_notification_policies policy
        JOIN mbox.stores store ON store.tenant_id=policy.tenant_id AND store.id=policy.store_id
        ${sourceJoin}
        JOIN LATERAL (
          SELECT candidate.id,candidate.identity_external_id,candidate.decision
          FROM mbox.wechat_notification_authorizations candidate
          WHERE candidate.tenant_id=policy.tenant_id AND candidate.store_id=policy.store_id
            AND candidate.customer_id=membership.customer_id
            AND candidate.membership_id=membership.id AND candidate.policy_id=policy.id
          ORDER BY candidate.authorization_version DESC,candidate.id DESC LIMIT 1
        ) authorization_choice ON authorization_choice.decision='granted'
        WHERE policy.tenant_id=$1::uuid AND policy.store_id=$2::uuid
          AND policy.notification_type=$3 AND policy.status='published'
          AND policy.effective_from<=$8::timestamptz
          AND (policy.effective_until IS NULL OR policy.effective_until>$8::timestamptz)
          AND NOT EXISTS(
            SELECT 1 FROM mbox.wechat_notification_authorization_uses authorization_use
            WHERE authorization_use.tenant_id=policy.tenant_id
              AND authorization_use.store_id=policy.store_id
              AND authorization_use.authorization_id=authorization_choice.id
          )
      )
      INSERT INTO mbox.wechat_customer_notification_jobs(
        tenant_id,store_id,customer_id,membership_id,identity_external_id,
        authorization_id,policy_id,notification_type,authorization_purpose,
        authorization_context,policy_version,template_id,source_type,source_id,
        points_change,points_at_risk,balance_after,expires_at,event_occurred_at,scheduled_for
      )
      SELECT $1::uuid,$2::uuid,customer_id,membership_id,identity_external_id,
        authorization_id,policy_id,notification_type,authorization_purpose,
        authorization_context,policy_version,template_id,$5,$4::uuid,$6,0,$7,NULL,$8::timestamptz,scheduled_for
      FROM eligible
      ON CONFLICT (tenant_id,store_id,source_type,source_id,notification_type) DO NOTHING
      RETURNING id
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.notificationType,
      input.sourceId,
      input.sourceType,
      input.pointsChange,
      input.balanceAfter,
      input.occurredAt,
    ])
    return result.rowCount === 1
  }
}

function mapAuthorizationOption(row: AuthorizationOptionRow): WechatNotificationAuthorizationOption {
  return {
    policyId: row.policy_id,
    notificationType: row.notification_type,
    purpose: row.authorization_purpose,
    authorizationContext: row.authorization_context,
    policyVersion: Number(row.policy_version),
    templateId: row.template_id,
    decision: row.decision,
    platformResult: row.platform_result,
    authorizationVersion: Number(row.authorization_version ?? 0),
    usesRemaining: Number(row.uses_remaining ?? 0),
    changedAt: row.authorized_at,
  }
}

function mapAuthorization(row: AuthorizationRow): WechatNotificationAuthorizationRecord {
  return {
    id: row.id,
    customerId: row.customer_id,
    membershipId: row.membership_id,
    identityExternalId: row.identity_external_id,
    ...mapAuthorizationOption(row),
  }
}

function validateAuthorizationInput(input: Readonly<{
  customerId: string
  notificationType: string
  policyId: string
  policyVersion: number
  templateId: string
  expectedVersion: number
  platformResult: string
  platformEventReference: string
  authorizedAt?: string
}>): void {
  requireUuid(input.customerId, 'customerId')
  requireUuid(input.policyId, 'policyId')
  if (!WECHAT_LOYALTY_NOTIFICATION_TYPES.includes(input.notificationType as WechatLoyaltyNotificationType)) {
    throw new TypeError('notificationType is invalid')
  }
  if (!Number.isSafeInteger(input.policyVersion) || input.policyVersion < 1) throw new TypeError('policyVersion is invalid')
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) throw new TypeError('expectedVersion is invalid')
  if (input.templateId.trim().length < 8 || input.templateId.length > 128) throw new TypeError('templateId is invalid')
  if (!['accept', 'reject', 'ban', 'revoke'].includes(input.platformResult)) throw new TypeError('platformResult is invalid')
  if (input.platformEventReference.trim().length < 8 || input.platformEventReference.length > 200) {
    throw new TypeError('platformEventReference is invalid')
  }
  if (input.authorizedAt !== undefined && !Number.isFinite(Date.parse(input.authorizedAt))) {
    throw new TypeError('authorizedAt is invalid')
  }
}

function validateEvent(
  id: string,
  pointsChange: number,
  balanceAfter: number,
  occurredAt: string,
  kind: 'credited' | 'reversed',
): void {
  requireUuid(id, 'sourceId')
  if (!Number.isSafeInteger(pointsChange) || (kind === 'credited' ? pointsChange <= 0 : pointsChange >= 0)) {
    throw new TypeError('pointsChange is invalid')
  }
  if (!Number.isSafeInteger(balanceAfter) || balanceAfter < 0) throw new TypeError('balanceAfter is invalid')
  if (!Number.isFinite(Date.parse(occurredAt))) throw new TypeError('occurredAt is invalid')
}

function requireUuid(value: string, label: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new TypeError(`${label} is invalid`)
  }
}
