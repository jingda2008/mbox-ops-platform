import type { ServiceTask } from '../shared/contracts'

export function taskAcceptMode(task: ServiceTask, currentEmployeeId: string, canClaimUnowned: boolean) {
  if (!['pending', 'escalated', 'reopened'].includes(task.status)) return null
  if (task.ownerId === null) return canClaimUnowned ? 'claim' as const : null
  return task.ownerId === currentEmployeeId ? 'accept' as const : null
}
