import { createHash } from 'node:crypto'
import {
  wechatNotificationValueSources,
  type WechatNotificationFieldMapping,
  type WechatNotificationValueSource,
} from '../../src/shared/wechat-loyalty-subscription-templates.js'
import type { ScopedPostgresTransactionRunner, ScopedTransaction, StoreScope } from './transaction-runner.js'
import { WechatLoyaltyNotificationRepository, type WechatLoyaltyNotificationType } from './wechat-loyalty-notification-repository.js'
import { LoyaltyOperationalControlRepository } from './loyalty-operational-control-repository.js'

export interface WechatMiniProgramNotificationRecipientResolver {
  resolveMiniProgramNotificationRecipient(
    customerId: string,
    identityExternalId: string,
  ): Promise<{ identityExternalId: string; openId: string } | null>
}

export interface WechatSubscriptionDeliveryRequest {
  jobId: string
  recipientOpenId: string
  notificationType: WechatLoyaltyNotificationType
  templateId: string
  pagePath: string
  pointsDataKey: string
  balanceDataKey: string | null
  occurredAtDataKey: string
  expiresAtDataKey: string | null
  pointsChange: number
  pointsAtRisk: number
  balanceAfter: number | null
  eventOccurredAt: string
  expiresAt: string | null
  fieldMappings?: readonly WechatNotificationFieldMapping[]
  storeName?: string | null
  accountDisplayName?: string | null
  memberNo?: string | null
  lastMonthConsumedPoints?: number | null
  monthExpiringPoints?: number | null
  accountPointsBalance?: number | null
  storeTimeZone?: string | null
}

export type WechatSubscriptionDeliveryResult =
  | { outcome: 'accepted'; providerReference: string | null }
  | { outcome: 'provider_rejected'; providerReference: string | null; errorCode: string }
  | { outcome: 'unknown'; providerReference: string | null; errorCode: string }

export interface WechatSubscriptionMessageDelivery {
  preflight?(): Promise<void>
  send(request: Readonly<WechatSubscriptionDeliveryRequest>): Promise<WechatSubscriptionDeliveryResult>
}

interface ClaimedRow extends Record<string, unknown> {
  id: string
  customer_id: string
  identity_external_id: string
  notification_type: WechatLoyaltyNotificationType
  template_id: string
  page_path: string
  points_data_key: string
  balance_data_key: string | null
  occurred_at_data_key: string
  expires_at_data_key: string | null
  policy_id?: string
  points_change: number
  points_at_risk: number
  balance_after: number | null
  event_occurred_at: string
  expires_at: string | null
  store_name?: string | null
  store_timezone?: string | null
  account_display_name?: string | null
  member_no?: string | null
  account_available_points?: number | null
  last_month_consumed_points?: number | null
  month_expiring_points?: number | null
  fieldMappings?: readonly WechatNotificationFieldMapping[]
}

export interface WechatLoyaltyNotificationBatch {
  workerId: string
  paused: boolean
  expiryJobsCreated: number
  claimed: number
  accepted: string[]
  rejected: string[]
  unknown: string[]
}

export class WechatLoyaltyNotificationWorker {
  constructor(
    private readonly transactions: Pick<ScopedPostgresTransactionRunner, 'run'>,
    private readonly recipients: WechatMiniProgramNotificationRecipientResolver,
    private readonly delivery: WechatSubscriptionMessageDelivery,
  ) {}

