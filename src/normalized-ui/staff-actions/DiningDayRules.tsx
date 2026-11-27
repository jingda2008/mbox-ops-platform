import {useCallback,useEffect,useState} from 'react'
import {STAFF_SESSION_BINDING_HEADER} from '../../shared/staff-session-binding'
import {executeRecoverableCommand} from '../recoverable-command'

type Rule={businessDate:string;minimum:boolean;ticket:boolean;revision:number}
const path='/api/table-management/dining-day-rules'
function description(minimum:boolean,ticket:boolean){
  if(minimum && ticket) return '持票人入座后整桌免低消，同桌可点单。普通桌按开台金额。'
  if(minimum) return '所有桌按各自的开台金额。'
  if(ticket) return '仅持本场有效票的顾客可点单。'
  return '顾客可正常点单，无低消。'
}

export function DiningDayRules({staffSessionId,canEdit,onMinimum}:{staffSessionId?:string;canEdit:boolean;onMinimum:(enabled:boolean)=>void}){
  const [saved,setSaved]=useState<Rule|null>(null)
  const [minimum,setMinimum]=useState(true),[ticket,setTicket]=useState(true)
  const [error,setError]=useState(''),[busy,setBusy]=useState(false)
  const request=useCallback(async(signal:AbortSignal,body?:Rule,key?:string):Promise<Rule>=>{
    const headers=new Headers({accept:'application/json'})
    if(staffSessionId)headers.set(STAFF_SESSION_BINDING_HEADER,staffSessionId)
    if(body){headers.set('content-type','application/json');headers.set('idempotency-key',key!)}
    const reply=await fetch(path,{method:body?'POST':'GET',headers,signal,body:body?JSON.stringify(body):undefined,credentials:'include'})
    const result=await reply.json()
    if(!reply.ok)throw Object.assign(new Error(result.error?.message??'暂时无法读取今天的消费条件'),{status:reply.status})
    return result.data
  },[staffSessionId])
  const apply=useCallback((r:Rule)=>{setSaved(r);setMinimum(r.minimum);setTicket(r.ticket);onMinimum(r.minimum);setError('')},[onMinimum])
  const load=useCallback(async(signal:AbortSignal)=>{
    try{const r=await request(signal);if(!signal.aborted)apply(r)}
    catch(e){if(!signal.aborted)setError(e instanceof Error?e.message:'读取失败')}
  },[apply,request])
  useEffect(()=>{const c=new AbortController();void load(c.signal);return()=>c.abort()},[load])
  async function save(){
    if(!saved || busy)return
    setBusy(true)
    const input={...saved,minimum,ticket}
    try{apply(await executeRecoverableCommand(`dining-day:${staffSessionId}:${saved.businessDate}`,input,`dining-day-${crypto.randomUUID()}`,key=>request(AbortSignal.timeout(15000),input,key)))}
    catch(e){setError(e instanceof Error?e.message:'保存结果待核对')}
    finally{setBusy(false)}
  }
  return <details className="staff-day-rules">
    <summary>今天的消费条件</summary>
    {saved && <><p>营业日 {saved.businessDate} · 当前生效：{description(saved.minimum,saved.ticket)}</p>
      {canEdit && <><fieldset disabled={busy}><legend>可单选或同时勾选</legend>
        <label><input type="checkbox" checked={minimum} onChange={e=>setMinimum(e.target.checked)}/>最低消费</label>
        <label><input type="checkbox" checked={ticket} onChange={e=>setTicket(e.target.checked)}/>门票</label>
      </fieldset>
      {(minimum!==saved.minimum || ticket!==saved.ticket) && <p>保存后：{description(minimum,ticket)}</p>}
      <button type="button" onClick={()=>void save()} disabled={busy || (saved.minimum===minimum && saved.ticket===ticket)}>保存消费条件</button></>}
    </>}
    {error && <p role="alert">{error} <button type="button" onClick={()=>void load(AbortSignal.timeout(10000))}>重新读取</button></p>}
  </details>
}
