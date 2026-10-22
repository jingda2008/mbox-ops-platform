import type {ActivityProductionCommand,ActivityServiceLine} from '../../shared/activity-service'

export type ActivityBatchAction='start'|'ready'|'take'
export interface ActivityBatchDraft {action:ActivityBatchAction;number:number;lines:Array<{id:string;version:number;name:string;station:string;max:number;quantity:number}>}
export function activityAvailable(line:ActivityServiceLine,action:ActivityBatchAction) {
  if(line.status!=='active'||line.held)return 0
  return Math.max(0,action==='start'?line.quantity-line.startedQuantity-(line.stoppedQuantity??0):action==='ready'?line.startedQuantity-line.readyQuantity:line.readyQuantity-line.takenQuantity-(line.discardedReadyQuantity??0))
}
export function activityBatchDraft(lines:ActivityServiceLine[],action:ActivityBatchAction,number:number):ActivityBatchDraft {
  return {action,number,lines:lines.filter(line=>line.number===number&&activityAvailable(line,action)>0).map(line=>({id:line.id,version:line.version,name:line.name,station:line.station,max:activityAvailable(line,action),quantity:activityAvailable(line,action)}))}
}
export function activityBatchCurrent(draft:ActivityBatchDraft,lines:ActivityServiceLine[]) {
  return draft.lines.every(part=>lines.some(line=>line.id===part.id&&line.number===draft.number&&line.version===part.version&&activityAvailable(line,draft.action)>=part.quantity))
}
export function activityBatchCommand(draft:ActivityBatchDraft):ActivityProductionCommand|null {
  if(!draft.lines.length||draft.lines.some(part=>!Number.isSafeInteger(part.quantity)||part.quantity<0||part.quantity>part.max))return null
  const lines=draft.lines.filter(part=>part.quantity>0).map(part=>({lineId:part.id,quantity:part.quantity,expectedVersion:part.version}))
  return lines.length?{action:draft.action,lines}:null
}
