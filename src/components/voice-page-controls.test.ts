import { describe, expect, it } from 'vitest'
import {
  canConfirmVoicePageStateChange,
  classifyVoicePageRisk,
  planVoicePageCommand,
  requiresExplicitVoiceFeedback,
  type VoicePageControl,
  type VoicePageStateSnapshot,
} from './voice-page-controls'

function control(overrides: Partial<VoicePageControl> & Pick<VoicePageControl, 'id' | 'kind' | 'label'>): VoicePageControl {
  return {
    context: '现场桌台',
    displayName: `现场桌台 · ${overrides.label}`,
    zone: 'page',
    disabled: false,
    generatedLabel: false,
    sensitive: false,
    risk: 'normal',
    ...overrides,
  }
}

describe('planVoicePageCommand', () => {
  it('maps an exact button command to the original page control', () => {
    const controls = [control({ id: 'open-table', kind: 'button', label: '立即开台' })]
    expect(planVoicePageCommand('点击立即开台', controls)).toMatchObject({
      kind: 'ready',
      controlId: 'open-table',
      action: 'activate',
      risk: 'normal',
    })
  })

  it('fills a named text or number field', () => {
    const controls = [control({ id: 'party-size', kind: 'input', label: '人数' })]
    expect(planVoicePageCommand('人数输入4', controls)).toMatchObject({
      kind: 'ready',
      controlId: 'party-size',
      action: 'set_value',
      value: '4',
    })
  })

  it('selects a valid option by its spoken label', () => {
    const controls = [control({
      id: 'channel',
      kind: 'select',
      label: '现场收费方式',
      options: [
        { label: '物理POS', value: 'physical_pos', disabled: false },
        { label: '现金', value: 'cash', disabled: false },
      ],
    })]
    expect(planVoicePageCommand('现场收费方式选择现金', controls)).toMatchObject({
      kind: 'ready',
      controlId: 'channel',
      action: 'select_option',
      value: 'cash',
      optionLabel: '现金',
    })
  })

  it('treats “选择桌台” as a button target when there is no matching select field', () => {
    const controls = [
      control({ id: 'nav-live', kind: 'button', label: '我的桌台', zone: 'navigation' }),
      control({ id: 'table-l04', kind: 'button', label: 'L04 休闲04 可开台', displayName: '桌台责任区 · L04 休闲04 可开台' }),
    ]

    expect(planVoicePageCommand('选择桌台 L04', controls)).toMatchObject({
      kind: 'ready',
      controlId: 'table-l04',
      action: 'activate',
    })
  })

  it('requires high-risk confirmation for financial actions', () => {
    const controls = [control({ id: 'refund', kind: 'button', label: '确认退款', risk: 'high' })]
    expect(planVoicePageCommand('确认退款', controls)).toMatchObject({
      kind: 'ready',
      controlId: 'refund',
      risk: 'high',
    })
  })

  it('does not allow voice entry into sensitive fields', () => {
    const controls = [control({ id: 'pin', kind: 'input', label: '员工PIN', sensitive: true })]
    expect(planVoicePageCommand('员工PIN输入1234', controls)).toEqual({
      kind: 'blocked',
      message: '“现场桌台 · 员工PIN”属于敏感字段，请在原页面手工输入。',
    })
  })

  it('reports disabled controls instead of clicking through validation', () => {
    const controls = [control({ id: 'submit', kind: 'button', label: '确认提交', disabled: true })]
    expect(planVoicePageCommand('点击确认提交', controls)).toEqual({
      kind: 'blocked',
      message: '“现场桌台 · 确认提交”当前不可用，请先完成页面要求的前置信息。',
    })
  })

  it('asks for context when duplicate button names are present', () => {
    const controls = [
      control({ id: 'save-product', kind: 'button', label: '保存', context: '商品配置', displayName: '商品配置 · 保存' }),
      control({ id: 'save-shift', kind: 'button', label: '保存', context: '班次配置', displayName: '班次配置 · 保存' }),
    ]
    expect(planVoicePageCommand('点击保存', controls)).toMatchObject({
      kind: 'ambiguous',
      candidates: [
        { id: 'save-shift', label: '班次配置 · 保存', command: '点击班次配置 · 保存' },
        { id: 'save-product', label: '商品配置 · 保存', command: '点击商品配置 · 保存' },
      ],
    })
    expect(planVoicePageCommand('点击商品配置保存', controls)).toMatchObject({
      kind: 'ready',
      controlId: 'save-product',
    })
  })

  it('uses the canonical navigation control when a page shortcut has the same label', () => {
    const controls = [
      control({ id: 'nav-live', kind: 'button', label: '现场调度', zone: 'navigation', displayName: '岗位工作台 · 现场调度' }),
      control({ id: 'home-live', kind: 'button', label: '现场调度', zone: 'page', displayName: '店长工作台 · 现场调度' }),
    ]
    expect(planVoicePageCommand('打开现场调度', controls)).toMatchObject({
      kind: 'ready',
      controlId: 'nav-live',
    })
  })

  it('does not require double confirmation merely because a navigation label names a risky module', () => {
    const controls = [control({ id: 'nav-payments', kind: 'button', label: '收银与退款', zone: 'navigation', risk: 'normal' })]
    expect(planVoicePageCommand('点击收银与退款', controls)).toMatchObject({
      kind: 'ready',
      controlId: 'nav-payments',
      risk: 'normal',
    })
  })
})

