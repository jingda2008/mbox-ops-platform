import { createHash } from 'node:crypto'
import type { ScopedTransaction } from './transaction-runner.js'

export const WECHAT_MEMBER_SERVICE_NOTIFICATION_TYPES = Object.freeze([
  'activity_registration_confirmed',
  'member_benefit_issued',
  'membership_tier_changed',
] as const)

export type WechatMemberServiceNotificationType = (typeof WECHAT_MEMBER_SERVICE_NOTIFICATION_TYPES)[number]
export type WechatMemberServiceAuthorizationContext =
  | 'activity_registration' | 'member_benefit' | 'membership_tier'
export type WechatMemberServiceAuthorizationPurpose = 'member_service_update'

export interface WechatMemberServiceAuthorizationOption {
  policyId: string
  notificationType: WechatMemberServiceNotificationType
  purpose: WechatMemberServiceAuthorizationPurpose
  authorizationContext: WechatMemberServiceAuthorizationContext
  policyVersion: number
  templateId: string
  decision: 'granted' | 'denied' | 'revoked' | null
  platformResult: 'accept' | 'reject' | 'ban' | 'revoke' | null
  authorizationVersion: number
  usesRemaining: number
  changedAt: string | null
}

export interface WechatMemberServiceAuthorizationRecord extends WechatMemberServiceAuthorizationOption {
  id: string
  customerId: string
  membershipId: string
  identityExternalId: string
}

interface OptionRow extends Record<string, unknown> {
  policy_id: string
  notification_type: WechatMemberServiceNotificationType
  authorization_purpose: WechatMemberServiceAuthorizationPurpose
  authorization_context: WechatMemberServiceAuthorizationContext
  policy_version: number
  template_id: string
  decision: 'granted' | 'denied' | 'revoked' | null
  platform_result: 'accept' | 'reject' | 'ban' | 'revoke' | null
  authorization_version: number | null
  uses_remaining: number | null
  authorized_at: string | null
}
interface AuthorizationRow extends OptionRow {
  id: string
  customer_id: string
  membership_id: string
  identity_external_id: string
}

export class WechatMemberServiceAuthorizationError extends Error {
  constructor(
    readonly code:
      | 'WECHAT_MEMBER_SERVICE_NOTIFICATION_NOT_CONFIGURED'
      | 'WECHAT_MEMBER_SERVICE_NOTIFICATION_POLICY_STALE'
      | 'WECHAT_MEMBER_SERVICE_NOTIFICATION_MEMBERSHIP_REQUIRED'
      | 'WECHAT_MEMBER_SERVICE_NOTIFICATION_IDENTITY_REQUIRED'
      | 'WECHAT_MEMBER_SERVICE_NOTIFICATION_VERSION_CONFLICT',
    message: string,
  ) {
    super(message)
    this.name = 'WechatMemberServiceAuthorizationError'
  }
}

export class WechatMemberServiceNotificationRepository {
  constructor(private readonly transaction: ScopedTransaction) {}

