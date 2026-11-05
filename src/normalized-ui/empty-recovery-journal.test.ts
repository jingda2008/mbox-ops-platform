import { describe, expect, it, vi } from 'vitest'
import { ManualPointsRecovery } from './manual-points-recovery'
import { activityProductionJournal } from './staff-actions/activity-production-recovery'
import type { StaffActionsApiPort } from './staff-actions/staff-actions-api'

function storage() {
  const records = new Map<string, string>()
  return { getItem: (key: string) => records.get(key) ?? null,
    setItem: vi.fn((key: string, value: string) => { records.set(key, value) }),
    removeItem: vi.fn((key: string) => { records.delete(key) }) }
}
const board = { activityItems: [], recoveryNamespace: 'local-device', commandScope: 'a'.repeat(64), staffSessionId: '11111111-1111-4111-8111-111111111111' }
const pointer = 'mbox.activity-pickup-origin.v1:local-device'
describe('empty and malformed recovery evidence', () => {
  it.each(['', '{broken', '{}', 'null', '[]'])('blocks manual points with existing journal %j', async raw => {
    const saved = storage(), key = 'mbox.manual-points.v1:store:actor', send = vi.fn(), read = vi.fn()
    saved.setItem(key, raw); saved.setItem.mockClear()
    await expect(new ManualPointsRecovery('store', 'actor', saved).execute(
      { kind: 'request', body: { memberNo: 'LOCAL', pointsDelta: 10, reason: '本地故障核对' } },
      ['loyalty.adjust.manual'], send, read)).rejects.toThrow()
    expect(send).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled()
    expect(saved.setItem).not.toHaveBeenCalled(); expect(saved.getItem(key)).toBe(raw)
  })
  it.each(['', '{broken', '{}', 'null', '[]'])('blocks pickup with existing origin %j', raw => {
    const saved = storage(), run = vi.fn(), recover = vi.fn()
    const api = { runActivityProduction: run, recoverActivityProduction: recover } as unknown as StaffActionsApiPort
    saved.setItem(pointer, raw); saved.setItem.mockClear()
    expect(() => activityProductionJournal(api, 'pickup', 'fallback', board, saved)).toThrow('损坏')
    expect(saved.getItem(pointer)).toBe(raw); expect(saved.setItem).not.toHaveBeenCalled()
    expect(saved.removeItem).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled(); expect(recover).not.toHaveBeenCalled()
  })
  it('allows a new pickup journal and cleans only a stale valid pointer without a pending command', () => {
    const saved = storage(), api = {} as StaffActionsApiPort
    const fresh = activityProductionJournal(api, 'pickup', 'fallback', board, saved)
    expect(fresh.previousLogin).toBe(false); expect(fresh.journal.pending()).toBeNull()
    fresh.remember(); expect(JSON.parse(saved.getItem(pointer)!)).toEqual({ staffSessionId: board.staffSessionId, commandScope: board.commandScope })
    expect(activityProductionJournal(api, 'pickup', 'fallback', board, saved).journal.pending()).toBeNull()
    expect(saved.getItem(pointer)).toBeNull()
  })
})
