import {useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react'
import type {PickupBoardData,PickupReceipt} from '../../shared/pickup-workflow'
import {staffErrorMessage} from '../../shared/staff-error-message'
import {PickupApi,PickupApiError,type PickupApiPort,type PickupMutationResult,type PickupRequest} from './pickup-api'
import {adjustPickupAmount,pickupDraft,pickupDraftCount,pickupDraftCurrent,pickupDraftOverLimit,pickupLines,pickupNeedsReview,pickupSelectionCurrent,pickupTables,pickupTakeCommand,pickupUndoCommand,pickupWaitLabel,
  PICKUP_PAGE_SIZE,PICKUP_REPEAT_GUARD_MS,type PickupDraft,type PickupLine,type PickupTable} from './pickup-board-state'
import './pickup-board.css'

export interface PickupBoardProps {staffSessionId:string;api?:PickupApiPort;onExit?:()=>void;onLoginRequired?:()=>void}
const clock=(value:string)=>new Date(value).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false})
const errorText=(error:unknown)=>error instanceof Error?error.message:'更新未完成，请核对原取餐操作'
const hint=(message:string|null)=>staffErrorMessage(message,'已有后续变化，请联系值班经理核对',409)

export function PickupBoard({staffSessionId,api:suppliedApi,onExit,onLoginRequired}:PickupBoardProps){
  const api=useMemo(()=>suppliedApi??new PickupApi({staffSessionId}),[suppliedApi,staffSessionId])
  const [data,setData]=useState<PickupBoardData|null>(null),[stale,setStale]=useState(true),[busy,setBusy]=useState(false)
  const [online,setOnline]=useState(()=>typeof navigator==='undefined'||navigator.onLine!==false)
  const [message,setMessage]=useState('正在读取取餐内容…'),[loginRequired,setLoginRequired]=useState(false)
  const [mode,setMode]=useState<'waiting'|'history'|'settings'>('waiting'),[page,setPage]=useState(0),[historyPage,setHistoryPage]=useState(0)
  const [draft,setDraft]=useState<PickupDraft|null>(null),[undo,setUndo]=useState<PickupReceipt|null>(null)
  const [recentId,setRecentId]=useState<string|null>(null),[guard,setGuard]=useState(false),[now,setNow]=useState(Date.now()),[,setStorageVersion]=useState(0)
  const [deviceLabel,setDeviceLabel]=useState('吧台取餐屏')
  const [showPrevious,setShowPrevious]=useState(false)
  const mounted=useRef(true),flight=useRef(false),readBusy=useRef(false),readSequence=useRef(0),readAbort=useRef<AbortController|null>(null)
  const latest=useRef<PickupBoardData|null>(null),pointer=useRef(false),queued=useRef<PickupBoardData|null>(null)
  const guardUntil=useRef(0),guardTimer=useRef<ReturnType<typeof setTimeout>|null>(null)
  const generation=useRef(0)
  const serverClock=useRef({at:Date.now(),received:performance.now()})
  const recovery=api.recovery()
  const read=useCallback(async()=>{
    readBusy.current=true;const sequence=++readSequence.current
    readAbort.current?.abort();const controller=new AbortController();readAbort.current=controller
    try{
      const next=await api.loadBoard(controller.signal)
      if(!mounted.current||sequence!==readSequence.current)throw new PickupApiError('读取已取消','PICKUP_ABORTED')
      const previous=latest.current
      if(previous&&previous.commandScope===next.commandScope&&next.revision<previous.revision)return previous
      latest.current=next;serverClock.current={at:Date.parse(next.generatedAt),received:performance.now()}
      if(pointer.current&&!flight.current)queued.current=next;else setData(next)
      setNow(serverClock.current.at);setStale(false);setLoginRequired(next.actor.actionSessionValid===false);setStorageVersion(value=>value+1)
      return next
    }catch(error){if(controller.signal.aborted)throw error
      if(mounted.current&&sequence===readSequence.current){setStale(true);setMessage(errorText(error));if([401,403].includes((error as {status?:number})?.status??0))setLoginRequired(true)}
      throw error
    }finally{if(sequence===readSequence.current)readBusy.current=false}
  },[api])
  useEffect(()=>{
    const effectGeneration=++generation.current
    mounted.current=true;flight.current=false;pointer.current=false;guardUntil.current=0;setGuard(false);setBusy(false)
    latest.current=null;queued.current=null;setData(null);setStale(true);setDraft(null);setUndo(null);setRecentId(null);setPage(0);setHistoryPage(0);setMode('waiting');setShowPrevious(false)
    void read().then(()=>{if(mounted.current)setMessage('核对实物后确认取走，送达同步完成')}).catch(()=>{})
    const refresh=()=>{if(document.visibilityState==='visible'&&!flight.current&&!readBusy.current)void read().catch(()=>{})}
    const connected=()=>{setOnline(true);refresh()},disconnected=()=>{setOnline(false);setStale(true);setMessage('连接中断，暂停确认；恢复连接后核对原结果')}
    const changed=()=>setStorageVersion(value=>value+1)
    const poll=setInterval(refresh,5000),clockTick=setInterval(()=>setNow(serverClock.current.at+performance.now()-serverClock.current.received),1000)
    document.addEventListener('visibilitychange',refresh);window.addEventListener('online',connected);window.addEventListener('offline',disconnected);window.addEventListener('storage',changed)
    return()=>{mounted.current=false;generation.current=effectGeneration+1;readAbort.current?.abort();clearInterval(poll);clearInterval(clockTick);if(guardTimer.current)clearTimeout(guardTimer.current)
      document.removeEventListener('visibilitychange',refresh);window.removeEventListener('online',connected);window.removeEventListener('offline',disconnected);window.removeEventListener('storage',changed)}
  },[read])
  const protect=()=>{guardUntil.current=performance.now()+PICKUP_REPEAT_GUARD_MS;setGuard(true);if(guardTimer.current)clearTimeout(guardTimer.current)
    guardTimer.current=setTimeout(()=>{if(mounted.current)setGuard(false)},PICKUP_REPEAT_GUARD_MS+10)}
  const leave=()=>{setDraft(null);setUndo(null);setMode('waiting')}
  const ready=!!data&&online&&!stale&&data.actor.actionSessionValid
  const unresolved=!!recovery.attempt||!!recovery.previousAttempt||!!recovery.error
  const locked=!ready||busy||unresolved
  const canTake=!locked&&!!data?.device&&data.actor.canPickup&&!guard
  const tables=pickupTables(data?.tables??[]),safePage=Math.min(page,Math.max(0,Math.ceil(tables.length/PICKUP_PAGE_SIZE)-1))
  const visible=tables.slice(safePage*PICKUP_PAGE_SIZE,(safePage+1)*PICKUP_PAGE_SIZE),command=draft?pickupTakeCommand(draft):null
  const draftCurrent=!!draft&&pickupDraftCurrent(draft,data?.tables??[])
  const recent=data?.history.find(receipt=>receipt.receiptId===recentId),currentUndo=undo&&data?.history.find(receipt=>receipt.receiptId===undo.receiptId)
  const history=data?.history??[],safeHistoryPage=Math.min(historyPage,Math.max(0,Math.ceil(history.length/PICKUP_PAGE_SIZE)-1))
  const choose=(table:PickupTable)=>{if(locked)return;setDraft(pickupDraft(table));setUndo(null);setMessage(`${table.tableCode} · 按本次实际拿到的份数调整`)}
  const beginUndo=(receipt:PickupReceipt)=>{if(locked||!data?.actor.canUndo)return;setDraft(null);setUndo(receipt);setMode('waiting');setMessage('仅当这次领取的实物仍在取餐区时撤回')}
  async function submit(request?:PickupRequest,previous=false){
    if(flight.current||!online||performance.now()<guardUntil.current)return
    if(request){
      if(!latest.current||stale||recovery.attempt||recovery.previousAttempt||recovery.error||!latest.current.actor.actionSessionValid)return
      if(request.kind==='command'){
        if(request.command.action==='take'&&(!latest.current.actor.canPickup||!pickupSelectionCurrent(request.command,latest.current.tables))){setMessage('出品或桌号已变化，请重新核对本次领取');return}
        if(request.command.action==='undo'&&!latest.current.actor.canUndo)return
      }else if(!latest.current.actor.canConfigure||(request.command.enabled&&!latest.current.setup.canConfigure)||(!request.command.enabled&&!latest.current.setup.configured))return
    }
    const runGeneration=generation.current
    flight.current=true;queued.current=null;setBusy(true);readSequence.current++;readAbort.current?.abort()
    let result:PickupMutationResult|null=null
    try{
      result=request?.kind==='command'?await api.run(request.command):request?.kind==='device'?await api.configureDevice(request.command):previous?await api.recoverPrevious():await api.recover()
      if(!mounted.current||generation.current!==runGeneration)return
      protect()
      const next=await read();api.acknowledgeRead(next)
      if(!mounted.current||generation.current!==runGeneration)return
      leave();setShowPrevious(false);setStorageVersion(value=>value+1)
      if(result.kind==='command'){
        setRecentId(result.data.receipt.receiptId)
        setMessage(result.data.receipt.undo?`${result.data.receipt.tableCode} · 已撤回取走与送达确认`:`${result.data.receipt.tableCode} · 已取走 ${result.data.receipt.quantity}份，送达已确认`)
      }else{setDeviceLabel(result.data.device?.label??'吧台取餐屏');setMessage(result.data.setup.configured?'本机已设为取餐屏':'本机已停用取餐操作')}
    }catch(error){if(mounted.current&&generation.current===runGeneration){setMessage(errorText(error));setStale(true);setStorageVersion(value=>value+1);if([401,403].includes((error as {status?:number})?.status??0))setLoginRequired(true)}}
    finally{if(generation.current===runGeneration){flight.current=false;if(mounted.current)setBusy(false)}}
  }
  const pointerEnd=()=>{pointer.current=false;setTimeout(()=>{const next=queued.current
    if(next&&mounted.current&&!pointer.current&&!flight.current){queued.current=null;if(next.commandScope===latest.current?.commandScope&&next.revision===latest.current.revision)setData(next)}
  },0)}
  return <section className="pickup-board" aria-label="吧台取餐工作台" onPointerDownCapture={()=>{pointer.current=true}} onPointerUpCapture={pointerEnd} onPointerCancel={pointerEnd}>
    <header className="pickup-top"><strong>吧台取餐</strong><nav aria-label="取餐查看">
      <button type="button" aria-pressed={mode==='waiting'} disabled={busy} onClick={leave}>待取 {tables.reduce((sum,table)=>sum+table.units.length,0)}份</button>
      <button type="button" aria-pressed={mode==='history'} disabled={busy} onClick={()=>{setMode('history');setDraft(null);setUndo(null)}}>取走记录</button>
      <button type="button" aria-pressed={mode==='settings'} disabled={busy} onClick={()=>{setMode('settings');setDraft(null);setUndo(null);setDeviceLabel(data?.device?.label??'吧台取餐屏')}}>设置</button>
    </nav><span className="pickup-connection">{!online?'连接中断':stale?'待更新':busy?'核对中':'已更新'}</span>{onExit&&<button type="button" onClick={onExit}>返回出品</button>}</header>
    <div className={`pickup-notice ${stale||recovery.error?'is-warning':''}`} role="status" aria-live="polite">
      <span>{busy?'正在核对原操作，请勿重复确认':recovery.error??(recovery.attempt?'有原操作结果待核对，请恢复后继续':recovery.previousAttempt?'本设备上次登录有取餐结果待核对':message)}</span>
      {recovery.attempt&&!recovery.error&&<button type="button" disabled={busy||!online||guard} onClick={()=>void submit()}>恢复原操作</button>}
      {recovery.previousAttempt&&!recovery.attempt&&!recovery.error&&<button type="button" disabled={busy} onClick={()=>setShowPrevious(true)}>查看本设备上次操作</button>}
      {!recovery.attempt&&(stale||!data)&&<button type="button" disabled={busy||!online} onClick={()=>void read().catch(()=>{})}>重新读取</button>}
      {(loginRequired||recovery.otherSession)&&onLoginRequired&&<button type="button" disabled={busy} onClick={onLoginRequired}>恢复登录</button>}
      {!draft&&!undo&&mode==='waiting'&&recent&&<span className="pickup-recent">{recent.tableCode} · {recent.undo?'已撤回':`刚取 ${recent.quantity}份`}{recent.canUndo&&<button type="button" disabled={locked||!data?.actor.canUndo} onClick={()=>beginUndo(recent)}>撤回</button>}</span>}
    </div>
    {data?.attention.length!==0&&data?.attention.length!==undefined&&<details className="pickup-attention"><summary>{data.attention.length}项出品待核对</summary>{data.attention.map(item=><p key={item.taskId}>{hint(item.message)} <a href={item.href}>查看原出品</a></p>)}</details>}
    {showPrevious&&recovery.previousAttempt?<div className="pickup-detail" aria-label="本设备上次取餐操作"><header><h2>核对本设备上次操作</h2><button type="button" disabled={busy} onClick={()=>setShowPrevious(false)}>返回</button></header>
      <div className="pickup-detail-scroll"><h3>{recovery.previousAttempt.preview?.title??(recovery.previousAttempt.request.kind==='device'?'上次取餐屏设置':'上次取餐确认')}</h3>
        <p>{clock(recovery.previousAttempt.createdAt)} · 结果待核对</p>{recovery.previousAttempt.preview?.lines.map((line,index)=><p className="pickup-recovery-line" key={index}>{line}</p>)}</div>
      <div className="pickup-detail-actions"><p>仅恢复上次确认的这批出品；本次登录须有对应操作权限。核对完成后再领取其他出品。</p>
        <button type="button" className="pickup-primary" disabled={!ready||busy||guard} onClick={()=>void submit(undefined,true)}>核对并恢复本设备上次操作</button></div>
    </div>:mode==='settings'||mode==='waiting'&&data&&(!data.device||!data.setup.configured)?<div className="pickup-setup">
      <h2>{data?.setup.configured?'本机取餐设置':'本机尚未设为取餐屏'}</h2>
      {data&&!data.setup.enabled&&<p>{data.device?'新设备设置已暂停；本机原有取餐与撤回权限仍可使用。':'新设备设置已暂停，请使用已启用的取餐屏。'}</p>}
      {data?.setup.configured?<><p>领取时无需选择员工姓名，取走即完成送达。</p>{data.actor.canConfigure&&<button type="button" disabled={locked||guard} onClick={()=>void submit({kind:'device',command:{enabled:false}})}>停用本机取餐屏</button>}</>
        :data?.actor.canConfigure&&data.setup.canConfigure?<><label>设备名称<input value={deviceLabel} maxLength={40} disabled={locked} onChange={event=>setDeviceLabel(event.target.value)}/></label>
          <button type="button" className="pickup-primary" disabled={locked||guard||!deviceLabel.trim()} onClick={()=>void submit({kind:'device',command:{enabled:true,label:deviceLabel.trim()}})}>设为取餐屏</button>
        </>:data?.setup.enabled&&<p>请由有设备设置权限的管理员将本机设为取餐屏。正常取餐无需选择姓名。</p>}
    </div>:mode==='history'?<div className="pickup-history" aria-label="取走记录">
      {history.slice(safeHistoryPage*PICKUP_PAGE_SIZE,(safeHistoryPage+1)*PICKUP_PAGE_SIZE).map(receipt=><article key={receipt.receiptId}><div><strong>{receipt.tableCode} · {receipt.quantity}份</strong><span>{clock(receipt.takenAt)} · {receipt.undo?'已撤回，待取餐':'已取走，送达已确认'}</span>
        <p>{pickupLines(receipt.units).map(line=>`${line.location} · ${line.name} × ${line.units.length}${line.notes?`（${line.notes}）`:''}`).join('；')}</p>{!receipt.canUndo&&!receipt.undo&&<small>{hint(receipt.undoBlockedReason)}</small>}</div>
        {!receipt.undo&&<button type="button" disabled={locked||!receipt.canUndo||!data?.actor.canUndo} onClick={()=>beginUndo(receipt)}>核对并撤回</button>}</article>)}
      {!history.length&&<p className="pickup-empty">暂无取走记录</p>}
      <Pager page={safeHistoryPage} total={history.length} onChange={setHistoryPage}/>
    </div>:undo?<div className="pickup-detail pickup-undo" aria-label="撤回本次取走">
      <header><h2>撤回 {undo.tableCode} · {undo.quantity}份</h2><button type="button" disabled={busy} onClick={leave}>取消</button></header>
      <div className="pickup-detail-scroll"><p>{clock(undo.takenAt)} · 取走确认</p><LineList lines={pickupLines(undo.units)}/></div>
      <div className="pickup-detail-actions"><p>仅当实物仍在取餐区时撤回；原份恢复待取，送达确认同步撤销。</p>
        {(!currentUndo?.canUndo||currentUndo.revision!==undo.revision)&&<p className="pickup-warning">{hint(currentUndo?.undoBlockedReason??'这条记录已有变化，请返回重新核对')}</p>}
        <button type="button" className="pickup-primary" disabled={locked||guard||!currentUndo?.canUndo||currentUndo.revision!==undo.revision||!data?.actor.canUndo} onClick={()=>{const body=pickupUndoCommand(undo);if(body)void submit({kind:'command',command:body})}}>{guard?'请稍候':'实物仍在取餐区，确认撤回'}</button>
      </div>
    </div>:draft?<PickupDetail key={`${draft.tableSessionId}:${draft.lines.map(line=>line.units.map(unit=>unit.unitId).join(',')).join(';')}`} draft={draft} locked={locked} canCancel={!busy} canConfirm={canTake&&draftCurrent} guard={guard}
      onCancel={leave} onAdjust={(key,delta)=>setDraft(current=>current?adjustPickupAmount(current,key,delta):null)} onConfirm={()=>{if(command)void submit({kind:'command',command})}} changed={!draftCurrent}/>
    :data?.device&&data.setup.configured&&data.actor.actionSessionValid&&!data.actor.canPickup?<div className="pickup-setup" role="status">
      <h2>本机已设为取餐屏</h2><p>请使用有取餐权限的岗位登录，登录后即可直接确认取走。</p>
      {onLoginRequired&&<button type="button" className="pickup-primary" onClick={onLoginRequired}>切换工作账号</button>}
    </div>:<main className="pickup-waiting" aria-label="待取餐桌台">
      {data&&!data.setup.enabled&&<p className="pickup-warning">新设备设置已暂停，本屏仍可取餐、撤回。</p>}
      <div className="pickup-oldest">{tables.length?`最久待取 ${tables[0]!.tableCode} · ${pickupWaitLabel(tables[0]!.units,now)}`:'拿到实物后确认'}</div>
      <div className="pickup-tickets">{visible.map(table=><PickupTicket key={`${table.tableSessionId}:${table.locationVersion}`} table={table} now={now} locked={locked} canTake={canTake} guard={guard}
        onSelect={()=>choose(table)} onTake={()=>{const body=pickupTakeCommand(pickupDraft(table));if(body)void submit({kind:'command',command:body})}}/>)}</div>
      {data&&data.actor.canPickup&&!tables.length&&<p className="pickup-empty">当前没有待取餐的出品</p>}
      <Pager page={safePage} total={tables.length} onChange={setPage}/>
    </main>}
    <footer className="pickup-foot">取走即完成送达，手机自动同步，无需再次确认。</footer>
  </section>
}

