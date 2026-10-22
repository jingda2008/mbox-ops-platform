import {useEffect,useMemo,useRef,useState} from 'react'
import type {NormalizedApiClient} from '../../normalized-api'
import type {ActivityServiceView} from '../../shared/activity-service'
import type {ActivityServiceExceptionCommand,ActivityServiceExceptionResult} from '../../shared/activity-service-exception'
import {DurableStaffCommand} from '../durable-staff-command'
import {activityExceptionDraft,activityExceptionRemaining} from './activity-service-exception-state'

const labels={hold:'暂停本菜',resume:'恢复剩余制作',cancel_unmade:'停做尚未制作部分',remake:'损耗后补做',record_issue:'交付异常备注'} as const
function storage(){try{return localStorage}catch{return undefined}}
export function ActivityServiceExceptionPanel({api,service,scope,disabled=false,onChanged}:{
  api:NormalizedApiClient;service:ActivityServiceView;scope:string;disabled?:boolean;onChanged:()=>Promise<void>
}) {
  const [selection,setSelection]=useState<{id:string;version:number}|null>(null)
  const [action,setAction]=useState<ActivityServiceExceptionCommand['action']>('hold')
  const [quantity,setQuantity]=useState('1'),[reason,setReason]=useState(''),[from,setFrom]=useState<'ready'|'taken'>('ready')
  const [goodsLost,setGoodsLost]=useState(false),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[stale,setStale]=useState(false)
  const flight=useRef(false),alive=useRef(true)
  const journal=useMemo(()=>new DurableStaffCommand<ActivityServiceExceptionCommand,ActivityServiceExceptionResult>(
    `activity-exception:${scope}:${service.registrationPublicId}`,
    (body,key)=>api.postEndpoint('/api/commerce/activity-service/exceptions',body,{idempotencyKey:key}),storage(),true),[api,scope,service.registrationPublicId])
  let pending:ReturnType<typeof journal.pending>=null,storageError=''
  try{pending=journal.pending()}catch(cause){storageError=cause instanceof Error?cause.message:'原操作记录无法读取'}
  useEffect(()=>{
    alive.current=true
    const suspend=()=>{if(alive.current)setStale(true)}
    const visibility=()=>{if(document.visibilityState!=='visible')suspend()}
    window.addEventListener('offline',suspend);window.addEventListener('online',suspend);window.addEventListener('pageshow',suspend);document.addEventListener('visibilitychange',visibility)
    return()=>{alive.current=false;window.removeEventListener('offline',suspend);window.removeEventListener('online',suspend);window.removeEventListener('pageshow',suspend);document.removeEventListener('visibilitychange',visibility)}
  },[])
  const line=service.meal?.lines.find(item=>item.id===selection?.id)
  const remaining=line?activityExceptionRemaining(line):null
  const current=!!line&&selection?.version===line.version
  const maximum=remaining?(action==='cancel_unmade'?remaining.unmade:remaining[from]):0
  const needsQuantity=action==='cancel_unmade'||action==='remake'
  const body=activityExceptionDraft(line,{action,version:selection?.version??0,quantity:Number(quantity),reason,remakeFrom:from,goodsLost})
  const locked=disabled||busy||!!pending||!!storageError||stale||navigator.onLine===false
  async function refresh(){
    if(navigator.onLine===false)throw new Error('网络尚未恢复，请联网后核对原记录')
    await onChanged()
    if(!alive.current)throw new Error('已切换报名，请回原报名恢复核对')
    setStale(false);setSelection(null)
  }
  async function submit(command?:ActivityServiceExceptionCommand){
    if(flight.current||disabled||navigator.onLine===false||!!storageError||command&&locked)return
    flight.current=true;setBusy(true);setMessage('正在核对处理结果，请勿重复操作')
    try{
      const result=command?await journal.submit(command):await journal.recover()
      await journal.refresh(refresh)
      if(!alive.current)return
      setReason('');setQuantity('1');setGoodsLost(false)
      setMessage(`${labels[result.action]}已登记，请通知对应制作及取餐岗位核对。`)
    }catch(cause){if(alive.current){setStale(true);setMessage(cause instanceof Error?cause.message:'结果待核对，请恢复原操作')}}
    finally{flight.current=false;if(alive.current)setBusy(false)}
  }
  return <section aria-label="管理者出餐异常处理">
    <h3>管理者处理</h3>
    <p>先核对原菜和实物。停做不会自动退款；可追回的错送先由统筹处理。</p>
    {!!service.meal?.issueNotes?.length&&<details><summary>交付异常记录（最近20条）</summary>{service.meal.issueNotes.map(note=><p key={note.id}>{note.reason} · {note.employeeLabel??'授权岗位'} · {new Date(note.createdAt).toLocaleString('zh-CN')}</p>)}</details>}
    {(storageError||message)&&<p role="status">{storageError||message}</p>}
    {pending?<div role="status"><p>原“{labels[pending.body.action]}”尚待核对，恢复时沿用原记录，不新增补做。</p>
      <button type="button" disabled={busy||disabled||!!storageError||navigator.onLine===false} onClick={()=>void submit()}>恢复原异常操作</button></div>:<>
      {stale&&<p role="alert">明细需要重新核对，更新后再操作。</p>}
      <button type="button" disabled={busy||disabled} onClick={()=>void refresh().catch(cause=>{setStale(true);setMessage(cause instanceof Error?cause.message:'暂时无法更新明细')})}>重新核对明细</button>
      <fieldset disabled={locked}>
        <label>原菜品<select aria-label="原菜品" value={selection?.id??''} onChange={event=>{
          const next=service.meal?.lines.find(item=>item.id===event.target.value)
          setSelection(next?{id:next.id,version:next.version}:null);setAction(next?.held?'resume':'hold');setQuantity('1');setGoodsLost(false)
        }}><option value="">请选择需要处理的原菜品</option>{service.meal?.lines.filter(item=>item.status==='active').map((item,index)=><option key={item.id} value={item.id}>{item.name} · {item.station==='bar'?'吧台':'后厨'}{item.held?' · 已暂停':''} · 第 {index+1} 条</option>)}</select></label>
        {line&&remaining&&<>
          <p>尚未制作 {remaining.unmade} 份 · 待取实物 {remaining.ready} 份 · 已取走记录 {line.takenQuantity} 份{line.stoppedQuantity?` · 已停做 ${line.stoppedQuantity} 份`:''}{line.remadeTakenQuantity?` · 已登记取走后补做 ${line.remadeTakenQuantity} 份`:''}</p>
          {!current&&<p role="alert">原菜明细已变化，请重新选择并核对，不会自动沿用新数量。</p>}
          <label>处理方式<select aria-label="处理方式" value={action} onChange={event=>{setAction(event.target.value as ActivityServiceExceptionCommand['action']);setQuantity('1');setGoodsLost(false)}}>
            {line.held?<option value="resume">恢复剩余制作</option>:<option value="hold">暂停本菜</option>}
            <option value="cancel_unmade" disabled={remaining.unmade===0}>停做尚未制作部分</option>
            <option value="remake" disabled={remaining.ready+remaining.taken===0}>损耗后补做</option>
            <option value="record_issue">交付异常备注</option>
          </select></label>
          {action==='record_issue'&&<p>记录错送、退回、联系或交接结果；不会改变已取数量，也不会自动补做或退款。</p>}
          {action==='hold'&&<p>暂停这道菜后续制作及取走，请同时通知岗位。恢复后只继续剩余部分。</p>}
          {action==='remake'&&<>
            <label>原实物所在环节<select aria-label="原实物所在环节" value={from} onChange={event=>{setFrom(event.target.value as 'ready'|'taken');setQuantity('1');setGoodsLost(false)}}><option value="ready">已放好、尚未取走</option><option value="taken">已取走后发生损耗</option></select></label>
            <label><input type="checkbox" checked={goodsLost} onChange={event=>setGoodsLost(event.target.checked)}/>确认原实物已损耗，需要重新制作</label>
            <p>补做生成独立制作明细，沿用原餐号；不会把原已取走记录改成未取。</p>
          </>}
          {needsQuantity&&<label>实际处理份数（最多 {maximum} 份）<input type="number" min={1} max={maximum} step={1} value={quantity} onChange={event=>setQuantity(event.target.value)}/></label>}
          <label>处理原因<input value={reason} minLength={2} maxLength={500} onChange={event=>setReason(event.target.value)} placeholder="请填写核实后的具体原因"/></label>
          <button type="button" disabled={!body} onClick={()=>{if(body)void submit(body)}}>确认{labels[action]}</button>
        </>}
      </fieldset>
    </>}
  </section>
}
