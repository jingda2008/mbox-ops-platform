import { readFileSync } from 'node:fs'
import { describe,expect,it } from 'vitest'

describe('staff recommendation mobile contract',()=>{
  const component=readFileSync(new URL('./TableRecommendationSheet.tsx',import.meta.url),'utf8')
  const panel=readFileSync(new URL('./StaffActionsPanel.tsx',import.meta.url),'utf8')
  const css=readFileSync(new URL('./staff-actions-panel.css',import.meta.url),'utf8')

  it('keeps the action behind the dedicated permission and states the authority boundary',()=>{
    expect(panel).toContain("hasPermission(props.permissions, 'recommendation.staff.modify')")
    expect(component).toContain('只可在系统已经生成的方案间调整')
    expect(component).toContain('不代表顾客已下单')
    expect(component).not.toContain('<textarea')
  })

  it('uses a compact bottom sheet with touch-sized controls for 320 and 390 widths',()=>{
    expect(css).toMatch(/\.staff-recommendation-overlay[^}]*align-items:\s*flex-end/)
    expect(css).toMatch(/\.staff-recommendation-form select[^}]*min-height:\s*48px/)
    expect(css).toMatch(/\.staff-recommendation-form \.staff-primary-action[^}]*min-height:\s*50px/)
    expect(css).toContain('@media (max-width: 560px)')
    expect(css).toMatch(/\.staff-recommendation-sheet\s*\{\s*max-height:\s*96dvh/)
  })
})
