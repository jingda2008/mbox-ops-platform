import { describe, expect, it } from 'vitest'
import { dutyManagerActionSchema } from './assistant-contracts.js'

describe('duty manager action contracts', () => {
  const base = {
    idempotencyKey: '00000000-0000-4000-8000-000000000201',
    riskIds: ['duty_risk_1'],
  }

  it('accepts bounded acknowledgement and deferral actions', () => {
    expect(dutyManagerActionSchema.parse({ ...base, action: 'acknowledge' })).toMatchObject({ action: 'acknowledge' })
    expect(dutyManagerActionSchema.parse({ ...base, action: 'defer', deferMinutes: 10 })).toMatchObject({ deferMinutes: 10 })
  })

  it('requires a review reason before dismissing a risk as false positive', () => {
    expect(() => dutyManagerActionSchema.parse({ ...base, action: 'dismiss_false_positive' })).toThrow('标记误报必须记录复核原因')
    expect(dutyManagerActionSchema.parse({
      ...base, action: 'dismiss_false_positive', note: '经理现场复核为误报',
    })).toMatchObject({ action: 'dismiss_false_positive' })
  })
})