  async runBatch(
    scope: Readonly<StoreScope>,
    workerId: string,
    batchSize = 50,
  ): Promise<WechatLoyaltyNotificationBatch> {
    validateWorker(workerId, batchSize)
    const initiallyPaused = await this.transactions.run(scope, async (transaction) => (
      (await new LoyaltyOperationalControlRepository(transaction).state('wechat_notification')).state==='paused'
    ), { readOnly: true })
    if (initiallyPaused) return {
      workerId,paused:true,expiryJobsCreated:0,claimed:0,accepted:[],rejected:[],unknown:[],
    }
    const expiryJobsCreated = await this.transactions.run(scope, (transaction) => (
      new WechatLoyaltyNotificationRepository(transaction).enqueueExpiringLots(batchSize)
    ))
    // Missing/invalid formal provider configuration must fail before a one-use
    // authorization is consumed or a job is leased.
    await this.delivery.preflight?.()
    const claimResult = await this.transactions.run(scope, (transaction) => claim(transaction, workerId, batchSize))
    const claimed = claimResult.jobs
    const result: WechatLoyaltyNotificationBatch = {
      workerId,
      paused: claimResult.paused,
      expiryJobsCreated,
      claimed: claimed.length,
      accepted: [],
      rejected: [],
      unknown: [],
    }
    for (const job of claimed) {
      let deliveryResult: WechatSubscriptionDeliveryResult
      try {
        const recipient = await this.recipients.resolveMiniProgramNotificationRecipient(
          job.customer_id,
          job.identity_external_id,
        )
        deliveryResult = recipient === null
          ? { outcome: 'provider_rejected', providerReference: null, errorCode: 'recipient_unavailable' }
          : await this.delivery.send(toDeliveryRequest(job, recipient.openId))
      } catch {
        // Once a provider request might have left the process, retrying a one-use
        // subscription authorization can duplicate a message. Unknown is terminal.
        deliveryResult = { outcome: 'unknown', providerReference: null, errorCode: 'delivery_outcome_unknown' }
      }
      await this.transactions.run(scope, (transaction) => recordOutcome(
        transaction,
        job.id,
        workerId,
        deliveryResult,
      ))
      result[deliveryResult.outcome === 'accepted' ? 'accepted'
        : deliveryResult.outcome === 'provider_rejected' ? 'rejected' : 'unknown'].push(job.id)
    }
    return result
  }
}

