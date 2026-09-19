import { describe, expect, it, vi } from 'vitest'
import { RefreshQueue } from './refresh-queue'
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }

describe('staff refresh queue', () => {
  it('does not interrupt a slow read when polling ticks and merges repeated polls', async () => {
    const gate = deferred(), signals: AbortSignal[] = []
    const read = vi.fn(async (signal: AbortSignal) => { signals.push(signal); await gate.promise })
    const queue = new RefreshQueue(read), pending = queue.request()
    await Promise.resolve()
    for (let i = 0; i < 8; i++) expect(queue.request()).toBe(pending)
    expect(read).toHaveBeenCalledTimes(1); expect(signals[0]!.aborted).toBe(false)
    gate.resolve(); await pending
    await queue.request(); expect(read).toHaveBeenCalledTimes(2)
  })

  it('coalesces mutation confirmations into a read that starts after the in-flight read', async () => {
    const first = deferred(), second = deferred()
    const read = vi.fn().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise)
    const queue = new RefreshQueue(read), pending = queue.request()
    await Promise.resolve()
    const confirmed = queue.request(true); queue.request(true)
    expect(read).toHaveBeenCalledTimes(1)
    first.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(read).toHaveBeenCalledTimes(2)
    let settled = false; void confirmed.then(() => { settled = true })
    await Promise.resolve(); expect(settled).toBe(false)
    second.resolve(); await pending; expect(settled).toBe(true)
  })

  it('aborts on teardown and does not let an old completion clear a new flight', async () => {
    const first = deferred(), second = deferred(), signals: AbortSignal[] = []
    const read = vi.fn(async (signal: AbortSignal) => { signals.push(signal); await (signals.length === 1 ? first.promise : second.promise) })
    const queue = new RefreshQueue(read), old = queue.request()
    await Promise.resolve(); queue.request(true); queue.cancel()
    expect(signals[0]!.aborted).toBe(true)
    const current = queue.request(); await Promise.resolve()
    first.resolve(); await old
    expect(queue.request()).toBe(current); expect(read).toHaveBeenCalledTimes(2)
    second.resolve(); await current
  })

  it('can retry after an unexpected reader failure', async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(undefined)
    const queue = new RefreshQueue(read)
    await expect(queue.request()).rejects.toThrow('offline')
    await queue.request(); expect(read).toHaveBeenCalledTimes(2)
  })
})
