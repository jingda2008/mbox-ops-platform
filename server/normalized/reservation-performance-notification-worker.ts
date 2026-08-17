import { createHash } from 'node:crypto'
import type { WechatMiniProgramNotificationRecipientResolver } from './wechat-loyalty-notification-worker.js'
import type { WechatTemplateMessageDelivery } from './wechat-subscription-message-adapter.js'
import type { ScopedPostgresTransactionRunner, ScopedTransaction, StoreScope } from './transaction-runner.js'

interface ClaimedReservationNotification extends Record<string, unknown> {
  id: string
  customer_id: string
  identity_external_id: string
  template_id: string
  page_path: string
  change_type_data_key: string
  performance_time_data_key: string
  reservation_time_data_key: string
  revision_kind: 'rescheduled' | 'cancelled' | 'replaced'
  resulting_starts_at: string | null
  reservation_arrival_at: string
}

export interface ReservationPerformanceNotificationBatch {
  workerId: string
  claimed: number
  accepted: string[]
  rejected: string[]
  unknown: string[]
  suppressed: number
}

export class ReservationPerformanceNotificationWorker {
  constructor(
    private readonly transactions: Pick<ScopedPostgresTransactionRunner, 'run'>,
    private readonly recipients: WechatMiniProgramNotificationRecipientResolver,
    private readonly delivery: WechatTemplateMessageDelivery,
  ) {}

  async runBatch(
    scope: Readonly<StoreScope>,
    workerId: string,
    batchSize = 50,
  ): Promise<ReservationPerformanceNotificationBatch> {
    validate(workerId, batchSize)
    await this.delivery.preflight?.()
    const claimed = await this.transactions.run(scope, (transaction) => claim(
      transaction, workerId, batchSize,
    ))
    const result: ReservationPerformanceNotificationBatch = {
      workerId,
      claimed: claimed.jobs.length,
      accepted: [],
      rejected: [],
      unknown: [],
      suppressed: claimed.suppressed,
    }
    for (const job of claimed.jobs) {
      let outcome: Awaited<ReturnType<WechatTemplateMessageDelivery['sendTemplate']>>
      try {
        const recipient = await this.recipients.resolveMiniProgramNotificationRecipient(
          job.customer_id,
          job.identity_external_id,
        )
        outcome = recipient === null
          ? { outcome: 'provider_rejected', providerReference: null, errorCode: 'recipient_unavailable' }
          : await this.delivery.sendTemplate({
              jobId: job.id,
              recipientOpenId: recipient.openId,
              templateId: job.template_id,
              pagePath: job.page_path,
              data: {
                [job.change_type_data_key]: revisionLabel(job.revision_kind),
                [job.performance_time_data_key]: job.resulting_starts_at === null
                  ? '原演出已取消' : providerTime(job.resulting_starts_at),
                [job.reservation_time_data_key]: providerTime(job.reservation_arrival_at),
              },
            })
      } catch {
        outcome = { outcome: 'unknown', providerReference: null, errorCode: 'delivery_outcome_unknown' }
      }
      await this.transactions.run(scope, (transaction) => recordOutcome(
        transaction, job.id, workerId, outcome,
      ))
      result[outcome.outcome === 'accepted' ? 'accepted'
        : outcome.outcome === 'provider_rejected' ? 'rejected' : 'unknown'].push(job.id)
    }
    return result
  }
}

