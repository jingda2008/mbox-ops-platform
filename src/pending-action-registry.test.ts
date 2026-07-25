import { describe, expect, it } from 'vitest'
import { PendingActionRegistry } from './pending-action-registry'

describe('PendingActionRegistry', () => {
  it('blocks duplicate work without blocking unrelated actions', () => {
    const registry = new PendingActionRegistry()

    expect(registry.begin('quick:water')).toBe(true)
    expect(registry.begin('quick:water')).toBe(false)
    expect(registry.begin('quick:birthday')).toBe(true)
    expect(registry.snapshot()).toEqual(new Set(['quick:water', 'quick:birthday']))

    registry.finish('quick:water')

    expect(registry.has('quick:water')).toBe(false)
    expect(registry.has('quick:birthday')).toBe(true)
  })

  it('detects an in-flight operation for one business object only', () => {
    const registry = new PendingActionRegistry()
    registry.begin('notify:waitlist-1')
    registry.begin('seat:waitlist-2')

    expect(registry.hasSuffix(':waitlist-1')).toBe(true)
    expect(registry.hasSuffix(':waitlist-2')).toBe(true)
    expect(registry.hasSuffix(':waitlist-3')).toBe(false)
  })
})
