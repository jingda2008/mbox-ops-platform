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
    expect(page).toContain('.slice(0, 2)')
    expect(view).toContain('wx:if="{{upcomingActivity || editorialCards.length}}"')
    expect(view).toContain('bindtap="openFeaturedActivity"')
    expect(view).toContain('bindtap="openEditorial"')
    expect(view).not.toContain('从1999开始')
  })

  it('keeps the customer journey primary and hides the entire editorial section when nothing is published',()=>{
    const view=read('miniprogram/pages/home/index.wxml')
    expect(view.indexOf('当前状态')).toBeLessThan(view.indexOf('发现 M-BOX'))
    expect(view).toContain('bindtap="openMenu"')
    expect(view).toContain('wx:if="{{upcomingActivity || editorialCards.length}}"')
  })

  it('lets authorized staff draft, publish and pause homepage content without a mini-program release',()=>{
    const panel=read('src/normalized-ui/HomeContentManagementPanel.tsx')
    const app=read('server/normalized/normalized-app.ts')
    expect(panel).toContain("auth.permissions.includes('community.activity.manage')")
    expect(panel).toContain("auth.permissions.includes('community.activity.publish')")
    expect(panel).toContain('/api/staff/home-content-cards')
    expect(panel).toContain("operation:'publish'|'pause'")
    expect(app).toContain('memberContentCardApiPlugin')
  })
})
