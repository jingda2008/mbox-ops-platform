import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { clientValidationError } from './validation-error.js'

describe('client validation errors', () => {
  it('turns an empty assisted-order table into an actionable Chinese message', () => {
    const schema = z.object({ tableId: z.string().min(1) })
    const parsed = schema.safeParse({ tableId: '' })
    if (parsed.success) throw new Error('expected validation failure')

    expect(clientValidationError(parsed.error)).toEqual({
      code: 'VALIDATION_ERROR',
      message: '未选择桌台；如桌台尚未开台，请先开台后再下单',
      details: { field: 'tableId' },
    })
  })

  it('does not expose library validation text for unknown fields', () => {
    const schema = z.object({ note: z.string().min(2) })
    const parsed = schema.safeParse({ note: '' })
    if (parsed.success) throw new Error('expected validation failure')

    expect(clientValidationError(parsed.error).message).toBe('提交信息不完整，请检查必填内容后重试')
  })
})