async function claim(
  transaction: ScopedTransaction,
  workerId: string,
  batchSize: number,
): Promise<{ jobs: ClaimedRow[]; paused: boolean }> {
  const control = await new LoyaltyOperationalControlRepository(transaction).state('wechat_notification', true)
  if (control.state==='paused') return { jobs: [], paused: true }
  await transaction.query(`
    UPDATE mbox.wechat_customer_notification_jobs job
    SET status='suppressed',failure_code=CASE
      WHEN EXISTS(
        SELECT 1 FROM mbox.wechat_notification_authorization_uses used
        WHERE used.tenant_id=job.tenant_id AND used.store_id=job.store_id
          AND used.authorization_id=job.authorization_id
      ) THEN 'authorization_already_used'
      ELSE 'authorization_or_scope_invalid' END,
      updated_at=clock_timestamp()
    WHERE job.tenant_id=$1::uuid AND job.store_id=$2::uuid
      AND job.status IN ('pending','failed')
      AND (
        EXISTS(
          SELECT 1 FROM mbox.wechat_notification_authorization_uses used
          WHERE used.tenant_id=job.tenant_id AND used.store_id=job.store_id
            AND used.authorization_id=job.authorization_id
        )
        OR NOT EXISTS(
          SELECT 1
          FROM mbox.wechat_notification_authorizations active_auth
          JOIN mbox.wechat_notification_policies policy
            ON policy.tenant_id=active_auth.tenant_id AND policy.store_id=active_auth.store_id
           AND policy.id=active_auth.policy_id
          JOIN mbox.customer_memberships membership
            ON membership.tenant_id=active_auth.tenant_id AND membership.store_id=active_auth.store_id
           AND membership.id=active_auth.membership_id
           AND membership.customer_id=active_auth.customer_id AND membership.status='active'
          JOIN mbox.wechat_identities identity
            ON identity.tenant_id=active_auth.tenant_id AND identity.store_id=active_auth.store_id
           AND identity.external_identity_id=active_auth.identity_external_id
           AND identity.channel='mini_program' AND identity.revoked_at IS NULL
          JOIN mbox.customer_identities customer_identity
            ON customer_identity.tenant_id=identity.tenant_id
           AND customer_identity.store_id=identity.store_id
           AND customer_identity.identity_kind='wechat'
           AND customer_identity.identity_hash=encode(sha256(convert_to('wechat:'||identity.principal_id,'UTF8')),'hex')
           AND customer_identity.status='active'
           AND customer_identity.customer_id=active_auth.customer_id
          WHERE active_auth.tenant_id=job.tenant_id AND active_auth.store_id=job.store_id
            AND active_auth.id=job.authorization_id AND active_auth.decision='granted'
            AND policy.id=job.policy_id AND policy.status='published'
            AND policy.effective_from<=clock_timestamp()
            AND (policy.effective_until IS NULL OR policy.effective_until>clock_timestamp())
            AND active_auth.id=(
              SELECT latest.id FROM mbox.wechat_notification_authorizations latest
              WHERE latest.tenant_id=active_auth.tenant_id
                AND latest.store_id=active_auth.store_id
                AND latest.customer_id=active_auth.customer_id
                AND latest.policy_id=active_auth.policy_id
              ORDER BY latest.authorization_version DESC,latest.id DESC LIMIT 1
            )
        )
      )
  `, [transaction.scope.tenantId, transaction.scope.storeId])

  await transaction.query(`
    WITH rate_clock AS (
      SELECT job.id,
        GREATEST(
          job.scheduled_for,
          COALESCE(MAX(sent.sent_at)+make_interval(mins=>policy.minimum_interval_minutes),job.scheduled_for),
          CASE WHEN COUNT(sent.id)>=policy.max_per_customer_per_24h
            THEN COALESCE(MIN(sent.sent_at)+interval '24 hours',job.scheduled_for)
            ELSE job.scheduled_for END
        ) AS next_scheduled_for
      FROM mbox.wechat_customer_notification_jobs job
      JOIN mbox.wechat_notification_policies policy
        ON policy.tenant_id=job.tenant_id AND policy.store_id=job.store_id AND policy.id=job.policy_id
      LEFT JOIN mbox.wechat_customer_notification_jobs sent
        ON sent.tenant_id=job.tenant_id AND sent.store_id=job.store_id
       AND sent.customer_id=job.customer_id AND sent.policy_id=job.policy_id
       AND sent.status='sent' AND sent.sent_at>clock_timestamp()-interval '24 hours'
      WHERE job.tenant_id=$1::uuid AND job.store_id=$2::uuid
        AND job.status IN ('pending','failed')
      GROUP BY job.id,job.scheduled_for,policy.minimum_interval_minutes,
        policy.max_per_customer_per_24h
    )
    UPDATE mbox.wechat_customer_notification_jobs job
    SET scheduled_for=rate_clock.next_scheduled_for,updated_at=clock_timestamp()
    FROM rate_clock
    WHERE job.tenant_id=$1::uuid AND job.store_id=$2::uuid
      AND job.id=rate_clock.id AND rate_clock.next_scheduled_for>job.scheduled_for
  `, [transaction.scope.tenantId, transaction.scope.storeId])

  const claimed = await transaction.query<ClaimedRow>(`
    WITH candidates AS MATERIALIZED (
      SELECT job.id,job.authorization_id
      FROM mbox.wechat_customer_notification_jobs job
      WHERE job.tenant_id=$1::uuid AND job.store_id=$2::uuid
        AND job.status IN ('pending','failed') AND job.attempts<job.max_attempts
        AND job.scheduled_for<=clock_timestamp()
        AND NOT EXISTS(
          SELECT 1 FROM mbox.wechat_notification_authorization_uses used
          WHERE used.tenant_id=job.tenant_id AND used.store_id=job.store_id
            AND used.authorization_id=job.authorization_id
        )
      ORDER BY job.scheduled_for,job.created_at,job.id
      FOR UPDATE SKIP LOCKED LIMIT $4
    ), consumed AS (
      INSERT INTO mbox.wechat_notification_authorization_uses(
        tenant_id,store_id,authorization_id,notification_job_id
      )
      SELECT $1::uuid,$2::uuid,candidate.authorization_id,candidate.id FROM candidates candidate
      ON CONFLICT DO NOTHING
      RETURNING notification_job_id
    ), changed AS (
      UPDATE mbox.wechat_customer_notification_jobs job
      SET status='sending',attempts=job.attempts+1,locked_by=$3,
        locked_at=clock_timestamp(),failure_code=NULL,updated_at=clock_timestamp()
      FROM consumed
      WHERE job.tenant_id=$1::uuid AND job.store_id=$2::uuid
        AND job.id=consumed.notification_job_id
      RETURNING job.*
    )
    SELECT changed.id,changed.customer_id,changed.policy_id,changed.identity_external_id,
      changed.notification_type,changed.template_id,policy.page_path,
      policy.points_data_key,policy.balance_data_key,policy.occurred_at_data_key,
      policy.expires_at_data_key,changed.points_change,changed.points_at_risk,
      changed.balance_after,changed.event_occurred_at::text,changed.expires_at::text,
      store.name AS store_name,COALESCE(store.timezone,'Asia/Shanghai') AS store_timezone,
      profile.display_name AS account_display_name,membership.member_no,
      account.available_points AS account_available_points,
      COALESCE(consumed.points,0) AS last_month_consumed_points,
      COALESCE(expiring.points,0) AS month_expiring_points
    FROM changed
    JOIN mbox.wechat_notification_policies policy
      ON policy.tenant_id=changed.tenant_id AND policy.store_id=changed.store_id
     AND policy.id=changed.policy_id
    LEFT JOIN mbox.stores store
      ON store.tenant_id=changed.tenant_id AND store.id=changed.store_id
    LEFT JOIN mbox.customer_memberships membership
      ON membership.tenant_id=changed.tenant_id AND membership.store_id=changed.store_id
     AND membership.id=changed.membership_id AND membership.customer_id=changed.customer_id
    LEFT JOIN mbox.customer_profiles profile
      ON profile.tenant_id=changed.tenant_id AND profile.store_id=changed.store_id
     AND profile.customer_id=changed.customer_id
    LEFT JOIN mbox.loyalty_accounts account
      ON account.tenant_id=changed.tenant_id AND account.store_id=changed.store_id
     AND account.customer_id=changed.customer_id
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(-ledger.points_delta),0)::integer AS points
      FROM mbox.loyalty_point_ledger ledger
      WHERE ledger.tenant_id=changed.tenant_id AND ledger.store_id=changed.store_id
        AND ledger.customer_id=changed.customer_id
        AND ledger.entry_type='redeem' AND ledger.points_delta<0
        AND ledger.occurred_at >= (
          date_trunc('month', clock_timestamp() AT TIME ZONE COALESCE(store.timezone,'Asia/Shanghai'))
          - interval '1 month'
        ) AT TIME ZONE COALESCE(store.timezone,'Asia/Shanghai')
        AND ledger.occurred_at < date_trunc(
          'month', clock_timestamp() AT TIME ZONE COALESCE(store.timezone,'Asia/Shanghai')
        ) AT TIME ZONE COALESCE(store.timezone,'Asia/Shanghai')
    ) consumed ON true
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(lot.remaining_points),0)::integer AS points
      FROM mbox.loyalty_point_lots lot
      WHERE lot.tenant_id=changed.tenant_id AND lot.store_id=changed.store_id
        AND lot.customer_id=changed.customer_id AND lot.status='available'
        AND lot.remaining_points>0 AND lot.expires_at IS NOT NULL
        AND lot.expires_at >= date_trunc(
          'month', clock_timestamp() AT TIME ZONE COALESCE(store.timezone,'Asia/Shanghai')
        ) AT TIME ZONE COALESCE(store.timezone,'Asia/Shanghai')
        AND lot.expires_at < (
          date_trunc('month', clock_timestamp() AT TIME ZONE COALESCE(store.timezone,'Asia/Shanghai'))
          + interval '1 month'
        ) AT TIME ZONE COALESCE(store.timezone,'Asia/Shanghai')
    ) expiring ON true
    ORDER BY changed.scheduled_for,changed.created_at,changed.id
  `, [transaction.scope.tenantId, transaction.scope.storeId, workerId, batchSize])
  const policyIds = [...new Set(claimed.rows.flatMap((row) => (
    typeof row.policy_id === 'string' && row.policy_id ? [row.policy_id] : []
  )))]
  const mappings = new Map<string, WechatNotificationFieldMapping[]>()
  if (policyIds.length > 0) {
    const fields = await transaction.query<{ policy_id: string; data_key: string; value_source: string }>(`
      SELECT policy_id,data_key,value_source
      FROM mbox.wechat_notification_policy_fields
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND policy_id=ANY($3::uuid[])
      ORDER BY policy_id,sort_order,data_key
    `, [transaction.scope.tenantId, transaction.scope.storeId, policyIds])
    for (const field of fields.rows) {
      if (!isValueSource(field.value_source)) continue
      const list = mappings.get(field.policy_id) ?? []
      list.push({ dataKey: field.data_key, valueSource: field.value_source })
      mappings.set(field.policy_id, list)
    }
  }
  return {
    jobs: claimed.rows.map((row) => ({
      ...row,
      fieldMappings: typeof row.policy_id === 'string' ? mappings.get(row.policy_id) ?? [] : [],
    })),
    paused: false,
  }
}

