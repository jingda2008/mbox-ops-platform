import { describe, expect, it, vi } from 'vitest'
import { startBootstrapPolling } from './App'

describe('bootstrap polling', () => {
  it('stops for an expired session and resumes with exactly one timer after login', () => {
    const refresh = vi.fn()
    const callbacks = new Map<number, () => void>()
    let nextTimer = 1
    const schedule = vi.fn((callback: () => void, delay: number) => {
      expect(delay).toBe(2000)
      const timer = nextTimer++
      callbacks.set(timer, callback)
      return timer
    })
    const cancel = vi.fn((timer: number) => callbacks.delete(timer))
    const tick = () => [...callbacks.values()].forEach((callback) => callback())

    const stopInitialPolling = startBootstrapPolling(true, refresh, () => true, schedule, cancel)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(callbacks.size).toBe(1)

    stopInitialPolling()
    const stopWhileLoggedOut = startBootstrapPolling(false, refresh, () => true, schedule, cancel)
    tick()
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(callbacks.size).toBe(0)

    const stopAuthenticatedPolling = startBootstrapPolling(true, refresh, () => true, schedule, cancel)
    expect(refresh).toHaveBeenCalledTimes(2)
    expect(callbacks.size).toBe(1)
    tick()
    expect(refresh).toHaveBeenCalledTimes(3)

    stopWhileLoggedOut()
    stopAuthenticatedPolling()
    expect(callbacks.size).toBe(0)
    expect(schedule).toHaveBeenCalledTimes(2)
    expect(cancel).toHaveBeenCalledTimes(2)
  })
})
