import { createHash } from 'node:crypto'
import type { RuntimeState } from '../src/shared/contracts.js'
import type { KdsTask, KdsTaskStatus } from '../src/shared/order-contracts.js'

export interface NormalizedKdsAuthorityRow extends Record<string, unknown> {
  source_id: string
  status: KdsTaskStatus
  payload: KdsTask | string
  snapshot_revision: number | string
}

export interface KdsAuthorityCommand {
  taskId: string
  eventType: `kds.${string}.v2`
  actorId: string
  requestId?: string
}

export class KdsAuthorityStateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KdsAuthorityStateError'
  }
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`)
    .join(',')}}`
}

function parseTask(value: KdsTask | string): KdsTask {
  const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value
  if (!parsed || typeof parsed !== 'object') throw new KdsAuthorityStateError('规范化KDS任务载荷不是对象')
  const task = parsed as Partial<KdsTask>
  if (!task.id || !task.orderId || !task.orderItemId || !task.tableSessionId || !task.status) {
    throw new KdsAuthorityStateError('规范化KDS任务缺少关键身份或状态')
  }
  return structuredClone(task as KdsTask)
}

function assertSameIdentity(aggregate: KdsTask, authority: KdsTask) {
  const fields = ['id', 'orderId', 'orderItemId', 'tableSessionId', 'stationId'] as const
  for (const field of fields) {
    if (aggregate[field] !== authority[field]) {
      throw new KdsAuthorityStateError(`KDS权威行与兼容镜像的${field}不一致`)
    }
  }
}

/**
 * Locks and validates the normalized row before domain code runs. During the
 * compatibility period an exact aggregate mirror is mandatory; divergence is
 * failed closed instead of silently overwriting either source.
 */
export function installAuthoritativeKdsTask(
  state: RuntimeState,
  row: NormalizedKdsAuthorityRow,
  expectedTaskId: string,
): KdsTask {
  const authority = parseTask(row.payload)
  if (row.source_id !== expectedTaskId || authority.id !== expectedTaskId) {
    throw new KdsAuthorityStateError('规范化KDS任务ID与请求不一致')
  }
  if (row.status !== authority.status) {
    throw new KdsAuthorityStateError('规范化KDS状态列与载荷不一致')
  }
  const index = state.orderDomain.kdsTasks.findIndex((task) => task.id === expectedTaskId)
  if (index < 0) throw new KdsAuthorityStateError('兼容镜像缺少规范化KDS任务')
  const aggregate = state.orderDomain.kdsTasks[index]!
  assertSameIdentity(aggregate, authority)
  if (canonicalize(aggregate) !== canonicalize(authority)) {
    throw new KdsAuthorityStateError('KDS规范化权威行与兼容镜像内容不一致，请先执行一致性修复')
  }
  state.orderDomain.kdsTasks[index] = authority
  return authority
}

export function authoritativeKdsTask(state: RuntimeState, taskId: string): KdsTask {
  const task = state.orderDomain.kdsTasks.find((candidate) => candidate.id === taskId)
  if (!task) throw new KdsAuthorityStateError('KDS命令完成后任务不存在')
  return task
}

export function inferKdsCommandOccurredAt(before: KdsTask, after: KdsTask): string {
  const latestException = after.exceptionEvents?.at(-1)
  if (latestException && canonicalize(before.exceptionEvents ?? []) !== canonicalize(after.exceptionEvents ?? [])) {
    return latestException.occurredAt
  }
  const candidates: Array<keyof Pick<KdsTask, 'deliveredAt' | 'pickedUpAt' | 'completedAt' | 'startedAt'>> = [
    'deliveredAt', 'pickedUpAt', 'completedAt', 'startedAt',
  ]
  for (const field of candidates) {
    if (after[field] && after[field] !== before[field]) return after[field]!
  }
  throw new KdsAuthorityStateError('KDS命令没有产生可审计的状态或异常变化')
}

export function kdsAuthorityEventId(operationScope: string, idempotencyKey: string) {
  return `kds_event_${createHash('sha256').update(`${operationScope}:${idempotencyKey}`).digest('hex').slice(0, 32)}`
}

export function kdsRequestHash(requestFingerprint: string) {
  return createHash('sha256').update(requestFingerprint).digest('hex')
}

export function kdsAuthorityEventPayload(before: KdsTask, after: KdsTask) {
  const latestException = after.exceptionEvents?.at(-1)
  return {
    orderId: after.orderId,
    orderItemId: after.orderItemId,
    tableSessionId: after.tableSessionId,
    tableCode: after.tableCode ?? null,
    stationId: after.stationId,
    itemName: after.itemName,
    quantity: after.quantity,
    previousStatus: before.status,
    status: after.status,
    exceptionId: latestException?.exceptionId ?? null,
    exceptionType: latestException?.type ?? null,
    managerDisposition: latestException?.managerDisposition ?? null,
    remakeKdsTaskId: latestException?.remakeKdsTaskId ?? null,
  }
}
