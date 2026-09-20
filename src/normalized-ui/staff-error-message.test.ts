import { describe, expect, it } from 'vitest'
import { staffErrorMessage, staffUnavailableMessage } from '../shared/staff-error-message'

describe('staff-facing error boundary',()=>{
  it('preserves useful business instructions including amounts',()=>expect(staffErrorMessage('本桌位置已变化，请刷新后重新确认转桌','待核对',409)).toBe('本桌位置已变化，请刷新后重新确认转桌'))
  it.each(['Voucher already redeemed','PAYMENT_INTERNAL_ERROR','查询失败：SELECT password FROM staff','TypeError: Cannot read property'])('does not render technical details: %s',value=>expect(staffErrorMessage(value,'操作结果待核对',400)).toBe('操作结果待核对'))
  it('keeps server failures unknown, even if the raw message claims failure',()=>expect(staffErrorMessage('事务失败，请重新建立付款','结果尚未确认，请核对原操作',500)).toBe('结果尚未确认，请核对原操作'))
  it.each(['GET','head'])('does not imply an uncertain write for a failed %s read',method=>expect(staffUnavailableMessage(method)).toBe('读取失败，请刷新重试'))
  it.each(['POST','PATCH','DELETE'])('keeps a failed %s write unknown',method=>expect(staffUnavailableMessage(method)).toContain('结果尚未确认'))
})
