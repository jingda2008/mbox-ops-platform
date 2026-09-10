import {describe,it,expect} from 'vitest'
import {orderHistoryAccess} from './order-history-access.js'
describe('operating history scope',()=>{
  it('limits ordinary staff at month/year boundaries and keeps finance a separate grant',()=>{
    expect(orderHistoryAccess(['order.history.view'],'2026-01-01')).toEqual({earliestBusinessDate:'2025-12-30',allowFinancialSummary:false})
    expect(orderHistoryAccess(['reconciliation.view'],'2026-09-10').earliestBusinessDate).toBe('2026-09-08')
    expect(orderHistoryAccess(['order.history.all'],'2026-09-10').earliestBusinessDate).toBeNull()
  })
  it('rejects invalid store dates instead of silently broadening history',()=>{
    for(const date of ['2026-02-30','not-a-date','2026-9-1'])expect(()=>orderHistoryAccess([],date)).toThrow()
  })
})
