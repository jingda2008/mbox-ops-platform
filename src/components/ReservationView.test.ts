import { describe, expect, it, vi } from 'vitest'
import { startReservationPolling } from './ReservationView'

describe('reservation polling', () => {
  it('uses self-scheduling list refreshes without overlapping requests', async () => {
    let resolveRefresh!: () => void
    const refresh = vi.fn(() => new Promise<void>((resolve) => { resolveRefresh = resolve }))
    const callbacks = new Map<number, () => void>()
    const schedule = vi.fn((callback: () => void, delay: number) => {
      expect(delay).toBe(10_000)
      callbacks.set(1, callback)
      return 1
    })
    const lifecycle = createLifecycleTarget()

    const stop = startReservationPolling(refresh, {
      isVisible: () => true,
      schedule,
      cancel: (timer) => callbacks.delete(timer),
      visibilityTarget: lifecycle,
      pageShowTarget: lifecycle,
    })
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(callbacks.size).toBe(0)

    lifecycle.dispatch('pageshow')
    expect(refresh).toHaveBeenCalledTimes(1)
    resolveRefresh()
    await flushPromises()
    expect(refresh).toHaveBeenCalledTimes(2)

    resolveRefresh()
    await flushPromises()
    expect(callbacks.size).toBe(1)
    stop()
  })

  it('does not poll while hidden and refreshes immediately on foreground restore', async () => {
    let visible = false
    const refresh = vi.fn().mockResolvedValue(undefined)
    const callbacks = new Map<number, () => void>()
    const lifecycle = createLifecycleTarget()

    const stop = startReservationPolling(refresh, {
      isVisible: () => visible,
      schedule: (callback) => {
        callbacks.set(1, callback)
        return 1
      },
      cancel: (timer) => callbacks.delete(timer),
      visibilityTarget: lifecycle,
      pageShowTarget: lifecycle,
    })
    expect(refresh).not.toHaveBeenCalled()

    visible = true
    lifecycle.dispatch('visibilitychange')
    expect(refresh).toHaveBeenCalledTimes(1)
    await flushPromises()
    expect(callbacks.size).toBe(1)

    visible = false
    lifecycle.dispatch('visibilitychange')
    expect(callbacks.size).toBe(0)
    stop()
    expect(lifecycle.listenerCount()).toBe(0)
  })
})

function createLifecycleTarget() {
  const listeners = new Map<string, Set<() => void>>()
  return {
    addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      const callback = listener as () => void
      const current = listeners.get(type) ?? new Set<() => void>()
      current.add(callback)
      listeners.set(type, current)
    },
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      listeners.get(type)?.delete(listener as () => void)
    },
    dispatch(type: string) {
      for (const listener of listeners.get(type) ?? []) listener()
    },
    listenerCount() {
      return [...listeners.values()].reduce((total, current) => total + current.size, 0)
    },
  }
}

async function flushPromises() {
  await Promise.resolve()
  await Promise.resolve()
}
