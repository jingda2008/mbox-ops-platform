import {useCallback,useEffect,useState} from 'react'
import {STAFF_SESSION_BINDING_HEADER} from '../../shared/staff-session-binding'
import {executeRecoverableCommand} from '../recoverable-command'
type Receipt={id:string;publicId:string;status:string;amountMinor:string;availableMinor:string}
type Refund={id:string;publicId:string;status:string;amountMinor:string;paymentId:string}
type Summary={minimumMinor:number;waiverMinor:number;qualifyingGoodsMinor:number;shortfallMinor:number;availableMinor:number;refundableBalanceMinor:number;message:string;receipts:Receipt[];refunds:Refund[]}
const money=(n:number|string)=>`¥${(Number(n)/100).toFixed(2)}`
const statusName:Record<string,string>={created:'待付款',pending:'待确认',succeeded:'已成功',partially_refunded:'部分退款',refunded:'已退款',failed:'失败待核对',closed:'已关闭',requested:'待复核',approved:'待退款',processing:'退款处理中',cancelled:'已取消',rejected:'已拒绝'}
export function TablePrepaymentPanel({sessionId,staffSessionId,permissions}:{sessionId:string;staffSessionId?:string;permissions:readonly string[]}){
 const [data,setData]=useState<Summary|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[reason,setReason]=useState(''),[waiver,setWaiver]=useState('')
 const request=useCallback(async<T,>(path:string,body?:object,key?:string,signal?:AbortSignal):Promise<T>=>{
  const headers=new Headers({'accept':'application/json'});if(staffSessionId)headers.set(STAFF_SESSION_BINDING_HEADER,staffSessionId)
  if(body){headers.set('content-type','application/json');headers.set('idempotency-key',key!)}
  const response=await fetch(`/api/${path}`,{method:body?'POST':'GET',headers,body:body?JSON.stringify(body):undefined,credentials:'include',signal:signal??AbortSignal.timeout(15000)})
  const result=await response.json();if(!response.ok)throw Object.assign(new Error(result.error?.message??'预收款操作失败'),{status:response.status});return result.data as T
 },[staffSessionId])
 const path=`table-management/sessions/${encodeURIComponent(sessionId)}/prepayment`
 const reload=useCallback(async(signal?:AbortSignal)=>{const value=await request<Summary|null>(path,undefined,undefined,signal);if(!signal?.aborted)setData(value)},[request,path])
 useEffect(()=>{const ac=new AbortController();setData(null);setError('');setReason('');setNotice('');void reload(ac.signal).catch(e=>{if(!ac.signal.aborted)setError(e.message)});return()=>ac.abort()},[reload])
 const command=async(target:string,body:object)=>{if(busy)return;setBusy(true);setError('');setNotice('')
  try{await executeRecoverableCommand(`prepayment:${staffSessionId}:${sessionId}:${target}`,body,`prepayment-${crypto.randomUUID()}`,key=>request(target,body,key));await reload();setNotice('操作已记录，请以最新资金状态为准。退款需复核并执行，不以申请成功代替到账。')}
  catch(e){setError(e instanceof Error?e.message:'操作结果待核对，请重试同一操作')}finally{setBusy(false)}
 }
 if(!data)return error?<p role="alert">{error}<button type="button" onClick={()=>void reload().catch(e=>setError(e.message))}>重新读取预收款</button></p>:null
 return <section className="table-service-panel" aria-label="本桌预收款结算"><h3>本桌预收款结算</h3><p>{data.message}</p><p>开台金额 {money(data.minimumMinor)} · 已减免 {money(data.waiverMinor)} · 当前还差 {money(data.shortfallMinor)}</p><p>差额收费未启用。达到门槛或经授权减免后，剩余款按原付款退款。</p>
  <button type="button" disabled={busy} onClick={()=>void reload().catch(e=>setError(e.message))}>刷新资金状态</button>
  <label>处理原因<input aria-label="预收款处理原因" value={reason} maxLength={500} onChange={e=>setReason(e.target.value)}/></label>
  {permissions.includes('refund.approve')&&<div><label>最低消费减免金额（元）<input inputMode="decimal" value={waiver} onChange={e=>setWaiver(e.target.value)}/></label><button type="button" disabled={busy||reason.trim().length<2||!/^\d+(\.\d{1,2})?$/.test(waiver)||Number(waiver)<=0} onClick={()=>void command(`${path}/waive`,{amountMinor:Math.round(Number(waiver)*100),reason})}>记录门槛减免</button></div>}
  {permissions.includes('refund.request')&&<button type="button" disabled={busy||reason.trim().length<2||data.shortfallMinor>0||data.refundableBalanceMinor<=0} onClick={()=>void command(`${path}/refund-unused`,{reason})}>申请退回剩余预收款 {money(data.refundableBalanceMinor)}</button>}
  {data.receipts.map(p=><div key={p.id}><p>{p.publicId} · {money(p.amountMinor)} · {statusName[p.status]??p.status}</p>{['pending','created'].includes(p.status)&&<><button type="button" disabled={busy} onClick={()=>void command(`payments/${p.id}/provider-query`,{})}>查询原付款</button><button type="button" disabled={busy} onClick={()=>void command(`payments/${p.id}/provider-close`,{reason:reason.trim().length>=4?reason:'客人取消本次预付款',expectedAmountMinor:Number(p.amountMinor)})}>取消未完成付款</button></>}</div>)}
  {data.refunds.map(r=><div key={r.id}><p>{r.publicId} · {money(r.amountMinor)} · {statusName[r.status]??r.status} · 退回原付款</p>{r.status==='requested'&&permissions.includes('refund.approve')&&<><button type="button" disabled={busy||reason.trim().length<2} onClick={()=>void command(`refunds/${r.id}/approve`,{reason})}>复核通过</button><button type="button" disabled={busy||reason.trim().length<2} onClick={()=>void command(`refunds/${r.id}/reject`,{reason})}>复核拒绝</button></>}{r.status==='approved'&&permissions.includes('refund.execute')&&<button type="button" disabled={busy} onClick={()=>void command(`refunds/${r.id}/execute`,{})}>执行原路退款</button>}{['processing','failed'].includes(r.status)&&permissions.includes('refund.execute')&&<button type="button" disabled={busy} onClick={()=>void command(`refunds/${r.id}/provider-query`,{})}>查询原退款</button>}</div>)}
  {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
 </section>
}

export function TablePrepaymentDirectory({staffSessionId,permissions}:{staffSessionId?:string;permissions:readonly string[]}){
 const [open,setOpen]=useState(false),[nextCursor,setNextCursor]=useState<string|null>(null),[sessions,setSessions]=useState<Array<{id:string;tableCode:string;publicId:string;status:string;businessDate:string;unsettled:boolean}>>([]),[selected,setSelected]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false)
 const load=async(cursor?:string)=>{setOpen(true);setBusy(true);setError('');try{
  const headers=new Headers({accept:'application/json'});if(staffSessionId)headers.set(STAFF_SESSION_BINDING_HEADER,staffSessionId)
  const response=await fetch(`/api/table-management/prepayments${cursor?'?before='+encodeURIComponent(cursor):''}`,{headers,credentials:'include',signal:AbortSignal.timeout(12000)}),body=await response.json()
  if(!response.ok)throw new Error(body.error?.message??'预收款记录读取失败');setSessions(current=>cursor?[...current,...body.data.filter((row:{id:string})=>!current.some(previous=>previous.id===row.id))]:body.data);setNextCursor(body.meta?.nextCursor??null)
 }catch(e){setError(e instanceof Error?e.message:'读取失败')}finally{setBusy(false)}}
 return <section aria-label="预收款财务待办"><button type="button" disabled={busy} onClick={()=>void load()}>预收款与往期结算</button>{open&&<><button type="button" onClick={()=>setOpen(false)}>收起</button><p>已释放桌位的旧桌次继续保留财务待办，与新开桌分别结算。</p>{sessions.map(session=><button type="button" key={session.id} aria-pressed={selected===session.id} onClick={()=>setSelected(session.id)}>{session.tableCode} · {session.businessDate} · {session.status==='closed'?'往期':'本次'} · {session.unsettled?'待处理':'可结台'}</button>)}{nextCursor&&<button type="button" disabled={busy} onClick={()=>void load(nextCursor)}>加载更早的预收款待办</button>}{!busy&&!sessions.length&&!error&&<p>暂无预收款待办</p>}{selected&&<TablePrepaymentPanel key={selected} sessionId={selected} staffSessionId={staffSessionId} permissions={permissions}/>}</>}{error&&<p role="alert">{error}</p>}</section>
}
