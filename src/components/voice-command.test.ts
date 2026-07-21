import { describe, expect, it } from 'vitest'
import type { RoleHomeNavigationId } from './role-access'
import { dutyRiskNavigationTarget, resolveVoiceCommand, voiceSuggestionsForNavigation } from './voice-command'

const serverNavigation: RoleHomeNavigationId[] = ['live', 'tasks', 'commerce', 'benefits', 'songs']

describe('resolveVoiceCommand', () => {
  it('routes a table action to the existing live workspace without executing it', () => {
    expect(resolveVoiceCommand('K2 开台', serverNavigation)).toEqual({
      kind: 'ready',
      target: 'live',
      label: '现场桌台',
      protectedActionRequested: true,
      summary: '先打开现场桌台并定位操作；涉及业务状态变更时仍需在原页面核对并确认。',
    })
  })

  it('marks ordinary navigation as complete only when no business action was requested', () => {
    expect(resolveVoiceCommand('打开现场桌台', serverNavigation)).toMatchObject({
      kind: 'ready',
      target: 'live',
      protectedActionRequested: false,
    })
  })

  it('routes natural task wording for frontline staff', () => {
    expect(resolveVoiceCommand('看看我现在要处理什么', serverNavigation)).toMatchObject({
      kind: 'ready',
      target: 'tasks',
    })
  })

  it('rejects navigation outside the current employee permissions', () => {
    expect(resolveVoiceCommand('帮我打开退款', serverNavigation)).toEqual({
      kind: 'denied',
      target: 'payments',
      label: '收银与支付',
    })
  })

  it('routes performance requests when the role can access songs', () => {
    expect(resolveVoiceCommand('打开今晚演出安排', serverNavigation)).toMatchObject({
      kind: 'ready',
      target: 'songs',
    })
  })

  it('does not guess when no deterministic route matches', () => {
    expect(resolveVoiceCommand('帮我照顾好这桌客人', serverNavigation)).toEqual({ kind: 'unknown' })
  })
})

describe('voiceSuggestionsForNavigation', () => {
  it('only exposes suggestions that the current employee may open', () => {
    const suggestions = voiceSuggestionsForNavigation(['tasks', 'commerce'])
    expect(suggestions.map((item) => item.target)).toEqual(['tasks', 'commerce'])
  })
})

describe('dutyRiskNavigationTarget', () => {
  it('routes operational alerts to a deterministic handling workspace', () => {
    expect(dutyRiskNavigationTarget('reservation')).toBe('reservations')
    expect(dutyRiskNavigationTarget('service')).toBe('tasks')
    expect(dutyRiskNavigationTarget('fulfillment')).toBe('commerce')
    expect(dutyRiskNavigationTarget('hardware')).toBe('devices')
  })
})
