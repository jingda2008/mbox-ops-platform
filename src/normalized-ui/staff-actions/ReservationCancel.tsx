import {useState} from 'react'
import type {StaffActionsApiPort} from './staff-actions-api'
export function ReservationCancel({id,canOverride,api,onChanged}:{id:string;canOverride:boolean;api:StaffActionsApiPort;onChanged:()=>void}) {
  const [open,setOpen]=useState(false),[reason,setReason]=useState(''),[override,setOverride]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('')
  if(!api.cancelReservation)return null
  if(!open)return <button type="button" onClick={()=>setOpen(true)}>取消预约</button>
  return <form className="reservation-cancel" onSubmit={e=>{e.preventDefault();if(busy)return;setBusy(true);setError('');void api.cancelReservation!(id,reason.trim(),override).then(()=>{setOpen(false);window.dispatchEvent(new Event('mbox:reservations-changed'));onChanged()}).catch(e=>{setError(e instanceof Error?e.message:'取消结果待核对，请刷新预约状态。')}).finally(()=>setBusy(false))}}><label>取消原因<textarea minLength={4} maxLength={500} required value={reason} onChange={e=>setReason(e.target.value)}/></label>{canOverride&&<label><input type="checkbox" checked={override} onChange={e=>setOverride(e.target.checked)}/>例外取消（已核实截止时间及定金处理；取消不会自动退款）</label>}{error&&<small role="alert">{error}</small>}<button disabled={busy||reason.trim().length<4} type="submit">{busy?'处理中…':'确认取消预约'}</button><button type="button" disabled={busy} onClick={()=>setOpen(false)}>保留预约</button></form>
}
