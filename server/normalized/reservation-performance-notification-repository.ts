import { createHash } from 'node:crypto'
import type { ScopedTransaction } from './transaction-runner.js'

export interface ReservationPerformanceNotificationAuthorizationOption {
  reservationPublicId: string
  policyId: string
  policyVersion: number
  templateId: string
  decision: 'granted' | 'denied' | 'revoked' | null
  platformResult: 'accept' | 'reject' | 'ban' | 'revoke' | null
  authorizationVersion: number
  usesRemaining: number
  changedAt: string | null
}

export interface ReservationPerformanceNotificationAuthorizationRecord
  extends ReservationPerformanceNotificationAuthorizationOption {
  id: string
  reservationId: string
  canonicalCustomerId: string
  identityExternalId: string
}

interface AuthorizationOptionRow extends Record<string, unknown> {
  reservation_public_id: string
  policy_id: string
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
  reservation_id: string
  canonical_customer_id: string
  identity_external_id: string
}

export class ReservationPerformanceNotificationAuthorizationError extends Error {
  constructor(
    readonly code:
      | 'RESERVATION_NOTIFICATION_RESERVATION_NOT_FOUND'
      | 'RESERVATION_NOTIFICATION_POLICY_STALE'
      | 'RESERVATION_NOTIFICATION_IDENTITY_REQUIRED'
      | 'RESERVATION_NOTIFICATION_VERSION_CONFLICT',
    message: string,
  ) {
    super(message)
    this.name = 'ReservationPerformanceNotificationAuthorizationError'
  }
}

export class ReservationPerformanceNotificationRepository {
  constructor(private readonly transaction: ScopedTransaction) {}

