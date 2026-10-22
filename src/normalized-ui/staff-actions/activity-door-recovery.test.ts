import { describe, expect, it } from 'vitest'
import { activityDoorRecoveryKey, isActivityCredential, readActivityDoorAttempt } from './activity-door-recovery'
import { effectiveStaffNavigation } from '../../shared/staff-module-access'
import { quickStaffEntries } from '../staff-navigation-model'

describe('activity door recovery and entry', () => {
  it('keeps the original batch and key but never persists a bearer credential', () => {
    const saved = { registrationPublicId: 'registration-123', key: 'original-request', command: { action: 'admit_and_redeem', arrivedCount: 2, credential: 'secret-code' } }
    expect(readActivityDoorAttempt(JSON.stringify(saved), saved.registrationPublicId)).toEqual({ registrationPublicId: saved.registrationPublicId, key: saved.key, command: { action: 'admit_and_redeem', arrivedCount: 2 } })
    expect(readActivityDoorAttempt(JSON.stringify(saved), 'next-registration')).toBeNull()
    expect(activityDoorRecoveryKey('employee-a', saved.registrationPublicId)).not.toEqual(activityDoorRecoveryKey('employee-b', saved.registrationPublicId))
  })
  it('distinguishes a dedicated package code from a member lookup and malformed codes', () => {
    expect(isActivityCredential('MBOX_ACTIVITY_V3:registration-123:550e8400-e29b-41d4-a716-446655440000')).toBe(true)
    expect(isActivityCredential('MBOX_MEMBER_V1:MBX-123')).toBe(false)
    expect(isActivityCredential('MBOX_ACTIVITY_V3:registration-123:')).toBe(false)
    expect(readActivityDoorAttempt('{broken', 'registration-123')).toBeNull()
  })
  it('makes scanning reachable to permitted staff in All without putting it in the home shortcuts', () => {
    const entries = effectiveStaffNavigation(['loyalty.account.view', 'community.activity.manage'], [])
    expect(entries).toContainEqual(expect.objectContaining({ code: 'scan', route: '/staff/scan' }))
    expect(quickStaffEntries(entries, 'service').some(entry => entry.code === 'scan')).toBe(false)
    expect(effectiveStaffNavigation(['inventory.view'], []).some(entry => entry.code === 'scan')).toBe(false)
  })
})