async function claim(transaction: ScopedTransaction, workerId: string, batchSize: number) {
  const suppressed = await transaction.query(`
    UPDATE mbox.reservation_performance_notification_jobs job
    SET status='suppressed',failure_code=CASE
      WHEN EXISTS(
        SELECT 1 FROM mbox.reservation_performance_notification_authorization_uses used
        WHERE used.tenant_id=job.tenant_id AND used.store_id=job.store_id
          AND used.authorization_id=job.authorization_id
      ) THEN 'authorization_already_used' ELSE 'authorization_or_context_invalid' END,
      updated_at=clock_timestamp()
    WHERE job.tenant_id=$1::uuid AND job.store_id=$2::uuid
      AND job.status='pending'
      AND (
        EXISTS(
          SELECT 1 FROM mbox.reservation_performance_notification_authorization_uses used
          WHERE used.tenant_id=job.tenant_id AND used.store_id=job.store_id
            AND used.authorization_id=job.authorization_id
        )
        OR NOT EXISTS(
          SELECT 1
          FROM mbox.reservation_performance_notification_authorizations grant_record
          JOIN mbox.reservation_performance_notification_policies policy
            ON policy.tenant_id=grant_record.tenant_id AND policy.store_id=grant_record.store_id
           AND policy.id=grant_record.policy_id
          JOIN mbox.wechat_identities identity
            ON identity.tenant_id=grant_record.tenant_id AND identity.store_id=grant_record.store_id
           AND identity.external_identity_id=grant_record.identity_external_id
           AND identity.channel='mini_program' AND identity.revoked_at IS NULL
          JOIN mbox.customer_identities customer_identity
            ON customer_identity.tenant_id=identity.tenant_id
           AND customer_identity.store_id=identity.store_id
           AND customer_identity.identity_kind='wechat'
           AND customer_identity.identity_hash=encode(digest('wechat:'||identity.principal_id,'sha256'),'hex')
           AND customer_identity.status='active'
           AND mbox.canonical_customer_id(
             customer_identity.tenant_id,customer_identity.store_id,customer_identity.customer_id
           )=grant_record.canonical_customer_id
          WHERE grant_record.tenant_id=job.tenant_id AND grant_record.store_id=job.store_id
            AND grant_record.id=job.authorization_id AND grant_record.decision='granted'
            AND grant_record.reservation_id=job.reservation_id
            AND grant_record.canonical_customer_id=job.customer_id
            AND grant_record.authorization_context='reservation'
            AND grant_record.notification_type='reservation_performance_revised'
            AND grant_record.template_id=job.template_id
            AND policy.id=job.policy_id AND policy.status='published'
            AND policy.authorization_context='reservation'
            AND policy.notification_type='reservation_performance_revised'
            AND policy.template_id=job.template_id
            AND policy.effective_from<=clock_timestamp()
            AND (policy.effective_until IS NULL OR policy.effective_until>clock_timestamp())
            AND grant_record.id=(
              SELECT latest.id
              FROM mbox.reservation_performance_notification_authorizations latest
              WHERE latest.tenant_id=grant_record.tenant_id
                AND latest.store_id=grant_record.store_id
                AND latest.canonical_customer_id=grant_record.canonical_customer_id
                AND latest.reservation_id=grant_record.reservation_id
                AND latest.policy_id=grant_record.policy_id
              ORDER BY latest.authorization_version DESC,latest.id DESC LIMIT 1
            )
        )
      )
    RETURNING id
  `, [transaction.scope.tenantId, transaction.scope.storeId])
  const result = await transaction.query<ClaimedReservationNotification>(`
    WITH candidates AS MATERIALIZED (
      SELECT job.id,job.authorization_id
      FROM mbox.reservation_performance_notification_jobs job
      WHERE job.tenant_id=$1::uuid AND job.store_id=$2::uuid
        AND job.status='pending' AND job.scheduled_for<=clock_timestamp()
        AND NOT EXISTS(
          SELECT 1 FROM mbox.reservation_performance_notification_authorization_uses used
          WHERE used.tenant_id=job.tenant_id AND used.store_id=job.store_id
            AND used.authorization_id=job.authorization_id
        )
      ORDER BY job.scheduled_for,job.created_at,job.id
      FOR UPDATE SKIP LOCKED LIMIT $4
    ), consumed AS (
      INSERT INTO mbox.reservation_performance_notification_authorization_uses(
        tenant_id,store_id,authorization_id,notification_job_id
      ) SELECT $1::uuid,$2::uuid,candidate.authorization_id,candidate.id
        FROM candidates candidate ON CONFLICT DO NOTHING
      RETURNING notification_job_id
    ), changed AS (
      UPDATE mbox.reservation_performance_notification_jobs job
      SET status='sending',attempts=1,locked_by=$3,locked_at=clock_timestamp(),
        failure_code=NULL,updated_at=clock_timestamp()
      FROM consumed
      WHERE job.tenant_id=$1::uuid AND job.store_id=$2::uuid
        AND job.id=consumed.notification_job_id
      RETURNING job.*
    )
    SELECT changed.id,changed.customer_id,changed.identity_external_id,
      changed.template_id,policy.page_path,policy.change_type_data_key,
      policy.performance_time_data_key,policy.reservation_time_data_key,
      revision.revision_kind,revision.resulting_starts_at::text,
      reservation.arrival_at::text AS reservation_arrival_at
    FROM changed
    JOIN mbox.reservation_performance_notification_policies policy
      ON policy.tenant_id=changed.tenant_id AND policy.store_id=changed.store_id
     AND policy.id=changed.policy_id
    JOIN mbox.performance_schedule_revisions revision
      ON revision.tenant_id=changed.tenant_id AND revision.store_id=changed.store_id
     AND revision.id=changed.revision_id
    JOIN mbox.reservations reservation
      ON reservation.tenant_id=changed.tenant_id AND reservation.store_id=changed.store_id
     AND reservation.id=changed.reservation_id
    ORDER BY changed.scheduled_for,changed.created_at,changed.id
  `, [transaction.scope.tenantId, transaction.scope.storeId, workerId, batchSize])
  return { jobs: result.rows, suppressed: suppressed.rowCount ?? 0 }
}

