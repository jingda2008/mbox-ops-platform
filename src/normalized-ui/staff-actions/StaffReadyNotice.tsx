import {useEffect,useMemo,useRef,useState} from 'react'
import {StaffActionsApi} from './staff-actions-api'
import type {StaffFulfillmentData,StaffFulfillmentItem} from './types'
import {fulfillmentNoticeKey} from './staff-notice-controller'
import './staff-ready-notice.css'

/** Persistent in-app handoff notice, including while a waiter is on another work page. */
export function StaffReadyNotice({employeeId,sessionId,canDeliver,usesActionQueue,onNavigate}:{employeeId:string;sessionId:string;canDeliver:boolean;usesActionQueue:boolean;onNavigate:(route:string)=>void}){
  const api=useMemo(()=>new StaffActionsApi({staffSessionId:sessionId}),[sessionId])
  const [items,setItems]=useState<StaffFulfillmentItem[]>([]),[stale,setStale]=useState(false),[dismissed,setDismissed]=useState('')
  const known=useRef<Set<string>|null>(null)
  useEffect(()=>{
    if(!canDeliver)return
    let stopped=false,inFlight=false;const abort=new AbortController()
    const accept=(queue:StaffFulfillmentData)=>{
      if(stopped||queue.actor.employeeId!==employeeId)return
      const ready=queue.actor.actionSessionValid===false?[]:queue.workItems.filter(item=>item.canDeliver&&item.readyForDelivery)
      const keys=new Set(ready.map(fulfillmentNoticeKey))
      if(known.current&&[...keys].some(key=>!known.current!.has(key))&&typeof navigator.vibrate==='function')navigator.vibrate([18,45,18])
      known.current=keys;setItems(ready);setStale(false)
    }
    const shared=(event:Event)=>{const detail=(event as CustomEvent<StaffFulfillmentData|null>).detail;if(detail)accept(detail);else{setItems([]);setStale(true)}}
    const read=async()=>{
      if(stopped||inFlight||usesActionQueue||document.visibilityState!=='visible')return
      inFlight=true
      try{accept(await api.loadFulfillment(abort.signal))}catch(error){if(!stopped){setStale(true);if([401,403].includes((error as {status?:number})?.status??0))setItems([])}}finally{inFlight=false}
    }
    window.addEventListener('mbox:fulfillment-read',shared)
    document.addEventListener('visibilitychange',read);window.addEventListener('online',read)
    void read();const timer=setInterval(()=>void read(),5000)
    return()=>{stopped=true;abort.abort();clearInterval(timer);window.removeEventListener('mbox:fulfillment-read',shared);document.removeEventListener('visibilitychange',read);window.removeEventListener('online',read)}
  },[api,canDeliver,employeeId,usesActionQueue])
  const signature=`${stale?'stale':'current'}:${items.map(fulfillmentNoticeKey).sort().join('|')}`
  if(!canDeliver||items.length===0&&!stale||signature===dismissed)return null
  const quantity=items.reduce((sum,item)=>sum+(item.quantities?.ready??item.item.quantity),0)
  return <aside className="staff-ready-notice" role="status" aria-label="出品取送提醒">
    <span><strong>{stale&&quantity===0?'取送状态待核对':`${quantity} 份出品待取送`}</strong><small>{stale?'更新失败，进入原订单核对':`${[...new Set(items.map(item=>item.table.code))].slice(0,4).join('、')}${new Set(items.map(item=>item.table.code)).size>4?'等桌':''} · 实际送达后再确认`}</small></span>
    <button type="button" onClick={()=>onNavigate(items[0]?`/staff/fulfillment?factId=${encodeURIComponent(items[0].taskId)}`:'/staff/fulfillment')}>查看取菜</button>
    <button type="button" aria-label="暂收起取送提醒" onClick={()=>setDismissed(signature)}>稍后</button>
  </aside>
}
