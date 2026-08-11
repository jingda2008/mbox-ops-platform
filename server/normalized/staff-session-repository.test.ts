import { describe, expect, it } from 'vitest'
import { hashDeviceKey, hashOpaqueToken } from './staff-session-repository.js'

describe('staff session token storage', () => {
  it('stores deterministic one-way token and device digests, never raw values', () => {
    const token = 'session-token-that-is-at-least-thirty-two-characters'
    const device = 'ipad-floor-l01-2026'
    const tokenHash = hashOpaqueToken(token)
    const deviceHash = hashDeviceKey(device)

    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/)
    expect(deviceHash).toMatch(/^[0-9a-f]{64}$/)
    expect(tokenHash).not.toContain(token)
    expect(deviceHash).not.toContain(device)
  })

  it('rejects weak opaque token and device identifiers', () => {
    expect(() => hashOpaqueToken('short')).toThrow('too short')
    expect(() => hashDeviceKey('ipad')).toThrow('at least 8')
  })
})
