import {ItemAfterSalesPanel} from './ItemAfterSalesPanel'
import {useCallback,useEffect,useMemo,useRef,useState} from 'react'
import type {RemakePhysicalHandover} from '../shared/item-after-sales'
import {ItemAfterSalesApi} from './item-after-sales-api'

/** Physical-only follow-up after the original visit ends. The recovery pointer
 * also survives when the last processed share has disappeared from the queue. */
export function RemakePhysicalHandoverPanel({employeeId}:{employeeId:string}){
  const api=useMemo(()=>new ItemAfterSalesApi(employeeId),[employeeId]),storageKey=`mbox-remake-handover-v1:${employeeId}`
  const [data,setData]=useState<RemakePhysicalHandover|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[expanded,setExpanded]=useState(false)
  const [originalItem,setOriginalItem]=useState<string|null>(null)
  const [pendingItem,setPendingItem]=useState<string|null>(null),[needsRefresh,setNeedsRefresh]=useState(false)
  const [counts,setCounts]=useState<Record<string,string>>({}),[received,setReceived]=useState<Record<string,boolean>>({})
  const active=useRef(0),working=useRef(false),polling=useRef(false),version=useRef(0)
  const state=useRef({data,expanded,pendingItem,needsRefresh});state.current={data,expanded,pendingItem,needsRefresh}
  const pointer=useCallback((itemId:string|null)=>{setPendingItem(itemId);try{if(itemId)sessionStorage.setItem(storageKey,itemId);else sessionStorage.removeItem(storageKey)}catch{/* Actual command recovery stays in the API session memory. */}},[storageKey])
  const load=useCallback(async(more=false)=>{
    const generation=active.current,read=++version.current
    const value=await api.listRemakeHandover(more?state.current.data?.nextCursor??undefined:undefined)
    if(generation!==active.current||read!==version.current)return
    setData(current=>more&&current?{...value,items:[...current.items,...value.items.filter(row=>!current.items.some(old=>old.batchId===row.batchId))]}:value)
    setExpanded(more);setNeedsRefresh(false)
  },[api])
  useEffect(()=>{
    const generation=++active.current;setData(null);setError('');setNotice('');setExpanded(false);setPendingItem(null);setNeedsRefresh(false);setCounts({});setReceived({})
    try{const itemId=sessionStorage.getItem(storageKey);if(itemId&&/^[0-9a-f-]{36}$/i.test(itemId)&&api.pending(itemId)?.url.endsWith('/after-visit-physical'))setPendingItem(itemId)}catch{/* No saved pointer on this device. */}
    void load().catch(error=>{if(generation===active.current)setError(error instanceof Error?error.message:'离店实物暂未读回')})
    const refresh=async()=>{
      if(generation!==active.current||working.current||polling.current||state.current.expanded||state.current.pendingItem||document.visibilityState==='hidden')return
      polling.current=true
      try{await load()}catch{/* Keep the previously read physical facts and manual refresh. */}finally{polling.current=false}
    }
    const timer=setInterval(()=>void refresh(),15_000);window.addEventListener('focus',refresh)
    return()=>{active.current++;version.current++;clearInterval(timer);window.removeEventListener('focus',refresh)}
  },[api,storageKey,load])
  const refresh=async(more=false)=>{
    if(working.current)return;working.current=true;setBusy(true);setError('')
    try{await load(more)}catch(error){setError(error instanceof Error?error.message:'实物待办暂未更新')}finally{working.current=false;setBusy(false)}
  }
  const run=async(itemId:string,work:()=>Promise<unknown>)=>{
    if(working.current)return
    const previous=api.pending(itemId)
    if(previous&&!previous.url.endsWith('/after-visit-physical')){setError('原商品还有未确认的处理，请先恢复原商品记录');setOriginalItem(itemId);return}
    working.current=true;version.current++;setBusy(true);setError('');setNotice('');pointer(itemId)
    let committed=false
    try{await work();committed=true;pointer(null);setNeedsRefresh(true);setNotice('实物登记已确认，原收款和退款不变');await load()}
    catch(error){
      if(!api.pending(itemId))pointer(null)
      setError(committed?'登记已成功，待办暂未读回。请刷新，不用再次提交。':error instanceof Error?error.message:'结果待确认，请恢复原登记')
    }finally{working.current=false;setBusy(false)}
  }
  if(!data?.items.length&&!pendingItem&&!error&&!notice)return null
  const locked=busy||!!pendingItem||needsRefresh
  return <section aria-label="离店重做实物" className="staff-item-after-sales-pending">
    <header><h3>离店重做实物待处理</h3><button disabled={busy} onClick={()=>void refresh()}>刷新实物待办</button></header>
    <p>原桌次已结束。这里只登记剩余实物的实际去向，原收款和退款另行处理。</p>
    {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
    {pendingItem&&<p>上次实物登记结果待确认。<button disabled={busy} onClick={()=>void run(pendingItem,()=>api.recover(pendingItem))}>恢复上次实物登记</button></p>}
    {data?.items.map(row=>{
      const count=Number(counts[row.batchId]??'1'),valid=Number.isSafeInteger(count)&&count>0&&count<=row.unitIds.length
      const selected=row.unitIds.slice(0,count).map(id=>row.returnEligibility?.[id]),canReturn=selected.length>0&&selected.every(value=>value?.canReturn===true)
      const blocked=selected.find(value=>value?.canReturn===false)?.reason
      const act=(disposition:'used_loss'|'returned_unopened')=>run(row.itemId,()=>api.act(row.itemId,`/api/commerce/item-after-sales/remakes/${row.batchId}/after-visit-physical`,{
        unitIds:row.unitIds.slice(0,count),disposition,unopenedReceived:disposition==='returned_unopened'&&received[row.batchId]===true,
        reason:disposition==='returned_unopened'?'离店后本批实物已收回且未开封':'离店后本批实际已耗用或损耗，不退回原料',
      }))
      return <article key={row.batchId} aria-label="离店重做实物批次">
        <strong>{row.tableCode} · {row.productName} · 待处理 {row.pendingQuantity} 份</strong>
        <p>原订单 {row.orderPublicId}</p>
        <label>本次实物份数 <input type="number" min="1" max={row.unitIds.length} value={counts[row.batchId]??'1'} disabled={locked} onChange={event=>setCounts(value=>({...value,[row.batchId]:event.target.value}))}/></label>
        {row.canReceive&&!canReturn&&<p role="note">库存记录待核对：{blocked??'原包装证据尚未读回，请刷新或联系库存负责人核对；无需为清待办登记损耗。'}</p>}
        {row.canReceive&&canReturn&&<><label><input type="checkbox" disabled={locked} checked={received[row.batchId]??false} onChange={event=>setReceived(value=>({...value,[row.batchId]:event.target.checked}))}/>本批实物已收回且未开封</label><button disabled={locked||!valid||!received[row.batchId]} onClick={()=>void act('returned_unopened')}>登记本批实物退回</button></>}
        {row.canRecordUsed&&<button disabled={locked||!valid} onClick={()=>void act('used_loss')}>确认本批已耗用或损耗</button>}
      </article>
    })}
    {originalItem&&<ItemAfterSalesPanel itemId={originalItem} employeeId={employeeId} onClose={()=>setOriginalItem(null)} onChanged={()=>void refresh()}/>}
    {data?.nextCursor&&<button disabled={busy} onClick={()=>void refresh(true)}>继续查看离店实物</button>}
  </section>
}
