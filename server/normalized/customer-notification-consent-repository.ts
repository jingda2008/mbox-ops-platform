import type { JsonObject } from './command-executor.js'
import type { ScopedTransaction } from './transaction-runner.js'

export type CustomerNotificationChannel = 'wechat' | 'sms'
export type CustomerNotificationPurpose = 'transactional_service'
export const CUSTOMER_NOTIFICATION_PURPOSE: CustomerNotificationPurpose = 'transactional_service'
export type CustomerNotificationConsentDecision = 'granted' | 'denied' | 'revoked'
export type CustomerNotificationConsentSource =
  | 'legacy_migration'
  | 'customer_self_service'
  | 'wechat_authorization'
  | 'reservation'
  | 'member_portal'
  | 'staff_record'
  | 'import'

export interface CustomerNotificationConsent {
  id: string
  customerId: string
  channel: CustomerNotificationChannel
  purpose: CustomerNotificationPurpose
  decision: CustomerNotificationConsentDecision
  consentVersion: number
  policyVersion: string
  source: CustomerNotificationConsentSource
  sourceReference: string | null
  templateId: string | null
  authorizationContext: 'loyalty_accrual' | 'reservation' | 'activity' | 'service' | null
  platformResult: 'accept' | 'reject' | 'ban' | null
  platformEventReference: string | null
  actorType: 'customer' | 'employee' | 'integration' | 'system'
  actorRef: string | null
  occurredAt: string
}

interface ConsentRow extends Record<string, unknown> {
  id: string
  customer_id: string
  channel: CustomerNotificationChannel
  purpose: CustomerNotificationPurpose
  decision: CustomerNotificationConsentDecision
  consent_version: number
  policy_version: string
  source: CustomerNotificationConsentSource
  source_reference: string | null
  template_id: string | null
  authorization_context: CustomerNotificationConsent['authorizationContext']
  platform_result: CustomerNotificationConsent['platformResult']
  platform_event_reference: string | null
  actor_type: CustomerNotificationConsent['actorType']
  actor_ref: string | null
  occurred_at: string
}

export class CustomerNotificationConsentRepository {
  constructor(private readonly transaction: ScopedTransaction) {}

  async current(
    customerId: string,
    channel: CustomerNotificationChannel,
    purpose: CustomerNotificationPurpose = CUSTOMER_NOTIFICATION_PURPOSE,
  ): Promise<CustomerNotificationConsent | null> {
    validateCustomerId(customerId)
    validateChannel(channel)
    const result = await this.transaction.query<ConsentRow>(`
      SELECT id, customer_id, channel, purpose, decision, consent_version, policy_version,
        source, source_reference, template_id, authorization_context, platform_result,
        platform_event_reference, actor_type, actor_ref, occurred_at::text
      FROM mbox.customer_notification_consents
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid
        AND customer_id = $3::uuid AND channel = $4 AND purpose = $5
      ORDER BY consent_version DESC, id DESC
      LIMIT 1
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, customerId, channel, purpose])
    return result.rows[0] === undefined ? null : mapConsent(result.rows[0])
  }

  async isGranted(
    customerId: string,
    channel: CustomerNotificationChannel,
    purpose: CustomerNotificationPurpose = CUSTOMER_NOTIFICATION_PURPOSE,
  ): Promise<boolean> {
    return (await this.current(customerId, channel, purpose))?.decision === 'granted'
  }

  async record(input: Readonly<{
    customerId: string
    channel: CustomerNotificationChannel
    purpose: CustomerNotificationPurpose
    decision: CustomerNotificationConsentDecision
    expectedVersion: number
    policyVersion: string
    source: CustomerNotificationConsentSource
    sourceReference?: string | null
    templateId?: string | null
    authorizationContext?: CustomerNotificationConsent['authorizationContext']
    platformResult?: CustomerNotificationConsent['platformResult']
    platformEventReference?: string | null
    actorType: CustomerNotificationConsent['actorType']
    actorRef?: string | null
    evidenceSnapshot?: JsonObject
    occurredAt?: string
  }>): Promise<CustomerNotificationConsent> {
    validateRecord(input)
    await this.transaction.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
      `customer-notification-consent:${this.transaction.scope.tenantId}:${this.transaction.scope.storeId}:${input.customerId}:${input.channel}:${input.purpose}`,
    ])
    const current = await this.current(input.customerId, input.channel, input.purpose)
    const currentVersion = current?.consentVersion ?? 0
    if (currentVersion !== input.expectedVersion) {
      throw new CustomerNotificationConsentConflictError(currentVersion)
    }
    const inserted = await this.transaction.query<ConsentRow>(`
      INSERT INTO mbox.customer_notification_consents (
        tenant_id, store_id, customer_id, channel, purpose, decision, consent_version,
        policy_version, source, source_reference, template_id, authorization_context,
        platform_result, platform_event_reference, actor_type, actor_ref, evidence_snapshot, occurred_at
      ) VALUES (
        $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11, $12,
        $13, $14, $15, $16, $17::jsonb, COALESCE($18::timestamptz, clock_timestamp())
      )
      RETURNING id, customer_id, channel, purpose, decision, consent_version, policy_version,
        source, source_reference, template_id, authorization_context, platform_result,
        platform_event_reference, actor_type, actor_ref, occurred_at::text
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.customerId,
      input.channel,
      input.purpose,
      input.decision,
      currentVersion + 1,
      input.policyVersion.trim(),
      input.source,
      input.sourceReference?.trim() || null,
      input.templateId?.trim() || null,
      input.authorizationContext ?? null,
      input.platformResult ?? null,
      input.platformEventReference?.trim() || null,
      input.actorType,
      input.actorRef?.trim() || null,
      JSON.stringify(input.evidenceSnapshot ?? {}),
      input.occurredAt ?? null,
    ])
    const row = inserted.rows[0]
    if (inserted.rowCount !== 1 || row === undefined) throw new Error('Customer notification consent was not recorded')
    return mapConsent(row)
  }
}

