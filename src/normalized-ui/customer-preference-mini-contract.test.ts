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

  it('moves editable preferences into a dedicated customer page rather than expanding them on My', () => {
    const page = read('miniprogram/pages/profile/index.js')
    const view = read('miniprogram/pages/profile/index.wxml')
    const settings = read('miniprogram/pages/profile-preferences/index.js')
    const settingsView = read('miniprogram/pages/profile-preferences/index.wxml')
    expect(page).toContain("wx.navigateTo({ url: '/pages/profile-preferences/index' })")
    expect(view).toContain('我的偏好')
    expect(view).not.toContain('查看依据')
    expect(settings).toContain('getCustomerProfile()')
    expect(settings).toContain('updatePreferences(preferences, displayName || null)')
    expect(settingsView).toContain('位置偏好')
    expect(settingsView).toContain('只保存月日，不保存出生年份。')
    expect(`${page}\n${view}\n${settings}\n${settingsView}`).not.toMatch(/canonicalCustomerId|actorRef|rawContent|staffId|employeeId|开始录音|wx\.getRecorderManager/)
  })

  it.each([320, 390])('keeps the preference controls usable at %ipx viewport width', (viewportWidth) => {
    const css = read('miniprogram/pages/profile-preferences/index.wxss')
    const compactPaddingRpx = viewportWidth <= 350 ? 44 : 56
    const contentWidth = viewportWidth - (viewportWidth * compactPaddingRpx / 750)
    expect(contentWidth).toBeGreaterThan(280)
    expect(css).toContain('@media(max-width:390px)')
    expect(css).toContain('.option-chip')
    expect(css).toContain('min-height:68rpx')
    expect(css).not.toMatch(/\.option-chip[^\{]*\{[^}]*min-width:\s*(?:3[2-9]\d|[4-9]\d\d)px/s)
  })
})