async function recordOutcome(
  transaction: ScopedTransaction,
  jobId: string,
  workerId: string,
  result: Awaited<ReturnType<WechatTemplateMessageDelivery['sendTemplate']>>,
) {
  const errorCode = result.outcome === 'accepted' ? null : normalizeCode(result.errorCode)
  const referenceHash = result.providerReference === null ? null
    : createHash('sha256').update(result.providerReference).digest('hex')
  const inserted = await transaction.query(`
    INSERT INTO mbox.reservation_performance_notification_receipts(
      tenant_id,store_id,notification_job_id,outcome,provider_reference_hash,
      provider_error_code
    ) SELECT $1::uuid,$2::uuid,job.id,$4,$5,$6
      FROM mbox.reservation_performance_notification_jobs job
      WHERE job.tenant_id=$1::uuid AND job.store_id=$2::uuid
        AND job.id=$3::uuid AND job.status='sending' AND job.locked_by=$7
      ON CONFLICT (tenant_id,store_id,notification_job_id) DO NOTHING
      RETURNING id
  `, [
    transaction.scope.tenantId,
    transaction.scope.storeId,
    jobId,
    result.outcome,
    referenceHash,
    errorCode,
    workerId,
  ])
  if (inserted.rowCount !== 1) throw new Error('Reservation notification lease was lost before receipt')
  const status = result.outcome === 'accepted' ? 'sent'
    : result.outcome === 'provider_rejected' ? 'failed' : 'unknown'
  const updated = await transaction.query(`
    UPDATE mbox.reservation_performance_notification_jobs
    SET status=$4,failure_code=$5,
      sent_at=CASE WHEN $4='sent' THEN clock_timestamp() ELSE NULL END,
      locked_by=NULL,locked_at=NULL,updated_at=clock_timestamp()
    WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
      AND status='sending' AND locked_by=$6
  `, [
    transaction.scope.tenantId,
    transaction.scope.storeId,
    jobId,
    status,
    errorCode,
    workerId,
  ])
  if (updated.rowCount !== 1) throw new Error('Reservation notification lease was lost after receipt')
}

function revisionLabel(kind: ClaimedReservationNotification['revision_kind']): string {
  return kind === 'rescheduled' ? '演出改期' : kind === 'replaced' ? '演出换场' : '演出取消'
}

function providerTime(value: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) throw new TypeError('Reservation notification time is invalid')
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date)
  const field = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value
  return `${field('year')}-${field('month')}-${field('day')} ${field('hour')}:${field('minute')}`
}

function validate(workerId: string, batchSize: number) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{2,95}$/.test(workerId)) throw new TypeError('workerId is invalid')
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 100) throw new TypeError('batchSize is invalid')
}

function normalizeCode(value: string): string {
  const normalized = value.trim().toLowerCase()
  return /^[a-z][a-z0-9_.:-]{2,95}$/.test(normalized) ? normalized : 'provider_error_invalid'
}
