import {describe,expect,it} from 'vitest'
import {kitchenAllocation,kitchenDraftAfterReady,kitchenGroups,kitchenReadySelection,kitchenSelectionCurrent} from './kitchen-board-state'
import type {KitchenPendingItem,KitchenBatchUnit} from '../../shared/kitchen-production'
const pending=(id:string,time:string,note=''):KitchenPendingItem=>({taskId:id,tableId:`table-${id}`,tableSessionId:`session-${id}`,tableCode:id,locationVersion:0,orderPublicId:`order-${id}`,orderCreatedAt:time,itemId:`item-${id}`,productId:'fries',productName:'薯条',specification:'大份',itemNote:note,orderNote:'',unmade:2,canPrepare:true})
const unit=(id:string,taskId:string):KitchenBatchUnit=>({...pending(taskId,'2026-09-20T10:00:00Z'),unitId:id,state:'started',held:false,stopped:false,originalTableCode:taskId})
describe('kitchen order and portion intent',()=>{
  it('groups only compatible notes, allocates oldest orders and does not mutate a frozen allocation when a new order arrives',()=>{
    const a=pending('T01','2026-09-20T10:00:00Z'),b=pending('T02','2026-09-20T10:01:00Z'),different=pending('T03','2026-09-20T10:02:00Z','不要盐')
    const groups=kitchenGroups([b,different,a]);expect(groups).toHaveLength(2)
    const chosen=kitchenAllocation(groups[0]!.items,3);expect(chosen.map(row=>[row.taskId,row.quantity,row.expectedUnmade])).toEqual([['T01',2,2],['T02',1,2]])
    kitchenGroups([a,b,different,pending('T04','2026-09-20T10:03:00Z')]);expect(chosen.map(row=>row.taskId)).toEqual(['T01','T02'])
  })
  it('keeps selections from another page and never transfers a selection to another original portion',()=>{
    const first=kitchenReadySelection([unit('a','T01'),unit('b','T01')],1)!,fifth=kitchenReadySelection([unit('e','T05')],1)!
    const after=kitchenDraftAfterReady({T01:first,T05:fifth},[fifth]);expect(after).toEqual({T01:first})
    expect(kitchenSelectionCurrent(first,[unit('b','T01')])).toBe(false)
    expect(kitchenSelectionCurrent(first,[{...unit('a','T01'),locationVersion:2}])).toBe(false)
    expect(kitchenSelectionCurrent(first,[{...unit('a','T01'),held:true}])).toBe(false)
    expect(kitchenSelectionCurrent(first,[unit('a','T01')])).toBe(true)
  })
  it('does not silently lower quantity or include unavailable or unowned portions',()=>{
    expect(kitchenAllocation([{...pending('T01','2026-09-20T10:00:00Z'),canPrepare:false}],1)).toEqual([])
    expect(kitchenAllocation([pending('T01','2026-09-20T10:00:00Z')],3)).toEqual([])
    expect(kitchenReadySelection([{...unit('a','T01'),held:true},unit('b','T01')],2)).toBeNull()
  })
})
