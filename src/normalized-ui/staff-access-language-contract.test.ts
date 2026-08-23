import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('staff access language contract', () => {
  it('keeps permission labels and default descriptions in Chinese while retaining codes only for internal data flow', () => {
    const source = readFileSync(new URL('./StaffAccessManagementPanel.tsx', import.meta.url), 'utf8')

    expect(source).toContain("'kds.prepare': '制作并完成出品'")
    expect(source).toContain("'fulfillment.view_all': '查看全店出品'")
    expect(source).toContain("return '按岗位配置此项操作权限。'")
    expect(source).toContain('containsChinese(configuredName)')
    expect(source).toContain("MANAGER: '店长'")
    expect(source).not.toContain("? code : configuredDescription")
  })
})
