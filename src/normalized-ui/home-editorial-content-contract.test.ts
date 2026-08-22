import { readFileSync } from 'node:fs'
import { describe,expect,it } from 'vitest'

const root=new URL('../../',import.meta.url)
const read=(path:string)=>readFileSync(new URL(path,root),'utf8')

describe('mini-program home editorial content',()=>{
  it('uses already-published activity and content projections instead of hard-coded campaigns',()=>{
    const page=read('miniprogram/pages/home/index.js')
    const view=read('miniprogram/pages/home/index.wxml')
    expect(page).toContain('bootstrap.activities')
    expect(page).toContain('bootstrap.content')
    expect(page).toContain("item.displayMode === 'pinned'")
    expect(page).toContain('CONTENT_ROTATION_WINDOW_MS')
    expect(page).toContain('return pinned.concat(rotating[rotationIndex])')
    expect(view).toContain('wx:if="{{upcomingActivity || editorialCards.length}}"')
    expect(view).toContain('bindtap="openFeaturedActivity"')
    expect(view).toContain('bindtap="openEditorial"')
    expect(view).toContain('class="published-content-card')
    expect(view).not.toContain('home-campaign-mask')
    expect(page).not.toContain('wx.showModal({ title: card.title')
    expect(view).not.toContain('从1999开始')
  })

  it('keeps the customer journey primary, leaves menu access in the tab bar, and hides unpublished editorial content',()=>{
    const view=read('miniprogram/pages/home/index.wxml')
    const app=read('miniprogram/app.json')
    expect(view.indexOf('今晚现场')).toBeLessThan(view.indexOf('当前状态'))
    expect(view.indexOf('当前状态')).toBeLessThan(view.indexOf('发现 M-BOX'))
    expect(view).not.toContain('home-menu-entry')
    expect(app).toContain('"pagePath": "pages/order/index"')
    expect(app).toContain('"text": "点单"')
    expect(view).toContain('wx:if="{{upcomingActivity || editorialCards.length}}"')
  })

  it('projects live status, the full evening schedule, performer profile and a compact monthly entry',()=>{
    const page=read('miniprogram/pages/home/index.js')
    const view=read('miniprogram/pages/home/index.wxml')
    expect(page).toContain('(view.schedules || [])')
    expect(page).toContain("current ? '正在演出' : '即将开始'")
    expect(page).toContain("item.type === 'show'")
    expect(view).toContain('bindtap="openTonightSchedule"')
    expect(view).toContain('bindtap="openPerformerProfile"')
    expect(view).toContain('bindtap="openMonthlyPerformance"')
    expect(view).toContain('wx:for="{{performance.schedules}}"')
    expect(view).toContain('performance-shortcuts')
  })

  it('carries the forest palette through ordering and account controls while preserving WeChat green for checkout',()=>{
    const appStyle=read('miniprogram/app.wxss')
    const orderStyle=read('miniprogram/pages/order/index.wxss')
    const accountStyle=read('miniprogram/pages/account/index.wxss')
    expect(appStyle).toContain('linear-gradient(145deg, #315d46, #214635)')
    expect(orderStyle).toContain('background: #315d46')
    expect(orderStyle).toContain('linear-gradient(145deg, #315d46, #214635)')
    expect(accountStyle).toContain('border: 1rpx solid #315d46')
  })

  it('lets authorized staff draft, publish and pause homepage content without a mini-program release',()=>{
    const panel=read('src/normalized-ui/HomeContentManagementPanel.tsx')
    const app=read('server/normalized/normalized-app.ts')
    expect(panel).toContain("auth.permissions.includes('community.activity.manage')")
    expect(panel).toContain("auth.permissions.includes('community.activity.publish')")
    expect(panel).toContain('/api/staff/home-content-cards')
    expect(panel).toContain("operation:'publish'|'pause'")
    expect(panel).toContain('常驻首页')
    expect(panel).toContain('轮换展示')
    expect(app).toContain('memberContentCardApiPlugin')
  })
})
