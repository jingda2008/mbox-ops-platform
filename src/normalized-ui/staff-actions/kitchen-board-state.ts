import {kitchenCompatibilityKey,type KitchenPendingItem,type KitchenStartSelection,type KitchenBatchUnit,type KitchenCommand} from '../../shared/kitchen-production'

export function kitchenGroups(items:KitchenPendingItem[]){
  const groups=new Map<string,{key:string;name:string;notes:string;items:KitchenPendingItem[];total:number;anchor:string}>()
  for(const item of [...items].sort((a,b)=>Date.parse(a.orderCreatedAt)-Date.parse(b.orderCreatedAt)||a.taskId.localeCompare(b.taskId))){
    const key=kitchenCompatibilityKey(item)
    const group=groups.get(key)??{key,name:item.productName,notes:[item.specification,item.itemNote,item.orderNote].filter(Boolean).join(' · '),items:[],total:0,anchor:item.orderCreatedAt}
    group.items.push(item);group.total+=item.unmade;groups.set(key,group)
  }
  return [...groups.values()]
}
/** Allocation is saved at selection time. Polls never replace the original intent. */
export function kitchenAllocation(items:KitchenPendingItem[],quantity:number):KitchenStartSelection[]{
  if(!Number.isSafeInteger(quantity)||quantity<1)return []
  let remaining=quantity
  const chosen:KitchenStartSelection[]=[]
  for(const item of items){if(!item.canPrepare||remaining<=0||chosen.length>=50)continue
    const count=Math.min(remaining,item.unmade)
    chosen.push({taskId:item.taskId,quantity:count,expectedUnmade:item.unmade,tableId:item.tableId,tableSessionId:item.tableSessionId,locationVersion:item.locationVersion});remaining-=count
  }
  return remaining===0?chosen:[]
}
export type KitchenReadySelection=Extract<KitchenCommand,{action:'ready'}>['items'][number]
export function kitchenReadySelection(units:KitchenBatchUnit[],quantity:number):KitchenReadySelection|null{
  const valid=units.filter(unit=>unit.state==='started'&&!unit.held&&!unit.stopped)
  if(!Number.isSafeInteger(quantity)||quantity<1||quantity>valid.length)return null
  const first=valid[0]!
  return {taskId:first.taskId,tableId:first.tableId,tableSessionId:first.tableSessionId,locationVersion:first.locationVersion,unitIds:valid.slice(0,quantity).map(unit=>unit.unitId)}
}
export function kitchenSelectionCurrent(selection:KitchenReadySelection,units:KitchenBatchUnit[]):boolean{
  return selection.unitIds.length>0&&selection.unitIds.every(id=>units.some(unit=>unit.unitId===id&&unit.taskId===selection.taskId&&unit.tableId===selection.tableId&&unit.tableSessionId===selection.tableSessionId&&unit.locationVersion===selection.locationVersion&&unit.state==='started'&&!unit.held&&!unit.stopped))
}
export function kitchenDraftAfterReady(drafts:Record<string,KitchenReadySelection>,completed:KitchenReadySelection[]){
  const next={...drafts}
  for(const item of completed){const previous=next[item.taskId];if(!previous)continue
    const remaining=previous.unitIds.filter(id=>!item.unitIds.includes(id))
    if(remaining.length)next[item.taskId]={...previous,unitIds:remaining};else delete next[item.taskId]
  }
  return next
}
