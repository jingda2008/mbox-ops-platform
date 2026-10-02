import { afterEach, describe, expect, it, vi } from 'vitest'
import { StaffActionsApi } from './staff-actions-api'
const actor = '11111111-1111-4111-8111-111111111111'
const table = '22222222-2222-4222-8222-222222222222'
const assignment = '33333333-3333-4333-8333-333333333333'
const input = { tableIds: [table], employeeId: actor, roleId: actor, assignmentType: 'backup' as const,
  startsAt: '2026-09-27T10:00:00Z', endsAt: null, reason: '晚班责任安排' }
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
afterEach(() => vi.useRealTimers())
function harness(guarded = true) {
  const stored = new Map<string, string>()
  const storage = { getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => { stored.set(key, value) }, removeItem: (key: string) => { stored.delete(key) } }
  let currentActor = actor
  let fail: 'network' | 'read' | null = null
  let error: { code: string; status: number; commitDisposition?: string } | null = null
  let readGate: Promise<void> | null = null
  let corrupt = false
  let sequence = 0
  const send = vi.fn<typeof fetch>(async (url, init) => {
    const path = String(url)
    if (path.endsWith('assignment-options')) return json({ data: { employees: [], roles: [],
      ...(guarded ? { supportsGuardedAssignmentRecovery: true, currentEmployeeId: currentActor } : {}) } })
    if (init?.method !== 'POST') {
      if (readGate) await readGate
      if (fail === 'read') throw new Error('read failed')
      return json({ data: [] })
    }
    if (fail === 'network') throw new Error('reply lost')
    if (error) return json({ error }, error.status)
    const body = JSON.parse(String(init.body))
    const data = path.endsWith('/batch') ? { id: 'batch', assignments: body.tableIds.map((id: string) => ({
      ...body, id, tableId: id, createdByEmployeeId: currentActor,
    })) } : { id: assignment, endsAt: body.endsAt }
    if (corrupt) data.id = ''
    return json({ data, meta: { replayed: false } })
  })
  const make = (sessionId = 'session-one') => new StaffActionsApi({ fetch: send, commandStorage: storage,
    staffSessionId: sessionId, createIdempotencyKey: () => `request-${++sequence}` })
  const posts = () => send.mock.calls.filter(([, init]) => init?.method === 'POST')
  return { make, storage, stored, posts, setReadGate: (value: Promise<void> | null) => { readGate = value }, setGuarded: (value: boolean) => { guarded = value }, setFail: (value: typeof fail) => { fail = value },
    setError: (value: typeof error) => { error = value }, setActor: (value: string) => { currentActor = value },
    setCorrupt: (value: boolean) => { corrupt = value } }
}

