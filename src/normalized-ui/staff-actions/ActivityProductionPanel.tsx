import {useCallback,useEffect,useMemo,useRef,useState} from 'react'
import type {ActivityProductionCommand,ActivityProductionResult} from '../../shared/activity-service'
import type {ActivityProductionBoard} from '../../shared/activity-production-recovery'
import {activityProductionJournal} from './activity-production-recovery'
import type {StaffActionsApiPort} from './staff-actions-api'
import {activityAvailable,activityBatchCommand,activityBatchCurrent,activityBatchDraft,type ActivityBatchAction,type ActivityBatchDraft} from './activity-production-state'
import './activity-production-panel.css'

type Board=ActivityProductionBoard
function storage(){try{return localStorage}catch{return undefined}}
export function ActivityProductionPanel({api,station,scope,active,blocked=false,query='',onCount}:{
  api:StaffActionsApiPort;station:'bar'|'kitchen'|'pickup';scope:string;active:boolean;blocked?:boolean;query?:string;onCount:(value:number)=>void
}) {
  const ownership=useMemo(()=>({api,station,scope}),[api,station,scope])
  const owner=useRef(ownership);owner.current=ownership
  const [dataOwner,setDataOwner]=useState<typeof ownership|null>(null)
  const [data,setData]=useState<Board|null>(null),[stale,setStale]=useState(true),[busy,setBusy]=useState(false)
  const [message,setMessage]=useState(''),[draft,setDraft]=useState<ActivityBatchDraft|null>(null)
  const [recent,setRecent]=useState<{command:ActivityProductionCommand;result:ActivityProductionResult}|null>(null)
  const [physical,setPhysical]=useState(false)
  const flight=useRef(false),reading=useRef(false),alive=useRef(true),revision=useRef(0),controller=useRef<AbortController|null>(null)
  const countCallback=useRef(onCount);countCallback.current=onCount
  const board=dataOwner===ownership?data:null
  let recovery:ReturnType<typeof activityProductionJournal>|null=null,unresolved=false,storageError=''
  try{recovery=activityProductionJournal(api,station,scope,board,storage());unresolved=!!recovery.journal.pending()}catch(cause){storageError=cause instanceof Error?cause.message:'原操作记录无法读取'}
  const read=useCallback(async()=>{
    const generation=++revision.current
    controller.current?.abort();const abort=new AbortController();controller.current=abort;reading.current=true
    try {
      const next=await api.loadActivityBoard!(station,abort.signal)
      if(!alive.current||owner.current!==ownership||generation!==revision.current)throw new Error('读取已中断，请恢复原操作')
      if(!Array.isArray(next.activityItems))throw new Error('活动出品无法读取，请重新读取')
      setData(next);setDataOwner(ownership);setStale(document.visibilityState!=='visible'||navigator.onLine===false)
      countCallback.current(next.activityItems.reduce((sum,line)=>sum+(station==='pickup'?activityAvailable(line,'take'):activityAvailable(line,'start')+activityAvailable(line,'ready')),0))
    }catch(cause){if(alive.current&&owner.current===ownership&&generation===revision.current&&!abort.signal.aborted){setStale(true);setMessage(cause instanceof Error?cause.message:'更新未完成，请重新读取')};throw cause}
    finally{if(generation===revision.current)reading.current=false}
  },[api,station,ownership])
  useEffect(()=>{
    alive.current=true;flight.current=false;setBusy(false);setData(null);setDataOwner(null);setStale(true);setDraft(null);setRecent(null);setPhysical(false);setMessage('正在核对当前岗位出品');countCallback.current(0);void read().catch(()=>{})
    const refresh=()=>{if(document.visibilityState==='visible'&&navigator.onLine!==false&&!flight.current&&!reading.current)void read().catch(()=>{})}
    const suspend=()=>{setStale(true);if(!flight.current){revision.current++;controller.current?.abort();reading.current=false}}
    const resume=()=>{suspend();refresh()}
    const visibility=()=>document.visibilityState==='visible'?resume():suspend()
    const timer=setInterval(refresh,5000)
    window.addEventListener('online',resume);window.addEventListener('offline',suspend);window.addEventListener('pageshow',resume);document.addEventListener('visibilitychange',visibility)
    return()=>{alive.current=false;revision.current++;controller.current?.abort();clearInterval(timer);window.removeEventListener('online',resume);window.removeEventListener('offline',suspend);window.removeEventListener('pageshow',resume);document.removeEventListener('visibilitychange',visibility)}
  },[read])
  const locked=blocked||busy||stale||!board||unresolved||!!storageError
  const lines=board?.activityItems??[]
  const numbers=[...new Set(lines.filter(line=>line.status==='active'&&(station==='pickup'?activityAvailable(line,'take')>0:line.held||activityAvailable(line,'start')+activityAvailable(line,'ready')>0)).map(line=>line.number))]
  const filtered=numbers.filter(number=>lines.some(line=>line.number===number&&`${number} ${line.name} ${line.activityTitle??''} ${line.location??''}`.includes(query.trim())))
  const command=draft?activityBatchCommand(draft):null
  const current=!!draft&&activityBatchCurrent(draft,lines)
  async function submit(body?:ActivityProductionCommand) {
    if(flight.current||blocked||!board||!recovery||navigator.onLine===false||(!body&&!unresolved)||!!storageError)return
    if(body&&locked)return
    flight.current=true;setBusy(true);revision.current++;controller.current?.abort();setMessage('正在核对原操作，请勿重复制作或取走')
    const requestOwner=ownership
    const currentOwner=()=>alive.current&&owner.current===requestOwner
    const journal=recovery.journal
    const original=body??journal.pending()?.body
    try {
      recovery.remember()
      const result=body?await journal.submit(body):await journal.recover()
      if(!currentOwner())return
      if(original&&result.action==='take')setRecent({command:original,result})
      await journal.refresh(read)
      recovery.acknowledge()
      if(!currentOwner())return
      setDraft(null);setPhysical(false)
      if(result.action==='undo_take')setRecent(null)
      setMessage(result.action==='take'?'本批已取走，按餐号送餐，无需再点手机':result.action==='undo_take'?'原批次已恢复待取':result.action==='start'?'本批已开始制作':'本批已放好取餐口')
    }catch(cause){if(currentOwner()){setStale(true);setMessage(cause instanceof Error?cause.message:'结果待核对，请恢复原操作')}}
    finally{if(currentOwner()){flight.current=false;setBusy(false)}}
  }
  function choose(number:number,action:ActivityBatchAction){if(!locked)setDraft(activityBatchDraft(lines,action,number))}
  return <section className="activity-production-panel" hidden={!active} aria-label={station==='pickup'?'活动按号取餐':'活动按号制作'}>
    <div className="activity-production-feedback" role="status"><span>{storageError||message||'核对餐号与实际份数，新增内容独立出单。'}{stale?' · 操作暂停，更新后继续':''}{recovery?.previousLogin?' · 发现本机原登录的取餐记录，请先恢复':''}</span>
      {unresolved&&<button type="button" disabled={busy||blocked||!board||!!storageError} onClick={()=>void submit()}>恢复原操作</button>}<button type="button" disabled={busy} onClick={()=>void read().catch(()=>{})}>重新读取</button>
    </div>
    {draft?<article className="activity-batch-detail"><header><h2>餐号 {draft.number} · 本批{draft.action==='take'?'取走':draft.action==='ready'?'放好':'制作'}</h2><button disabled={busy||unresolved} onClick={()=>setDraft(null)}>返回</button></header>
      <div className="activity-batch-lines">{draft.lines.map(part=><label key={part.id}><span>{part.name}<small>{part.station==='bar'?'吧台':'后厨'} · 可选 {part.max} 份</small></span>
        <input type="number" min={0} max={part.max} step={1} value={part.quantity} disabled={locked} aria-label={`${part.name} 本批数量`} onChange={event=>{const quantity=Number(event.target.value);setDraft(old=>old?{...old,lines:old.lines.map(line=>line.id===part.id?{...line,quantity}:line)}:null)}}/></label>)}</div>
      {!current&&<p role="alert">这批出品已发生变化，请返回重新核对，不会自动加入新菜。</p>}
      <button type="button" disabled={locked||!command||!current} onClick={()=>{if(command)void submit(command)}}>{draft.action==='take'?'本批已取走':draft.action==='ready'?'本批已放好取餐口':'开始本批制作'}</button>
    </article>:<div className="activity-production-cards">{filtered.map(number=>{
      const group=lines.filter(line=>line.number===number),first=group[0]!
      const pending=group.reduce((sum,line)=>sum+activityAvailable(line,'start'),0),working=group.reduce((sum,line)=>sum+activityAvailable(line,'ready'),0),ready=group.reduce((sum,line)=>sum+activityAvailable(line,'take'),0)
      return <article key={number}><header><strong>餐号 {number}</strong><span>{first.location||'按号码牌送餐'}</span></header><p>{first.activityTitle} · {first.packageName}</p>
        <ul>{group.map(line=><li key={line.id}>{line.name} × {line.quantity}{line.selectionLabel&&<span> · {line.selectionLabel}</span>}{line.note&&<p>要求：{line.note}</p>}<small>{line.held?'暂停，等待领班处理 · ':line.status==='cancelled'?'已取消 · ':''}已放好 {line.readyQuantity} · 已取 {line.takenQuantity}{line.stoppedQuantity?` · 已停做 ${line.stoppedQuantity}`:''}{line.discardedReadyQuantity?` · 已作废 ${line.discardedReadyQuantity}`:''}</small></li>)}</ul>
        <footer>{station==='pickup'?<button disabled={locked||ready===0} onClick={()=>choose(number,'take')}>核对本批取走 · {ready} 份可取</button>:<>
          {pending>0&&<button disabled={locked} onClick={()=>choose(number,'start')}>开始制作 · {pending} 份</button>}
          {working>0&&<button disabled={locked} onClick={()=>choose(number,'ready')}>已放好 · {working} 份</button>}</>}</footer></article>
    })}{!filtered.length&&<p>{stale?'正在核对活动出品':'当前没有待处理的活动出品'}</p>}</div>}
    {station==='pickup'&&<details><summary>活动取走记录与异常撤回</summary>
      {(board?.receipts??[]).map(receipt=><p key={receipt.receiptId}>餐号 {receipt.lines[0]?.number} · 本批 {receipt.command?.lines.reduce((sum,line)=>sum+line.quantity,0)??0} 份 · {receipt.source?.label||'取餐岗位'}
        {receipt.canUndo&&receipt.command&&<button disabled={locked} onClick={()=>{setRecent({command:receipt.command!,result:receipt});setPhysical(false)}}>核对原批次</button>}</p>)}
    </details>}
    {station==='pickup'&&recent&&<details open><summary>核对所选原批次 · 餐号 {recent.result.lines[0]?.number}</summary><p>只在实物仍在取餐区、尚未交出时撤回原批次。已送出、洒漏或错送请交统筹处理。</p>
      <label><input type="checkbox" checked={physical} disabled={locked} onChange={event=>setPhysical(event.target.checked)}/>实物仍在取餐区</label>
      <button disabled={locked||!physical} onClick={()=>void submit({action:'undo_take',receiptId:recent.result.receiptId,physicalStillAtPickupPoint:true,lines:recent.command.lines.map(part=>({...part,expectedVersion:recent.result.lines.find(line=>line.id===part.lineId)?.version??part.expectedVersion}))})}>撤回原批次取走</button></details>}
  </section>
}
