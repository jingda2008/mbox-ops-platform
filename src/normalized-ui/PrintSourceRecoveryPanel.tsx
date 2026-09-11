import {printFailureReason} from './print-failure-presentation'
import {NormalizedApiError} from '../normalized-api'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { NormalizedApiClient } from '../normalized-api'
import './print-source-recovery-panel.css'
import { PrintTicketPolicyPanel } from './PrintTicketPolicyPanel'

interface Source {lastErrorCode?:string|null;id:string;ticketKind:string;status:string;attempts:number;createdAt:string;nextAttemptAt:string}
const names:Record<string,string>={production:'出品单',settlement:'预结账单（未收款）',payment:'收款凭条',activity_payment:'活动收款',refund:'退款凭条',activity_refund:'活动退款',order_summary:'订单汇总及挂单预结算',delivery:'配送单',table_settlement:'整桌结账归档',daily_settlement:'营业日结单'}
const statuses:Record<string,string>={pending:'等待生成',retry:'失败，等待重试',dead:'已停止，需核对',skipped:'未生成票据'}

export function PrintSourceRecoveryPanel({api}:{api:NormalizedApiClient}){
  const [rows,setRows]=useState<Source[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false)
  const [reason,setReason]=useState(''),[confirmId,setConfirmId]=useState('')
  const keys=useRef(new Map<string,{key:string;reason:string}>()),generation=useRef(0)
  const refresh=useCallback(async()=>{
    const current=++generation.current
    try{const response=await api.getEndpoint<{data:Source[]}>('/api/hardware/print-sources')
      if(current===generation.current){setRows(response.data);setError('')}}
    catch{if(current===generation.current)setError('票据生成状态暂未读到，可重试；不影响营业')}
  },[api])
  useEffect(()=>{void refresh();return()=>{generation.current++}},[refresh])
  async function retry(row:Source){
    if(busy||reason.trim().length<3)return
    if(confirmId!==row.id){setConfirmId(row.id);return}
    setBusy(true)
    const attempt=keys.current.get(row.id)||{key:`print-source-${crypto.randomUUID()}`,reason:reason.trim()}
    keys.current.set(row.id,attempt)
    try{await api.postEndpoint(`/api/hardware/print-sources/${row.id}/retry`,{reason:attempt.reason},{idempotencyKey:attempt.key})
      keys.current.delete(row.id);setConfirmId('');await refresh()}
    catch(error){setError(error instanceof NormalizedApiError&&error.kind==='http'&&error.status!==null&&error.status<500&&error.status!==425 ? `${error.message}；本次请求被拒绝，请按提示处理后重试。` : '操作结果未确认，请刷新核对；再次操作沿用原编号，不重复生成')}
    finally{setBusy(false)}
  }
  return <><PrintTicketPolicyPanel api={api}/><section className="staff-song-requests print-source-recovery"><h2>票据生成检查</h2>
    <p className="staff-module-footnote">这里只处理票据生成，不会重新点单、扣库存、收款或退款。打印关闭期间跳过的记录不会在开机后集中补出。</p>
    <button type="button" disabled={busy} onClick={()=>void refresh()}>刷新生成状态</button>
    {error&&<p role="status">{error}</p>}
    {!error&&rows.length===0&&<p>当前没有待处理的票据生成记录。</p>}
    {rows.some(row=>['retry','dead'].includes(row.status))&&<label>处理原因<input value={reason} maxLength={1000} onChange={e=>{setReason(e.target.value);setConfirmId('')}} placeholder="至少3字：先核对业务时间和设备，再填写原因" />{reason.trim().length<3&&<small>还需填写 {3-reason.trim().length} 个字</small>}</label>}
    {rows.map(row=><article key={row.id}><div><strong>{names[row.ticketKind]||'票据'} · {statuses[row.status]||row.status}</strong>
      <span>{new Date(row.createdAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})} · 尝试 {row.attempts} 次</span>
      {['retry','dead'].includes(row.status)&&<p>{printFailureReason(row.lastErrorCode)}</p>}{row.status==='skipped'&&<p>{row.lastErrorCode?printFailureReason(row.lastErrorCode):'原记录未留存跳过原因；请核对当时业务状态、自动打印开关与路由，不应直接补出历史出品单。'}</p>}
      {confirmId===row.id&&<span>请确认不是已经不再需要的历史出品单，恢复只生成纸票。</span>}</div>
      {['retry','dead'].includes(row.status)&&<button type="button" disabled={busy||reason.trim().length<3} onClick={()=>void retry(row)}>{confirmId===row.id?'确认恢复生成':'核对后重试'}</button>}
    </article>)}
  </section></>
}
