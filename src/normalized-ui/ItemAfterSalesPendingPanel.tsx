import {RemakePhysicalHandoverPanel} from './RemakePhysicalHandoverPanel'
import {useEffect,useMemo,useRef,useState} from 'react'
import {ItemAfterSalesApi} from './item-after-sales-api'
import {ItemAfterSalesPanel} from './ItemAfterSalesPanel'
import type {ItemAfterSalesPending} from '../shared/item-after-sales'

/** Existing staff tasks and cashier workspace share this pending queue. */
export function ItemAfterSalesPendingPanel({employeeId}:{employeeId:string}){
  const api=useMemo(()=>new ItemAfterSalesApi(employeeId),[employeeId])
  const generation=useRef(0)
  const [enabled,setEnabled]=useState(false),[data,setData]=useState<ItemAfterSalesPending|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[selected,setSelected]=useState<string|null>(null)
  const [expanded,setExpanded]=useState(false),[refreshDelayed,setRefreshDelayed]=useState(false)
  const [accessRetry,setAccessRetry]=useState(0)
  const readVersion=useRef(0),polling=useRef(false)
  const current=useRef({busy,data,selected,expanded});current.current={busy,data,selected,expanded}
  useEffect(()=>{const current=++generation.current;setEnabled(false);setData(null);setError('');setSelected(null);setBusy(false)
    setExpanded(false);setRefreshDelayed(false);readVersion.current++
    void api.access().then(async access=>{if(current!==generation.current||!access.enabled&&!access.recoveryAvailable)return;setEnabled(true);const first=await api.listPending();if(current===generation.current)setData(first)})
      .catch(error=>{if(current===generation.current)setError(error instanceof Error?error.message:'待处理商品暂未读取')})
    return()=>{generation.current++}},[api,accessRetry])
  const load=async(more=false)=>{
    if(busy)return
    const currentGeneration=generation.current,version=++readVersion.current
    setBusy(true);setError('')
    try{const value=await api.listPending(more?data?.nextCursor??undefined:undefined);if(currentGeneration===generation.current&&version===readVersion.current){setData(current=>more&&current?{...value,items:[...current.items,...value.items.filter(item=>!current.items.some(existing=>existing.caseId===item.caseId))]}:value);setExpanded(more);setRefreshDelayed(false)}}
    catch(error){if(currentGeneration===generation.current)setError(error instanceof Error?error.message:'待处理商品暂未读取')}
    finally{if(currentGeneration===generation.current)setBusy(false)}
  }
  useEffect(()=>{
    if(!enabled)return
    let active=true
    const refresh=async()=>{
      // A visible first page is the live work queue. Expanded history keeps its
      // place, and an open product already refreshes its own original facts.
      if(!active||polling.current||document.visibilityState==='hidden'||current.current.busy||!current.current.data||current.current.selected||current.current.expanded)return
      polling.current=true
      const version=readVersion.current,session=generation.current
      try{const value=await api.listPending();if(active&&session===generation.current&&version===readVersion.current&&!current.current.selected&&!current.current.expanded){setData(value);setRefreshDelayed(false)}}
      catch{if(active&&session===generation.current&&version===readVersion.current)setRefreshDelayed(true)}
      finally{polling.current=false}
    }
    const timer=setInterval(()=>void refresh(),15_000)
    window.addEventListener('focus',refresh);document.addEventListener('visibilitychange',refresh)
    return()=>{active=false;clearInterval(timer);window.removeEventListener('focus',refresh);document.removeEventListener('visibilitychange',refresh)}
  },[enabled,api])
  if(!enabled)return error?<section aria-label="商品售后待办" className="staff-item-after-sales-pending">
    <p role="alert">{error}</p>
    <button type="button" onClick={()=>setAccessRetry(value=>value+1)}>重新读取商品待办</button>
  </section>:null
  return <><RemakePhysicalHandoverPanel key={employeeId} employeeId={employeeId}/><section aria-label="商品售后待办" className="staff-item-after-sales-pending">
    <header><h3>待处理商品</h3><button disabled={busy} onClick={()=>void load()}>刷新商品待办</button></header>
    <p>含以前营业日未处理完的商品；拒绝或撤回后仍暂停的商品会保留在这里。</p>
    {error&&<p role="alert">{error}</p>}
    {refreshDelayed&&<p role="status">待办更新暂时延迟，已有记录保留，可点刷新重试。</p>}
    {data?.items.length===0&&<p>没有待处理商品。</p>}
    {data?.items.map(item=><article key={item.caseId} data-after-sales-case-id={item.caseId}>
      <strong>{item.tableCode} · {item.productName} ×{item.selectedQuantity}</strong>
      {item.orderPublicId&&<p title={item.orderPublicId}>原单尾号 {item.orderPublicId.slice(-8)}{item.orderBusinessDate&&` · ${item.orderBusinessDate}`}{item.createdAt&&Number.isFinite(Date.parse(item.createdAt))&&` · 申请 ${new Date(item.createdAt).toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit'})}`}</p>}
      <p>{item.businessDate} · {item.requesterName}申请 · {item.physicalOnly?(item.heldQuantity>0?`实物待核对 ${item.heldQuantity} 份`:'岗位通知待知悉'):item.awaitingCashPayout?'待确认现金实退':item.refundFailed?'退款失败待处理':item.refundNeedsReview?'渠道待核对':item.heldQuantity>0?`暂停 ${item.heldQuantity} 份`:item.unconfirmedNoticeCount>0?'岗位通知待知悉':'资金待处理'}</p>
      <p>资金：{item.status==='rejected'?'申请已拒绝，按原资金记录':item.status==='withdrawn'?'申请已撤回，按原资金记录':item.moneyComplete?(item.succeededMinor?`已退款 ¥${(item.succeededMinor/100).toFixed(2)}`:'已处理完成'):item.refundFailed?'退款失败待处理':item.refundNeedsReview?'结果待核对':item.awaitingCashPayout?'待确认现金实退':'待审核或处理'}；实物：{item.physicalComplete?'已处理':item.heldQuantity>0?`待处理 ${item.heldQuantity} 份`:'待核对'}；岗位通知：{item.unconfirmedNoticeCount>0?`待知悉 ${item.unconfirmedNoticeCount} 条`:'已知悉'}。</p>
      <button onClick={()=>setSelected(item.orderItemId)}>处理商品</button>
    </article>)}
    {data?.nextCursor&&<button disabled={busy} onClick={()=>void load(true)}>继续查看待处理商品</button>}
    {selected&&<ItemAfterSalesPanel itemId={selected} employeeId={employeeId} onClose={()=>setSelected(null)} onChanged={()=>void load()}/>}
  </section></>
}
