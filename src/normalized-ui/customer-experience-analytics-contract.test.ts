import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const projectRoot = new URL('../../', import.meta.url)
const read = (path: string) => readFileSync(new URL(path, projectRoot), 'utf8')

describe('customer experience analytics presentation contract', () => {
  it('labels authoritative outcomes separately from non-causal later-order facts', () => {
    const panel = read('src/normalized-ui/CustomerExperienceAnalyticsPanel.tsx')
    expect(panel).toContain('推荐结果（仅推荐）')
    expect(panel).toContain('<option value="complaint">有订单投诉</option>')
    expect(panel).toContain('<option value="follow_on_order">同桌后续付款</option>')
    expect(panel).toContain('<option value="repeat_purchase">后续同品复购</option>')
    expect(panel).toContain('只是订单事实，不代表由本次推荐造成')
    expect(panel).toContain('只有明确关联本人订单的投诉才计入')
    expect(panel).not.toMatch(/推荐导致.*(?:复购|加单)|推荐带来.*(?:复购|加单)/)
  })

  it('shows recommendation contribution and missing-authority categories without guessing', () => {
    const panel = read('src/normalized-ui/CustomerExperienceAnalyticsPanel.tsx')
    expect(panel).toContain('推荐未记录展示')
    expect(panel).toContain('实付推荐缺冻结成本')
    expect(panel).toContain('投诉未关联本人订单')
    expect(panel).toContain("row.contributionAmountMinor===null ? '数据不足'")
    expect(panel).toContain('移除/拒绝')
    expect(panel).toContain('员工调整')
  })

  it('keeps filters and facts usable on narrow management screens', () => {
    const panel = read('src/normalized-ui/CustomerExperienceAnalyticsPanel.tsx')
    const css = read('src/normalized-ui/customer-experience-analytics-panel.css')
    expect(panel).toContain('套餐（强订单行）')
    expect(panel).toContain('packageProductId')
    expect(panel).toContain('来店场景（同桌事实）')
    expect(panel).toContain('<option value="friends">朋友聚会</option>')
    expect(panel).toContain('客群（暂不可用）')
    expect(panel).toContain('缺事件时点分群事实')
    expect(panel).not.toContain('来店场景（仅推荐）')
    expect(css).toContain('.ce-analytics__recommendation-table { min-width: 1180px !important; }')
    expect(css).toContain('overflow-x: auto')
    expect(css).toContain('@media (max-width: 390px)')
    expect(css).toContain('@media (max-width: 340px)')
    expect(css).toContain('.ce-analytics__filters { grid-template-columns: 1fr; }')
  })

  it('states the authority boundary instead of guessing package or customer segment facts', () => {
    const panel = read('src/normalized-ui/CustomerExperienceAnalyticsPanel.tsx')
    expect(panel).toContain('view.filterCapabilities.occasion.basis')
    expect(panel).toContain('view.filterCapabilities.package.basis')
    expect(panel).toContain('view.filterCapabilities.customerSegment.reason')
    expect(panel).not.toMatch(/customerSnapshot|membership_snapshot|product_snapshot/)
  })
})
