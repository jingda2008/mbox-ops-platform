import { useEffect, useRef, useState } from 'react'
import type { NormalizedApiClient } from '../normalized-api'
import { PRINT_TICKET_LABELS, type PrintTicketPolicy } from '../shared/print-ticket-policy'

export function PrintTicketPolicyPanel({api}:{api:NormalizedApiClient}) {
  const [rows,setRows]=useState<PrintTicketPolicy[]>([]),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false)
  const [reason,setReason]=useState('')
  const [refresh,setRefresh]=useState(0)
  const pending=useRef<{key:string;body:PrintTicketPolicy&{reason:string}}|null>(null)
  useEffect(()=>{
    let active=true
    api.getEndpoint<{data:PrintTicketPolicy[]}>('/api/hardware/print-ticket-policies')
      .then(result=>{if(active){setRows(result.data);setNotice('')}})
      .catch(()=>{if(active)setNotice('打印规则暂未读取，不影响营业')})
    return()=>{active=false}
  },[api,refresh])
  async function save(row:PrintTicketPolicy) {
    if(busy||reason.trim().length<3)return
    setBusy(true)
    pending.current??={key:`print-policy-${crypto.randomUUID()}`,body:{...row,copies:row.copies??1,reason:reason.trim()}}
    try {
      await api.postEndpoint('/api/hardware/print-ticket-policies',pending.current.body,{idempotencyKey:pending.current.key})
      const saved=await api.getEndpoint<{data:PrintTicketPolicy[]}>('/api/hardware/print-ticket-policies')
      const expected=pending.current.body,actual=saved.data.find(r=>r.ticketKind===expected.ticketKind)
      if(!actual||actual.enabled!==expected.enabled||actual.copies!==expected.copies)throw new Error('readback mismatch')
      setRows(current=>current.map(r=>r.ticketKind===actual.ticketKind?actual:r))
      pending.current=null
      setNotice('已保存；只影响后续生成的票据，已排队票据请在打印任务中处理。')
    } catch {setNotice('保存结果未确认，请点击重试；保持原操作编号，不会重复修改。')}
    finally {setBusy(false)}
  }
  return <section className="staff-song-requests print-source-recovery print-ticket-policies"><h2>自动打印单据</h2>
    <p className="staff-module-footnote">后厨制作单走后厨；酒水制作走吧台；汇总、配送与收银单据走收银路由（请绑定吧台打印机）。关闭不补打历史；份数未配置时沿用路由。</p>
    {notice&&<p role="status">{notice}</p>}
    <button type="button" disabled={busy||pending.current!==null} onClick={()=>setRefresh(v=>v+1)}>重新读取规则（放弃未保存选择）</button>
    <label>修改原因<input value={reason} disabled={busy||pending.current!==null} maxLength={1000} onChange={e=>setReason(e.target.value)} placeholder="至少3个字，例如调整出单份数" /></label>
    {rows.map(row=><article key={row.ticketKind}><strong>{PRINT_TICKET_LABELS[row.ticketKind]}</strong>
      <label><input type="checkbox" checked={row.enabled} disabled={busy||pending.current!==null} onChange={e=>setRows(rows.map(r=>r.ticketKind===row.ticketKind?{...r,enabled:e.target.checked}:r))}/>自动打印</label>
      <label>份数<select value={row.copies??''} disabled={busy||pending.current!==null} onChange={e=>setRows(rows.map(r=>r.ticketKind===row.ticketKind?{...r,copies:Number(e.target.value)}:r))}>
        {row.copies===null&&<option value="">沿用路由</option>}{[1,2,3,4,5].map(n=><option value={n} key={n}>{n}份</option>)}
      </select></label>
      <button type="button" disabled={busy||reason.trim().length<3||(pending.current!==null&&pending.current.body.ticketKind!==row.ticketKind)} onClick={()=>void save(row)}>{pending.current?.body.ticketKind===row.ticketKind?'重试原操作':'保存'}</button>
    </article>)}
  </section>
}
