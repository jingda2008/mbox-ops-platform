import {MAX_PICKUP_TASKS,MAX_PICKUP_UNITS,type PickupBoardData,type PickupCommand,type PickupReceipt,type PickupSelection,type PickupUnit} from '../../shared/pickup-workflow'

export type PickupTable=PickupBoardData['tables'][number]
export interface PickupLine {key:string;name:string;notes:string;location:string;units:PickupUnit[]}
export interface PickupDraft {tableId:string;tableCode:string;tableSessionId:string;locationVersion:number;lines:PickupLine[];amounts:Record<string,number>}
export const PICKUP_PAGE_SIZE=4
export const PICKUP_REPEAT_GUARD_MS=650
export const pickupUnitKey=(unit:Pick<PickupUnit,'kind'|'unitId'>)=>`${unit.kind}:${unit.unitId}`
const time=(value:string|null)=>value===null?Number.POSITIVE_INFINITY:Date.parse(value)

export function pickupLocation(unit:PickupUnit):string{
  if(unit.pickupLocation&&/[\u3400-\u9fff]/.test(unit.pickupLocation))return unit.pickupLocation
  return unit.station==='kitchen'?'后厨取餐口':'酒水吧台'
}
export function pickupNotes(unit:PickupUnit):string{
  return [unit.specification,unit.itemNote,unit.orderNote].filter(Boolean).join(' · ')
}
export function pickupLines(units:readonly PickupUnit[]):PickupLine[]{
  const groups=new Map<string,PickupLine>()
  for(const unit of [...units].sort((a,b)=>time(a.readyAt)-time(b.readyAt)||pickupUnitKey(a).localeCompare(pickupUnitKey(b)))){
    const notes=pickupNotes(unit),location=pickupLocation(unit)
    const key=JSON.stringify([unit.productName,unit.specification,unit.itemNote,unit.orderNote,unit.station,location])
    const group=groups.get(key)??{key,name:unit.productName,notes,location,units:[]}
    group.units.push({...unit});groups.set(key,group)
  }
  return [...groups.values()]
}
export function pickupTables(tables:readonly PickupTable[]):PickupTable[]{
  return tables.filter(table=>table.units.length>0).map(table=>({...table,units:[...table.units]})).sort((a,b)=>
    Math.min(...a.units.map(unit=>time(unit.readyAt)))-Math.min(...b.units.map(unit=>time(unit.readyAt)))||a.tableCode.localeCompare(b.tableCode,'zh-CN'))
}
export function pickupWaitLabel(units:readonly PickupUnit[],now:number):string{
  const at=Math.min(...units.map(unit=>time(unit.readyAt)))
  if(!Number.isFinite(at))return '等候时间待核对'
  const minutes=Math.floor(Math.max(0,now-at)/60_000)
  return minutes>0?`等候 ${minutes}分钟`:'刚摆好'
}
export function pickupDraft(table:PickupTable):PickupDraft{
  const lines=pickupLines(table.units)
  return {tableId:table.tableId,tableCode:table.tableCode,tableSessionId:table.tableSessionId,locationVersion:table.locationVersion,
    lines,amounts:Object.fromEntries(lines.map(line=>[line.key,line.units.length]))}
}
export function adjustPickupAmount(draft:PickupDraft,key:string,delta:-1|1):PickupDraft{
  const line=draft.lines.find(item=>item.key===key),amount=draft.amounts[key]
  if(!line||!Number.isSafeInteger(amount))return draft
  return {...draft,amounts:{...draft.amounts,[key]:Math.max(0,Math.min(line.units.length,amount+delta))}}
}
/** Only the exact physical units read when the draft was opened are eligible. */
export function pickupTakeCommand(draft:PickupDraft):Extract<PickupCommand,{action:'take'}>|null{
  const units:PickupSelection[]=[]
  for(const line of draft.lines){const count=draft.amounts[line.key]
    if(!Number.isSafeInteger(count)||count<0||count>line.units.length)return null
    units.push(...line.units.slice(0,count).map(unit=>({kind:unit.kind,unitId:unit.unitId,version:unit.version})))
  }
  if(units.length===0||pickupDraftOverLimit(draft)||new Set(units.map(pickupUnitKey)).size!==units.length)return null
  return {action:'take',tableId:draft.tableId,tableSessionId:draft.tableSessionId,locationVersion:draft.locationVersion,units}
}
export function pickupDraftCount(draft:PickupDraft):number{return draft.lines.reduce((sum,line)=>sum+(draft.amounts[line.key]??0),0)}
export function pickupDraftOverLimit(draft:PickupDraft):boolean{
  const selected=draft.lines.flatMap(line=>line.units.slice(0,draft.amounts[line.key]??0))
  return selected.length>MAX_PICKUP_UNITS||new Set(selected.map(unit=>unit.taskId)).size>MAX_PICKUP_TASKS
}
export function pickupDraftCurrent(draft:PickupDraft,tables:readonly PickupTable[]):boolean{
  const table=tables.find(item=>item.tableId===draft.tableId&&item.tableSessionId===draft.tableSessionId&&item.locationVersion===draft.locationVersion)
  return !!table&&draft.lines.every(line=>line.units.slice(0,draft.amounts[line.key]??0).every(unit=>table.units.some(current=>pickupUnitKey(current)===pickupUnitKey(unit)&&current.version===unit.version)))
}
export function pickupSelectionCurrent(command:Extract<PickupCommand,{action:'take'}>,tables:readonly PickupTable[]):boolean{
  const table=tables.find(item=>item.tableId===command.tableId&&item.tableSessionId===command.tableSessionId&&item.locationVersion===command.locationVersion)
  return !!table&&command.units.length>0&&command.units.every(ref=>table.units.some(unit=>pickupUnitKey(unit)===pickupUnitKey(ref)&&unit.version===ref.version))
}
export function pickupUndoCommand(receipt:PickupReceipt):Extract<PickupCommand,{action:'undo'}>|null{
  return receipt.canUndo&&receipt.undo===null?{action:'undo',receiptId:receipt.receiptId,expectedRevision:receipt.revision,physicalStillAtPickupPoint:true}:null
}
export function pickupNeedsReview(lines:readonly PickupLine[]):boolean{
  const units=lines.flatMap(line=>line.units)
  return lines.length>3||lines.some(line=>line.name.length>18||line.notes.length>12)||units.length>MAX_PICKUP_UNITS||new Set(units.map(unit=>unit.taskId)).size>MAX_PICKUP_TASKS
}
