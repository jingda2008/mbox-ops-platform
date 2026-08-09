import { randomUUID } from 'node:crypto'
import type { RuntimeState } from '../src/shared/contracts.js'
import type { SopActionRecord, SopActionRecordType } from '../src/shared/sop-contracts.js'
import type { RuntimeRepository } from './repository.js'
import { PostgresOptimisticConcurrencyError } from './postgres-repository.js'

export interface SopActionDispatchRequest {
  id: string
  type: Extract<SopActionRecordType, 'headset_notification' | 'wecom_notification' | 'camera_snapshot'>
  tableId: string
  tableSessionId: string
  taskId: string
  recipientEmployeeIds: string[]
  content: string
  idempotencyKey: string
}

export type SopActionDispatchResult =
  | { outcome: 'completed'; providerReference: string; evidenceReference?: string }
  | { outcome: 'rejected'; reason: string; providerReference?: string; evidenceReference?: string }
  | { outcome: 'retryable_failure'; reason: string }
  | { outcome: 'permanent_failure'; reason: string }

export interface SopActionAdapter {
  readonly type: SopActionDispatchRequest['type']
  dispatch(request: SopActionDispatchRequest): Promise<SopActionDispatchResult>
}

interface SopActionClaim {
  recordId: string
  workerId: string
  attemptNumber: number
  request: SopActionDispatchRequest
}

const dispatchableTypes = new Set<SopActionRecordType>(['headset_notification', 'wecom_notification', 'camera_snapshot'])

function hasDueActions(state: RuntimeState, now: Date) {
  const dueAt = now.toISOString()
  return (state.sopActionRecords ?? []).some((record) => (
    record.status === 'queued'
    && dispatchableTypes.has(record.type)
    && (record.nextAttemptAt ?? record.requestedAt) <= dueAt
    && (!record.leaseExpiresAt || record.leaseExpiresAt <= dueAt)
  ))
}

function appendAudit(state: RuntimeState, record: SopActionRecord, action: string, now: Date, details: Record<string, unknown>) {
  state.auditEntries.push({
    id: `audit_${randomUUID()}`,
    actorId: 'system-sop-action-dispatcher',
    action,
    objectType: 'sop_action_record',
    objectId: record.id,
    occurredAt: now.toISOString(),
    details: { type: record.type, attemptCount: record.attemptCount, ...details },
  })
}

function claimDueActions(
  state: RuntimeState,
  adapters: readonly SopActionAdapter[],
  workerId: string,
  now: Date,
  limit = 50,
) {
  state.sopActionRecords ??= []
  const adapterTypes = new Set(adapters.map((adapter) => adapter.type))
  const dueAt = now.toISOString()
  const due = state.sopActionRecords
    .filter((record) => (
      record.status === 'queued'
      && dispatchableTypes.has(record.type)
      && (record.nextAttemptAt ?? record.requestedAt) <= dueAt
      && (!record.leaseExpiresAt || record.leaseExpiresAt <= dueAt)
    ))
    .toSorted((left, right) => left.requestedAt.localeCompare(right.requestedAt))
    .slice(0, limit)
  const claims: SopActionClaim[] = []
  for (const record of due) {
    if (!adapterTypes.has(record.type as SopActionAdapter['type'])) {
      record.status = 'unconfigured'
      record.failureReason = `${record.type}通道尚未配置，未执行外部动作`
      record.nextAttemptAt = null
      appendAudit(state, record, 'sop.action.unconfigured.v1', now, { reason: record.failureReason })
      continue
    }
    record.attemptCount += 1
    record.lastAttemptAt = now.toISOString()
    record.nextAttemptAt = null
    record.leaseOwner = workerId
    record.leaseExpiresAt = new Date(now.getTime() + 60_000).toISOString()
    claims.push({
      recordId: record.id,
      workerId,
      attemptNumber: record.attemptCount,
      request: {
        id: record.id,
        type: record.type as SopActionDispatchRequest['type'],
        tableId: record.tableId,
        tableSessionId: record.tableSessionId,
        taskId: record.taskId,
        recipientEmployeeIds: [...record.recipientEmployeeIds],
        content: record.content,
        idempotencyKey: record.id,
      },
    })
  }
  if (due.length > 0) state.revision += 1
  return claims
}

