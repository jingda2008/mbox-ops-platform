import {useEffect,useRef,useState} from 'react'
import type {NormalizedApiClient,StaffAuthView} from '../normalized-api'
import {PerformanceRevisionPanel,type PerformanceRevisionSchedule} from './PerformanceRevisionPanel'

type Slot={performerId:string;startsAt:string;endsAt:string}
type Preview=Slot&{performerName:string;existingId:string|null;reasons:string[]}
type Rule={days:number[];start:string;end:string;performerId:string}
const weekdays=['日','一','二','三','四','五','六']
export function MonthlySchedulePanel({api,auth,performers,onChanged}:{api:NormalizedApiClient;auth:StaffAuthView;performers:readonly {id:string;stageName:string;status?:string}[];onChanged():Promise<void>}){
 const storageKey=`mbox.monthly-draft:${auth.employee.id}`
 const restored=useRef<{month?:string;rules?:Rule[];slots?:Slot[]}|null>(null)
 if(restored.current===null){try{const saved=JSON.parse(localStorage.getItem(storageKey)??'{}');restored.current=saved&&typeof saved==='object'?{
 month:typeof saved.month==='string'&&/^\d{4}-(0[1-9]|1[0-2])$/.test(saved.month)?saved.month:undefined,
 rules:Array.isArray(saved.rules)?saved.rules.filter((r:Rule)=>r&&Array.isArray(r.days)&&r.days.every(d=>Number.isInteger(d)&&d>=0&&d<=6)&&typeof r.performerId==='string'&&/^([01]\d|2[0-3]):[0-5]\d$/.test(r.start)&&/^([01]\d|2[0-3]):[0-5]\d$/.test(r.end)).slice(0,31):undefined,
 slots:Array.isArray(saved.slots)?saved.slots.filter((s:Slot)=>s&&typeof s.performerId==='string'&&Number.isFinite(Date.parse(s.startsAt))&&Number.isFinite(Date.parse(s.endsAt))).slice(0,500):undefined,
 }:{}}catch{restored.current={}}}
 const [month,setMonth]=useState(()=>typeof restored.current?.month==='string'&&/^\d{4}-\d{2}$/.test(restored.current.month)?restored.current.month:new Date(Date.now()+8*3600000).toISOString().slice(0,7))
 const [rules,setRules]=useState<Rule[]>(Array.isArray(restored.current?.rules)?restored.current.rules:[{days:[1,2,3,4,5,6,0],start:'21:00',end:'22:00',performerId:performers[0]?.id??''}])
 const [slots,setSlots]=useState<Slot[]>(Array.isArray(restored.current?.slots)?restored.current.slots:[]),[preview,setPreview]=useState<Preview[]|null>(null),[published,setPublished]=useState<PerformanceRevisionSchedule[]>([])
 const [message,setMessage]=useState(''),[busy,setBusy]=useState(false)
 const attempt=useRef<{fingerprint:string;key:string}|null>(null),writing=useRef(false),generation=useRef(0)
 useEffect(()=>{try{localStorage.setItem(storageKey,JSON.stringify({month,rules,slots}))}catch{/* Draft remains usable in memory. */}},[storageKey,month,rules,slots])
 async function loadPublished(){const epoch=generation.current;const response=await api.getEndpoint<{data:PerformanceRevisionSchedule[]}>(`/api/staff/schedules/monthly?month=${month}`);if(epoch===generation.current)setPublished(response.data)}
 useEffect(()=>{let active=true;setPublished([]);void api.getEndpoint<{data:PerformanceRevisionSchedule[]}>(`/api/staff/schedules/monthly?month=${month}`).then(result=>{if(active)setPublished(result.data)}).catch(error=>{if(active)setMessage(error instanceof Error?error.message:'月度排班未读取')});return()=>{active=false}},[api,month])
 function invalidate(){generation.current++;setPreview(null);setMessage('')}
 function generate(){
  invalidate();const next:Slot[]=[];const [year,mon]=month.split('-').map(Number)
  if(!year||!mon)return setMessage('请选择月份')
  const days=new Date(Date.UTC(year,mon,0)).getUTCDate()
  for(let day=1;day<=days;day++)for(const rule of rules){
   if(!rule.days.includes(new Date(Date.UTC(year,mon-1,day)).getUTCDay()))continue
   if(!rule.performerId||!rule.start||!rule.end)return setMessage('每条规则都需要选择歌手和起止时间')
   const date=`${month}-${String(day).padStart(2,'0')}`
   const start=Date.parse(`${date}T${rule.start}:00+08:00`);let end=Date.parse(`${date}T${rule.end}:00+08:00`)
   if(end<=start)end+=86400000
   next.push({performerId:rule.performerId,startsAt:new Date(start).toISOString(),endsAt:new Date(end).toISOString()})
  }
  setSlots(next.sort((a,b)=>a.startsAt.localeCompare(b.startsAt)));setMessage(`已生成 ${next.length} 场草稿。可逐场修改歌手、时间或移除例外日期，预览通过后发布。`)
 }
 async function check(){const version=++generation.current;setBusy(true);try{const result=await api.postEndpoint<{data:Preview[]}>('/api/staff/schedules/monthly/preview',{month,slots});if(version===generation.current)setPreview(result.data)}catch(error){if(version===generation.current)setMessage(error instanceof Error?error.message:'预览未完成')}finally{if(version===generation.current)setBusy(false)}}
 async function publish(){
  if(writing.current||!preview||preview.some(slot=>slot.reasons.length))return
  writing.current=true;setBusy(true);const payload={month,slots},fingerprint=JSON.stringify(payload)
  if(attempt.current?.fingerprint!==fingerprint)attempt.current={fingerprint,key:crypto.randomUUID()}
  try{const result=await api.postEndpoint<{data:{createdCount:number;existingCount:number}}>('/api/staff/schedules/monthly/publish',payload,{idempotencyKey:attempt.current.key});setMessage(`已发布 ${result.data.createdCount} 场，${result.data.existingCount} 场已存在并保留。`);setPreview(null);attempt.current=null;await loadPublished();await onChanged()}
  catch(error){setMessage(error instanceof Error?error.message:'发布结果未确认，再次点击会核对同一请求')}
  finally{writing.current=false;setBusy(false)}
 }
 function changeSlot(index:number,patch:Partial<Slot>){invalidate();setSlots(current=>current.map((slot,i)=>i===index?{...slot,...patch}:slot))}
 const local=(iso:string)=>new Date(Date.parse(iso)+8*3600000).toISOString().slice(0,16)
 return <details className="monthly-schedule-panel"><summary>月度演出表 · 生成与编辑</summary><label>月份<input type="month" value={month} disabled={busy} onChange={event=>{invalidate();setSlots([]);setMonth(event.target.value)}}/></label>
  <p>北京时间；结束时间早于或等于开始时间表示次日。草稿发布后才会显示给顾客。</p>
  {rules.map((rule,index)=><fieldset key={index} disabled={busy}><legend>规则 {index+1}</legend><div>{weekdays.map((name,day)=><label key={day}><input type="checkbox" checked={rule.days.includes(day)} onChange={()=>{invalidate();setRules(current=>current.map((r,i)=>i===index?{...r,days:r.days.includes(day)?r.days.filter(d=>d!==day):[...r.days,day]}:r))}}/>周{name}</label>)}</div>
   <label>开始<input type="time" value={rule.start} onChange={event=>{invalidate();setRules(current=>current.map((r,i)=>i===index?{...r,start:event.target.value}:r))}}/></label>
   <label>结束<input type="time" value={rule.end} onChange={event=>{invalidate();setRules(current=>current.map((r,i)=>i===index?{...r,end:event.target.value}:r))}}/></label>
   <label>歌手<select value={rule.performerId} onChange={event=>{invalidate();setRules(current=>current.map((r,i)=>i===index?{...r,performerId:event.target.value}:r))}}><option value="">请选择</option>{performers.filter(p=>p.status!=='inactive').map(p=><option key={p.id} value={p.id}>{p.stageName}</option>)}</select></label>
   <button type="button" onClick={()=>{invalidate();setRules(current=>current.filter((_,i)=>i!==index))}}>移除规则</button></fieldset>)}
  <button type="button" disabled={busy||rules.length>=5} onClick={()=>setRules([...rules,{days:[5,6],start:'22:00',end:'23:00',performerId:performers[0]?.id??''}])}>增加时间段规则</button><button type="button" disabled={busy||!rules.length} onClick={generate}>按规则生成整月草稿</button>
  {slots.length>0&&<div className="monthly-schedule-days">{slots.map((slot,index)=><fieldset key={index} disabled={busy}><legend>第{index+1}场 · {local(slot.startsAt).slice(0,10)}</legend><label>歌手<select value={slot.performerId} onChange={event=>changeSlot(index,{performerId:event.target.value})}>{performers.map(p=><option key={p.id} value={p.id}>{p.stageName}</option>)}</select></label><label>开始<input type="datetime-local" value={local(slot.startsAt)} onChange={event=>{if(event.target.value)changeSlot(index,{startsAt:new Date(`${event.target.value}:00+08:00`).toISOString()})}}/></label><label>结束<input type="datetime-local" value={local(slot.endsAt)} onChange={event=>{if(event.target.value)changeSlot(index,{endsAt:new Date(`${event.target.value}:00+08:00`).toISOString()})}}/></label><button type="button" onClick={()=>{invalidate();setSlots(current=>current.filter((_,i)=>i!==index))}}>本日取消此场草稿</button></fieldset>)}</div>}
  {slots.length>0&&<button type="button" disabled={busy} onClick={()=>void check()}>预览冲突与发布范围</button>}
  {preview&&<section><p>共 {preview.length} 场；{preview.filter(slot=>slot.existingId).length} 场已有相同排班，不重复生成。</p>{preview.filter(slot=>slot.reasons.length).map((slot,index)=><p role="alert" key={index}>{local(slot.startsAt)} · {slot.performerName}：{slot.reasons.join('；')}</p>)}<button type="button" disabled={busy||preview.some(slot=>slot.reasons.length>0)} onClick={()=>void publish()}>发布已预览的场次</button></section>}
  {message&&<p role="status">{message}</p>}<p>草稿自动保存在本设备当前账号，发布前均不对顾客显示。</p><h4>本月已发布</h4>{published.map(slot=><article key={slot.id}>{local(slot.startsAt).replace('T',' ')} — {local(slot.endsAt).replace('T',' ')} · {slot.performerStageName}</article>)}
  <PerformanceRevisionPanel api={api} auth={auth} schedules={published} onChanged={async()=>{await loadPublished();await onChanged()}}/>
 </details>
}
