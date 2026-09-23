import {useCallback,useEffect,useMemo,useRef,useState} from 'react'
import type {KitchenBoardData,KitchenCommand,KitchenCommandResult,KitchenStartSelection} from '../../shared/kitchen-production'
import {DurableStaffCommand} from '../durable-staff-command'
import type {StaffActionsApiPort} from './staff-actions-api'
import {kitchenAllocation,kitchenDraftAfterReady,kitchenGroups,kitchenReadySelection,kitchenSelectionCurrent,type KitchenReadySelection} from './kitchen-board-state'
import './kitchen-production-board.css'

type Drafts=Record<string,Record<string,KitchenReadySelection>>
type KitchenPreference={quantity:number;equipment:string;minutes:string}
type StartDraft={key:string;quantity:string;items:KitchenStartSelection[];equipment:string;minutes:string}
const pageSize=4
function stored<T>(key:string,fallback:T):T{try{return JSON.parse(localStorage.getItem(key)??'null')??fallback}catch{return fallback}}
function storage(){try{return localStorage}catch{return undefined}}
function shortOrder(value:string){return value.length>14?value.slice(-10):value}
function clock(value:string){return new Date(value).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false})}

export function KitchenProductionBoard({api,employeeId,blocked,onChanged,onLegacy,onLoginRequired}:{
  api:StaffActionsApiPort;employeeId:string;blocked:boolean;onChanged:()=>Promise<void>;onLegacy:(ids:string[])=>void;onLoginRequired?:()=>void
}){
  const storageKey=`mbox.kitchen.drafts.v1:${employeeId}`
  const [data,setData]=useState<KitchenBoardData|null>(null)
  const [expanded,setExpanded]=useState(true)
  const [stale,setStale]=useState(true)
  const [busy,setBusy]=useState(false)
  const [message,setMessage]=useState('正在读取后厨队列…')
  const [query,setQuery]=useState('')
  const [start,setStart]=useState<StartDraft|null>(()=>stored<{start:StartDraft|null}>(storageKey,{start:null}).start)
  const [drafts,setDrafts]=useState<Drafts>(()=>stored<{drafts:Drafts}>(storageKey,{drafts:{}}).drafts)
  const [selectedBatch,setSelectedBatch]=useState<string|null>(()=>stored<{selectedBatch?:string}>(storageKey,{}).selectedBatch??null)
  const [page,setPage]=useState(()=>stored<{page?:number}>(storageKey,{}).page??0)
  const [now,setNow]=useState(Date.now())
  const readBusy=useRef(false),flight=useRef(false),readRevision=useRef(0),controller=useRef<AbortController|null>(null),alive=useRef(true)
  const callbacks=useRef({onChanged,onLegacy});callbacks.current={onChanged,onLegacy}
  const pointer=useRef<string|null>(null)
  const journal=useMemo(()=>new DurableStaffCommand<KitchenCommand,KitchenCommandResult>(`kitchen:${employeeId}`,
    (body,key)=>api.runKitchenCommand!(employeeId,body,key),storage(),true),[api,employeeId])

  const read=useCallback(async()=>{
    readBusy.current=true
    const revision=++readRevision.current
    controller.current?.abort();const abort=new AbortController();controller.current=abort
    try{
      const next=await api.loadKitchenBoard!(abort.signal)
      if(!alive.current||revision!==readRevision.current)throw new Error('读取已中断，请恢复原操作')
      if(next.employeeId!==employeeId)throw new Error('登录员工已改变，请重新进入后厨')
      setData(next);setStale(false);callbacks.current.onLegacy(next.legacyTaskIds)
    }catch(error){if(abort.signal.aborted)throw error
      if(alive.current&&revision===readRevision.current){setStale(true);setMessage(error instanceof Error?error.message:'队列更新失败，请重新读取')
        if([401,403].includes((error as {status?:number})?.status??0))setData(null)}
      throw error
    }finally{if(revision===readRevision.current)readBusy.current=false}
  },[api,employeeId])
  useEffect(()=>{alive.current=true;void read().then(()=>setMessage('按下单时间排列；新单不会加入已经开做的批次')).catch(()=>{})
    const timer=setInterval(()=>setNow(Date.now()),1000)
    const poll=setInterval(()=>{if(!flight.current&&!readBusy.current)void read().catch(()=>{})},5000)
    return()=>{alive.current=false;controller.current?.abort();clearInterval(timer);clearInterval(poll)}
  },[read])
  useEffect(()=>{try{localStorage.setItem(storageKey,JSON.stringify({drafts,start,selectedBatch,page}))}catch{setMessage('选择暂时无法保存；提交前必须恢复设备存储')}},[drafts,start,selectedBatch,page,storageKey])
  useEffect(()=>{if(!expanded)return;const old=document.body.style.overflow;document.body.style.overflow='hidden'
    return()=>{document.body.style.overflow=old}},[expanded])

  const needle=query.trim().toLowerCase()
  const groups=kitchenGroups(data?.pending??[])
  const group=groups.find(item=>item.key===start?.key)
  const batch=data?.batches.find(item=>item.id===selectedBatch)
  const selected=selectedBatch?drafts[selectedBatch]??{}:{}
  const destinations=batch?[...new Set(batch.units.filter(unit=>unit.state==='started').map(unit=>unit.taskId))].map(id=>batch.units.filter(unit=>unit.taskId===id)):[]
  const pages=Math.max(1,Math.ceil(destinations.length/pageSize)),safePage=Math.min(page,pages-1)
  const visible=destinations.slice(safePage*pageSize,(safePage+1)*pageSize)
  const pageSelected=visible.map(units=>selected[units[0]!.taskId]).filter((item):item is KitchenReadySelection=>!!item)
  const pageQuantity=pageSelected.reduce((sum,item)=>sum+item.unitIds.length,0)
  const otherQuantity=Object.values(selected).reduce((sum,item)=>sum+item.unitIds.length,0)-pageQuantity
  const allRemaining=destinations.map(units=>kitchenReadySelection(units,units.filter(unit=>unit.state==='started').length)).filter((item):item is KitchenReadySelection=>!!item)
  const allQuantity=allRemaining.reduce((sum,item)=>sum+item.unitIds.length,0)
  const allValid=!!batch&&batch.units.filter(unit=>unit.state==='started').every(unit=>!unit.held&&!unit.stopped)
  const readyValid=pageSelected.every(item=>kitchenSelectionCurrent(item,batch?.units??[]))
  const unresolved=journal.pending()
  const locked=blocked||busy||stale||!data?.canPrepare||!!unresolved
  const startValid=!!start&&!!group&&start.items.length>0&&start.items.every(item=>data?.pending.some(current=>current.taskId===item.taskId&&current.canPrepare&&current.unmade>=item.quantity&&current.unmade===item.expectedUnmade&&current.tableId===item.tableId&&current.tableSessionId===item.tableSessionId&&current.locationVersion===item.locationVersion))
  const seconds=start?.minutes.trim()?Math.round(Number(start.minutes)*60):null
  const equipmentBusy=!!start?.equipment.trim()&&data?.batches.some(item=>item.equipment?.replace(/\s/g,'').toLowerCase()===start.equipment.replace(/\s/g,'').toLowerCase()&&!item.releasedAt)===true
  const timeValid=seconds===null||Number.isSafeInteger(seconds)&&seconds>0&&seconds<=36000
  const overdue=data?.batches.filter(item=>(!item.equipment||!item.releasedAt)&&item.startedAt&&item.expectedSeconds&&now-Date.parse(item.startedAt)>item.expectedSeconds*1000).length??0

  function focusBatch(id:string,search=query){
    setSelectedBatch(id)
    const current=data?.batches.find(item=>item.id===id),find=search.trim().toLowerCase()
    const taskIds=[...new Set(current?.units.filter(unit=>unit.state==='started').map(unit=>unit.taskId)??[])]
    const index=find?taskIds.findIndex(taskId=>current?.units.some(unit=>unit.taskId===taskId&&(unit.tableCode.toLowerCase().includes(find)||unit.orderPublicId.toLowerCase().includes(find)))):0
    setPage(index<0?0:Math.floor(index/pageSize))
  }
  function choose(key:string,quantity?:string){
    const chosen=groups.find(item=>item.key===key);if(!chosen)return
    const preference=stored<Record<string,KitchenPreference>>(`mbox.kitchen.preferences:${employeeId}`,{})[key]
    const amount=quantity??String(Math.min(preference?.quantity??1,chosen.total))
    const previous=start?.key===key?start:preference
    setStart({key,quantity:amount,items:kitchenAllocation(chosen.items,Number(amount)),equipment:previous?.equipment??'',minutes:previous?.minutes??''})
  }
  function selectQuantity(taskId:string,quantity:number){
    if(!batch)return
    const value=kitchenReadySelection(batch.units.filter(unit=>unit.taskId===taskId),quantity)
    setDrafts(current=>{const next={...current[batch.id]};if(value)next[taskId]=value;else delete next[taskId];return {...current,[batch.id]:next}})
  }
  async function submit(command?:KitchenCommand){
    if(flight.current)return
    flight.current=true;setBusy(true);readRevision.current++;controller.current?.abort()
    const original=command??journal.pending()?.body
    try{
      const result=command?await journal.submit(command):await journal.recover()
      await journal.refresh(read)
      if(!alive.current)return
      if(original?.action==='ready')setDrafts(current=>({...current,[original.batchId]:kitchenDraftAfterReady(current[original.batchId]??{},original.items)}))
      if(original?.action==='start'||original?.action==='quick-ready'){
        if(original.action==='start'){
          const preferences=stored<Record<string,KitchenPreference>>(`mbox.kitchen.preferences:${employeeId}`,{})
          try{localStorage.setItem(`mbox.kitchen.preferences:${employeeId}`,JSON.stringify({...preferences,[original.compatibilityKey]:{quantity:result.quantity,equipment:original.equipment??'',minutes:original.expectedSeconds===null?'':String(original.expectedSeconds/60)}}))}catch{/* Original commands remain durably recorded. */}
        }
        setStart(null);if(original.action==='start'){setSelectedBatch(result.batchId);setPage(0)}
      }
      setMessage(result.action==='release'?'已登记实际出锅；剩余份数继续分盘':result.action==='start'?`已开始 ${result.quantity} 份，原订单分配已保存`:`已备齐 ${result.quantity} 份，已加入服务员取送队列`)
      void callbacks.current.onChanged().catch(()=>{})
    }catch(error){if(alive.current){setMessage(error instanceof Error?error.message:'操作结果未能确认，请恢复原操作');setStale(true)}}
    finally{flight.current=false;if(alive.current)setBusy(false)}
  }
  function button(command:KitchenCommand,label:string,disabled:boolean){
    const signature=JSON.stringify(command)
    return <button type="button" disabled={disabled} onPointerDown={()=>{pointer.current=signature}}
      onClick={()=>{const down=pointer.current;pointer.current=null;if(down!==null&&down!==signature){setMessage('刚才选择的批次已改变，请重新核对后点击');return}void submit(command)}}>{label}</button>
  }
  if(!expanded)return <button type="button" className="kitchen-open" onClick={()=>setExpanded(true)}>打开后厨双板工作台{unresolved?' · 有待恢复操作':''}</button>
  return <section className="kitchen-board" aria-label="后厨制作工作台" onKeyDown={event=>{if(event.key==='Escape')setExpanded(false)}}>
    <header className="kitchen-top"><div><strong>后厨工作台</strong><small>{overdue>0?`${overdue} 批计时已到 · 请核对实际出锅`:'旧单优先 · 按实际份数制作'}</small></div>
      <label>找桌 / 菜品 / 订单<input value={query} onChange={event=>{setQuery(event.target.value);if(selectedBatch)focusBatch(selectedBatch,event.target.value)}} placeholder="桌号、菜品或订单"/></label>
      <button type="button" onClick={()=>void read().catch(()=>{})} disabled={busy}>刷新</button>
      <button type="button" onClick={()=>setExpanded(false)}>取送 / 历史 / 异常</button>
    </header>
    <div className={`kitchen-notice ${stale?'is-stale':''}`} role="status" aria-label="后厨操作反馈"><span>{busy?'正在核对原操作，请勿再次制作…':unresolved?'有原操作结果待确认，恢复后才能继续':message}{stale&&!busy?'；操作暂停，重新读取后继续':''}</span>
      {unresolved&&<button type="button" disabled={busy} onClick={()=>void submit()}>恢复原操作</button>}
      {(!data||data.actionSessionValid===false)&&onLoginRequired&&<button type="button" onClick={onLoginRequired}>恢复登录</button>}
    </div>
    {data&&!data.canStart&&data.canPrepare&&<p className="kitchen-paused">新增制作已暂停；原批次可继续出锅、分盘或恢复原结果。</p>}
    <div className="kitchen-columns">
      <section className="kitchen-pane" aria-label="待制作"><h2>待制作 <span>{data?.pending.reduce((sum,item)=>sum+item.unmade,0)??0} 份</span></h2>
        <div className="kitchen-cards">{groups.filter(item=>!needle||item.name.toLowerCase().includes(needle)||item.items.some(row=>row.tableCode.toLowerCase().includes(needle)||row.orderPublicId.toLowerCase().includes(needle))).map(item=><button type="button" className="kitchen-group" key={item.key} aria-pressed={start?.key===item.key} disabled={locked} onClick={()=>choose(item.key)}>
          <strong>{item.name} <b>{item.total} 份</b></strong><small>{item.notes||'无特殊备注'} · 最早 {clock(item.anchor)}</small>
        </button>)}{data&&groups.length===0&&<p>当前没有待开做菜品</p>}</div>
        <div className="kitchen-detail">{start&&group?<><h3>{group.name}<small>{group.notes||'无特殊备注'}</small></h3>
          <div className="kitchen-start-fields"><label>本批份数<input type="number" min="1" max="999" value={start.quantity} disabled={locked} onChange={event=>choose(start.key,event.target.value)}/></label>
            <label>实际设备<input list="kitchen-equipment" value={start.equipment} maxLength={40} placeholder="不填则无需占用设备" disabled={locked} onChange={event=>setStart({...start,equipment:event.target.value})}/><datalist id="kitchen-equipment">{data?.equipmentLabels.map(label=><option key={label} value={label}/>)}</datalist></label>
            <label>预计分钟<input type="number" min="0" max="600" step="0.5" placeholder="可不填" value={start.minutes} disabled={locked} onChange={event=>setStart({...start,minutes:event.target.value})}/></label></div>
          <div className="kitchen-allocation" aria-label="本批原订单分配">{start.items.map(item=>{const source=data?.pending.find(row=>row.taskId===item.taskId);return <div key={item.taskId}><strong>{source?.tableCode??'待核对'} × {item.quantity}</strong><span>{shortOrder(source?.orderPublicId??'原订单已改变')}</span></div>})}</div>
          {equipmentBusy&&<small role="status">所选设备仍被占用；实际出锅后释放，或改选另一台设备。</small>}
          {!timeValid&&<small role="alert">预计时间应大于0且不超过600分钟；也可留空。</small>}
          {!startValid&&<small role="alert">所选数量、桌号或任务已改变，请重新选择本批份数。</small>}
        </>:<p className="kitchen-placeholder">先选菜品，再核对本批份数与对应桌号。</p>}</div>
        <footer className="kitchen-actions">{start? <>{button({action:'start',compatibilityKey:start.key,items:start.items,equipment:start.equipment.trim()||null,expectedSeconds:seconds},`开始制作 ${start.quantity||0} 份`,locked||!data?.canStart||!startValid||!timeValid||equipmentBusy)}
          {button({action:'quick-ready',compatibilityKey:start.key,items:start.items,equipment:null,expectedSeconds:null},'已做好 · 直接备齐',locked||!data?.canStart||!startValid)}</>:<p>只转移本次选定份数；新订单留在待制作。</p>}</footer>
      </section>
      <section className="kitchen-pane" aria-label="正在制作"><h2>正在制作 <span>{data?.batches.length??0} 批</span></h2>
        <div className="kitchen-cards">{data?.batches.filter(item=>!needle||item.productName.toLowerCase().includes(needle)||item.units.some(unit=>unit.tableCode.toLowerCase().includes(needle)||unit.orderPublicId.toLowerCase().includes(needle))).map(item=>{
          const remaining=item.units.filter(unit=>unit.state==='started').length
          const elapsed=item.startedAt?Math.floor((now-Date.parse(item.startedAt))/60000):null
          return <button type="button" key={item.id} className="kitchen-group" aria-pressed={selectedBatch===item.id} onClick={()=>focusBatch(item.id)}><strong>{item.productName} <b>{remaining} / {item.originalQuantity} 份</b></strong>
            <small>{!item.equipment?'制作中 · 无需设备':!item.releasedAt?`${item.equipment} · 制作中`:'已出锅 · 待分盘'} · 开做 {item.startedAt?clock(item.startedAt):'直接备齐'}{elapsed!==null?` · 已 ${elapsed} 分钟`:''}</small></button>
        })}{data&&data.batches.length===0&&<p>当前没有在制批次</p>}</div>
        <div className="kitchen-detail">{batch?<><div className="kitchen-batch-title"><h3>{batch.productName}<small>{[batch.specification,batch.itemNote,batch.orderNote].filter(Boolean).join(' · ')||'无特殊备注'}</small></h3>
          {batch.equipment&&!batch.releasedAt&&button({action:'release',batchId:batch.id},`${batch.equipment} 已出锅`,locked||batch.employeeId!==employeeId)}</div>
          {batch.employeeId!==employeeId&&<small>由 {batch.employeeName} 制作，请原员工核对。</small>}
          <div className="kitchen-destinations">{visible.map(units=>{const unit=units[0]!,available=units.filter(row=>row.state==='started'&&!row.held&&!row.stopped).length,choice=selected[unit.taskId]
            return <label key={unit.taskId} className="kitchen-destination"><span><strong>{unit.tableCode}</strong><small title={unit.orderPublicId}>{clock(unit.orderCreatedAt)} · {shortOrder(unit.orderPublicId)}{unit.originalTableCode!==unit.tableCode?` · 原${unit.originalTableCode}`:''}</small></span>
              <span>可分 {available} 份{units.some(row=>row.held||row.stopped)&&<small className="kitchen-warning">含暂停 / 停止份数</small>}{choice&&!kitchenSelectionCurrent(choice,units)&&<small className="kitchen-warning">原选择已改变，请重新核对</small>}</span>
              <input aria-label={`${unit.tableCode} ${shortOrder(unit.orderPublicId)} 本次备齐份数`} type="number" min="0" max={available} value={choice?.unitIds.length??0} disabled={locked||batch.employeeId!==employeeId} onChange={event=>selectQuantity(unit.taskId,Number(event.target.value))}/>
            </label>})}</div>
          <div className="kitchen-pagination"><button type="button" disabled={safePage===0} onClick={()=>setPage(safePage-1)}>上一页</button><span>{safePage+1} / {pages} 页{otherQuantity>0?` · 其他页已选 ${otherQuantity} 份`:''}</span><button type="button" disabled={safePage+1>=pages} onClick={()=>setPage(safePage+1)}>下一页</button></div>
        </>:<p className="kitchen-placeholder">选择一个原制作批次，按桌分盘后通知取菜。</p>}</div>
        <footer className="kitchen-actions">{batch?<><button type="button" disabled={locked||batch.employeeId!==employeeId} onClick={()=>{
          const additions=visible.map(units=>kitchenReadySelection(units,units.filter(unit=>unit.state==='started'&&!unit.held&&!unit.stopped).length)).filter((item):item is KitchenReadySelection=>!!item)
          setDrafts(current=>({...current,[batch.id]:{...current[batch.id],...Object.fromEntries(additions.map(item=>[item.taskId,item]))}}))
        }}>本页选满</button>{button({action:'ready',batchId:batch.id,items:pageSelected},`本页 ${pageQuantity} 份备齐 · 通知取菜`,locked||pageQuantity===0||!readyValid||batch.employeeId!==employeeId)}
          <details className="kitchen-more"><summary aria-label="整批备齐选项">更多</summary><div><p>整批尚余 {allQuantity} 份，涉及 {allRemaining.length} 个原订单品项，包括其他页。请先核对全部实物。</p>
            {button({action:'ready',batchId:batch.id,items:allRemaining},`整批 ${allQuantity} 份已备齐`,locked||!allValid||allQuantity===0||batch.employeeId!==employeeId)}</div></details>
        </>:<p>已备齐自动进入取送；服务员送达后完成。</p>}</footer>
      </section>
    </div>
  </section>
}
