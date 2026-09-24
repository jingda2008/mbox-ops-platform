import {useCallback,useEffect,useMemo,useRef,useState,type ReactNode} from 'react'
import {useScreenViewport} from './use-screen-viewport'
import {ScreenFullscreenButton} from './ScreenFullscreenButton'
import {requiresStaffLogin} from './staff-session-error'
import type {KitchenBoardData,KitchenCommand,KitchenCommandResult,KitchenStartSelection,KitchenHandoffPreview,ProductionStation} from '../../shared/kitchen-production'
import {DurableStaffCommand} from '../durable-staff-command'
import type {StaffActionsApiPort} from './staff-actions-api'
import {kitchenAllocation,kitchenDraftAfterReady,kitchenGroups,kitchenReadySelection,kitchenSelectionCurrent,kitchenInitialReadyDraft,kitchenPreferredBatchQuantity,type KitchenReadySelection} from './kitchen-board-state'
import './kitchen-production-board.css'

type Drafts=Record<string,Record<string,KitchenReadySelection>>
type KitchenPreference={quantity:number;equipment:string;minutes:string}
type StartDraft={key:string;quantity:string;items:KitchenStartSelection[];equipment:string;minutes:string}
const pageSize=4
function stored<T>(key:string,fallback:T):T{try{return JSON.parse(localStorage.getItem(key)??'null')??fallback}catch{return fallback}}
function storage(){try{return localStorage}catch{return undefined}}
function shortOrder(value:string){return value.length>14?value.slice(-10):value}
function clock(value:string){return new Date(value).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false})}
function ProductionNote({text}:{text:string}){return text?<span className="kitchen-production-note">{text}</span>:null}

