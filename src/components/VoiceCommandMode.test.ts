import { describe, expect, it } from 'vitest'
import { assistantPageCapabilities } from './assistant-page-capabilities'
import type { VoicePageControl } from './voice-page-controls'

function control(overrides: Partial<VoicePageControl> = {}): VoicePageControl {
  return {
    id: 'control-1',
    kind: 'input',
    label: '桌台备注',
    context: '开台表单',
    displayName: '开台表单 · 桌台备注',
    zone: 'page',
    disabled: false,
    generatedLabel: false,
    sensitive: false,
    risk: 'normal',
    value: '客人手机号和私人备注',
    ...overrides,
  }
}

describe('assistantPageCapabilities', () => {
  it('never sends field values or sensitive controls to the model', () => {
    const capabilities = assistantPageCapabilities([
      control(),
      control({ id: 'pin', label: '员工PIN', displayName: '员工PIN', sensitive: true, value: '1234' }),
    ])

    expect(capabilities).toHaveLength(1)
    expect(JSON.stringify(capabilities)).not.toContain('客人手机号')
    expect(JSON.stringify(capabilities)).not.toContain('1234')
    expect(capabilities[0]).toMatchObject({ command: '在开台表单 · 桌台备注输入内容' })
  })
})
