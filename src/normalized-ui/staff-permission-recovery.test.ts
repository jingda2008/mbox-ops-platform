import { describe, expect, it, vi } from 'vitest'
import { StaffPermissionRecovery } from './staff-permission-recovery'
import type { StaffPermissionDeploymentResult } from '../shared/normalized-contracts'

function storage() {
  const values = new Map<string, string>()
  return { get length() { return values.size }, key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) } }
}
const body = { expectedVersion: 'a'.repeat(64), reason: '调整员工职责',
  changes: [{ kind: 'employee_override' as const, employeeId: 'target', permissionCode: 'order.create', effect: 'grant' as const }] }
const result: StaffPermissionDeploymentResult = { status: 'verified', replayed: true, verifiedAt: '2026-09-21T00:00:00Z', changes: [],
  overview: { generatedAt: '', scopeKey: 'tenant:store', configurationVersion: 'b'.repeat(64), roles: [], employees: [], permissions: [], areas: [], configurationDefinitions: [] } }

describe('permission publication durable original intent', () => {
  it('restores exact key, version and changes after reload, despite changed drafts', async () => {
    const saved = storage()
    const original = new StaffPermissionRecovery('tenant:store', 'admin', saved)
    const first = vi.fn(async () => { throw new Error('lost response after commit') })
    await expect(original.execute(body, first)).rejects.toThrow('lost response')
    const persisted = original.pending()!
    expect(persisted.body).toEqual(body)
    const freshPage = new StaffPermissionRecovery('tenant:store', 'admin', saved)
    const retry = vi.fn(async () => result)
    await freshPage.execute({ ...body, reason: '后来编辑的新原因' }, retry)
    expect(retry).toHaveBeenCalledWith(persisted)
    expect(freshPage.pending()).toBeNull()
  })

  it('deduplicates double clicks and separates actor and store recovery', async () => {
    const saved = storage()
    const recovery = new StaffPermissionRecovery('tenant:store', 'admin', saved)
    let finish!: (value: StaffPermissionDeploymentResult) => void
    const send = vi.fn(() => new Promise<StaffPermissionDeploymentResult>((resolve) => { finish = resolve }))
    const one = recovery.execute(body, send)
    const two = recovery.execute(body, send)
    expect(send).toHaveBeenCalledTimes(1)
    expect(new StaffPermissionRecovery('tenant:other', 'admin', saved).pending()).toBeNull()
    expect(new StaffPermissionRecovery('tenant:store', 'other-admin', saved).pending()).toBeNull()
    finish(result)
    await Promise.all([one, two])
    expect(recovery.pending()).toBeNull()
  })

  it('retains authentication loss and unknown 500; clears only definitive invalid or stale requests', async () => {
    for (const code of ['AUTH_REQUIRED', 'STAFF_ACCESS_FORBIDDEN', 'PERMISSION_DEPLOYMENT_FAILED', 'STAFF_ACCESS_VERSION_CONFLICT', 'PERMISSION_DEPLOYMENT_INVALID']) {
      const recovery = new StaffPermissionRecovery('tenant:store', 'admin', storage())
      await expect(recovery.execute(body, async () => { throw Object.assign(new Error(code), { code }) })).rejects.toThrow(code)
      expect(recovery.pending() === null).toBe(['STAFF_ACCESS_VERSION_CONFLICT', 'PERMISSION_DEPLOYMENT_INVALID'].includes(code))
    }
  })

  it('does not send writes if persistent storage is unavailable', async () => {
    const saved = storage()
    saved.setItem = () => { throw new Error('storage unavailable') }
    const send = vi.fn(async () => result)
    await expect(new StaffPermissionRecovery('tenant:store', 'admin', saved).execute(body, send)).rejects.toThrow('storage unavailable')
    expect(send).not.toHaveBeenCalled()
  })
})
