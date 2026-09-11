import {useEffect,useRef,useState} from 'react'
import type {NormalizedApiClient} from '../normalized-api'
type Row={financialSignals?:string[]|null;id:string;publicId:string;amountMinor:string;status:string;createdAt:string;phase:string|null;stopReason:string|null;nextQueryAt:string|null;queryCount:number|null;caseStatus:string|null;note:string|null;ownerName:string|null;ownerEmployeeId:string|null;orderPublicId:string|null;tableCode:string|null}
export function PaymentFinanceReviewPanel({api,canManage}:{api:NormalizedApiClient;canManage:boolean}){
 const [rows,setRows]=useState<Row[]>([]),[message,setMessage]=useState(''),[open,setOpen]=useState(false),[page,setPage]=useState(0),[more,setMore]=useState(false),[revision,setRevision]=useState(0)
 const [notes,setNotes]=useState<Record<string,string>>({}),[busy,setBusy]=useState<string|null>(null)
 const active=useRef(false),attempts=useRef(new Map<string,{body:string;key:string}>())
 useEffect(()=>{if(!open)return;let current=true;void api.getEndpoint<{data:Row[];hasMore:boolean}>(`/api/payments/finance-review?page=${page}`).then(result=>{if(current){setRows(result.data);setMore(result.hasMore);setMessage('')}}).catch(error=>{if(current)setMessage(error instanceof Error?error.message:'财务核对暂未读取')});return()=>{current=false}},[api,open,page,revision])
 async function save(row:Row,resolve=false){
  if(active.current)return
  const note=(notes[row.id]??row.note??'').trim();if(note.length<3)return setMessage('请填写至少3字的核对结果或后续安排')
  const body={note,resolve},fingerprint=JSON.stringify(body)
  if(attempts.current.get(row.id)?.body!==fingerprint)attempts.current.set(row.id,{body:fingerprint,key:crypto.randomUUID()})
  active.current=true;setBusy(row.id)
  try{await api.postEndpoint(`/api/payments/${row.id}/finance-review`,body,{idempotencyKey:attempts.current.get(row.id)!.key});attempts.current.delete(row.id);setRevision(value=>value+1);setMessage(resolve?'财务核对已结案':'核对进展已保存，本人已登记为负责人')}
  catch(error){setMessage(error instanceof Error?error.message:'保存结果未确认，请使用原内容重试')}
  finally{active.current=false;setBusy(null)}
 }
 const time=(value:string|null)=>value?new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'未记录'
 const phase=(row:Row)=>['created','pending'].includes(row.status)?row.phase==='stopped'?'自动查询已停止，待财务核对':row.nextQueryAt?`后台继续核对；下次 ${time(row.nextQueryAt)}`:'支付结果未知，待财务核对':'支付已取得最终状态，待核对结案'
 return <details className="payment-finance-review" onToggle={event=>setOpen(event.currentTarget.open)}><summary>财务核对 · 原支付与核对进展</summary><p>这里保留原付款事实；未知结果不阻止正常收款。原款晚到引起多收时，仍需在退款待办处理。</p>
  {message&&<p role="status">{message}</p>}{rows.map(row=><article key={row.id}><strong>{row.tableCode??'活动或历史付款'} · ¥{(Number(row.amountMinor)/100).toFixed(2)}</strong><p>{row.publicId} · {time(row.createdAt)}</p>{row.financialSignals?.map(signal=><p key={signal} role="alert">{signal==='order_overcollected'?'已确认多收，请到收银原订单办理退款':signal==='cancelled_order_captured'?'订单取消后仍有到账，请到收银原订单办理退款':'已到账但缺少入账流水，请核对'}</p>)}<p>{phase(row)}；负责人：{row.ownerName??'待财务人员接手'}；已查询 {row.queryCount??0} 次</p>{row.stopReason&&<p>查询停止原因：{({confirmed_receipt:'已确认到账',provider_terminal_result:'渠道已返回最终结果',provider_query_window_expired:'已超过渠道自动查单时限，需财务核对渠道凭证',finance_review_required:'持续未取得最终结果，已转财务人工核对'} as Record<string,string>)[row.stopReason]??`历史原因代码 ${row.stopReason}，请按付款编号核对`} </p>}
   {canManage?<><label>核对进展<textarea maxLength={1000} value={notes[row.id]??row.note??''} onChange={event=>setNotes({...notes,[row.id]:event.target.value})} placeholder="记录渠道凭据、当前核对结果及后续安排"/></label><button type="button" disabled={busy!==null} onClick={()=>void save(row)}>本人接手并保存进展</button>{!['created','pending'].includes(row.status)&&<button type="button" disabled={busy!==null} onClick={()=>void save(row,true)}>核对完成，结案</button>}</>:<p>{row.note??'尚未记录核对进展；需财务管理权限的人员处理。'}</p>}
  </article>)}{open&&!rows.length&&!message&&<p>当前没有待核对记录。</p>}<nav><button disabled={page===0||busy!==null} onClick={()=>setPage(value=>value-1)}>上一页</button><span>第{page+1}页</span><button disabled={!more||busy!==null} onClick={()=>setPage(value=>value+1)}>下一页</button><button disabled={busy!==null} onClick={()=>setRevision(value=>value+1)}>刷新核对状态</button></nav>
 </details>
}