function Pager({page,total,onChange}:{page:number;total:number;onChange:(value:number)=>void}){
  if(total<=PICKUP_PAGE_SIZE)return null
  const pages=Math.ceil(total/PICKUP_PAGE_SIZE)
  return <nav className="pickup-pages" aria-label="取餐分页"><button type="button" disabled={page===0} onClick={()=>onChange(page-1)}>上一页</button><span>{page+1}/{pages}</span><button type="button" disabled={page+1>=pages} onClick={()=>onChange(page+1)}>下一页</button></nav>
}
function PickupTicket({table,now,locked,canTake,guard,onSelect,onTake}:{table:PickupTable;now:number;locked:boolean;canTake:boolean;guard:boolean;onSelect:()=>void;onTake:()=>void}){
  const lines=useMemo(()=>pickupLines(table.units),[table.units]),content=useRef<HTMLDivElement>(null),[overflow,setOverflow]=useState(true)
  useLayoutEffect(()=>{const check=()=>{if(content.current)setOverflow([...content.current.querySelectorAll<HTMLElement>('[data-pickup-line]')].some(line=>line.scrollWidth>line.clientWidth+1))}
    check();const observer=typeof ResizeObserver==='undefined'?null:new ResizeObserver(check);if(content.current)observer?.observe(content.current)
    void document.fonts?.ready.then(check);return()=>observer?.disconnect()
  },[lines])
  const review=pickupNeedsReview(lines)||overflow
  return <article className="pickup-ticket" data-table-code={table.tableCode}><header><strong>{table.tableCode}</strong><span>{table.units.length}份待取 · {pickupWaitLabel(table.units,now)}</span></header>
    <div className="pickup-ticket-lines" ref={content}>{lines.slice(0,3).map(line=><p key={line.key} data-pickup-line><span className="pickup-location">{line.location}</span>{line.name} × {line.units.length}{line.notes&&<em> · {line.notes.length>12?'有特殊要求，请核对':line.notes}</em>}</p>)}</div>
    <div className="pickup-ticket-actions">{review?<button type="button" className="pickup-primary" disabled={locked} onClick={onSelect}>{lines.length>3?'查看全部并核对':'核对全部内容'}</button>:<><button type="button" className="pickup-primary" disabled={!canTake} onClick={onTake}>{guard?'请稍候':`本次 ${table.units.length}份已取走`}</button><button type="button" disabled={locked} onClick={onSelect}>少取几份</button></>}</div>
  </article>
}
function LineList({lines}:{lines:PickupLine[]}){return <>{lines.map(line=><div className="pickup-full-line" key={line.key}><strong>{line.name} × {line.units.length}</strong><small>{line.location}</small>{line.notes&&<p>{line.notes}</p>}</div>)}</>}
function PickupDetail({draft,locked,canCancel,canConfirm,guard,changed,onCancel,onAdjust,onConfirm}:{draft:PickupDraft;locked:boolean;canCancel:boolean;canConfirm:boolean;guard:boolean;changed:boolean;onCancel:()=>void;onAdjust:(key:string,delta:-1|1)=>void;onConfirm:()=>void}){
  const area=useRef<HTMLDivElement>(null),[readAll,setReadAll]=useState(false)
  useLayoutEffect(()=>{const element=area.current;if(!element)return
    const check=()=>{if(element.scrollHeight<=element.clientHeight+2||element.scrollTop+element.clientHeight>=element.scrollHeight-3)setReadAll(true)}
    check();const observer=typeof ResizeObserver==='undefined'?null:new ResizeObserver(check);observer?.observe(element)
    return()=>observer?.disconnect()
  },[])
  const count=pickupDraftCount(draft),overLimit=pickupDraftOverLimit(draft)
  return <div className="pickup-detail" aria-label={`${draft.tableCode} 本次取餐`}><header><h2>{draft.tableCode} · 本次取走 {count}份</h2><button type="button" disabled={!canCancel} onClick={onCancel}>取消</button></header>
    <div className="pickup-detail-scroll" ref={area} onScroll={event=>{const element=event.currentTarget;if(element.scrollTop+element.clientHeight>=element.scrollHeight-3)setReadAll(true)}}>
      {draft.lines.map(line=><div className="pickup-full-line pickup-adjust-line" key={line.key}><div><strong>{line.name}</strong><small>{line.location} · 待取 {line.units.length}份</small>{line.notes&&<p>{line.notes}</p>}</div>
        <div className="pickup-stepper"><button type="button" aria-label={`减少 ${line.name} 数量`} disabled={locked||draft.amounts[line.key]===0} onClick={()=>onAdjust(line.key,-1)}>−</button>
          <input type="number" inputMode="none" readOnly tabIndex={-1} value={draft.amounts[line.key]} aria-label={`${line.name} 本次取走数量`}/>
          <button type="button" aria-label={`增加 ${line.name} 数量`} disabled={locked||draft.amounts[line.key]===line.units.length} onClick={()=>onAdjust(line.key,1)}>＋</button></div>
      </div>)}
    </div><div className="pickup-detail-actions"><p>{changed?'出品或桌号已变化，请取消后重新核对':overLimit?'本桌出品较多，请减少本次领取数量后分批确认':!readAll?'请向下查看全部出品和特殊要求':'核对实际拿到的份数后确认'}</p>
      <button type="button" className="pickup-primary" disabled={!canConfirm||!readAll||!count||overLimit} onClick={onConfirm}>{guard?'请稍候':`本次 ${count}份已取走`}</button></div>
  </div>
}
