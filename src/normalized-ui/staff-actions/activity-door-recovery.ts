import type { ActivityDoorCommand } from '../../shared/activity-service'

export interface ActivityDoorAttempt {
  registrationPublicId: string
  command: Omit<ActivityDoorCommand, 'credential'>
  key: string
}

const actions = new Set(['admit', 'redeem', 'admit_and_redeem', 'plaque_issued', 'return_plaque', 'restore_plaque', 'recover', 'update_location'])
export function activityDoorRecoveryKey(employeeId: string, registrationPublicId: string) {
  return `mbox.activity-door.v3:${employeeId}:${registrationPublicId}`
}
export function readActivityDoorAttempt(value: string | null, registrationPublicId: string): ActivityDoorAttempt | null {
  try {
    const parsed = JSON.parse(value ?? 'null') as ActivityDoorAttempt | null
    if (!parsed || parsed.registrationPublicId !== registrationPublicId || !parsed.command
      || !actions.has(parsed.command.action) || typeof parsed.key !== 'string' || parsed.key.length < 8) return null
    if (parsed.command.arrivedCount !== undefined && (!Number.isInteger(parsed.command.arrivedCount) || parsed.command.arrivedCount < 1)) return null
    // The bearer credential is supplied only by the current scan, never persisted.
    const { action, arrivedCount, location } = parsed.command
    return { registrationPublicId, key: parsed.key, command: { action, ...(arrivedCount !== undefined ? { arrivedCount } : {}), ...(typeof location === 'string' ? { location } : {}) } }
  } catch { return null }
}

export function isActivityCredential(code: string) {
  return /^MBOX_ACTIVITY_V3:[A-Za-z0-9_-]{8,128}:[a-f0-9-]{36}$/i.test(code.trim())
}