function applyResult(state: RuntimeState, claim: SopActionClaim, result: SopActionDispatchResult, now: Date) {
  const record = (state.sopActionRecords ?? []).find((candidate) => candidate.id === claim.recordId)
  if (!record) throw new Error('SOP动作记录不存在')
  if (record.leaseOwner !== claim.workerId || record.attemptCount !== claim.attemptNumber) {
    throw new Error('SOP动作租约已经失效')
  }
  record.leaseOwner = null
  record.leaseExpiresAt = null
  if (result.outcome === 'completed') {
    if (!result.providerReference.trim()) throw new Error('外部动作未返回可审计凭证')
    record.status = 'completed'
    record.completedAt = now.toISOString()
    record.completedBy = 'system-sop-action-dispatcher'
    record.providerReference = result.providerReference
    record.evidenceReference = result.evidenceReference ?? null
    record.failureReason = null
    appendAudit(state, record, 'sop.action.completed.v1', now, { providerReference: result.providerReference })
  } else if (result.outcome === 'rejected') {
    record.status = 'rejected'
    record.completedAt = now.toISOString()
    record.completedBy = 'system-sop-action-dispatcher'
    record.providerReference = result.providerReference ?? null
    record.evidenceReference = result.evidenceReference ?? null
    record.failureReason = result.reason
    appendAudit(state, record, 'sop.action.rejected.v1', now, { reason: result.reason })
  } else if (result.outcome === 'retryable_failure' && record.attemptCount < 3) {
    record.status = 'queued'
    record.failureReason = result.reason
    record.nextAttemptAt = new Date(now.getTime() + 30_000 * 2 ** (record.attemptCount - 1)).toISOString()
    appendAudit(state, record, 'sop.action.retry_scheduled.v1', now, {
      reason: result.reason,
      nextAttemptAt: record.nextAttemptAt,
    })
  } else {
    record.status = 'failed'
    record.completedAt = now.toISOString()
    record.completedBy = 'system-sop-action-dispatcher'
    record.failureReason = result.reason
    record.nextAttemptAt = null
    appendAudit(state, record, 'sop.action.failed.v1', now, { reason: result.reason })
  }
  state.revision += 1
}

export async function dispatchDueSopActions(
  repository: RuntimeRepository,
  adapters: readonly SopActionAdapter[],
  workerId: string,
  now = new Date(),
  snapshot?: RuntimeState,
) {
  const emptySummary = { claimed: 0, completed: 0, rejected: 0, failed: 0, retried: 0 }
  if (!hasDueActions(snapshot ?? await repository.read(), now)) return emptySummary
  const claims = await repository.mutate(
    (state) => claimDueActions(state, adapters, workerId, now),
    { metricLabel: 'scheduler' },
  )
  const summary = { claimed: claims.length, completed: 0, rejected: 0, failed: 0, retried: 0 }
  for (const claim of claims) {
    const adapter = adapters.find((candidate) => candidate.type === claim.request.type)!
    let result: SopActionDispatchResult
    try {
      result = await adapter.dispatch(claim.request)
    } catch (error) {
      result = { outcome: 'retryable_failure', reason: error instanceof Error ? error.message : '外部动作适配器异常' }
    }
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await repository.mutate(
          (state) => applyResult(state, claim, result, new Date()),
          { metricLabel: 'scheduler' },
        )
        break
      } catch (error) {
        if (!(error instanceof PostgresOptimisticConcurrencyError) || attempt === 3) throw error
      }
    }
    if (result.outcome === 'completed') summary.completed += 1
    else if (result.outcome === 'rejected') summary.rejected += 1
    else if (result.outcome === 'retryable_failure') summary.retried += 1
    else summary.failed += 1
  }
  return summary
}
