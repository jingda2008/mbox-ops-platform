import type { ServiceTask } from '../shared/contracts'

export type TaskQueueFilter = 'all' | 'sla-risk' | 'escalated' | 'complaint'

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

export function taskAcceptMode(task: ServiceTask, currentEmployeeId: string, canClaimUnowned: boolean) {
  if (!['pending', 'escalated', 'reopened'].includes(task.status)) return null
  if (task.ownerId === null) return canClaimUnowned ? 'claim' as const : null
  return task.ownerId === currentEmployeeId ? 'accept' as const : null
}
