import { describe, expect, it } from 'vitest'
import { isComfortablyVisible, shouldRevealChangedCandidate } from './global-action-reveal'

describe('global action reveal viewport policy', () => {
  const viewport = { innerHeight: 844, innerWidth: 390 }

  it('keeps a result that is already comfortably visible in place', () => {
    const element = { getBoundingClientRect: () => ({ top: 40, left: 20, right: 370, bottom: 240 }) } as Element
    expect(isComfortablyVisible(element, viewport as Window)).toBe(true)
  })

  it('requires reveal when the next operation is below or outside the viewport', () => {
    const below = { getBoundingClientRect: () => ({ top: 860, left: 20, right: 370, bottom: 980 }) } as Element
    const clipped = { getBoundingClientRect: () => ({ top: 30, left: 20, right: 410, bottom: 240 }) } as Element
    expect(isComfortablyVisible(below, viewport as Window)).toBe(false)
    expect(isComfortablyVisible(clipped, viewport as Window)).toBe(false)
  })

  it('re-reveals an existing result message but not routine changes inside an existing operation panel', () => {
    const result = { getAttribute: (name: string) => name === 'role' ? 'status' : null } as Element
    const panel = { getAttribute: () => null, hasAttribute: () => false } as unknown as Element
    const visibleBefore = new Set<Element>([result, panel])
    expect(shouldRevealChangedCandidate(result, visibleBefore)).toBe(true)
    expect(shouldRevealChangedCandidate(panel, visibleBefore)).toBe(false)
    expect(shouldRevealChangedCandidate({ getAttribute: () => null, hasAttribute: () => false } as unknown as Element, visibleBefore)).toBe(true)
  })

  it('re-reveals an existing aria-live confirmation even without a status role', () => {
    const live = {
      getAttribute: (name: string) => name === 'aria-live' ? 'polite' : null,
      hasAttribute: (name: string) => name === 'aria-live',
    } as unknown as Element
    expect(shouldRevealChangedCandidate(live, new Set([live]))).toBe(true)
  })
})
