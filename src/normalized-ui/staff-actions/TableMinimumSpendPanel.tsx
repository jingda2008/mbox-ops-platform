import {useCallback,useEffect,useRef,useState} from 'react'
import {STAFF_SESSION_BINDING_HEADER} from '../../shared/staff-session-binding'
import {executeRecoverableCommand} from '../recoverable-command'
type History={id:string;kind:'adjust'|'release';employeeName:string;employeeId:string;reason:string;createdAt:string;amountMinor:string|null;beforeMinor:string|null;afterMinor:string|null;orderPublicId:string|null;shortfallMinor:string|null}
type Summary={originalMinimumMinor:number;effectiveMinimumMinor:number;consumedMinor:number;shortfallMinor:number;mode:string;status:string;history:History[]}
const money=(n:number|string)=>`¥${(Number(n)/100).toFixed(2)}`
export function TableMinimumSpendPanel({sessionId,staffSessionId,permissions}:{sessionId:string;staffSessionId?:string;permissions:readonly string[]}){
 const [data,setData]=useState<Summary|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[reason,setReason]=useState(''),[target,setTarget]=useState(''),[confirmCancel,setConfirmCancel]=useState(false)
 const writing=useRef(false),generation=useRef(0)
 const path=`/api/table-management/sessions/${encodeURIComponent(sessionId)}/minimum-spend`
 const request=useCallback(async(body?:object,key?:string,signal?:AbortSignal):Promise<Summary>=>{
  const headers=new Headers({accept:'application/json'});if(staffSessionId)headers.set(STAFF_SESSION_BINDING_HEADER,staffSessionId)
  if(body){headers.set('content-type','application/json');headers.set('idempotency-key',key!)}
  const response=await fetch(path,{method:body?'POST':'GET',headers,credentials:'include',body:body?JSON.stringify(body):undefined,signal:signal??AbortSignal.timeout(15000)})
  const result=await response.json();if(!response.ok)throw Object.assign(new Error(result.error?.message??'低消处理失败'),{status:response.status});return result.data
 },[path,staffSessionId])
 const reload=useCallback(async(signal?:AbortSignal)=>{const epoch=generation.current,value=await request(undefined,undefined,signal);if(!signal?.aborted&&epoch===generation.current)setData(value)},[request])
 useEffect(()=>{generation.current++;const ac=new AbortController();setData(null);setError('');setNotice('');setReason('');setTarget('');setConfirmCancel(false);void reload(ac.signal).catch(e=>{if(!ac.signal.aborted)setError(e.message)});return()=>{generation.current++;ac.abort()}},[reload])
 const adjust=async(targetMinimumMinor:number)=>{
  if(writing.current||!data)return;writing.current=true;setBusy(true);setError('');setNotice('');const epoch=generation.current
  const input={expectedMinimumMinor:data.effectiveMinimumMinor,targetMinimumMinor,reason:reason.trim()}
  try{const value=await executeRecoverableCommand(`minimum:${staffSessionId}:${sessionId}`,input,`minimum-${crypto.randomUUID()}`,key=>request(input,key));if(epoch!==generation.current)return;setData(value);window.dispatchEvent(new CustomEvent('mbox:table-minimum-updated',{detail:sessionId}));setReason('');setTarget('');setConfirmCancel(false);setNotice('本桌低消已更新并记录原因。已有订单、应付款及原退款审批保持有效。')}
  catch(e){if(epoch===generation.current)setError(e instanceof Error?e.message:'操作结果待核对，请重试同一操作')}
  finally{writing.current=false;if(epoch===generation.current)setBusy(false)}
 }
 if(!data)return error?<p role="alert">{error}<button type="button" onClick={()=>void reload().catch(e=>setError(e.message))}>重新读取低消</button></p>:null
 if(data.originalMinimumMinor===0&&data.history.length===0)return null
 const targetMinor=Math.round(Number(target)*100),validTarget=/^\d+(\.\d{1,2})?$/.test(target)&&Number.isSafeInteger(targetMinor)&&targetMinor>0&&targetMinor<data.effectiveMinimumMinor
 const canAdjust=permissions.includes('table.minimum_spend.adjust')&&permissions.includes('table.view_all')&&data.effectiveMinimumMinor>0
 return <section className="table-service-panel" aria-label="本桌最低消费"><h3>本桌最低消费</h3><p>开台 {money(data.originalMinimumMinor)} · 当前 {money(data.effectiveMinimumMinor)} · 已点有效商品 {money(data.consumedMinor)} · 还差 {money(data.shortfallMinor)}</p><p>按优惠前商品金额累计，退菜后重新核算。本单放行不取消整桌要求。差额收费未启用；调整低消不会自动退款。</p><button type="button" disabled={busy} onClick={()=>void reload().catch(e=>setError(e.message))}>刷新本桌低消</button>
 {canAdjust&&<details><summary>调整整桌低消</summary><label>低消调整原因<input value={reason} maxLength={500} disabled={busy} onChange={e=>setReason(e.target.value)}/></label><label>调整后的整桌低消（元）<input inputMode="decimal" value={target} disabled={busy} onChange={e=>setTarget(e.target.value)}/></label><button type="button" disabled={busy||reason.trim().length<2||!validTarget} onClick={()=>void adjust(targetMinor)}>降低整桌低消</button><label><input type="checkbox" checked={confirmCancel} disabled={busy} onChange={e=>setConfirmCancel(e.target.checked)}/>确认取消本桌剩余低消要求</label><button type="button" disabled={busy||reason.trim().length<2||!confirmCancel} onClick={()=>void adjust(0)}>取消整桌低消</button></details>}
 <details><summary>低消操作记录（{data.history.length}）</summary>{data.history.map(row=><p key={row.id}>{row.kind==='release'?`本单放行 ${row.orderPublicId} · 当时还差 ${money(row.shortfallMinor??0)} · 整桌低消不变`:`整桌低消调整 ${row.beforeMinor===null?'历史减免 '+money(row.amountMinor??0):money(row.beforeMinor)+' → '+money(row.afterMinor??0)}`} · {row.employeeName} · {new Date(row.createdAt).toLocaleString('zh-CN')} · {row.reason}</p>)}</details>{error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
 </section>
}
