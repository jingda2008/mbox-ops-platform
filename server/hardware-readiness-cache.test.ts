import { describe, expect, it, vi } from 'vitest'
import { createHardwareReadinessResolver, hardwareReadinessSnapshot } from './hardware-readiness-cache.js'
import { createSeedState } from './seed.js'

describe('hardware readiness cache', () => {
  it('classifies an unconfigured store without a state read', async () => {
    const state = createSeedState(new Date('2026-08-09T12:00:00.000Z'))
    const readState = vi.fn(async () => state)
    const resolve = createHardwareReadinessResolver(readState, state, 60_000)

    expect(await resolve(1_000)).toEqual(hardwareReadinessSnapshot(state))
    expect(readState).toHaveBeenCalledTimes(1)
    expect(await resolve(30_000)).toEqual(hardwareReadinessSnapshot(state))
    expect(readState).toHaveBeenCalledTimes(1)
  })

  it('single-flights refreshes and only rereads after the TTL', async () => {
    const state = createSeedState(new Date('2026-08-09T12:00:00.000Z'))
    const readState = vi.fn(async () => state)
    const resolve = createHardwareReadinessResolver(readState, state, 60_000)

    await Promise.all([resolve(1_000), resolve(1_000), resolve(1_000)])
    expect(readState).toHaveBeenCalledTimes(1)
    await resolve(61_001)
    expect(readState).toHaveBeenCalledTimes(2)
  })
})
