import {useEffect,useRef,useState} from 'react'
import type {StaffActionsApiPort} from './staff-actions-api'
/** Plaintext stays in this mounted view and is cleared on hide, blur, or timeout. */
export function ReservationContact({id,allowed,available,api}:{id:string;allowed:boolean;available:boolean;api:StaffActionsApiPort}) {
  const generation=useRef(0)
  const [contact,setContact]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('')
  useEffect(()=>{let current=true;const clear=()=>{generation.current++;if(current)setContact('')};const visibility=()=>{if(document.visibilityState!=='visible')clear()};window.addEventListener('blur',clear);document.addEventListener('visibilitychange',visibility);const timer=setTimeout(clear,60000);return()=>{current=false;generation.current++;clearTimeout(timer);window.removeEventListener('blur',clear);document.removeEventListener('visibilitychange',visibility)}},[contact,id,allowed])
  useEffect(()=>{setContact('');setError('')},[id,allowed])
  async function reveal(){const request=++generation.current;setBusy(true);setError('');try{const r=await api.readReservationContact!(id,'联系客人核对本次预约');if(generation.current===request&&document.visibilityState==='visible')setContact(r.contact)}catch{if(generation.current===request)setError('联系方式暂未读取，请重试或联系有权限的接待人员。')}finally{setBusy(false)}}
  return <div className="reservation-contact"><span>{allowed&&contact?contact:available?'联系方式已保护':'未留联系方式'}</span>{allowed&&available&&api.readReservationContact&&<button type="button" disabled={busy} onClick={()=>contact?setContact(''):void reveal()}>{busy?'读取中…':contact?'隐藏联系方式':'查看联系方式'}</button>}{error&&<small role="alert">{error}</small>}</div>
}
