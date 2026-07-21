import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetOptimisticActionsForTests, runOptimisticAction } from './optimistic-action'

afterEach(resetOptimisticActionsForTests)

describe('runOptimisticAction', () => {
  it('applies immediately and reconciles the authoritative result', async () => {
    const events: string[] = []
    const result = await runOptimisticAction({
      key: 'task:1',
      apply: () => { events.push('apply'); return 'before' },
      commit: async () => { events.push('commit'); return 'server' },
      reconcile: (value) => events.push(`reconcile:${value}`),
      rollback: () => events.push('rollback'),
    })
    expect(result).toBe('server')
    expect(events).toEqual(['apply', 'commit', 'reconcile:server'])
  })

  it('rolls back the latest failed action', async () => {
    const rollback = vi.fn()
    await expect(runOptimisticAction({
      key: 'task:1',
      apply: () => 'snapshot',
      commit: async () => { throw new Error('failed') },
      reconcile: vi.fn(),
      rollback,
    })).rejects.toThrow('failed')
    expect(rollback).toHaveBeenCalledWith('snapshot', expect.any(Error))
  })

  it('does not let an older failure undo a newer action', async () => {
    let rejectOlder: ((error: Error) => void) | undefined
    const olderRollback = vi.fn()
    const older = runOptimisticAction({
      key: 'task:1',
      apply: () => 'older',
      commit: () => new Promise<string>((_resolve, reject) => { rejectOlder = reject }),
      reconcile: vi.fn(),
      rollback: olderRollback,
    })
    await runOptimisticAction({
      key: 'task:1',
      apply: () => 'newer',
      commit: async () => 'done',
      reconcile: vi.fn(),
      rollback: vi.fn(),
    })
    rejectOlder?.(new Error('late failure'))
    await expect(older).rejects.toThrow('late failure')
    expect(olderRollback).not.toHaveBeenCalled()
  })
})
