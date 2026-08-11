import { describe, expect, it } from 'vitest'
import { getOrCreateDeviceKey } from './staff-device'

describe('normalized staff device identity', () => {
  it('creates one non-secret device key and reuses it', () => {
    const values = new Map<string, string>()
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
    const first = getOrCreateDeviceKey(storage, () => '01234567-89ab-4def-8123-456789abcdef')
    expect(first).toBe('web-01234567-89ab-4def-8123-456789abcdef')
    expect(getOrCreateDeviceKey(storage, () => 'unused')).toBe(first)
  })
})
