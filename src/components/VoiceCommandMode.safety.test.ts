import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./VoiceCommandMode.tsx', import.meta.url), 'utf8')

describe('AI assistant execution safety', () => {
  it('never falls back to simulated page execution after assistant planning fails', () => {
    expect(source).not.toContain('我已切换到快速命令')
    expect(source).toContain('本次没有执行任何操作，请重试或返回岗位页面手动处理。')
    const failureHandler = source.slice(source.indexOf('async function submitAssistantMessage'), source.indexOf('function selectAmbiguousCandidate'))
    expect(failureHandler).not.toContain('prepareCommand(message)')
  })

  it('labels server-confirmed execution separately from page interaction', () => {
    expect(source).toContain("if (step.action === 'execute_server_tool') return '已由服务端确认'")
    expect(source).toContain('每一步都会重新核对岗位权限和门店最新状态')
  })
})
