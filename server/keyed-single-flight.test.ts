import { describe, expect, it } from 'vitest'
import { KeyedSingleFlight } from './keyed-single-flight.js'

describe('KeyedSingleFlight', () => {
  it('shares one in-flight database check without caching the settled result', async () => {
    const singleFlight = new KeyedSingleFlight<number>()
    let calls = 0
    const operation = async () => {
      calls += 1
      await new Promise((resolve) => setTimeout(resolve, 5))
      return calls
    }

    expect(await Promise.all(Array.from({ length: 60 }, () => singleFlight.run('session', operation))))
      .toEqual(Array.from({ length: 60 }, () => 1))
    expect(calls).toBe(1)
    expect(singleFlight.size).toBe(0)
    expect(await singleFlight.run('session', operation)).toBe(2)
    expect(calls).toBe(2)
  })

  it('does not combine different sessions and clears rejected work', async () => {
    const singleFlight = new KeyedSingleFlight<number>()
    const first = singleFlight.run('a', async () => 1)
    const second = singleFlight.run('b', async () => 2)
    expect(await Promise.all([first, second])).toEqual([1, 2])
    await expect(singleFlight.run('a', async () => { throw new Error('failed') })).rejects.toThrow('failed')
    expect(singleFlight.size).toBe(0)
  })
})
