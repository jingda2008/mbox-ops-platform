import type {MenuBundleUnitSelection} from '../shared/contracts'

export interface StaffOrderDraft {
  quantities:Record<string,number>
  selections:Record<string,MenuBundleUnitSelection[]>
  notes:Record<string,string>
  note:string
  giftReason:string
}
const empty=():StaffOrderDraft=>({quantities:{},selections:{},notes:{},note:'',giftReason:''})
type DraftStorage=Pick<Storage,'getItem'|'setItem'|'removeItem'>
function storage():DraftStorage|undefined {try{return typeof window==='undefined'?undefined:window.sessionStorage}catch{return undefined}}
export function staffOrderDraftKey(employeeId:string|undefined,sessionId:string,mode:'paid'|'gift') {
  return employeeId?`mbox.staff-order-draft.v1:${employeeId}:${sessionId}:${mode}`:undefined
}
export function readStaffOrderDraft(key:string|undefined,store=storage(),now=Date.now()):StaffOrderDraft {
  if(!key||!store)return empty()
  try {
    const raw=store.getItem(key)
    if(!raw||raw.length>200_000)return empty()
    const value=JSON.parse(raw)
    if(!value||!Number.isFinite(value.savedAt)||now-value.savedAt>12*3600_000||value.savedAt>now+60_000)return empty()
    const result=empty()
    if(!value.quantities||typeof value.quantities!=='object'||Array.isArray(value.quantities))return result
    for(const [id,n]of Object.entries(value.quantities).slice(0,200)) {
      if(!id||['__proto__','constructor','prototype'].includes(id)||id.length>128||!Number.isSafeInteger(n)||Number(n)<1||Number(n)>999)continue
      result.quantities[id]=Number(n)
      if(typeof value.notes?.[id]==='string')result.notes[id]=value.notes[id].slice(0,300)
      const units=value.selections?.[id]
      if(Array.isArray(units)&&units.length<=Number(n)&&units.every(unit=>unit&&Array.isArray(unit.groups)&&unit.groups.length<=50&&unit.groups.every((group:unknown)=>{
        if(!group||typeof group!=='object')return false
        const g=group as {groupId?:unknown;productIds?:unknown}
        return typeof g.groupId==='string'&&g.groupId.length<=128&&Array.isArray(g.productIds)&&g.productIds.length<=50&&g.productIds.every(p=>typeof p==='string'&&p.length<=128)
      }))) result.selections[id]=units
    }
    result.note=typeof value.note==='string'?value.note.slice(0,500):''
    result.giftReason=typeof value.giftReason==='string'?value.giftReason.slice(0,500):''
    return result
  }catch{return empty()}
}
export function saveStaffOrderDraft(key:string|undefined,draft:StaffOrderDraft,store=storage(),now=Date.now()) {
  if(!key||!store)return
  try{if(!Object.keys(draft.quantities).length)store.removeItem(key);else store.setItem(key,JSON.stringify({...draft,savedAt:now}))}catch{/* Storage failure must never block ordering. */}
}
export function clearStaffOrderDraft(key:string|undefined,store=storage()){try{if(key)store?.removeItem(key)}catch{/* Current order remains usable. */}}
