import {useEffect,useEffectEvent,useState} from 'react'
import type {NormalizedApiClient,StaffAuthView} from '../normalized-api'
import {executeRecoverableCommand} from './recoverable-command'
import {createIdempotencyKey} from './cashier-mutation'
import {useConfirmationDialog} from './ConfirmationDialog'
interface Broadcast{id:string;account_id:string;title:string;content:string;scheduled_at:string;status:string;provider_reference:string|null;error_code:string|null}
interface Account{id:string;name:string;enabled?:boolean}
const statuses:Record<string,string>={draft:'草稿',scheduled:'等待发送',sending:'正在提交',accepted:'平台已受理，待最终回执',rejected:'平台拒绝',unknown:'结果待核对，禁止自动重发',cancelled:'已取消',delivered:'平台回执发送完成',delivery_failed:'平台回执发送失败'}
function toShanghaiIso(date:string,time:string){
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!/^\d{2}:\d{2}$/.test(time))throw new Error('请选择发送日期和时间')
 return `${date}T${time}:00+08:00`
}
export function SocialBroadcastPanel({api,auth}:{api:NormalizedApiClient;auth:StaffAuthView}){
 const allowed=auth.permissions.includes('community.activity.manage'),[accounts,setAccounts]=useState<Account[]>([]),[rows,setRows]=useState<Broadcast[]>([]),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[form,setForm]=useState({accountId:'',title:'',content:'',scheduledDate:'',scheduledTime:''}),{confirmAction}=useConfirmationDialog()
 async function perform(fn:()=>Promise<void>){if(busy)return;setBusy(true);try{await fn()}catch(e){setMessage(e instanceof Error?e.message:'结果未确认，请刷新核对')}finally{setBusy(false)}}
 async function command<T=unknown>(path:string,body:unknown){return executeRecoverableCommand<T>(`${auth.employee.id}:${path}`,body,createIdempotencyKey('broadcast'),key=>api.postEndpoint(path,body,{idempotencyKey:key}))}
 function pickAccount(list:Account[],current:string){
  if(current&&list.some(a=>a.id===current))return current
  const enabled=list.find(a=>a.enabled!==false)
  return enabled?.id??list[0]?.id??''
 }
 async function loadAccounts(){
  const account=await api.getEndpoint<{data:Account[]}>('/api/staff/social-broadcasts/accounts')
  setAccounts(account.data)
  setForm(current=>({...current,accountId:pickAccount(account.data,current.accountId)}))
  return account.data
 }
 async function load(){
  const result=await api.getEndpoint<{data:Broadcast[]}>('/api/staff/social-broadcasts')
  setRows(result.data)
  await loadAccounts()
 }
 const initialize=useEffectEvent(()=>{void perform(load)})
 useEffect(()=>{if(allowed)initialize()},[allowed,api,auth.employee.id])
 if(!allowed)return null
 async function action(row:Broadcast,action:'schedule'|'cancel'){
  if(action==='schedule'&&!await confirmAction({title:'安排服务号群发',description:`将于${new Date(row.scheduled_at).toLocaleString('zh-CN')}向所选服务号全部关注者群发以下内容：\n${row.content}`,confirmLabel:'确认安排群发'}))return
  await perform(async()=>{await command(`/api/staff/social-broadcasts/${row.id}/action`,{action,audienceConfirmed:action==='schedule'});await load()})
 }
 async function saveDraft(schedule:boolean){
  let scheduledAt=''
  try{scheduledAt=toShanghaiIso(form.scheduledDate,form.scheduledTime)}catch(error){setMessage(error instanceof Error?error.message:'请选择发送日期和时间');return}
  if(!form.accountId){setMessage('请选择服务号');return}
  const body={accountId:form.accountId,title:form.title,content:form.content,scheduledAt}
  if(schedule){
   const accountName=accounts.find(a=>a.id===form.accountId)?.name??'所选服务号'
   if(!await confirmAction({title:'保存并安排服务号群发',description:`将于${form.scheduledDate} ${form.scheduledTime}（北京时间）向「${accountName}」全部关注者群发以下内容：\n${form.content}`,confirmLabel:'确认安排群发'}))return
  }
  await perform(async()=>{
   const created=await command<{id:string;status:string}>('/api/staff/social-broadcasts',body)
   if(schedule)await command(`/api/staff/social-broadcasts/${created.id}/action`,{action:'schedule',audienceConfirmed:true})
   setForm(current=>({accountId:current.accountId,title:'',content:'',scheduledDate:'',scheduledTime:''}))
   await load()
   setMessage(schedule?'已安排群发，到达时间后由平台发送；最终送达以微信回执为准':'已保存草稿，可在下方预览并安排发送')
  })
 }
 return <section className="bottle-custody-panel"><h3>服务号活动群发</h3><p>范围为服务号全部关注者，使用公众号群发渠道。保存草稿后可预览并安排发送；也可直接保存并安排。平台配额与最终送达以微信回执为准。</p><button disabled={busy} onClick={()=>void perform(load)}>刷新状态</button>{message&&<p role="status">{message}</p>}
 {accounts.length===0&&<p role="status">当前没有可选服务号。请先在本页下方「服务号、企业微信与专属卡」保存并启用服务号，再点「刷新状态」。</p>}
 <form onSubmit={e=>{e.preventDefault();void saveDraft(false)}}><div className="custody-fields">
  <label>服务号<select required style={{minWidth:220}} value={form.accountId} onFocus={()=>void loadAccounts().catch(()=>undefined)} onChange={e=>setForm({...form,accountId:e.target.value})}><option value="">请选择</option>{accounts.map(a=><option key={a.id} value={a.id}>{a.name}{a.enabled===false?'（未启用）':''}</option>)}</select></label>
  <label>任务名称<input required maxLength={80} style={{minWidth:220}} value={form.title} onChange={e=>setForm({...form,title:e.target.value})}/></label>
  <label>发送日期<input required type="date" style={{minWidth:180}} value={form.scheduledDate} onChange={e=>setForm({...form,scheduledDate:e.target.value})}/></label>
  <label>发送时间<input required type="time" style={{minWidth:140}} value={form.scheduledTime} onChange={e=>setForm({...form,scheduledTime:e.target.value})}/></label>
  <label style={{flex:'1 1 100%'}}>群发内容<textarea required maxLength={600} value={form.content} onChange={e=>setForm({...form,content:e.target.value})}/></label>
 </div>
 <button disabled={busy||accounts.length===0} type="submit">保存群发草稿</button>
 <button disabled={busy||accounts.length===0} type="button" onClick={()=>void saveDraft(true)}>保存并安排发送</button>
 </form>
 {rows.map(row=><article key={row.id}><h4>{row.title} · {statuses[row.status]??row.status}</h4><p>{row.content}</p><p>{new Date(row.scheduled_at).toLocaleString('zh-CN')} · {accounts.find(a=>a.id===row.account_id)?.name}</p>{row.provider_reference&&<p>平台回执：{row.provider_reference}</p>}{row.error_code&&<p>结果代码：{row.error_code}</p>}{row.status==='draft'&&<button disabled={busy} onClick={()=>void action(row,'schedule')}>预览并安排发送</button>}{['draft','scheduled'].includes(row.status)&&<button disabled={busy} onClick={()=>void action(row,'cancel')}>取消任务</button>}</article>)}
 {rows.length>=100&&<button disabled={busy} onClick={()=>void perform(async()=>{const next=await api.getEndpoint<{data:Broadcast[]}>(`/api/staff/social-broadcasts?cursor=${rows.at(-1)!.id}`);setRows([...rows,...next.data])})}>加载更早任务</button>}
 </section>
}
