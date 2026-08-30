import { describe, expect, it } from 'vitest'
import { shortPublicReference } from './public-reference'

describe('public reference presentation', () => {
  it('keeps a short business reference readable', () => {
    expect(shortPublicReference('A01-1024')).toBe('A01-1024')
  })

  it('uses a compact suffix for long internal references', () => {
    expect(shortPublicReference('order-ca5a30dd-0000-4000-8000-123456789abc')).toBe('…56789abc')
  })

  it('does not expose an empty raw value', () => {
    expect(shortPublicReference('  ')).toBe('待生成')
  })
})
