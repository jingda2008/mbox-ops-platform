import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const projectRoot = new URL('../../', import.meta.url)
const read = (path: string) => readFileSync(new URL(path, projectRoot), 'utf8')

describe('customer preference mini-program contract', () => {
  it('uses the authenticated preference fact API with retry-safe declaration and withdrawal', () => {
    const api = read('miniprogram/utils/api.js')
    expect(api).toContain("publicRequest('/api/public/mini/preferences')")
    expect(api).toContain("method: 'POST', headers: { 'idempotency-key': attempt.idempotencyKey }")
    expect(api).toContain('/api/public/mini/preferences/${encodeURIComponent(publicId)}/withdraw')
    expect(api).toContain("mbox.customer.preference.declare.v1")
    expect(api).toContain('mbox.customer.preference.withdraw.${publicId}')
    expect(api).toContain("error.code !== 'NETWORK_ERROR'")
  })

  it('projects the public response without canonical identity or internal scoring fields', () => {
    const api = read('server/normalized/customer-preference-api.ts')
    expect(api).toContain('publicPreferenceSnapshot(await options.service.list(context))')
    expect(api).toContain('data:publicPreferenceSnapshot(result.value)')
    const projection = api.slice(api.indexOf('function publicPreferenceSnapshot'), api.indexOf('async function handle'))
    expect(projection).toContain('supportingEvidenceCount')
    expect(projection).toContain('contraryEvidenceCount')
    expect(projection).toContain('sourceKind:source.sourceKind')
    expect(projection).not.toMatch(/canonicalCustomerId|confidence|supportScore|contraryScore|netScore|calculatedAt|actorRef|rawContent/)
  })

  it('shows only a compact evidence summary and provides explicit correction and withdrawal actions', () => {
    const page = read('miniprogram/pages/profile/index.js')
    const view = read('miniprogram/pages/profile/index.wxml')
    expect(page).toContain('getCustomerPreferenceFacts()')
    expect(page).toContain("polarity: 'contradicts'")
    expect(page).toContain('withdrawCustomerPreferenceSource(publicId')
    expect(view).toContain('只用于本店推荐，可纠正和撤回')
    expect(view).toContain('查看依据')
    expect(view).toContain('bindtap="correctCustomerPreference"')
    expect(view).toContain('bindtap="withdrawCustomerPreference"')
    expect(view).toContain('条结构化摘要，不展示员工原话、员工身份或内部备注。')
    expect(`${page}\n${view}`).not.toMatch(/canonicalCustomerId|actorRef|rawContent|staffId|employeeId|开始录音|wx\.getRecorderManager/)
  })

  it.each([320, 390])('keeps the preference controls usable at %ipx viewport width', (viewportWidth) => {
    const css = read('miniprogram/pages/profile/index.wxss')
    const compactPaddingRpx = viewportWidth <= 350 ? 44 : 56
    const contentWidth = viewportWidth - (viewportWidth * compactPaddingRpx / 750)
    expect(contentWidth).toBeGreaterThan(280)
    expect(css).toContain('@media (max-width: 350px)')
    expect(css).toMatch(/\.preference-head-action \{[^}]*min-height: 44px;/s)
    expect(css).toMatch(/\.preference-fact-row button,[^{]*\.preference-evidence-row button \{[^}]*min-height: 44px;/s)
    expect(css).toContain('grid-template-columns: minmax(0, 1fr) auto;')
    expect(css).not.toMatch(/\.preference-[^{]+\{[^}]*min-width:\s*(?:3[2-9]\d|[4-9]\d\d)px/s)
  })
})
