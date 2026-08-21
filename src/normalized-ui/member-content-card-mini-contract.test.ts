import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const projectRoot = new URL('../../', import.meta.url)
const read = (path: string) => readFileSync(new URL(path, projectRoot), 'utf8')

describe('member content card mini-program contract', () => {
  it('keeps content recommendations separate from issued benefits and below core member information', () => {
    const page = read('miniprogram/pages/profile/index.js')
    const view = read('miniprogram/pages/profile/index.wxml')
    expect(page).toContain('(data.content || [])')
    expect(page).toContain('.sort((left, right) => left.priority - right.priority)')
    expect(page).toContain('.slice(0, 3)')
    expect(view).toContain('活动与内容')
    expect(view).toContain('可用权益')
    expect(view.indexOf('可用权益')).toBeLessThan(view.indexOf('活动与内容'))
    expect(view.indexOf('接下来的安排')).toBeLessThan(view.indexOf('活动与内容'))
    expect(view.indexOf('最近积分')).toBeLessThan(view.indexOf('活动与内容'))
  })

  it('rechecks the server-approved internal path and never directly executes an external target', () => {
    const page = read('miniprogram/pages/profile/index.js')
    const view = read('miniprogram/pages/profile/index.wxml')
    expect(page).toContain('CONTENT_CARD_SIMPLE_TARGETS')
    expect(page).toContain("value.match(/^\\/pages\\/community-detail\\/index\\?id=([^&#]+)$/)")
    expect(page).toContain("wx.showToast({ title: '该内容暂不支持跳转'")
    expect(page).toContain('safeContentCardTarget(card.targetPath)')
    expect(page).not.toMatch(/wx\.(?:navigateTo|switchTab)\(\{\s*url:\s*(?:item|card)\.targetPath/)
    expect(view).toContain('wx:if="{{item.hasTarget}}"')
    expect(view).toContain('{{item.ctaLabel}}')
  })

  it.each([320, 390])('uses a compact horizontal card rail at %ipx without reducing action targets', (viewportWidth) => {
    const view = read('miniprogram/pages/profile/index.wxml')
    const css = read('miniprogram/pages/profile/index.wxss')
    const cardWidthRpx = 420
    const cardWidth = viewportWidth * cardWidthRpx / 750
    expect(cardWidth).toBeLessThan(viewportWidth - 40)
    expect(view).toContain('<scroll-view scroll-x enhanced')
    expect(css).toMatch(/\.member-content-copy button \{[^}]*min-height: 88rpx;/s)
    expect(css).toMatch(/\.member-content-title \{[^}]*-webkit-line-clamp: 2;/s)
    expect(css).toMatch(/\.member-content-summary \{[^}]*-webkit-line-clamp: 2;/s)
    expect(`${view}\n${read('miniprogram/pages/profile/index.js')}`).not.toMatch(/开始录音|wx\.getRecorderManager|voice\/transcribe/)
  })
})