  async authorizationOptions(customerId: string, channelConfigured: boolean): Promise<WechatMemberServiceAuthorizationOption[]> {
    uuid(customerId, 'customerId')
    if (!channelConfigured) return []
    const result = await this.transaction.query<OptionRow>(`
      SELECT policy.id AS policy_id,policy.notification_type,policy.authorization_purpose,
        policy.authorization_context,policy.policy_version,policy.template_id,
        latest.decision,latest.platform_result,latest.authorization_version,latest.authorized_at::text,
        CASE WHEN latest.decision='granted' AND NOT EXISTS(
          SELECT 1 FROM mbox.wechat_member_service_notification_authorization_uses used
          WHERE used.tenant_id=policy.tenant_id AND used.store_id=policy.store_id
            AND used.authorization_id=latest.id
        ) THEN 1 ELSE 0 END::integer AS uses_remaining
      FROM mbox.wechat_member_service_notification_policies policy
      JOIN mbox.customer_memberships membership
        ON membership.tenant_id=policy.tenant_id AND membership.store_id=policy.store_id
       AND membership.customer_id=$3::uuid AND membership.status='active'
      LEFT JOIN LATERAL (
        SELECT latest_auth.id,latest_auth.decision,latest_auth.platform_result,
          latest_auth.authorization_version,latest_auth.authorized_at
        FROM mbox.wechat_member_service_notification_authorizations latest_auth
        WHERE latest_auth.tenant_id=policy.tenant_id AND latest_auth.store_id=policy.store_id
          AND latest_auth.customer_id=membership.customer_id AND latest_auth.membership_id=membership.id
          AND latest_auth.policy_id=policy.id
        ORDER BY latest_auth.authorization_version DESC,latest_auth.id DESC LIMIT 1
      ) latest ON true
      WHERE policy.tenant_id=$1::uuid AND policy.store_id=$2::uuid
        AND policy.status='published' AND policy.effective_from<=clock_timestamp()
        AND (policy.effective_until IS NULL OR policy.effective_until>clock_timestamp())
      ORDER BY CASE policy.notification_type
        WHEN 'activity_registration_confirmed' THEN 1
        WHEN 'member_benefit_issued' THEN 2 ELSE 3 END
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, customerId])
    return result.rows.map(option)
  }

  async recordAuthorization(input: Readonly<{
    customerId: string
    notificationType: WechatMemberServiceNotificationType
    policyId: string
    policyVersion: number
    templateId: string
    expectedVersion: number
    platformResult: 'accept' | 'reject' | 'ban' | 'revoke'
    platformEventReference: string
    authorizedAt?: string
  }>): Promise<WechatMemberServiceAuthorizationRecord> {
    validate(input)
    await this.transaction.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `wechat-member-service-authorization:${this.transaction.scope.tenantId}:${this.transaction.scope.storeId}:${input.customerId}:${input.policyId}`,
    ])
    const selected = await this.transaction.query<{
      policy_id: string
      notification_type: WechatMemberServiceNotificationType
      authorization_purpose: WechatMemberServiceAuthorizationPurpose
      authorization_context: WechatMemberServiceAuthorizationContext
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
      FROM mbox.wechat_member_service_notification_policies policy
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
        WHERE wechat_identity.tenant_id=policy.tenant_id AND wechat_identity.store_id=policy.store_id
          AND wechat_identity.channel='mini_program' AND wechat_identity.revoked_at IS NULL
          AND (wechat_identity.member_id IS NULL OR wechat_identity.member_id=membership.id)
        ORDER BY wechat_identity.last_authenticated_at DESC,wechat_identity.id DESC LIMIT 1
      ) identity ON true
      LEFT JOIN LATERAL (
        SELECT latest_auth.authorization_version
        FROM mbox.wechat_member_service_notification_authorizations latest_auth
        WHERE latest_auth.tenant_id=policy.tenant_id AND latest_auth.store_id=policy.store_id
          AND latest_auth.customer_id=membership.customer_id AND latest_auth.membership_id=membership.id
          AND latest_auth.policy_id=policy.id
        ORDER BY latest_auth.authorization_version DESC,latest_auth.id DESC LIMIT 1
      ) latest ON true
      WHERE policy.tenant_id=$1::uuid AND policy.store_id=$2::uuid
        AND policy.id=$4::uuid AND policy.notification_type=$5
        AND policy.status='published' AND policy.effective_from<=clock_timestamp()
        AND (policy.effective_until IS NULL OR policy.effective_until>clock_timestamp())
      FOR KEY SHARE OF policy,membership
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, input.customerId, input.policyId, input.notificationType])
    const row = selected.rows[0]
    if (!row) throw new WechatMemberServiceAuthorizationError(
      'WECHAT_MEMBER_SERVICE_NOTIFICATION_MEMBERSHIP_REQUIRED','当前会员或通知策略不可用',
    )
    if (row.policy_version !== input.policyVersion || row.template_id !== input.templateId) {
      throw new WechatMemberServiceAuthorizationError(
        'WECHAT_MEMBER_SERVICE_NOTIFICATION_POLICY_STALE','通知模板已经更新，请刷新后重新授权',
      )
    }
    if (row.identity_external_id === null) throw new WechatMemberServiceAuthorizationError(
      'WECHAT_MEMBER_SERVICE_NOTIFICATION_IDENTITY_REQUIRED','当前顾客没有可验证的本人微信身份',
    )
    if (row.current_version !== input.expectedVersion) throw new WechatMemberServiceAuthorizationError(
      'WECHAT_MEMBER_SERVICE_NOTIFICATION_VERSION_CONFLICT','通知授权已变化，请刷新后重试',
    )
    const decision = input.platformResult === 'accept' ? 'granted'
      : input.platformResult === 'revoke' ? 'revoked' : 'denied'
    const inserted = await this.transaction.query<AuthorizationRow>(`
      INSERT INTO mbox.wechat_member_service_notification_authorizations(
        tenant_id,store_id,customer_id,membership_id,identity_external_id,policy_id,
        notification_type,authorization_purpose,authorization_context,policy_version,template_id,
        decision,platform_result,authorization_version,uses_allowed,source,
        platform_event_reference_hash,authorized_at
      ) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6::uuid,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
        COALESCE($18::timestamptz,clock_timestamp()))
      RETURNING id,customer_id,membership_id,identity_external_id,policy_id,notification_type,
        authorization_purpose,authorization_context,policy_version,template_id,decision,platform_result,
        authorization_version,uses_allowed AS uses_remaining,authorized_at::text
    `, [
      this.transaction.scope.tenantId,this.transaction.scope.storeId,input.customerId,row.membership_id,
      row.identity_external_id,row.policy_id,row.notification_type,row.authorization_purpose,
      row.authorization_context,row.policy_version,row.template_id,decision,input.platformResult,
      row.current_version+1,decision==='granted'?1:0,
      input.platformResult==='revoke'?'customer_revoke':'wechat_client',
      createHash('sha256').update(input.platformEventReference).digest('hex'),input.authorizedAt ?? null,
    ])
    const authorization = inserted.rows[0]
    if (!authorization) throw new Error('WeChat member-service authorization was not recorded')
    return record(authorization)
  }
}

function option(row: OptionRow): WechatMemberServiceAuthorizationOption {
  return {
    policyId: row.policy_id,notificationType: row.notification_type,purpose: row.authorization_purpose,
    authorizationContext: row.authorization_context,policyVersion: Number(row.policy_version),templateId: row.template_id,
    decision: row.decision,platformResult: row.platform_result,authorizationVersion: Number(row.authorization_version ?? 0),
    usesRemaining: Number(row.uses_remaining ?? 0),changedAt: row.authorized_at,
  }
}
function record(row: AuthorizationRow): WechatMemberServiceAuthorizationRecord {
  return { id:row.id,customerId:row.customer_id,membershipId:row.membership_id,identityExternalId:row.identity_external_id,...option(row) }
}
function validate(input: Readonly<{customerId:string;notificationType:WechatMemberServiceNotificationType;policyId:string;policyVersion:number;templateId:string;expectedVersion:number;platformResult:string;platformEventReference:string;authorizedAt?:string}>): void {
  uuid(input.customerId,'customerId');uuid(input.policyId,'policyId')
  if (!WECHAT_MEMBER_SERVICE_NOTIFICATION_TYPES.includes(input.notificationType)) throw new TypeError('notificationType is invalid')
  integer(input.policyVersion,'policyVersion',1);integer(input.expectedVersion,'expectedVersion',0)
  text(input.templateId,'templateId',8,128);text(input.platformEventReference,'platformEventReference',8,200)
  if (!['accept','reject','ban','revoke'].includes(input.platformResult)) throw new TypeError('platformResult is invalid')
  if (input.authorizedAt !== undefined && !Number.isFinite(Date.parse(input.authorizedAt))) throw new TypeError('authorizedAt is invalid')
}
function text(value: unknown,label:string,min:number,max:number): string {
  if (typeof value!=='string') throw new TypeError(`${label} is invalid`)
  const normalized=value.trim();if(normalized.length<min||normalized.length>max) throw new TypeError(`${label} is invalid`);return normalized
}
function uuid(value:unknown,label:string): string {
  const normalized=text(value,label,36,36)
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)) throw new TypeError(`${label} is invalid`)
  return normalized
}
function integer(value:unknown,label:string,min:number): number {
  if(!Number.isSafeInteger(value)||(value as number)<min||(value as number)>2_000_000_000) throw new TypeError(`${label} is invalid`)
  return value as number
}
