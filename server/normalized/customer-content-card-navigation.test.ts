import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { safeContentTargetPath } from './customer-experience-repository.js'

describe('member content card public navigation', () => {
  it('allows only registered low-risk mini-program destinations', () => {
    expect(safeContentTargetPath('/pages/community/index')).toBe('/pages/community/index')
    expect(safeContentTargetPath('/pages/profile/index')).toBe('/pages/profile/index')
    expect(safeContentTargetPath('/pages/community-detail/index?id=activity-public-001'))
      .toBe('/pages/community-detail/index?id=activity-public-001')
  })

  it('does not execute external, malformed, or query-injected paths', () => {
    expect(safeContentTargetPath('https://example.com/promo')).toBeNull()
    expect(safeContentTargetPath('javascript:alert(1)')).toBeNull()
    expect(safeContentTargetPath('//example.com/promo')).toBeNull()
    expect(safeContentTargetPath('/pages/community/index?redirect=https://example.com')).toBeNull()
    expect(safeContentTargetPath('/pages/community-detail/index?id=short')).toBeNull()
    expect(safeContentTargetPath('/pages/community-detail/index?id=activity-public-001&next=/pages/order/index')).toBeNull()
    expect(safeContentTargetPath('/pages/../internal/admin')).toBeNull()
  })

  it('uses strong audience fields rather than display JSON to decide visibility', () => {
    const source = readFileSync(new URL('./customer-experience-repository.ts', import.meta.url), 'utf8')
    const query = source.slice(source.indexOf('private async listContentCards'), source.indexOf('private async listBenefits'))
    expect(query).toContain('audience_visibility')
    expect(query).toContain('audience_member_levels')
    expect(query).toContain('audience_lifecycle_stages')
    expect(query).not.toContain('audience_rule')
  })
})
