import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./MemberBenefitsPortal.tsx', import.meta.url), 'utf8')

describe('retired web member entry', () => {
  it('does not reintroduce the legacy member data source or old customer tiers', () => {
    expect(source).toContain('请在 M-BOX 小程序查看会员中心')
    expect(source).not.toMatch(/api\/dev\/member-portal|standard|platinum|error\.message/)
  })
})
