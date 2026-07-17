import type { ServiceTask } from '../shared/contracts'

export function taskQueueIsOpen(task: Pick<ServiceTask, 'status'>) {
  return !['completed', 'confirmed', 'cancelled'].includes(task.status)
}

export function taskAcceptMode(task: ServiceTask, currentEmployeeId: string, canClaimUnowned: boolean) {
  if (!['pending', 'escalated', 'reopened'].includes(task.status)) return null
  if (task.ownerId === null) return canClaimUnowned ? 'claim' as const : null
  return task.ownerId === currentEmployeeId ? 'accept' as const : null
}
