import {useEffect,useEffectEvent,useState} from 'react'
import type {NormalizedApiClient,StaffAuthView} from '../normalized-api'
import {executeRecoverableCommand} from './recoverable-command'
import {createIdempotencyKey} from './cashier-mutation'
interface Policy {width:number;startNumber:number;padZero:boolean;alphabet:string;maximumPrefixLength:number}
interface View {policy:Policy;version:number;nextCandidate:string|null}
export function MemberNumberPolicyPanel({api,auth}:{api:NormalizedApiClient;auth:StaffAuthView}){
 const [view,setView]=useState<View|null>(null),[message,setMessage]=useState(''),[busy,setBusy]=useState(false),[reason,setReason]=useState('')
 const allowed=auth.permissions.includes('member.card.manage')
 async function load(){setBusy(true);try{setView((await api.getEndpoint<{data:View}>('/api/staff/member-number-policy')).data);setMessage('')}catch(error){setMessage(error instanceof Error?error.message:'读取失败，可重试')}finally{setBusy(false)}}
 const initialize=useEffectEvent(()=>{void load()})
 useEffect(()=>{if(allowed)initialize()},[allowed,api,auth.employee.id])
 if(!allowed)return null
 const change=(patch:Partial<Policy>)=>setView(value=>value?{...value,policy:{...value.policy,...patch}}:value)
 async function save(){if(!view||busy)return;setBusy(true);try{const body={policy:view.policy,version:view.version,reason};await executeRecoverableCommand(`${auth.employee.id}:member-number-policy`,body,createIdempotencyKey('member-number'),key=>api.postEndpoint('/api/staff/member-number-policy',body,{idempotencyKey:key}));await load();setMessage('号段配置已保存，已发会员号保持不变。')}catch(error){setMessage(error instanceof Error?error.message:'保存结果未确认，请刷新核对')}finally{setBusy(false)}}
 return <section className="member-card-management-panel"><h3>会员号规则</h3><p>新会员自动发号；数字用尽后依次使用字母前缀。已发会员号保持不变，重复候选号自动跳过。</p><button type="button" disabled={busy} onClick={()=>void load()}>刷新配置</button>{view&&<form onSubmit={event=>{event.preventDefault();void save()}}>
 <label>总位数<input type="number" min="4" max="12" value={view.policy.width} onChange={e=>change({width:Number(e.target.value)})}/></label>
 <label>起始数字<input type="number" min="1" max="999999999999" value={view.policy.startNumber} onChange={e=>change({startNumber:Number(e.target.value)})}/></label>
 <label>字母顺序<input value={view.policy.alphabet} maxLength={26} onChange={e=>change({alphabet:e.target.value.toUpperCase()})}/></label>
 <label>最长字母前缀<input type="number" min="0" max="4" value={view.policy.maximumPrefixLength} onChange={e=>change({maximumPrefixLength:Number(e.target.value)})}/></label>
 <label><input type="checkbox" checked={view.policy.padZero} onChange={e=>change({padZero:e.target.checked})}/>不足位数补零</label>
 <p>当前已保存规则的下一个候选号：{view.nextCandidate??'号段已用尽，请扩展配置'}</p>
 <label>变更原因<input required minLength={2} maxLength={300} value={reason} onChange={e=>setReason(e.target.value)}/></label><button disabled={busy} type="submit">保存会员号规则</button></form>}{message&&<p role="status">{message}</p>}</section>
}