describe('classifyVoicePageRisk', () => {
  it('keeps module navigation and disclosure controls out of the financial risk class', () => {
    expect(classifyVoicePageRisk('收银与退款', { zone: 'navigation' })).toBe('normal')
    expect(classifyVoicePageRisk('岗位与权限', { safeDisclosure: true })).toBe('normal')
  })

  it('requires double confirmation for state-changing business and configuration actions', () => {
    expect(classifyVoicePageRisk('确认转桌')).toBe('high')
    expect(classifyVoicePageRisk('确认退款')).toBe('high')
    expect(classifyVoicePageRisk('保存权益配置')).toBe('high')
    expect(classifyVoicePageRisk('刷新预约')).toBe('normal')
  })
})

describe('requiresExplicitVoiceFeedback', () => {
  it('requires positive outcome evidence for business mutations and every high-risk activation', () => {
    expect(requiresExplicitVoiceFeedback('立即开台', 'activate', 'normal')).toBe(true)
    expect(requiresExplicitVoiceFeedback('保存员工', 'activate', 'high')).toBe(true)
    expect(requiresExplicitVoiceFeedback('确认退款', 'activate', 'high')).toBe(true)
  })

  it('allows visible UI transitions and field changes to use immediate state evidence', () => {
    expect(requiresExplicitVoiceFeedback('L04 休闲04 可开台', 'activate', 'normal')).toBe(false)
    expect(requiresExplicitVoiceFeedback('人数', 'set_value', 'normal')).toBe(false)
    expect(requiresExplicitVoiceFeedback('销售归属', 'select_option', 'normal')).toBe(false)
  })
})

describe('canConfirmVoicePageStateChange', () => {
  const before: VoicePageStateSnapshot = { heading: '现场桌台', feedback: [], stateSignature: 'before', busy: false }

  it('accepts a stable UI state change for low-risk navigation', () => {
    expect(canConfirmVoicePageStateChange(
      before,
      { ...before, stateSignature: 'after' },
      false,
    )).toBe(true)
  })

  it('never treats a generic UI change as explicit business completion evidence', () => {
    expect(canConfirmVoicePageStateChange(
      before,
      { ...before, stateSignature: 'after' },
      true,
    )).toBe(false)
  })

  it('waits while the changed page is still busy', () => {
    expect(canConfirmVoicePageStateChange(
      before,
      { ...before, stateSignature: 'after', busy: true },
      false,
    )).toBe(false)
  })
})
