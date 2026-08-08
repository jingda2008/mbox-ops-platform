import type { ServiceTask, ServiceTypeConfig, ServiceWorkflowLevel } from '../shared/contracts'

export type TaskQueueFilter = 'all' | 'sla-risk' | 'escalated' | 'complaint'
export type TaskWorkflowLevel = ServiceWorkflowLevel
export type TaskQueueActionMode = 'quick-complete' | 'accept' | 'arrive' | 'complete'

export function taskQueueFilterForQuery(query?: string | null): TaskQueueFilter {
  if (query === 'service-sla-risk') return 'sla-risk'
  if (query === 'service-escalated') return 'escalated'
  if (query === 'service-complaints') return 'complaint'
  return 'all'
}

export function taskMatchesQueueFilter(
  task: ServiceTask,
  filter: TaskQueueFilter,
  complaintServiceTypeIds: ReadonlySet<string>,
  now = Date.now(),
) {
  if (filter === 'sla-risk') {
    return now >= new Date(task.warningAt).getTime() && !['arrived', 'completed', 'confirmed'].includes(task.status)
  }
  if (filter === 'escalated') return task.escalationLevel > 0 || task.status === 'escalated'
  if (filter === 'complaint') return complaintServiceTypeIds.has(task.serviceTypeId)
  return true
}

export function taskQueueIsOpen(task: Pick<ServiceTask, 'status'>) {
  return !['completed', 'confirmed', 'cancelled'].includes(task.status)
}

export function taskWorkflowLevel(
  serviceType?: ServiceTypeConfig,
  task?: Pick<ServiceTask, 'workflowLevel'>,
): TaskWorkflowLevel {
  const level = task?.workflowLevel ?? serviceType?.workflowLevel
  return level === 'L0' || level === 'L1' || level === 'L2' || level === 'L3' ? level : 'L3'
}

export function taskQueueIsVisible(task: Pick<ServiceTask, 'status'>, serviceType?: ServiceTypeConfig) {
  return taskWorkflowLevel(serviceType, task as Pick<ServiceTask, 'workflowLevel'>) !== 'L0' && taskQueueIsOpen(task)
}

export function taskAcceptMode(task: ServiceTask, currentEmployeeId: string, canClaimUnowned: boolean) {
  if (!['pending', 'escalated', 'reopened'].includes(task.status)) return null
  if (task.ownerId === null) return canClaimUnowned ? 'claim' as const : null
  return task.ownerId === currentEmployeeId ? 'accept' as const : null
}

export function taskCanQuickComplete(
  task: ServiceTask,
  serviceType: ServiceTypeConfig,
  currentEmployeeId: string,
  isClaimable: boolean,
) {
  if (taskWorkflowLevel(serviceType, task) !== 'L1' || !taskQueueIsOpen(task)) return false
  if (task.ownerId === currentEmployeeId) return true
  return isClaimable && (
    serviceType.allowBackupDirectComplete === true
    || serviceType.allowCrossAreaComplete === true
  )
}

export function taskQueueActionMode(
  task: ServiceTask,
  serviceType: ServiceTypeConfig,
  currentEmployeeId: string,
  isClaimable: boolean,
): TaskQueueActionMode | null {
  const workflowLevel = taskWorkflowLevel(serviceType, task)
  if (workflowLevel === 'L0' || !taskQueueIsOpen(task)) return null
  if (workflowLevel === 'L1') {
    return taskCanQuickComplete(task, serviceType, currentEmployeeId, isClaimable) ? 'quick-complete' : null
  }
  if (['pending', 'escalated', 'reopened'].includes(task.status)) {
    return taskAcceptMode(task, currentEmployeeId, isClaimable) ? 'accept' : null
  }
  if (task.ownerId !== currentEmployeeId) return null
  if (workflowLevel === 'L2') return ['accepted', 'arrived'].includes(task.status) ? 'complete' : null
  if (task.status === 'accepted') return 'arrive'
  if (task.status === 'arrived') return 'complete'
  return null
}

function queueRank(
  task: ServiceTask,
  serviceType: ServiceTypeConfig | undefined,
  currentEmployeeId: string,
  claimableTaskIds: ReadonlySet<string>,
  now: number,
) {
  const atRisk = task.status === 'escalated'
    || task.escalationLevel > 0
    || task.priority === 'urgent'
    || now >= new Date(task.warningAt).getTime()
  if (atRisk) return 0
  const delivery = serviceType?.code === 'FULFILLMENT_DELIVERY'
  if (delivery && task.ownerId === currentEmployeeId) return 1
  if (delivery && claimableTaskIds.has(task.id)) return 2
  if (task.ownerId === currentEmployeeId) return 3
  return 4
}

export function compareTaskQueueItems(
  left: ServiceTask,
  right: ServiceTask,
  serviceTypeById: ReadonlyMap<string, ServiceTypeConfig>,
  currentEmployeeId: string,
  claimableTaskIds: ReadonlySet<string>,
  now = Date.now(),
) {
  const rank = queueRank(left, serviceTypeById.get(left.serviceTypeId), currentEmployeeId, claimableTaskIds, now)
    - queueRank(right, serviceTypeById.get(right.serviceTypeId), currentEmployeeId, claimableTaskIds, now)
  if (rank !== 0) return rank
  const due = new Date(left.warningAt).getTime() - new Date(right.warningAt).getTime()
  if (due !== 0) return due
  const created = new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime()
  if (created !== 0) return created
  return left.id.localeCompare(right.id)
}

function recentRequestLabel(timestamp: string, now: number) {
  const requestedAt = new Date(timestamp).getTime()
  if (!Number.isFinite(requestedAt)) return '刚刚'
  const seconds = Math.max(0, Math.floor((now - requestedAt) / 1000))
  if (seconds < 10) return '刚刚'
  if (seconds < 60) return `${seconds}秒前`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}分钟前`
  return `${Math.floor(minutes / 60)}小时前`
}

export function taskRepeatSummary(task: ServiceTask, now = Date.now()) {
  const requestCount = Math.max(1, Math.floor(task.requestCount ?? 1))
  if (requestCount <= 1) return null
  const lastRequestedAt = task.lastRequestedAt || task.updatedAt || task.createdAt
  return `重复呼叫 ${requestCount}次 · 最近${recentRequestLabel(lastRequestedAt, now)}`
}