  async authorizationOptions(
    customerId: string,
    channelConfigured: boolean,
  ): Promise<ReservationPerformanceNotificationAuthorizationOption[]> {
    requireUuid(customerId, 'customerId')
    if (!channelConfigured) return []
    const result = await this.transaction.query<AuthorizationOptionRow>(`
      SELECT reservation.public_id AS reservation_public_id,
        policy.id AS policy_id,policy.policy_version,policy.template_id,
        latest.decision,latest.platform_result,latest.authorization_version,
        latest.authorized_at::text,
        CASE WHEN latest.decision='granted' AND NOT EXISTS(
          SELECT 1 FROM mbox.reservation_performance_notification_authorization_uses used
          WHERE used.tenant_id=policy.tenant_id AND used.store_id=policy.store_id
            AND used.authorization_id=latest.id
        ) THEN 1 ELSE 0 END::integer AS uses_remaining
      FROM mbox.reservations reservation
      JOIN mbox.reservation_performance_notification_policies policy
        ON policy.tenant_id=reservation.tenant_id AND policy.store_id=reservation.store_id
       AND policy.status='published' AND policy.effective_from<=clock_timestamp()
       AND (policy.effective_until IS NULL OR policy.effective_until>clock_timestamp())
       AND policy.notification_type='reservation_performance_revised'
       AND policy.authorization_context='reservation'
      LEFT JOIN LATERAL (
        SELECT grant_record.id,grant_record.decision,grant_record.platform_result,
          grant_record.authorization_version,grant_record.authorized_at
        FROM mbox.reservation_performance_notification_authorizations grant_record
        WHERE grant_record.tenant_id=reservation.tenant_id
          AND grant_record.store_id=reservation.store_id
          AND grant_record.reservation_id=reservation.id
          AND grant_record.policy_id=policy.id
          AND grant_record.canonical_customer_id=mbox.canonical_customer_id(
            reservation.tenant_id,reservation.store_id,$3::uuid
          )
        ORDER BY grant_record.authorization_version DESC,grant_record.id DESC LIMIT 1
      ) latest ON true
      WHERE reservation.tenant_id=$1::uuid AND reservation.store_id=$2::uuid
        AND reservation.customer_id IS NOT NULL
        AND mbox.canonical_customer_id(
          reservation.tenant_id,reservation.store_id,reservation.customer_id
        )=mbox.canonical_customer_id(reservation.tenant_id,reservation.store_id,$3::uuid)
        AND reservation.preferred_schedule_id IS NOT NULL
        AND reservation.status IN ('pending','confirmed','arrived','seated')
      ORDER BY reservation.arrival_at,reservation.id
      LIMIT 100
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, customerId])
    return result.rows.map(mapOption)
  }

  async presentationPolicy(
    channelConfigured: boolean,
  ): Promise<ReservationPerformanceNotificationAuthorizationOption | null> {
    if (!channelConfigured) return null
    const result = await this.transaction.query<AuthorizationOptionRow>(`
      SELECT '' AS reservation_public_id,
        policy.id AS policy_id,policy.policy_version,policy.template_id,
        NULL::text AS decision,NULL::text AS platform_result,0::integer AS authorization_version,
        NULL::text AS authorized_at,0::integer AS uses_remaining
      FROM mbox.reservation_performance_notification_policies policy
      WHERE policy.tenant_id=$1::uuid AND policy.store_id=$2::uuid
        AND policy.status='published' AND policy.effective_from<=clock_timestamp()
        AND (policy.effective_until IS NULL OR policy.effective_until>clock_timestamp())
        AND policy.notification_type='reservation_performance_revised'
        AND policy.authorization_context='reservation'
      ORDER BY policy.policy_version DESC,policy.id DESC
      LIMIT 1
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId])
    const row = result.rows[0]
    return row ? mapOption(row) : null
  }

  async recordAuthorization(input: Readonly<{
    customerId: string
    reservationPublicId: string
    policyId: string
    policyVersion: number
    templateId: string
    expectedVersion: number
    platformResult: 'accept' | 'reject' | 'ban' | 'revoke'
    platformEventReference: string
    authorizedAt?: string
  }>): Promise<ReservationPerformanceNotificationAuthorizationRecord> {
    validateInput(input)
    await this.transaction.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `reservation-performance-notification:${this.transaction.scope.tenantId}:${this.transaction.scope.storeId}:${input.reservationPublicId}:${input.policyId}`,
    ])
    const selected = await this.transaction.query<{
      reservation_id: string
      reservation_public_id: string
      canonical_customer_id: string
      policy_id: string
      policy_version: number
      template_id: string
      identity_external_id: string | null
      current_version: number
    }>(`
      SELECT reservation.id AS reservation_id,reservation.public_id AS reservation_public_id,
        mbox.canonical_customer_id(
          reservation.tenant_id,reservation.store_id,$3::uuid
        ) AS canonical_customer_id,
        policy.id AS policy_id,policy.policy_version,policy.template_id,
        identity.external_identity_id AS identity_external_id,
        COALESCE(latest.authorization_version,0)::integer AS current_version
      FROM mbox.reservations reservation
      JOIN mbox.reservation_performance_notification_policies policy
        ON policy.tenant_id=reservation.tenant_id AND policy.store_id=reservation.store_id
       AND policy.id=$5::uuid AND policy.status='published'
       AND policy.notification_type='reservation_performance_revised'
       AND policy.authorization_context='reservation'
       AND policy.effective_from<=clock_timestamp()
       AND (policy.effective_until IS NULL OR policy.effective_until>clock_timestamp())
      LEFT JOIN LATERAL (
        SELECT wechat_identity.external_identity_id
        FROM mbox.wechat_identities wechat_identity
        JOIN mbox.customer_identities customer_identity
          ON customer_identity.tenant_id=wechat_identity.tenant_id
         AND customer_identity.store_id=wechat_identity.store_id
         AND customer_identity.identity_kind='wechat'
         AND customer_identity.identity_hash=encode(
           digest('wechat:'||wechat_identity.principal_id,'sha256'),'hex'
         )
         AND customer_identity.status='active'
         AND mbox.canonical_customer_id(
           customer_identity.tenant_id,customer_identity.store_id,customer_identity.customer_id
         )=mbox.canonical_customer_id(reservation.tenant_id,reservation.store_id,$3::uuid)
        WHERE wechat_identity.tenant_id=reservation.tenant_id
          AND wechat_identity.store_id=reservation.store_id
          AND wechat_identity.channel='mini_program' AND wechat_identity.revoked_at IS NULL
        ORDER BY wechat_identity.last_authenticated_at DESC,wechat_identity.id DESC LIMIT 1
      ) identity ON true
      LEFT JOIN LATERAL (
        SELECT grant_record.authorization_version
        FROM mbox.reservation_performance_notification_authorizations grant_record
        WHERE grant_record.tenant_id=reservation.tenant_id
          AND grant_record.store_id=reservation.store_id
          AND grant_record.reservation_id=reservation.id
          AND grant_record.policy_id=policy.id
          AND grant_record.canonical_customer_id=mbox.canonical_customer_id(
            reservation.tenant_id,reservation.store_id,$3::uuid
          )
        ORDER BY grant_record.authorization_version DESC,grant_record.id DESC LIMIT 1
      ) latest ON true
      WHERE reservation.tenant_id=$1::uuid AND reservation.store_id=$2::uuid
        AND reservation.public_id=$4
        AND reservation.customer_id IS NOT NULL
        AND mbox.canonical_customer_id(
          reservation.tenant_id,reservation.store_id,reservation.customer_id
        )=mbox.canonical_customer_id(reservation.tenant_id,reservation.store_id,$3::uuid)
        AND reservation.preferred_schedule_id IS NOT NULL
        AND reservation.status IN ('pending','confirmed','arrived','seated')
      FOR KEY SHARE OF reservation,policy
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.customerId,
      input.reservationPublicId,
      input.policyId,
    ])
    const row = selected.rows[0]
    if (row === undefined) throw new ReservationPerformanceNotificationAuthorizationError(
      'RESERVATION_NOTIFICATION_RESERVATION_NOT_FOUND', '未找到本人可用的预约或提醒政策',
    )
    if (row.policy_version !== input.policyVersion || row.template_id !== input.templateId) {
      throw new ReservationPerformanceNotificationAuthorizationError(
        'RESERVATION_NOTIFICATION_POLICY_STALE', '提醒模板已经更新，请刷新后重新选择',
      )
    }
    if (row.identity_external_id === null) throw new ReservationPerformanceNotificationAuthorizationError(
      'RESERVATION_NOTIFICATION_IDENTITY_REQUIRED', '当前没有可验证的本人微信身份',
    )
    if (row.current_version !== input.expectedVersion) {
      throw new ReservationPerformanceNotificationAuthorizationError(
        'RESERVATION_NOTIFICATION_VERSION_CONFLICT', '提醒授权已经变化，请刷新后重试',
      )
    }
    const decision = input.platformResult === 'accept' ? 'granted'
      : input.platformResult === 'revoke' ? 'revoked' : 'denied'
    const inserted = await this.transaction.query<AuthorizationRow>(`
      INSERT INTO mbox.reservation_performance_notification_authorizations(
        tenant_id,store_id,reservation_id,canonical_customer_id,identity_external_id,
        policy_id,notification_type,authorization_context,policy_version,template_id,
        decision,platform_result,authorization_version,uses_allowed,source,
        platform_event_reference_hash,authorized_at
      ) VALUES(
        $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6::uuid,
        'reservation_performance_revised','reservation',$7,$8,$9,$10,$11,$12,$13,$14,
        COALESCE($15::timestamptz,clock_timestamp())
      )
      RETURNING id,reservation_id,$16::text AS reservation_public_id,
        canonical_customer_id,identity_external_id,policy_id,policy_version,template_id,
        decision,platform_result,authorization_version,
        uses_allowed AS uses_remaining,authorized_at::text
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      row.reservation_id,
      row.canonical_customer_id,
      row.identity_external_id,
      row.policy_id,
      row.policy_version,
      row.template_id,
      decision,
      input.platformResult,
      row.current_version + 1,
      decision === 'granted' ? 1 : 0,
      input.platformResult === 'revoke' ? 'customer_revoke' : 'wechat_client',
      createHash('sha256').update(input.platformEventReference).digest('hex'),
      input.authorizedAt ?? null,
      row.reservation_public_id,
    ])
    const authorization = inserted.rows[0]
    if (authorization === undefined) throw new Error('Reservation notification authorization was not recorded')
    return mapRecord(authorization)
  }
}

