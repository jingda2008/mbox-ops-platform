import { describe, expect, it, vi } from 'vitest'
import { startBootstrapPolling } from './App'

describe('bootstrap polling', () => {
  it('does not attach lifecycle work while polling is disabled', () => {
    const refresh = vi.fn()
    const lifecycle = createLifecycleTarget()
    const stop = startBootstrapPolling(false, refresh, {
      visibilityTarget: lifecycle,
      pageShowTarget: lifecycle,
    })

    expect(refresh).not.toHaveBeenCalled()
    expect(lifecycle.listenerCount()).toBe(0)
    stop()
  })

  it('self-schedules after completion and backs off while data is unchanged', async () => {
    const refresh = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    const callbacks = new Map<number, () => void>()
    let nextTimer = 1
    const schedule = vi.fn((callback: () => void, _delay: number) => {
      const timer = nextTimer++
      callbacks.set(timer, callback)
      return timer
    })
    const cancel = vi.fn((timer: number) => callbacks.delete(timer))
    const lifecycle = createLifecycleTarget()

    const stop = startBootstrapPolling(true, refresh, {
      isOnline: () => true,
      isVisible: () => true,
      schedule,
      cancel,
      visibilityTarget: lifecycle,
      pageShowTarget: lifecycle,
    })
    expect(refresh).toHaveBeenCalledTimes(1)
    await flushPromises()
    expect(callbacks.size).toBe(1)
    expect(schedule).toHaveBeenLastCalledWith(expect.any(Function), 5_000)

    const callback = [...callbacks.values()][0]!
    callbacks.clear()
    callback()
    await flushPromises()
    expect(refresh).toHaveBeenCalledTimes(2)
    expect(schedule).toHaveBeenLastCalledWith(expect.any(Function), 8_000)

    stop()
    expect(callbacks.size).toBe(0)
  })

  it('pauses while hidden and refreshes immediately when the app returns', async () => {
    let visible = false
    const refresh = vi.fn().mockResolvedValue(true)
    const callbacks = new Map<number, () => void>()
    const schedule = vi.fn((callback: () => void) => {
      callbacks.set(1, callback)
      return 1
    })
    const cancel = vi.fn((timer: number) => callbacks.delete(timer))
    const lifecycle = createLifecycleTarget()

    const stop = startBootstrapPolling(true, refresh, {
      isOnline: () => true,
      isVisible: () => visible,
      schedule,
      cancel,
      visibilityTarget: lifecycle,
      pageShowTarget: lifecycle,
    })
    expect(refresh).not.toHaveBeenCalled()
    expect(callbacks.size).toBe(0)

    visible = true
    lifecycle.dispatch('visibilitychange')
    expect(refresh).toHaveBeenCalledTimes(1)
    await flushPromises()
    expect(callbacks.size).toBe(1)

    visible = false
    lifecycle.dispatch('visibilitychange')
    expect(callbacks.size).toBe(0)
    visible = true
    lifecycle.dispatch('pageshow', { persisted: true } as PageTransitionEvent)
    expect(refresh).toHaveBeenCalledTimes(2)
    await flushPromises()

    stop()
    expect(lifecycle.listenerCount()).toBe(0)
  })

  it('does not duplicate bootstrap on a normal initial pageshow', async () => {
    const refresh = vi.fn().mockResolvedValue(true)
    const lifecycle = createLifecycleTarget()
    const stop = startBootstrapPolling(true, refresh, {
      isOnline: () => true,
      isVisible: () => true,
      schedule: vi.fn(() => 1),
      cancel: vi.fn(),
      visibilityTarget: lifecycle,
      pageShowTarget: lifecycle,
    })

    lifecycle.dispatch('pageshow', { persisted: false } as PageTransitionEvent)
    await flushPromises()
    expect(refresh).toHaveBeenCalledTimes(1)
    stop()
  })

  it('keeps one refresh in flight when foreground signals repeat', async () => {
    let resolveRefresh!: (changed: boolean) => void
    const refresh = vi.fn(() => new Promise<boolean>((resolve) => { resolveRefresh = resolve }))
    const lifecycle = createLifecycleTarget()
    const schedule = vi.fn(() => 1)

    const stop = startBootstrapPolling(true, refresh, {
      isOnline: () => true,
      isVisible: () => true,
      schedule,
      cancel: vi.fn(),
      visibilityTarget: lifecycle,
      pageShowTarget: lifecycle,
    })
    lifecycle.dispatch('pageshow', { persisted: true } as PageTransitionEvent)
    lifecycle.dispatch('visibilitychange')
    expect(refresh).toHaveBeenCalledTimes(1)

    resolveRefresh(true)
    await flushPromises()
    expect(refresh).toHaveBeenCalledTimes(2)
    stop()
  })

  it('avoids network requests while offline and retries at a relaxed cadence', () => {
    const refresh = vi.fn()
    const lifecycle = createLifecycleTarget()
    const schedule = vi.fn(() => 1)

    const stop = startBootstrapPolling(true, refresh, {
      isOnline: () => false,
      isVisible: () => true,
      schedule,
      cancel: vi.fn(),
      visibilityTarget: lifecycle,
      pageShowTarget: lifecycle,
    })

    expect(refresh).not.toHaveBeenCalled()
    expect(schedule).toHaveBeenCalledWith(expect.any(Function), 15_000)
    stop()
  })
})

function createLifecycleTarget() {
  const listeners = new Map<string, Set<(event: Event) => void>>()
  return {
    addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      const callback = listener as (event: Event) => void
      const current = listeners.get(type) ?? new Set<(event: Event) => void>()
      current.add(callback)
      listeners.set(type, current)
    },
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      listeners.get(type)?.delete(listener as (event: Event) => void)
    },
    dispatch(type: string, event: Event = new Event(type)) {
      for (const listener of listeners.get(type) ?? []) listener(event)
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