async function recordOutcome(
  transaction: ScopedTransaction,
  jobId: string,
  workerId: string,
  result: WechatSubscriptionDeliveryResult,
): Promise<void> {
  const outcome = result.outcome
  const providerReferenceHash = result.providerReference === null ? null
    : createHash('sha256').update(result.providerReference).digest('hex')
  const errorCode = outcome === 'accepted' ? null : normalizeCode(result.errorCode)
  const inserted = await transaction.query(`
    INSERT INTO mbox.wechat_notification_receipts(
      tenant_id,store_id,notification_job_id,outcome,provider_reference_hash,
      provider_error_code,occurred_at
    )
    SELECT $1::uuid,$2::uuid,job.id,$4,$5,$6,clock_timestamp()
    FROM mbox.wechat_customer_notification_jobs job
    WHERE job.tenant_id=$1::uuid AND job.store_id=$2::uuid
      AND job.id=$3::uuid AND job.status='sending' AND job.locked_by=$7
    ON CONFLICT (tenant_id,store_id,notification_job_id) DO NOTHING
    RETURNING notification_job_id
  `, [
    transaction.scope.tenantId,
    transaction.scope.storeId,
    jobId,
    outcome,
    providerReferenceHash,
    errorCode,
    workerId,
  ])
  if (inserted.rowCount !== 1) throw new Error('WeChat notification job lease was lost before receipt')
  const updated = await transaction.query(`
    UPDATE mbox.wechat_customer_notification_jobs
    SET status=$4,failure_code=$5,sent_at=CASE WHEN $4='sent' THEN clock_timestamp() ELSE NULL END,
      locked_by=NULL,locked_at=NULL,updated_at=clock_timestamp()
    WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
      AND status='sending' AND locked_by=$6
  `, [
    transaction.scope.tenantId,
    transaction.scope.storeId,
    jobId,
    outcome === 'accepted' ? 'sent' : 'failed',
    errorCode,
    workerId,
  ])
  if (updated.rowCount !== 1) throw new Error('WeChat notification job lease was lost after receipt')
}

