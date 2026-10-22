import {describe,it,expect} from 'vitest'
import type {ActivityServiceLine} from '../../shared/activity-service'
import {activityAvailable,activityBatchDraft,activityBatchCurrent,activityBatchCommand} from './activity-production-state'
const line=(patch:Partial<ActivityServiceLine>={}):ActivityServiceLine=>({id:'line-1',taskId:'task-1',registrationPublicId:'reg-1',mealId:'meal-1',number:12,location:'A区',productId:'p-1',name:'果汁',station:'bar',quantity:5,startedQuantity:5,readyQuantity:3,takenQuantity:1,version:4,status:'active',createdAt:'2026-10-22T10:00:00Z',...patch})
describe('活动实际批次',()=>{
  it('饮品先取只结实际数量，保留未完成菜品',()=>{
    const lines=[line(),line({id:'line-2',station:'kitchen',readyQuantity:0,takenQuantity:0})]
    const draft=activityBatchDraft(lines,'take',12)
    draft.lines[0]!.quantity=1
    expect(activityBatchCommand(draft)).toEqual({action:'take',lines:[{lineId:'line-1',quantity:1,expectedVersion:4}]})
    expect(activityAvailable(lines[0]!,'take')).toBe(2)
  })
  it('刷新不把新增单加入正在核对的批次，其他人取过后原选择失效',()=>{
    const draft=activityBatchDraft([line()],'take',12)
    expect(activityBatchCurrent(draft,[line(),line({id:'new-addon'})])).toBe(true)
    expect(activityBatchCommand(draft)?.lines).toHaveLength(1)
    expect(activityBatchCurrent(draft,[line({version:5,takenQuantity:2})])).toBe(false)
  })
  it('停止、越量、空批次以及不同餐号不被提交',()=>{
    expect(activityAvailable(line({held:true}),'take')).toBe(0)
    expect(activityAvailable(line({startedQuantity:2,stoppedQuantity:3}),'start')).toBe(0)
    expect(activityAvailable(line({discardedReadyQuantity:1}),'take')).toBe(1)
    const draft=activityBatchDraft([line({status:'cancelled'}),line({number:13})],'take',12)
    expect(activityBatchCommand(draft)).toBeNull()
    const active=activityBatchDraft([line()],'take',12)
    active.lines[0]!.quantity=3
    expect(activityBatchCommand(active)).toBeNull()
    active.lines[0]!.quantity=0
    expect(activityBatchCommand(active)).toBeNull()
  })
})