function mapOption(row: AuthorizationOptionRow): ReservationPerformanceNotificationAuthorizationOption {
  return {
    reservationPublicId: row.reservation_public_id,
    policyId: row.policy_id,
    policyVersion: Number(row.policy_version),
    templateId: row.template_id,
    decision: row.decision,
    platformResult: row.platform_result,
    authorizationVersion: Number(row.authorization_version ?? 0),
    usesRemaining: Number(row.uses_remaining ?? 0),
    changedAt: row.authorized_at,
  }
}

function mapRecord(row: AuthorizationRow): ReservationPerformanceNotificationAuthorizationRecord {
  return {
    id: row.id,
    reservationId: row.reservation_id,
    canonicalCustomerId: row.canonical_customer_id,
    identityExternalId: row.identity_external_id,
    ...mapOption(row),
  }
}

function validateInput(input: Readonly<{
  customerId: string
  reservationPublicId: string
  policyId: string
  policyVersion: number
  templateId: string
  expectedVersion: number
  platformResult: string
  platformEventReference: string
}>): void {
  requireUuid(input.customerId, 'customerId')
  requireUuid(input.policyId, 'policyId')
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/.test(input.reservationPublicId)) {
    throw new TypeError('reservationPublicId is invalid')
  }
  if (!Number.isSafeInteger(input.policyVersion) || input.policyVersion < 1) throw new TypeError('policyVersion is invalid')
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) throw new TypeError('expectedVersion is invalid')
  if (input.templateId.trim().length < 8 || input.templateId.length > 128) throw new TypeError('templateId is invalid')
  if (!['accept','reject','ban','revoke'].includes(input.platformResult)) throw new TypeError('platformResult is invalid')
  if (input.platformEventReference.trim().length < 8 || input.platformEventReference.length > 200) {
    throw new TypeError('platformEventReference is invalid')
  }
}

function requireUuid(value: string, label: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new TypeError(`${label} is invalid`)
  }
}
