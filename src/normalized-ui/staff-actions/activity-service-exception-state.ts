import type {ActivityServiceLine} from '../../shared/activity-service'
import {parseActivityServiceException,type ActivityServiceExceptionCommand} from '../../shared/activity-service-exception'

export function activityExceptionRemaining(line:ActivityServiceLine) {
  return {
    unmade:Math.max(0,line.quantity-line.startedQuantity-(line.stoppedQuantity??0)),
    ready:Math.max(0,line.readyQuantity-line.takenQuantity-(line.discardedReadyQuantity??0)),
    taken:Math.max(0,line.takenQuantity-(line.remadeTakenQuantity??0)),
  }
}
export function activityExceptionDraft(line:ActivityServiceLine|undefined,input:{
  action:ActivityServiceExceptionCommand['action'];version:number;quantity:number;reason:string;remakeFrom:'ready'|'taken';goodsLost:boolean
}):ActivityServiceExceptionCommand|null {
  if(!line||line.status!=='active'||line.version!==input.version)return null
  const remaining=activityExceptionRemaining(line)
  if(input.action==='hold'&&line.held||input.action==='resume'&&!line.held)return null
  if(input.action==='cancel_unmade'&&input.quantity>remaining.unmade)return null
  if(input.action==='remake'&&input.quantity>remaining[input.remakeFrom])return null
  try{return parseActivityServiceException({...input,lineId:line.id,expectedVersion:input.version})}catch{return null}
}
