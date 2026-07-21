import { describe, expect, it, vi } from 'vitest'
import { RevisionScopedCache } from './revision-scoped-cache.js'

describe('revision scoped cache', () => {
  it('reuses one projection only for the same actor scope and revision', () => {
    const cache = new RevisionScopedCache<{ marker: number }>()
    const create = vi.fn(() => ({ marker: 1 }))

    expect(cache.getOrCreate('store-a:employee-a', 7, create)).toEqual({ marker: 1 })
    expect(cache.getOrCreate('store-a:employee-a', 7, create)).toEqual({ marker: 1 })
    expect(create).toHaveBeenCalledTimes(1)

    cache.getOrCreate('store-a:employee-b', 7, create)
    cache.getOrCreate('store-a:employee-a', 8, create)
    expect(create).toHaveBeenCalledTimes(3)
  })

  it('evicts the least recently used entry at the configured bound', () => {
    const cache = new RevisionScopedCache<number>(2)
    cache.getOrCreate('employee-a', 1, () => 1)
    cache.getOrCreate('employee-b', 1, () => 2)
    cache.getOrCreate('employee-a', 1, () => 10)
    cache.getOrCreate('employee-c', 1, () => 3)

    expect(cache.size).toBe(2)
    expect(cache.getOrCreate('employee-a', 1, () => 10)).toBe(1)
    expect(cache.getOrCreate('employee-b', 1, () => 20)).toBe(20)
  })
})
