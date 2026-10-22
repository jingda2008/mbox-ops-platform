import {describe,it,expect} from 'vitest'
import type {ActivityServiceLine} from '../../shared/activity-service'
import {activityExceptionDraft,activityExceptionRemaining} from './activity-service-exception-state'
const line=(patch:Partial<ActivityServiceLine>={}):ActivityServiceLine=>({id:'10000000-0000-4000-8000-000000000001',taskId:'task',registrationPublicId:'reg',mealId:'meal',number:12,location:null,productId:'product',name:'热菜',station:'kitchen',quantity:10,startedQuantity:6,readyQuantity:4,takenQuantity:2,stoppedQuantity:1,discardedReadyQuantity:1,remadeTakenQuantity:1,version:3,status:'active',createdAt:'2026-10-22T10:00:00Z',...patch})
const draft={action:'cancel_unmade' as const,version:3,quantity:3,reason:'顾客取消尚未制作的部分',remakeFrom:'ready' as const,goodsLost:false}
describe('管理者出餐异常的真实剩余与原记录',()=>{
  it('已停做、已损耗和已补做不能再次计入可处理份数',()=>{
    expect(activityExceptionRemaining(line())).toEqual({unmade:3,ready:1,taken:1})
    expect(activityExceptionDraft(line(),draft)).toMatchObject({action:'cancel_unmade',quantity:3,expectedVersion:3})
    expect(activityExceptionDraft(line(),{...draft,quantity:4})).toBeNull()
    expect(activityExceptionDraft(line(),{...draft,action:'remake',goodsLost:true,quantity:2})).toBeNull()
    expect(activityExceptionDraft(line(),{...draft,action:'remake',goodsLost:true,remakeFrom:'taken',quantity:2})).toBeNull()
  })
  it('过期版本、非整数、取消明细及缺少理由都不能成为新操作',()=>{
    expect(activityExceptionDraft(line({version:4}),draft)).toBeNull()
    expect(activityExceptionDraft(line(),{...draft,quantity:1.5})).toBeNull()
    expect(activityExceptionDraft(line({status:'cancelled'}),draft)).toBeNull()
    expect(activityExceptionDraft(line(),{...draft,reason:''})).toBeNull()
  })
  it('补做必须确认实物损耗，保留原取走事实和环节',()=>{
    expect(activityExceptionDraft(line(),{...draft,action:'remake',quantity:1})).toBeNull()
    const original=line()
    expect(activityExceptionDraft(original,{...draft,action:'remake',quantity:1,remakeFrom:'taken',goodsLost:true})).toEqual({action:'remake',lineId:original.id,expectedVersion:3,quantity:1,reason:draft.reason,remakeFrom:'taken',goodsLost:true})
    expect(original.takenQuantity).toBe(2)
  })
  it('暂停后只能恢复原剩余，恢复命令不携带伪造制作或送达数量',()=>{
    expect(activityExceptionDraft(line({held:true}),{...draft,action:'hold'})).toBeNull()
    expect(activityExceptionDraft(line(),{...draft,action:'resume'})).toBeNull()
    expect(activityExceptionDraft(line({held:true}),{...draft,action:'resume'})).toEqual({action:'resume',lineId:line().id,expectedVersion:3,reason:draft.reason})
  })
})
