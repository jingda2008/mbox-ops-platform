import { readFile } from 'node:fs/promises'
import { describe,expect,it } from 'vitest'

describe('recommendation policy management UI contract',()=>{
  it('exposes a mobile-safe three-person workflow and an independent rollout control',async()=>{
    const [panel,css,host]=await Promise.all([
      readFile(new URL('./RecommendationPolicyManagementPanel.tsx',import.meta.url),'utf8'),
      readFile(new URL('./recommendation-policy-management-panel.css',import.meta.url),'utf8'),
      readFile(new URL('./CustomerExperienceManagementPanel.tsx',import.meta.url),'utf8'),
    ])
    expect(panel).toContain("auth.permissions.includes('recommendation.rule.view')")
    expect(panel).toContain("auth.permissions.includes('recommendation.rule.draft')")
    expect(panel).toContain("auth.permissions.includes('recommendation.rule.approve')")
    expect(panel).toContain("auth.permissions.includes('recommendation.rule.publish')")
    expect(panel).toContain('规则版本和顾客试点为两个独立动作')
    expect(panel).toContain("performanceWeight:0,inventoryWeight:0,capacityWeight:0")
    expect(panel).toContain('/features/recommendation.engine')
    expect(panel).toContain('/clone-draft')
    expect(panel).not.toContain('JSON.stringify(draft')
    expect(css).toContain('min-height:44px')
    expect(css).toMatch(/@media\(max-width:420px\)/)
    expect(host).toContain('<RecommendationPolicyManagementPanel api={api} auth={auth} />')
  })
})