describe('web responsibility original-request recovery', () => {
  it('restores the exact original batch after page refresh and refuses changed tables or reason', async () => {
    const h = harness(), first = h.make()
    await first.loadTableAssignmentOptions()
    h.setFail('network')
    await expect(first.assignTables(input)).rejects.toMatchObject({ code: 'NETWORK_ERROR' })
    const restored = h.make()
    await restored.loadTableAssignmentOptions()
    await expect(restored.assignTables({ ...input, reason: '修改原因' })).rejects.toThrow('不能改动')
    expect(h.posts()).toHaveLength(1)
    h.setFail(null)
    await restored.recoverTableAssignment()
    const [a, b] = h.posts()
    expect(a![0]).toBe(b![0]); expect(a![1]!.body).toBe(b![1]!.body)
    expect(new Headers(a![1]?.headers).get('x-idempotency-key')).toBe(new Headers(b![1]?.headers).get('x-idempotency-key'))
    await restored.loadTableAssignments()
    expect(restored.pendingTableAssignment()).toBeNull()
  })

  it('keeps the original end time across delay, refresh and renewed login by the same employee', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-27T12:00:00Z'))
    const h = harness(), api = h.make()
    await api.loadTableAssignmentOptions(); h.setFail('network')
    await expect(api.endTableAssignment(assignment, '交班结束')).rejects.toThrow()
    vi.setSystemTime(new Date('2026-09-28T12:00:00Z'))
    const refreshed = h.make('new-session')
    await refreshed.loadTableAssignmentOptions(); h.setFail(null)
    await refreshed.endTableAssignment(assignment, '交班结束')
    expect(h.posts()[0]![1]!.body).toBe(h.posts()[1]![1]!.body)
    expect(JSON.parse(String(h.posts()[1]![1]!.body)).endsAt).toBe('2026-09-27T12:00:00.000Z')
  })

  it('merges duplicate clicks and never resends a confirmed command while list refresh fails', async () => {
    const h = harness(), api = h.make(); await api.loadTableAssignmentOptions()
    await Promise.all([api.assignTables(input), api.assignTables(input)])
    expect(h.posts()).toHaveLength(1)
    h.setFail('read'); await expect(api.loadTableAssignments()).rejects.toThrow()
    const refreshed = h.make(); await refreshed.loadTableAssignmentOptions()
    await refreshed.recoverTableAssignment()
    expect(h.posts()).toHaveLength(1)
    h.setFail(null); await refreshed.loadTableAssignments()
    expect(refreshed.pendingTableAssignment()).toBeNull()
  })

  it('blocks another employee and restores only after returning to the original employee', async () => {
    const h = harness(), api = h.make(); await api.loadTableAssignmentOptions(); h.setFail('network')
    await expect(api.assignTables(input)).rejects.toThrow()
    h.setActor(table)
    const other = h.make('other-session'); await other.loadTableAssignmentOptions()
    expect(other.pendingTableAssignment()?.canRecover).toBe(false)
    await expect(other.recoverTableAssignment()).rejects.toThrow('原员工')
    expect(h.posts()).toHaveLength(1)
    h.setActor(actor); await other.loadTableAssignmentOptions(); h.setFail(null)
    await other.recoverTableAssignment(); expect(h.posts()).toHaveLength(2)
  })

  it.each([
    { status: 409, code: 'TABLE_OPERATION_CONFLICT' },
    { status: 409, code: 'TABLE_ASSIGNMENT_NOT_COMMITTED' },
    { status: 403, code: 'TABLE_PERMISSION_DENIED' },
    { status: 404, code: 'NOT_FOUND' },
    { status: 503, code: 'STORE_UNAVAILABLE' },
  ])('retains unknown, revoked and temporarily absent endpoints: $code', async error => {
    const h = harness(), api = h.make(); await api.loadTableAssignmentOptions(); h.setError(error)
    await expect(api.assignTables(input)).rejects.toThrow()
    expect(api.pendingTableAssignment()?.canRecover).toBe(true)
    await expect(api.assignTables({ ...input, reason: '换键重试' })).rejects.toThrow()
    expect(h.posts()).toHaveLength(1)
  })

  it('releases only an explicitly rolled back conflict and then permits a corrected command', async () => {
    const h = harness(), api = h.make(); await api.loadTableAssignmentOptions()
    h.setError({ status: 409, code: 'TABLE_ASSIGNMENT_NOT_COMMITTED', commitDisposition: 'not_committed' })
    await expect(api.assignTables(input)).rejects.toThrow()
    expect(api.pendingTableAssignment()).toBeNull()
    h.setError(null); await api.assignTables({ ...input, reason: '修正时段' })
    expect(new Headers(h.posts()[0]![1]?.headers).get('x-idempotency-key')).not.toBe(new Headers(h.posts()[1]![1]?.headers).get('x-idempotency-key'))
  })

  it('does not dispatch if durable storage fails, and keeps corrupt records untouched', async () => {
    const h = harness(), api = h.make(); await api.loadTableAssignmentOptions()
    const originalSet = h.storage.setItem
    h.storage.setItem = () => { throw new Error('storage full') }
    await expect(api.assignTables(input)).rejects.toThrow('保存')
    expect(h.posts()).toHaveLength(0)
    h.storage.setItem = originalSet
    h.stored.set('mbox.assignment-recovery.v1', '{broken')
    await expect(api.assignTables(input)).rejects.toThrow('读取')
    expect(h.posts()).toHaveLength(0); expect(api.pendingTableAssignment()?.canRecover).toBe(false)
  })

  it('retains a mismatched server receipt instead of claiming success', async () => {
    const h = harness(), api = h.make(); await api.loadTableAssignmentOptions(); h.setCorrupt(true)
    await expect(api.assignTables(input)).rejects.toThrow('不一致')
    expect(api.pendingTableAssignment()).not.toBeNull()
    h.setCorrupt(false); await api.recoverTableAssignment()
    expect(new Headers(h.posts()[0]![1]?.headers).get('x-idempotency-key')).toBe(new Headers(h.posts()[1]![1]?.headers).get('x-idempotency-key'))
  })

  it('retries the original receipt when saving confirmation fails after server success', async () => {
    const h = harness(), api = h.make(); await api.loadTableAssignmentOptions()
    const original = h.storage.setItem
    let writes = 0
    h.storage.setItem = (key, value) => { if (++writes === 2) throw new Error('disk full after commit'); original(key, value) }
    await expect(api.assignTables(input)).rejects.toThrow('保存')
    h.storage.setItem = original
    const refreshed = h.make(); await refreshed.loadTableAssignmentOptions(); await refreshed.recoverTableAssignment()
    expect(h.posts()).toHaveLength(2)
    expect(new Headers(h.posts()[0]![1]?.headers).get('x-idempotency-key')).toBe(new Headers(h.posts()[1]![1]?.headers).get('x-idempotency-key'))
  })

  it('does not resubmit a confirmed command if storage cleanup fails', async () => {
    const h = harness(), api = h.make(); await api.loadTableAssignmentOptions(); await api.assignTables(input)
    const remove = h.storage.removeItem
    h.storage.removeItem = () => { throw new Error('cleanup failed') }
    await expect(api.loadTableAssignments()).rejects.toThrow('未能清除')
    await api.recoverTableAssignment(); expect(h.posts()).toHaveLength(1)
    h.storage.removeItem = remove; await api.loadTableAssignments(); expect(api.pendingTableAssignment()).toBeNull()
  })

  it('keeps the original guarded route when a server rollback disables the capability', async () => {
    const h = harness(), api = h.make(); await api.loadTableAssignmentOptions(); h.setFail('network')
    await expect(api.assignTables(input)).rejects.toThrow()
    h.setGuarded(false); await api.loadTableAssignmentOptions(); h.setFail(null)
    h.setError({ status: 404, code: 'NOT_FOUND' })
    await expect(api.recoverTableAssignment()).rejects.toThrow()
    expect(h.posts().every(([path]) => String(path).includes('guarded-assignments'))).toBe(true)
    expect(api.pendingTableAssignment()).not.toBeNull()
  })

  it('does not clear a new confirmation when an older list request finishes late', async () => {
    const h = harness(), api = h.make(); await api.loadTableAssignmentOptions()
    let release!: () => void
    h.setReadGate(new Promise<void>(resolve => { release = resolve }))
    const oldRead = api.loadTableAssignments()
    await api.assignTables(input)
    release(); await oldRead
    expect(api.pendingTableAssignment()).not.toBeNull()
    h.setReadGate(null); await api.loadTableAssignments()
    expect(api.pendingTableAssignment()).toBeNull()
  })

  it('preserves original webpage routes against an older server without enabling guarded recovery', async () => {
    const h = harness(false), api = h.make(); await api.loadTableAssignmentOptions()
    await api.assignTables(input); await api.endTableAssignment(assignment, '正常交班')
    expect(h.posts().map(([path]) => path)).toEqual(['/api/table-management/assignments/batch', `/api/table-management/assignments/${assignment}/end`])
    expect(h.stored.size).toBe(0)
  })
})
