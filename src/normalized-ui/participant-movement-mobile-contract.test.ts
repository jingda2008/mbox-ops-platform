import { readFileSync } from 'node:fs'
import { describe,expect,it } from 'vitest'

const read=(path:string) => readFileSync(new URL(path,import.meta.url),'utf8')

describe('participant movement mobile contract',() => {
  it('keeps split and merge as a three-step, permission-gated staff action',() => {
    const panel=read('./staff-actions/StaffActionsPanel.tsx')
    const sheet=read('./staff-actions/ParticipantMovementSheet.tsx')
    expect(panel).toContain("hasPermission(props.permissions,'table.participation.manage')")
    expect(sheet).toContain('下一步：执行前预检')
    expect(sheet).toContain('基础条件已核对，提交时仍检查未结业务')
    expect(sheet).toContain('确认执行')
    expect(sheet).toContain("kind==='participant_merge' && participants.length>0")
    expect(sheet).toContain('全员并桌必须选择源桌全部已识别顾客')
  })

  it('shows safe identity cues and does not expose customer ids or contacts',() => {
    const sheet=read('./staff-actions/ParticipantMovementSheet.tsx')
    expect(sheet).toContain("reservation_owner:'预约人'")
    expect(sheet).toContain("unknown:'角色待确认'")
    expect(sheet).toContain('无座位标签，请逐人确认')
    expect(sheet).toContain('index+1')
    expect(sheet).not.toContain('customerPublicId.slice')
    expect(sheet).not.toMatch(/phone|contactValue|openid/)
  })

  it('fits 320 and 390 widths and preserves the capacity override path',() => {
    const [sheet,css]=[read('./staff-actions/ParticipantMovementSheet.tsx'),read('./staff-actions/staff-actions-panel.css')]
    expect(sheet).toContain('needsCapacityReason')
    expect(sheet).toContain("target?.activeSession?.capacityAtOpen")
    expect(sheet).toContain('加座与安全说明')
    expect(sheet).toContain('capacityOverrideReason')
    expect(css).toContain('.staff-participant-sheet { width: min(100%, 620px)')
    expect(css).toContain('@media (max-width: 560px)')
    expect(css).toMatch(/staff-participant-sheet[^}]*width: 100%/)
    expect(css).toMatch(/staff-participant-sheet > header button[^}]*min-width: 44px[^}]*min-height: 44px/)
    expect(sheet).toContain('刷新名单并重新预检')
    expect(sheet).toContain('请先处理以下未结事项')
    expect(sheet).toContain("preview?.blockers.length")
  })
})