function toDeliveryRequest(row: ClaimedRow, openId: string): WechatSubscriptionDeliveryRequest {
  return {
    jobId: row.id,
    recipientOpenId: openId,
    notificationType: row.notification_type,
    templateId: row.template_id,
    pagePath: row.page_path,
    pointsDataKey: row.points_data_key,
    balanceDataKey: row.balance_data_key,
    occurredAtDataKey: row.occurred_at_data_key,
    expiresAtDataKey: row.expires_at_data_key,
    pointsChange: Number(row.points_change),
    pointsAtRisk: Number(row.points_at_risk),
    balanceAfter: row.balance_after === null ? null : Number(row.balance_after),
    eventOccurredAt: row.event_occurred_at,
    expiresAt: row.expires_at,
    ...(row.fieldMappings && row.fieldMappings.length > 0 ? {
      fieldMappings: row.fieldMappings,
      storeName: textOrEmpty(row.store_name),
      accountDisplayName: row.account_display_name ?? null,
      memberNo: row.member_no ?? null,
      lastMonthConsumedPoints: nonNegativeInteger(row.last_month_consumed_points),
      monthExpiringPoints: nonNegativeInteger(row.month_expiring_points),
      accountPointsBalance: row.account_available_points === null || row.account_available_points === undefined
        ? null
        : nonNegativeInteger(row.account_available_points),
      storeTimeZone: textOrEmpty(row.store_timezone) || 'Asia/Shanghai',
    } : {}),
  }
}

function isValueSource(value: string): value is WechatNotificationValueSource {
  return (wechatNotificationValueSources as readonly string[]).includes(value)
}

function textOrEmpty(value: string | null | undefined): string {
  return typeof value === 'string' ? value : ''
}

function nonNegativeInteger(value: number | string | null | undefined): number {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0
}

function validateWorker(workerId: string, batchSize: number): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{2,95}$/.test(workerId)) throw new TypeError('workerId is invalid')
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 100) throw new TypeError('batchSize is invalid')
}

function normalizeCode(value: string): string {
  const normalized = value.trim().toLowerCase()
  return /^[a-z][a-z0-9_.:-]{2,95}$/.test(normalized) ? normalized : 'provider_error_invalid'
}