export function KitchenProductionBoard({api,employeeId,blocked,onChanged,onLegacy,onLoginRequired,stationCode='kitchen',headerActions}:{
  api:StaffActionsApiPort;employeeId:string;stationCode?:ProductionStation;blocked:boolean;onChanged:()=>Promise<void>;onLegacy:(ids:string[])=>void;onLoginRequired?:()=>void;headerActions?:ReactNode
}){
  const viewport=useScreenViewport()
  const stationLabel=stationCode==='bar'?'酒水':'后厨',pickupPlace=stationCode==='bar'?'酒水吧台':'后厨取餐口'
  const storageKey=`mbox.${stationCode}.drafts.v1:${employeeId}`
  const [handoff,setHandoff]=useState<KitchenHandoffPreview|null>(null)
  const [handoffReason,setHandoffReason]=useState('交班接续制作')
  const [physicalChecked,setPhysicalChecked]=useState(false)
  const [data,setData]=useState<KitchenBoardData|null>(null)
  const [loginRequired,setLoginRequired]=useState(false)
  const [expanded,setExpanded]=useState(true)
  const [stale,setStale]=useState(true)
  const [busy,setBusy]=useState(false)
  const [message,setMessage]=useState(`正在读取${stationLabel}队列…`)
  const [query,setQuery]=useState('')
  const [start,setStart]=useState<StartDraft|null>(()=>stored<{start:StartDraft|null}>(storageKey,{start:null}).start)
  const [drafts,setDrafts]=useState<Drafts>(()=>stored<{drafts:Drafts}>(storageKey,{drafts:{}}).drafts)
  const [selectedBatch,setSelectedBatch]=useState<string|null>(()=>stored<{selectedBatch?:string}>(storageKey,{}).selectedBatch??null)
  const [activePane,setActivePane]=useState<'pending'|'working'>(()=>selectedBatch?'working':'pending')
  const [page,setPage]=useState(()=>stored<{page?:number}>(storageKey,{}).page??0)
  const [now,setNow]=useState(Date.now())
  const readBusy=useRef(false),flight=useRef(false),readRevision=useRef(0),controller=useRef<AbortController|null>(null),alive=useRef(true)
  const callbacks=useRef({onChanged,onLegacy});callbacks.current={onChanged,onLegacy}
  const pointer=useRef<string|null>(null)
  const journal=useMemo(()=>new DurableStaffCommand<KitchenCommand,KitchenCommandResult>(`${stationCode}:${employeeId}`,
    (body,key)=>api.runKitchenCommand!(employeeId,body,key,stationCode),storage(),true),[api,employeeId,stationCode])

  const read=useCallback(async()=>{
    readBusy.current=true
    const revision=++readRevision.current
    controller.current?.abort();const abort=new AbortController();controller.current=abort
    try{
      const next=await api.loadKitchenBoard!(abort.signal,stationCode)
      if(!alive.current||revision!==readRevision.current)throw new Error('读取已中断，请恢复原操作')
      if(next.employeeId!==employeeId||next.stationCode!==stationCode)throw new Error('登录员工或岗位已改变，请重新进入制作屏')
      setData(next);setStale(document.visibilityState!=='visible'||navigator.onLine===false);setLoginRequired(next.actionSessionValid===false);callbacks.current.onLegacy(next.legacyTaskIds)
    }catch(error){if(abort.signal.aborted)throw error
      if(alive.current&&revision===readRevision.current){setStale(true);setLoginRequired(requiresStaffLogin(error));setMessage(error instanceof Error?error.message:'队列更新失败，请重新读取')
        if([401,403].includes((error as {status?:number})?.status??0))setData(null)}
      throw error
    }finally{if(revision===readRevision.current)readBusy.current=false}
  },[api,employeeId,stationCode])
  useEffect(()=>{alive.current=true;void read().then(()=>setMessage('按下单时间排列；新单不会加入已经开做的批次')).catch(()=>{})
    const timer=setInterval(()=>setNow(Date.now()),1000)
    const refresh=()=>{if(document.visibilityState==='visible'&&navigator.onLine!==false&&!flight.current&&!readBusy.current)void read().catch(()=>{})}
    const suspend=()=>{setStale(true);pointer.current=null
      if(!flight.current){readRevision.current++;controller.current?.abort();readBusy.current=false}}
    const resume=()=>{suspend();refresh()}
    const visibility=()=>{if(document.visibilityState==='visible')resume();else suspend()}
    document.addEventListener('visibilitychange',visibility);window.addEventListener('online',resume);window.addEventListener('offline',suspend);window.addEventListener('pageshow',resume)
    const poll=setInterval(refresh,5000)
    return()=>{alive.current=false;controller.current?.abort();clearInterval(timer);clearInterval(poll)
      document.removeEventListener('visibilitychange',visibility);window.removeEventListener('online',resume);window.removeEventListener('offline',suspend);window.removeEventListener('pageshow',resume)}
  },[read])
  useEffect(()=>{try{localStorage.setItem(storageKey,JSON.stringify({drafts,start,selectedBatch,page}))}catch{setMessage('选择暂时无法保存；提交前必须恢复设备存储')}},[drafts,start,selectedBatch,page,storageKey])
  useEffect(()=>{if(!expanded)return;const old=document.body.style.overflow;document.body.style.overflow='hidden'
    return()=>{document.body.style.overflow=old}},[expanded])

  const needle=query.trim().toLowerCase()
  const groups=kitchenGroups(data?.pending??[])
  const group=groups.find(item=>item.key===start?.key)
  const batch=data?.batches.find(item=>item.id===selectedBatch)
  // Freeze only the first selection of this immutable batch. Subsequent polls
  // never add new portions or restore quantities the operator cleared.
  useEffect(()=>{if(!batch)return;setDrafts(current=>Object.hasOwn(current,batch.id)?current:{...current,[batch.id]:kitchenInitialReadyDraft(batch.units)})},[batch])
  const selected=selectedBatch?drafts[selectedBatch]??{}:{}
  const destinations=batch?[...new Set(batch.units.filter(unit=>unit.state==='started'&&!unit.stopped).map(unit=>unit.taskId))].map(id=>batch.units.filter(unit=>unit.taskId===id)):[]
  const pages=Math.max(1,Math.ceil(destinations.length/pageSize)),safePage=Math.min(page,pages-1)
  const visible=destinations.slice(safePage*pageSize,(safePage+1)*pageSize)
  const pageSelected=visible.map(units=>selected[units[0]!.taskId]).filter((item):item is KitchenReadySelection=>!!item)
  const pageQuantity=pageSelected.reduce((sum,item)=>sum+item.unitIds.length,0)
  const otherQuantity=Object.values(selected).reduce((sum,item)=>sum+item.unitIds.length,0)-pageQuantity
  const allRemaining=destinations.map(units=>kitchenReadySelection(units,units.filter(unit=>unit.state==='started'&&!unit.stopped).length)).filter((item):item is KitchenReadySelection=>!!item)
  const allQuantity=allRemaining.reduce((sum,item)=>sum+item.unitIds.length,0)
  const allValid=!!batch&&batch.units.filter(unit=>unit.state==='started'&&!unit.stopped).every(unit=>!unit.held&&!unit.stopped)
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
    const taskIds=[...new Set(current?.units.filter(unit=>unit.state==='started'&&!unit.stopped).map(unit=>unit.taskId)??[])]
    const index=find?taskIds.findIndex(taskId=>current?.units.some(unit=>unit.taskId===taskId&&(unit.tableCode.toLowerCase().includes(find)||unit.orderPublicId.toLowerCase().includes(find)))):0
    setPage(index<0?0:Math.floor(index/pageSize))
  }
  function choose(key:string,quantity?:string){
    setActivePane('pending')
    const chosen=groups.find(item=>item.key===key);if(!chosen)return
    const preference=stored<Record<string,KitchenPreference>>(`mbox.${stationCode}.preferences:${employeeId}`,{})[key]
    const amount=quantity??String(kitchenPreferredBatchQuantity(chosen.items,preference?.quantity))
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
          const preferences=stored<Record<string,KitchenPreference>>(`mbox.${stationCode}.preferences:${employeeId}`,{})
          try{localStorage.setItem(`mbox.${stationCode}.preferences:${employeeId}`,JSON.stringify({...preferences,[original.compatibilityKey]:{quantity:result.quantity,equipment:original.equipment??'',minutes:original.expectedSeconds===null?'':String(original.expectedSeconds/60)}}))}catch{/* Original commands remain durably recorded. */}
        }
        setStart(null);if(original.action==='start'){setSelectedBatch(result.batchId);setPage(0);setActivePane('working')}
      }
      if(result.action==='handoff'){setHandoff(null);setPhysicalChecked(false)}
      setMessage('上次操作：'+(result.action==='handoff'?'已接续全部关联批次':result.action==='release'?'已确认设备清空':result.action==='start'?`已开始 ${result.quantity} 份`:`已确认 ${result.quantity} 份放好${pickupPlace}`))
      void callbacks.current.onChanged().catch(()=>{})
    }catch(error){if(alive.current){setMessage(error instanceof Error?error.message:'操作结果未能确认，请恢复原操作');setLoginRequired(requiresStaffLogin(error));setStale(true)}}
    finally{flight.current=false;if(alive.current)setBusy(false)}
  }
  async function previewHandoff(){
    if(!batch||!api.loadKitchenHandoffPreview||flight.current)return
    setBusy(true);flight.current=true
    try{const preview=await api.loadKitchenHandoffPreview(batch.id,stationCode);if(alive.current){setHandoff(preview);setPhysicalChecked(false)}}
    catch(error){setMessage(error instanceof Error?error.message:'接班范围读取失败，请重试')}
    finally{flight.current=false;setBusy(false)}
  }
  function button(command:KitchenCommand,label:string,disabled:boolean){
    const signature=JSON.stringify(command)
    return <button type="button" disabled={disabled} onPointerDown={()=>{pointer.current=signature}}
      onClick={()=>{const down=pointer.current;pointer.current=null;if(down!==null&&down!==signature){setMessage('刚才选择的批次已改变，请重新核对后点击');return}void submit(command)}}>{label}</button>
  }
  if(!expanded)return <button type="button" className="kitchen-open" onClick={()=>setExpanded(true)}>打开{stationLabel}制作屏{unresolved?' · 有待恢复操作':''}</button>
  return <section className="kitchen-board" style={viewport.style} data-short-viewport={viewport.short} aria-label={`${stationLabel}制作工作台`} onKeyDown={event=>{if(event.key==='Escape'&&!headerActions)setExpanded(false)}}>
    <header className="kitchen-top">{headerActions}<div><strong>{stationLabel}制作</strong>{overdue>0&&<small className="kitchen-warning">{overdue} 批计时已到 · 请核对实物</small>}<span className="kitchen-pickup-summary">待取 {data?.pickupSummary.awaitingPickup??0} · <span title="当前营业日累计">已取走 {data?.pickupSummary.pickedUpThisShift??0}</span></span></div>
      <label><span className="kitchen-search-label">找桌 / 品名 / 订单</span><input value={query} onChange={event=>{setQuery(event.target.value);if(selectedBatch)focusBatch(selectedBatch,event.target.value)}} placeholder="桌号、品名或订单"/></label>
      <button type="button" onClick={()=>void read().catch(()=>{})} disabled={busy}>刷新</button>
      {headerActions?<ScreenFullscreenButton/>:<button type="button" onClick={()=>setExpanded(false)}>收起</button>}
    </header>
    <div className={`kitchen-notice ${stale?'is-stale':''} ${!stale&&!busy&&!unresolved&&!loginRequired&&message==='按下单时间排列；新单不会加入已经开做的批次'?'is-idle':''}`} data-action-reveal="off" role="status" aria-label={`${stationLabel}操作反馈`}><span>{busy?'正在核对原操作，请勿再次制作…':unresolved?'有原操作结果待确认，恢复后才能继续':message}{stale&&!busy?'；操作暂停，重新读取后继续':''}</span>
      {unresolved&&<button type="button" disabled={busy} onClick={()=>void submit()}>恢复原操作</button>}
      {loginRequired&&onLoginRequired&&<button type="button" onClick={onLoginRequired}>恢复登录</button>}
    </div>
    {data&&!data.canStart&&data.canPrepare&&<p className="kitchen-paused">新增制作已暂停；原批次可继续分装、放好或恢复原结果。</p>}
    <nav className="kitchen-view-switch" aria-label="制作工序切换">
      <button type="button" aria-pressed={activePane==='pending'} onClick={()=>setActivePane('pending')}>待制作 {data?.pending.reduce((sum,item)=>sum+item.unmade,0)??0} 份</button>
      <button type="button" aria-pressed={activePane==='working'} onClick={()=>setActivePane('working')}>制作中 {data?.batches.length??0} 批</button>
    </nav>
    <div className="kitchen-columns" data-active-pane={activePane}>
      <section className={`kitchen-pane ${start&&group?'has-selection':'is-browsing'}`} aria-label="待制作"><h2>待制作 <span>{data?.pending.reduce((sum,item)=>sum+item.unmade,0)??0} 份</span></h2>
        <div className="kitchen-cards">{groups.filter(item=>!needle||item.name.toLowerCase().includes(needle)||item.items.some(row=>row.tableCode.toLowerCase().includes(needle)||row.orderPublicId.toLowerCase().includes(needle))).map(item=><button type="button" className="kitchen-group" key={item.key} aria-pressed={start?.key===item.key} disabled={locked} onClick={()=>choose(item.key)}>
          <strong>{item.name} <b>{item.total} 份</b></strong><ProductionNote text={item.notes}/><small>{!item.notes&&'无特殊备注 · '}最早 {clock(item.anchor)}</small>
        </button>)}{data&&groups.length===0&&<p>当前没有待制作的出品</p>}</div>
        <div className="kitchen-detail">{start&&group?<><h3>{group.name}</h3><ProductionNote text={group.notes}/>
          <div className="kitchen-start-fields">
            <div className="kitchen-quantity-field"><label htmlFor={`${stationCode}-batch-quantity`}>本批份数</label><div className="kitchen-quantity-stepper">
              <button type="button" aria-label="本批减少一份" disabled={locked||Number(start.quantity)<=1} onClick={()=>choose(start.key,String(Math.max(1,Number(start.quantity)-1)))}>−</button>
              <input id={`${stationCode}-batch-quantity`} type="number" min="1" max="999" value={start.quantity} disabled={locked} onChange={event=>choose(start.key,event.target.value)}/>
              <button type="button" aria-label="本批增加一份" disabled={locked||Number(start.quantity)>=Math.min(group.total,999)} onClick={()=>choose(start.key,String(Math.min(group.total,999,Number(start.quantity)+1)))}>＋</button>
            </div></div>
            <details className="kitchen-settings" open={stationCode==='kitchen'&&!headerActions?true:undefined}>
              <summary>制作设置{start.equipment?` · ${start.equipment}`:''}{start.minutes?` · ${start.minutes}分钟`:''}</summary>
              <div><label>实际设备<input list="kitchen-equipment" value={start.equipment} maxLength={40} placeholder="可不填" disabled={locked} onChange={event=>setStart({...start,equipment:event.target.value})}/><datalist id="kitchen-equipment">{data?.equipmentLabels.map(label=><option key={label} value={label}/>)}</datalist></label>
              <label>预计分钟<input type="number" min="0" max="600" step="0.5" placeholder="可不填" value={start.minutes} disabled={locked} onChange={event=>setStart({...start,minutes:event.target.value})}/></label></div>
            </details>
          </div>
          <div className="kitchen-allocation" aria-label="本批原订单分配">{start.items.map(item=>{const source=data?.pending.find(row=>row.taskId===item.taskId);return <div key={item.taskId}><strong>{source?.tableCode??'待核对'} × {item.quantity}</strong><span>{shortOrder(source?.orderPublicId??'原订单已改变')}</span></div>})}</div>
          {equipmentBusy&&<small role="status">所选设备仍被占用；实际出锅后释放，或改选另一台设备。</small>}
          {!timeValid&&<small role="alert">预计时间应大于0且不超过600分钟；也可留空。</small>}
          {!startValid&&<small role="alert">所选数量、桌号或任务已改变，请重新选择本批份数。</small>}
        </>:<p className="kitchen-placeholder">先选出品，再核对份数与桌号。</p>}</div>
        <footer className="kitchen-actions">{start? <>{button({action:'start',compatibilityKey:start.key,items:start.items,equipment:start.equipment.trim()||null,expectedSeconds:seconds},`开始制作 ${start.quantity||0} 份`,locked||!data?.canStart||!startValid||!timeValid||equipmentBusy)}
          {button({action:'quick-ready',compatibilityKey:start.key,items:start.items,equipment:null,expectedSeconds:null},`已放好${pickupPlace}`,locked||!data?.canStart||!startValid)}</>:<p>仅开始选中的份数，其余留在待制作。</p>}</footer>
      </section>
      <section className={`kitchen-pane ${batch?'has-selection':'is-browsing'}`} aria-label="正在制作"><h2>正在制作 <span>{data?.batches.length??0} 批</span></h2>
        <div className="kitchen-cards">{data?.batches.filter(item=>!needle||item.productName.toLowerCase().includes(needle)||item.units.some(unit=>unit.tableCode.toLowerCase().includes(needle)||unit.orderPublicId.toLowerCase().includes(needle))).map(item=>{
          const remaining=item.units.filter(unit=>unit.state==='started'&&!unit.stopped).length,ready=item.units.filter(unit=>!unit.stopped&&unit.state==='ready').length,pickedUp=item.units.filter(unit=>!unit.stopped&&unit.state==='delivered').length
          const elapsed=item.startedAt?Math.max(0,Math.floor((now-Date.parse(item.startedAt))/60000)):null
          return <button type="button" key={item.id} className="kitchen-group" aria-pressed={selectedBatch===item.id} onClick={()=>{setActivePane('working');focusBatch(item.id)}}><strong>{item.productName} <b>余 {remaining} / {item.originalQuantity} 份</b></strong>
            <ProductionNote text={[item.specification,item.itemNote,item.orderNote].filter(Boolean).join(' · ')}/>
            <small>{!item.equipment?'制作中 · 无需设备':!item.releasedAt?`${item.equipment} · 制作中`:'设备已空 · 待分装'} · 开做 {item.startedAt?clock(item.startedAt):'直接备齐'}{elapsed!==null?` · 已 ${elapsed} 分钟`:''}</small><small>累计备齐 {ready+pickedUp} · 待取 {ready} · 已取 {pickedUp}</small></button>
        })}{data&&data.batches.length===0&&<p>当前没有在制批次</p>}</div>
        <div className="kitchen-detail">{batch?<><div className="kitchen-batch-title"><h3>{batch.productName}</h3>
          {batch.equipment&&!batch.releasedAt&&button({action:'release',batchId:batch.id,expectedOwnershipVersion:batch.ownershipVersion},`${batch.equipment} 已清空`,locked||batch.employeeId!==employeeId)}</div>
          <ProductionNote text={[batch.specification,batch.itemNote,batch.orderNote].filter(Boolean).join(' · ')}/>
          {batch.employeeId!==employeeId&&<div className="kitchen-owner"><small>当前负责人：{batch.employeeName}</small>{data?.canHandoff&&api.loadKitchenHandoffPreview&&<button type="button" disabled={locked} onClick={()=>void previewHandoff()}>核对并接班</button>}</div>}{destinations.length===0&&batch.equipment&&!batch.releasedAt&&<p>本批已无待制作份数，请核对设备实际清空后释放。</p>}
          <div className="kitchen-destinations">{visible.map(units=>{const unit=units[0]!,available=units.filter(row=>row.state==='started'&&!row.held&&!row.stopped).length,choice=selected[unit.taskId]
            return <label key={unit.taskId} className="kitchen-destination"><span><strong>{unit.tableCode}</strong><small title={unit.orderPublicId}>{clock(unit.orderCreatedAt)} · {shortOrder(unit.orderPublicId)}{unit.originalTableCode!==unit.tableCode?` · 原${unit.originalTableCode}`:''}</small></span>
              <span>可分 {available} 份{units.some(row=>row.held||row.stopped)&&<small className="kitchen-warning">含暂停 / 停止份数</small>}{choice&&!kitchenSelectionCurrent(choice,units)&&<small className="kitchen-warning">原选择已改变，请重新核对</small>}</span>
              <input aria-label={`${unit.tableCode} ${shortOrder(unit.orderPublicId)} 本次备齐份数`} type="number" min="0" max={available} value={choice?.unitIds.length??0} disabled={locked||batch.employeeId!==employeeId} onChange={event=>selectQuantity(unit.taskId,Number(event.target.value))}/>
            </label>})}</div>

        </>:<p className="kitchen-placeholder">选择正在制作的出品，按桌分装，放好取餐区后确认。</p>}</div>
        {batch&&pages>1&&<div className="kitchen-pagination"><button type="button" disabled={safePage===0} onClick={()=>setPage(safePage-1)}>上一页</button><span>{safePage+1} / {pages} 页{otherQuantity>0?` · 其他页已选 ${otherQuantity} 份`:null}</span><button type="button" disabled={safePage+1>=pages} onClick={()=>setPage(safePage+1)}>下一页</button></div>}
        <footer className="kitchen-actions">{batch?<><button type="button" disabled={locked||batch.employeeId!==employeeId} onClick={()=>{
          const additions=visible.map(units=>kitchenReadySelection(units,units.filter(unit=>unit.state==='started'&&!unit.held&&!unit.stopped).length)).filter((item):item is KitchenReadySelection=>!!item)
          setDrafts(current=>({...current,[batch.id]:{...current[batch.id],...Object.fromEntries(additions.map(item=>[item.taskId,item]))}}))
        }}>本页选满</button>{button({action:'ready',batchId:batch.id,expectedOwnershipVersion:batch.ownershipVersion,items:pageSelected},`本页 ${pageQuantity} 份已放好`,locked||pageQuantity===0||!readyValid||batch.employeeId!==employeeId)}
          <details className="kitchen-more"><summary aria-label="整批备齐选项">更多</summary><div><p>整批尚余 {allQuantity} 份，涉及 {allRemaining.length} 个原订单品项，包括其他页。请先核对全部实物。</p>
            {button({action:'ready',batchId:batch.id,expectedOwnershipVersion:batch.ownershipVersion,items:allRemaining},`整批 ${allQuantity} 份已放好`,locked||!allValid||allQuantity===0||batch.employeeId!==employeeId)}</div></details>
        </>:<p>放好取餐区后确认；服务员取走即计送达。</p>}</footer>
      </section>
    </div>
    {handoff&&<div className="kitchen-handoff-backdrop"><section className="kitchen-handoff" role="dialog" aria-modal="true" aria-label="接班实物核对">
      <h2>接续 {handoff.batches.length} 个关联制作批次</h2><p>同一订单分在多个批次时一并接班。请逐项核对实物和设备。</p>
      <div className="kitchen-handoff-lines">{handoff.displayLines.map(line=><p key={line.batchId}><strong>{line.productName} · {line.tableCodes.join('、')}</strong><br/>余 {line.remaining} 份 · {line.equipment??'无需设备'}{line.equipment?(line.released?'已清空':'待核对清空'):''}<ProductionNote text={[line.specification,line.itemNote,line.orderNote].filter(Boolean).join(' · ')}/></p>)}</div>
      <label>接班原因<input maxLength={1000} value={handoffReason} onChange={event=>setHandoffReason(event.target.value)}/></label>
      <label className="kitchen-physical-check"><input type="checkbox" checked={physicalChecked} onChange={event=>setPhysicalChecked(event.target.checked)}/>我已核对以上全部实物和设备</label>
      <footer><button type="button" disabled={busy} onClick={()=>setHandoff(null)}>暂不接班</button>{button({action:'handoff',batchId:handoff.anchorBatchId,expectedBatches:handoff.batches,expectedTasks:handoff.tasks,physicalChecked:true,reason:handoffReason},'确认接班',locked||!physicalChecked||handoffReason.trim().length<2)}</footer>
    </section></div>}
  </section>
}