export class CustomerNotificationConsentConflictError extends Error {
  constructor(readonly currentVersion: number) {
    super('Customer notification consent changed; refresh before retrying')
    this.name = 'CustomerNotificationConsentConflictError'
  }
}

function mapConsent(row: ConsentRow): CustomerNotificationConsent {
  return {
    id: row.id,
    customerId: row.customer_id,
    channel: row.channel,
    purpose: row.purpose,
    decision: row.decision,
    consentVersion: Number(row.consent_version),
    policyVersion: row.policy_version,
    source: row.source,
    sourceReference: row.source_reference,
    templateId: row.template_id,
    authorizationContext: row.authorization_context,
    platformResult: row.platform_result,
    platformEventReference: row.platform_event_reference,
    actorType: row.actor_type,
    actorRef: row.actor_ref,
    occurredAt: row.occurred_at,
  }
}

function validateRecord(input: Readonly<{
  customerId: string
  channel: CustomerNotificationChannel
  purpose: CustomerNotificationPurpose
  decision: CustomerNotificationConsentDecision
  expectedVersion: number
  policyVersion: string
  source: CustomerNotificationConsentSource
  templateId?: string | null
  authorizationContext?: CustomerNotificationConsent['authorizationContext']
  platformResult?: CustomerNotificationConsent['platformResult']
  platformEventReference?: string | null
  actorType: CustomerNotificationConsent['actorType']
  occurredAt?: string
}>): void {
  validateCustomerId(input.customerId)
  validateChannel(input.channel)
  if (input.purpose !== CUSTOMER_NOTIFICATION_PURPOSE) throw new TypeError('notification consent purpose is invalid')
  if (!['granted', 'denied', 'revoked'].includes(input.decision)) throw new TypeError('consent decision is invalid')
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) throw new TypeError('expectedVersion is invalid')
  if (input.policyVersion.trim().length < 1 || input.policyVersion.length > 64) throw new TypeError('policyVersion is invalid')
  if (![
    'legacy_migration', 'customer_self_service', 'wechat_authorization',
    'reservation', 'member_portal', 'staff_record', 'import',
  ].includes(input.source)) throw new TypeError('consent source is invalid')
  if (!['customer', 'employee', 'integration', 'system'].includes(input.actorType)) throw new TypeError('consent actor type is invalid')
  if (input.source === 'wechat_authorization') {
    if (input.channel !== 'wechat'
      || typeof input.templateId !== 'string' || input.templateId.trim().length < 8
      || !['loyalty_accrual', 'reservation', 'activity', 'service'].includes(input.authorizationContext ?? '')
      || !['accept', 'reject', 'ban'].includes(input.platformResult ?? '')
      || typeof input.platformEventReference !== 'string' || input.platformEventReference.trim().length < 8
      || (input.platformResult === 'accept' ? input.decision !== 'granted' : input.decision !== 'denied')) {
      throw new TypeError('WeChat authorization evidence is invalid')
    }
  }
  if (input.occurredAt !== undefined && !Number.isFinite(Date.parse(input.occurredAt))) throw new TypeError('occurredAt is invalid')
}

function validateCustomerId(value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new TypeError('customerId is invalid')
  }
}

function validateChannel(value: string): asserts value is CustomerNotificationChannel {
  if (value !== 'wechat' && value !== 'sms') throw new TypeError('notification consent channel is invalid')
}
