import {useEffect,useMemo,useState} from 'react'
import {StaffActionsApi} from './staff-actions-api'
import './staff-reservation-notice.css'
/** A live work queue, not an offline push or a read receipt. */
export function StaffReservationNotice({sessionId,enabled,onNavigate}:{sessionId:string;enabled:boolean;onNavigate:(route:string)=>void}) {
  const api=useMemo(()=>new StaffActionsApi({staffSessionId:sessionId}),[sessionId])
  const [counts,setCounts]=useState({current:0,carryover:0}),[stale,setStale]=useState(false)
  useEffect(()=>{setCounts({current:0,carryover:0});setStale(false);if(!enabled)return;let stopped=false,inFlight=false;const abort=new AbortController()
    const read=async()=>{if(stopped||inFlight||document.visibilityState!=='visible')return;inFlight=true;try{const [current,carryover]=await Promise.all([api.loadReservations({status:'pending'},abort.signal),api.loadReservations({range:'carryover',status:'pending'},abort.signal)]);if(!stopped){setCounts({current:current.filter(r=>r.status==='pending').length,carryover:carryover.filter(r=>r.status==='pending').length});setStale(false)}}catch(e){if(!stopped){setStale(true);if([401,403].includes((e as {status?:number}).status??0))setCounts({current:0,carryover:0})}}finally{inFlight=false}}
    void read();const timer=setInterval(()=>void read(),15000);document.addEventListener('visibilitychange',read);window.addEventListener('online',read);window.addEventListener('mbox:reservations-changed',read)
    return()=>{stopped=true;abort.abort();clearInterval(timer);document.removeEventListener('visibilitychange',read);window.removeEventListener('online',read);window.removeEventListener('mbox:reservations-changed',read)}
  },[api,enabled])
  if(!enabled||counts.current+counts.carryover===0&&!stale)return null
  return <aside className="staff-reservation-notice" role="status" aria-label="新预约待接单提醒"><span><strong>{stale?'预约提醒连接待恢复':`${counts.current+counts.carryover}${Math.max(counts.current,counts.carryover)>=500?'+':''} 条预约等待接单`}</strong><small>{stale?'无法确认最新数量，请重新读取。':'请核对联系方式与需求，再确认预约。'}</small></span>{(counts.current>0||stale)&&<button type="button" onClick={()=>onNavigate('/staff/reservations?range=current')}>查看待接预约</button>}{counts.carryover>0&&<button type="button" onClick={()=>onNavigate('/staff/reservations?range=carryover')}>查看跨日待办</button>}</aside>
}
